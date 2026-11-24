import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../lib/store';
import { StockFetchError } from '../../lib/repo';
import { STALE_HOURS, parseShelf, type SourceKey } from '../../lib/stocktakeBuild';
import { sortTidy, targetOf } from '../../lib/tidy';
import { fileStamp, moveXls, planMoves, type MoveIssue, type MovePlan, type SystemFile } from '../../lib/tidyExport';
import { useTidyCtx } from '../../lib/useTidyData';
import { saveFileAndTell } from '../../lib/download';
import type { TidyTask } from '../../lib/types';
import { IconCheck, IconDownload, IconRefresh, IconX } from '../Icons';

type State = { phase: 'loading' } | { phase: 'error'; code: 'auth' | 'net' | 'server'; detail: string } | { phase: 'ready'; plan: MovePlan; n: number };

/**
 * 管理员：已搬的移库任务 → 每个系统一份 WMS「批次库存 › 批量移库位」导入文件（.xls）。
 * 打开时读一次各厅的批次库存（来自「同步库存」），按规则排出每个文件的行，有问题的任务列出来；
 * 下载哪个系统的文件，就把那个文件里的任务记成「出过文件」。导入 WMS 是人工做的，导完回清单点「已导入」。
 */
export function TidyExportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const data = useTidyCtx();
  const repo = useStore((s) => s.repo);
  const pushToast = useStore((s) => s.pushToast);

  const [again, setAgain] = useState(false);
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [saved, setSaved] = useState<SourceKey[]>([]);
  const [busy, setBusy] = useState<SourceKey | null>(null);
  const run = useRef(0);
  const tasksRef = useRef(data.tasks);
  tasksRef.current = data.tasks;

  const moved = useMemo(() => data.tasks.filter((x) => x.kind === 'move' && x.status === 'moved'), [data.tasks]);
  const nExported = moved.filter((x) => x.exported_at).length;

  const load = useCallback(
    async (includeExported: boolean) => {
      const id = ++run.current;
      // 文件里的行按走的顺序排（和清单一样），导入报错时好对照
      const tasks = sortTidy(tasksRef.current.filter((x) => x.kind === 'move' && x.status === 'moved' && (includeExported || !x.exported_at)));
      setSaved([]);
      if (!tasks.length) {
        setState({ phase: 'ready', plan: { files: [], issues: [], skipped: [] }, n: 0 });
        return;
      }
      setState({ phase: 'loading' });
      // 来源所在的厅必须有；目标在别的厅时也取那个厅（查目标库位在系统里的写法）
      const halls = new Set<string>();
      for (const x of tasks) {
        halls.add(x.hall);
        const h = parseShelf(targetOf(x))?.hall;
        if (h) halls.add(h);
      }
      try {
        const snaps = await Promise.all([...halls].sort().map((h) => repo.stockBatches(h)));
        if (run.current !== id) return;
        setState({ phase: 'ready', plan: planMoves(tasks, snaps), n: tasks.length });
      } catch (e) {
        if (run.current !== id) return;
        const err = e instanceof StockFetchError ? e : new StockFetchError('server', String((e as Error)?.message ?? e));
        setState({ phase: 'error', code: err.code, detail: err.detail });
      }
    },
    [repo],
  );

  useEffect(() => {
    void load(again);
  }, [load, again]);

  const download = async (f: SystemFile) => {
    if (busy) return;
    setBusy(f.key);
    try {
      await saveFileAndTell(moveXls(f), t('tidy.x.fileName', { wms: f.wms, stamp: fileStamp() }));
      setSaved((s) => (s.includes(f.key) ? s : [...s, f.key]));
      await data.markExported(f.tasks.map((x) => x.id));
    } catch (e) {
      pushToast({ title: t('stock.err.export'), body: String((e as Error)?.message ?? e), kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const issueText = (i: MoveIssue) => t(`tidy.issue.${i.code}`, { n: i.n ?? 0, was: i.was ?? 0, to: i.to ?? '' });
  const route = (x: TidyTask) => `${x.src} → ${targetOf(x)}`;
  const plan = state.phase === 'ready' ? state.plan : null;
  const skips = plan ? plan.issues.filter((i) => i.skip) : [];
  const warns = plan ? plan.issues.filter((i) => !i.skip) : [];

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal td-export" role="dialog" aria-modal="true" aria-label={t('tidy.x.title')}>
        <div className="m-head">
          <div>
            <h1>{t('tidy.x.title')}</h1>
            <div className="sub">{t('tidy.x.sub')}</div>
          </div>
          <div className="grow" />
          <button className="close-round" aria-label={t('actions.close')} onClick={onClose}>
            <IconX size={18} />
          </button>
        </div>
        <div className="m-body">
          {state.phase === 'loading' && <div className="st-build-wait muted">{t('tidy.x.loading')}</div>}
          {state.phase === 'error' && (
            <div className="st-warn st-build-err" role="alert">
              <span className="grow">
                {t(`stock.build.err.${state.code}`, { msg: state.detail })}
              </span>
              <button className="btn soft sm" onClick={() => void load(again)}>
                <IconRefresh size={14} />
                {t('stock.retry')}
              </button>
            </div>
          )}
          {plan && state.phase === 'ready' && (
            <>
              {state.n === 0 && <div className="st-warn">{nExported ? t('tidy.x.allExported', { count: nExported }) : t('tidy.x.nothing')}</div>}
              {plan.files.map((f) => (
                <div key={f.key} className="td-file" data-sys={f.key}>
                  <div className="td-file-main">
                    <b>
                      {f.wms} <span className="muted">{f.wh}</span>
                    </b>
                    <span>{t('tidy.x.fileFacts', { rows: f.rows.length, qty: f.qty, tasks: f.tasks.length })}</span>
                    <span className={f.stale ? 'red' : 'muted'}>
                      {f.syncDt ? t('tidy.x.syncAt', { time: f.syncDt }) : t('tidy.x.syncUnknown')}
                      {f.stale && ` · ${t('tidy.x.stale', { hours: STALE_HOURS })}`}
                    </span>
                    {!f.batch && <span className="muted">{t('tidy.x.noBatch')}</span>}
                  </div>
                  <button className={`btn ${saved.includes(f.key) ? 'soft' : 'primary'} sm`} disabled={busy !== null} onClick={() => void download(f)} data-download={f.key}>
                    {saved.includes(f.key) ? <IconCheck size={14} /> : <IconDownload size={14} />}
                    {saved.includes(f.key) ? t('tidy.x.again') : t('tidy.x.download')}
                  </button>
                </div>
              ))}
              {skips.length > 0 && (
                <div className="td-issues skip">
                  <h3>{t('tidy.x.skipped', { count: skips.length })}</h3>
                  <ul>
                    {skips.map((i, k) => (
                      <li key={k} data-issue={i.code}>
                        <b>{route(i.task)}</b>
                        <span>{issueText(i)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {warns.length > 0 && (
                <div className="td-issues">
                  <h3>{t('tidy.x.warns', { count: warns.length })}</h3>
                  <ul>
                    {warns.map((i, k) => (
                      <li key={k} data-issue={i.code}>
                        <b>{route(i.task)}</b>
                        <span>{issueText(i)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {plan.files.length > 0 && <p className="td-p muted">{t('tidy.x.how')}</p>}
            </>
          )}
          {nExported > 0 && (
            <label className="td-check">
              <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} />
              {t('tidy.x.includeExported', { count: nExported })}
            </label>
          )}
        </div>
        <div className="m-foot">
          <div className="grow">{moved.length ? t('tidy.x.movedN', { count: moved.length }) : ''}</div>
          <button className="btn ghost" onClick={() => void load(again)} disabled={state.phase === 'loading'}>
            <IconRefresh size={14} />
            {t('tidy.x.recheck')}
          </button>
          <button className="btn primary" onClick={onClose}>
            {t('actions.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
