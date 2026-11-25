// 「仓库 → 整理」的规则（不碰界面、不碰网络）：
//   - 3D 页发来的「加入整理」消息怎么收（只收形状对的）；
//   - 清单按走的顺序排（厅 → 通道 → 位号 → 排 → 层）、按通道分组；
//   - 一次现场操作在本机先改成什么样（和数据库函数 tidy_act 同一套规则，离线时先显示、联网后补传）；
//   - 扫到的库位码对上清单里的哪一条。
import { normLoc } from './stocktake';
import { SOURCES, aisleOf, parseShelf } from './stocktakeBuild';
import type { TidyAct, TidyDraft, TidyStatus, TidyTask } from './types';

/** 还没结束的状态 */
export const TIDY_OPEN: TidyStatus[] = ['todo', 'moved', 'problem'];
export const isOpen = (t: TidyTask) => TIDY_OPEN.includes(t.status);
/** 货架库位的统一写法 */
export const isSlot = (s: string) => /^B[1-9]-\d{2}-\d{2}-\d{2}$/.test(s);
/** 货实际在 / 要去的库位 */
export const targetOf = (t: TidyTask) => t.moved_to || t.dst;

export function newTidyId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // 老浏览器 / 不是 https 时没有 randomUUID
  const b = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const num01 = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 50 ? v : null);

/**
 * 3D 页发来的任务（{kind, src, dst, sys, cust, fill, before, after, same, lines}）→ TidyDraft。
 * 只收形状对的：库位必须是货架库位的统一写法，移库任务要有不同于来源的目标；最多 500 条。
 */
export function asTidyDrafts(raw: unknown): TidyDraft[] {
  if (!Array.isArray(raw)) return [];
  const out: TidyDraft[] = [];
  const seen = new Set<string>();
  for (const x of raw.slice(0, 500)) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const kind = o.kind === 'pallet' ? 'pallet' : o.kind === 'move' ? 'move' : null;
    const src = typeof o.src === 'string' ? o.src.trim().toUpperCase() : '';
    const dst = kind === 'move' && typeof o.dst === 'string' ? o.dst.trim().toUpperCase() : '';
    if (!kind || !isSlot(src) || seen.has(src)) continue;
    if (kind === 'move' && (!isSlot(dst) || dst === src)) continue;
    seen.add(src);
    const lines: [string, number][] = [];
    if (Array.isArray(o.lines)) {
      for (const l of o.lines.slice(0, 200)) {
        if (Array.isArray(l) && typeof l[0] === 'string' && typeof l[1] === 'number' && Number.isFinite(l[1])) lines.push([l[0].slice(0, 80), l[1]]);
      }
    }
    out.push({
      id: newTidyId(),
      kind,
      src,
      dst,
      sys: typeof o.sys === 'string' ? o.sys.slice(0, 12) : '',
      cust: typeof o.cust === 'string' ? o.cust.slice(0, 120) : '',
      fill: num01(o.fill),
      before: num01(o.before),
      after: num01(o.after),
      same: o.same === true,
      lines,
      note: typeof o.note === 'string' ? o.note.trim().slice(0, 500) : '',
    });
  }
  return out;
}

/** 手机上报的空托盘 */
export function palletDraft(src: string, note = ''): TidyDraft {
  return { id: newTidyId(), kind: 'pallet', src, dst: '', sys: '', cust: '', fill: null, before: null, after: null, same: false, lines: [], note: note.trim().slice(0, 500) };
}

/** 草稿在本机先显示成的样子（服务器回来后换成真的那一行） */
export function draftToTask(d: TidyDraft, userId: string | null, name: string, at: string): TidyTask {
  return {
    id: d.id,
    kind: d.kind,
    src: d.src,
    dst: d.dst,
    hall: d.src.slice(1, 2),
    sys: d.sys,
    customer: d.cust,
    fill: d.fill,
    dst_before: d.before,
    dst_after: d.after,
    same_sku: d.same,
    lines: d.lines,
    status: 'todo',
    problem: '',
    note: d.note,
    moved_to: '',
    created_by: userId,
    created_by_name: name,
    created_at: at,
    acted_by: null,
    acted_by_name: '',
    acted_at: null,
    exported_at: null,
    exported_by: null,
    closed_at: null,
  };
}

/**
 * 清单里能不能加这条：来源已经有没结束的任务、来源正是别的任务的目标、目标正是别的任务的来源 → 不能
 * （和数据库函数 tidy_add 一样）。返回不能加的原因，能加返回 null。
 */
export function addBlocked(tasks: TidyTask[], d: Pick<TidyDraft, 'kind' | 'src' | 'dst'>): 'listed' | 'isTarget' | 'targetLeaving' | null {
  for (const t of tasks) {
    if (!isOpen(t)) continue;
    if (t.src === d.src) return 'listed';
    if (t.kind === 'move' && (t.dst === d.src || t.moved_to === d.src)) return 'isTarget';
    if (t.kind === 'move' && d.kind === 'move' && t.src === d.dst) return 'targetLeaving';
  }
  return null;
}

/** 一次操作在本机先改成什么样（规则和数据库函数 tidy_act 一样；状态对不上就原样返回） */
export function applyTidyAct(t: TidyTask, a: TidyAct, opts: { userId: string | null; name: string; at: string; admin: boolean }): TidyTask {
  const who = { acted_by: opts.userId, acted_by_name: opts.name, acted_at: opts.at };
  if (t.acted_at && opts.at < t.acted_at) return t;
  switch (a.action) {
    case 'moved': {
      if (t.kind !== 'move' || (t.status !== 'todo' && t.status !== 'problem')) return t;
      const to = (a.dst || t.dst).trim().toUpperCase();
      if (!isSlot(to) || to === t.src) return t;
      return { ...t, ...who, status: 'moved', moved_to: to, problem: '', note: a.note === undefined ? t.note : a.note.trim().slice(0, 500) };
    }
    case 'problem':
      if (t.status !== 'todo' && t.status !== 'problem') return t;
      return { ...t, ...who, status: 'problem', problem: a.problem, note: a.note.trim().slice(0, 500) };
    case 'reopen':
      if ((t.status !== 'moved' && t.status !== 'problem') || t.exported_at) return t;
      return { ...t, ...who, status: 'todo', moved_to: '', problem: '' };
    case 'done':
      if (t.kind === 'pallet' ? t.status !== 'todo' && t.status !== 'problem' : t.status !== 'moved' || !opts.admin) return t;
      return { ...t, ...who, status: 'done', problem: '', closed_at: opts.at };
    case 'cancel':
      if ((t.status !== 'todo' && t.status !== 'problem') || (t.created_by !== opts.userId && !opts.admin)) return t;
      return { ...t, ...who, status: 'cancelled', closed_at: opts.at };
    case 'retarget': {
      const to = a.dst.trim().toUpperCase();
      if (t.kind !== 'move' || (t.status !== 'todo' && t.status !== 'problem') || !isSlot(to) || to === t.src) return t;
      return { ...t, ...who, dst: to, same_sku: false, dst_before: null, dst_after: null };
    }
  }
}

export interface TidyPos {
  hall: string;
  r: number;
  p: number;
  l: number;
  aisle: string;
}

/** 库位 → 厅 / 排 / 位 / 层 / 通道（通道的分法和盘点一样：01 单独，02+03、04+05 …） */
export function tidyPos(loc: string): TidyPos | null {
  const s = parseShelf(loc);
  return s ? { hall: s.hall, r: s.r, p: s.p, l: s.l, aisle: aisleOf(s.hall, s.r) } : null;
}

const aisleRank = (a: string) => Number(a.split('-')[0]);

/** 走的顺序：厅 → 通道 → 位号 → 排 → 层（按来源库位） */
export function sortTidy(tasks: TidyTask[]): TidyTask[] {
  const key = (t: TidyTask) => {
    const p = tidyPos(t.src);
    return p ? [Number(p.hall), aisleRank(p.aisle), p.p, p.r, p.l] : [99, 0, 0, 0, 0];
  };
  return [...tasks].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  });
}

export interface TidyGroup {
  /** '2|14-15' */
  key: string;
  hall: string;
  aisle: string;
  tasks: TidyTask[];
}

/** 按 厅 + 通道 分组（保持走的顺序） */
export function groupTidy(tasks: TidyTask[]): TidyGroup[] {
  const out: TidyGroup[] = [];
  for (const t of sortTidy(tasks)) {
    const p = tidyPos(t.src);
    const hall = p?.hall ?? t.hall;
    const aisle = p?.aisle ?? '';
    const key = `${hall}|${aisle}`;
    const g = out[out.length - 1];
    if (g && g.key === key) g.tasks.push(t);
    else out.push({ key, hall, aisle, tasks: [t] });
  }
  return out;
}

export interface TidyCounts {
  todo: number;
  moved: number;
  problem: number;
  pallet: number;
  /** 已搬、还没出过移库文件的 */
  toExport: number;
  /** 出过文件、还没点「已导入」的 */
  exported: number;
}

export function countTidy(tasks: TidyTask[]): TidyCounts {
  const c: TidyCounts = { todo: 0, moved: 0, problem: 0, pallet: 0, toExport: 0, exported: 0 };
  for (const t of tasks) {
    if (t.status === 'problem') c.problem += 1;
    else if (t.kind === 'pallet') {
      if (t.status === 'todo') c.pallet += 1;
    } else if (t.status === 'todo') c.todo += 1;
    else if (t.status === 'moved') {
      c.moved += 1;
      if (t.exported_at) c.exported += 1;
      else c.toExport += 1;
    }
  }
  return c;
}

/** 一起加进清单的一批移库任务（3D 页点一次「加入整理」= 一批；一条条加的合成最后一组） */
export interface TidyBatch {
  key: string;
  /** 什么时候、谁加的；一条条加的那一组 = null / '' */
  at: string | null;
  name: string;
  /** 这一批一共几条移库任务（搬完的、结束的也算） */
  total: number;
  /** 其中现在还能取消的（待搬 / 有问题，而且是自己加的，或者自己是管理员） */
  open: TidyTask[];
}

/**
 * 「批量取消」里的一批一批：同一个人同一刻加的 = 一批（数据库函数 tidy_add 一次调用里的行是同一个时间），
 * 新的在前；只有一条的不单列，合成「一条条加的」放最后。只算移库任务（空托盘是现场报的，一条条处理）。
 * 没有可取消的批不出现。
 */
export function tidyBatches(tasks: TidyTask[], userId: string | null, admin: boolean): TidyBatch[] {
  const groups = new Map<string, TidyTask[]>();
  for (const t of tasks) {
    if (t.kind !== 'move') continue;
    const k = `${t.created_by ?? ''}|${t.created_at}`;
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  const canCancel = (t: TidyTask) => (t.status === 'todo' || t.status === 'problem') && (admin || (!!userId && t.created_by === userId));
  const out: TidyBatch[] = [];
  const single: TidyBatch = { key: 'single', at: null, name: '', total: 0, open: [] };
  for (const [key, list] of groups) {
    if (list.length < 2) {
      single.total += 1;
      if (canCancel(list[0])) single.open.push(list[0]);
      continue;
    }
    const open = list.filter(canCancel);
    if (open.length) out.push({ key, at: list[0].created_at, name: list[0].created_by_name, total: list.length, open });
  }
  out.sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0) || a.key.localeCompare(b.key));
  if (single.open.length) out.push(single);
  return out;
}

/**
 * 补发时一次并着发哪几条：队列最前面连着的现场操作里，各是各的任务的前 max 条。
 * 碰到「加任务」就停（它后面的操作可能就是对刚加的任务做的），同一条任务的第二个操作也停（要按点的顺序发）。
 */
export function headActs<T extends { op: string; id?: string }>(ops: T[], max: number): T[] {
  const out: T[] = [];
  const ids = new Set<string>();
  for (const o of ops) {
    if (o.op !== 'act' || !o.id || ids.has(o.id) || out.length >= max) break;
    out.push(o);
    ids.add(o.id);
  }
  return out;
}

/** 扫到 / 输入的码 → 统一库位号（认不出返回 null） */
export function scanToLoc(raw: string): string | null {
  const n = normLoc(raw);
  return n && isSlot(n) ? n : null;
}

export type ScanHit =
  /** 是清单里一条还没搬的任务的来源 */
  | { kind: 'source'; task: TidyTask }
  /** 是某条待搬任务的目标（没先扫来源就扫了目标） */
  | { kind: 'target'; task: TidyTask }
  /** 已经搬完 / 在等导入的 */
  | { kind: 'moved'; task: TidyTask }
  /** 清单里没有：可以报空托盘 */
  | { kind: 'free'; loc: string };

/** 扫到的库位在清单里是什么 */
export function matchScan(tasks: TidyTask[], loc: string): ScanHit {
  const open = tasks.filter(isOpen);
  const src = open.find((t) => t.src === loc);
  if (src) return src.status === 'moved' ? { kind: 'moved', task: src } : { kind: 'source', task: src };
  const dst = open.find((t) => t.kind === 'move' && t.status !== 'moved' && t.dst === loc);
  if (dst) return { kind: 'target', task: dst };
  const done = open.find((t) => t.kind === 'move' && t.status === 'moved' && t.moved_to === loc);
  if (done) return { kind: 'moved', task: done };
  return { kind: 'free', loc };
}

/** 占用写成百分比：0.0312 → '3%'，不到 0.5% 写 '<1%'，空的写 '0%' */
export function pctText(f: number | null | undefined): string {
  if (f == null || !Number.isFinite(f)) return '';
  return f <= 0 ? '0%' : f < 0.005 ? '<1%' : `${Math.round(f * 100)}%`;
}

/** 一共几件 */
export const totalQty = (t: TidyTask) => t.lines.reduce((a, l) => a + (Number(l[1]) || 0), 0);

const WMS_NAME = new Map<string, string>(SOURCES.map((x) => [x.key, x.wms]));
/** 系统的叫法：B3 → 盘古 */
export const sysName = (key: string) => WMS_NAME.get(key) ?? key;
