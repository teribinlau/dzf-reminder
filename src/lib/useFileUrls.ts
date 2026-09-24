import { useEffect, useState } from 'react';
import { useStore } from './store';
import type { FileBucket } from './repo';

// 私有桶里的文件要签名地址才能看。缩略图每次渲染都去签一遍太浪费：
// 签一次管 60 分钟，这里记 50 分钟，过期前一直用缓存。
const cache = new Map<string, { url: string; exp: number }>();
const TTL = 50 * 60 * 1000;
const k = (bucket: FileBucket, path: string) => `${bucket}:${path}`;

function fromCache(bucket: FileBucket, paths: string[]): Record<string, string> {
  const now = Date.now();
  const out: Record<string, string> = {};
  for (const p of paths) {
    const c = cache.get(k(bucket, p));
    if (c && c.exp > now) out[p] = c.url;
  }
  return out;
}

/** 一批文件的「在浏览器里直接看」地址（图片缩略图 / 大图用）；断网时拿不到就是空的 */
export function useFileUrls(bucket: FileBucket, paths: string[]): Record<string, string> {
  const repo = useStore((s) => s.repo);
  const key = paths.join('|');
  const [urls, setUrls] = useState<Record<string, string>>(() => fromCache(bucket, paths));
  useEffect(() => {
    let alive = true;
    setUrls(fromCache(bucket, paths));
    const now = Date.now();
    const missing = paths.filter((p) => (cache.get(k(bucket, p))?.exp ?? 0) <= now);
    if (!missing.length) return;
    repo
      .fileUrls(bucket, missing)
      .then((got) => {
        for (const [p, u] of Object.entries(got)) cache.set(k(bucket, p), { url: u, exp: Date.now() + TTL });
        if (alive) setUrls(fromCache(bucket, paths));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, key, repo]);
  return urls;
}
