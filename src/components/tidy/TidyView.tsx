import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { askConfirm, useStore } from '../../lib/store';
import { aisleLabel, hhmm } from '../../lib/stocktake';
import { countTidy, groupTidy, isOpen, matchScan, pctText, scanToLoc, sysName, targetOf, tidyBatches, totalQty } from '../../lib/tidy';
import { useRackStock } from '../../lib/useRackStock';
import { useTidyCtx } from '../../lib/useTidyData';
import type { TidyTask } from '../../lib/types';
import { isTauri } from '../../lib/tauri';
import { SignAs } from '../SignAs';
import { IconCamera, IconCheck, IconDownload, IconRefresh, IconSearch } from '../Icons';
import { CameraScanner, cameraSupported } from '../stocktake/CameraScanner';
import { TidyCancelDialog } from './TidyCancelDialog';
import { TidyLocSheet } from './TidyLocSheet';
import { TidySheet } from './TidySheet';
import { TidyExportDialog } from './TidyExportDialog';

type Filter = 'todo' | 'moved' | 'closed';
/** 手指操作的设备（手机、平板）：清单空着时先给「扫一个库位」，电脑上先给「去 3D 里挑」 */
const TOUCH = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

/** 清单里的一条 */
function TaskRow({ task, onOpen }: { task: TidyTask; onOpen: (t: TidyTask) => void }) {
  const { t } = useTranslation();
  const qty = totalQty(task);
  const goods = task.lines.length === 1 ? `${task.lines[0][0]} ×${task.lines[0][1]}` : task.lines.length ? t('tidy.skuN', { n: task.lines.length, qty }) : '';
  const meta = [task.customer, task.sys && sysName(task.sys), goods].filter(Boolean).join(' · ');
  const state = task.status === 'problem' ? 'problem' : task.status === 'moved' ? (task.exported_at ? 'exported' : 'moved') : task.status;
  return (
    <button className={`td-row ${state} ${task.kind}`} data-src={task.src} data-status={task.status} onClick={() => onOpen(task)}>
      <span className="td-row-main">
        <span className="td-route">
          <b className="td-loc">{task.src}</b>
          {task.kind === 'move' ? (
            <>
              <span className="td-arrow" aria-hidden="true">
                →
              </span>
              <b className="td-loc dst">{targetOf(task)}</b>
            </>
          ) : (
            <span className="td-tag pallet">{t('tidy.pallet')}</span>
          )}
        </span>
        {meta && <span className="td-meta">{meta}</span>}
        {task.status === 'problem' && (
          <span className="td-meta red">
            {t(`tidy.problem.${task.problem || 'other'}`)}
            {task.note && ` · ${task.note}`}
          </span>
        )}
        {task.status !== 'problem' && task.note && <span className="td-meta">{task.note}</span>}
        {(task.status === 'moved' || task.status === 'done' || task.status === 'cancelled') && task.acted_at && (
          <span className="td-meta">
            {t(`tidy.by.${task.status === 'moved' ? (task.exported_at ? 'exported' : 'moved') : task.status}`, { name: task.acted_by_name || '—', time: hhmm(task.acted_at) })}
          </span>
        )}
      </span>
      <span className="td-row-side">
        {task.kind === 'move' && task.status !== 'done' && task.status !== 'cancelled' && (
          <span className="td-fill">
            {task.fill != null && t('tidy.fill', { pct: pctText(task.fill) })}
            {task.same_sku && <span className="td-tag same">{t('tidy.sameSku')}</span>}
          </span>
        )}
        <span className={`td-state ${state}`}>{t(`tidy.state.${state}`)}</span>
      </span>
    </button>
  );
}

/**
 * 「仓库」→「整理」：整理清单。
 *   - 任务有两个来路：在「3D 仓库」的「整理」里成批挑（占用很少的库位并到别的库位）；
 *     或者现场扫一个库位 → 看里面有什么货、能并到哪 → 加进清单 / 直接搬（TidyLocSheet）。空托盘也是现场扫了报的。
 *   - 手机：扫来源库位 → 打开那一条 → 拿货 → 扫目标库位 = 已搬。
 *   - 加错了一整批：「批量取消」。
 *   - 管理员：已搬的任务按系统生成 WMS 移库文件，导入后点「已导入」。
 */
export function TidyView({ active, onShow3d }: { active: boolean; onShow3d: (loc: string) => void }) {
  const { t, i18n } = useTranslation();
  const data = useTidyCtx();
  const me = useStore((s) => s.me);
  const openKey = useStore((s) => s.tdOpen);
  const camera = useStore((s) => s.tdCamera);
  const exporting = useStore((s) => s.tdExport);
  const bulk = useStore((s) => s.tdBulk);
  const setNav = useStore((s) => s.setTdNav);
  const pushToast = useStore((s) => s.pushToast);
  const isAdmin = me?.role === 'admin';
  const lang = i18n.language;

  const [filter, setFilter] = useState<Filter>('todo');
  const [scan, setScan] = useState('');
  /** 打开着的任务：刚扫到的目标库位（和原定目标不一样时，面板里问「放到这里？」） */
  const [scanned, setScanned] = useState<{ loc: string; tick: number } | null>(null);
  const tasksRef = useRef(data.tasks);
  tasksRef.current = data.tasks;
  // 1–4 厅货架的库存（扫库位看货、给合并建议用）：进这一页就先取好，扫的时候不用等
  const racks = useRackStock(active && data.ready);
  const openRef = useRef(openKey);
  openRef.current = openKey;

  const counts = useMemo(() => countTidy(data.tasks), [data.tasks]);
  const shown = useMemo(() => {
    const list = data.tasks.filter((x) =>
      filter === 'todo' ? x.status === 'todo' || x.status === 'problem' : filter === 'moved' ? x.status === 'moved' : x.status === 'done' || x.status === 'cancelled',
    );
    return groupTidy(list);
  }, [data.tasks, filter]);
  const nClosed = useMemo(() => data.tasks.filter((x) => !isOpen(x)).length, [data.tasks]);
  const anyOpen = nClosed < data.tasks.length;
  const exported = useMemo(() => data.tasks.filter((x) => x.kind === 'move' && x.status === 'moved' && x.exported_at), [data.tasks]);
  /** 我现在能批量取消的有几条（还没搬的移库任务；普通成员只算自己加的） */
  const nCancellable = useMemo(() => tidyBatches(data.tasks, me?.id ?? null, isAdmin).reduce((a, b) => a + b.open.length, 0), [data.tasks, me?.id, isAdmin]);

  const openTask = openKey && !openKey.startsWith('loc:') ? (data.tasks.find((x) => x.id === openKey) ?? null) : null;
  const openLoc = openKey?.startsWith('loc:') ? openKey.slice(4) : null;

  /** 打开一个库位：清单里有它就开那条任务，没有就开「不在清单里」的面板（看货、合并建议、报空托盘） */
  const openByLoc = useCallback(
    (loc: string) => {
      const hit = matchScan(tasksRef.current, loc);
      setScanned(null);
      if (hit.kind === 'free') setNav({ tdOpen: `loc:${loc}`, tdCamera: false });
      else {
        if (hit.kind === 'target') pushToast({ title: t('tidy.scanIsTarget', { src: hit.task.src }), body: '', kind: 'info' });
        setNav({ tdOpen: hit.task.id, tdCamera: false });
      }
    },
    [setNav, pushToast, t],
  );

  // 扫到 / 输入的库位。quiet = 相机在扫：认不得的码由相机画面自己显示。返回认不认得（相机认得就关）。
  const onScan = useCallback(
    (raw: string, quiet = false): boolean => {
      const loc = scanToLoc(raw);
      if (!loc) {
        if (!quiet) pushToast({ title: t('tidy.scanUnknown'), body: raw.slice(0, 60), kind: 'error' });
        return false;
      }
      const cur = openRef.current;
      const curTask = cur && !cur.startsWith('loc:') ? tasksRef.current.find((x) => x.id === cur) : null;
      // 正开着一条还没搬的移库任务：这次扫的是目标库位
      if (curTask && curTask.kind === 'move' && (curTask.status === 'todo' || curTask.status === 'problem') && loc !== curTask.src) {
        setScanned((s) => ({ loc, tick: (s?.tick ?? 0) + 1 }));
        setNav({ tdCamera: false });
        return true;
      }
      // 正开着一个不在清单里的库位：这次扫的交给那个面板（能搬就当目标等确认，不能搬就改看这个库位）
      if (cur?.startsWith('loc:')) {
        if (loc !== cur.slice(4)) setScanned((s) => ({ loc, tick: (s?.tick ?? 0) + 1 }));
        setNav({ tdCamera: false });
        return true;
      }
      openByLoc(loc);
      return true;
    },
    [setNav, pushToast, t, openByLoc],
  );

  // 扫码枪（蓝牙键盘模式）：没在输入框里时，连续很快敲进来、以回车 / Tab 结尾的一串 = 扫到的码
  useEffect(() => {
    if (!active) return;
    let buf = '';
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const st = useStore.getState();
      if (st.tdBulk || st.tdExport) return; // 弹窗开着：扫到的不理（不然会在弹窗底下打开一个面板）
      const now = performance.now();
      if (now - last > 150) buf = '';
      last = now;
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (buf.length >= 4) {
          e.preventDefault();
          onScan(buf);
        }
        buf = '';
        return;
      }
      if (e.key.length === 1) buf += e.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onScan]);

  // 打开的任务被别人删了 / 清单里没有了：关掉面板
  useEffect(() => {
    if (openKey && !openKey.startsWith('loc:') && data.loaded && !openTask) setNav({ tdOpen: null });
  }, [openKey, openTask, data.loaded, setNav]);

  const finishExported = async () => {
    if (!exported.length) return;
    if (!(await askConfirm({ body: t('tidy.confirmImported', { count: exported.length }), ok: t('tidy.markImported') }))) return;
    data.actMany(exported, { action: 'done' });
  };

  if (!data.ready) {
    return (
      <div className="st-view td-view">
        <div className="st-empty">{t('tidy.needMigration')}</div>
      </div>
    );
  }

  const nTodo = counts.todo + counts.problem + counts.pallet;
  const canCamera = cameraSupported() && !isTauri();
  return (
    <div className="st-view td-view">
      <div className="st-top">
        <div className="st-title-row">
          <div className="st-title">
            <h2>{t('tidy.title')}</h2>
            <div className="st-sub">
              {t('tidy.counts', { todo: counts.todo, moved: counts.moved, problem: counts.problem, pallet: counts.pallet })}
            </div>
          </div>
          <div className="grow" />
          <span className={`st-sync ${data.pending ? 'wait' : ''}`} title={data.pending ? t('stock.pendingHint') : t('stock.synced')}>
            {data.pending ? t('stock.pending', { count: data.pending }) : <IconCheck size={14} />}
          </span>
          <button className="icon-btn" aria-label={t('stock.reload')} title={t('stock.reload')} onClick={() => void data.reload().then(() => data.flush())}>
            <IconRefresh size={16} />
          </button>
        </div>
        <form
          className="st-scan"
          onSubmit={(e) => {
            e.preventDefault();
            if (scan.trim()) onScan(scan);
            setScan('');
          }}
        >
          <IconSearch size={15} />
          <input
            className="st-scan-input"
            placeholder={t('tidy.scanPh')}
            aria-label={t('tidy.scanPh')}
            value={scan}
            enterKeyHint="go"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setScan(e.target.value)}
          />
          {canCamera && (
            <button type="button" className="btn primary sm" onClick={() => setNav({ tdCamera: true })}>
              <IconCamera size={15} />
              {t('stock.scan')}
            </button>
          )}
        </form>
        {me?.is_station && (
          <div className="st-sign">
            <span>{t('tidy.signAs')}</span>
            <SignAs value={data.signName} onChange={data.setSignName} />
          </div>
        )}
        <div className="st-admin td-bar">
          <div className="seg sm" role="tablist">
            {(['todo', 'moved', 'closed'] as Filter[]).map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                {t(`tidy.f.${f}`)}
                <span className="td-n">{f === 'todo' ? nTodo : f === 'moved' ? counts.moved : nClosed}</span>
              </button>
            ))}
          </div>
          <div className="grow" />
          {nCancellable > 1 && (
            <button className="mini-btn danger" onClick={() => setNav({ tdBulk: true })} id="td-bulk">
              {t('tidy.bulk.btn')}
            </button>
          )}
          <button className="mini-btn" onClick={() => onShow3d('')}>
            {t('tidy.pickIn3d')}
          </button>
          {isAdmin && (
            <button className="mini-btn on" disabled={!counts.moved} onClick={() => setNav({ tdExport: true })} id="td-export">
              <IconDownload size={13} />
              {t('tidy.exportN', { count: counts.toExport })}
            </button>
          )}
        </div>
      </div>

      {data.loadError && (
        <div className="st-error">
          {t('stock.err.load')}：{data.loadError}
          <button className="btn soft sm" onClick={() => void data.reload()}>
            {t('stock.retry')}
          </button>
        </div>
      )}

      <div className="td-list">
        {data.needSign && <div className="st-warn">{t('tidy.signFirst')}</div>}
        {filter === 'moved' && isAdmin && exported.length > 0 && (
          <div className="td-note">
            <span>{t('tidy.exportedN', { count: exported.length })}</span>
            <button className="mini-btn" onClick={() => void finishExported()} id="td-imported">
              <IconCheck size={13} />
              {t('tidy.markImported')}
            </button>
          </div>
        )}
        {filter === 'moved' && counts.moved > 0 && !isAdmin && <div className="td-note">{t('tidy.movedHint')}</div>}
        {!data.loaded && <div className="st-empty">{t('stock.loading')}</div>}
        {data.loaded &&
          !shown.length &&
          (filter === 'todo' && !anyOpen ? (
            <div className="st-empty td-empty">
              <b>{t('tidy.emptyTitle')}</b>
              <span>{t('tidy.emptyHint')}</span>
              {/* 手机上先扫码（3D 里挑库位在小屏幕上不好操作），电脑上先去 3D 里成批挑 */}
              {canCamera && TOUCH ? (
                <>
                  <button className="btn primary sm" onClick={() => setNav({ tdCamera: true })} id="td-empty-scan">
                    <IconCamera size={15} />
                    {t('tidy.scanOne')}
                  </button>
                  <button className="mini-btn" onClick={() => onShow3d('')}>
                    {t('tidy.pickIn3d')}
                  </button>
                </>
              ) : (
                <button className="btn primary sm" onClick={() => onShow3d('')}>
                  {t('tidy.pickIn3d')}
                </button>
              )}
            </div>
          ) : (
            <div className="st-empty">{t(`tidy.none.${filter}`)}</div>
          ))}
        {shown.map((g) => (
          <section key={g.key} className="td-group">
            <h3>
              {t('tidy.hallN', { hall: g.hall })}
              {g.aisle && ` · ${aisleLabel(g.aisle, lang)}`}
              <span className="td-n">{g.tasks.length}</span>
            </h3>
            {g.tasks.map((x) => (
              <TaskRow key={x.id} task={x} onOpen={(task) => (setScanned(null), setNav({ tdOpen: task.id }))} />
            ))}
          </section>
        ))}
      </div>

      {openTask && (
        <TidySheet
          task={openTask}
          scanned={scanned}
          onClose={() => (setScanned(null), setNav({ tdOpen: null }))}
          onShow3d={(loc) => {
            setNav({ tdOpen: null });
            onShow3d(loc);
          }}
        />
      )}
      {!openTask && openLoc && (
        <TidyLocSheet
          key={openLoc}
          loc={openLoc}
          racks={racks}
          scanned={scanned}
          onClose={() => (setScanned(null), setNav({ tdOpen: null }))}
          onOpenTask={(id) => (setScanned(null), setNav({ tdOpen: id }))}
          onLook={openByLoc}
          onShow3d={(loc) => {
            setNav({ tdOpen: null });
            onShow3d(loc);
          }}
        />
      )}
      {exporting && isAdmin && <TidyExportDialog onClose={() => setNav({ tdExport: false })} />}
      {bulk && <TidyCancelDialog onClose={() => setNav({ tdBulk: false })} />}
      {camera && <CameraScanner onCode={(c) => onScan(c, true)} onClose={() => setNav({ tdCamera: false })} missKey="tidy.camMiss" />}
    </div>
  );
}
