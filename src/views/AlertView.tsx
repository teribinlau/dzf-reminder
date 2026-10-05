// 置顶小窗（Tauri 单独的 WebviewWindow）：只显示一条提醒和三个按钮，动作通过事件发回主窗口
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { closeAlertWindow, emitAlertAction, listenAlertDismiss, listenAlertPayload, type AlertPayload } from '../lib/tauri';
import { IconBell, IconCheck, IconX } from '../components/Icons';

export function AlertView() {
  const { t } = useTranslation();
  const [p, setP] = useState<AlertPayload | null>(null);
  useEffect(() => {
    let un: (() => void) | undefined;
    let unDismiss: (() => void) | undefined;
    void listenAlertPayload(setP).then((u) => (un = u));
    // 开发时在浏览器里看小窗：window.dispatchEvent(new CustomEvent('dzf-alert-demo', { detail: payload }))（打包后这段会被去掉）
    const demo = (e: Event) => setP((e as CustomEvent<AlertPayload>).detail);
    if (import.meta.env.DEV) window.addEventListener('dzf-alert-demo', demo);
    // 主窗口里已经把这条完成 / 稍后了：小窗自己关掉
    void listenAlertDismiss((key) => {
      setP((cur) => {
        if (cur && cur.key === key) void closeAlertWindow();
        return cur;
      });
    }).then((u) => (unDismiss = u));
    return () => {
      un?.();
      unDismiss?.();
      if (import.meta.env.DEV) window.removeEventListener('dzf-alert-demo', demo);
    };
  }, []);
  // Esc = 先关掉（提醒还在，逾期了照样会再弹）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && void closeAlertWindow();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const act = async (type: 'complete' | 'snooze' | 'open') => {
    if (!p) return;
    await emitAlertAction({ type, key: p.key, reminderId: p.reminderId, occurrenceAt: p.occurrenceAt, minutes: 10 });
    await closeAlertWindow();
  };
  if (!p) {
    return (
      <div className="alert-win">
        <IconBell size={20} />
      </div>
    );
  }
  return (
    <div className="alert-win" style={{ borderTopColor: p.priority === 'high' ? 'var(--red)' : p.teamColor }}>
      <div className="alert-top">
        <span className="k" style={{ color: p.teamColor }}>
          {p.teamName}
          {p.priority === 'high' ? ` · ${t('priority.highLabel')}` : ''}
        </span>
        <button className="icon-btn sm alert-x" aria-label={t('actions.close')} title={t('alert.closeHint')} onClick={() => void closeAlertWindow()}>
          <IconX size={14} />
        </button>
      </div>
      <span className="time">{p.timeLabel}</span>
      <h1>{p.title}</h1>
      {p.body && <p className="hint-text alert-body">{p.body}</p>}
      <div className="acts">
        <button className="btn primary lg" onClick={() => void act('complete')}>
          <IconCheck size={16} />
          {t('alert.done')}
        </button>
        <button className="btn outline lg" onClick={() => void act('snooze')}>
          {t('alert.later')}
        </button>
        <button className="btn ghost lg" onClick={() => void act('open')}>
          {t('alert.open')}
        </button>
      </div>
    </div>
  );
}
