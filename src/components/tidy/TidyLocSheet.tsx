import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../lib/store';
import { hhmm } from '../../lib/stocktake';
import { STALE_HOURS } from '../../lib/stocktakeBuild';
import { addBlocked, palletDraft, pctText, scanToLoc, sysName } from '../../lib/tidy';
import { TIDY_LIMIT, checkTarget, moveDraft, rackSlotOf, slotInfo, suggestFor, type RackSlot, type TargetCheck, type TidyWhere } from '../../lib/tidySuggest';
import type { RackStockApi } from '../../lib/useRackStock';
import { useTidyCtx } from '../../lib/useTidyData';
import { isTauri } from '../../lib/tauri';
import { IconAlert, IconCamera, IconCheck, IconRefresh, IconX } from '../Icons';
import { cameraSupported } from '../stocktake/CameraScanner';

/** 货多的库位先列这么多种 */
const GOODS_SHOWN = 6;

/**
 * 扫到的库位不在整理清单里（手机上是从下面升上来的面板，电脑上是弹窗）：
 *   - 系统里这个库位有什么货、占多少托（1–4 厅货架的库存，进「整理」页时取好的）；
 *   - 可以并到哪（最多 4 个，规则和 3D 页的「整理」一样）：点一个，或者直接去扫目标库位 →
 *     「加入整理清单」（等会儿搬）或者「已经搬到 …」（一步记成已搬）；也可以自己输目标，不合适的会提醒；
 *   - 这里其实只有空托盘：报上来。
 * scanned = 面板开着时又扫到的库位：这里的货能搬就当作「放到这里」（等确认，不自动提交），不能搬就改看那个库位。
 */
export function TidyLocSheet({
  loc,
  racks,
  scanned,
  onClose,
  onOpenTask,
  onLook,
  onShow3d,
}: {
  loc: string;
  racks: RackStockApi;
  scanned: { loc: string; tick: number } | null;
  onClose: () => void;
  /** 刚加进清单的那条：打开它 */
  onOpenTask: (id: string) => void;
  /** 改看另一个库位（和重新扫一次一样） */
  onLook: (loc: string) => void;
  onShow3d: (loc: string) => void;
}) {
  const { t } = useTranslation();
  const data = useTidyCtx();
  const pushToast = useStore((s) => s.pushToast);
  const setNav = useStore((s) => s.setTdNav);
  const blocked = data.needSign;
  const canCamera = cameraSupported() && !isTauri();

  /** 想放到哪：点的建议 / 扫到的 / 手输的 */
  const [pick, setPick] = useState('');
  const [via, setVia] = useState<'tap' | 'scan' | 'type'>('type');
  const [pickOpen, setPickOpen] = useState(false);
  const [palletOpen, setPalletOpen] = useState(false);
  const [note, setNote] = useState('');
  const [allGoods, setAllGoods] = useState(false);
  const seenTick = useRef(scanned?.tick ?? 0);
  const pickRef = useRef<HTMLDivElement>(null);

  const { model, touch } = racks;
  // 用到库存了：没有或者太旧就在后台取一份
  useEffect(() => {
    touch();
  }, [touch]);

  const isRack = useMemo(() => !!rackSlotOf(loc), [loc]);
  const sug = useMemo(() => (model && isRack ? suggestFor(model, loc, data.tasks) : null), [model, isRack, loc, data.tasks]);
  const slot: RackSlot | null = sug?.slot ?? null;
  const canPick = !!sug?.canPick;

  const cand = pick.trim() ? scanToLoc(pick) : null;
  const chk: TargetCheck | null = useMemo(() => (model && slot && canPick && cand ? checkTarget(model, slot, cand, data.tasks) : null), [model, slot, canPick, cand, data.tasks]);

  // 面板开着时又扫到一个库位
  useEffect(() => {
    if (!scanned || scanned.tick === seenTick.current) return;
    seenTick.current = scanned.tick;
    if (!canPick) {
      onLook(scanned.loc); // 这里的货搬不了（或者还不知道有什么）：那就是想看那个库位
      return;
    }
    setPick(scanned.loc);
    setVia('scan');
    setPickOpen(true);
    setPalletOpen(false);
  }, [scanned]); // eslint-disable-line react-hooks/exhaustive-deps

  // 选了 / 扫到了目标：把下面那一块（放到哪、两个按钮）滚到看得见的地方
  useEffect(() => {
    if (pickOpen && via !== 'type') pickRef.current?.scrollIntoView({ block: 'nearest' });
  }, [pickOpen, via, cand]);

  const done = (title: string) => {
    pushToast({ title, body: '', kind: 'info' });
    onClose();
  };

  /** 加一条「这个库位 → c.loc」；moved = 货已经搬过去了，直接记成已搬 */
  const addMove = (c: TargetCheck, moved: boolean) => {
    if (!slot || blocked || c.block) return;
    const draft = moveDraft(slot, c);
    const why = addBlocked(data.tasks, draft);
    if (why) {
      pushToast({ title: t(`tidy.blocked.${why}`), body: why === 'targetLeaving' ? c.loc : loc, kind: 'error' });
      return;
    }
    const res = data.add([draft]);
    if (!res.added) return;
    if (moved) {
      data.act(res.tasks[0], { action: 'moved' });
      done(t('tidy.toast.moved', { src: loc, dst: c.loc }));
    } else {
      pushToast({ title: t('tidy.toast.added', { src: loc, dst: c.loc }), body: '', kind: 'info' });
      onOpenTask(draft.id);
    }
  };

  const addPallet = () => {
    if (blocked) return;
    const why = addBlocked(data.tasks, { kind: 'pallet', src: loc, dst: '' });
    if (why) {
      pushToast({ title: t(`tidy.blocked.${why}`), body: loc, kind: 'error' });
      return;
    }
    if (data.add([palletDraft(loc, note)]).added) done(t('tidy.toast.pallet', { src: loc }));
  };

  const whereText = (w: TidyWhere, hall: number) => (w === 'far' ? t('tidy.sug.where.far', { hall }) : t(`tidy.sug.where.${w}`));

  // 这个库位的货是哪几个系统的、那几个系统的库存是什么时候同步的
  const info = slot ? slotInfo(slot) : null;
  const systems = slot ? [...new Set(slot.items.map((i) => i.sys))] : [];
  const now = Date.now();
  const syncLines = systems.map((key) => {
    const s = model?.sync[key];
    const ageH = s?.at ? (now - Date.parse(s.at)) / 3600000 : null;
    return { key, time: s?.dt ?? '', stale: ageH === null || ageH > STALE_HOURS };
  });
  const qty = slot ? slot.q : 0;
  const goods = slot ? (allGoods ? slot.items : slot.items.slice(0, GOODS_SHOWN)) : [];
  const showPallet = palletOpen || !slot || !!note;

  const sub = [t('tidy.notListed'), info && info.cuKey !== '?' ? info.cuKey : '', systems.map(sysName).join(' + '), sug?.fill != null ? t('tidy.fill', { pct: pctText(sug.fill) }) : '']
    .filter(Boolean)
    .join(' · ');

  const addBtn = chk && !chk.block && (
    <button key="add" className={`btn ${via === 'scan' ? 'soft' : 'primary'} td-big`} disabled={blocked} onClick={() => addMove(chk, false)} id="td-pick-add">
      {t('tidy.pick.add')}
    </button>
  );
  const movedBtn = chk && !chk.block && (
    <button key="moved" className={`btn ${via === 'scan' ? 'primary' : 'soft'} td-big`} disabled={blocked} onClick={() => addMove(chk, true)} id="td-pick-moved">
      <IconCheck size={16} />
      {t('tidy.pick.moved', { dst: chk.loc })}
    </button>
  );

  return (
    <div className="overlay td-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sm td-sheet td-loc-sheet" role="dialog" aria-modal="true" aria-label={loc} data-src={loc}>
        <div className="m-head">
          <div>
            <h1 className="td-sheet-title">
              <span className="td-loc">{loc}</span>
            </h1>
            <div className="sub">{sub}</div>
          </div>
          <div className="grow" />
          <button className="close-round" aria-label={t('actions.close')} onClick={onClose}>
            <IconX size={18} />
          </button>
        </div>

        <div className="m-body">
          {blocked && <div className="st-warn">{t('tidy.signFirst')}</div>}

          {/* 库存：还没取到 / 取不到 / 不是货架托位 */}
          {!isRack && (
            <p className="td-p muted" id="td-stock-notrack">
              {t('tidy.stock.notRack')}
            </p>
          )}
          {isRack && !model && racks.loading && (
            <p className="td-p muted" id="td-stock-loading">
              {t('tidy.stock.loading')}
            </p>
          )}
          {isRack && !model && !racks.loading && racks.error && (
            <div className="st-warn td-stock-err" id="td-stock-err" data-err={racks.error}>
              <span>{t(`tidy.stock.err.${racks.error}`, { detail: racks.detail })}</span>
              <button className="mini-btn" onClick={racks.refresh} id="td-stock-retry">
                {t('tidy.stock.retry')}
              </button>
            </div>
          )}

          {/* 系统里这个库位的货 */}
          {sug && !slot && (
            <p className="td-p" id="td-stock-empty">
              {t('tidy.stock.empty')}
            </p>
          )}
          {slot && (
            <div className="td-lines" id="td-goods">
              <div className="td-lines-head">
                <span>{t('tidy.stock.here')}</span>
                <b>{t('tidy.pcs', { qty })}</b>
              </div>
              <ul>
                {goods.map((it, i) => (
                  <li key={i}>
                    <span className="td-sku">
                      {it.sku}
                      {systems.length > 1 && <span className="td-tag">{sysName(it.sys)}</span>}
                      {it.t && <span className="td-tag bad">{it.t}</span>}
                      {it.o > 0 && <span className="td-tag bad">{t('tidy.stock.out', { n: it.o })}</span>}
                      {it.vol == null && <span className="td-tag">{t('tidy.stock.noDims')}</span>}
                    </span>
                    <b>×{it.q}</b>
                  </li>
                ))}
              </ul>
              {slot.items.length > GOODS_SHOWN && !allGoods && (
                <button className="mini-btn" onClick={() => setAllGoods(true)} id="td-goods-more">
                  {t('tidy.stock.more', { n: slot.items.length - GOODS_SHOWN })}
                </button>
              )}
              {syncLines.map((s) =>
                s.stale ? (
                  <p key={s.key} className="td-p red td-stale" data-sys={s.key}>
                    <IconAlert size={13} />
                    {s.time ? t('tidy.stock.stale', { sys: sysName(s.key), time: s.time, hours: STALE_HOURS }) : t('tidy.stock.noSync', { sys: sysName(s.key) })}
                  </p>
                ) : (
                  <p key={s.key} className="td-p muted td-asof" data-sys={s.key}>
                    {t('tidy.stock.asOf', { sys: sysName(s.key), time: s.time })}
                  </p>
                ),
              )}
            </div>
          )}
          {model && racks.error && !racks.loading && (
            <p className="td-p muted" id="td-stock-old">
              {t('tidy.stock.old', { time: hhmm(new Date(racks.loadedAt).toISOString()) })}
            </p>
          )}

          {/* 可以并到哪 */}
          {sug && slot && sug.why && (
            <p className="td-p" id="td-sug-why" data-why={sug.why}>
              {t(`tidy.sug.why.${sug.why}`)}
            </p>
          )}
          {sug && sug.targets.length > 0 && (
            <div className="td-sug" id="td-sug">
              <div className="td-lines-head">
                <span>{t('tidy.sug.title')}</span>
                <span>{t('tidy.sug.fillHead')}</span>
              </div>
              {sug.targets.map((x) => (
                <button
                  key={x.loc}
                  className={`td-sug-row ${cand === x.loc ? 'active' : ''}`}
                  aria-pressed={cand === x.loc}
                  data-dst={x.loc}
                  onClick={() => {
                    setPick(x.loc);
                    setVia('tap');
                    setPickOpen(true);
                    setPalletOpen(false);
                  }}
                >
                  <span className="td-sug-main">
                    <b className="td-loc dst">{x.loc}</b>
                    {x.same && <span className="td-tag same">{t('tidy.sameSku')}</span>}
                    <span className="td-sug-where">{whereText(x.where, x.hall)}</span>
                  </span>
                  <span className="td-sug-fill">
                    {pctText(x.before)} → <b>{pctText(x.after)}</b>
                  </span>
                </button>
              ))}
              {sug.total > sug.targets.length && <p className="td-p muted">{t('tidy.sug.total', { n: sug.total, shown: sug.targets.length })}</p>}
            </div>
          )}

          {/* 放到哪：点的建议、扫到的、手输的 */}
          {canPick && pickOpen && (
            <div className="td-alt td-pick" id="td-pick" data-via={via} ref={pickRef}>
              <label htmlFor="td-pick-in">{t('tidy.pick.label')}</label>
              <div className="td-alt-row">
                <input
                  id="td-pick-in"
                  className={`input ${pick.trim() && (!cand || chk?.block) ? 'bad' : ''}`}
                  placeholder="B2-14-47-01"
                  value={pick}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setPick(e.target.value);
                    setVia('type');
                  }}
                />
                {canCamera && (
                  <button className="btn soft sm" onClick={() => setNav({ tdCamera: true })} id="td-pick-scan2" aria-label={t('tidy.pick.scan')}>
                    <IconCamera size={15} />
                  </button>
                )}
              </div>
              {pick.trim() && !cand && <span className="td-p red">{t('tidy.altBad')}</span>}
              {chk?.block && (
                <span className="td-p red" id="td-pick-block" data-block={chk.block}>
                  {t(`tidy.pick.block.${chk.block}`)}
                </span>
              )}
              {chk && !chk.block && (
                <>
                  <p className="td-p" id="td-pick-facts">
                    {[
                      chk.same ? t('tidy.sameSku') : '',
                      whereText(chk.where, chk.hall),
                      chk.before != null && chk.after != null ? t('tidy.pick.fill', { before: pctText(chk.before), after: pctText(chk.after) }) : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {chk.warn.map((w) => (
                    <p key={w} className="td-p td-warn" data-warn={w}>
                      <IconAlert size={13} />
                      {t(`tidy.pick.warn.${w}`, { sys: sysName(slot?.items[0]?.sys ?? ''), pct: pctText(TIDY_LIMIT) })}
                    </p>
                  ))}
                  {via === 'scan' ? [movedBtn, addBtn] : [addBtn, movedBtn]}
                </>
              )}
              {via === 'scan' && cand && (
                <button className="mini-btn" onClick={() => onLook(cand)} id="td-pick-look">
                  {t('tidy.pick.look', { dst: cand })}
                </button>
              )}
            </div>
          )}
          {canPick && !pickOpen && (
            <>
              {canCamera ? (
                <button className="btn soft td-big" disabled={blocked} onClick={() => setNav({ tdCamera: true })} id="td-pick-scan">
                  <IconCamera size={16} />
                  {t('tidy.pick.scan')}
                </button>
              ) : (
                <p className="td-p muted">{t('tidy.pick.how')}</p>
              )}
              <button className="mini-btn" onClick={() => setPickOpen(true)} id="td-pick-open">
                {t('tidy.pick.open')}
              </button>
            </>
          )}

          {/* 这里只有空托盘 */}
          {showPallet ? (
            <div className="td-pallet" id="td-pallet">
              <p className="td-p">{t('tidy.palletAsk')}</p>
              <input className="input" placeholder={t('tidy.notePh')} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} aria-label={t('tidy.notePh')} />
              <button className={`btn ${slot ? 'soft' : 'primary'} td-big`} disabled={blocked} onClick={addPallet} id="td-add-pallet">
                {t('tidy.palletAdd')}
              </button>
              <p className="td-p muted">{t('tidy.palletHint')}</p>
            </div>
          ) : (
            <button className="mini-btn" onClick={() => setPalletOpen(true)} id="td-pallet-open">
              {t('tidy.palletOpen')}
            </button>
          )}
        </div>

        <div className="m-foot">
          {isRack && (
            <button className="mini-btn" onClick={() => onShow3d(loc)} id="td-show3d">
              {t('tidy.show3d')}
            </button>
          )}
          <div className="grow" />
          {isRack && (
            <button className="mini-btn" disabled={racks.loading} onClick={racks.refresh} id="td-stock-refresh">
              <IconRefresh size={13} />
              {racks.loading ? t('tidy.stock.loading') : t('tidy.stock.refresh')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
