import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './zh-CN.json';
import deDE from './de-DE.json';

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'de-DE': { translation: deDE },
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
});

// 让 <html lang> 跟着界面语言走：CSS 的 :lang(de) 规则和系统拼写检查都靠它
i18n.on('languageChanged', (lng) => {
  if (typeof document !== 'undefined') document.documentElement.lang = lng;
});

export default i18n;
