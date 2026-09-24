// 照片上传前在本机压一下：手机照片一张 3–5 MB，Supabase 免费版一共 1 GB。
// 规则（用户定的）：长边超过 2560px 就等比缩到 2560px，存成 JPEG（质量 0.85）；
// 标签、单据上的字在 2560px 下依然清楚。只动照片 —— PDF、Excel 等原样上传；
// 压完反而更大、或者浏览器解不了（比如 Chrome 里的 HEIC）也原样上传。

export const MAX_EDGE = 2560;
const QUALITY = 0.85;
/** 没超尺寸但文件还是很大（比如 2000px 的 PNG 照片）也转一下 JPEG */
const BIG_BYTES = 1.5 * 1024 * 1024;
const SHRINKABLE = /^image\/(jpeg|jpg|png|webp|heic|heif|bmp)$/i;
/** 浏览器 <img> 能直接显示的图片（缩略图用）；HEIC 在 Chrome 里显示不了，当普通文件 */
const PREVIEWABLE = /^image\/(jpeg|jpg|png|gif|webp|svg\+xml|bmp|avif)$/i;

export function isPreviewableImage(mime: string | undefined | null): boolean {
  return !!mime && PREVIEWABLE.test(mime);
}

async function decode(file: File): Promise<{ src: CanvasImageSource; width: number; height: number; done: () => void } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { src: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
    } catch {
      /* 老 Safari 不认 options，或者格式解不了 —— 走 <img> 再试一次 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { src: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

export async function shrinkImage(file: File): Promise<File> {
  if (!SHRINKABLE.test(file.type)) return file;
  const img = await decode(file);
  if (!img || !img.width || !img.height) return file;
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    if (scale === 1 && file.size <= BIG_BYTES) return file;
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#ffffff'; // PNG 的透明底转 JPEG 会变黑，先铺白
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.src, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[a-z0-9]{1,8}$/i, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified });
  } finally {
    img.done();
  }
}
