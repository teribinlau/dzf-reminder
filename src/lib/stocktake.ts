// 库位空位盘点（「仓库」→「盘点」）的纯逻辑：库位码识别、按库位分组、判断差异、统计进度。
// 和 Claude 出的《X厅_库位空位盘点表.xlsx》里的「差异类型」公式是同一套规则：
//   应有（件）：下限 = 在库 − 待出（必须在），上限 = 在库；有待出的那部分可能已经拣到备货待发区。
//   勾「空」、下限 > 0                 → 系统有货现场空（差异；库位按可用空位算，系统里的货要核实去哪了）
//   勾「空」、下限 = 0、上限 > 0       → 待出已拣（不是差异，按空位算，可以放新货）
//   勾「半 / 满」、上限 = 0            → 系统空现场有货
//   勾「无」、上限 = 0                 → 现场无位置（不是差异：这个号现在没有能用的位置，比如那一列放了 2 个大托）
//   勾「无」、上限 > 0                 → 系统有货现场无位置（差异，移库时核对；只有待出的也算）
//   实数 < 下限 或 > 上限              → 数量不符
//   勾「异」                           → 异常
//   现场加了表上没有的货               → 有表外的货
// 备注里写「挪」（或 move）= 要先挪开旁边的托盘才放得下：单独统计成备用库位，不算可用空位。
import { formatInTimeZone } from 'date-fns-tz';
import { TZ, type StockMark, type StockStatus, type StocktakeRow } from './types';

/** 按钮顺序：空 半 满 无 异 */
export const STATUSES: StockStatus[] = ['empty', 'half', 'full', 'none', 'odd'];

export type Verdict = 'todo' | 'ok' | 'picked' | 'noSlot' | 'odd' | 'sysFull' | 'sysEmpty' | 'sysNoSlot' | 'qty' | 'found';
/** 全部判断（导出时按这个顺序取名字） */
export const VERDICTS: Verdict[] = ['todo', 'ok', 'picked', 'noSlot', 'odd', 'sysFull', 'sysEmpty', 'sysNoSlot', 'qty', 'found'];
/** 算「差异」的几种（待出已拣、系统没货的「无」不算） */
export const DIFF_VERDICTS: Verdict[] = ['odd', 'sysFull', 'sysEmpty', 'sysNoSlot', 'qty', 'found'];
export const isDiff = (v: Verdict) => DIFF_VERDICTS.includes(v);

/** 备注里写了「挪」或 move（不分大小写，remove / moved 不算）：要先挪开旁边的托盘才放得下 */
export function isMoveNote(note: string | null | undefined): boolean {
  return !!note && /挪|\bmove\b/i.test(note);
}

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
    case 'none':
      if (hi > 0) return 'sysNoSlot';
      return found ? 'found' : 'noSlot';
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

/** 一个库位上记下的货：表上有数的 SKU，加上现场加的（SKU，没写 SKU 的用备注） */
export interface LocProduct {
  sku: string;
  wms: string;
  customer: string;
  /** 表上的：应有（下限~上限）；现场加的：件数 */
  lo: number;
  hi: number;
  found: boolean;
}

export function productsOf(g: LocGroup): LocProduct[] {
  const out: LocProduct[] = [];
  for (const r of g.rows) {
    if (r.added) {
      const name = (r.sku || r.note).trim();
      if (name) out.push({ sku: name, wms: r.wms, customer: r.customer, lo: r.actual ?? 0, hi: r.actual ?? 0, found: true });
    } else if (r.sku.trim() && r.hi > 0) out.push({ sku: r.sku.trim(), wms: r.wms, customer: r.customer, lo: r.lo, hi: r.hi, found: false });
  }
  return out;
}

/** 勾了「半」、却不知道是什么货（表上没货，也没加「表上没有的货」）：移库合并要用，得补记 */
export function needsProduct(g: LocGroup): boolean {
  return g.head.status === 'half' && productsOf(g).length === 0;
}

export interface Stats {
  total: number;
  done: number;
  /** 勾「空」的 */
  empty: number;
  /** 可用空位：勾「空」、备注没写挪（系统有货现场空、待出已拣的也算） */
  usable: number;
  picked: number;
  half: number;
  canAdd: number;
  /** 勾「半」但没记是什么货 */
  halfNoSku: number;
  full: number;
  none: number;
  odd: number;
  /** 备注写了「挪 / move」的：备用库位，需整理后才能用 */
  move: number;
  /** 系统有货现场空：系统里的货要核实去哪了 */
  missing: number;
  /** 系统有货现场无位置：移库时核对 */
  noSlotDiff: number;
  diff: number;
}

export function emptyStats(): Stats {
  return { total: 0, done: 0, empty: 0, usable: 0, picked: 0, half: 0, canAdd: 0, halfNoSku: 0, full: 0, none: 0, odd: 0, move: 0, missing: 0, noSlotDiff: 0, diff: 0 };
}

export function addStats(s: Stats, g: LocGroup, v: Verdict = verdictOf(g)): Stats {
  s.total += 1;
  const st = g.head.status;
  const move = isMoveNote(g.head.note);
  if (st) s.done += 1;
  if (move) s.move += 1;
  if (st === 'empty') {
    s.empty += 1;
    if (!move) s.usable += 1;
  }
  if (v === 'picked') s.picked += 1;
  if (st === 'half') {
    s.half += 1;
    s.canAdd += g.head.can_add ?? 0;
    if (needsProduct(g)) s.halfNoSku += 1;
  }
  if (st === 'full') s.full += 1;
  if (st === 'none') s.none += 1;
  if (st === 'odd') s.odd += 1;
  if (v === 'sysFull') s.missing += 1;
  if (v === 'sysNoSlot') s.noSlotDiff += 1;
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
