import i18n from '../i18n';
import { useStore } from './store';
import { isTauri } from './tauri';

// 存文件（盘点结果、照片压缩包、提交的文件「全部下载」）：
// 浏览器里走普通下载；桌面版的 webview 不一定会处理 <a download>（Mac 的根本不下载，Windows 的有时没反应），
// 所以交给桌面壳直接写到「下载」文件夹，返回完整路径，界面上提示存到哪了、可以在文件夹里显示。

export function safeFileName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return s || 'download';
}

/** 桌面版：发给 save_download 的请求体 = 4 字节文件名长度（小端）+ 文件名（UTF-8）+ 文件内容 */
export function packDownload(name: string, data: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const body = new Uint8Array(4 + nameBytes.length + data.length);
  new DataView(body.buffer).setUint32(0, nameBytes.length, true);
  body.set(nameBytes, 4);
  body.set(data, 4 + nameBytes.length);
  return body;
}

/**
 * 存一个文件。桌面版返回存下来的完整路径（重名的自动加 (1)、(2)…）；浏览器里返回 null（浏览器自己显示下载）。
 */
export async function saveFile(blob: Blob, name: string): Promise<string | null> {
  const safe = safeFileName(name);
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const body = packDownload(safe, new Uint8Array(await blob.arrayBuffer()));
    return invoke<string>('save_download', body);
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safe;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  return null;
}

/** 桌面版：在资源管理器 / 访达里选中这个文件 */
export async function revealFile(path: string): Promise<void> {
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
}

/** 路径里的文件名（Windows 和 Mac 的分隔符都认） */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** 存文件；桌面版存好后弹一条「已保存到「下载」文件夹 · 文件名」，带「在文件夹里显示」 */
export async function saveFileAndTell(blob: Blob, name: string): Promise<void> {
  const path = await saveFile(blob, name);
  if (!path) return;
  useStore.getState().pushToast({
    title: i18n.t('files.saved'),
    body: baseName(path),
    kind: 'info',
    ms: 15000,
    action: { label: i18n.t('files.reveal'), run: () => void revealFile(path).catch(() => undefined) },
  });
}
