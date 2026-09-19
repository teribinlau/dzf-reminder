// DZF 提醒 · Notion「到柜登记表」→ 提醒 自动同步
//
// 每 15 分钟由 pg_cron 调一次（也可以手动 POST）。做的事：
//   1. 读 Notion 数据库里 日期 ≥ 7 天前 的行（POST {"since":"2026-08-01"} 可补更早的历史）
//   2. 状态 = 已预约 且 日期 ≥ 今天 的每一柜 → 一条提醒（到柜时段到点，提前 30 分钟提醒），指派给入库组；
//      状态 = 已卸柜 的行（含历史）→ 已完成的记录，日历里能回看
//   3. 每个有到柜的日期 → 前一个工作日 16:00 一条「明天到柜 N 柜」汇总
//   4. 表里改了日期 / 时段 / 信息 → 更新提醒；状态改成 已卸柜 → 自动完成；改期 / 取消 / 爽约 → 归档
//
// 需要的环境变量（Supabase → Edge Functions → Secrets）：
//   NOTION_TOKEN          Notion 内部集成密钥（ntn_…），且集成已连接到「到柜登记表」
//   NOTION_DATABASE_ID    到柜登记表的数据库 id（默认 614b6528-7de4-4dd4-b9ba-189892cb2387）
//   SYNC_SECRET           调用口令，请求头 x-sync-secret 必须一致（函数关闭了 JWT 校验）
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   Supabase 自动注入
//   CREATOR_PROFILE_ID    可选：提醒的「创建人」，默认取第一个管理员
//   TEAM_NAME_ZH          可选：指派的班组中文名，默认「入库组」

import { createClient } from 'npm:@supabase/supabase-js@2';

const TZ = 'Europe/Berlin';
const SOURCE = 'notion';
const NOTION_VERSION = '2022-06-28';

type NotionPage = {
  id: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, any>;
};

type Row = {
  id: string; // notion page id（带横线）
  url: string;
  orderNo: string; // 入库单号
  date: string | null; // YYYY-MM-DD
  dateTime: string | null; // 如果日期带时间，ISO
  slot: string | null; // 时间：08:30 … 16:00 / 待定
  shipper: string; // 发货方
  container: string; // 柜号
  size: string; // 货柜尺寸
  status: string; // 状态
  sysStatus: string; // 系统状态
  unloader: string; // 卸柜方
  goods: string; // 货物信息
  note: string; // 备注
};

type Desired = {
  key: string;
  title: string;
  notes: string;
  due_at: string; // ISO UTC
  link: string;
  priority: 'low' | 'medium' | 'high';
  remind_before_min: number;
  overdue_repeat_min: number;
  done?: string; // 有值 = 这条应当是「已完成」状态，值是完成人显示名（如 Notion · 已卸柜）
};

// ---------- 时区工具（不引第三方库） ----------
function tzOffsetMinutes(utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - utcMs) / 60000);
}
function localToUtc(y: number, m: number, d: number, hh: number, mm: number): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let off = tzOffsetMinutes(guess);
  let utc = guess - off * 60000;
  const off2 = tzOffsetMinutes(utc);
  if (off2 !== off) utc = guess - off2 * 60000;
  return new Date(utc);
}
function localYmd(dt: Date): string {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return dtf.format(dt); // en-CA 输出 YYYY-MM-DD
}
function ymdParts(ymd: string): [number, number, number] {
  const [y, m, d] = ymd.split('-').map(Number);
  return [y, m, d];
}
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymdParts(ymd);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
function weekday(ymd: string): number {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = 周日
}
function prevWorkingDay(ymd: string): string {
  let d = addDays(ymd, -1);
  while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, -1);
  return d;
}
const WD_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ---------- Notion ----------
function plain(prop: any): string {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
    case 'rich_text':
      return (prop[prop.type] ?? []).map((t: any) => t.plain_text ?? '').join('').trim();
    case 'select':
      return prop.select?.name ?? '';
    case 'status':
      return prop.status?.name ?? '';
    case 'number':
      return prop.number == null ? '' : String(prop.number);
    default:
      return '';
  }
}

async function fetchNotionRows(token: string, dbId: string, sinceYmd: string): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page_size: 100,
        start_cursor: cursor,
        filter: { property: '日期', date: { on_or_after: sinceYmd } },
        sorts: [{ property: '日期', direction: 'ascending' }],
      }),
    });
    if (!res.ok) throw new Error(`Notion ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    for (const page of data.results as NotionPage[]) {
      const p = page.properties;
      const dateProp = p['日期']?.date;
      const start: string | null = dateProp?.start ?? null;
      rows.push({
        id: page.id,
        url: page.url,
        orderNo: plain(p['入库单号']),
        date: start ? start.slice(0, 10) : null,
        dateTime: start && start.length > 10 ? start : null,
        slot: plain(p['时间']) || null,
        shipper: plain(p['发货方']),
        container: plain(p['柜号']),
        size: plain(p['货柜尺寸']),
        status: plain(p['状态']),
        sysStatus: plain(p['系统状态']),
        unloader: plain(p['卸柜方']),
        goods: plain(p['货物信息']),
        note: plain(p['备注']),
      });
    }
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return rows;
}

// ---------- 把一行变成提醒 ----------
function slotHm(slot: string | null): [number, number] | null {
  const m = slot?.match(/^(\d{1,2}):(\d{2})$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function containerDue(row: Row): Date {
  const [y, m, d] = ymdParts(row.date!);
  if (row.dateTime) {
    const t = new Date(row.dateTime);
    if (!isNaN(t.getTime())) return t;
  }
  const hm = slotHm(row.slot) ?? [8, 0];
  return localToUtc(y, m, d, hm[0], hm[1]);
}

// 时段标签：优先用「时间」列；日期列自带时间的用那个；都没有 = 待定
function slotLabel(row: Row, pending: string): string {
  if (slotHm(row.slot)) return row.slot!;
  if (row.dateTime) {
    const t = new Date(row.dateTime);
    if (!isNaN(t.getTime())) {
      return new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
    }
  }
  return pending;
}

function containerTitle(row: Row): string {
  const what = row.container || row.size || row.orderNo || '货柜';
  return ['到柜 ' + slotLabel(row, '时段待定'), what, row.shipper].filter(Boolean).join(' · ');
}

function containerNotes(row: Row): string {
  const lines = [
    row.orderNo ? `入库单号：${row.orderNo}` : '',
    row.size ? `货柜：${row.size}` : '',
    row.unloader ? `卸柜方：${row.unloader}` : '',
    row.goods ? `货物：${row.goods}` : '',
    row.note ? `备注：${row.note}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function shortLine(row: Row): string {
  return [slotLabel(row, '待定'), row.container || row.size || '—', row.shipper, row.size && row.container ? row.size : '', row.orderNo]
    .filter(Boolean)
    .join(' · ');
}

function buildDesired(rows: Row[], today: string, dbUrl: string): Map<string, Desired> {
  const desired = new Map<string, Desired>();
  const byDate = new Map<string, Row[]>();
  for (const row of rows) {
    if (!row.date) continue;
    const key = `page:${row.id}`;
    // 已卸柜：不管日期，都作为「已完成」的记录保留（历史也能在日历里看到）
    if (row.status === '已卸柜') {
      desired.set(key, {
        key,
        title: containerTitle(row),
        notes: containerNotes(row),
        due_at: containerDue(row).toISOString(),
        link: row.url,
        priority: 'medium',
        remind_before_min: 30,
        overdue_repeat_min: 60,
        done: 'Notion · 已卸柜',
      });
      continue;
    }
    if (row.status !== '已预约' || row.date < today) continue;
    if (row.date > addDays(today, 60)) continue;
    desired.set(key, {
      key,
      title: containerTitle(row),
      notes: containerNotes(row),
      due_at: containerDue(row).toISOString(),
      link: row.url,
      priority: 'medium',
      remind_before_min: 30,
      overdue_repeat_min: 60,
    });
    const list = byDate.get(row.date) ?? [];
    list.push(row);
    byDate.set(row.date, list);
  }
  // 汇总：前一个工作日 16:00
  for (const [date, list] of byDate) {
    const prev = prevWorkingDay(date);
    if (prev < today) continue; // 已经过了汇总时间点的不再补建
    const [y, m, d] = ymdParts(prev);
    const due = localToUtc(y, m, d, 16, 0);
    const when = addDays(prev, 1) === date ? '明天' : WD_ZH[weekday(date)];
    list.sort((a, b) => (a.slot ?? '').localeCompare(b.slot ?? ''));
    const key = `digest:${date}`;
    desired.set(key, {
      key,
      title: `${when}到柜 ${list.length} 柜（${date.slice(5).replace('-', '.')}）`,
      notes: list.map(shortLine).join('\n'),
      due_at: due.toISOString(),
      link: dbUrl,
      priority: 'low',
      remind_before_min: 0,
      overdue_repeat_min: 0,
    });
  }
  return desired;
}

// ---------- 主流程 ----------
Deno.serve(async (req) => {
  const secret = Deno.env.get('SYNC_SECRET') ?? '';
  if (!secret || req.headers.get('x-sync-secret') !== secret) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  const token = Deno.env.get('NOTION_TOKEN');
  if (!token) return json({ error: 'NOTION_TOKEN not set' }, 500);
  const dbId = Deno.env.get('NOTION_DATABASE_ID') ?? '614b6528-7de4-4dd4-b9ba-189892cb2387';
  const dbUrl = `https://www.notion.so/${dbId.replace(/-/g, '')}`;

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const started = new Date();
  const stats = { created: 0, updated: 0, archived: 0, completed: 0 };
  let message = '';
  let ok = true;

  try {
    // 创建人 / 班组
    let creatorId = Deno.env.get('CREATOR_PROFILE_ID') ?? '';
    if (!creatorId) {
      const { data } = await supabase.from('profiles').select('id').eq('role', 'admin').eq('active', true).order('created_at').limit(1);
      creatorId = data?.[0]?.id ?? '';
    }
    if (!creatorId) throw new Error('no admin profile to own synced reminders');
    const teamName = Deno.env.get('TEAM_NAME_ZH') ?? '入库组';
    const { data: teamRows } = await supabase.from('teams').select('id').eq('name_zh', teamName).limit(1);
    const teamId: string | null = teamRows?.[0]?.id ?? null;

    const today = localYmd(new Date());
    // 默认只看最近 7 天起的行；POST 体 {"since":"2026-08-01"} 可以把更早的历史一起补进来
    let since = addDays(today, -7);
    try {
      const body = await req.json();
      if (typeof body?.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.since)) since = body.since;
    } catch {
      // 没有请求体
    }
    const rows = await fetchNotionRows(token, dbId, since);
    const rowById = new Map(rows.map((r) => [`page:${r.id}`, r]));
    const desired = buildDesired(rows, today, dbUrl);
    const [sy, sm, sd] = ymdParts(since);
    const sinceMs = localToUtc(sy, sm, sd, 0, 0).getTime();

    const { data: existingRows, error: exErr } = await supabase
      .from('reminders')
      .select('id, source_key, title, notes, due_at, link, priority, remind_before_min, overdue_repeat_min, archived, team_id')
      .eq('source', SOURCE);
    if (exErr) throw exErr;
    const existing = new Map((existingRows ?? []).map((r: any) => [r.source_key as string, r]));

    // 已经有完成记录的提醒 id（避免重复写 completion）
    const existingIds = (existingRows ?? []).map((r: any) => r.id as string);
    const completedIds = new Set<string>();
    if (existingIds.length) {
      const { data: compRows, error: compErr } = await supabase.from('completions').select('reminder_id').in('reminder_id', existingIds);
      if (compErr) throw compErr;
      for (const c of compRows ?? []) completedIds.add((c as any).reminder_id as string);
    }

    const markDone = async (reminderId: string, dueAt: string, name: string) => {
      if (completedIds.has(reminderId)) return;
      const { error } = await supabase.from('completions').insert({
        reminder_id: reminderId,
        occurrence_at: dueAt,
        completed_by: creatorId,
        completed_by_name: name,
        note: '',
      });
      if (error) throw error;
      completedIds.add(reminderId);
      stats.completed++;
    };

    // 1) 新建 / 更新
    for (const want of desired.values()) {
      const cur = existing.get(want.key);
      if (!cur) {
        const { data: ins, error } = await supabase
          .from('reminders')
          .insert({
            title: want.title,
            notes: want.notes,
            due_at: want.due_at,
            tz: TZ,
            rrule: null,
            skip_holidays: false,
            remind_before_min: want.remind_before_min,
            overdue_repeat_min: want.overdue_repeat_min,
            priority: want.priority,
            visibility: 'team',
            team_id: teamId,
            created_by: creatorId,
            link: want.link,
            completion_mode: 'any',
            archived: false,
            source: SOURCE,
            source_key: want.key,
          })
          .select('id')
          .single();
        if (error) throw error;
        if (teamId) {
          const { error: aErr } = await supabase.from('reminder_assignees').insert({ reminder_id: ins.id, team_id: teamId });
          if (aErr) throw aErr;
        }
        stats.created++;
        if (want.done) await markDone(ins.id, want.due_at, want.done);
        continue;
      }
      if (want.done) await markDone(cur.id, want.due_at, want.done);
      const changed =
        cur.title !== want.title ||
        cur.notes !== want.notes ||
        new Date(cur.due_at).getTime() !== new Date(want.due_at).getTime() ||
        cur.link !== want.link ||
        cur.priority !== want.priority ||
        cur.remind_before_min !== want.remind_before_min ||
        cur.overdue_repeat_min !== want.overdue_repeat_min ||
        cur.archived === true ||
        (teamId && cur.team_id !== teamId);
      if (changed) {
        const { error } = await supabase
          .from('reminders')
          .update({
            title: want.title,
            notes: want.notes,
            due_at: want.due_at,
            link: want.link,
            priority: want.priority,
            remind_before_min: want.remind_before_min,
            overdue_repeat_min: want.overdue_repeat_min,
            archived: false,
            team_id: teamId ?? cur.team_id,
          })
          .eq('id', cur.id);
        if (error) throw error;
        stats.updated++;
      }
    }

    // 2) 不再需要的：取消 / 改期 / 爽约 / 行被删 → 归档。只看这次读取窗口内的提醒，更早的历史不动
    for (const [key, cur] of existing) {
      if (desired.has(key) || cur.archived) continue;
      if (new Date(cur.due_at).getTime() < sinceMs) continue;
      if (key.startsWith('digest:')) {
        // 过去的汇总留作记录；未来的（例如整天的柜都取消了）归档
        const date = key.slice('digest:'.length);
        if (date >= today) {
          await supabase.from('reminders').update({ archived: true }).eq('id', cur.id);
          stats.archived++;
        }
        continue;
      }
      const row = rowById.get(key);
      if (!row || ['取消', '改期', '爽约'].includes(row.status) || (row.date && row.date < today && row.status !== '已预约')) {
        await supabase.from('reminders').update({ archived: true }).eq('id', cur.id);
        stats.archived++;
      }
      // 仍是「已预约」但日期已过：留着（会显示逾期，提醒大家去 Notion 更新状态）
    }
    message = `since=${since} rows=${rows.length} desired=${desired.size}`;
  } catch (e) {
    ok = false;
    message = (e as Error).message ?? String(e);
    console.error('sync failed', e);
  }

  await supabase.from('sync_runs').insert({
    source: SOURCE,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    ok,
    ...stats,
    message,
  });

  return json({ ok, ...stats, message }, ok ? 200 : 500);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
