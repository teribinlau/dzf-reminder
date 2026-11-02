// 库位空位盘点（「仓库」→「盘点」）的纯逻辑：库位码识别、按库位分组、判断差异、统计进度。
// 和 Claude 出的《X厅_库位空位盘点表.xlsx》里的「差异类型」公式是同一套规则：
//   应有（件）：下限 = 在库 − 待出（必须在），上限 = 在库；有待出的那部分可能已经拣到备货待发区。
//   勾「空」、下限 > 0                 → 系统有货现场空
//   勾「空」、下限 = 0、上限 > 0       → 待出已拣（不是差异，按空位算，可以放新货）
//   勾「半 / 满」、上限 = 0            → 系统空现场有货
//   实数 < 下限 或 > 上限              → 数量不符
//   勾「异」                           → 异常
//   现场加了表上没有的货               → 有表外的货
import { formatInTimeZone } from 'date-fns-tz';
import { TZ, type StockMark, type StockStatus, type StocktakeRow } from './types';

export const STATUSES: StockStatus[] = ['empty', 'half', 'full', 'odd'];

export type Verdict = 'todo' | 'ok' | 'picked' | 'odd' | 'sysFull' | 'sysEmpty' | 'qty' | 'found';
/** 算「差异」的几种（待出已拣不算） */
export const DIFF_VERDICTS: Verdict[] = ['odd', 'sysFull', 'sysEmpty', 'qty', 'found'];
export const isDiff = (v: Verdict) => DIFF_VERDICTS.includes(v);

/** 一个库位：同库位的几行放在一起（第一行是表上的首行，现场加的跟在后面） */
export interface LocGroup {
  loc: string;
  aisle: string;
  pos: number | null;
  head: StocktakeRow;
  rows: StocktakeRow[];
  extra: boolean;
}

const pad2 = (n: number | string) => String(Number(n)).padStart(2, '0');

/**
 * 扫到 / 输入的库位码 → 统一写法 B{厅}-{排}-{位}-{层}。认不出返回 null。
 *  - B4-13-44-03、B04-13-44-03、b4-13-44-3、带空格 / 全角横杠
 *  - 盘古 12 位码：厅2 区2 排3 0 位2 层2 → 030101601003 = B3-16-10-03
 *  - 标签里夹着别的字（如「LOC:B4-13-44-03」）也能认出中间那段
 */
export function normLoc(raw: string): string | null {
  const s = raw
    .trim()
    .toUpperCase()
    .replace(/[‐-―−－]/g, '-')
    .replace(/\s+/g, '');
  const b = s.match(/^B0?(\d)-(\d{1,3})-(\d{1,3})-(\d{1,3})$/);
  if (b) return `B${b[1]}-${pad2(b[2])}-${pad2(b[3])}-${pad2(b[4])}`;
  const d = s.match(/^(\d{2})(\d{2})(\d{3})0(\d{2})(\d{2})$/);
  if (d) return `B${Number(d[1])}-${pad2(d[3])}-${pad2(d[4])}-${pad2(d[5])}`;
  const inner = s.match(/B0?(\d)-(\d{1,3})-(\d{1,3})-(\d{1,3})/);
  if (inner) return `B${inner[1]}-${pad2(inner[2])}-${pad2(inner[3])}-${pad2(inner[4])}`;
  return null;
}

/** 扫码索引：各种写法 → 统一库位号 */
export function buildScanIndex(rows: StocktakeRow[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const r of rows) {
    if (!r.is_first || r.added) continue;
    const keys = [r.loc, ...(r.codes ?? [])];
    for (const k of keys) {
      if (!k) continue;
      idx.set(k.trim().toUpperCase(), r.loc);
      const n = normLoc(k);
      if (n && !idx.has(n)) idx.set(n, r.loc);
    }
  }
  return idx;
}

/** 扫到的码 → 这次盘点里的库位（没有就是 null） */
export function findLoc(idx: Map<string, string>, raw: string): string | null {
  const s = raw.trim().toUpperCase();
  if (!s) return null;
  if (idx.has(s)) return idx.get(s)!;
  const n = normLoc(s);
  return n ? idx.get(n) ?? null : null;
}

/** 行排序：走行顺序，同一库位里表上的在前、现场加的按加的先后 */
export function sortRows(rows: StocktakeRow[]): StocktakeRow[] {
  return [...rows].sort((a, b) => a.seq - b.seq || Number(a.added) - Number(b.added) || a.id - b.id);
}

/** 按库位分组（保持走行顺序） */
export function groupLocations(rows: StocktakeRow[]): LocGroup[] {
  const map = new Map<string, StocktakeRow[]>();
  for (const r of sortRows(rows)) {
    const list = map.get(r.loc);
    if (list) list.push(r);
    else map.set(r.loc, [r]);
  }
  const out: LocGroup[] = [];
  for (const [loc, list] of map) {
    const head = list.find((r) => r.is_first && !r.added) ?? list[0];
    out.push({ loc, aisle: head.aisle, pos: head.pos, head, rows: [head, ...list.filter((r) => r !== head)], extra: head.extra });
  }
  return out;
}

/** 通道顺序（按第一次出现） */
export function aisleOrder(groups: LocGroup[]): string[] {
  const seen: string[] = [];
  for (const g of groups) if (!seen.includes(g.aisle)) seen.push(g.aisle);
  return seen;
}

/** 通道显示：'02-03' → '02/03 排' */
export function aisleLabel(aisle: string, lang: string): string {
  const a = aisle.replace(/-/g, '/');
  return lang.startsWith('de') ? `Reihe ${a}` : `${a} 排`;
}

/** 应有（件）的写法：没有待出一个数，有待出「下限~上限」，空库位空着 */
export function qtyText(lo: number, hi: number): string {
  if (hi <= 0) return '';
  return lo === hi ? String(hi) : `${lo}~${hi}`;
}

/** 一个库位现在算什么 */
export function verdictOf(g: LocGroup): Verdict {
  const sys = g.rows.filter((r) => !r.added);
  const lo = sys.reduce((s, r) => s + r.lo, 0);
  const hi = sys.reduce((s, r) => s + r.hi, 0);
  const found = g.rows.some((r) => r.added);
  switch (g.head.status) {
    case null:
      return 'todo';
    case 'odd':
      return 'odd';
    case 'empty':
      if (lo > 0) return 'sysFull';
      if (hi > 0) return found ? 'found' : 'picked';
      return found ? 'found' : 'ok';
    default: {
      if (hi === 0) return 'sysEmpty';
      const qtyOff = sys.some((r) => r.actual !== null && (r.actual < r.lo || r.actual > r.hi));
      if (qtyOff) return 'qty';
      return found ? 'found' : 'ok';
    }
  }
}

/** 一行的数在不在范围里（没填实数就不算不符） */
export function qtyOff(r: StocktakeRow): boolean {
  return !r.added && r.actual !== null && (r.actual < r.lo || r.actual > r.hi);
}

export interface Stats {
  total: number;
  done: number;
  empty: number;
  picked: number;
  half: number;
  canAdd: number;
  full: number;
  odd: number;
  diff: number;
}

export function emptyStats(): Stats {
  return { total: 0, done: 0, empty: 0, picked: 0, half: 0, canAdd: 0, full: 0, odd: 0, diff: 0 };
}

export function addStats(s: Stats, g: LocGroup, v: Verdict = verdictOf(g)): Stats {
  s.total += 1;
  const st = g.head.status;
  if (st) s.done += 1;
  if (st === 'empty') s.empty += 1;
  if (v === 'picked') s.picked += 1;
  if (st === 'half') {
    s.half += 1;
    s.canAdd += g.head.can_add ?? 0;
  }
  if (st === 'full') s.full += 1;
  if (st === 'odd') s.odd += 1;
  if (isDiff(v)) s.diff += 1;
  return s;
}

/** 每条通道的统计 + 全部合计 */
export function statsByAisle(groups: LocGroup[]): { aisles: { aisle: string; stats: Stats }[]; total: Stats } {
  const by = new Map<string, Stats>();
  const total = emptyStats();
  for (const g of groups) {
    const v = verdictOf(g);
    if (!by.has(g.aisle)) by.set(g.aisle, emptyStats());
    addStats(by.get(g.aisle)!, g, v);
    addStats(total, g, v);
  }
  return { aisles: aisleOrder(groups).map((aisle) => ({ aisle, stats: by.get(aisle)! })), total };
}

export function markOf(r: StocktakeRow): StockMark {
  return { status: r.status, can_add: r.can_add, actual: r.actual, note: r.note ?? '' };
}

export function sameMark(a: StockMark, b: StockMark): boolean {
  return a.status === b.status && a.can_add === b.can_add && a.actual === b.actual && (a.note ?? '') === (b.note ?? '');
}

/** 本地先改（乐观更新）：规则和数据库里的 stocktake_mark() 一样 */
export function applyMark(r: StocktakeRow, m: StockMark, name: string, userId: string | null, at: string): StocktakeRow {
  const status = r.is_first ? m.status : null;
  const note = (m.note ?? '').trim().slice(0, 500);
  const clear = status === null && m.actual === null && note === '';
  return {
    ...r,
    status,
    can_add: status === 'half' ? m.can_add : null,
    actual: m.actual,
    note,
    counted_by: clear ? null : userId,
    counted_by_name: clear ? '' : name,
    counted_at: clear ? null : at,
  };
}

/** 几点几分（柏林时间）；不是今天的带日期 */
export function hhmm(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = formatInTimeZone(d, TZ, 'yyyy-MM-dd') === formatInTimeZone(now, TZ, 'yyyy-MM-dd');
  return formatInTimeZone(d, TZ, sameDay ? 'HH:mm' : 'MM-dd HH:mm');
}

/** 输入框里的件数：空 = null，其他非负整数 */
export function parseCount(v: string): number | null | 'bad' {
  const s = v.trim();
  if (!s) return null;
  if (!/^\d{1,6}$/.test(s)) return 'bad';
  return Number(s);
}
