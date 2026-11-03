// 「盘点 → 从库存数据新建」：把「SKU 库位查询」同步好的库存（/api/stock?hall=N）和库容表合成一张盘点表，
// 结果和导入 Claude 做的《X厅_库位空位盘点表.xlsx》一样（同一套 StocktakeImportRow），规则也和
// Claude 的生成脚本 make_count_sheet.py v4 一致：
//   - 库位：库容表里的每个托位（每排每层从起始位号数起）+ 系统里有货的货架库位 B{厅}-排-位-层。
//     库容表里没有的号算「库容表外」（extra，现场没有这个位就勾「异」）。不是货架格的码（B1-1XN 这类）不进表，只计数。
//     12 位旧码（SKU 工具已经解码成统一写法，原码另给）、B04- / 没补零的写法、小格（…-A-1，和 3D 页一样算在格子上）
//     都并到统一库位上，原来的码放进 codes，照样能扫。
//   - 同一库位同一系统同一 SKU 合成一行：在库 = 全部批次（E14，含不良 / 暂存，另打标签「含不良 N」），
//     待出 = 已分配给订单、还没签出的（out_quantity）。应有：下限 = 在库 − 待出，上限 = 在库。空库位一行，SKU 空着。
//   - 通道：01 排单独一条，之后 02+03、04+05……；3 厅 10、11 排（地库排）各自一条，12+13 … 18+19，20 排单独一条。00 排单独一条。
//   - 走行顺序：通道 → 位号 → 排 → 层；同一库位里按系统（盘古、DECGN、海派、DZF）再按 SKU。
import { CAPACITY } from './capacity';
import type { StocktakeImportRow } from './types';
import type { ParsedSheet } from './stocktakeXlsx';

/** /api/stock 的一行：[显示库位, 原码, 来源下标, SKU, 在库, 待出, 库存类型（'' = 良品）, 客户代码] */
export type StockApiRow = [string, string, number, string, number, number, string, string];

/** 一个系统最近一次同步（sku-kuwei-data 的 latest.sync） */
export interface StockSync {
  dt?: string; // 'MM-DD HH:mm'：点书签那台电脑的时间
  n?: number | null;
  at?: string | null; // 服务器收到的时间（ISO）；还没同步过、用 09-30 基线的 = null
  base?: boolean;
  host?: string;
  wh?: string;
}

export interface StockSnapshot {
  hall: string;
  at: string; // 取数据的时间
  sync: Record<string, StockSync>;
  rows: StockApiRow[];
}

/** SKU 库位查询里的系统来源 */
export const SOURCES = [
  { src: 3, key: 'B3', wms: '盘古', wh: 'B3' },
  { src: 4, key: 'DECGN', wms: 'DECGN', wh: 'DECGN' },
  { src: 5, key: 'HP', wms: '海派', wh: 'DE01' },
  { src: 6, key: 'DZF', wms: 'DZF', wh: 'DZFDA' },
] as const;
export type SourceKey = (typeof SOURCES)[number]['key'];
const BY_SRC = new Map<number, (typeof SOURCES)[number]>(SOURCES.map((s) => [s.src, s]));

/** 同步时间超过这么多小时就提醒（和导入表时的「导出太久」一样） */
export const STALE_HOURS = 12;

/** 服务器回来的 JSON → StockSnapshot（形状不对就抛错，不让坏数据进表） */
export function parseSnapshot(j: unknown, hall: string): StockSnapshot {
  const o = j as { hall?: unknown; at?: unknown; sync?: unknown; rows?: unknown };
  if (!o || typeof o !== 'object' || !Array.isArray(o.rows)) throw new Error('BAD_SNAPSHOT');
  if (String(o.hall) !== hall) throw new Error('BAD_SNAPSHOT hall');
  const rows: StockApiRow[] = [];
  for (const r of o.rows as unknown[]) {
    if (!Array.isArray(r) || r.length < 6) throw new Error('BAD_SNAPSHOT row');
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
    rows.push([String(r[0] ?? ''), String(r[1] ?? ''), Number(r[2]), String(r[3] ?? ''), num(r[4]), num(r[5]), String(r[6] ?? ''), String(r[7] ?? '')]);
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
        host: typeof s.host === 'string' ? s.host : undefined,
        wh: typeof s.wh === 'string' ? s.wh : undefined,
      };
    }
  }
  return { hall, at: typeof o.at === 'string' ? o.at : new Date().toISOString(), sync, rows };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 排 → 通道键（见文件开头的规则） */
export function aisleOf(hall: string, r: number): string {
  if (r <= 1) return pad2(r);
  if (hall === '3' && !((r >= 2 && r <= 9) || (r >= 12 && r <= 19))) return pad2(r);
  const a = r - (r % 2);
  return `${pad2(a)}-${pad2(a + 1)}`;
}

/** 通道排序用：通道里的第一排 */
const aisleRank = (a: string) => Number(a.split('-')[0]);

/**
 * 货架库位码 → 厅 / 排 / 位 / 层 和统一写法 B{厅}-RR-PP-LL；不是货架码返回 null。
 * 和 3D 仓库页一样：后面多一段的（B3-12-18-01-A-1 这类格子里的小格）算在那个格子上。
 */
export function parseShelf(code: string): { hall: string; r: number; p: number; l: number; loc: string } | null {
  const m = code.trim().toUpperCase().match(/^B0?(\d)-(\d{1,3})-(\d{1,3})-(\d{1,3})(?:-.+)?$/);
  if (!m) return null;
  const [r, p, l] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return { hall: m[1], r, p, l, loc: `B${m[1]}-${pad2(r)}-${pad2(p)}-${pad2(l)}` };
}

/** 库容表里这个厅的全部托位（统一写法） */
export function capacitySlots(hall: string): Set<string> {
  const out = new Set<string>();
  for (const row of CAPACITY[hall]?.rows ?? []) {
    if (!row.lv) continue; // 地库排没有货架格
    const s0 = row.s ?? 1;
    row.lv.forEach((n, i) => {
      for (let p = s0; p < s0 + n; p++) out.add(`B${hall}-${pad2(row.r)}-${pad2(p)}-${pad2(i + 1)}`);
    });
  }
  return out;
}

const TYPE_SHORT: Record<string, string> = { 不良品: '不良', 暂存: '暂存' };
const typeShort = (t: string) => TYPE_SHORT[t] ?? t;

interface Agg {
  src: number;
  sku: string;
  onhand: number;
  out: number;
  types: Map<string, number>; // 库存类型 → 在库
  cust: Set<string>;
  raws: Set<string>; // 系统里的原码
}

interface LocInfo {
  loc: string;
  r: number;
  p: number;
  l: number;
  aisle: string;
  extra: boolean;
  codes: Set<string>; // 系统里的各种写法（显示库位 / 原码）
  aggs: Map<string, Agg>;
}

export interface SystemInfo {
  key: SourceKey;
  wms: string;
  wh: string;
  /** 这个厅里这个系统有货的库位数 / 行数（整个厅，不管选了哪些通道） */
  locations: number;
  rows: number;
  sync: StockSync | null;
  /** 同步了多少小时（没同步过 = null） */
  ageH: number | null;
  stale: boolean;
}

export interface AisleInfo {
  aisle: string;
  locations: number;
  empty: number;
}

export interface BuildResult {
  sheet: ParsedSheet;
  /** 整个厅的通道（选不选都列出来） */
  aisles: AisleInfo[];
  systems: SystemInfo[];
  /** 选中的通道里：空库位、有货库位、库容表外的库位 */
  empty: number;
  stocked: number;
  extra: number;
  /** 不是货架格的码（没放进表）：个数和前几个 */
  skipped: { count: number; examples: string[] };
}

export interface BuildOptions {
  /** 只要这几条通道；不给 = 全部 */
  aisles?: string[] | null;
  title?: string;
  now?: Date;
}

/** 库存数据 + 库容表 → 盘点表 */
export function buildFromStock(snap: StockSnapshot, opts: BuildOptions = {}): BuildResult {
  const hall = snap.hall;
  const now = (opts.now ?? new Date()).getTime();
  const cap = capacitySlots(hall);
  const locs = new Map<string, LocInfo>();
  const skipped = new Set<string>();
  const sysLocs = new Map<number, Set<string>>();
  const sysRows = new Map<number, Set<string>>();

  const locOf = (loc: string, r: number, p: number, l: number): LocInfo => {
    let x = locs.get(loc);
    if (!x) {
      x = { loc, r, p, l, aisle: aisleOf(hall, r), extra: !cap.has(loc), codes: new Set(), aggs: new Map() };
      locs.set(loc, x);
    }
    return x;
  };
  for (const loc of cap) {
    const s = parseShelf(loc)!;
    locOf(loc, s.r, s.p, s.l);
  }

  for (const [disp, raw, src, sku, onhand, out, type, cust] of snap.rows) {
    const S = BY_SRC.get(src);
    if (!S || !sku.trim() || !(onhand > 0 || out > 0)) continue; // 0 件的批次记录不算有货
    const s = parseShelf(disp);
    if (!s || s.hall !== hall) {
      if (disp.trim()) skipped.add(disp.trim().toUpperCase());
      continue;
    }
    const x = locOf(s.loc, s.r, s.p, s.l);
    for (const c of [disp.trim().toUpperCase(), raw.trim().toUpperCase()]) if (c && c !== s.loc) x.codes.add(c);
    const k = `${src}\u0001${sku}`;
    let a = x.aggs.get(k);
    if (!a) {
      a = { src, sku, onhand: 0, out: 0, types: new Map(), cust: new Set(), raws: new Set() };
      x.aggs.set(k, a);
    }
    const q = Math.max(0, Math.round(onhand)); // 数据库里是整数列
    a.onhand += q;
    a.out += Math.max(0, Math.round(out));
    a.types.set(type, (a.types.get(type) ?? 0) + q);
    for (const c of cust.split(',')) if (c.trim()) a.cust.add(c.trim());
    a.raws.add(raw.trim() || disp.trim()); // 这条库存在系统里记在哪个码上（原码；没有原码就是显示的那个）
    if (!sysLocs.has(src)) sysLocs.set(src, new Set());
    sysLocs.get(src)!.add(s.loc);
    if (!sysRows.has(src)) sysRows.set(src, new Set());
    sysRows.get(src)!.add(`${s.loc}\u0001${sku}`);
  }

  // 走行顺序
  const ordered = [...locs.values()].sort(
    (a, b) => aisleRank(a.aisle) - aisleRank(b.aisle) || a.p - b.p || a.r - b.r || a.l - b.l,
  );
  const aisleMap = new Map<string, AisleInfo>();
  for (const x of ordered) {
    let ai = aisleMap.get(x.aisle);
    if (!ai) aisleMap.set(x.aisle, (ai = { aisle: x.aisle, locations: 0, empty: 0 }));
    ai.locations += 1;
    if (!x.aggs.size) ai.empty += 1;
  }
  const want = opts.aisles ? new Set(opts.aisles) : null;

  const rows: StocktakeImportRow[] = [];
  let empty = 0;
  let stocked = 0;
  let extra = 0;
  for (const x of ordered) {
    if (want && !want.has(x.aisle)) continue;
    const codes = [x.loc, ...[...x.codes].sort()];
    const aggs = [...x.aggs.values()].sort((a, b) => a.src - b.src || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
    const locIn = [...new Set(aggs.map((a) => BY_SRC.get(a.src)!.wms))].join(',');
    if (x.extra) extra += 1;
    const base = { aisle: x.aisle, pos: x.p, loc: x.loc, codes, extra: x.extra };
    if (!aggs.length) {
      empty += 1;
      rows.push({
        ...base,
        seq: rows.length + 1,
        serial: `${hall}-${String(rows.length + 1).padStart(3, '0')}`,
        is_first: true,
        sku: '',
        wms: '',
        customer: '',
        lo: 0,
        hi: 0,
        tag: '',
        info: { orig: '', wh: '', loc_in: '', out: 0, stype: '', tier: x.l, from: 'stock' },
      });
      continue;
    }
    stocked += 1;
    aggs.forEach((a, i) => {
      const S = BY_SRC.get(a.src)!;
      const good = a.types.get('') ?? 0;
      const others = [...a.types.entries()].filter(([t, q]) => t !== '' && q > 0).sort(([t1], [t2]) => (t1 < t2 ? -1 : 1));
      const tag = others.map(([t, q]) => `含${typeShort(t)} ${q}`).join(' · ');
      const stype = others.length ? [good > 0 ? `良品 ${good}` : '', ...others.map(([t, q]) => `${typeShort(t)} ${q}`)].filter(Boolean).join(' / ') : '良品';
      rows.push({
        ...base,
        seq: rows.length + 1,
        serial: `${hall}-${String(rows.length + 1).padStart(3, '0')}`,
        is_first: i === 0,
        sku: a.sku,
        wms: S.wms,
        customer: [...a.cust].sort().join(','),
        // 待出本来不会比在库多；万一数据对不上（在库 0、待出 N），按 0~N 印，不把这个位当空的
        lo: Math.max(a.onhand - a.out, 0),
        hi: Math.max(a.onhand, a.out),
        tag,
        info: { orig: [...a.raws].sort().join(' / '), wh: S.wh, loc_in: locIn, out: a.out, stype, tier: x.l, from: 'stock' },
      });
    });
  }

  const systems: SystemInfo[] = SOURCES.map((S) => {
    const sync = snap.sync[S.key] ?? null;
    const at = sync?.at ? Date.parse(sync.at) : NaN;
    const ageH = Number.isNaN(at) ? null : Math.max(0, (now - at) / 3600000);
    const nLocs = sysLocs.get(S.src)?.size ?? 0;
    return {
      key: S.key,
      wms: S.wms,
      wh: S.wh,
      locations: nLocs,
      rows: sysRows.get(S.src)?.size ?? 0,
      sync,
      ageH,
      stale: nLocs > 0 && (ageH === null || ageH > STALE_HOURS),
    };
  });
  // 导出时间 = 这个厅有货的几个系统里最早的那次同步（之后的出入库表上都没有）
  const times = systems.filter((s) => s.locations > 0 && s.sync?.at).map((s) => Date.parse(s.sync!.at!));
  const exported = times.length ? new Date(Math.min(...times)).toISOString() : null;

  const aisles = [...aisleMap.values()];
  const picked = want ? aisles.filter((a) => want.has(a.aisle)) : aisles;
  return {
    sheet: {
      hall,
      title: opts.title ?? `${hall}厅 库位空位盘点`,
      exported_at: exported,
      rows,
      locations: empty + stocked,
      aisles: picked.length,
    },
    aisles,
    systems,
    empty,
    stocked,
    extra,
    skipped: { count: skipped.size, examples: [...skipped].sort().slice(0, 5) },
  };
}
