import type { ReactNode } from 'react';
import { openExternal } from '../lib/tauri';

// 网址：遇到空白、引号、尖括号或中文标点就停；末尾的英文标点（句号、逗号…）不算网址的一部分
const URL_RE = /https?:\/\/[^\s<>"'，。；、！？：（）【】《》「」]+/g;
const TRAIL_RE = /[.,;:!?)\]]+$/;

/** 把一段文字里的网址变成可以点的链接（桌面版用系统浏览器打开），其余原样显示 */
export function Linkify({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    const trail = url.match(TRAIL_RE)?.[0] ?? '';
    if (trail) url = url.slice(0, -trail.length);
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <a
        key={start}
        className="inline-link"
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          e.preventDefault();
          void openExternal(url);
        }}
      >
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
