import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './styles.css';
import './skins.css';
import App from './App';
import { useStore } from './lib/store';
import { applySkin } from './lib/skins';

// 皮肤在第一次渲染之前就挂上，免得先闪一下默认配色
applySkin(useStore.getState().settings.skin);
useStore.subscribe((s, prev) => {
  if (s.settings.skin !== prev.settings.skin) applySkin(s.settings.skin);
});
// 桌面版的置顶提醒小窗是另一个窗口：主窗口里换了皮肤，它通过 storage 事件跟着换
window.addEventListener('storage', (e) => {
  if (e.key !== 'dzf-reminder-settings-v1' || !e.newValue) return;
  try {
    applySkin((JSON.parse(e.newValue) as { skin?: unknown }).skin);
  } catch {
    /* ignore */
  }
});

// 文件拖到没有接收区的地方松手：浏览器默认会直接打开这个文件（把整个应用换掉），拦下来
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
