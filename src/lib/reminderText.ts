// 提醒的标题 / 备注按界面语言取：Notion 同步过来的提醒带德语版（title_de / notes_de），
// 德语界面显示德语版，中文界面还是中文；手动建的提醒没有德语版，两边都显示原文。
import type { Lang, Reminder } from './types';

type Texts = Pick<Reminder, 'title' | 'notes'> & Partial<Pick<Reminder, 'title_de' | 'notes_de'>>;

export function reminderTitle(r: Texts, lang: Lang): string {
  return lang.startsWith('de') && r.title_de ? r.title_de : r.title;
}

export function reminderNotes(r: Texts, lang: Lang): string {
  return lang.startsWith('de') && r.notes_de ? r.notes_de : r.notes;
}

/** 搜索用：中德两版都算 */
export function reminderMatches(r: Texts, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return r.title.toLowerCase().includes(s) || (r.title_de ?? '').toLowerCase().includes(s);
}
