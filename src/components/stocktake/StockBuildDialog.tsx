import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../lib/store';
import { useStocktakeCtx } from '../../lib/useStocktakeData';
import { aisleLabel, hhmm } from '../../lib/stocktake';
import { RACK_HALLS } from '../../lib/capacity';
import { buildFromStock, STALE_HOURS, type StockSnapshot, type SystemInfo } from '../../lib/stocktakeBuild';
import { StockFetchError } from '../../lib/repo';
import { IconRefresh, IconX } from '../Icons';

const LAST_HALL = 'dzf-st-build-hall-v1';

function lastHall(): string {
  try {
    const h = localStorage.getItem(LAST_HALL);
    if (h && RACK_HALLS.includes(h)) return h;
  } catch {
    /* 存储不可用 */
  }
  return '4'; // 计划从 4 厅开始盘
}

type Load = { state: 'loading' } | { state: 'ok'; snap: StockSnapshot } | { state: 'error'; err: unknown };

/**
 * 「从库存数据新建」：选厅 →（自动）从 SKU 库位查询取这个厅的库存 → 看各系统同步时间、选通道 → 生成。
 * 生成的盘点和导入 Claude 做的盘点表一样（同一套行），生成后马上打开。
 */
export function StockBuildDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const data = useStocktakeCtx();
  const repo = useStore((s) => s.repo);
  const setNav = useStore((s) => s.setStNav);
  const [hall, setHall] = useState(lastHall);
  const [loads, setLoads] = useState<Record<string, Load>>({});
  const [picked, setPicked] = useState<Record<string, string[] | null>>({}); // 每个厅选的通道；null = 全部
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  // 每个厅取一次（切回来不重取）；「重新取」按钮再取一次
  const fetchHall = useCallback(
    async (h: string) => {
      setLoads((m) => ({ ...m, [h]: { state: 'loading' } }));
      try {
        const snap = await repo.stockSnapshot(h);
        setLoads((m) => ({ ...m, [h]: { state: 'ok', snap } }));
      } catch (err) {
        setLoads((m) => ({ ...m, [h]: { state: 'error', err } }));
      }
    },
    [repo],
  );

  useEffect(() => {
    if (!loads[hall]) void fetchHall(hall);
    try {
      localStorage.setItem(LAST_HALL, hall);
    } catch {
      /* 存储不可用 */
    }
  }, [hall, loads, fetchHall]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && done === null && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, done]);

  const load = loads[hall];
  const snap = load?.state === 'ok' ? load.snap : null;
  const aisles = picked[hall] ?? null;
  const full = useMemo(() => (snap ? buildFromStock(snap) : null), [snap]);
  const res = useMemo(() => (snap ? (aisles ? buildFromStock(snap, { aisles }) : full) : null), [snap, aisles, full]);
  const allAisles = full?.aisles ?? [];
  const isOn = (a: string) => !aisles || aisles.includes(a);

  const lang = i18n.language;
  const defaultTitle = useMemo(() => {
    const base = t('stock.build.titleAll', { hall });
    if (!aisles || !full || aisles.length === full.aisles.length) return base;
    const order = full.aisles.map((x) => x.aisle).filter((a) => aisles.includes(a));
    if (order.length && order.length <= 3) return t('stock.build.titlePick', { base, list: order.map((a) => aisleLabel(a, lang)).join(t('stock.build.listSep')) });
    return t('stock.build.titleSome', { hall, count: order.length });
  }, [t, hall, aisles, full, lang]);
  useEffect(() => {
    if (!titleTouched) setTitle(defaultTitle);
  }, [defaultTitle, titleTouched]);

  const toggleAisle = (a: string) => {
    const all = allAisles.map((x) => x.aisle);
    const cur = aisles ?? all;
    const next = cur.includes(a) ? cur.filter((x) => x !== a) : all.filter((x) => x === a || cur.includes(x));
    setPicked((m) => ({ ...m, [hall]: next.length === all.length ? null : next }));
  };
  const setAll = (on: boolean) => setPicked((m) => ({ ...m, [hall]: on ? null : [] }));

  const stale = (full?.systems ?? []).filter((s) => s.stale);
  const same = data.takes.filter((x) => x.hall === hall && x.status === 'open');
  const rows = res?.sheet.rows ?? [];
  const busy = done !== null;

  const go = async () => {
    if (!res || !rows.length) return;
    setDone(0);
    const id = await data.importTake({ hall, title: title.trim() || defaultTitle, exported_at: res.sheet.exported_at }, rows, setDone);
    setDone(null);
    if (id) {
      onClose();
      setNav({ stTake: id, stAisle: null });
    }
  };

  const ago = (h: number) =>
    h < 1 ? t('stock.build.agoM', { count: Math.max(1, Math.round(h * 60)) }) : h < 48 ? t('stock.build.agoH', { count: Math.round(h) }) : t('stock.build.agoD', { count: Math.round(h / 24) });
  const syncText = (s: SystemInfo) => {
    if (!s.sync) return t('stock.build.noSync');
    if (!s.sync.at) return t('stock.build.baseOnly', { date: s.sync.dt ?? '' });
    return `${hhmm(s.sync.at, new Date(0))} · ${ago(s.ageH ?? 0)}`;
  };

  const errMsg = (err: unknown) => {
    if (err instanceof StockFetchError) {
      if (err.code === 'auth') return t('stock.build.err.auth');
      if (err.code === 'net') return t('stock.build.err.net');
      if (err.detail === 'HTTP 404') return t('stock.build.err.notYet');
      return t('stock.build.err.server', { msg: err.detail });
    }
    return String((err as Error)?.message ?? err);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal st-build" role="dialog" aria-modal="true" aria-label={t('stock.build.title')}>
        <div className="m-head">
          <div>
            <h1>{t('stock.build.title')}</h1>
            <div className="sub">{t('stock.build.sub')}</div>
          </div>
          <div className="grow" />
          <button className="close-round" aria-label={t('actions.close')} onClick={onClose} disabled={busy}>
            <IconX size={18} />
          </button>
        </div>
        <div className="m-body">
          <div className="field">
            <span className="lbl" id="st-build-hall">
              {t('stock.hall')}
            </span>
            <div className="seg st-build-halls" role="radiogroup" aria-labelledby="st-build-hall">
              {RACK_HALLS.map((h) => (
                <button key={h} role="radio" aria-checked={h === hall} className={h === hall ? 'active' : ''} disabled={busy} onClick={() => setHall(h)}>
                  {t('stock.build.hallN', { hall: h })}
                </button>
              ))}
            </div>
          </div>

          {(!load || load.state === 'loading') && <div className="st-build-wait">{t('stock.build.loading', { hall })}</div>}
          {load?.state === 'error' && (
            <div className="st-error st-build-err" role="alert">
              <span className="grow">{errMsg(load.err)}</span>
              <button className="btn sm" onClick={() => void fetchHall(hall)}>
                {t('stock.retry')}
              </button>
            </div>
          )}

          {res && full && (
            <>
              <div className="field">
                <div className="st-build-row">
                  <span className="lbl">{t('stock.build.systems')}</span>
                  <div className="grow" />
                  <button className="btn ghost sm" onClick={() => void fetchHall(hall)} disabled={busy}>
                    <IconRefresh size={14} />
                    {t('stock.build.refetch')}
                  </button>
                </div>
                <ul className="st-build-sys">
                  {full.systems.map((s) => (
                    <li key={s.key} className={`${s.locations ? '' : 'none'} ${s.stale ? 'stale' : ''}`} data-sys={s.key}>
                      <b>
                        {s.wms} <span className="muted">{s.wh}</span>
                      </b>
                      <span className="st-build-when">{syncText(s)}</span>
                      <span className="st-build-n">{s.locations ? t('stock.build.sysLocs', { count: s.locations }) : t('stock.build.sysNone')}</span>
                    </li>
                  ))}
                </ul>
                {snap && !Object.keys(snap.sync).length ? (
                  <div className="st-warn">{t('stock.build.noSyncInfo')}</div>
                ) : (
                  stale.length > 0 && <div className="st-warn">{t('stock.build.stale', { names: stale.map((s) => s.wms).join(t('stock.build.listSep')), hours: STALE_HOURS })}</div>
                )}
              </div>

              <div className="field">
                <div className="st-build-row">
                  <span className="lbl">{t('stock.build.aisles')}</span>
                  <div className="grow" />
                  <button className="btn ghost sm" onClick={() => setAll(true)} disabled={busy || !aisles}>
                    {t('stock.build.all')}
                  </button>
                  <button className="btn ghost sm" onClick={() => setAll(false)} disabled={busy || (aisles !== null && aisles.length === 0)}>
                    {t('stock.build.none')}
                  </button>
                </div>
                <div className="chips st-build-aisles">
                  {allAisles.map((a) => (
                    <button
                      key={a.aisle}
                      className={`chip ${isOn(a.aisle) ? 'active' : ''}`}
                      aria-pressed={isOn(a.aisle)}
                      disabled={busy}
                      onClick={() => toggleAisle(a.aisle)}
                      data-aisle={a.aisle}
                    >
                      {aisleLabel(a.aisle, lang)}
                      <span className="st-build-cnt">{a.locations}</span>
                    </button>
                  ))}
                </div>
              </div>

              <ul className="st-imp-facts">
                <li>
                  <span>{t('stock.factLocs')}</span>
                  <b>{res.sheet.locations}</b>
                </li>
                <li>
                  <span>{t('stock.build.factEmpty')}</span>
                  <b>{res.empty}</b>
                </li>
                <li>
                  <span>{t('stock.build.factExtra')}</span>
                  <b>{res.extra}</b>
                </li>
                <li>
                  <span>{t('stock.factRows')}</span>
                  <b>{rows.length}</b>
                </li>
                <li>
                  <span>{t('stock.build.factTime')}</span>
                  <b>{res.sheet.exported_at ? hhmm(res.sheet.exported_at, new Date(0)) : '—'}</b>
                </li>
              </ul>
              {full.skipped.count > 0 && (
                <div className="st-build-note muted">
                  {t('stock.build.skipped', { count: full.skipped.count, list: full.skipped.examples.join(t('stock.build.listSep')) + (full.skipped.count > full.skipped.examples.length ? '…' : '') })}
                </div>
              )}
              {!rows.length && <div className="st-warn">{t('stock.build.noRows')}</div>}
              {same.length > 0 && <div className="st-warn">{t('stock.build.warnSameHall', { hall, title: same[0].title })}</div>}

              <div className="field">
                <label htmlFor="st-build-title">{t('stock.importName')}</label>
                <input
                  id="st-build-title"
                  className="input"
                  value={title}
                  maxLength={80}
                  disabled={busy}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleTouched(true);
                  }}
                />
              </div>
            </>
          )}
        </div>
        <div className="m-foot">
          <div className="grow">{busy ? t('stock.importing', { done, total: rows.length }) : ''}</div>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            {t('actions.cancel')}
          </button>
          <button className="btn primary" onClick={() => void go()} disabled={busy || !res || !rows.length}>
            {t('stock.build.go')}
          </button>
        </div>
      </div>
    </div>
  );
}
