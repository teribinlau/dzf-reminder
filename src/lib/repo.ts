import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Assignee, Attachment, Completion, Profile, Reminder, ReminderInput, Snooze, Submission, Team, TeamMembership } from './types';

export interface Session {
  userId: string;
  email: string;
}

export interface Snapshot {
  teams: Team[];
  profiles: Profile[];
  reminders: Reminder[];
  assignees: Assignee[];
  completions: Completion[];
  snoozes: Snooze[];
  submissions: Submission[];
  memberships: TeamMembership[]; // 兼任班组
  attachments: Attachment[]; // 创建人挂的附件
}

/** 两个私有桶：员工交的文件 / 创建人挂的附件 */
export type FileBucket = 'submissions' | 'attachments';

/** 上传回传文件时的元数据（文件本体单独传） */
export type SubmissionMeta = Omit<Submission, 'id' | 'created_at' | 'file_path' | 'file_name' | 'size' | 'mime'>;

export const MAX_UPLOAD_MB = 20;

/** Storage 对象名：时间 + 随机串 + 原扩展名（原始文件名可能有中文 / 空格，存在表里） */
function objectName(fileName: string): string {
  const ext = (fileName.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? 'bin').toLowerCase();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

export interface Repo {
  mode: 'supabase' | 'demo';
  getSession(): Promise<Session | null>;
  onAuthChange(cb: (s: Session | null) => void): () => void;
  signInWithEmail(email: string): Promise<void>;
  /** 输入邮件里的 6 位验证码登录（桌面端用，不需要跳转浏览器） */
  verifyEmailCode(email: string, code: string): Promise<void>;
  /** 演示模式：直接以某个示例用户身份进入 */
  signInDemo?(userId: string): Promise<void>;
  signOut(): Promise<void>;
  loadAll(): Promise<Snapshot>;
  subscribe(onChange: () => void): () => void;
  createReminder(input: ReminderInput, userId: string): Promise<string>;
  updateReminder(id: string, input: ReminderInput): Promise<void>;
  deleteReminder(id: string): Promise<void>;
  addCompletion(c: Omit<Completion, 'id' | 'completed_at'>): Promise<void>;
  removeCompletion(id: string): Promise<void>;
  setSnooze(s: Omit<Snooze, 'id'>): Promise<void>;
  clearSnooze(reminderId: string, userId: string, occurrenceAt: string): Promise<void>;
  /** 上传一个回传文件并登记；返回登记行 */
  addSubmission(meta: SubmissionMeta, file: File): Promise<Submission>;
  /** 删记录 + 删文件 */
  removeSubmission(s: Submission): Promise<void>;
  /** 拿一个短期有效的下载地址（浏览器直接打开就会下载） */
  submissionUrl(s: Submission): Promise<string>;
  /** 给提醒挂一个附件（只有创建人 / 管理员有权限，数据库里也拦着） */
  addAttachment(reminderId: string, userId: string, file: File): Promise<Attachment>;
  removeAttachment(a: Attachment): Promise<void>;
  /** 短期有效的地址：downloadName 给了就是「下载」，不给就是在浏览器里直接看（图片预览用） */
  fileUrl(bucket: FileBucket, path: string, downloadName?: string): Promise<string>;
  /** 一次拿一批图片的预览地址（缩略图用），返回 path → url */
  fileUrls(bucket: FileBucket, paths: string[]): Promise<Record<string, string>>;
  updateProfile(id: string, patch: Partial<Profile>): Promise<void>;
  /** 设置某人的兼任班组（整组替换，不含主班组） */
  setMemberships(profileId: string, teamIds: string[]): Promise<void>;
  upsertTeam(team: Partial<Team> & { name_zh: string; name_de: string; color: string }): Promise<void>;
  deleteTeam(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Supabase 实现
// ---------------------------------------------------------------------------
export function hasSupabaseConfig(): boolean {
  return !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
}

export class SupabaseRepo implements Repo {
  mode = 'supabase' as const;
  client: SupabaseClient;

  constructor() {
    this.client = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }

  async getSession(): Promise<Session | null> {
    const { data } = await this.client.auth.getSession();
    const u = data.session?.user;
    return u ? { userId: u.id, email: u.email ?? '' } : null;
  }

  onAuthChange(cb: (s: Session | null) => void): () => void {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
      const u = session?.user;
      cb(u ? { userId: u.id, email: u.email ?? '' } : null);
    });
    return () => data.subscription.unsubscribe();
  }

  async signInWithEmail(email: string): Promise<void> {
    const { error } = await this.client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) throw error;
  }

  async verifyEmailCode(email: string, code: string): Promise<void> {
    const { error } = await this.client.auth.verifyOtp({ email, token: code.trim(), type: 'email' });
    if (error) throw error;
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
  }

  async loadAll(): Promise<Snapshot> {
    const since = new Date(Date.now() - 60 * 86400000).toISOString();
    const [teams, profiles, reminders, assignees, completions, snoozes, submissions, memberships, attachments] = await Promise.all([
      this.client.from('teams').select('*').order('sort'),
      this.client.from('profiles').select('*').order('name'),
      this.client.from('reminders').select('*').eq('archived', false),
      this.client.from('reminder_assignees').select('*'),
      this.client.from('completions').select('*').gte('occurrence_at', since),
      this.client.from('snoozes').select('*'),
      this.client.from('submissions').select('*').gte('occurrence_at', since).order('created_at'),
      this.client.from('profile_teams').select('profile_id, team_id'),
      this.client.from('reminder_attachments').select('*').order('created_at'),
    ]);
    const err = [teams, profiles, reminders, assignees, completions, snoozes, submissions, memberships].find((r) => r.error)?.error;
    if (err) throw err;
    return {
      teams: (teams.data ?? []) as Team[],
      profiles: (profiles.data ?? []) as Profile[],
      reminders: (reminders.data ?? []) as Reminder[],
      assignees: (assignees.data ?? []) as Assignee[],
      completions: (completions.data ?? []) as Completion[],
      snoozes: (snoozes.data ?? []) as Snooze[],
      submissions: (submissions.data ?? []) as Submission[],
      memberships: (memberships.data ?? []) as TeamMembership[],
      // 附件表是 0005 迁移加的：前端先上线、迁移还没跑时，这里报错不能把整个应用拖垮，当作没有附件
      attachments: attachments.error ? [] : ((attachments.data ?? []) as Attachment[]),
    };
  }

  subscribe(onChange: () => void): () => void {
    let timer: number | undefined;
    const debounced = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(onChange, 250);
    };
    const channel = this.client
      .channel('dzf-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reminders' }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reminder_assignees' }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'completions' }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'submissions' }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reminder_attachments' }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profile_teams' }, debounced)
      .subscribe();
    return () => {
      this.client.removeChannel(channel);
    };
  }

  private reminderRow(input: ReminderInput) {
    return {
      title: input.title,
      notes: input.notes,
      due_at: input.due_at,
      rrule: input.rrule,
      skip_holidays: input.skip_holidays,
      remind_before_min: input.remind_before_min,
      overdue_repeat_min: input.overdue_repeat_min,
      priority: input.priority,
      visibility: input.visibility,
      team_id: input.team_id,
      link: input.link,
      completion_mode: input.completion_mode,
      require_upload: input.require_upload,
    };
  }

  private async writeAssignees(reminderId: string, input: ReminderInput) {
    await this.client.from('reminder_assignees').delete().eq('reminder_id', reminderId);
    const rows = [
      ...input.assignee_user_ids.map((user_id) => ({ reminder_id: reminderId, user_id, team_id: null })),
      ...input.assignee_team_ids.map((team_id) => ({ reminder_id: reminderId, user_id: null, team_id })),
    ];
    if (rows.length) {
      const { error } = await this.client.from('reminder_assignees').insert(rows);
      if (error) throw error;
    }
  }

  async createReminder(input: ReminderInput, userId: string): Promise<string> {
    const { data, error } = await this.client
      .from('reminders')
      .insert({ ...this.reminderRow(input), created_by: userId })
      .select('id')
      .single();
    if (error) throw error;
    await this.writeAssignees(data.id as string, input);
    return data.id as string;
  }

  async updateReminder(id: string, input: ReminderInput): Promise<void> {
    const { error } = await this.client.from('reminders').update(this.reminderRow(input)).eq('id', id);
    if (error) throw error;
    await this.writeAssignees(id, input);
  }

  async deleteReminder(id: string): Promise<void> {
    const { error } = await this.client.from('reminders').update({ archived: true }).eq('id', id);
    if (error) throw error;
  }

  async addCompletion(c: Omit<Completion, 'id' | 'completed_at'>): Promise<void> {
    const { error } = await this.client.from('completions').upsert(c, { onConflict: 'reminder_id,occurrence_at,completed_by' });
    if (error) throw error;
  }

  async removeCompletion(id: string): Promise<void> {
    const { error } = await this.client.from('completions').delete().eq('id', id);
    if (error) throw error;
  }

  async setSnooze(s: Omit<Snooze, 'id'>): Promise<void> {
    const { error } = await this.client.from('snoozes').upsert(s, { onConflict: 'reminder_id,user_id,occurrence_at' });
    if (error) throw error;
  }

  async clearSnooze(reminderId: string, userId: string, occurrenceAt: string): Promise<void> {
    await this.client
      .from('snoozes')
      .delete()
      .eq('reminder_id', reminderId)
      .eq('user_id', userId)
      .eq('occurrence_at', occurrenceAt);
  }

  async addSubmission(meta: SubmissionMeta, file: File): Promise<Submission> {
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`too large: ${file.name}`);
    // 对象路径只用 ASCII（原始文件名存在表里），第一段是提醒 id，Storage 权限靠它判断
    const occ = meta.occurrence_at.replace(/[^0-9]/g, '').slice(0, 12);
    const path = `${meta.reminder_id}/${occ}/${objectName(file.name)}`;
    const up = await this.client.storage.from('submissions').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (up.error) throw up.error;
    const row = { ...meta, file_path: path, file_name: file.name, size: file.size, mime: file.type || '' };
    const { data, error } = await this.client.from('submissions').insert(row).select('*').single();
    if (error) {
      await this.client.storage.from('submissions').remove([path]);
      throw error;
    }
    return data as Submission;
  }

  async removeSubmission(s: Submission): Promise<void> {
    const { error } = await this.client.from('submissions').delete().eq('id', s.id);
    if (error) throw error;
    await this.client.storage.from('submissions').remove([s.file_path]);
  }

  async submissionUrl(s: Submission): Promise<string> {
    return this.fileUrl('submissions', s.file_path, s.file_name);
  }

  async addAttachment(reminderId: string, userId: string, file: File): Promise<Attachment> {
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`too large: ${file.name}`);
    // 对象路径只用 ASCII，第一段是提醒 id（Storage 权限靠它判断）
    const path = `${reminderId}/${objectName(file.name)}`;
    const up = await this.client.storage.from('attachments').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (up.error) throw up.error;
    const row = { reminder_id: reminderId, uploaded_by: userId, file_path: path, file_name: file.name, size: file.size, mime: file.type || '' };
    const { data, error } = await this.client.from('reminder_attachments').insert(row).select('*').single();
    if (error) {
      await this.client.storage.from('attachments').remove([path]);
      throw error;
    }
    return data as Attachment;
  }

  async removeAttachment(a: Attachment): Promise<void> {
    const { error } = await this.client.from('reminder_attachments').delete().eq('id', a.id);
    if (error) throw error;
    await this.client.storage.from('attachments').remove([a.file_path]);
  }

  async fileUrl(bucket: FileBucket, path: string, downloadName?: string): Promise<string> {
    const { data, error } = await this.client.storage.from(bucket).createSignedUrl(path, 600, downloadName ? { download: downloadName } : undefined);
    if (error) throw error;
    return data.signedUrl;
  }

  async fileUrls(bucket: FileBucket, paths: string[]): Promise<Record<string, string>> {
    if (!paths.length) return {};
    const { data, error } = await this.client.storage.from(bucket).createSignedUrls(paths, 3600);
    if (error) throw error;
    const out: Record<string, string> = {};
    for (const d of data ?? []) if (d.path && d.signedUrl) out[d.path] = d.signedUrl;
    return out;
  }

  async updateProfile(id: string, patch: Partial<Profile>): Promise<void> {
    const { error } = await this.client.from('profiles').update(patch).eq('id', id);
    if (error) throw error;
  }

  async setMemberships(profileId: string, teamIds: string[]): Promise<void> {
    const del = await this.client.from('profile_teams').delete().eq('profile_id', profileId);
    if (del.error) throw del.error;
    if (teamIds.length) {
      const { error } = await this.client.from('profile_teams').insert(teamIds.map((team_id) => ({ profile_id: profileId, team_id })));
      if (error) throw error;
    }
  }

  async upsertTeam(team: Partial<Team> & { name_zh: string; name_de: string; color: string }): Promise<void> {
    const { error } = await this.client.from('teams').upsert(team);
    if (error) throw error;
  }

  async deleteTeam(id: string): Promise<void> {
    const { error } = await this.client.from('teams').delete().eq('id', id);
    if (error) throw error;
  }
}
