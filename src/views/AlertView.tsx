// 置顶小窗（Tauri 单独的 WebviewWindow）：只显示一条提醒和三个按钮，动作通过事件发回主窗口
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { closeAlertWindow, emitAlertAction, listenAlertPayload, type AlertPayload } from '../lib/tauri';
import { IconBell, IconCheck } from '../components/Icons';

export function AlertView() {
  const { t } = useTranslation();
  const [p, setP] = useState<AlertPayload | null>(null);
  useEffect(() => {
    let un: (() => void) | undefined;
    void listenAlertPayload(setP).then((u) => (un = u));
    return () => un?.();
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
      <span className="k" style={{ color: p.teamColor }}>
        {p.teamName}
        {p.priority === 'high' ? ` · ${t('priority.highLabel')}` : ''}
      </span>
      <span className="time">{p.timeLabel}</span>
      <h1>{p.title}</h1>
      {p.body && <p className="hint-text">{p.body}</p>}
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
