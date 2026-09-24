import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { useFileUrls } from '../lib/useFileUrls';
import { openExternal } from '../lib/tauri';
import { IconChevronL, IconChevronR, IconDownload, IconX } from './Icons';

/** 看大图：全屏黑底，左右翻（键盘 ← →、手机左右滑），Esc / 返回键关掉 */
export function ImageViewer() {
  const { t } = useTranslation();
  const viewer = useStore((s) => s.viewer);
  const close = useStore((s) => s.closeViewer);
  const open = useStore((s) => s.openViewer);
  const repo = useStore((s) => s.repo);
  const pushToast = useStore((s) => s.pushToast);
  const touchX = useRef<number | null>(null);

  const images = viewer?.images ?? [];
  const bucket = images[0]?.bucket ?? 'attachments';
  const urls = useFileUrls(
    bucket,
    images.map((x) => x.path),
  );

  const go = (d: number) => {
    if (!viewer || images.length < 2) return;
    open({ ...viewer, index: (viewer.index + d + images.length) % images.length });
  };

  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!viewer || !images.length) return null;
  const cur = images[viewer.index];
  const download = async () => {
    try {
      await openExternal(await repo.fileUrl(cur.bucket, cur.path, cur.name));
    } catch (e) {
      pushToast({ title: t('errors.downloadFailed'), body: (e as Error).message, kind: 'error' });
    }
  };

  return (
    <div
      className="viewer"
      role="dialog"
      aria-modal="true"
      aria-label={cur.name}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current === null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
      }}
    >
      <div className="viewer-bar">
        <span className="viewer-name">
          {cur.name}
          {images.length > 1 && <span className="viewer-count"> · {viewer.index + 1}/{images.length}</span>}
        </span>
        <button className="viewer-btn" onClick={() => void download()} aria-label={t('files.download')}>
          <IconDownload size={18} />
        </button>
        <button className="viewer-btn" onClick={close} aria-label={t('actions.close')}>
          <IconX size={18} />
        </button>
      </div>
      {urls[cur.path] ? <img className="viewer-img" src={urls[cur.path]} alt={cur.name} onMouseDown={(e) => e.stopPropagation()} /> : <span className="viewer-loading">…</span>}
      {images.length > 1 && (
        <>
          <button className="viewer-nav prev" onClick={() => go(-1)} aria-label={t('files.prev')}>
            <IconChevronL size={22} />
          </button>
          <button className="viewer-nav next" onClick={() => go(1)} aria-label={t('files.next')}>
            <IconChevronR size={22} />
          </button>
        </>
      )}
    </div>
  );
}
