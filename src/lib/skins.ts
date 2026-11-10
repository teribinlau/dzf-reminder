// 皮肤：颜色 / 圆角 / 字体都是 CSS 变量（src/skins.css），这里只负责
//   1. 把 data-skin 挂到 <html> 上
//   2. 按需加载这套皮肤要的字体（从 npm 打包进来）：英文 / 数字只要拉丁子集；
//      中文字体每套皮肤配一个，按 unicode-range 切成约一百个小文件，页面上出现哪些字浏览器才下载哪几片
//   3. 手机浏览器地址栏 / 状态栏的颜色跟着换
import type { Skin } from './types';

export interface SkinMeta {
  id: Skin;
  /** 设置页上显示的名字 */
  name: string;
  /** 名字要跟着界面语言走的（不是品牌名）：i18n 的 key，有的话优先用它 */
  nameKey?: string;
  /** 来源（设置页小字） */
  source: string;
  /** 预览色块：页面底色 / 卡片 / 主色 / 强调色 */
  swatch: [string, string, string, string];
  /** 预览「Aa 字」用的字体（英文 + 这套皮肤的中文标题字体） */
  previewFont: string;
  /** 预览字的粗细（单一字重的中文字体不加粗，免得被浏览器硬描粗） */
  previewWeight?: number;
  /** 中文字体的名字，设置页小字里显示 */
  cjk: string;
  /** 圆角倍数，和 skins.css 里的 --rs 一致，预览卡片用 */
  rs: number;
}

export const SKINS: SkinMeta[] = [
  { id: 'default', name: 'DZF', source: 'DZF', cjk: '思源黑体', swatch: ['#eeece7', '#f6f5f1', '#121212', '#e5322d'], previewFont: "'Archivo', 'Noto Sans SC', sans-serif", rs: 1 },
  { id: 'opencode', name: 'opencode.ai', source: 'getdesign', cjk: '霞鹜文楷等宽', swatch: ['#f8f7f7', '#fdfcfc', '#201d1d', '#007aff'], previewFont: "'JetBrains Mono', 'LXGW WenKai Mono', monospace", rs: 0.3 },
  { id: 'notion', name: 'Notion', source: 'getdesign', cjk: '思源宋体', swatch: ['#f6f5f4', '#ffffff', '#191918', '#0075de'], previewFont: "'Inter', 'Noto Serif SC', sans-serif", previewWeight: 800, rs: 0.7 },
  { id: 'popcart', name: 'Popcart', source: 'Claude Design', cjk: '站酷快乐体', swatch: ['#f7f8fa', '#ffffff', '#15181c', '#e4000f'], previewFont: "'Fredoka', 'ZCOOL KuaiLe', sans-serif", previewWeight: 500, rs: 1.4 },
  {
    id: 'glass',
    name: 'Glass',
    nameKey: 'settings.skinGlass',
    source: 'DZF',
    cjk: '站酷小薇体',
    // 底色是壁纸的缩小版，卡片是半透明白
    swatch: ['radial-gradient(90px 60px at 0% 0%, #ffc7b0 0, transparent 70%), radial-gradient(90px 60px at 100% 0%, #b5caff 0, transparent 70%), radial-gradient(110px 60px at 60% 130%, #d4bdff 0, transparent 70%), #eef1f8', 'rgba(255, 255, 255, 0.62)', '#1b2030', '#4353ff'],
    previewFont: "'Manrope', 'ZCOOL XiaoWei', sans-serif",
    previewWeight: 500,
    rs: 1.3,
  },
];

// 中文字体（全部按 unicode-range 切片，CSS 很小，字体文件用到才下载）：
//   opencode → 霞鹜文楷等宽（正文 400 + 粗 700，全界面）
//   notion   → 思源宋体 900（只用在标题上；标题都是 800 / 900）
//   popcart  → 站酷快乐体（单一字重，只用在标题上）
//   glass    → 站酷小薇体（单一字重，只用在标题上）
// 正文的思源黑体（Noto Sans SC）还是 index.html 里那份，所有皮肤共用。
const FONT_LOADERS: Partial<Record<Skin, () => Promise<unknown>>> = {
  opencode: () =>
    Promise.all([
      import('@fontsource/jetbrains-mono/latin-400.css'),
      import('@fontsource/jetbrains-mono/latin-500.css'),
      import('@fontsource/jetbrains-mono/latin-700.css'),
      import('@fontsource/jetbrains-mono/latin-800.css'),
      import('lxgw-wenkai-webfont/lxgwwenkaimono-regular.css'),
      import('lxgw-wenkai-webfont/lxgwwenkaimono-bold.css'),
    ]),
  notion: () =>
    Promise.all([
      import('@fontsource/inter/latin-400.css'),
      import('@fontsource/inter/latin-500.css'),
      import('@fontsource/inter/latin-700.css'),
      import('@fontsource/inter/latin-800.css'),
      import('@fontsource/inter/latin-900.css'),
      import('@fontsource/noto-serif-sc/900.css'),
    ]),
  popcart: () =>
    Promise.all([
      import('@fontsource/figtree/latin-400.css'),
      import('@fontsource/figtree/latin-500.css'),
      import('@fontsource/figtree/latin-700.css'),
      import('@fontsource/figtree/latin-800.css'),
      import('@fontsource/fredoka/latin-500.css'),
      import('@fontsource/fredoka/latin-600.css'),
      import('@fontsource/fredoka/latin-700.css'),
      import('@fontsource/zcool-kuaile/400.css'),
    ]),
  glass: () =>
    Promise.all([
      import('@fontsource/manrope/latin-400.css'),
      import('@fontsource/manrope/latin-500.css'),
      import('@fontsource/manrope/latin-600.css'),
      import('@fontsource/manrope/latin-700.css'),
      import('@fontsource/manrope/latin-800.css'),
      import('@fontsource/zcool-xiaowei/400.css'),
    ]),
};

/** 设置里存的值可能是旧版本 / 手改的，不认识就当默认皮肤 */
export function normalizeSkin(v: unknown): Skin {
  return SKINS.some((s) => s.id === v) ? (v as Skin) : 'default';
}

/** 字体都是本地文件（打包进应用），预览卡片要显示真字体，所以设置页打开时把全部皮肤的字体先加载了 */
export function preloadSkinFonts(): void {
  for (const load of Object.values(FONT_LOADERS)) void load?.().catch(() => undefined);
}

export function applySkin(value: unknown): void {
  const skin = normalizeSkin(value);
  const root = document.documentElement;
  if (skin === 'default') root.removeAttribute('data-skin');
  else root.setAttribute('data-skin', skin);
  void FONT_LOADERS[skin]?.().catch(() => undefined);
  // 手机上地址栏 / 状态栏的颜色
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (bg && meta) meta.setAttribute('content', bg);
}
