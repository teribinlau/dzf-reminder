import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isPreviewableImage } from '../lib/images';
import { fmtSize } from '../lib/format';
import { filesFromTransfer, isFileDrag, mergeFiles } from '../lib/files';
import { IconCamera, IconFile, IconPlus, IconRefresh, IconX } from './Icons';

/** 已经在服务器上的文件（编辑提醒时的旧附件） */
export interface TrayExisting {
  id: string;
  name: string;
  size: number;
  mime: string;
  thumb?: string;
  /** 保存时要删掉（先标记，点「取消」就什么都不动） */
  removed?: boolean;
}

/** 手机 / 平板上多给一个「拍照」按钮（桌面上 capture 没用，会变成普通的选图片） */
const TOUCH = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

/**
 * 选文件的托盘：可以分好几次加（先拍一张、再从相册挑几张、再加个 PDF），
 * 每个都能点 × 去掉，确认之后才真的上传。
 */
export function FileTray({
  files,
  onChange,
  existing = [],
  onToggleExisting,
  onOpenExisting,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  existing?: TrayExisting[];
  onToggleExisting?: (id: string) => void;
  onOpenExisting?: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const pick = useRef<HTMLInputElement>(null);
  const cam = useRef<HTMLInputElement>(null);

  // 本地图片的预览地址：文件变了就重建，旧的回收
  const thumbs = useMemo(() => files.map((f) => (isPreviewableImage(f.type) ? URL.createObjectURL(f) : '')), [files]);
  useEffect(() => () => thumbs.forEach((u) => u && URL.revokeObjectURL(u)), [thumbs]);

  const add = (input: HTMLInputElement | null) => {
    const picked = Array.from(input?.files ?? []);
    if (input) input.value = '';
    if (!picked.length) return;
    onChange(mergeFiles(files, picked)); // 同一个文件选两次只算一个
  };
  // 电脑上也可以直接把文件拖进来
  const [over, setOver] = useState(false);

  return (
    <div
      className={`tray ${over ? 'drag' : ''}`}
      onDragOver={(e) => {
        if (disabled || !isFileDrag(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (disabled || !isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const got = filesFromTransfer(e.dataTransfer);
        if (got.length) onChange(mergeFiles(files, got));
      }}
    >
      {existing.map((x) => (
        <div key={x.id} className={`tray-item ${x.removed ? 'removed' : ''}`}>
          <button type="button" className="tray-thumb" onClick={() => onOpenExisting?.(x.id)} title={x.name} disabled={!onOpenExisting}>
            {x.thumb ? <img src={x.thumb} alt="" /> : <IconFile size={22} />}
          </button>
          <span className="tray-name" title={x.name}>
            {x.name}
          </span>
          <span className="tray-size">{x.removed ? t('files.willRemove') : fmtSize(x.size)}</span>
          {onToggleExisting && (
            <button type="button" className="tray-x" onClick={() => onToggleExisting(x.id)} aria-label={x.removed ? t('files.undoRemove') : t('files.remove', { name: x.name })} disabled={disabled}>
              {x.removed ? <IconRefresh size={12} /> : <IconX size={12} />}
            </button>
          )}
        </div>
      ))}
      {files.map((f, i) => (
        <div key={`${f.name}|${f.size}`} className="tray-item new">
          <span className="tray-thumb">{thumbs[i] ? <img src={thumbs[i]} alt="" /> : <IconFile size={22} />}</span>
          <span className="tray-name" title={f.name}>
            {f.name}
          </span>
          <span className="tray-size">{fmtSize(f.size)}</span>
          <button type="button" className="tray-x" onClick={() => onChange(files.filter((_, j) => j !== i))} aria-label={t('files.remove', { name: f.name })} disabled={disabled}>
            <IconX size={12} />
          </button>
        </div>
      ))}
      <div className="tray-add">
        <button type="button" className="tray-btn" onClick={() => pick.current?.click()} disabled={disabled}>
          <IconPlus size={16} />
          {files.length || existing.length ? t('files.addMore') : t('files.add')}
        </button>
        {TOUCH && (
          <button type="button" className="tray-btn" onClick={() => cam.current?.click()} disabled={disabled}>
            <IconCamera size={16} />
            {t('files.camera')}
          </button>
        )}
      </div>
      <input ref={pick} type="file" multiple hidden onChange={() => add(pick.current)} />
      <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={() => add(cam.current)} />
    </div>
  );
}
