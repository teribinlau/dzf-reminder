// 盘点之后的「核实任务」：要核实的库位做成一条普通提醒（用提醒原来的新建接口，不另建表、不改提醒页）。
//   系统有货现场空     → 核实系统里的货去哪了（库位本身按可用空位算）
//   系统有货现场无位置 → 移库时核对
// 提醒建好后打开编辑框，时间、指派给谁、备注都可以再改。
import { toZonedTime } from 'date-fns-tz';
import { localToUtc } from './recurrence';
import { TZ, type Profile, type ReminderInput, type Settings } from './types';
import { qtyText, verdictOf, type LocGroup } from './stocktake';

export interface FollowUpItem {
  loc: string;
  kind: 'sysFull' | 'sysNoSlot';
  /** 系统里这个库位上的货：SKU ×应有（系统 · 客户） */
  goods: string[];
  note: string;
}

/** 要核实的库位（按走行顺序） */
export function followUpItems(groups: LocGroup[]): FollowUpItem[] {
  const out: FollowUpItem[] = [];
  for (const g of groups) {
    const v = verdictOf(g);
    if (v !== 'sysFull' && v !== 'sysNoSlot') continue;
    const goods = g.rows
      .filter((r) => !r.added && r.sku && r.hi > 0)
      .map((r) => {
        const from = [r.wms, r.customer].filter(Boolean).join(' · ');
        return `${r.sku} ×${qtyText(r.lo, r.hi)}${from ? `（${from}）` : ''}`;
      });
    out.push({ loc: g.loc, kind: v, goods, note: g.head.note });
  }
  return out;
}

/** 提醒里的文字（界面语言） */
export interface FollowUpText {
  title: string;
  intro: string;
  sysFull: string;
  sysNoSlot: string;
  more: (n: number) => string;
  outro: string;
}

/** 备注里最多写几个库位（太长的提醒不好看；完整清单在导出表的「差异明细」页） */
export const FOLLOW_MAX = 60;

/** 默认：明天 9:00（柏林），指派给自己的班组（没有班组就给自己），和新建提醒的默认一样 */
export function followUpInput(
  items: FollowUpItem[],
  me: Pick<Profile, 'id' | 'team_id'>,
  settings: Pick<Settings, 'defaultRemindBefore' | 'overdueRepeatMin'>,
  text: FollowUpText,
  now = new Date(),
): ReminderInput {
  const z = toZonedTime(now, TZ);
  const day = new Date(z.getFullYear(), z.getMonth(), z.getDate() + 1);
  const due = localToUtc(day.getFullYear(), day.getMonth() + 1, day.getDate(), 9, 0);
  const shown = items.slice(0, FOLLOW_MAX);
  const lines: string[] = [text.intro];
  for (const kind of ['sysFull', 'sysNoSlot'] as const) {
    const list = shown.filter((x) => x.kind === kind);
    if (!list.length) continue;
    lines.push('', kind === 'sysFull' ? text.sysFull : text.sysNoSlot);
    for (const it of list) lines.push(`${it.loc}  ${it.goods.join(' / ')}${it.note ? ` · ${it.note}` : ''}`);
  }
  if (items.length > shown.length) lines.push('', text.more(items.length - shown.length));
  lines.push('', text.outro);
  return {
    title: text.title,
    notes: lines.join('\n'),
    due_at: due.toISOString(),
    rrule: null,
    skip_holidays: true,
    remind_before_min: settings.defaultRemindBefore,
    overdue_repeat_min: settings.overdueRepeatMin,
    priority: 'medium',
    visibility: 'team',
    team_id: me.team_id,
    link: '',
    completion_mode: 'any',
    require_upload: false,
    assignee_user_ids: me.team_id ? [] : [me.id],
    assignee_team_ids: me.team_id ? [me.team_id] : [],
  };
}

/** 本机记一下这次盘点建过的核实提醒（再点就是打开它，不重复建） */
export const followKey = (takeId: string) => `dzf-st-followup-v1:${takeId}`;
