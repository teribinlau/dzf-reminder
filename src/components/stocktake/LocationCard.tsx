import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../lib/store';
import type { StockStatus, StocktakePhoto, StocktakeRow } from '../../lib/types';
import { hhmm, isDiff, isMoveNote, markOf, needsProduct, parseCount, productsOf, qtyOff, qtyText, STATUSES, verdictOf, type LocGroup } from '../../lib/stocktake';
import { useStocktakeActions } from '../../lib/useStocktakeData';
import { FileGallery } from '../FileGallery';
import { IconCamera, IconPlus, IconTrash } from '../Icons';

/** 数字输入框：失焦 / 回车时才提交；空 = 清掉 */
function CountInput({
  value,
  onCommit,
  label,
  disabled,
  autoFocus,
  className = '',
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  label: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(value === null ? '' : String(value));
    setBad(false);
  }, [value]);
  const commit = () => {
    const v = parseCount(text);
    if (v === 'bad') {
      setBad(true);
      return;
    }
    setBad(false);
    if (v !== value) onCommit(v);
  };
  return (
    <input
      className={`st-num ${bad ? 'bad' : ''} ${className}`}
      inputMode="numeric"
      pattern="[0-9]*"
      enterKeyHint="done"
      aria-label={label}
      aria-invalid={bad}
      value={text}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/**
 * 一个库位：表上的几行（SKU + 应有）、现场加的货、空 / 半 / 满 / 无 / 异、还能放、实数、备注、照片。
 * 点状态马上记下（离线也先记在本机）；再点一次同一个 = 撤销。
 * 「半」要知道是什么货（移库时合并）：表上没货的，先打开「表上没有的货」记下来。
 */
export const LocationCard = memo(function LocationCard({
  group,
  photos,
  focused,
  closed,
  onAdvance,
}: {
  group: LocGroup;
  photos: StocktakePhoto[];
  focused: boolean;
  closed: boolean;
  /** 点完「空 / 满 / 无」（「半」填完还能放）自动跳到下一个没盘的库位 */
  onAdvance: (loc: string) => void;
}) {
  const { t } = useTranslation();
  const me = useStore((s) => s.me);
  const isAdmin = me?.role === 'admin';
  const data = useStocktakeActions();
  const head = group.head;
  const sysRows = group.rows.filter((r) => !r.added);
  const found = group.rows.filter((r) => r.added);
  const v = verdictOf(group);
  const [qtyMode, setQtyMode] = useState(() => sysRows.some((r) => r.actual !== null));
  const [noteOpen, setNoteOpen] = useState(() => !!head.note);
  const [foundOpen, setFoundOpen] = useState(false);
  const [focusCanAdd, setFocusCanAdd] = useState(false);
  /** 换一下 = 重新挂上「还能放」输入框（让它重新拿到焦点） */
  const [canAddKey, setCanAddKey] = useState(0);
  const [note, setNote] = useState(head.note);
  const [fSku, setFSku] = useState('');
  const [fQty, setFQty] = useState('');
  const [fNote, setFNote] = useState('');
  const [busy, setBusy] = useState(false);
  /** 已经盘过、又不是当前这个的库位收起来（只看结果），点一下展开改 */
  const [expanded, setExpanded] = useState(false);
  const compact = !!head.status && !focused && !expanded && !foundOpen && !(focusCanAdd && head.status === 'half');
  const lacksProduct = needsProduct(group);
  const move = isMoveNote(head.note);
  const fileRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  useEffect(() => setNote(head.note), [head.note]);

  const setStatus = (st: StockStatus) => {
    if (closed) return;
    const next = head.status === st ? null : st;
    data.mark(head, { ...markOf(head), status: next, can_add: next === 'half' ? head.can_add : null });
    if (next === 'half') {
      // 表上没货：先记是什么货（SKU 或箱唛），再填还能放
      if (!productsOf(group).length) {
        setFocusCanAdd(false);
        setFoundOpen(true);
      } else setFocusCanAdd(true);
    } else if (next === 'odd') {
      setExpanded(true);
      setNoteOpen(true);
      window.setTimeout(() => noteRef.current?.focus(), 30);
    } else if (next) {
      setExpanded(false);
      onAdvance(group.loc);
    }
  };

  const commitNote = () => {
    if (note.trim() !== head.note) data.mark(head, { ...markOf(head), note: note.trim() });
  };

  const submitFound = async () => {
    const qty = parseCount(fQty);
    if (qty === 'bad' || (!fSku.trim() && !fNote.trim())) return;
    setBusy(true);
    const ok = await data.addFound(group.loc, fSku, qty, fNote);
    setBusy(false);
    if (ok) {
      setFSku('');
      setFQty('');
      setFNote('');
      setFoundOpen(false);
      if (head.status === 'half') {
        if (head.can_add !== null) {
          setExpanded(false);
          onAdvance(group.loc);
        } else {
          // 货记上了，接着填还能放
          setFocusCanAdd(true);
          setCanAddKey((k) => k + 1);
        }
      }
    }
  };

  const onFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (fileRef.current) fileRef.current.value = '';
    if (!list.length) return;
    setBusy(true);
    await data.addPhotos(group.loc, list);
    setBusy(false);
  };

  const rowLabel = (r: StocktakeRow) => r.sku + (r.tag ? `（${r.tag}）` : '');
  const tier = Number(group.loc.slice(-2));
  const verdictCls = v === 'todo' ? 'todo' : v === 'ok' ? 'ok' : v === 'picked' ? 'picked' : v === 'noSlot' ? 'none' : isDiff(v) ? 'diff' : '';

  return (
    <article
      className={`st-loc ${focused ? 'focus' : ''} ${head.status ? 'done' : ''} ${compact ? 'compact' : ''}`}
      data-loc={group.loc}
      aria-label={group.loc}
      onClick={compact && !closed ? () => setExpanded(true) : undefined}
    >
      <header className="st-loc-head">
        <span className="st-loc-code">{group.loc}</span>
        {Number.isFinite(tier) && <span className={`st-tier t${tier}`}>{t('stock.tier', { n: tier })}</span>}
        {group.extra && (
          <span className="st-badge warn" title={t('stock.extraHint')}>
            {t('stock.extra')}
          </span>
        )}
        <span className="grow" />
        {v !== 'todo' && v !== 'ok' && <span className={`st-badge ${verdictCls}`}>{t(`stock.v.${v}`)}</span>}
        {compact && head.status && <span className={`st-chip ${head.status}`}>{t(`stock.s.${head.status}`)}</span>}
      </header>

      <ul className="st-rows">
        {sysRows.map((r) =>
          r.sku ? (
            <li key={r.id} className={`${qtyOff(r) ? 'off' : ''} ${qtyMode ? 'wide' : ''}`}>
              <span className="st-sku" title={rowLabel(r)}>
                {rowLabel(r)}
              </span>
              <span className="st-wms">{r.wms}</span>
              <span className="st-qty" title={r.lo !== r.hi ? t('stock.rangeHint', { lo: r.lo, out: r.hi - r.lo }) : undefined}>
                {qtyText(r.lo, r.hi)}
              </span>
              {qtyMode && (
                <CountInput
                  value={r.actual}
                  label={t('stock.actualFor', { sku: r.sku })}
                  disabled={closed}
                  onCommit={(n) => data.mark(r, { ...markOf(r), actual: n })}
                  className="st-actual"
                />
              )}
            </li>
          ) : (
            <li key={r.id} className="empty-row">
              <span className="st-sku muted">{t('stock.noStock')}</span>
            </li>
          ),
        )}
        {found.map((r) => (
          <li key={r.id} className={`found ${!closed && !compact && (r.added_by === me?.id || isAdmin) ? 'wide' : ''}`}>
            <span className="st-sku" title={r.note}>
              <IconPlus size={12} /> {r.sku || r.note}
            </span>
            <span className="st-wms">{t('stock.foundTag')}</span>
            <span className="st-qty">{r.actual ?? ''}</span>
            {!closed && !compact && (r.added_by === me?.id || isAdmin) && (
              <button className="icon-btn sm" aria-label={t('stock.deleteFound')} onClick={() => void data.deleteFound(r)}>
                <IconTrash size={13} />
              </button>
            )}
          </li>
        ))}
      </ul>

      {compact ? (
        <div className="st-summary">
          {head.status === 'half' && head.can_add !== null && <span>{t('stock.canAddN', { n: head.can_add })}</span>}
          {lacksProduct && <span className="st-summary-warn">{t('stock.halfNoSku')}</span>}
          {move && <span className="st-move-tag">{t('stock.moveTag')}</span>}
          {head.note && <span className="st-summary-note">{head.note}</span>}
          {photos.length > 0 && (
            <span>
              <IconCamera size={12} /> {photos.length}
            </span>
          )}
          <span className="st-summary-by">
            {head.counted_by_name} · {hhmm(head.counted_at)}
          </span>
          {!closed && <span className="st-summary-edit">{t('stock.tapToEdit')}</span>}
        </div>
      ) : (
        <>
        <div className="st-status" role="group" aria-label={t('stock.statusLabel')}>
          {STATUSES.map((st) => (
            <button
              key={st}
              className={`st-st ${st} ${head.status === st ? 'on' : ''}`}
              aria-pressed={head.status === st}
              disabled={closed}
              onClick={() => setStatus(st)}
            >
              {t(`stock.s.${st}`)}
            </button>
          ))}
        </div>
        {focused && !closed && <p className="st-hint">{t('stock.noneHint')}</p>}

        {head.status === 'half' && (
          <label className="st-canadd">
            <span>{t('stock.canAdd')}</span>
            <CountInput
              key={canAddKey}
              value={head.can_add}
              label={t('stock.canAdd')}
              disabled={closed}
              autoFocus={focusCanAdd}
              onCommit={(n) => {
                setFocusCanAdd(false);
                data.mark(head, { ...markOf(head), can_add: n });
                // 还不知道是什么货：先别跳走，等货记上
                if (n !== null && !lacksProduct) {
                  setExpanded(false);
                  onAdvance(group.loc);
                }
              }}
            />
            <span>{t('stock.pcs')}</span>
          </label>
        )}
        {lacksProduct && !closed && <p className="st-loc-warn">{t('stock.halfNeedSku')}</p>}

        {!closed && (
          <div className="st-acts">
            {sysRows.some((r) => r.sku) && (
              <button className={`mini-btn ${qtyMode ? 'on' : ''}`} onClick={() => setQtyMode((x) => !x)}>
                {t('stock.qtyWrong')}
              </button>
            )}
            <button className={`mini-btn ${foundOpen ? 'on' : ''}`} onClick={() => setFoundOpen((x) => !x)}>
              {t('stock.addFound')}
            </button>
            <button className={`mini-btn ${noteOpen ? 'on' : ''}`} onClick={() => setNoteOpen((x) => !x)}>
              {t('stock.note')}
            </button>
            <button className="mini-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
              <IconCamera size={13} />
              {t('stock.photo')}
            </button>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
          </div>
        )}

        {(noteOpen || (closed && head.note)) && (
          <input
            ref={noteRef}
            className="input st-note"
            placeholder={t('stock.notePh')}
            aria-label={t('stock.note')}
            value={note}
            maxLength={500}
            disabled={closed}
            enterKeyHint="done"
            onChange={(e) => setNote(e.target.value)}
            onBlur={commitNote}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        )}

        {foundOpen && !closed && (
          <div className="st-found-form">
            <input className="input" placeholder={t('stock.foundSku')} aria-label={t('stock.foundSku')} value={fSku} onChange={(e) => setFSku(e.target.value)} autoFocus />
            <input
              className="input st-found-qty"
              inputMode="numeric"
              placeholder={t('stock.foundQty')}
              aria-label={t('stock.foundQty')}
              value={fQty}
              onChange={(e) => setFQty(e.target.value)}
            />
            <input className="input" placeholder={t('stock.foundNote')} aria-label={t('stock.foundNote')} value={fNote} onChange={(e) => setFNote(e.target.value)} />
            <button className="btn primary sm" disabled={busy || parseCount(fQty) === 'bad' || (!fSku.trim() && !fNote.trim())} onClick={() => void submitFound()}>
              {t('stock.foundAdd')}
            </button>
          </div>
        )}

        {photos.length > 0 && (
          <FileGallery
            bucket="stocktakes"
            items={photos.map((p) => ({ id: p.id, file_path: p.file_path, file_name: p.file_name, size: p.size, mime: p.mime, meta: `${p.uploaded_by_name} ${hhmm(p.created_at)}` }))}
            canDelete={(it) => !closed && (isAdmin || photos.find((p) => p.id === it.id)?.uploaded_by === me?.id)}
            onDelete={(it) => {
              const p = photos.find((x) => x.id === it.id);
              if (p) void data.removePhoto(p);
            }}
          />
        )}
        </>
      )}

      {head.counted_at && !compact && (
        <footer className="st-by">
          {head.counted_by_name} · {hhmm(head.counted_at)}
        </footer>
      )}
    </article>
  );
}, sameCard);

/** 只有这个库位的行 / 照片换了（或者高亮、结束状态变了）才重画 */
function sameCard(
  a: { group: LocGroup; photos: StocktakePhoto[]; focused: boolean; closed: boolean; onAdvance: (loc: string) => void },
  b: { group: LocGroup; photos: StocktakePhoto[]; focused: boolean; closed: boolean; onAdvance: (loc: string) => void },
): boolean {
  if (a.focused !== b.focused || a.closed !== b.closed || a.onAdvance !== b.onAdvance) return false;
  if (a.group.rows.length !== b.group.rows.length || a.photos.length !== b.photos.length) return false;
  return a.group.rows.every((r, i) => r === b.group.rows[i]) && a.photos.every((p, i) => p === b.photos[i]);
}
