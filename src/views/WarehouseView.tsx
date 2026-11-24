import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { SKU_ORIGIN, asSkuMessage, skuLang, skuUrl, tidyMessage, type SkuPage } from '../lib/warehouse';
import { TidyCtx, useTidyData } from '../lib/useTidyData';
import { openExternal } from '../lib/tauri';
import { IconExternal, IconRefresh } from '../components/Icons';
import { StocktakeView } from './StocktakeView';
import { TidyView } from '../components/tidy/TidyView';

const PAGES: SkuPage[] = ['lookup', '3d'];

/**
 * 仓库：SKU 查询 / 3D 仓库两个页签，内容是 sku-kuwei 网站（框里打开，用 app 的登录免口令）；
 * 「盘点」「整理」两个页签是应用自己的（库位空位盘点见 StocktakeView，库位整理见 TidyView）。
 * 第一次打开后一直留着（切到别的页面只是藏起来），回来时不用重新加载数据；3D 页第一次点到才加载。
 *
 * 整理清单的数据放在这一层：3D 页的「整理」要知道清单里已经有哪些库位（不再建议），
 * 在 3D 页里点「加入整理」也是发到这里来加。
 */
export function WarehouseView({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation();
  const repo = useStore((s) => s.repo);
  const whTab = useStore((s) => s.whTab);
  const setWhTab = useStore((s) => s.setWhTab);
  const pushToast = useStore((s) => s.pushToast);
  const lang = skuLang(i18n.language);
  const isStock = whTab === 'stocktake';
  const isTidy = whTab === 'tidy';
  const own = isStock || isTidy;
  const tab: SkuPage = whTab === '3d' ? '3d' : 'lookup';
  const [stockSeen, setStockSeen] = useState(isStock);
  if (isStock && !stockSeen) setStockSeen(true);
  const [tidySeen, setTidySeen] = useState(isTidy);
  if (isTidy && !tidySeen) setTidySeen(true);
  const [mounted, setMounted] = useState<Record<SkuPage, boolean>>({ lookup: whTab === 'lookup', '3d': whTab === '3d' });
  const [gen, setGen] = useState<Record<SkuPage, number>>({ lookup: 0, '3d': 0 });
  const [initQ, setInitQ] = useState<Record<SkuPage, string>>({ lookup: '', '3d': '' });
  const [initMode, setInitMode] = useState('');
  const frames = useRef<Record<SkuPage, HTMLIFrameElement | null>>({ lookup: null, '3d': null });
  /** 发过 ready 的那个框（换了新框 / 框里重新加载就不算了） */
  const readyWin = useRef<Record<SkuPage, Window | null>>({ lookup: null, '3d': null });
  /** 框还没好时要搜的词，等它发 ready 再发过去 */
  const pending = useRef<Record<SkuPage, { q: string; mode: string }>>({ lookup: { q: '', mode: '' }, '3d': { q: '', mode: '' } });

  const tidy = useTidyData(active);
  const tidyRef = useRef(tidy);
  tidyRef.current = tidy;

  /** 切到某个页签；带 q 就让那个页面去搜它（还没加载的带在地址里，正在加载的等它好了再发）。mode = 'tidy'：3D 页切到整理模式 */
  const open = useCallback(
    (page: SkuPage, q = '', mode = '') => {
      setWhTab(page);
      const el = frames.current[page];
      if (!el) {
        if (q) setInitQ((x) => ({ ...x, [page]: q }));
        if (mode && page === '3d') setInitMode(mode);
        setMounted((m) => (m[page] ? m : { ...m, [page]: true }));
      } else if (q || mode) {
        if (el.contentWindow && readyWin.current[page] === el.contentWindow) el.contentWindow.postMessage({ dzf: 'sku', op: 'goto', q, mode }, SKU_ORIGIN);
        else pending.current[page] = { q, mode };
      }
    },
    [setWhTab],
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== SKU_ORIGIN || !e.source) return;
      const page = PAGES.find((p) => frames.current[p]?.contentWindow === e.source);
      const m = asSkuMessage(e.data);
      if (!page || !m) return;
      const src = e.source as Window;
      if (m.op === 'hello') {
        // 网页要登录：把当前的访问令牌只交给发消息的这个框（演示模式 / 没登录是 null → 网页改成要口令）
        readyWin.current[page] = null;
        void repo
          .accessToken()
          .catch(() => null)
          .then((token) => src.postMessage({ dzf: 'sku', op: 'token', token }, SKU_ORIGIN));
      } else if (m.op === 'ready') {
        readyWin.current[page] = src;
        // 3D 页：先告诉它整理清单里有什么、能不能加
        if (page === '3d') src.postMessage(tidyMessage(tidyRef.current.tasks, tidyRef.current.canAdd), SKU_ORIGIN);
        const p = pending.current[page];
        if (p.q || p.mode) {
          pending.current[page] = { q: '', mode: '' };
          src.postMessage({ dzf: 'sku', op: 'goto', q: p.q, mode: p.mode }, SKU_ORIGIN);
        }
      } else if (m.op === 'open') open(m.to, m.q);
      else if (m.op === 'tidy-open') setWhTab('tidy');
      else if (m.op === 'tidy-add' && page === '3d') {
        const d = tidyRef.current;
        if (!d.canAdd || !m.tasks.length) {
          // 加不了（没登录 / 表还没建 / 工位账号没选名字）：把现在的清单再发一次，页面上「已加入」的标记会退回去
          src.postMessage(tidyMessage(d.tasks, d.canAdd), SKU_ORIGIN);
          if (m.tasks.length) pushToast({ title: t('tidy.cannotAdd'), body: d.needSign ? t('tidy.signFirst') : '', kind: 'error' });
          return;
        }
        const res = d.add(m.tasks);
        pushToast({
          title: res.added ? t('tidy.added', { count: res.added }) : t('tidy.addedNone'),
          body: res.blocked ? t('tidy.addedBlocked', { count: res.blocked }) : '',
          kind: res.added ? 'info' : 'error',
          action: res.added ? { label: t('tidy.openList'), run: () => setWhTab('tidy') } : undefined,
        });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [repo, open, setWhTab, pushToast, t]);

  // 整理清单变了（自己加的、别人搬的、能不能加变了）：告诉已经加载好的 3D 页
  useEffect(() => {
    const win = frames.current['3d']?.contentWindow;
    if (win && readyWin.current['3d'] === win) win.postMessage(tidyMessage(tidy.tasks, tidy.canAdd), SKU_ORIGIN);
  }, [tidy.tasks, tidy.canAdd]);

  const reload = () => {
    pending.current[tab] = { q: '', mode: '' };
    setInitQ((x) => ({ ...x, [tab]: '' }));
    if (tab === '3d') setInitMode('');
    setGen((g) => ({ ...g, [tab]: g[tab] + 1 }));
  };

  return (
    <section className="wview" hidden={!active}>
      <div className="wv-head">
        <h1>{t('warehouse.title')}</h1>
        <div className="seg" role="tablist">
          {PAGES.map((p) => (
            <button key={p} role="tab" aria-selected={!own && tab === p} className={!own && tab === p ? 'active' : ''} onClick={() => open(p)}>
              {t(p === '3d' ? 'warehouse.three' : 'warehouse.lookup')}
            </button>
          ))}
          <button role="tab" aria-selected={isStock} className={isStock ? 'active' : ''} onClick={() => setWhTab('stocktake')}>
            {t('warehouse.stocktake')}
          </button>
          <button role="tab" aria-selected={isTidy} className={isTidy ? 'active' : ''} onClick={() => setWhTab('tidy')}>
            {t('warehouse.tidy')}
          </button>
        </div>
        <div className="grow" />
        {!own && (
          <>
            <button className="icon-btn" aria-label={t('warehouse.reload')} title={t('warehouse.reload')} onClick={reload}>
              <IconRefresh size={16} />
            </button>
            <button
              className="icon-btn"
              aria-label={t('warehouse.openBrowser')}
              title={t('warehouse.openBrowser')}
              onClick={() => void openExternal(skuUrl(tab, lang, '', false))}
            >
              <IconExternal size={16} />
            </button>
          </>
        )}
      </div>
      <div className="wv-body">
        {stockSeen && (
          <div className={`wv-stock ${isStock ? 'on' : ''}`}>
            <StocktakeView active={active && isStock} />
          </div>
        )}
        {tidySeen && (
          <div className={`wv-stock ${isTidy ? 'on' : ''}`}>
            <TidyCtx.Provider value={tidy}>
              <TidyView active={active && isTidy} onShow3d={(loc) => open('3d', loc, 'tidy')} />
            </TidyCtx.Provider>
          </div>
        )}
        {PAGES.map(
          (p) =>
            mounted[p] && (
              <iframe
                key={`${p}-${gen[p]}-${lang}`}
                ref={(el) => {
                  frames.current[p] = el;
                }}
                className={!own && tab === p ? 'on' : ''}
                src={skuUrl(p, lang, initQ[p], true, p === '3d' ? initMode : '')}
                title={t(p === '3d' ? 'warehouse.three' : 'warehouse.lookup')}
                allow="fullscreen"
              />
            ),
        )}
      </div>
    </section>
  );
}
