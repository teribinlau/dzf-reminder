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
import { followKey, followUpInput, followUpItems } from '../../lib/stocktakeFollowup';
import { useStocktakeCtx } from '../../lib/useStocktakeData';
import type { StocktakePhoto } from '../../lib/types';
import { isTauri } from '../../lib/tauri';
import { saveFileAndTell } from '../../lib/download';
import { SignAs } from '../SignAs';
import { IconArrowL, IconBell, IconCamera, IconCheck, IconDownload, IconRefresh, IconSearch, IconTrash } from '../Icons';
import { LocationCard } from './LocationCard';
import { CameraScanner, cameraSupported } from './CameraScanner';

/** 导出文件名里的时间：本地时间 20261103-1445 */
function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif' };

/** 照片在压缩包里的名字：序号_库位号_第几张.jpg（按走行顺序、同一库位按拍的先后） */
function photoFileNames(rows: { loc: string; serial: string; seq: number; is_first: boolean; added: boolean }[], photos: StocktakePhoto[]) {
  const head = new Map<string, { serial: string; seq: number }>();
  for (const r of rows) if (r.is_first && !r.added && !head.has(r.loc)) head.set(r.loc, { serial: r.serial, seq: r.seq });
  const sorted = [...photos].sort(
    (a, b) => (head.get(a.loc)?.seq ?? 1e9) - (head.get(b.loc)?.seq ?? 1e9) || a.loc.localeCompare(b.loc) || a.created_at.localeCompare(b.created_at),
  );
  const n = new Map<string, number>();
  const used = new Set<string>();
  return sorted.map((photo) => {
    const i = (n.get(photo.loc) ?? 0) + 1;
    n.set(photo.loc, i);
    const fromName = /\.([a-z0-9]{2,5})$/i.exec(photo.file_name)?.[1]?.toLowerCase();
    const ext = fromName ?? EXT[photo.mime] ?? 'jpg';
    const serial = head.get(photo.loc)?.serial;
    let name = `${serial ? `${serial}_` : ''}${photo.loc}_${i}.${ext}`.replace(/[\\/:*?"<>|]/g, '_');
    while (used.has(name)) name = name.replace(/(\.[^.]+)$/, '_$1');
    used.add(name);
    return { photo, name };
  });
}

/** 虚拟「通道」：所有有差异的库位 */
export const DIFF_AISLE = '*diff';

type Filter = 'all' | 'todo' | 'diff';

/** 这次盘点的汇总：可用空位（只算「空」）、半、满、无、异、挪，要核实的标红 */
function Totals({ s }: { s: Stats }) {
  const { t } = useTranslation();
  const item = (n: number, label: string, cls = '', title?: string) => (
    <span className={`st-tot ${cls}`} title={title}>
      <b>{n}</b>
      {label}
    </span>
  );
  return (
    <div className="st-totals" aria-label={t('stock.tot.label')}>
      {item(s.usable, t('stock.tot.usable') + (s.empty !== s.usable ? t('stock.tot.emptyAll', { n: s.empty }) : ''), 'good', t('stock.tot.usableHint'))}
      {item(s.half, t('stock.tot.half', { n: s.canAdd }))}
      {item(s.full, t('stock.s.full'))}
      {item(s.none, t('stock.s.none'))}
      {item(s.odd, t('stock.s.odd'))}
      {item(s.move, t('stock.tot.move'), '', t('stock.tot.moveHint'))}
      {s.missing > 0 && item(s.missing, t('stock.tot.missing'), 'red', t('stock.tot.missingHint'))}
      {s.noSlotDiff > 0 && item(s.noSlotDiff, t('stock.v.sysNoSlot'), 'red', t('stock.tot.noSlotHint'))}
      {s.halfNoSku > 0 && item(s.halfNoSku, t('stock.halfNoSku'), 'red', t('stock.halfNeedSku'))}
    </div>
  );
}

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
  const repo = useStore((s) => s.repo);
  const reminders = useStore((s) => s.reminders);
  const isAdmin = me?.role === 'admin';
  const take = data.take;
  const closed = take?.status === 'closed';

  const [filter, setFilter] = useState<Filter>('all');
  const [focusLoc, setFocusLoc] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [scan, setScan] = useState('');
  const [exporting, setExporting] = useState(false);
  const [zipping, setZipping] = useState<{ done: number; total: number } | null>(null);
  const [following, setFollowing] = useState(false);
  const [followId, setFollowId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  // 这次盘点在本机建过的核实提醒（还在的话，按钮就是「打开」）
  useEffect(() => {
    if (!take) return;
    try {
      setFollowId(localStorage.getItem(followKey(take.id)));
    } catch {
      setFollowId(null);
    }
  }, [take?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const followItems = useMemo(() => followUpItems(groups), [groups]);
  const followOpen = !!followId && reminders.some((r) => r.id === followId);

  // 管理员：系统有货现场空 / 现场无位置的库位建一条核实提醒，建好打开编辑框改时间和指派
  const createFollowUp = async () => {
    const st = useStore.getState();
    if (!take || !me || !st.session || following) return;
    if (followOpen && followId) {
      st.openEdit(followId);
      return;
    }
    if (!followItems.length) return;
    if (!st.online || !navigator.onLine) {
      pushToast({ title: t('errors.needOnline'), body: '', kind: 'error' });
      return;
    }
    if (!window.confirm(t('stock.follow.confirm', { count: followItems.length }))) return;
    setFollowing(true);
    try {
      await data.flush();
      const input = followUpInput(followItems, me, st.settings, {
        title: t('stock.follow.title', { title: take.title }),
        intro: t('stock.follow.intro', { title: take.title, time: take.exported_at ? hhmm(take.exported_at, new Date(0)) : '—' }),
        sysFull: t('stock.follow.sysFull'),
        sysNoSlot: t('stock.follow.sysNoSlot'),
        more: (n) => t('stock.follow.more', { count: n }),
        outro: t('stock.follow.outro'),
      });
      const id = await st.repo.createReminder(input, st.session.userId);
      try {
        localStorage.setItem(followKey(take.id), id);
      } catch {
        /* 存不了也没关系，只是下次会再问一次 */
      }
      setFollowId(id);
      await st.reload();
      st.openEdit(id);
    } catch (e) {
      pushToast({ title: t('errors.saveFailed'), body: String((e as Error)?.message ?? e), kind: 'error' });
    } finally {
      setFollowing(false);
    }
  };

  const exportResults = async () => {
    if (!take) return;
    setExporting(true);
    try {
      await data.flush();
      const { buildResults } = await import('../../lib/stocktakeXlsx');
      const blob = await buildResults(take, data.rows, data.photos, t, i18n.language, (iso) => (iso ? hhmm(iso, new Date(0)) : ''));
      await saveFileAndTell(blob, `${take.title}_${fileStamp()}.xlsx`);
    } catch (e) {
      pushToast({ title: t('stock.err.export'), body: String((e as Error)?.message ?? e), kind: 'error' });
    } finally {
      setExporting(false);
    }
  };

  // 管理员：这次盘点的照片打成一个压缩包，文件名 = 序号_库位号_第几张（和导出的表格对得上）
  const exportPhotos = async () => {
    if (!take || !data.photos.length || zipping) return;
    const names = photoFileNames(data.rows, data.photos);
    const total = names.length;
    setZipping({ done: 0, total });
    try {
      const [{ default: JSZip }, urls] = await Promise.all([import('jszip'), repo.fileUrls('stocktakes', names.map((x) => x.photo.file_path))]);
      const zip = new JSZip();
      let done = 0;
      let failed = 0;
      let next = 0;
      const worker = async () => {
        while (next < names.length) {
          const x = names[next++];
          try {
            const url = urls[x.photo.file_path];
            if (!url) throw new Error('no url');
            const res = await fetch(url);
            if (!res.ok) throw new Error(String(res.status));
            zip.file(x.name, await res.blob(), { compression: 'STORE' });
          } catch {
            failed += 1;
          }
          done += 1;
          setZipping({ done, total });
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (failed === total) throw new Error(t('stock.err.photos'));
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      await saveFileAndTell(blob, t('stock.photosZipName', { title: take.title, stamp: fileStamp() }));
      if (failed) pushToast({ title: t('stock.err.photos'), body: `${failed} / ${total}`, kind: 'error' });
    } catch (e) {
      pushToast({ title: t('stock.err.photos'), body: String((e as Error)?.message ?? e), kind: 'error' });
    } finally {
      setZipping(null);
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
            <button className="mini-btn" disabled={exporting} onClick={() => void exportResults()}>
              <IconDownload size={13} />
              {exporting ? t('stock.exporting') : t('stock.export')}
            </button>
            {(followOpen || followItems.length > 0) && (
              <button className="mini-btn" disabled={following} title={t('stock.follow.hint')} onClick={() => void createFollowUp()}>
                <IconBell size={13} />
                {followOpen ? t('stock.follow.open') : t('stock.follow.create', { count: followItems.length })}
              </button>
            )}
            {data.photos.length > 0 && (
              <button className="mini-btn" disabled={!!zipping} onClick={() => void exportPhotos()}>
                <IconCamera size={13} />
                {zipping ? t('stock.photosZipping', zipping) : t('stock.photos', { count: data.photos.length })}
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
          {total.done > 0 && <Totals s={total} />}
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
                {t('stock.aisleMeta', { empty: s.empty, half: s.half, full: s.full, none: s.none, odd: s.odd })}
                {s.move > 0 && ` · ${t('stock.aisleMove', { n: s.move })}`}
                {s.diff > 0 && <b className="red"> · {t('stock.diffN', { count: s.diff })}</b>}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="st-list" ref={listRef}>
            {!closed && <p className="st-hint-bar">{t('stock.noneHintLong')}</p>}
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
