import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { askConfirm, useStore } from '../../lib/store';
import { hhmm } from '../../lib/stocktake';
import { tidyBatches } from '../../lib/tidy';
import { useTidyCtx } from '../../lib/useTidyData';
import { IconX } from '../Icons';

/**
 * 「批量取消」：一批一批地把还没搬的移库任务从清单里去掉。
 * 一批 = 一次「加入整理」加进来的那些（3D 页里挑了一堆、点一次加入）；一条条加的合成最后一组。
 * 只动待搬 / 有问题的；已搬的要出移库文件，不在这里。普通成员只看得到自己加的，管理员看得到所有人的。
 */
export function TidyCancelDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const data = useTidyCtx();
  const me = useStore((s) => s.me);
  const pushToast = useStore((s) => s.pushToast);
  const isAdmin = me?.role === 'admin';

  const batches = useMemo(() => tidyBatches(data.tasks, me?.id ?? null, isAdmin), [data.tasks, me?.id, isAdmin]);
  // 只有一批时先替他勾上（反正还要再确认一次）
  const [sel, setSel] = useState<Set<string>>(() => new Set(batches.length === 1 ? [batches[0].key] : []));

  const picked = batches.filter((b) => sel.has(b.key));
  const count = picked.reduce((a, b) => a + b.open.length, 0);
  const all = batches.length > 0 && picked.length === batches.length;
  const toggle = (key: string) =>
    setSel((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const go = async () => {
    if (!count || data.needSign) return;
    if (!(await askConfirm({ body: t('tidy.bulk.confirm', { count }), ok: t('tidy.bulk.confirmOk', { count }), cancel: t('tidy.keep'), danger: true }))) return;
    const n = data.actMany(
      picked.flatMap((b) => b.open),
      { action: 'cancel' },
    );
    if (n) pushToast({ title: t('tidy.bulk.done', { count: n }), body: '', kind: 'info' });
    else pushToast({ title: t('tidy.err.noChange'), body: t('tidy.err.noChangeWhy'), kind: 'error' });
    onClose();
  };

  return (
    <div className="overlay td-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sm td-sheet td-bulk" role="dialog" aria-modal="true" aria-label={t('tidy.bulk.title')}>
        <div className="m-head">
          <div>
            <h1>{t('tidy.bulk.title')}</h1>
            <div className="sub">{t('tidy.bulk.sub')}</div>
          </div>
          <div className="grow" />
          <button className="close-round" aria-label={t('actions.close')} onClick={onClose}>
            <IconX size={18} />
          </button>
        </div>

        <div className="m-body">
          {data.needSign && <div className="st-warn">{t('tidy.signFirst')}</div>}
          {!batches.length && <p className="td-p muted">{t('tidy.bulk.none')}</p>}
          {batches.length > 1 && (
            <label className="td-check td-bulk-all">
              <input type="checkbox" checked={all} onChange={() => setSel(new Set(all ? [] : batches.map((b) => b.key)))} id="td-bulk-all" />
              {t('tidy.bulk.all')}
            </label>
          )}
          {batches.map((b) => (
            <label key={b.key} className={`td-bulk-row ${sel.has(b.key) ? 'on' : ''}`} data-batch={b.at ?? 'single'}>
              <input type="checkbox" checked={sel.has(b.key)} onChange={() => toggle(b.key)} />
              <span className="td-bulk-main">
                <b>{b.at ? t('tidy.bulk.batch', { time: hhmm(b.at), name: b.name || '—', n: b.total }) : t('tidy.bulk.single')}</b>
                <span className="td-meta">{t('tidy.bulk.open', { n: b.open.length })}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="m-foot">
          <div className="grow" />
          <button className="btn ghost" onClick={onClose}>
            {t('actions.close')}
          </button>
          <button className="btn danger-fill" disabled={!count || data.needSign} onClick={() => void go()} id="td-bulk-go">
            {t('tidy.bulk.go', { n: count })}
          </button>
        </div>
      </div>
    </div>
  );
}
