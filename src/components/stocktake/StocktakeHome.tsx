import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../lib/store';
import { useStocktakeCtx } from '../../lib/useStocktakeData';
import { hhmm } from '../../lib/stocktake';
import type { ParsedSheet } from '../../lib/stocktakeXlsx';
import type { Stocktake } from '../../lib/types';
import { IconChevronR, IconUpload, IconWarehouse, IconX } from '../Icons';
import { StockBuildDialog } from './StockBuildDialog';

function TakeCard({ take, onOpen }: { take: Stocktake; onOpen: () => void }) {
  const { t } = useTranslation();
  const data = useStocktakeCtx();
  const p = data.progress[take.id];
  const pct = p && p.locations ? Math.round((p.counted / p.locations) * 100) : 0;
  return (
    <button className={`st-take ${take.status}`} onClick={onOpen}>
      <span className="st-take-hall">{take.hall}</span>
      <span className="st-take-main">
        <b>{take.title}</b>
        <span className="muted">
          {take.exported_at ? t('stock.exportedAt', { time: hhmm(take.exported_at) }) : ''}
          {take.status === 'closed' && take.closed_at ? ` · ${t('stock.closedAt', { time: hhmm(take.closed_at) })}` : ''}
        </span>
        {p && (
          <span className="st-take-prog">
            <span className="st-bar">
              <i style={{ width: `${pct}%` }} />
            </span>
            {t('stock.progress', { done: p.counted, total: p.locations, pct })}
          </span>
        )}
      </span>
      <IconChevronR size={18} />
    </button>
  );
}

/** 导入前先给管理员看一眼：哪个厅、什么时候导出的、多少行 / 库位 / 通道，有没有要注意的 */
function ImportDialog({ file, sheet, onClose }: { file: File; sheet: ParsedSheet; onClose: () => void }) {
  const { t } = useTranslation();
  const data = useStocktakeCtx();
  const setNav = useStore((s) => s.setStNav);
  const [title, setTitle] = useState(sheet.title);
  const [done, setDone] = useState<number | null>(null);
  const same = data.takes.filter((x) => x.hall === sheet.hall && x.status === 'open');
  const ageH = sheet.exported_at ? (Date.now() - Date.parse(sheet.exported_at)) / 3600000 : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && done === null && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, done]);

  const go = async () => {
    setDone(0);
    const id = await data.importTake({ hall: sheet.hall, title: title.trim() || sheet.title, exported_at: sheet.exported_at }, sheet.rows, setDone);
    setDone(null);
    if (id) {
      onClose();
      setNav({ stTake: id });
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && done === null && onClose()}>
      <div className="modal sm" role="dialog" aria-modal="true" aria-label={t('stock.importTitle')}>
        <div className="m-head">
          <div>
            <h1>{t('stock.importTitle')}</h1>
            <div className="sub">{file.name}</div>
          </div>
          <div className="grow" />
          <button className="close-round" aria-label={t('actions.close')} onClick={onClose} disabled={done !== null}>
            <IconX size={18} />
          </button>
        </div>
        <div className="m-body">
          <div className="field">
            <label htmlFor="st-imp-title">{t('stock.importName')}</label>
            <input id="st-imp-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
          </div>
          <ul className="st-imp-facts">
            <li>
              <span>{t('stock.hall')}</span>
              <b>{sheet.hall}</b>
            </li>
            <li>
              <span>{t('stock.exported')}</span>
              <b>{sheet.exported_at ? hhmm(sheet.exported_at, new Date(0)) : '—'}</b>
            </li>
            <li>
              <span>{t('stock.factLocs')}</span>
              <b>{sheet.locations}</b>
            </li>
            <li>
              <span>{t('stock.factRows')}</span>
              <b>{sheet.rows.length}</b>
            </li>
            <li>
              <span>{t('stock.factAisles')}</span>
              <b>{sheet.aisles}</b>
            </li>
          </ul>
          {ageH !== null && ageH > 12 && <div className="st-warn">{t('stock.warnOld', { hours: Math.round(ageH) })}</div>}
          {same.length > 0 && <div className="st-warn">{t('stock.warnSameHall', { hall: sheet.hall, title: same[0].title })}</div>}
        </div>
        <div className="m-foot">
          <div className="grow">{done !== null ? t('stock.importing', { done, total: sheet.rows.length }) : ''}</div>
          <button className="btn ghost" onClick={onClose} disabled={done !== null}>
            {t('actions.cancel')}
          </button>
          <button className="btn primary" onClick={() => void go()} disabled={done !== null}>
            {t('stock.importGo')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 盘点列表：进行中的、已结束的；管理员可以从库存数据新建，或导入 Claude 做的盘点表 */
export function StocktakeHome() {
  const { t } = useTranslation();
  const data = useStocktakeCtx();
  const me = useStore((s) => s.me);
  const setNav = useStore((s) => s.setStNav);
  const pushToast = useStore((s) => s.pushToast);
  const isAdmin = me?.role === 'admin';
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [picked, setPicked] = useState<{ file: File; sheet: ParsedSheet } | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [building, setBuilding] = useState(false);

  const onFile = async (f: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!f) return;
    setParsing(true);
    try {
      const { readCountSheet } = await import('../../lib/stocktakeXlsx');
      const sheet = await readCountSheet(f);
      setPicked({ file: f, sheet });
    } catch (e) {
      const err = e as { code?: string; detail?: string; message?: string };
      const known = ['notXlsx', 'noAppSheet', 'badFormat', 'noRawSheet', 'missingColumn', 'badRow', 'empty'];
      pushToast({
        title: t('stock.err.parse'),
        body: err.code && known.includes(err.code) ? t(`stock.parse.${err.code}`, { detail: err.detail ?? '' }) : String(err.message ?? e),
        kind: 'error',
      });
    } finally {
      setParsing(false);
    }
  };

  if (!data.ready) return <div className="st-empty">{t('stock.needMigration')}</div>;
  const open = data.takes.filter((x) => x.status === 'open');
  const closed = data.takes.filter((x) => x.status === 'closed');

  return (
    <div className="st-home">
      <div className="st-home-head">
        <div>
          <h2>{t('stock.homeTitle')}</h2>
          <p className="muted">{t('stock.homeSub')}</p>
        </div>
        {isAdmin && (
          <div className="st-home-actions">
            <button className="btn primary sm" onClick={() => setBuilding(true)}>
              <IconWarehouse size={15} />
              {t('stock.fromStock')}
            </button>
            <button className="btn ghost sm" disabled={parsing} onClick={() => fileRef.current?.click()}>
              <IconUpload size={15} />
              {parsing ? t('stock.reading') : t('stock.import')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              hidden
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </div>
        )}
      </div>
      {!data.listLoaded ? (
        <div className="st-empty">{t('stock.loading')}</div>
      ) : (
        <>
          {open.length === 0 && <div className="st-empty">{isAdmin ? t('stock.noneAdmin') : t('stock.none')}</div>}
          {open.map((x) => (
            <TakeCard key={x.id} take={x} onOpen={() => setNav({ stTake: x.id })} />
          ))}
          {closed.length > 0 && (
            <>
              <button className="st-closed-toggle" onClick={() => setShowClosed((v) => !v)} aria-expanded={showClosed}>
                {t('stock.closedN', { count: closed.length })}
              </button>
              {showClosed && closed.map((x) => <TakeCard key={x.id} take={x} onOpen={() => setNav({ stTake: x.id })} />)}
            </>
          )}
        </>
      )}
      {picked && <ImportDialog file={picked.file} sheet={picked.sheet} onClose={() => setPicked(null)} />}
      {building && <StockBuildDialog onClose={() => setBuilding(false)} />}
    </div>
  );
}
