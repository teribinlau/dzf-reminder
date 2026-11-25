import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';

/**
 * 应用自己的确认框（全局一个，挂在 App 最后面；用 store 的 askConfirm() 弹）。
 *
 * 为什么不用 window.confirm：Mac 桌面版的内核（WKWebView，wry 没接那个系统面板）不弹它，
 * 直接当成点了「取消」—— 所有「先问一句再做」的按钮在 Mac 桌面版上都点了没反应（v0.8.9 的「不搬了」就是这样发现的）。
 *
 * - 焦点默认在「取消」上：回车 / 扫码枪打出来的回车不会误点「确定」。
 * - 键盘事件在这里拦下（捕获阶段），下面的弹窗、扫码枪监听都收不到；Esc = 取消。
 * - 点遮罩 = 取消；安卓返回键 = 取消（useBackButton 里算一层）。
 */
export function ConfirmDialog() {
  const { t } = useTranslation();
  const req = useStore((s) => s.confirm);
  const answer = useStore((s) => s.answerConfirm);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const id = req?.id;

  useEffect(() => {
    if (id == null) return;
    const before = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        answer(false);
      } else if (e.key === 'Tab') {
        // 只有两个按钮：Tab 在它们之间来回
        e.preventDefault();
        (document.activeElement === cancelRef.current ? okRef : cancelRef).current?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (before && document.contains(before)) before.focus();
    };
  }, [id, answer]);

  if (!req) return null;
  return (
    <div
      className="overlay confirm-ov"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) answer(false);
      }}
    >
      <div className="modal sm confirm" role="alertdialog" aria-modal="true" aria-describedby="confirm-text">
        <div className="m-body">
          <p className="confirm-text" id="confirm-text">
            {req.body}
          </p>
        </div>
        <div className="m-foot">
          <div className="grow" />
          <button ref={cancelRef} className="btn ghost" onClick={() => answer(false)} id="confirm-cancel">
            {req.cancel ?? t('actions.cancel')}
          </button>
          <button ref={okRef} className={`btn ${req.danger ? 'danger-fill' : 'primary'}`} onClick={() => answer(true)} id="confirm-ok">
            {req.ok ?? t('actions.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
