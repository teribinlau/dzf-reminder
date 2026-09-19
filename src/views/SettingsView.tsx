import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type SettingsTab } from '../lib/store';
import { teamName } from '../lib/occurrences';
import { isTauri } from '../lib/tauri';
import { clockLabel } from '../lib/format';
import { Avatar } from '../components/Avatar';
import { IconBell, IconInfo, IconLock, IconMonitor, IconPlus, IconRefresh, IconSliders, IconTrash, IconUsers, IconLogout } from '../components/Icons';
import type { Profile, Team } from '../lib/types';

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.1.0';

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="txt">
        <b>{title}</b>
        {hint && <span>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function SettingsView() {
  const { t } = useTranslation();
  const tab = useStore((s) => s.settingsTab);
  const setTab = useStore((s) => s.setSettingsTab);
  const me = useStore((s) => s.me);
  const isAdmin = me?.role === 'admin';
  const tabs: { key: SettingsTab; label: string; icon: ReactNode; admin?: boolean }[] = [
    { key: 'general', label: t('settings.general'), icon: <IconSliders size={16} /> },
    { key: 'notifications', label: t('settings.notifications'), icon: <IconBell size={16} /> },
    { key: 'accounts', label: t('settings.accounts'), icon: <IconUsers size={16} />, admin: true },
    { key: 'sync', label: t('settings.sync'), icon: <IconRefresh size={16} /> },
    { key: 'about', label: t('settings.about'), icon: <IconInfo size={16} /> },
  ];
  return (
    <section className="main">
      <div className="main-head">
        <div className="title">
          <span>{t('settings.title')}</span>
          <span className="dim">{tabs.find((x) => x.key === tab)?.label}</span>
        </div>
      </div>
      <div className="settings">
        <nav>
          {tabs
            .filter((x) => !x.admin || isAdmin)
            .map((x) => (
              <button key={x.key} className={tab === x.key ? 'active' : ''} onClick={() => setTab(x.key)}>
                {x.icon}
                {x.label}
              </button>
            ))}
        </nav>
        <div className="pane">
          {tab === 'general' && <GeneralPane />}
          {tab === 'notifications' && <NotificationsPane />}
          {tab === 'accounts' && isAdmin && <AccountsPane />}
          {tab === 'sync' && <SyncPane />}
          {tab === 'about' && <AboutPane />}
        </div>
      </div>
    </section>
  );
}

function GeneralPane() {
  const { t } = useTranslation();
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const setMyLang = useStore((s) => s.setMyLang);
  const me = useStore((s) => s.me);
  const adminUpdateProfile = useStore((s) => s.adminUpdateProfile);
  const signOut = useStore((s) => s.signOut);
  const [name, setName] = useState(me?.name ?? '');
  return (
    <>
      <div>
        <h2>{t('settings.general')}</h2>
        <Row title={t('settings.language')} hint={t('settings.languageHint')}>
          <div className="seg">
            <button className={settings.lang === 'zh-CN' ? 'active' : ''} onClick={() => void setMyLang('zh-CN')}>
              简体中文
            </button>
            <button className={settings.lang === 'de-DE' ? 'active' : ''} onClick={() => void setMyLang('de-DE')}>
              Deutsch
            </button>
          </div>
        </Row>
        {me && (
          <Row title={t('settings.changeMyName')} hint={me.email}>
            <input className="input row-input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== me.name && void adminUpdateProfile(me.id, { name: name.trim() })} />
          </Row>
        )}
        {isTauri() && (
          <>
            <Row title={t('settings.autostart')} hint={t('settings.autostartHint')}>
              <Switch on={settings.autostart} onChange={(v) => update({ autostart: v })} label={t('settings.autostart')} />
            </Row>
            <Row title={t('settings.closeToTray')} hint={t('settings.closeToTrayHint')}>
              <Switch on={settings.closeToTray} onChange={(v) => update({ closeToTray: v })} label={t('settings.closeToTray')} />
            </Row>
          </>
        )}
        <Row title={t('settings.timezone')} hint={t('settings.timezoneHint')}>
          <span className="hint-text" style={{ fontWeight: 700, color: 'var(--ink)' }}>
            Europe/Berlin
          </span>
        </Row>
        <div className="set-row" style={{ borderBottom: 0 }}>
          <button className="btn ghost" onClick={() => void signOut()}>
            <IconLogout size={14} />
            {t('actions.signOut')}
          </button>
        </div>
      </div>
    </>
  );
}

function NotificationsPane() {
  const { t } = useTranslation();
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  return (
    <div>
      <h2>{t('settings.notifications')}</h2>
      <Row title={t('settings.systemNotifications')} hint={t('settings.systemNotificationsHint')}>
        <Switch on={settings.systemNotifications} onChange={(v) => update({ systemNotifications: v })} label={t('settings.systemNotifications')} />
      </Row>
      <Row title={t('settings.sound')} hint={t('settings.soundHint')}>
        <Switch on={settings.sound} onChange={(v) => update({ sound: v })} label={t('settings.sound')} />
      </Row>
      {isTauri() && (
        <Row title={t('settings.alertWindow')} hint={t('settings.alertWindowHint')}>
          <Switch on={settings.alertWindow} onChange={(v) => update({ alertWindow: v })} label={t('settings.alertWindow')} />
        </Row>
      )}
      <Row title={t('settings.defaultBefore')} hint={t('settings.defaultBeforeHint')}>
        <div className="chips">
          {[0, 5, 15, 30, 60].map((m) => (
            <button key={m} className={`chip ${settings.defaultRemindBefore === m ? 'active' : ''}`} onClick={() => update({ defaultRemindBefore: m })}>
              {m === 0 ? t('time.onTime') : m === 60 ? t('time.beforeH', { n: 1 }) : t('time.before', { n: m })}
            </button>
          ))}
        </div>
      </Row>
      <Row title={t('settings.dnd')} hint={t('settings.dndHint')}>
        <div className="dnd-row">
          <input type="time" className="input time-input" value={settings.dndFrom} onChange={(e) => update({ dndFrom: e.target.value })} aria-label="from" />
          <span className="hint-text">{t('settings.to')}</span>
          <input type="time" className="input time-input" value={settings.dndTo} onChange={(e) => update({ dndTo: e.target.value })} aria-label="to" />
          <button className={`chip ${settings.dndWeekend ? 'active' : ''}`} onClick={() => update({ dndWeekend: !settings.dndWeekend })}>
            {t('settings.dndWeekend')}
          </button>
          <Switch on={settings.dndEnabled} onChange={(v) => update({ dndEnabled: v })} label={t('settings.dnd')} />
        </div>
      </Row>
      <Row title={t('settings.overdueRepeat')} hint={t('settings.overdueRepeatHint')}>
        <select className="select" value={settings.overdueRepeatMin} onChange={(e) => update({ overdueRepeatMin: Number(e.target.value) })} aria-label={t('settings.overdueRepeat')}>
          {[0, 10, 15, 30, 60].map((m) => (
            <option key={m} value={m}>
              {m === 0 ? '—' : t('settings.every', { n: m })}
            </option>
          ))}
        </select>
      </Row>
    </div>
  );
}

function AccountsPane() {
  const { t } = useTranslation();
  const me = useStore((s) => s.me);
  const teams = useStore((s) => s.teams);
  const profiles = useStore((s) => s.profiles);
  const lang = useStore((s) => s.settings.lang);
  const adminUpdateProfile = useStore((s) => s.adminUpdateProfile);
  const adminUpsertTeam = useStore((s) => s.adminUpsertTeam);
  const adminDeleteTeam = useStore((s) => s.adminDeleteTeam);
  const [editTeam, setEditTeam] = useState<Partial<Team> | null>(null);

  const saveTeam = async () => {
    if (!editTeam || !editTeam.name_zh?.trim()) return;
    await adminUpsertTeam({ ...editTeam, name_zh: editTeam.name_zh.trim(), name_de: (editTeam.name_de ?? editTeam.name_zh).trim(), color: editTeam.color ?? '#0E7C6B' });
    setEditTeam(null);
  };

  return (
    <>
      <div className="callout" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <IconLock size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>{t('settings.inviteHint')}</span>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <h2 style={{ flex: 1, marginBottom: 0 }}>
            {t('settings.teams')} · {teams.length}
          </h2>
          <button className="btn ghost sm" onClick={() => setEditTeam({ name_zh: '', name_de: '', color: '#0E7C6B' })}>
            <IconPlus size={14} />
            {t('actions.newTeam')}
          </button>
        </div>
        {editTeam && (
          <div className="team-card" style={{ marginBottom: 10, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input" style={{ width: 150, height: 36 }} placeholder={t('settings.teamNameZh')} value={editTeam.name_zh ?? ''} onChange={(e) => setEditTeam({ ...editTeam, name_zh: e.target.value })} />
            <input className="input" style={{ width: 150, height: 36 }} placeholder={t('settings.teamNameDe')} value={editTeam.name_de ?? ''} onChange={(e) => setEditTeam({ ...editTeam, name_de: e.target.value })} />
            <input type="color" value={editTeam.color ?? '#0E7C6B'} onChange={(e) => setEditTeam({ ...editTeam, color: e.target.value })} aria-label={t('settings.color')} style={{ width: 44, height: 36, border: 0, background: 'none' }} />
            <button className="btn primary sm" onClick={() => void saveTeam()}>
              {t('actions.save')}
            </button>
            <button className="btn ghost sm" onClick={() => setEditTeam(null)}>
              {t('actions.cancel')}
            </button>
          </div>
        )}
        <div className="team-cards">
          {teams.map((tm) => {
            const members = profiles.filter((p) => p.team_id === tm.id && p.active && !p.is_station);
            return (
              <div key={tm.id} className="team-card">
                <div className="name">
                  <span className="dot" style={{ background: tm.color, width: 10, height: 10 }} />
                  {tm.name_zh}
                  <span className="cnt">{t('settings.membersCount', { n: members.length })}</span>
                </div>
                <div className="de">{tm.name_de}</div>
                <span className="avatars">
                  {members.slice(0, 5).map((p) => (
                    <Avatar key={p.id} p={p} size="sm" />
                  ))}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn ghost sm" onClick={() => setEditTeam(tm)}>
                    {t('actions.edit')}
                  </button>
                  <button
                    className="btn ghost sm"
                    aria-label={t('settings.deleteTeam')}
                    onClick={() => {
                      if (window.confirm(t('settings.confirmDeleteTeam'))) void adminDeleteTeam(tm.id);
                    }}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <h2 style={{ marginBottom: 10 }}>
          {t('settings.members')} · {profiles.length}
        </h2>
        <div className="table" style={{ gridTemplateColumns: 'minmax(150px, 1.2fr) minmax(0, 1.4fr) 150px 150px 120px 60px' }}>
          <div className="th">{t('settings.name')}</div>
          <div className="th">{t('settings.email')}</div>
          <div className="th">{t('form.team')}</div>
          <div className="th">{t('settings.role')}</div>
          <div className="th">{t('settings.status')}</div>
          <div className="th">{t('settings.station')}</div>
          {profiles.map((p) => (
            <MemberRow key={p.id} p={p} me={me} teams={teams} lang={lang} onChange={(patch) => void adminUpdateProfile(p.id, patch)} />
          ))}
        </div>
      </div>
    </>
  );
}

function MemberRow({ p, me, teams, lang, onChange }: { p: Profile; me: Profile | null; teams: Team[]; lang: string; onChange: (patch: Partial<Profile>) => void }) {
  const { t } = useTranslation();
  const isMe = me?.id === p.id;
  return (
    <>
      <div className="td">
        <Avatar p={p} size="sm" />
        <b style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</b>
        {isMe && <span className="hint-text">· {t('settings.you')}</span>}
      </div>
      <div className="td mute" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {p.email}
      </div>
      <div className="td">
        <select className="select" value={p.team_id ?? ''} onChange={(e) => onChange({ team_id: e.target.value || null })} aria-label={t('form.team')}>
          <option value="">{t('form.noTeam')}</option>
          {teams.map((tm) => (
            <option key={tm.id} value={tm.id}>
              {teamName(tm, lang)}
            </option>
          ))}
        </select>
      </div>
      <div className="td">
        <div className="role-seg">
          <button className={p.role === 'member' ? 'active' : ''} disabled={isMe} onClick={() => onChange({ role: 'member' })}>
            {t('settings.member')}
          </button>
          <button className={p.role === 'admin' ? 'active' : ''} disabled={isMe} onClick={() => onChange({ role: 'admin' })}>
            {t('settings.admin')}
          </button>
        </div>
      </div>
      <div className="td">
        {p.active ? (
          <button className="status-ok" onClick={() => !isMe && onChange({ active: false })} title={t('settings.deactivate')} style={{ cursor: isMe ? 'default' : 'pointer' }}>
            <span className="dot" style={{ width: 7, height: 7 }} />
            {t('settings.active')}
          </button>
        ) : (
          <button className="btn primary sm" onClick={() => onChange({ active: true })}>
            {t('settings.activate')}
          </button>
        )}
      </div>
      <div className="td">
        <button className={`switch ${p.is_station ? 'on' : ''}`} role="switch" aria-checked={p.is_station} aria-label={t('station.mode')} title={t('station.modeHint')} onClick={() => onChange({ is_station: !p.is_station })}>
          <i />
        </button>
      </div>
    </>
  );
}

function SyncPane() {
  const { t } = useTranslation();
  const mode = useStore((s) => s.mode);
  const online = useStore((s) => s.online);
  const fromCache = useStore((s) => s.fromCache);
  const lastSync = useStore((s) => s.lastSync);
  const error = useStore((s) => s.error);
  const reload = useStore((s) => s.reload);
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  return (
    <div>
      <h2>{t('settings.sync')}</h2>
      <div className="stat-cards" style={{ marginTop: 10 }}>
        <div className="stat-card">
          <span className="k">{t('settings.server')}</span>
          <span className="v">{mode === 'demo' ? t('settings.demoServer') : url?.replace(/^https?:\/\//, '')}</span>
          <span className="s">Supabase · Frankfurt</span>
        </div>
        <div className="stat-card">
          <span className="k">{t('settings.status')}</span>
          <span className={online && !fromCache ? 'status-ok' : 'status-warn'}>
            <span className="dot" style={{ width: 8, height: 8 }} />
            {online && !fromCache ? t('settings.connected') : t('settings.disconnected')}
          </span>
          <span className="s">
            {t('settings.lastSync')} {lastSync ? clockLabel(lastSync) : '—'}
            {error ? ` · ${error}` : ''}
          </span>
        </div>
        <div className="stat-card">
          <span className="k">{t('settings.cache')}</span>
          <span className="v">IndexedDB</span>
          <span className="s">{t('settings.cacheHint')}</span>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="btn ghost" onClick={() => void reload()}>
          <IconRefresh size={14} />
          {t('settings.sync')}
        </button>
      </div>
    </div>
  );
}

function AboutPane() {
  const { t } = useTranslation();
  const [msg, setMsg] = useState<string | null>(null);
  const updateReady = useStore((s) => s.updateReady);
  const checkUpdate = useStore((s) => s.checkUpdate);
  const applyUpdate = useStore((s) => s.applyUpdate);
  const check = async () => {
    setMsg('…');
    const v = await checkUpdate();
    setMsg(v ? t('settings.updated', { v }) : t('settings.upToDate'));
  };
  return (
    <div>
      <h2>{t('settings.about')}</h2>
      <div className="set-row">
        <div className="txt">
          <b>DZF 提醒 · DZF Erinnerungen</b>
          <span>
            {t('settings.version')} {APP_VERSION} · {isTauri() ? 'Desktop' : 'Web / PWA'}
          </span>
        </div>
        {isTauri() && (
          <button className="btn ghost" onClick={() => void check()}>
            <IconRefresh size={14} />
            {t('settings.checkUpdate')}
          </button>
        )}
      </div>
      {(msg || updateReady) && (
        <div className="set-row" style={{ borderBottom: 0 }}>
          <span className="hint-text">{msg ?? t('settings.updated', { v: updateReady })}</span>
          {updateReady && (
            <button className="btn primary sm" onClick={() => void applyUpdate()}>
              {t('settings.restart')}
            </button>
          )}
        </div>
      )}
      {isTauri() && <span className="hint-text">{t('settings.autoUpdateHint')}</span>}
      <div className="callout" style={{ marginTop: 14, display: 'flex', gap: 10 }}>
        <IconMonitor size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>{t('station.modeHint')}</span>
      </div>
    </div>
  );
}
