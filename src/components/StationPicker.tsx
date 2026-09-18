import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { Avatar } from './Avatar';
import { IconX } from './Icons';

/** 工位模式：点完成时选一下是谁 */
export function StationPicker() {
  const { t } = useTranslation();
  const pending = useStore((s) => s.pendingComplete);
  const me = useStore((s) => s.me);
  const profiles = useStore((s) => s.profiles);
  const complete = useStore((s) => s.complete);
  const cancel = useStore((s) => s.cancelPendingComplete);
  if (!pending || !me) return null;
  const teamMembers = profiles.filter((p) => p.active && !p.is_station && p.team_id === me.team_id);
  const others = profiles.filter((p) => p.active && !p.is_station && p.team_id !== me.team_id);
  const people = [...teamMembers, ...others];
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="modal sm" role="dialog" aria-modal="true">
        <div className="m-head">
          <div className="grow">
            <h1>{t('station.whoDone')}</h1>
            <div className="sub">{t('station.whoDoneHint')}</div>
          </div>
          <button className="close-round" aria-label={t('actions.close')} onClick={cancel}>
            <IconX size={16} />
          </button>
        </div>
        <div className="m-body" style={{ paddingBottom: 24 }}>
          <div className="hint-text" style={{ fontWeight: 700 }}>
            {pending.reminder.title}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
            {people.map((p) => (
              <button key={p.id} className="opt-card" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }} onClick={() => void complete(pending, p.name)}>
                <Avatar p={p} />
                <b>{p.name}</b>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
