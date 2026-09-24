import { useEffect, useRef } from 'react';
import { useStore } from './store';

type Layer = 'detail' | 'picker' | 'modal' | 'viewer';
// 叠放顺序：详情在最下面，看大图在最上面
const RANK: Record<Layer, number> = { detail: 1, picker: 2, modal: 3, viewer: 4 };

/**
 * 安卓（以及浏览器）的返回键：先关掉当前打开的那一层，而不是直接退出应用。
 *
 * 做法：往上叠一层就往历史里压一条记录，返回键把它弹出来 → popstate → 关掉最上面那层。
 * 用界面上的 × 关掉一层时，把它压进去的那条也弹掉（history.back），免得历史越积越多；
 * 这次 back 引起的 popstate 要跳过，不然会把下面那层也关掉。
 */
export function useBackButton(): void {
  const showNew = useStore((s) => s.showNew);
  const pendingComplete = useStore((s) => s.pendingComplete);
  const detailOpen = useStore((s) => s.mobileDetailOpen);
  const viewer = useStore((s) => s.viewer);

  const layer: Layer | null = viewer ? 'viewer' : showNew ? 'modal' : pendingComplete ? 'picker' : detailOpen ? 'detail' : null;
  const prev = useRef<Layer | null>(null);
  const fromPop = useRef(false);
  const skipPop = useRef(0);

  useEffect(() => {
    const onPop = () => {
      if (skipPop.current > 0) {
        skipPop.current -= 1;
        return;
      }
      const st = useStore.getState();
      if (!st.viewer && !st.showNew && !st.pendingComplete && !st.mobileDetailOpen) return;
      fromPop.current = true;
      if (st.viewer) st.closeViewer();
      else if (st.showNew) st.closeModal();
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
    const was = prev.current ? RANK[prev.current] : 0;
    const now = layer ? RANK[layer] : 0;
    if (now > was) {
      window.history.pushState({ dzfLayer: layer }, '');
    } else if ((window.history.state as { dzfLayer?: string } | null)?.dzfLayer) {
      // 用 × 关掉了上面那层：退一格历史，并跳过它引起的 popstate
      skipPop.current += 1;
      window.history.back();
    }
    prev.current = layer;
  }, [layer]);
}
