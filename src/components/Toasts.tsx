import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { useOccurrences } from '../lib/useData';
import { IconX } from './Icons';

export function Toasts() {
  const { t } = useTranslation();
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const requestComplete = useStore((s) => s.requestComplete);
  const snooze = useStore((s) => s.snooze);
  const select = useStore((s) => s.select);
  const now = new Date();
  const from = useMemo(() => new Date(now.getTime() - 3 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const to = useMemo(() => new Date(now.getTime() + 2 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const occs = useOccurrences(from, to, false);
  if (!toasts.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((tt) => {
        const o = tt.occurrenceKey ? occs.find((x) => x.key === tt.occurrenceKey) : undefined;
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
