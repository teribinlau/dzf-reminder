export type Role = 'admin' | 'member';
export type Lang = 'zh-CN' | 'de-DE';
export type Priority = 'low' | 'medium' | 'high';
export type Visibility = 'private' | 'team' | 'company';
export type CompletionMode = 'any' | 'each';

export interface Team {
  id: string;
  name_zh: string;
  name_de: string;
  color: string;
  sort: number;
}

export interface Profile {
  id: string;
  email: string;
  name: string;
  team_id: string | null;
  role: Role;
  lang: Lang;
  is_station: boolean;
  active: boolean;
}

export interface Reminder {
  id: string;
  title: string;
  notes: string;
  due_at: string; // ISO (UTC)
  tz: string;
  rrule: string | null;
  skip_holidays: boolean;
  remind_before_min: number;
  overdue_repeat_min: number;
  priority: Priority;
  visibility: Visibility;
  team_id: string | null;
  created_by: string;
  link: string;
  completion_mode: CompletionMode;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface Assignee {
  id: string;
  reminder_id: string;
  user_id: string | null;
  team_id: string | null;
}

export interface Completion {
  id: string;
  reminder_id: string;
  occurrence_at: string;
  completed_by: string;
  completed_by_name: string;
  completed_at: string;
  note: string;
}

export interface Snooze {
  id: string;
  reminder_id: string;
  user_id: string;
  occurrence_at: string;
  until: string;
}

/** 一次具体的到期（重复提醒展开后的一项） */
export interface Occurrence {
  key: string; // reminderId|occurrenceISO
  reminder: Reminder;
  at: Date; // 到期时间
  completion: Completion | null; // any 模式：第一条完成记录；each 模式：当前用户的完成记录
  completions: Completion[];
  snoozedUntil: Date | null;
  isOverdue: boolean;
  /** 重复提醒里超过 48 小时仍未完成的旧日期：不再当作逾期催办，只在历史里记为「未完成」 */
  stale: boolean;
}

export interface ReminderInput {
  title: string;
  notes: string;
  due_at: string;
  rrule: string | null;
  skip_holidays: boolean;
  remind_before_min: number;
  overdue_repeat_min: number;
  priority: Priority;
  visibility: Visibility;
  team_id: string | null;
  link: string;
  completion_mode: CompletionMode;
  assignee_user_ids: string[];
  assignee_team_ids: string[];
}

export interface Settings {
  lang: Lang;
  autostart: boolean;
  closeToTray: boolean;
  systemNotifications: boolean;
  sound: boolean;
  alertWindow: boolean; // 高优先级额外弹置顶小窗
  defaultRemindBefore: number;
  dndEnabled: boolean;
  dndFrom: string; // "18:30"
  dndTo: string; // "07:00"
  dndWeekend: boolean;
  overdueRepeatMin: number;
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'zh-CN',
  autostart: true,
  closeToTray: true,
  systemNotifications: true,
  sound: true,
  alertWindow: true,
  defaultRemindBefore: 15,
  dndEnabled: true,
  dndFrom: '18:30',
  dndTo: '07:00',
  dndWeekend: true,
  overdueRepeatMin: 30,
};

export const TZ = 'Europe/Berlin';
