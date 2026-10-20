import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { useOccurrences } from '../lib/useData';
import { IconChevronD, IconX } from './Icons';

/** 右下角最多同时显示几条；再多的折叠成一行「还有 N 条提醒」 */
export const MAX_VISIBLE_TOASTS = 3;

export function Toasts() {
  const { t } = useTranslation();
  const toasts = useStore((s) => s.toasts);
  const loaded = useStore((s) => s.loaded);
  const dismiss = useStore((s) => s.dismissToast);
  const clearToasts = useStore((s) => s.clearToasts);
  const requestComplete = useStore((s) => s.requestComplete);
  const snooze = useStore((s) => s.snooze);
  const select = useStore((s) => s.select);
  const [expanded, setExpanded] = useState(false);
  const now = new Date();
  const from = useMemo(() => new Date(now.getTime() - 3 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const to = useMemo(() => new Date(now.getTime() + 2 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const occs = useOccurrences(from, to, false);
  const byKey = useMemo(() => new Map(occs.map((o) => [o.key, o])), [occs]);

  // 这条提醒已经有人完成了（别的电脑上完成的也算）、稍后了、或者看不到了 → 提醒栏没意义了，自己消失
  useEffect(() => {
    if (!loaded) return;
    const nowMs = Date.now();
    for (const tt of toasts) {
      if (!tt.occurrenceKey) continue;
      const o = byKey.get(tt.occurrenceKey);
      if (!o || o.completion || (o.snoozedUntil && o.snoozedUntil.getTime() > nowMs)) dismiss(tt.id);
    }
  }, [toasts, byKey, loaded, dismiss]);

  // 条数降回上限以内就不用再记着「展开」了
  useEffect(() => {
    if (toasts.length <= MAX_VISIBLE_TOASTS && expanded) setExpanded(false);
  }, [toasts.length, expanded]);

  if (!toasts.length) return null;
  const folded = toasts.length > MAX_VISIBLE_TOASTS;
  const hidden = folded && !expanded ? toasts.length - MAX_VISIBLE_TOASTS : 0;
  // 折叠时藏掉最早的那几条。列表是 column-reverse：DOM 里第一个贴着角落 ——
  // 折叠行在最下面（一直看得见，展开很多条要滚动时也不会跑掉），上面依次是最新 → 较早的
  const shown = hidden ? toasts.slice(hidden) : toasts;
  return (
    <div className={`toasts${folded && expanded ? ' scroll' : ''}`} aria-live="polite">
      {folded && (
        <div className="toast fold" role="status">
          <button className="fold-btn" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            <span>{expanded ? t('toasts.collapse') : t('toasts.more', { count: hidden })}</span>
            <IconChevronD size={14} className={expanded ? 'flip' : undefined} />
          </button>
          <button className="btn ghost sm" onClick={clearToasts}>
            {t('toasts.closeAll')}
          </button>
        </div>
      )}
      {[...shown].reverse().map((tt) => {
        const o = tt.occurrenceKey ? byKey.get(tt.occurrenceKey) : undefined;
        return (
          <div key={tt.id} className={`toast ${tt.kind}`}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div className="t">{tt.title}</div>
                {tt.body && <div className="b">{tt.body}</div>}
              </div>
              <button className="icon-btn sm" aria-label={t('actions.close')} onClick={() => dismiss(tt.id)}>
                <IconX size={14} />
              </button>
            </div>
            {o && !o.completion && (
              <div className="acts">
                <button className="btn primary sm" onClick={() => { requestComplete(o); dismiss(tt.id); }}>
                  {t('alert.done')}
                </button>
                <button className="btn ghost sm" onClick={() => { void snooze(o, 10); dismiss(tt.id); }}>
                  {t('alert.later')}
                </button>
                <button className="btn ghost sm" onClick={() => { select(o.key); dismiss(tt.id); }}>
                  {t('alert.open')}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
