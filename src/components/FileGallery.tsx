import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import type { FileBucket } from '../lib/repo';
import { isPreviewableImage } from '../lib/images';
import { fmtSize } from '../lib/format';
import { useFileUrls } from '../lib/useFileUrls';
import { openExternal } from '../lib/tauri';
import { IconDownload, IconFile, IconX } from './Icons';

export interface GalleryItem {
  id: string;
  file_path: string;
  file_name: string;
  size: number;
  mime: string;
  /** 小字：谁、什么时候（回传文件用） */
  meta?: string;
}

/**
 * 服务器上的一组文件：照片排成缩略图（点开看大图，左右翻），其他文件一行一个（点了下载）。
 * 附件和回传文件共用。
 */
export function FileGallery({
  bucket,
  items,
  canDelete,
  onDelete,
}: {
  bucket: FileBucket;
  items: GalleryItem[];
  canDelete?: (it: GalleryItem) => boolean;
  onDelete?: (it: GalleryItem) => void;
}) {
  const { t } = useTranslation();
  const repo = useStore((s) => s.repo);
  const pushToast = useStore((s) => s.pushToast);
  const openViewer = useStore((s) => s.openViewer);
  const images = items.filter((it) => isPreviewableImage(it.mime));
  const others = items.filter((it) => !isPreviewableImage(it.mime));
  const urls = useFileUrls(
    bucket,
    images.map((it) => it.file_path),
  );

  const download = async (it: GalleryItem) => {
    try {
      await openExternal(await repo.fileUrl(bucket, it.file_path, it.file_name));
    } catch (e) {
      pushToast({ title: t('errors.downloadFailed'), body: (e as Error).message, kind: 'error' });
    }
  };
  const del = (it: GalleryItem) => {
    if (window.confirm(t('files.confirmDelete', { name: it.file_name }))) onDelete?.(it);
  };

  return (
    <div className="gallery">
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((it, i) => (
            <div key={it.id} className="thumb">
              <button
                type="button"
                className="thumb-img"
                title={it.meta ? `${it.file_name} · ${it.meta}` : it.file_name}
                onClick={() => openViewer({ images: images.map((x) => ({ bucket, path: x.file_path, name: x.file_name })), index: i })}
              >
                {urls[it.file_path] ? <img src={urls[it.file_path]} alt={it.file_name} loading="lazy" /> : <span className="thumb-ph" />}
              </button>
              {it.meta && <span className="thumb-meta">{it.meta}</span>}
              {canDelete?.(it) && (
                <button type="button" className="thumb-x" aria-label={t('actions.delete')} onClick={() => del(it)}>
                  <IconX size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {others.map((it) => (
        <div key={it.id} className="sub-row">
          <button className="sub-file" onClick={() => void download(it)} title={it.file_name}>
            <IconFile size={14} />
            <span className="sub-name">{it.file_name}</span>
          </button>
          <span className="sub-meta">{[it.meta, fmtSize(it.size)].filter(Boolean).join(' · ')}</span>
          <button className="icon-btn sm" aria-label={t('files.download')} onClick={() => void download(it)}>
            <IconDownload size={12} />
          </button>
          {canDelete?.(it) && (
            <button className="icon-btn sm" aria-label={t('actions.delete')} onClick={() => del(it)}>
              <IconX size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
