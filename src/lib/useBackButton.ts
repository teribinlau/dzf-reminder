import { useEffect, useRef } from 'react';
import { useStore } from './store';

/**
 * 安卓（以及浏览器）的返回键：先关掉当前打开的那一层，而不是直接退出应用。
 *
 * 做法：打开一层就往历史里压一条记录，返回键把它弹出来 → popstate → 关掉最上面那层。
 * 用界面上的 × 关掉时，把自己压进去的那条也弹掉，免得历史越积越多。
 */
export function useBackButton(): void {
  const showNew = useStore((s) => s.showNew);
  const pendingComplete = useStore((s) => s.pendingComplete);
  const detailOpen = useStore((s) => s.mobileDetailOpen);

  const layer = showNew ? 'modal' : pendingComplete ? 'picker' : detailOpen ? 'detail' : null;
  const prev = useRef<string | null>(null);
  const fromPop = useRef(false);

  useEffect(() => {
    const onPop = () => {
      const st = useStore.getState();
      if (!st.showNew && !st.pendingComplete && !st.mobileDetailOpen) return;
      fromPop.current = true;
      if (st.showNew) st.closeModal();
      else if (st.pendingComplete) st.cancelPendingComplete();
      else st.select(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (layer === prev.current) return;
    if (fromPop.current) {
      // 这次变化本来就是返回键引起的，历史已经退了一格，不用再动
      fromPop.current = false;
      prev.current = layer;
      return;
    }
    if (layer) {
      window.history.pushState({ dzfLayer: layer }, '');
    } else if (prev.current && (window.history.state as { dzfLayer?: string } | null)?.dzfLayer) {
      window.history.back();
    }
    prev.current = layer;
  }, [layer]);
}
