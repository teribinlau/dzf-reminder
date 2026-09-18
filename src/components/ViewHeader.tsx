import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { IconPlus } from './Icons';

export function ViewHeader({ title, sub, dim }: { title: string; sub?: string; dim?: string }) {
  const { t } = useTranslation();
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const openNew = useStore((s) => s.openNew);
  return (
    <div className="main-head">
      <div>
        <div className="title">
          <span>{title}</span>
          {dim && <span className="dim">{dim}</span>}
        </div>
        {sub && <div className="sub">{sub}</div>}
      </div>
      <div className="grow" />
      <div className="seg" role="tablist">
        <button role="tab" className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}>
          {t('views.list')}
        </button>
        <button role="tab" className={view === 'calendar' ? 'active' : ''} onClick={() => setView('calendar')}>
          {t('views.calendar')}
        </button>
      </div>
      <button className="btn primary" onClick={openNew}>
        <IconPlus size={15} />
        {t('actions.new')}
      </button>
    </div>
  );
}
