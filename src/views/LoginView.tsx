import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { DEMO_USERS } from '../lib/demo';
import { IconBell, IconLogout } from '../components/Icons';

export function LoginView() {
  const { t } = useTranslation();
  const repo = useStore((s) => s.repo);
  const mode = useStore((s) => s.mode);
  const session = useStore((s) => s.session);
  const me = useStore((s) => s.me);
  const loaded = useStore((s) => s.loaded);
  const signOut = useStore((s) => s.signOut);
  const settings = useStore((s) => s.settings);
  const setMyLang = useStore((s) => s.setMyLang);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pending = session && loaded && (!me || !me.active);

  const send = async () => {
    setErr(null);
    setBusy(true);
    try {
      await repo.signInWithEmail(email.trim());
      setSent(email.trim());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="box">
        <div className="brand">
          <span className="logo" style={{ width: 40, height: 40, borderRadius: 'calc(12px * var(--rs))', background: 'var(--primary)', color: 'var(--on-primary)', display: 'grid', placeItems: 'center' }}>
            <IconBell size={20} />
          </span>
          <h1>{pending ? t('login.pendingTitle') : mode === 'demo' ? t('login.demoTitle') : t('login.title')}</h1>
        </div>
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          <button className={settings.lang === 'zh-CN' ? 'active' : ''} onClick={() => void setMyLang('zh-CN')}>
            中文
          </button>
          <button className={settings.lang === 'de-DE' ? 'active' : ''} onClick={() => void setMyLang('de-DE')}>
            Deutsch
          </button>
        </div>

        {pending ? (
          <>
            <p>{t('login.pendingHint', { email: session?.email })}</p>
            <button className="btn outline" onClick={() => void signOut()}>
              <IconLogout size={14} />
              {t('actions.signOut')}
            </button>
          </>
        ) : mode === 'demo' ? (
          <>
            <p>{t('login.demoHint')}</p>
            <button className="btn primary lg block" onClick={() => void repo.signInDemo?.(DEMO_USERS.admin)}>
              {t('login.asAdmin')}
            </button>
            <button className="btn outline lg block" onClick={() => void repo.signInDemo?.(DEMO_USERS.member)}>
              {t('login.asMember')}
            </button>
            <button className="btn ghost lg block" onClick={() => void repo.signInDemo?.(DEMO_USERS.station)}>
              {t('login.asStation')}
            </button>
          </>
        ) : sent ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setErr(null);
              setBusy(true);
              repo
                .verifyEmailCode(sent, code)
                .catch((er: Error) => setErr(er.message))
                .finally(() => setBusy(false));
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <p className="ok">{t('login.sent', { email: sent })}</p>
            <p>{t('login.codeHint')}</p>
            <input className="input big" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} aria-label={t('login.code')} />
            {err && <p style={{ color: 'var(--red-ink)' }}>{err}</p>}
            <button className="btn primary lg block" type="submit" disabled={busy || code.trim().length < 6}>
              {t('login.verify')}
            </button>
            <button className="btn ghost" type="button" onClick={() => { setSent(null); setCode(''); }}>
              {t('login.changeEmail')}
            </button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <p>{t('login.hint')}</p>
            <input className="input big" type="email" required autoFocus placeholder="name@firma.de" value={email} onChange={(e) => setEmail(e.target.value)} aria-label={t('login.email')} />
            {err && <p style={{ color: 'var(--red-ink)' }}>{err}</p>}
            <button className="btn primary lg block" type="submit" disabled={busy || !email.includes('@')}>
              {t('login.send')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
