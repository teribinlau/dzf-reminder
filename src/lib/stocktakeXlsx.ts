// 盘点表 .xlsx 的读和写（只在导入 / 导出时动态加载，jszip 已经是依赖，不另加解析库）。
//
// 读：Claude 出的《X厅_库位空位盘点表.xlsx》里有一个隐藏的「_app」页（format = dzf-stocktake-v1、厅、导出时间、标题）
//     和「WMS原始数据」页（每行一个序号，列名固定，见 RAW 里的名字）。只认这两页，打印用的「盘点表」页不读。
// 写：导出现场结果，文字用 inlineStr，Excel / WPS / LibreOffice 都能打开。四页：
//   「X厅盘点结果」每行一个序号（和以前一样，最后多一列「备用（挪）」）
//   「汇总」每条通道的 空 / 可用空位 / 半 / 满 / 无 / 异 / 挪 / 差异
//   「差异明细」要核实的：系统有货现场空的货（去哪了）、系统有货现场无位置（移库时核对）……后几列留给核实的人填
//   「可用库位」移库用：空 → 半（同 SKU 优先合并）→ 挪（需整理后才能使用）→ 有差异的（核实后才能用）；无 / 异不列
import JSZip from 'jszip';
import type { StockStatus, StocktakeImportRow, StocktakePhoto, StocktakeRow, Stocktake } from './types';
import {
  aisleLabel,
  groupLocations,
  isDiff,
  isMoveNote,
  needsProduct,
  productsOf,
  qtyOff,
  qtyText,
  statsByAisle,
  STATUSES,
  verdictOf,
  VERDICTS,
  type LocGroup,
  type Stats,
  type Verdict,
} from './stocktake';

export const SHEET_FORMAT = 'dzf-stocktake-v1';

export interface ParsedSheet {
  hall: string;
  title: string;
  exported_at: string | null;
  rows: StocktakeImportRow[];
  locations: number;
  aisles: number;
}

/** 导入失败的原因（界面上按 code 显示中文 / 德语） */
export class SheetError extends Error {
  constructor(
    public code: 'notXlsx' | 'noAppSheet' | 'badFormat' | 'noRawSheet' | 'missingColumn' | 'badRow' | 'empty',
    public detail = '',
  ) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
  }
}

type Cell = string | number | null;

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'application/xml');
}

/** 'BC' → 54（从 0 开始） */
function colIndex(ref: string): number {
  const letters = ref.replace(/[0-9]/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function textOf(el: Element): string {
  // <si> / <is> 里可能是一个 <t>，也可能是好几段 <r><t>…</t></r>
  return Array.from(el.getElementsByTagName('t'))
    .map((t) => t.textContent ?? '')
    .join('');
}

async function readWorkbook(file: Blob): Promise<{ sheets: Map<string, string>; zip: JSZip; shared: string[] }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new SheetError('notXlsx');
  }
  const wbXml = await zip.file('xl/workbook.xml')?.async('string');
  const relXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!wbXml || !relXml) throw new SheetError('notXlsx');
  const rels = new Map<string, string>();
  for (const r of Array.from(parseXml(relXml).getElementsByTagName('Relationship'))) {
    const target = r.getAttribute('Target') ?? '';
    rels.set(r.getAttribute('Id') ?? '', target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const sheets = new Map<string, string>();
  for (const s of Array.from(parseXml(wbXml).getElementsByTagName('sheet'))) {
    const rid = s.getAttributeNS(REL_NS, 'id') ?? s.getAttribute('r:id') ?? '';
    const path = rels.get(rid);
    if (path) sheets.set(s.getAttribute('name') ?? '', path);
  }
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string');
  const shared = sharedXml ? Array.from(parseXml(sharedXml).getElementsByTagName('si')).map(textOf) : [];
  return { sheets, zip, shared };
}

async function readSheet(zip: JSZip, path: string, shared: string[]): Promise<Cell[][]> {
  const xml = await zip.file(path)?.async('string');
  if (!xml) return [];
  const out: Cell[][] = [];
  for (const row of Array.from(parseXml(xml).getElementsByTagName('row'))) {
    const r = Number(row.getAttribute('r') ?? out.length + 1) - 1;
    const cells: Cell[] = [];
    for (const c of Array.from(row.getElementsByTagName('c'))) {
      const ref = c.getAttribute('r');
      const ci = ref ? colIndex(ref) : cells.length;
      const t = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent ?? null;
      let val: Cell = null;
      if (t === 's') val = v === null ? null : (shared[Number(v)] ?? '');
      else if (t === 'inlineStr') val = c.getElementsByTagName('is')[0] ? textOf(c.getElementsByTagName('is')[0]) : '';
      else if (t === 'str' || t === 'e') val = v;
      else if (t === 'b') val = v === '1' ? 1 : 0;
      else val = v === null || v === '' ? null : Number(v);
      cells[ci] = val;
    }
    out[r] = cells;
  }
  return Array.from(out, (r) => r ?? []);
}

const str = (v: Cell) => (v === null || v === undefined ? '' : String(v).trim());
function int(v: Cell, what: string, serial: string): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n < 0 || Math.round(n) !== n) throw new SheetError('badRow', `${serial} ${what}=${v}`);
  return n;
}

/** 「WMS原始数据」页要的列（名字和 Claude 的生成脚本一致） */
const RAW = {
  serial: '序号',
  loc: '库位号',
  orig: '原库位号',
  locIn: '哪些系统有此库位',
  wms: '系统',
  wh: '仓库代码',
  customer: '客户代码',
  sku: 'SKU',
  onhand: '在库',
  out: '待出',
  lo: '应在（在库−待出）',
  stype: '库存类型',
  batches: '批次（入库单×数量）',
  firstPut: '最早上架时间',
  tier: '层',
  extra: '库容表外',
  tag: '标签',
  aisle: '通道键',
  pos: '位号',
  first: '首行',
  codes: '扫码',
} as const;
const REQUIRED: (keyof typeof RAW)[] = ['serial', 'loc', 'wms', 'sku', 'onhand', 'lo', 'aisle', 'first'];

/** 读 Claude 出的盘点表 */
export async function readCountSheet(file: Blob): Promise<ParsedSheet> {
  const { sheets, zip, shared } = await readWorkbook(file);
  const appPath = sheets.get('_app');
  if (!appPath) throw new SheetError('noAppSheet');
  const meta = new Map<string, string>();
  for (const r of await readSheet(zip, appPath, shared)) if (r[0] !== null && r[0] !== undefined) meta.set(str(r[0]), str(r[1] ?? null));
  if (meta.get('format') !== SHEET_FORMAT) throw new SheetError('badFormat', meta.get('format') ?? '');
  const rawPath = sheets.get('WMS原始数据');
  if (!rawPath) throw new SheetError('noRawSheet');
  const table = await readSheet(zip, rawPath, shared);
  const head = (table[0] ?? []).map((h) => str(h ?? null));
  const col = {} as Record<keyof typeof RAW, number>;
  for (const k of Object.keys(RAW) as (keyof typeof RAW)[]) col[k] = head.indexOf(RAW[k]);
  const missing = REQUIRED.filter((k) => col[k] < 0).map((k) => RAW[k]);
  if (missing.length) throw new SheetError('missingColumn', missing.join('、'));
  const get = (r: Cell[], k: keyof typeof RAW): Cell => (col[k] >= 0 ? (r[col[k]] ?? null) : null);

  const rows: StocktakeImportRow[] = [];
  const seenSerial = new Set<string>();
  const firstOf = new Map<string, number>();
  let lastLoc = '';
  const closedLocs = new Set<string>();
  for (const r of table.slice(1)) {
    const serial = str(get(r, 'serial'));
    if (!/^\d+-\d+$/.test(serial)) continue; // 表尾的说明行 / 空行
    if (seenSerial.has(serial)) throw new SheetError('badRow', `${serial} 重复`);
    seenSerial.add(serial);
    const loc = str(get(r, 'loc')).toUpperCase();
    const aisle = str(get(r, 'aisle'));
    if (!loc || !aisle) throw new SheetError('badRow', `${serial} 缺库位或通道`);
    // 同一个库位的几行必须挨着
    if (loc !== lastLoc) {
      if (closedLocs.has(loc)) throw new SheetError('badRow', `${serial} ${loc} 不连续`);
      if (lastLoc) closedLocs.add(lastLoc);
      lastLoc = loc;
    }
    const isFirst = str(get(r, 'first')) === '1';
    if (isFirst) {
      if (firstOf.has(loc)) throw new SheetError('badRow', `${serial} ${loc} 首行重复`);
      firstOf.set(loc, rows.length);
    } else if (!firstOf.has(loc)) throw new SheetError('badRow', `${serial} ${loc} 缺首行`);
    const sku = str(get(r, 'sku'));
    const hi = int(get(r, 'onhand'), '在库', serial);
    const lo = int(get(r, 'lo'), '应在', serial);
    if (lo > hi) throw new SheetError('badRow', `${serial} 应在>在库`);
    const orig = str(get(r, 'orig'));
    const codes = Array.from(new Set([loc, orig, ...str(get(r, 'codes')).split('|')].map((x) => x.trim()).filter(Boolean)));
    const posCell = get(r, 'pos');
    const tierCell = get(r, 'tier');
    rows.push({
      seq: rows.length + 1,
      serial,
      aisle,
      pos: posCell === null || posCell === '' ? null : int(posCell, '位号', serial),
      loc,
      codes,
      is_first: isFirst,
      sku,
      wms: str(get(r, 'wms')),
      customer: str(get(r, 'customer')),
      lo: sku ? lo : 0,
      hi: sku ? hi : 0,
      tag: str(get(r, 'tag')),
      extra: str(get(r, 'extra')) === '是',
      info: {
        orig,
        wh: str(get(r, 'wh')),
        loc_in: str(get(r, 'locIn')),
        out: int(get(r, 'out'), '待出', serial),
        stype: str(get(r, 'stype')),
        batches: str(get(r, 'batches')),
        first_put: str(get(r, 'firstPut')),
        tier: tierCell === null ? null : Number(tierCell),
      },
    });
  }
  if (!rows.length) throw new SheetError('empty');
  const hall = meta.get('hall') || rows[0].serial.split('-')[0];
  const exported = meta.get('exported_at') || '';
  const exportedAt = exported && !Number.isNaN(Date.parse(exported)) ? new Date(exported).toISOString() : null;
  return {
    hall,
    title: meta.get('title') || `${hall}厅 库位空位盘点`,
    exported_at: exportedAt,
    rows,
    locations: firstOf.size,
    aisles: new Set(rows.map((r) => r.aisle)).size,
  };
}

// ---------------------------------------------------------------------------
// 导出现场结果
// ---------------------------------------------------------------------------
const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // XML 1.0 不允许的控制字符去掉
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function colName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type XCell = string | number | null;

export interface SheetSpec {
  name: string;
  header: string[];
  rows: XCell[][];
  widths: number[];
  /** 表格下面空一行写的说明（每句一行，写在 A 列） */
  notes?: string[];
  /** 要加粗的数据行（从 0 开始，不算表头），比如合计 */
  bold?: number[];
}

/** 工作表名：最多 31 个字，不能有 []:*?/\ */
const sheetName = (s: string) => s.replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || 'Sheet';

/** 几页的 xlsx：每页第一行是表头（加粗、冻结、可筛选），文字用 inlineStr */
export async function buildWorkbook(specs: SheetSpec[]): Promise<Blob> {
  const zip = new JSZip();
  const cell = (v: XCell, ref: string, bold = false) => {
    const s = bold ? ' s="1"' : '';
    if (v === null || v === '') return '';
    if (typeof v === 'number') return `<c r="${ref}"${s}><v>${v}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  };
  const names: string[] = [];
  specs.forEach((sp, si) => {
    let name = sheetName(sp.name);
    while (names.includes(name)) name = sheetName(`${name.slice(0, 28)}_${si + 1}`);
    names.push(name);
    const bold = new Set((sp.bold ?? []).map((i) => i + 1));
    const table = [sp.header, ...sp.rows];
    const lines = table.map(
      (r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cell(v, `${colName(ci)}${ri + 1}`, ri === 0 || bold.has(ri))).join('')}</row>`,
    );
    (sp.notes ?? []).forEach((n, i) => {
      const ri = table.length + 2 + i;
      lines.push(`<row r="${ri}">${cell(n, `A${ri}`)}</row>`);
    });
    const lastCol = colName(Math.max(sp.header.length, 1) - 1);
    zip.file(
      `xl/worksheets/sheet${si + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL_NS}">` +
        `<sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
        `<cols>${sp.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
        `<sheetData>${lines.join('')}</sheetData>` +
        `<autoFilter ref="A1:${lastCol}${table.length}"/>` +
        `</worksheet>`,
    );
  });
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      specs
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('') +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL_NS}">` +
      `<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
      `<definedNames>${specs
        .map(
          (sp, i) =>
            `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(names[i].replace(/'/g, "''"))}'!$A$1:$${colName(Math.max(sp.header.length, 1) - 1)}$${sp.rows.length + 1}</definedName>`,
        )
        .join('')}</definedNames>` +
      `</workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      specs
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('') +
      `<Relationship Id="rId${specs.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  );
  zip.file(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font></fonts>` +
      `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`,
  );
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** 单页 xlsx（以前的接口） */
export function buildXlsx(sheet: string, header: string[], rows: XCell[][], widths: number[]): Promise<Blob> {
  return buildWorkbook([{ name: sheet, header, rows, widths }]);
}

/** 界面语言的翻译函数（i18next 的 t；测试时可以换成自己的） */
export type Translate = (key: string, opts?: Record<string, unknown>) => unknown;

/** 导出用的文字：都从 stock.* 取，中文 / 德语跟着界面走 */
function exportText(t: Translate) {
  const str = (k: string, o?: Record<string, unknown>) => String(t(k, o));
  const arr = (k: string) => t(k, { returnObjects: true }) as string[];
  return {
    str,
    status: Object.fromEntries(STATUSES.map((s) => [s, str(`stock.s.${s}`)])) as Record<StockStatus, string>,
    verdict: Object.fromEntries(VERDICTS.map((v) => [v, str(`stock.v.${v}`)])) as Record<Verdict, string>,
    header: arr('stock.exportHeader'),
    added: str('stock.foundTag'),
    yes: str('stock.xls.yes'),
    sum: { name: str('stock.xls.sumSheet'), header: arr('stock.xls.sumHeader'), total: str('stock.xls.total'), notes: arr('stock.xls.sumNotes') },
    diff: { name: str('stock.xls.diffSheet'), header: arr('stock.xls.diffHeader'), notes: arr('stock.xls.diffNotes') },
    use: {
      name: str('stock.xls.useSheet'),
      header: arr('stock.xls.useHeader'),
      notes: arr('stock.xls.useNotes'),
      kind: { empty: str('stock.xls.kind.empty'), half: str('stock.xls.kind.half'), move: str('stock.xls.kind.move'), check: str('stock.xls.kind.check') },
      warn: { sysFull: str('stock.xls.warn.sysFull'), picked: str('stock.xls.warn.picked'), noSku: str('stock.xls.warn.noSku'), move: str('stock.xls.warn.move') },
    },
  };
}

/** 差异明细里的先后：要核实去向的在最前面 */
const DIFF_ORDER: Verdict[] = ['sysFull', 'sysNoSlot', 'sysEmpty', 'qty', 'found', 'odd'];

/** SKU 比较用：去空格、大写（现场加的本来就是大写） */
const skuKey = (s: string) => s.trim().toUpperCase();

/**
 * 导出这次盘点的现场结果（四页，见文件开头）。
 * fmtTime：盘点时间怎么写（界面上是柏林时间 MM-dd HH:mm）；lang：通道名用中文还是德语。
 */
export async function buildResults(
  take: Stocktake,
  rows: StocktakeRow[],
  photos: StocktakePhoto[],
  t: Translate,
  lang: string,
  fmtTime: (iso: string | null) => string,
  now = new Date(),
): Promise<Blob> {
  const L = exportText(t);
  const groups = groupLocations(rows);
  const verdicts = new Map<string, Verdict>(groups.map((g) => [g.loc, verdictOf(g)]));
  const nPhotos = new Map<string, number>();
  for (const p of photos) nPhotos.set(p.loc, (nPhotos.get(p.loc) ?? 0) + 1);
  const st = (g: LocGroup) => (g.head.status ? L.status[g.head.status] : '');

  // 1. 盘点结果：每行一个序号；状态 / 判断 / 照片数 / 挪写在每个库位的第一行
  const results: XCell[][] = [];
  for (const g of groups) {
    const v = verdicts.get(g.loc)!;
    const n = nPhotos.get(g.loc) ?? 0;
    g.rows.forEach((r, i) => {
      results.push([
        r.serial,
        r.aisle,
        r.loc,
        r.sku,
        r.wms,
        r.customer,
        r.added ? '' : qtyText(r.lo, r.hi),
        i === 0 && r.status ? L.status[r.status] : '',
        i === 0 ? r.can_add : null,
        r.actual,
        r.note,
        i === 0 ? L.verdict[v] : '',
        r.added ? L.added : '',
        i === 0 && n ? n : null,
        r.counted_by_name,
        fmtTime(r.counted_at),
        r.counted_at,
        i === 0 && isMoveNote(g.head.note) ? L.yes : '',
      ]);
    });
  }

  // 2. 汇总：每条通道一行 + 合计
  const { aisles, total } = statsByAisle(groups);
  const sumRow = (name: string, s: Stats): XCell[] => [
    name,
    s.total,
    s.done,
    s.empty,
    s.usable,
    s.half,
    s.canAdd,
    s.full,
    s.none,
    s.odd,
    s.move,
    s.diff,
    s.missing,
    s.noSlotDiff,
    s.halfNoSku,
  ];
  const summary = [...aisles.map((a) => sumRow(aisleLabel(a.aisle, lang), a.stats)), sumRow(L.sum.total, total)];

  // 3. 差异明细：每样要核实的货一行
  const diffRows: XCell[][] = [];
  const todo = (v: Verdict) => L.str(`stock.xls.todo.${v}`);
  for (const kind of DIFF_ORDER) {
    for (const g of groups) {
      if (verdicts.get(g.loc) !== kind) continue;
      const base = (sku: string, wms: string, customer: string, qty: string, actual: number | null): XCell[] => [
        L.verdict[kind],
        todo(kind),
        g.aisle,
        g.loc,
        sku,
        wms,
        customer,
        qty,
        actual,
        st(g),
        g.head.note,
        nPhotos.get(g.loc) || null,
        g.head.counted_by_name,
        fmtTime(g.head.counted_at),
        '',
        '',
        '',
        '',
      ];
      const sys = g.rows.filter((r) => !r.added && r.sku && r.hi > 0);
      const found = g.rows.filter((r) => r.added);
      let list: XCell[][] = [];
      if (kind === 'sysFull' || kind === 'sysNoSlot') list = sys.map((r) => base(r.sku, r.wms, r.customer, qtyText(r.lo, r.hi), r.actual));
      else if (kind === 'qty') list = g.rows.filter(qtyOff).map((r) => base(r.sku, r.wms, r.customer, qtyText(r.lo, r.hi), r.actual));
      else if (kind === 'sysEmpty' || kind === 'found') list = found.map((r) => base(r.sku || r.note, '', '', '', r.actual));
      if (!list.length) list = [base('', '', '', '', null)];
      diffRows.push(...list);
    }
  }

  // 4. 可用库位：空 → 半（同 SKU 优先合并）→ 挪（需整理后才能使用）→ 有差异的；无 / 异不列。
  //    按草稿规则（用户 11-03 定），有差异的库位（系统有货现场空、系统空现场有货、数量不符、有表外的货……）
  //    差异核实、处理完之前不做移库目标：不算「可直接用」，单独列在最后。
  const bySku = new Map<string, LocGroup[]>();
  for (const g of groups) {
    for (const k of new Set(productsOf(g).map((p) => skuKey(p.sku)))) {
      if (!bySku.has(k)) bySku.set(k, []);
      bySku.get(k)!.push(g);
    }
  }
  const tierOf = (g: LocGroup) => {
    const n = Number(g.loc.slice(-2));
    return Number.isFinite(n) ? n : null;
  };
  const useRow = (kind: string, g: LocGroup, p: { sku: string; wms: string; customer: string; qty: string } | null, others: LocGroup[], warn: string): XCell[] => [
    kind,
    g.aisle,
    g.loc,
    tierOf(g),
    g.head.status === 'half' ? g.head.can_add : null,
    p?.sku ?? '',
    p?.wms ?? '',
    p?.customer ?? '',
    p?.qty ?? '',
    others.length || null,
    others
      .slice(0, 12)
      .map((o) => `${o.loc}${o.head.status ? `（${L.status[o.head.status]}）` : ''}`)
      .join('、') + (others.length > 12 ? ' …' : ''),
    warn,
    g.head.note,
    g.head.counted_by_name,
    fmtTime(g.head.counted_at),
  ];
  const useRows: XCell[][] = [];
  const counted = (g: LocGroup) => !!g.head.status;
  const later: LocGroup[] = [];
  const hasDiff = (g: LocGroup) => isDiff(verdicts.get(g.loc)!);
  for (const g of groups) {
    if (g.head.status !== 'empty' || isMoveNote(g.head.note)) continue;
    if (hasDiff(g)) {
      later.push(g);
      continue;
    }
    useRows.push(useRow(L.use.kind.empty, g, null, [], verdicts.get(g.loc) === 'picked' ? L.use.warn.picked : ''));
  }
  const halfRows: { hasOthers: boolean; sku: string; seq: number; row: XCell[] }[] = [];
  for (const g of groups) {
    if (g.head.status !== 'half' || isMoveNote(g.head.note)) continue;
    if (hasDiff(g)) {
      later.push(g);
      continue;
    }
    const prods = productsOf(g);
    if (!prods.length) {
      halfRows.push({ hasOthers: false, sku: '\uffff', seq: g.head.seq, row: useRow(L.use.kind.half, g, null, [], needsProduct(g) ? L.use.warn.noSku : '') });
      continue;
    }
    for (const p of prods) {
      const others = (bySku.get(skuKey(p.sku)) ?? []).filter((o) => o.loc !== g.loc);
      const qty = p.found ? (p.hi ? String(p.hi) : '') : qtyText(p.lo, p.hi);
      halfRows.push({ hasOthers: others.length > 0, sku: skuKey(p.sku), seq: g.head.seq, row: useRow(L.use.kind.half, g, { sku: p.sku, wms: p.wms, customer: p.customer, qty }, others, '') });
    }
  }
  // 同 SKU 在别的库位也有的排前面（按 SKU 挨着），其余按走行顺序
  halfRows.sort((a, b) => Number(b.hasOthers) - Number(a.hasOthers) || (a.hasOthers ? a.sku.localeCompare(b.sku) : 0) || a.seq - b.seq);
  useRows.push(...halfRows.map((x) => x.row));
  for (const g of groups) {
    if (!counted(g) || !isMoveNote(g.head.note) || g.head.status === 'odd' || g.head.status === 'full') continue;
    if (hasDiff(g)) {
      later.push(g);
      continue;
    }
    const prods = productsOf(g);
    const p = prods[0];
    useRows.push(useRow(L.use.kind.move, g, p ? { sku: prods.map((x) => x.sku).join(' / '), wms: p.wms, customer: p.customer, qty: '' } : null, [], ''));
  }
  // 有差异的：按走行顺序，写上是什么差异（细节在「差异明细」），核实完才能用
  later.sort((a, b) => a.head.seq - b.head.seq);
  for (const g of later) {
    const v = verdicts.get(g.loc)!;
    // 勾「空」的：表上的货现场并不在（只写现场加的），别让人以为那里有货
    const prods = productsOf(g).filter((x) => g.head.status !== 'empty' || x.found);
    const p = prods[0];
    const keys = new Set(prods.map((x) => skuKey(x.sku)));
    const others = groups.filter((o) => o.loc !== g.loc && [...keys].some((k) => bySku.get(k)?.includes(o)));
    const warn = [
      v === 'sysFull' ? L.use.warn.sysFull : L.str('stock.xls.warn.diff', { v: L.verdict[v] }),
      needsProduct(g) ? L.use.warn.noSku : '',
      isMoveNote(g.head.note) ? L.use.warn.move : '',
    ]
      .filter(Boolean)
      .join(L.str('stock.xls.warnSep'));
    useRows.push(useRow(L.use.kind.check, g, p ? { sku: prods.map((x) => x.sku).join(' / '), wms: p.wms, customer: p.customer, qty: '' } : null, others, warn));
  }

  const meta = L.str('stock.xls.meta', { title: take.title, time: fmtTime(now.toISOString()) });
  return buildWorkbook([
    {
      name: `${take.hall}厅盘点结果`,
      header: L.header,
      rows: results,
      widths: [9, 8, 14, 26, 8, 10, 10, 6, 8, 7, 24, 16, 8, 6, 10, 16, 26, 10],
    },
    {
      name: L.sum.name,
      header: L.sum.header,
      rows: summary,
      widths: [12, 7, 7, 6, 9, 6, 10, 6, 6, 6, 10, 7, 12, 14, 10],
      bold: [summary.length - 1],
      notes: [...L.sum.notes, meta],
    },
    {
      name: L.diff.name,
      header: L.diff.header,
      rows: diffRows,
      widths: [18, 26, 8, 14, 26, 8, 10, 10, 6, 6, 22, 6, 10, 12, 16, 10, 10, 16],
      notes: [...L.diff.notes, meta],
    },
    {
      name: L.use.name,
      header: L.use.header,
      rows: useRows,
      widths: [20, 8, 14, 5, 9, 26, 8, 10, 9, 9, 40, 24, 22, 10, 12],
      notes: [...L.use.notes, meta],
    },
  ]);
}
