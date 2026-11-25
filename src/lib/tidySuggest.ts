// 「整理」里扫到一个库位：系统里这个库位有什么货、占多少、可以并到哪。
//
// 规则和「3D 仓库」页的「整理」一样（那边的 tTargets / tidyPick，见 SKU 库位查询的 web3d/3d.tpl.html；
// 算术顺序也照那边写，浮点结果一样，测试里和 Python 的独立重算逐条对过）：
//   - 占用 = 货物体积 ÷ 一个托位（1.2×0.8×1.7 m³）；在库 = E14（已经含待出），体积按在库算。
//   - 整个库位一起搬。里面有待出、不良 / 暂存的不动；一个库位里有几个系统或几个客户的货不建议。
//   - 目标 = 同一个系统里已经有货的货架托位、客户一样（那里不能有别的客户的货）、都有尺寸、
//     不往更高的层搬、并入后不超过 80% 托。排序：同 SKU → 目标在 1 层 → 近（同通道 → 同厅 → 别的厅）→ 库位号。
//   - 清单里没结束的任务先算进去：它们的来源不再当目标，目标的占用加上要并进来的体积。
// 和 3D 页不一样的只有一处：这里没有「占用不超过 20%」的门槛 —— 人就站在库位前面，搬不搬自己定。
//
// 库存来自「SKU 库位查询」的 /api/stock?hall=1,2,3,4&dims=1（1–4 厅货架，每行带产品长宽高）。
import { CAPACITY } from './capacity';
import { SOURCES, type StockSync } from './stocktakeBuild';
import { isOpen, isSlot, newTidyId, targetOf } from './tidy';
import type { TidyDraft, TidyTask } from './types';

/** 一个托位的体积（m³），同库容表 */
export const PALLET_M3 = 1.2 * 0.8 * 1.7;
/** 并入后不超过这么多托 */
export const TIDY_LIMIT = 0.8;
/** 一次最多给几个目标 */
export const TIDY_MAX_TARGETS = 4;

/** /api/stock?…&dims=1 的一行：[显示库位, 原码, 来源下标, SKU, 在库, 待出, 库存类型（'' = 良品）, 客户代码, [长, 宽, 高]（cm）| null] */
export type RackApiRow = [string, string, number, string, number, number, string, string, [number, number, number] | null];

export interface RackSnapshot {
  /** 取数据的时间 */
  at: string;
  sync: Record<string, StockSync>;
  rows: RackApiRow[];
}

/** 服务器回来的 JSON → RackSnapshot（形状不对就抛错） */
export function parseRackSnapshot(j: unknown): RackSnapshot {
  const o = j as { at?: unknown; sync?: unknown; rows?: unknown };
  if (!o || typeof o !== 'object' || !Array.isArray(o.rows)) throw new Error('BAD_RACKS');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
  const rows: RackApiRow[] = [];
  for (const r of o.rows as unknown[]) {
    if (!Array.isArray(r) || r.length < 8) throw new Error('BAD_RACKS row');
    const d = r[8];
    const dims = Array.isArray(d) && d.length === 3 && d.every((v) => typeof v === 'number' && Number.isFinite(v)) ? (d as [number, number, number]) : null;
    rows.push([String(r[0] ?? ''), String(r[1] ?? ''), Number(r[2]), String(r[3] ?? ''), num(r[4]), num(r[5]), String(r[6] ?? ''), String(r[7] ?? ''), dims]);
  }
  const sync: Record<string, StockSync> = {};
  if (o.sync && typeof o.sync === 'object') {
    for (const [k, v] of Object.entries(o.sync as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const s = v as Record<string, unknown>;
      sync[k] = {
        dt: typeof s.dt === 'string' ? s.dt : undefined,
        n: typeof s.n === 'number' ? s.n : null,
        at: typeof s.at === 'string' && !Number.isNaN(Date.parse(s.at)) ? s.at : null,
        base: s.base === true,
        wh: typeof s.wh === 'string' ? s.wh : undefined,
      };
    }
  }
  return { at: typeof o.at === 'string' && !Number.isNaN(Date.parse(o.at)) ? o.at : new Date().toISOString(), sync, rows };
}

export interface RackItem {
  /** 来源下标 3–6 和它的键（B3 / DECGN / HP / DZF） */
  si: number;
  sys: string;
  sku: string;
  /** 在库（含待出）、其中待出的 */
  q: number;
  o: number;
  /** 库存类型：'' = 良品，不良品 / 暂存 */
  t: string;
  /** 客户代码（几个用逗号隔开） */
  c: string;
  /** 这一行货的体积 m³；没有尺寸 = null */
  vol: number | null;
}

export interface RackSlot {
  /** 统一写法 B2-14-34-01 */
  loc: string;
  h: number;
  r: number;
  p: number;
  l: number;
  items: RackItem[];
  /** 有尺寸的货的体积合计 m³ */
  vol: number;
  /** 没有尺寸的行数 */
  unk: number;
  /** 件数 */
  q: number;
  info?: SlotInfo;
}

export interface SlotInfo {
  sis: Set<number>;
  cu: Set<string>;
  cuKey: string;
  /** 有待出 */
  out: boolean;
  /** 有不良品 / 暂存 */
  bad: boolean;
}

export interface RackModel {
  at: string;
  sync: Record<string, StockSync>;
  /** 有货的货架托位：统一库位码 → 托位 */
  slots: Map<string, RackSlot>;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const KEY_OF = new Map<number, string>(SOURCES.map((s) => [s.src, s.key]));

/**
 * 库位码 → 货架托位（厅、排、位、层）；不是货架托位返回 null。
 * 和 3D 页的 parseLoc 一样：12 位旧码、B02- 写法、后面多一段的小格（B3-12-18-01-A-1）都算在格子上；
 * 这一排要在库容表里是货架排（3 厅 10、11 排是地库排，不算），层 1–3，位 1–99。
 */
export function rackSlotOf(raw: string, disp = ''): { h: number; r: number; p: number; l: number; loc: string } | null {
  const c = String(raw || disp || '')
    .trim()
    .toUpperCase();
  let h = 0;
  let r = 0;
  let p = 0;
  let l = 0;
  let m = /^(\d{2})(\d{2})(\d{3})(\d)(\d{2})(\d{2})$/.exec(c);
  if (m) {
    h = +m[1];
    r = +m[3];
    p = +m[5];
    l = +m[6];
  } else if ((m = /^B0?(\d)-(\d{1,3})-(\d{1,3})-(\d{1,2})(?:-.+)?$/.exec(c))) {
    h = +m[1];
    r = +m[2];
    p = +m[3];
    l = +m[4];
  }
  if (!h) return null;
  const row = CAPACITY[String(h)]?.rows.find((x) => x.r === r);
  if (!row || !row.lv || l < 1 || l > 3 || p < 1 || p > 99) return null;
  return { h, r, p, l, loc: `B${h}-${pad2(r)}-${pad2(p)}-${pad2(l)}` };
}

/** 库存行 → 有货的货架托位（顺序、算术和 3D 页的 buildModel 一样） */
export function buildRack(snap: RackSnapshot): RackModel {
  const slots = new Map<string, RackSlot>();
  for (const x of snap.rows) {
    const si = x[2];
    if (!(si >= 3)) continue;
    const o = x[5];
    const q = Math.max(x[4], o);
    if (q <= 0) continue;
    const at = rackSlotOf(x[1] || x[0], x[0]);
    if (!at) continue;
    const d = x[8];
    const vol = d ? (q * d[0] * d[1] * d[2]) / 1e6 : null;
    let s = slots.get(at.loc);
    if (!s) {
      s = { loc: at.loc, h: at.h, r: at.r, p: at.p, l: at.l, items: [], vol: 0, unk: 0, q: 0 };
      slots.set(at.loc, s);
    }
    s.items.push({ si, sys: KEY_OF.get(si) ?? String(si), sku: x[3], q, o, t: x[6], c: x[7], vol });
    s.q += q;
    if (vol != null) s.vol += vol;
    else s.unk += 1;
  }
  for (const s of slots.values()) s.items.sort((a, b) => (b.vol || 0) - (a.vol || 0) || b.q - a.q);
  return { at: snap.at, sync: snap.sync, slots };
}

/** 一个有货托位：哪些系统、哪些客户、有没有待出 / 不良暂存（算一次存着） */
export function slotInfo(s: RackSlot): SlotInfo {
  if (s.info) return s.info;
  const sis = new Set<number>();
  const cu = new Set<string>();
  let out = false;
  let bad = false;
  for (const it of s.items) {
    sis.add(it.si);
    if (it.c) it.c.split(',').forEach((c) => cu.add(c));
    else cu.add('?');
    if (it.o > 0) out = true;
    if (it.t) bad = true;
  }
  return (s.info = { sis, cu, cuKey: [...cu].sort().join(','), out, bad });
}

const aisleNo = (s: { r: number }) => (s.r <= 1 ? 0 : Math.floor(s.r / 2)); // 通道：01 单独，02+03、04+05 …（只用来算远近）
type Pos = { h: number; r: number; p: number; l: number };
const dist = (a: Pos, b: Pos) => (a.h !== b.h ? 1000 + Math.abs(a.h - b.h) * 100 : Math.abs(aisleNo(a) - aisleNo(b)) * 10 + Math.abs(a.p - b.p) + Math.abs(a.l - b.l) * 0.5);
/** 目标离来源多远：同一条通道 / 同一个厅 / 别的厅 */
export type TidyWhere = 'aisle' | 'hall' | 'far';
const whereOf = (a: Pos, b: Pos): TidyWhere => (a.h !== b.h ? 'far' : aisleNo(a) === aisleNo(b) ? 'aisle' : 'hall');

/** 清单里没结束的移库任务：gone = 它们的来源（不再当目标），extra = 要并进各个目标的体积 */
export interface TidyContext {
  gone: Set<string>;
  extra: Map<string, number>;
}

export function tidyContext(model: RackModel, tasks: TidyTask[]): TidyContext {
  const gone = new Set<string>();
  const extra = new Map<string, number>();
  for (const t of tasks) {
    if (t.kind !== 'move' || !isOpen(t)) continue;
    const s = model.slots.get(t.src);
    if (!s) continue; // 系统里来源已经没货了（移库文件导进去、又同步过了）
    gone.add(s.loc);
    const to = targetOf(t);
    if (to) extra.set(to, (extra.get(to) || 0) + s.vol);
  }
  return { gone, extra };
}

export interface TidyTarget {
  loc: string;
  hall: number;
  level: number;
  /** 目标里已经有同一个 SKU */
  same: boolean;
  /** 目标并入前 / 并入后的占用（0–1） */
  before: number;
  after: number;
  d: number;
  where: TidyWhere;
}

/** s 整个库位能并到哪，好的在前（全部，不截断） */
export function targetsFor(model: RackModel, s: RackSlot, ctx: TidyContext): TidyTarget[] {
  const I = slotInfo(s);
  if (I.sis.size !== 1 || I.cu.size !== 1 || I.cu.has('?')) return [];
  const si = s.items[0].si;
  const skus = new Set(s.items.map((i) => i.sku));
  const v = s.vol / PALLET_M3;
  const out: TidyTarget[] = [];
  for (const t of model.slots.values()) {
    if (t === s || t.unk || t.l > s.l || ctx.gone.has(t.loc)) continue;
    const J = slotInfo(t);
    if (!J.sis.has(si) || J.cuKey !== I.cuKey) continue;
    const before = (t.vol + (ctx.extra.get(t.loc) || 0)) / PALLET_M3;
    const after = before + v;
    if (after > TIDY_LIMIT) continue;
    out.push({ loc: t.loc, hall: t.h, level: t.l, same: t.items.some((i) => i.si === si && skus.has(i.sku)), before, after, d: dist(s, t), where: whereOf(s, t) });
  }
  return out.sort((a, b) => Number(b.same) - Number(a.same) || Number(b.level === 1) - Number(a.level === 1) || a.d - b.d || (a.loc < b.loc ? -1 : 1));
}

/**
 * 为什么不给建议：
 *   empty 系统里这个库位是空的 · dst 别的任务要并到这里 · unk 有的货没有尺寸（算不了占用）· out 有待出 ·
 *   bad 有不良品 / 暂存 · multi 几个系统或几个客户 · none 没有合适的目标
 */
export type TidyWhy = 'empty' | 'dst' | 'unk' | 'out' | 'bad' | 'multi' | 'none';

export interface TidySuggestion {
  /** 系统里这个库位的货；空库位 = null */
  slot: RackSlot | null;
  /** 占用（0–1）；有的货没有尺寸 = null */
  fill: number | null;
  why: TidyWhy | null;
  /** 最多 TIDY_MAX_TARGETS 个 */
  targets: TidyTarget[];
  /** 一共有几个能并的目标 */
  total: number;
  /** 能不能自己另选目标（有待出、不良 / 暂存、几个客户或系统的不能搬） */
  canPick: boolean;
}

/** 扫到 loc：系统里有什么、能并到哪 */
export function suggestFor(model: RackModel, loc: string, tasks: TidyTask[]): TidySuggestion {
  const s = model.slots.get(loc) ?? null;
  if (!s) return { slot: null, fill: null, why: 'empty', targets: [], total: 0, canPick: false };
  const ctx = tidyContext(model, tasks);
  const I = slotInfo(s);
  const fill = s.unk ? null : s.vol / PALLET_M3;
  const none = (why: TidyWhy, canPick: boolean): TidySuggestion => ({ slot: s, fill, why, targets: [], total: 0, canPick });
  if (ctx.extra.has(s.loc)) return none('dst', false);
  if (I.out) return none('out', false);
  if (I.bad) return none('bad', false);
  if (I.sis.size > 1 || I.cu.size > 1) return none('multi', false);
  if (s.unk) return none('unk', true);
  const ts = targetsFor(model, s, ctx);
  if (!ts.length) return none('none', true);
  return { slot: s, fill, why: null, targets: ts.slice(0, TIDY_MAX_TARGETS), total: ts.length, canPick: true };
}

/**
 * 自己选的目标行不行：
 *   不行（block）：notSlot 不是货架库位 · self 就是来源 · src 是别的任务要搬走的库位 · cust 那里有别的客户的货
 *   可以但要提醒（warn）：empty 系统里那里是空的 · sys 那里没有这个系统的货 · unk 那里有的货没有尺寸 ·
 *                        up 比来源的层高 · full 并入后超过 80% 托
 */
export type TargetIssue = 'notSlot' | 'self' | 'src' | 'cust' | 'empty' | 'sys' | 'unk' | 'up' | 'full';

export interface TargetCheck {
  loc: string;
  block: TargetIssue | null;
  warn: TargetIssue[];
  same: boolean;
  /** 目标并入前 / 并入后的占用；算不了 = null */
  before: number | null;
  after: number | null;
  where: TidyWhere;
  hall: number;
  level: number;
}

export function checkTarget(model: RackModel, s: RackSlot, dst: string, tasks: TidyTask[]): TargetCheck {
  const at = isSlot(dst) ? rackSlotOf(dst) : null;
  const res: TargetCheck = { loc: dst, block: null, warn: [], same: false, before: null, after: null, where: 'far', hall: at?.h ?? 0, level: at?.l ?? 0 };
  if (!at) return { ...res, block: 'notSlot' };
  res.where = whereOf(s, at);
  if (at.loc === s.loc) return { ...res, block: 'self' };
  if (tasks.some((t) => isOpen(t) && t.kind === 'move' && t.src === at.loc)) return { ...res, block: 'src' };
  const I = slotInfo(s);
  const si = s.items[0].si;
  const t = model.slots.get(at.loc) ?? null;
  if (t && slotInfo(t).cuKey !== I.cuKey) return { ...res, block: 'cust' };
  const ctx = tidyContext(model, tasks);
  const extra = (ctx.extra.get(at.loc) || 0) / PALLET_M3;
  if (!t) res.warn.push('empty');
  else {
    if (!slotInfo(t).sis.has(si)) res.warn.push('sys');
    if (t.unk) res.warn.push('unk');
    const skus = new Set(s.items.map((i) => i.sku));
    res.same = t.items.some((i) => i.si === si && skus.has(i.sku));
  }
  if (at.l > s.l) res.warn.push('up');
  if (!s.unk && !(t && t.unk)) {
    res.before = (t ? t.vol / PALLET_M3 : 0) + extra;
    res.after = res.before + s.vol / PALLET_M3;
    if (res.after > TIDY_LIMIT) res.warn.push('full');
  }
  return res;
}

/** 来源 + 选定的目标 → 整理任务（和 3D 页「加入整理」发来的一样；同一个 SKU 有几行的合成一行） */
export function moveDraft(s: RackSlot, to: { loc: string; same: boolean; before: number | null; after: number | null }): TidyDraft {
  const r4 = (v: number | null) => (v == null ? null : +v.toFixed(4));
  const lines: [string, number][] = [];
  for (const i of s.items) {
    const l = lines.find((x) => x[0] === i.sku);
    if (l) l[1] += i.q;
    else lines.push([i.sku, i.q]);
  }
  return {
    id: newTidyId(),
    kind: 'move',
    src: s.loc,
    dst: to.loc,
    sys: s.items[0].sys,
    cust: slotInfo(s).cuKey,
    fill: s.unk ? null : +(s.vol / PALLET_M3).toFixed(4),
    before: r4(to.before),
    after: r4(to.after),
    same: !!to.same,
    lines,
    note: '',
  };
}
