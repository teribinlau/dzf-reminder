import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { Avatar } from './Avatar';
import { IconBell, IconCalendar, IconList, IconSliders, IconUsers } from './Icons';
import { clockLabel } from '../lib/format';

export function Rail({ overdue }: { overdue: number }) {
  const { t } = useTranslation();
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const setSettingsTab = useStore((s) => s.setSettingsTab);
  const me = useStore((s) => s.me);
  const online = useStore((s) => s.online);
  const fromCache = useStore((s) => s.fromCache);
  const lastSync = useStore((s) => s.lastSync);

  return (
    <nav className="rail" aria-label="main">
      <div className="logo">
        <IconBell size={18} />
      </div>
      <button className={`nav-btn ${view === 'board' ? 'active' : ''}`} aria-label={t('nav.board')} title={t('nav.board')} onClick={() => setView('board')}>
        <IconList size={18} />
        {overdue > 0 && <span className="badge">{overdue}</span>}
      </button>
      <button className={`nav-btn ${view === 'calendar' ? 'active' : ''}`} aria-label={t('nav.calendar')} title={t('nav.calendar')} onClick={() => setView('calendar')}>
        <IconCalendar size={18} />
      </button>
      {me?.role === 'admin' && (
        <button
          className={`nav-btn ${view === 'settings' && useStore.getState().settingsTab === 'accounts' ? 'active' : ''}`}
          aria-label={t('nav.teams')}
          title={t('nav.teams')}
          onClick={() => {
            setSettingsTab('accounts');
            setView('settings');
          }}
        >
          <IconUsers size={18} />
        </button>
      )}
      <button
        className={`nav-btn ${view === 'settings' ? 'active' : ''}`}
        aria-label={t('nav.settings')}
        title={t('nav.settings')}
        onClick={() => {
          setSettingsTab('general');
          setView('settings');
        }}
      >
        <IconSliders size={18} />
      </button>
      <div className="spacer" />
      <div
        className={`sync ${online && !fromCache ? '' : 'off'}`}
        title={online && !fromCache ? (lastSync ? t('app.syncedAt', { time: clockLabel(lastSync) }) : t('app.synced')) : t('app.offline')}
        aria-label={online && !fromCache ? t('app.synced') : t('app.offline')}
      >
        <span className="dot" style={{ width: 10, height: 10 }} />
      </div>
      {me && (
        <div style={{ marginTop: 6 }} title={me.name}>
          <Avatar p={me} size="lg" />
        </div>
      )}
    </nav>
  );
}
