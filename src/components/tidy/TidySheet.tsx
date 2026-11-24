import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../lib/store';
import { hhmm } from '../../lib/stocktake';
import { addBlocked, isOpen, palletDraft, pctText, scanToLoc, sysName, targetOf, totalQty } from '../../lib/tidy';
import { useTidyCtx } from '../../lib/useTidyData';
import type { TidyProblem, TidyTask } from '../../lib/types';
import { isTauri } from '../../lib/tauri';
import { IconAlert, IconCamera, IconCheck, IconX } from '../Icons';
import { cameraSupported } from '../stocktake/CameraScanner';

const PROBLEMS: Exclude<TidyProblem, ''>[] = ['qty', 'missing', 'full', 'other'];

/**
 * 整理清单里打开的一条（手机上是从下面升上来的面板，电脑上是弹窗）：
 *   - 移库任务（待搬 / 有问题）：从哪拿、拿什么、放到哪 →「已搬到 …」；扫目标库位也算确认；放到了别的库位可以改；
 *     搬不了点原因（数量不对 / 货不在 / 目标放不下 / 别的）→ 这条停下。
 *   - 已搬：等管理员出移库文件、导入；点错了可以撤回。
 *   - 空托盘：搬走了。
 *   - loc（扫到的库位不在清单里）：可以报「这里只有空托盘」。
 * scanned = 面板开着时又扫到的库位（当作目标）。
 */
export function TidySheet({
  task,
  loc,
  scanned,
  onClose,
  onShow3d,
}: {
  task: TidyTask | null;
  loc: string | null;
  scanned: { loc: string; tick: number } | null;
  onClose: () => void;
  onShow3d: (loc: string) => void;
}) {
  const { t } = useTranslation();
  const data = useTidyCtx();
  const me = useStore((s) => s.me);
  const pushToast = useStore((s) => s.pushToast);
  const setNav = useStore((s) => s.setTdNav);
  const isAdmin = me?.role === 'admin';

  const [alt, setAlt] = useState('');
  const [altOpen, setAltOpen] = useState(false);
  const [problem, setProblem] = useState<Exclude<TidyProblem, ''> | null>(null);
  const [note, setNote] = useState('');
  const seenTick = useRef(0);

  const movable = !!task && task.kind === 'move' && (task.status === 'todo' || task.status === 'problem');
  const blocked = data.needSign;

  const done = (title: string) => {
    pushToast({ title, body: '', kind: 'info' });
    onClose();
  };

  /** 放到了哪：空 = 原定目标 */
  const moved = (to = '') => {
    if (!task || blocked) return;
    const dst = to || task.dst;
    if (to && to !== task.dst) {
      // 换了目标：不能放到别的任务要搬走的库位上
      const clash = data.tasks.find((x) => x.id !== task.id && isOpen(x) && x.src === to);
      if (clash) {
        pushToast({ title: t('tidy.err.targetLeaving'), body: to, kind: 'error' });
        return;
      }
    }
    if (data.act(task, to && to !== task.dst ? { action: 'moved', dst: to } : { action: 'moved' })) done(t('tidy.toast.moved', { src: task.src, dst }));
  };

  // 面板开着时扫到了库位：就是原定目标 → 直接算已搬；别的库位 → 填进「放到了别的库位」等确认
  useEffect(() => {
    if (!scanned || scanned.tick === seenTick.current || !task || !movable) return;
    seenTick.current = scanned.tick;
    if (scanned.loc === task.dst) moved();
    else {
      setAlt(scanned.loc);
      setAltOpen(true);
      setProblem(null);
    }
  }, [scanned]); // eslint-disable-line react-hooks/exhaustive-deps

  const altLoc = alt.trim() ? scanToLoc(alt) : null;
  const altBad = !!alt.trim() && (!altLoc || altLoc === task?.src);

  const report = () => {
    if (!task || !problem || blocked) return;
    if (problem === 'other' && !note.trim()) return;
    if (data.act(task, { action: 'problem', problem, note })) done(t('tidy.toast.problem', { src: task.src }));
  };

  const addPallet = () => {
    if (!loc || blocked) return;
    const why = addBlocked(data.tasks, { kind: 'pallet', src: loc, dst: '' });
    if (why) {
      pushToast({ title: t(`tidy.blocked.${why}`), body: loc, kind: 'error' });
      return;
    }
    if (data.add([palletDraft(loc, note)]).added) done(t('tidy.toast.pallet', { src: loc }));
  };

  const src = task?.src ?? loc ?? '';
  const qty = task ? totalQty(task) : 0;
  const canCancel = !!task && (task.status === 'todo' || task.status === 'problem') && (isAdmin || task.created_by === me?.id);

  return (
    <div className="overlay td-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sm td-sheet" role="dialog" aria-modal="true" aria-label={src} data-src={src}>
        <div className="m-head">
          <div>
            <h1 className="td-sheet-title">
              <span className="td-loc">{src}</span>
              {task?.kind === 'move' && (
                <>
                  <span className="td-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="td-loc dst">{targetOf(task)}</span>
                </>
              )}
            </h1>
            <div className="sub">
              {task
                ? [
                    task.kind === 'pallet' ? t('tidy.pallet') : task.same_sku ? t('tidy.sameSkuLong') : t('tidy.mixLong'),
                    task.customer,
                    task.sys && sysName(task.sys),
                    task.kind === 'move' && task.fill != null ? t('tidy.fill', { pct: pctText(task.fill) }) : '',
                    task.kind === 'move' && task.dst_before != null && task.dst_after != null ? t('tidy.dstFill', { before: pctText(task.dst_before), after: pctText(task.dst_after) }) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : t('tidy.notListed')}
            </div>
          </div>
          <div className="grow" />
          <button className="close-round" aria-label={t('actions.close')} onClick={onClose}>
            <IconX size={18} />
          </button>
        </div>

        <div className="m-body">
          {blocked && <div className="st-warn">{t('tidy.signFirst')}</div>}

          {/* 扫到的库位不在清单里：报空托盘 */}
          {!task && loc && (
            <>
              <p className="td-p">{t('tidy.palletAsk')}</p>
              <input className="input" placeholder={t('tidy.notePh')} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} aria-label={t('tidy.notePh')} />
              <button className="btn primary td-big" disabled={blocked} onClick={addPallet} id="td-add-pallet">
                {t('tidy.palletAdd')}
              </button>
              <p className="td-p muted">{t('tidy.palletHint')}</p>
            </>
          )}

          {task && task.kind === 'move' && task.lines.length > 0 && (
            <div className="td-lines">
              <div className="td-lines-head">
                <span>{t('tidy.take')}</span>
                <b>{t('tidy.pcs', { qty })}</b>
              </div>
              <ul>
                {task.lines.map(([sku, n]) => (
                  <li key={sku}>
                    <span className="td-sku">{sku}</span>
                    <b>×{n}</b>
                  </li>
                ))}
              </ul>
              <p className="td-p muted">{t('tidy.takeHint')}</p>
            </div>
          )}

          {task && task.status === 'problem' && (
            <div className="st-warn td-problem">
              <IconAlert size={15} />
              <span>
                {t(`tidy.problem.${task.problem || 'other'}`)}
                {task.note && ` · ${task.note}`}
                {task.acted_at && ` — ${task.acted_by_name || '—'} ${hhmm(task.acted_at)}`}
              </span>
            </div>
          )}

          {/* 移库：还没搬 */}
          {task && movable && (
            <>
              <button className="btn primary td-big" disabled={blocked} onClick={() => moved()} id="td-moved">
                <IconCheck size={16} />
                {t('tidy.movedTo', { dst: task.dst })}
              </button>
              {cameraSupported() && !isTauri() ? (
                <button className="btn soft td-big" disabled={blocked} onClick={() => setNav({ tdCamera: true })} id="td-scan-target">
                  <IconCamera size={16} />
                  {t('tidy.scanTarget')}
                </button>
              ) : (
                <p className="td-p muted">{t('tidy.movedHow')}</p>
              )}

              {altOpen ? (
                <div className="td-alt">
                  <label htmlFor="td-alt-in">{t('tidy.altLabel')}</label>
                  <div className="td-alt-row">
                    <input
                      id="td-alt-in"
                      className={`input ${altBad ? 'bad' : ''}`}
                      placeholder="B2-14-47-01"
                      value={alt}
                      autoCapitalize="characters"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setAlt(e.target.value)}
                    />
                    <button className="btn primary sm" disabled={blocked || !altLoc || altBad} onClick={() => altLoc && moved(altLoc)} id="td-moved-alt">
                      {t('tidy.altGo')}
                    </button>
                  </div>
                  {altBad && <span className="td-p red">{altLoc === task.src ? t('tidy.altIsSrc') : t('tidy.altBad')}</span>}
                  {altLoc && !altBad && altLoc !== task.dst && <span className="td-p muted">{t('tidy.altNote', { dst: task.dst, to: altLoc })}</span>}
                </div>
              ) : (
                <button className="mini-btn" onClick={() => (setAltOpen(true), setProblem(null))} id="td-alt-open">
                  {t('tidy.altOpen')}
                </button>
              )}

              <div className="td-prob">
                <span className="td-prob-lbl">{t('tidy.cannot')}</span>
                <div className="chips">
                  {PROBLEMS.map((p) => (
                    <button key={p} className={`chip ${problem === p ? 'active' : ''}`} aria-pressed={problem === p} onClick={() => setProblem(problem === p ? null : p)} data-problem={p}>
                      {t(`tidy.problem.${p}`)}
                    </button>
                  ))}
                </div>
                {problem && (
                  <>
                    <input
                      className="input"
                      placeholder={t(`tidy.problemPh.${problem}`)}
                      value={note}
                      maxLength={200}
                      onChange={(e) => setNote(e.target.value)}
                      aria-label={t('tidy.notePh')}
                    />
                    <button className="btn soft td-big" disabled={blocked || (problem === 'other' && !note.trim())} onClick={report} id="td-report">
                      {t('tidy.report')}
                    </button>
                    <p className="td-p muted">{t('tidy.reportHint')}</p>
                  </>
                )}
              </div>
            </>
          )}

          {/* 移库：已搬，等出文件 / 导入 */}
          {task && task.kind === 'move' && task.status === 'moved' && (
            <>
              <p className="td-p">
                {t('tidy.movedInfo', { dst: targetOf(task), name: task.acted_by_name || '—', time: task.acted_at ? hhmm(task.acted_at) : '' })}
                {task.moved_to && task.moved_to !== task.dst && ` ${t('tidy.movedElse', { dst: task.dst })}`}
              </p>
              <p className="td-p muted">{task.exported_at ? t('tidy.exportedInfo', { time: hhmm(task.exported_at) }) : t('tidy.waitExport')}</p>
              {isAdmin && (
                <button className="btn primary td-big" disabled={blocked} onClick={() => data.act(task, { action: 'done' }) && done(t('tidy.toast.done', { src: task.src }))} id="td-imported-one">
                  <IconCheck size={16} />
                  {t('tidy.importedOne')}
                </button>
              )}
              {!task.exported_at && (
                <button className="mini-btn" disabled={blocked} onClick={() => data.act(task, { action: 'reopen' }) && done(t('tidy.toast.reopen', { src: task.src }))} id="td-reopen">
                  {t('tidy.reopen')}
                </button>
              )}
            </>
          )}

          {/* 空托盘 */}
          {task && task.kind === 'pallet' && (task.status === 'todo' || task.status === 'problem') && (
            <>
              <p className="td-p">
                {t('tidy.palletInfo', { name: task.created_by_name || '—', time: hhmm(task.created_at) })}
                {task.note && ` · ${task.note}`}
              </p>
              <button className="btn primary td-big" disabled={blocked} onClick={() => data.act(task, { action: 'done' }) && done(t('tidy.toast.palletDone', { src: task.src }))} id="td-pallet-done">
                <IconCheck size={16} />
                {t('tidy.palletDone')}
              </button>
            </>
          )}

          {task && (task.status === 'done' || task.status === 'cancelled') && (
            <p className="td-p">
              {t(`tidy.by.${task.status}`, { name: task.acted_by_name || '—', time: task.acted_at ? hhmm(task.acted_at) : '' })}
              {task.note && ` · ${task.note}`}
            </p>
          )}

          {task && task.status !== 'problem' && task.note && isOpen(task) && task.kind === 'move' && <p className="td-p muted">{task.note}</p>}
        </div>

        <div className="m-foot">
          {task?.kind === 'move' && isOpen(task) && (
            <button className="mini-btn" onClick={() => onShow3d(task.src)} id="td-show3d">
              {t('tidy.show3d')}
            </button>
          )}
          <div className="grow" />
          {canCancel && task && (
            <button
              className="mini-btn danger"
              disabled={blocked}
              onClick={() => {
                if (window.confirm(t('tidy.confirmCancel', { src: task.src })) && data.act(task, { action: 'cancel' })) done(t('tidy.toast.cancelled', { src: task.src }));
              }}
              id="td-cancel"
            >
              {t('tidy.cancelTask')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
