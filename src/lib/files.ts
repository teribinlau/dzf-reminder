import i18n from '../i18n';

/** 同一个文件点两次只算一个。按「名字 + 大小」认：lastModified 靠不住 —— iPhone 每次从相册选都会给个新时间 */
export function mergeFiles(current: File[], added: File[]): File[] {
  const seen = new Set(current.map((f) => `${f.name}|${f.size}`));
  const out = [...current];
  for (const f of added) {
    const k = `${f.name}|${f.size}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/**
 * 粘贴 / 拖进来的文件。截图从剪贴板出来都叫 image.png，下载的时候分不清 ——
 * 改成「截图 11-22-33.png」这种（同一次粘了好几张就再加 -1、-2）。
 */
export function filesFromTransfer(dt: DataTransfer | null): File[] {
  const list = Array.from(dt?.files ?? []);
  const now = new Date();
  const hms = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join('-');
  return list.map((f, i) => {
    const m = f.name.match(/^image\.(png|jpe?g|gif|webp|bmp)$/i);
    if (!m) return f;
    const name = `${i18n.t('files.pastedName', { time: hms })}${list.length > 1 ? `-${i + 1}` : ''}.${m[1].toLowerCase()}`;
    return new File([f], name, { type: f.type, lastModified: f.lastModified });
  });
}

/** 拖进来的是不是文件（拖一段文字进输入框不用管） */
export function isFileDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}
