import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import i18n from './i18n';
import './styles.css';
import './skins.css';
import App from './App';
import { useStore } from './lib/store';
import { applySkin } from './lib/skins';

// 皮肤和语言在第一次渲染之前就挂上，免得先闪一下默认配色。
// 语言：主窗口在 store.init() 里还会再设一次；置顶提醒小窗不跑 init，全靠这里（不然德语同事看到的小窗按钮是中文）
applySkin(useStore.getState().settings.skin);
void i18n.changeLanguage(useStore.getState().settings.lang);
useStore.subscribe((s, prev) => {
  if (s.settings.skin !== prev.settings.skin) applySkin(s.settings.skin);
});
// 桌面版的置顶提醒小窗是另一个窗口：主窗口里换了皮肤 / 语言，它通过 storage 事件跟着换
window.addEventListener('storage', (e) => {
  if (e.key !== 'dzf-reminder-settings-v1' || !e.newValue) return;
  try {
    const next = JSON.parse(e.newValue) as { skin?: unknown; lang?: unknown };
    applySkin(next.skin);
    if (next.lang === 'zh-CN' || next.lang === 'de-DE') void i18n.changeLanguage(next.lang);
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
