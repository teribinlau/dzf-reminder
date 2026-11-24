// .xls（BIFF8）写入器：WMS 的「批量移库位」只认真正的 .xls（xlsx 改后缀会报「文件中必须包含有内容」）。
// 从「合并拣货单」工具的 biff8Xls() 原样搬过来（那边已经用真导入验证过，xlrd / SheetJS / LibreOffice 三种读法也核过），
// 只加了类型：字符串写 LABEL（文本，12 位库位码前导 0 不丢、时间原样），数字写 NUMBER；外面套最小的 OLE2 复合文档。
// PHPExcel 一类导入器读完最后一个 EOF 就停，流尾补零没影响。

/** 一个单元格：字符串按文本写，数字按数字写，null / '' 留空 */
export type XlsCell = string | number | null | undefined;

export function biff8Xls(aoa: XlsCell[][], colWidths?: number[], sheetName?: string): Uint8Array {
  const parts: number[] = [];
  const u16 = (n: number) => [n & 255, (n >> 8) & 255];
  const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  const rec = (type: number, data: number[]) => { parts.push(...u16(type), ...u16(data.length), ...data); };
  const ustr = (s: string) => { const b: number[] = []; for (const ch of String(s)) { const c = ch.codePointAt(0) ?? 0; if (c > 0xFFFF) { b.push(...u16(0xD800 + ((c - 0x10000) >> 10)), ...u16(0xDC00 + ((c - 0x10000) & 0x3FF))); } else b.push(...u16(c)); } return b; };
  const bof = (dt: number) => rec(0x0809, [...u16(0x0600), ...u16(dt), ...u16(0x0DBB), ...u16(0x07CC), ...u32(0), ...u32(6)]);
  // —— 工作簿全局 ——
  bof(0x0005);
  rec(0x0042, u16(1200));                                                             // CODEPAGE UTF-16
  rec(0x003D, [...u16(0), ...u16(0), ...u16(0x3B4F), ...u16(0x1E71), ...u16(0x0038), ...u16(0), ...u16(0), ...u16(1), ...u16(600)]);  // WINDOW1
  for (let i = 0; i < 5; i++) rec(0x0031, [...u16(200), ...u16(0), ...u16(0x7FFF), ...u16(400), ...u16(0), 0, 0, 0, 0, 5, 0, 65, 114, 105, 97, 108]);  // FONT Arial 10 ×5（高度/属性/颜色/粗细/上下标/下划线/族/字符集/保留/名称）
  for (let i = 0; i < 16; i++) {                                                      // XF：15 个样式 + 1 个单元格（ixfe=15）
    const style = i < 15;
    rec(0x00E0, [...u16(0), ...u16(0), ...u16(style ? 0xFFF5 : 0x0001), 0x20, 0, 0, style ? 0 : 0xF4, 0, 0, 0, 0, 0, 0, 0, 0, ...u16(0x20C0)]);
  }
  const name = String(sheetName || 'Sheet1').slice(0, 31);
  const bsPos = parts.length;
  rec(0x0085, [...u32(0), ...u16(0), name.length, 1, ...ustr(name)]);               // BOUNDSHEET（偏移稍后回填）
  rec(0x000A, []);
  // —— 工作表 ——
  const sheetOff = parts.length;
  parts[bsPos + 4] = sheetOff & 255; parts[bsPos + 5] = (sheetOff >> 8) & 255; parts[bsPos + 6] = (sheetOff >> 16) & 255; parts[bsPos + 7] = (sheetOff >>> 24) & 255;
  bof(0x0010);
  const nCols = aoa.reduce((m, r) => Math.max(m, r.length), 0);
  rec(0x0200, [...u32(0), ...u32(aoa.length), ...u16(0), ...u16(nCols), ...u16(0)]);  // DIMENSIONS
  (colWidths || []).forEach((w, c) => rec(0x007D, [...u16(c), ...u16(c), ...u16(Math.round(w * 256)), ...u16(15), ...u16(0), ...u16(0)]));  // COLINFO
  aoa.forEach((row, r) => row.forEach((v, c) => {
    if (v == null || v === '') return;
    if (typeof v === 'number' && isFinite(v)) {
      const f = new Float64Array([v]), b = new Uint8Array(f.buffer);
      rec(0x0203, [...u16(r), ...u16(c), ...u16(15), ...b]);                          // NUMBER
    } else {
      const s = ustr(String(v).slice(0, 4000));
      rec(0x0204, [...u16(r), ...u16(c), ...u16(15), ...u16(s.length / 2), 1, ...s]);  // LABEL（UTF-16）
    }
  }));
  rec(0x000A, []);
  // —— OLE2 复合文档：头 | FAT | 目录 | Workbook 流（凑到 ≥4096 字节，避免 mini stream）——
  const SEC = 512, ENDOFCHAIN = 0xFFFFFFFE, FREE = 0xFFFFFFFF, FATSECT = 0xFFFFFFFD;
  const streamLen = Math.max(4096, Math.ceil(parts.length / SEC) * SEC);
  const nData = streamLen / SEC;
  let nFat = 1; while (nFat * 128 < nFat + 1 + nData) nFat++;
  const total = nFat + 1 + nData;
  const out = new Uint8Array(SEC * (1 + total));
  const w16 = (o: number, n: number) => { out[o] = n & 255; out[o + 1] = (n >> 8) & 255; };
  const w32 = (o: number, n: number) => { out[o] = n & 255; out[o + 1] = (n >> 8) & 255; out[o + 2] = (n >> 16) & 255; out[o + 3] = (n >>> 24) & 255; };
  out.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], 0);
  w16(24, 0x3E); w16(26, 3); w16(28, 0xFFFE); w16(30, 9); w16(32, 6);
  w32(44, nFat); w32(48, nFat); w32(56, 4096); w32(60, ENDOFCHAIN); w32(64, 0); w32(68, ENDOFCHAIN); w32(72, 0);
  for (let i = 0; i < 109; i++) w32(76 + i * 4, i < nFat ? i : FREE);
  const fat = (i: number) => SEC * (1 + Math.floor(i / 128)) + (i % 128) * 4;
  for (let i = 0; i < nFat * 128; i++) w32(fat(i), FREE);
  for (let i = 0; i < nFat; i++) w32(fat(i), FATSECT);
  w32(fat(nFat), ENDOFCHAIN);                                                          // 目录只占 1 个扇区
  for (let i = 0; i < nData; i++) w32(fat(nFat + 1 + i), i === nData - 1 ? ENDOFCHAIN : nFat + 2 + i);
  const dir = SEC * (1 + nFat);
  const entry = (k: number, nm: string, type: number, child: number, start: number, size: number) => {
    const o = dir + k * 128, s = ustr(nm);
    out.set(s, o); w16(o + 64, s.length + 2); out[o + 66] = type; out[o + 67] = 1;
    w32(o + 68, FREE); w32(o + 72, FREE); w32(o + 76, child); w32(o + 116, start); w32(o + 120, size);
  };
  entry(0, 'Root Entry', 5, 1, ENDOFCHAIN, 0);
  entry(1, 'Workbook', 2, FREE, nFat + 1, streamLen);
  for (let k = 2; k < 4; k++) { const o = dir + k * 128; w32(o + 68, FREE); w32(o + 72, FREE); w32(o + 76, FREE); }
  out.set(parts, SEC * (1 + nFat + 1));
  return out;
}
