import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../lib/store';
import {
  aisleLabel,
  buildScanIndex,
  findLoc,
  groupLocations,
  hhmm,
  isDiff,
  statsByAisle,
  verdictOf,
  type LocGroup,
  type Stats,
  type Verdict,
} from '../../lib/stocktake';
import { useStocktakeCtx } from '../../lib/useStocktakeData';
import type { StocktakePhoto } from '../../lib/types';
import { isMacDesktop, isTauri } from '../../lib/tauri';
import { SignAs } from '../SignAs';
import { IconArrowL, IconCamera, IconCheck, IconDownload, IconRefresh, IconSearch, IconTrash } from '../Icons';
import { LocationCard } from './LocationCard';
import { CameraScanner, cameraSupported } from './CameraScanner';

/** 虚拟「通道」：所有有差异的库位 */
export const DIFF_AISLE = '*diff';

type Filter = 'all' | 'todo' | 'diff';

function Bar({ s }: { s: Stats }) {
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  return (
    <div className="st-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 打开的一次盘点：扫码 / 输入库位号跳过去；通道列表；一条通道里按走行顺序的库位卡片 */
export function StocktakeSession({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation();
  const data = useStocktakeCtx();
  const me = useStore((s) => s.me);
  const aisle = useStore((s) => s.stAisle);
  const camera = useStore((s) => s.stCamera);
  const setNav = useStore((s) => s.setStNav);
  const pushToast = useStore((s) => s.pushToast);
  const isAdmin = me?.role === 'admin';
  const take = data.take;
  const closed = take?.status === 'closed';

  const [filter, setFilter] = useState<Filter>('all');
  const [focusLoc, setFocusLoc] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [scan, setScan] = useState('');
  const [exporting, setExporting] = useState(false);
  const [canExport, setCanExport] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void isMacDesktop().then((mac) => setCanExport(!mac));
  }, []);

  const groups = useMemo(() => groupLocations(data.rows), [data.rows]);
  const verdicts = useMemo(() => new Map<string, Verdict>(groups.map((g) => [g.loc, verdictOf(g)])), [groups]);
  const index = useMemo(() => buildScanIndex(data.rows), [data.rows]);
  const stats = useMemo(() => statsByAisle(groups), [groups]);
  const photosByLoc = useMemo(() => {
    const m = new Map<string, StocktakePhoto[]>();
    for (const p of data.photos) m.set(p.loc, [...(m.get(p.loc) ?? []), p]);
    return m;
  }, [data.photos]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const indexRef = useRef(index);
  indexRef.current = index;
  const aisleRef = useRef(aisle);
  aisleRef.current = aisle;

  const shown: LocGroup[] = useMemo(() => {
    if (!aisle) return [];
    const base = aisle === DIFF_AISLE ? groups.filter((g) => isDiff(verdicts.get(g.loc)!)) : groups.filter((g) => g.aisle === aisle);
    if (filter === 'todo') return base.filter((g) => !g.head.status || g.loc === focusLoc);
    if (filter === 'diff') return base.filter((g) => isDiff(verdicts.get(g.loc)!) || g.loc === focusLoc);
    return base;
  }, [aisle, groups, verdicts, filter, focusLoc]);

  // 扫到 / 输入的库位：切到那条通道、高亮、滚过去。返回这次盘点里有没有这个库位。
  // quiet = 相机在扫：认不得的码由相机画面自己显示（提示条在相机下面会被盖住）
  const goTo = useCallback(
    (raw: string, quiet = false): boolean => {
      const loc = findLoc(indexRef.current, raw);
      if (!loc) {
        if (!quiet) pushToast({ title: t('stock.scanUnknown'), body: raw.slice(0, 60), kind: 'error' });
        return false;
      }
      const g = groupsRef.current.find((x) => x.loc === loc);
      if (!g) return false;
      if (aisleRef.current !== g.aisle) setNav({ stAisle: g.aisle, stCamera: false });
      else setNav({ stCamera: false });
      setFocusLoc(loc);
      setFocusTick((n) => n + 1);
      return true;
    },
    [setNav, pushToast, t],
  );

  // 点完一个库位：跳到同一条通道里下一个还没盘的
  const onAdvance = useCallback((loc: string) => {
    const list = groupsRef.current;
    const i = list.findIndex((g) => g.loc === loc);
    if (i < 0) return;
    const sameAisle = aisleRef.current === DIFF_AISLE ? null : list[i].aisle;
    const next = list.slice(i + 1).find((g) => (sameAisle ? g.aisle === sameAisle : true) && !g.head.status && g.loc !== loc);
    if (next && (!sameAisle || next.aisle === sameAisle)) {
      setFocusLoc(next.loc);
      setFocusTick((n) => n + 1);
    } else setFocusLoc(null);
  }, []);

  useEffect(() => {
    if (!focusLoc) return;
    const el = listRef.current?.querySelector(`[data-loc="${CSS.escape(focusLoc)}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusLoc, focusTick, aisle]);

  // 扫码枪（蓝牙键盘模式）：没在输入框里时，连续很快敲进来、以回车 / Tab 结尾的一串 = 扫到的码
  useEffect(() => {
    if (!active || !take) return;
    let buf = '';
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const now = performance.now();
      if (now - last > 150) buf = '';
      last = now;
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (buf.length >= 4) {
          e.preventDefault();
          goTo(buf);
        }
        buf = '';
        return;
      }
      if (e.key.length === 1) buf += e.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, take, goTo]);

  const exportResults = async () => {
    if (!take) return;
    setExporting(true);
    try {
      await data.flush();
      const { buildResults, saveBlob } = await import('../../lib/stocktakeXlsx');
      const labels = {
        status: { empty: t('stock.s.empty'), half: t('stock.s.half'), full: t('stock.s.full'), odd: t('stock.s.odd') },
        verdict: Object.fromEntries((['todo', 'ok', 'picked', 'odd', 'sysFull', 'sysEmpty', 'qty', 'found'] as Verdict[]).map((v) => [v, t(`stock.v.${v}`)])) as Record<Verdict, string>,
        header: t('stock.exportHeader', { returnObjects: true }) as string[],
        added: t('stock.foundTag'),
      };
      const blob = await buildResults(take, data.rows, data.photos, labels, (iso) => (iso ? hhmm(iso, new Date(0)) : ''));
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
      saveBlob(blob, `${take.title}_${stamp}.xlsx`);
    } catch (e) {
      pushToast({ title: t('stock.err.export'), body: String((e as Error)?.message ?? e), kind: 'error' });
    } finally {
      setExporting(false);
    }
  };

  if (!take) {
    return (
      <div className="st-empty">
        {data.listLoaded ? t('stock.missing') : t('stock.loading')}
        <button className="btn soft sm" onClick={() => setNav({ stTake: null })}>
          {t('stock.backToList')}
        </button>
      </div>
    );
  }

  const total = stats.total;
  const pct = total.total ? Math.round((total.done / total.total) * 100) : 0;
  const inAisle = aisle ? (aisle === DIFF_AISLE ? null : stats.aisles.find((a) => a.aisle === aisle)?.stats) : null;
  const lang = i18n.language;

  return (
    <div className="st-session">
      <div className="st-top">
        <div className="st-title-row">
          <button
            className="icon-btn"
            aria-label={aisle ? t('stock.allAisles') : t('stock.backToList')}
            onClick={() => setNav(aisle ? { stAisle: null } : { stTake: null })}
          >
            <IconArrowL size={18} />
          </button>
          <div className="st-title">
            {aisle ? (
              <>
                <h2>{aisle === DIFF_AISLE ? t('stock.allDiff') : aisleLabel(aisle, lang)}</h2>
                <div className="st-sub">
                  {inAisle && (
                    <b className="st-count">
                      {inAisle.done}/{inAisle.total}
                    </b>
                  )}
                  <span className="st-sub-title">{take.title}</span>
                </div>
              </>
            ) : (
              <>
                <h2>{take.title}</h2>
                <div className="st-sub">
                  {take.exported_at && t('stock.exportedAt', { time: hhmm(take.exported_at) })}
                  {closed && <span className="st-badge">{t('stock.closed')}</span>}
                </div>
              </>
            )}
          </div>
          <div className="grow" />
          {aisle && (
            <div className="seg sm" role="tablist">
              {(['all', 'todo', 'diff'] as Filter[]).map((f) => (
                <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                  {t(`stock.f.${f}`)}
                </button>
              ))}
            </div>
          )}
          <span className={`st-sync ${data.pending ? 'wait' : ''}`} title={data.pending ? t('stock.pendingHint') : t('stock.synced')}>
            {data.pending ? t('stock.pending', { count: data.pending }) : <IconCheck size={14} />}
          </span>
          {!aisle && (
            <button className="icon-btn" aria-label={t('stock.reload')} title={t('stock.reload')} onClick={() => void data.reloadTake()}>
              <IconRefresh size={16} />
            </button>
          )}
        </div>
        {!aisle && (
          <div className="st-progress">
            <Bar s={total} />
            <span>
              {t('stock.progress', { done: total.done, total: total.total, pct })}
              {total.diff > 0 && ` · ${t('stock.diffN', { count: total.diff })}`}
            </span>
          </div>
        )}
        {!closed && (
          <form
            className="st-scan"
            onSubmit={(e) => {
              e.preventDefault();
              if (scan.trim()) goTo(scan);
              setScan('');
            }}
          >
            <IconSearch size={15} />
            <input
              className="st-scan-input"
              placeholder={t('stock.scanPh')}
              aria-label={t('stock.scanPh')}
              value={scan}
              enterKeyHint="go"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setScan(e.target.value)}
            />
            {cameraSupported() && !isTauri() && (
              <button type="button" className="btn primary sm" onClick={() => setNav({ stCamera: true })}>
                <IconCamera size={15} />
                {t('stock.scan')}
              </button>
            )}
          </form>
        )}
        {me?.is_station && (
          <div className="st-sign">
            <span>{t('stock.signAs')}</span>
            <SignAs value={data.signName} onChange={data.setSignName} />
          </div>
        )}
        {isAdmin && !aisle && (
          <div className="st-admin">
            {canExport && (
              <button className="mini-btn" disabled={exporting} onClick={() => void exportResults()}>
                <IconDownload size={13} />
                {exporting ? t('stock.exporting') : t('stock.export')}
              </button>
            )}
            {closed ? (
              <button className="mini-btn" onClick={() => void data.setTakeStatus(take.id, 'open')}>
                {t('stock.reopen')}
              </button>
            ) : (
              <button
                className="mini-btn"
                onClick={() => {
                  if (window.confirm(t('stock.confirmClose', { title: take.title }))) void data.setTakeStatus(take.id, 'closed');
                }}
              >
                {t('stock.close')}
              </button>
            )}
            <button
              className="mini-btn danger"
              onClick={() => {
                if (window.confirm(t('stock.confirmDelete', { title: take.title }))) void data.deleteTake(take.id);
              }}
            >
              <IconTrash size={13} />
              {t('stock.delete')}
            </button>
          </div>
        )}
      </div>

      {data.loadError && (
        <div className="st-error">
          {t('stock.err.load')}：{data.loadError}
          <button className="btn soft sm" onClick={() => void data.reloadTake()}>
            {t('stock.retry')}
          </button>
        </div>
      )}

      {data.needSign && !closed ? (
        <div className="st-empty">{t('stock.signFirst')}</div>
      ) : !aisle ? (
        <div className="st-aisles" ref={listRef}>
          {data.loading && !groups.length && <div className="st-empty">{t('stock.loading')}</div>}
          {total.diff > 0 && (
            <button className="st-aisle diff" onClick={() => setNav({ stAisle: DIFF_AISLE })}>
              <span className="st-aisle-name">{t('stock.allDiff')}</span>
              <span className="st-aisle-n">{total.diff}</span>
            </button>
          )}
          {stats.aisles.map(({ aisle: a, stats: s }) => (
            <button key={a} className={`st-aisle ${s.done === s.total ? 'complete' : ''}`} onClick={() => setNav({ stAisle: a })}>
              <span className="st-aisle-name">{aisleLabel(a, lang)}</span>
              <span className="st-aisle-n">
                {s.done}/{s.total}
              </span>
              <Bar s={s} />
              <span className="st-aisle-meta">
                {t('stock.aisleMeta', { empty: s.empty, half: s.half, full: s.full })}
                {s.diff > 0 && <b className="red"> · {t('stock.diffN', { count: s.diff })}</b>}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="st-list" ref={listRef}>
            {shown.map((g) => (
              <LocationCard
                key={g.loc}
                group={g}
                photos={photosByLoc.get(g.loc) ?? NO_PHOTOS}
                focused={g.loc === focusLoc}
                closed={closed}
                onAdvance={onAdvance}
              />
            ))}
            {!shown.length && <div className="st-empty">{filter === 'all' ? t('stock.noLocs') : t('stock.nothingHere')}</div>}
            {shown.length > 0 && aisle !== DIFF_AISLE && <div className="st-end">{t('stock.aisleEnd')}</div>}
          </div>
        </>
      )}

      {camera && <CameraScanner onCode={(c) => goTo(c, true)} onClose={() => setNav({ stCamera: false })} />}
    </div>
  );
}

const NO_PHOTOS: StocktakePhoto[] = [];
