import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Tauri 开发时由 tauri CLI 注入 TAURI_ENV_* 变量；网页 / Vercel 构建时没有。
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

// 字体包（@fontsource、lxgw-wenkai-webfont）的 CSS 里每个 @font-face 都带一个 .woff 备用地址，
// 打包时会把 .woff 也一起拷进来（比 .woff2 还大）。我们支持的浏览器都认 woff2，把备用地址去掉 ——
// 中文字体一个字重就有一百来个分片，不去掉的话安装包要多出一倍。
const woff2Only = {
  name: 'dzf-woff2-only',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!/node_modules[\\/](@fontsource|lxgw-wenkai-webfont)[\\/].*\.css(\?|$)/.test(id)) return null;
    return { code: code.replace(/,\s*url\([^)]*\.woff['"]?\)\s*format\(['"]woff['"]\)/g, ''), map: null };
  },
};

export default defineConfig({
  plugins: [
    woff2Only,
    react(),
    // 手机 / 浏览器用的 PWA；Tauri 打包时关闭（桌面端不需要 service worker）
    VitePWA({
      disable: isTauri,
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'DZF 提醒',
        short_name: 'DZF 提醒',
        description: 'DZF 团队共享提醒',
        lang: 'zh-CN',
        theme_color: '#EEECE7',
        background_color: '#EEECE7',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // 各皮肤的中文字体（思源宋体 / 霞鹜文楷 / 站酷快乐体 / 小薇体）每个字重有一百来个分片、几 MB，
        // 不能装应用时全下下来：不进预缓存，页面上真用到哪一片再下载，下载过的留在缓存里（离线也能用）
        globIgnores: ['**/noto-serif-sc-*.woff2', '**/zcool-*.woff2', '**/lxgwwenkai*.woff2'],
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && /^\/assets\/(noto-serif-sc-|zcool-|lxgwwenkai).*\.woff2$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'dzf-cjk-fonts',
              expiration: { maxEntries: 700, maxAgeSeconds: 365 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
