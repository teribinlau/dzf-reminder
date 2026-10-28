import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { SKU_ORIGIN, asSkuMessage, skuLang, skuUrl, type SkuPage } from '../lib/warehouse';
import { openExternal } from '../lib/tauri';
import { IconExternal, IconRefresh } from '../components/Icons';

const PAGES: SkuPage[] = ['lookup', '3d'];

/**
 * 仓库：SKU 查询 / 3D 仓库两个页签，内容是 sku-kuwei 网站（框里打开，用 app 的登录免口令）。
 * 第一次打开后一直留着（切到别的页面只是藏起来），回来时不用重新加载数据；3D 页第一次点到才加载。
 */
export function WarehouseView({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation();
  const repo = useStore((s) => s.repo);
  const lang = skuLang(i18n.language);
  const [tab, setTab] = useState<SkuPage>('lookup');
  const [mounted, setMounted] = useState<Record<SkuPage, boolean>>({ lookup: true, '3d': false });
  const [gen, setGen] = useState<Record<SkuPage, number>>({ lookup: 0, '3d': 0 });
  const [initQ, setInitQ] = useState<Record<SkuPage, string>>({ lookup: '', '3d': '' });
  const frames = useRef<Record<SkuPage, HTMLIFrameElement | null>>({ lookup: null, '3d': null });
  /** 发过 ready 的那个框（换了新框 / 框里重新加载就不算了） */
  const readyWin = useRef<Record<SkuPage, Window | null>>({ lookup: null, '3d': null });
  /** 框还没好时要搜的词，等它发 ready 再发过去 */
  const pending = useRef<Record<SkuPage, string>>({ lookup: '', '3d': '' });

  /** 切到某个页签；带 q 就让那个页面去搜它（还没加载的带在地址里，正在加载的等它好了再发） */
  const open = useCallback((page: SkuPage, q = '') => {
    setTab(page);
    const el = frames.current[page];
    if (!el) {
      if (q) setInitQ((x) => ({ ...x, [page]: q }));
      setMounted((m) => (m[page] ? m : { ...m, [page]: true }));
    } else if (q) {
      if (el.contentWindow && readyWin.current[page] === el.contentWindow) el.contentWindow.postMessage({ dzf: 'sku', op: 'goto', q }, SKU_ORIGIN);
      else pending.current[page] = q;
    }
  }, []);

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
        const q = pending.current[page];
        if (q) {
          pending.current[page] = '';
          src.postMessage({ dzf: 'sku', op: 'goto', q }, SKU_ORIGIN);
        }
      } else if (m.op === 'open') open(m.to, m.q);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [repo, open]);

  const reload = () => {
    pending.current[tab] = '';
    setInitQ((x) => ({ ...x, [tab]: '' }));
    setGen((g) => ({ ...g, [tab]: g[tab] + 1 }));
  };

  return (
    <section className="wview" hidden={!active}>
      <div className="wv-head">
        <h1>{t('warehouse.title')}</h1>
        <div className="seg" role="tablist">
          {PAGES.map((p) => (
            <button key={p} role="tab" aria-selected={tab === p} className={tab === p ? 'active' : ''} onClick={() => open(p)}>
              {t(p === '3d' ? 'warehouse.three' : 'warehouse.lookup')}
            </button>
          ))}
        </div>
        <div className="grow" />
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
      </div>
      <div className="wv-body">
        {PAGES.map(
          (p) =>
            mounted[p] && (
              <iframe
                key={`${p}-${gen[p]}-${lang}`}
                ref={(el) => {
                  frames.current[p] = el;
                }}
                className={tab === p ? 'on' : ''}
                src={skuUrl(p, lang, initQ[p])}
                title={t(p === '3d' ? 'warehouse.three' : 'warehouse.lookup')}
                allow="fullscreen"
              />
            ),
        )}
      </div>
    </section>
  );
}
