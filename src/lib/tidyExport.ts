// 「整理 → 生成移库文件」：已搬的任务 + 各系统的批次库存 → 每个系统一份 WMS「批次库存 › 批量移库位」导入文件（.xls）。
//
// 批次库存来自「SKU 库位查询」的 /api/stock?hall=N&batch=1（「同步库存」书签推上去的原始批次行，一条批次一行）。
// 规则（和手工做移库文件时一样）：
//   - 一条批次一行：仓库代码 / 入库单号 / 上架时间 / 产品代码 / 原库位 / 新库位 / 调整数量 / 备注 / 新托盘号（留空）。
//   - 库位写系统里的原码（12 位数字码、B04- 这类写法原样）；目标库位的原码取那个库位在同一个系统里现有批次的写法，
//     查不到（目标在这个系统里没有货）就照来源的写法推一个，并提醒导入前核对。
//   - 调整数量 = 在库 − 待出（被订单占用的不能移，硬导会报「调整数量大于可售数量」）；全被占用的行不进文件。
//   - 入库单号和上架时间要么都填、要么都空：同一个库位同一个 SKU 只有一条批次时可以都空；
//     有几条批次又没有批次信息（那个系统还没用新书签同步过）→ 这条任务先不出，提示去同步。
//   - 系统里来源库位已经没有这个系统的货 → 不出（可能已经移过了）。
//   - 不良品 / 暂存的批次不进文件（模板里没有库存类型这一列，和良品同批次时分不开），列出来手工处理。
import { biff8Xls, type XlsCell } from './biffXls';
import { SOURCES, STALE_HOURS, parseShelf, type SourceKey } from './stocktakeBuild';
import { targetOf } from './tidy';
import type { TidyTask } from './types';

/** /api/stock?batch=1 的一行：[显示库位, 系统里的库位号, 来源下标, SKU, 在库, 待出, 库存类型（'' = 良品）, 客户代码, 入库单号, 上架时间] */
export type BatchRow = [string, string, number, string, number, number, string, string, string, string];

export interface BatchSrc {
  /** 'MM-DD HH:mm'：点书签那台电脑的时间 */
  dt: string;
  /** 服务器收到的时间（ISO） */
  at: string | null;
  n: number | null;
  /** WMS 里的仓库代码（移库文件第 1 列） */
  wh: string;
  /** false = 这个系统还没用带批次的书签同步过：入库单号 / 上架时间是空的 */
  batch: boolean;
}

export interface BatchSnapshot {
  hall: string;
  at: string;
  src: Record<string, BatchSrc>;
  rows: BatchRow[];
}

/** 服务器回来的 JSON → BatchSnapshot（形状不对就抛错） */
export function parseBatchSnapshot(j: unknown, hall: string): BatchSnapshot {
  const o = j as { hall?: unknown; at?: unknown; src?: unknown; rows?: unknown };
  if (!o || typeof o !== 'object' || !Array.isArray(o.rows)) throw new Error('BAD_BATCH');
  if (String(o.hall) !== hall) throw new Error('BAD_BATCH hall');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
  const str = (v: unknown) => (v == null ? '' : String(v).trim());
  const rows: BatchRow[] = [];
  for (const r of o.rows as unknown[]) {
    if (!Array.isArray(r) || r.length < 8) throw new Error('BAD_BATCH row');
    rows.push([str(r[0]), str(r[1]), Number(r[2]), str(r[3]), num(r[4]), num(r[5]), str(r[6]), str(r[7]), str(r[8]), str(r[9])]);
  }
  const src: Record<string, BatchSrc> = {};
  if (o.src && typeof o.src === 'object') {
    for (const [k, v] of Object.entries(o.src as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const s = v as Record<string, unknown>;
      src[k] = {
        dt: typeof s.dt === 'string' ? s.dt : '',
        at: typeof s.at === 'string' && !Number.isNaN(Date.parse(s.at)) ? s.at : null,
        n: typeof s.n === 'number' ? s.n : null,
        wh: typeof s.wh === 'string' ? s.wh : '',
        batch: s.batch === true,
      };
    }
  }
  return { hall, at: typeof o.at === 'string' ? o.at : new Date().toISOString(), src, rows };
}

export const MOVE_HEADER = [
  '仓库代码/Warehouse Code',
  '入库单号/Inbound Order No',
  '上架时间/Putaway',
  '产品代码/Product Barcode',
  '原库位/Original Location Code',
  '新库位/New Location Code',
  '调整数量/Adjustment Quantity',
  '备注/Note',
  '新托盘号/New pallet number',
];
const MOVE_WIDTHS = [10, 24, 20, 34, 16, 16, 10, 24, 12];
export const MOVE_NOTE = '库位整理';

/** 文件里的一行 */
export interface MoveRow {
  wh: string;
  inb: string;
  put: string;
  sku: string;
  from: string;
  to: string;
  qty: number;
  taskId: string;
}

/**
 * 一条任务出文件时发现的情况。
 *   noStock      系统里来源库位已经没有这个系统的货（整条不出）
 *   needSync     有几条批次、又没有批次信息（整条不出，先同步）
 *   noSystem     任务上没写是哪个系统的货（整条不出）
 *   reserved     有的批次全被订单占用，没进文件（n = 件数）
 *   partReserved 有的批次一部分被占用，只移了能移的（n = 留下的件数）
 *   guessTarget  目标库位在这个系统里没有货，库位号是照来源的写法推的
 *   changed      系统里的件数和加入时不一样（n = 现在的在库件数，was = 加入时）
 *   mergedBatch  几条批次没有批次信息，合成了一行（入库单号 / 上架时间留空）
 *   otherType    有不良品 / 暂存的批次，没进文件（n = 件数）
 */
export type MoveIssueCode = 'noStock' | 'needSync' | 'noSystem' | 'reserved' | 'partReserved' | 'guessTarget' | 'changed' | 'mergedBatch' | 'otherType';
export interface MoveIssue {
  task: TidyTask;
  code: MoveIssueCode;
  /** true = 这条任务整条没进文件 */
  skip: boolean;
  n?: number;
  was?: number;
  to?: string;
}

export interface SystemFile {
  key: SourceKey;
  wms: string;
  wh: string;
  /** 这个系统最近一次同步：'MM-DD HH:mm' 和服务器时间 */
  syncDt: string;
  syncAt: string | null;
  /** 同步时间超过 STALE_HOURS 小时 */
  stale: boolean;
  batch: boolean;
  rows: MoveRow[];
  /** 至少有一行进了文件的任务 */
  tasks: TidyTask[];
  qty: number;
}

export interface MovePlan {
  files: SystemFile[];
  issues: MoveIssue[];
  /** 整条没进文件的任务 */
  skipped: TidyTask[];
}

const BY_KEY = new Map<string, (typeof SOURCES)[number]>(SOURCES.map((s) => [s.key, s]));
const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** 批次行的库位落在哪个货架格（统一写法；小格 B3-12-18-01-A-1 算在格子上；12 位旧码显示库位已经解过） */
function slotOf(r: BatchRow): string | null {
  return parseShelf(r[0])?.loc ?? parseShelf(r[1])?.loc ?? null;
}

/** 照来源库位在系统里的写法，写出目标库位（目标在这个系统里没有货、查不到原码时用） */
export function guessRaw(srcRaw: string, src: string, dst: string): string {
  const d = parseShelf(dst);
  if (!d) return dst;
  const b = srcRaw.trim().toUpperCase().match(/^B(0?)\d-(\d+)-(\d+)-(\d+)$/);
  if (b) return `B${b[1]}${d.hall}-${pad(d.r, b[2].length)}-${pad(d.p, b[3].length)}-${pad(d.l, b[4].length)}`;
  // 12 位码：厅2 区2 排3 0 位2 层2。区照来源的写（同一个厅才靠得住）
  const n = srcRaw.trim().match(/^(\d{2})(\d{2})(\d{3})0(\d{2})(\d{2})$/);
  if (n && parseShelf(src)?.hall === d.hall) return `${pad(Number(d.hall), 2)}${n[2]}${pad(d.r, 3)}0${pad(d.p, 2)}${pad(d.l, 2)}`;
  return dst;
}

/**
 * 已搬的移库任务 + 各厅的批次库存 → 每个系统一份文件的内容。
 * snaps 要包含每条任务来源所在的厅；目标在别的厅时，有那个厅的数据就能查到目标的原码，没有就照来源的写法推。
 */
export function planMoves(tasks: TidyTask[], snaps: BatchSnapshot[], now = Date.now()): MovePlan {
  const byHall = new Map(snaps.map((s) => [s.hall, s]));
  // 厅 → 货架格 → 这个格子里的批次行
  const index = new Map<string, Map<string, BatchRow[]>>();
  for (const s of snaps) {
    const m = new Map<string, BatchRow[]>();
    for (const r of s.rows) {
      const loc = slotOf(r);
      if (!loc) continue;
      const list = m.get(loc);
      if (list) list.push(r);
      else m.set(loc, [r]);
    }
    index.set(s.hall, m);
  }
  const files = new Map<SourceKey, SystemFile>();
  const issues: MoveIssue[] = [];
  const skipped: TidyTask[] = [];
  const skip = (task: TidyTask, code: MoveIssueCode) => {
    issues.push({ task, code, skip: true });
    skipped.push(task);
  };

  for (const task of tasks) {
    if (task.kind !== 'move' || task.status !== 'moved') continue;
    const sys = BY_KEY.get(task.sys);
    const snap = byHall.get(task.hall);
    if (!sys || !snap) {
      skip(task, 'noSystem');
      continue;
    }
    const to = targetOf(task);
    const here = (index.get(task.hall)?.get(task.src) ?? []).filter((r) => r[2] === sys.src && r[4] > 0);
    if (!here.length) {
      skip(task, 'noStock');
      continue;
    }
    // 目标库位在这个系统里的写法
    const toHall = parseShelf(to)?.hall ?? '';
    const there = (index.get(toHall)?.get(to) ?? []).filter((r) => r[2] === sys.src);
    // 不要小格的码（B3-12-18-01-A-1 这类）：移到格子本身
    const exact = there.find((r) => !/^B0?\d-\d+-\d+-\d+-./i.test(r[1] || r[0]));
    let toRaw = exact ? exact[1] || exact[0] : '';
    let guessed = false;
    if (!toRaw) {
      toRaw = guessRaw(here[0][1] || here[0][0], task.src, to);
      guessed = true;
    }

    // 同一个原码 + SKU 的批次放一起；不良品 / 暂存的不进文件
    const groups = new Map<string, BatchRow[]>();
    const other = here.filter((r) => r[6]).reduce((a, r) => a + r[4], 0);
    for (const r of here) {
      if (r[6]) continue;
      const k = `${r[1] || r[0]}\u0000${r[3]}`;
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }
    const rows: MoveRow[] = [];
    let needSync = false;
    let reserved = 0;
    let part = 0;
    let merged = false;
    const info = snap.src[sys.key];
    const wh = info?.wh || sys.wh;
    for (const g of groups.values()) {
      const from = g[0][1] || g[0][0];
      const sku = g[0][3];
      const withBatch = g.every((r) => r[8] && r[9]);
      if (!withBatch && g.length > 1 && !info?.batch) {
        needSync = true;
        break;
      }
      // 有批次信息：同一批次（入库单号 + 上架时间）可能有几条记录，合成一行；没有：整组一行、两项留空
      const byBatch = new Map<string, { inb: string; put: string; on: number; out: number }>();
      for (const r of g) {
        const k = withBatch ? `${r[8]}\u0000${r[9]}` : '';
        const b = byBatch.get(k) ?? { inb: withBatch ? r[8] : '', put: withBatch ? r[9] : '', on: 0, out: 0 };
        b.on += r[4];
        b.out += r[5];
        byBatch.set(k, b);
      }
      if (!withBatch && g.length > 1) merged = true;
      for (const b of [...byBatch.values()].sort((x, y) => x.put.localeCompare(y.put) || x.inb.localeCompare(y.inb))) {
        const qty = b.on - b.out;
        if (qty <= 0) {
          reserved += b.on;
          continue;
        }
        if (b.out > 0) part += b.out;
        rows.push({ wh, inb: b.inb, put: b.put, sku, from, to: toRaw, qty, taskId: task.id });
      }
    }
    if (needSync) {
      skip(task, 'needSync');
      continue;
    }
    if (reserved) issues.push({ task, code: 'reserved', skip: !rows.length, n: reserved });
    if (other) issues.push({ task, code: 'otherType', skip: !rows.length, n: other });
    if (!rows.length) {
      skipped.push(task);
      continue;
    }
    if (part) issues.push({ task, code: 'partReserved', skip: false, n: part });
    if (guessed) issues.push({ task, code: 'guessTarget', skip: false, to: toRaw });
    if (merged) issues.push({ task, code: 'mergedBatch', skip: false });
    const onHand = here.reduce((a, r) => a + r[4], 0);
    const was = task.lines.reduce((a, l) => a + (Number(l[1]) || 0), 0);
    if (task.lines.length && onHand !== was) issues.push({ task, code: 'changed', skip: false, n: onHand, was });

    let f = files.get(sys.key);
    if (!f) {
      const at = info?.at ?? null;
      f = {
        key: sys.key,
        wms: sys.wms,
        wh,
        syncDt: info?.dt ?? '',
        syncAt: at,
        stale: !at || now - Date.parse(at) > STALE_HOURS * 3600000,
        batch: !!info?.batch,
        rows: [],
        tasks: [],
        qty: 0,
      };
      files.set(sys.key, f);
    }
    f.rows.push(...rows);
    f.tasks.push(task);
    f.qty += rows.reduce((a, r) => a + r.qty, 0);
  }
  const order = SOURCES.map((s) => s.key as SourceKey);
  return { files: [...files.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)), issues, skipped };
}

/** 一个系统的文件内容（表头 + 行） */
export function moveAoa(f: SystemFile): XlsCell[][] {
  return [MOVE_HEADER, ...f.rows.map((r) => [r.wh, r.inb, r.put, r.sku, r.from, r.to, r.qty, MOVE_NOTE, ''])];
}

/** 一个系统的 .xls 文件 */
export function moveXls(f: SystemFile): Blob {
  const bytes = biff8Xls(moveAoa(f), MOVE_WIDTHS, 'Sheet1');
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/vnd.ms-excel' });
}

/** 文件名里的时间：本地时间 20261124-1630 */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
