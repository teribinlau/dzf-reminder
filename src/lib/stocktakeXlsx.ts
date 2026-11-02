// 盘点表 .xlsx 的读和写（只在导入 / 导出时动态加载，jszip 已经是依赖，不另加解析库）。
//
// 读：Claude 出的《X厅_库位空位盘点表.xlsx》里有一个隐藏的「_app」页（format = dzf-stocktake-v1、厅、导出时间、标题）
//     和「WMS原始数据」页（每行一个序号，列名固定，见 RAW 里的名字）。只认这两页，打印用的「盘点表」页不读。
// 写：导出现场结果，一页「盘点结果」，每行一个序号，文字用 inlineStr，Excel / WPS / LibreOffice 都能打开。
import JSZip from 'jszip';
import type { StocktakeImportRow, StocktakePhoto, StocktakeRow, Stocktake } from './types';
import { groupLocations, qtyText, verdictOf, type Verdict } from './stocktake';

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

/** 最简单的单页 xlsx：第一行是表头（加粗、冻结、可筛选），文字用 inlineStr */
export async function buildXlsx(sheetName: string, header: string[], rows: (string | number | null)[][], widths: number[]): Promise<Blob> {
  const zip = new JSZip();
  const lastCol = colName(header.length - 1);
  const cell = (v: string | number | null, ref: string, bold = false) => {
    const s = bold ? ' s="1"' : '';
    if (v === null || v === '') return '';
    if (typeof v === 'number') return `<c r="${ref}"${s}><v>${v}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  };
  const lines = [header, ...rows].map(
    (r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cell(v, `${colName(ci)}${ri + 1}`, ri === 0)).join('')}</row>`,
  );
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL_NS}">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${lines.join('')}</sheetData>` +
    `<autoFilter ref="A1:${lastCol}${rows.length + 1}"/>` +
    `</worksheet>`;
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
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
      `<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
      `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${esc(sheetName)}'!$A$1:$${lastCol}$${rows.length + 1}</definedName></definedNames>` +
      `</workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
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
      `</styleSheet>`,
  );
  zip.file('xl/worksheets/sheet1.xml', sheet);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** 导出这次盘点的现场结果：每行一个序号；判断 / 照片数写在每个库位的第一行 */
export async function buildResults(
  take: Stocktake,
  rows: StocktakeRow[],
  photos: StocktakePhoto[],
  labels: { status: Record<string, string>; verdict: Record<Verdict, string>; header: string[]; added: string },
  fmtTime: (iso: string | null) => string,
): Promise<Blob> {
  const groups = groupLocations(rows);
  const out: (string | number | null)[][] = [];
  for (const g of groups) {
    const v = verdictOf(g);
    const nPhotos = photos.filter((p) => p.loc === g.loc).length;
    g.rows.forEach((r, i) => {
      out.push([
        r.serial,
        r.aisle,
        r.loc,
        r.sku,
        r.wms,
        r.customer,
        r.added ? '' : qtyText(r.lo, r.hi),
        i === 0 && r.status ? labels.status[r.status] : '',
        i === 0 ? r.can_add : null,
        r.actual,
        r.note,
        i === 0 ? labels.verdict[v] : '',
        r.added ? labels.added : '',
        i === 0 && nPhotos ? nPhotos : null,
        r.counted_by_name,
        fmtTime(r.counted_at),
        r.counted_at,
      ]);
    });
  }
  return buildXlsx(`${take.hall}厅盘点结果`.slice(0, 31), labels.header, out, [9, 8, 14, 26, 8, 10, 10, 6, 8, 7, 24, 16, 8, 6, 10, 16, 26]);
}

/** 浏览器里下载一个 Blob */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}
