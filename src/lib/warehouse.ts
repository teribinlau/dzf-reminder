// 「仓库」页：把 SKU 库位查询网站（sku-kuwei）的两个页面嵌进来 —— SKU 查询、3D 仓库。
//
// 免口令进入：网页在框里打开时（?embed=1）会发 hello 给 app，app 回一个当前登录的 Supabase
// 访问令牌；网页拿它去请求自己站上的 /api/data，那边向 Supabase 问 public.is_active()，
// 是已激活成员才给数据。令牌只发给 SKU_ORIGIN 这一个来源，口令不写进 app。
// 网页那边只认这几个 app 来源：https://dzf-reminder.vercel.app、tauri://localhost、
// http(s)://tauri.localhost、http://localhost:1420（开发）。
//
// 消息（都带 dzf: 'sku'）：
//   网页 → app：{ op: 'hello' | 'ready', page }、{ op: 'open', page, to: 'lookup' | '3d', q }
//   app → 网页：{ op: 'token', token }、{ op: 'goto', q }
// 库位整理（3D 页的「整理」，v0.8.9）：
//   3D 页 → app：{ op: 'tidy-add', tasks: [{ kind: 'move', src, dst, sys, cust, fill, before, after, same, lines }
//                 | { kind: 'pallet', src }] } = 加入整理清单；{ op: 'tidy-open' } = 打开整理清单
//   app → 3D 页：{ op: 'tidy', can, tasks: [{ kind, src, dst }] } = 清单里没结束的任务（页面不再建议这些来源、
//                 目标的占用算上要并进来的）+ 现在能不能加；{ op: 'goto', q, mode: 'tidy' } = 切到整理模式并定位
import { asTidyDrafts, isOpen, targetOf } from './tidy';
import type { TidyDraft, TidyTask } from './types';

export type SkuPage = 'lookup' | '3d';

/** sku-kuwei 的来源；本地测试时可以用 VITE_SKU_ORIGIN 换成本地服务器 */
export const SKU_ORIGIN = (import.meta.env.VITE_SKU_ORIGIN || 'https://sku-kuwei.vercel.app').replace(/\/+$/, '');

/** 网页只有中文 / 英文：德语界面用英文版 */
export function skuLang(appLang: string | undefined): 'zh' | 'en' {
  return (appLang ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 页面地址：embed 时网页走「向 app 要令牌」；q = 打开后直接搜（库位 / SKU / 客户） */
export function skuUrl(page: SkuPage, lang: 'zh' | 'en', q = '', embed = true, mode = ''): string {
  const p = new URLSearchParams();
  if (embed) p.set('embed', '1');
  p.set('lang', lang);
  if (q) p.set('q', q);
  if (mode && page === '3d') p.set('mode', mode);
  return `${SKU_ORIGIN}${page === '3d' ? '/3d/' : '/'}?${p.toString()}`;
}

export type SkuMessage =
  | { dzf: 'sku'; op: 'hello' | 'ready'; page?: SkuPage }
  | { dzf: 'sku'; op: 'open'; page?: SkuPage; to: SkuPage; q?: string }
  | { dzf: 'sku'; op: 'tidy-add'; tasks: TidyDraft[] }
  | { dzf: 'sku'; op: 'tidy-open' };

/** 只收形状对的消息（来源另外查） */
export function asSkuMessage(data: unknown): SkuMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m.dzf !== 'sku' || typeof m.op !== 'string') return null;
  if (m.op === 'hello' || m.op === 'ready') return { dzf: 'sku', op: m.op };
  if (m.op === 'open' && (m.to === 'lookup' || m.to === '3d')) {
    return { dzf: 'sku', op: 'open', to: m.to, q: typeof m.q === 'string' ? m.q.slice(0, 200) : '' };
  }
  if (m.op === 'tidy-add') return { dzf: 'sku', op: 'tidy-add', tasks: asTidyDrafts(m.tasks) };
  if (m.op === 'tidy-open') return { dzf: 'sku', op: 'tidy-open' };
  return null;
}

/** 发给 3D 页的整理清单：只发没结束的任务（已搬、还没导入的也算：系统里货还在原库位） */
export function tidyMessage(tasks: TidyTask[], can: boolean): { dzf: 'sku'; op: 'tidy'; can: boolean; tasks: { kind: string; src: string; dst: string }[] } {
  return { dzf: 'sku', op: 'tidy', can, tasks: tasks.filter(isOpen).map((t) => ({ kind: t.kind, src: t.src, dst: t.kind === 'move' ? targetOf(t) : '' })) };
}
