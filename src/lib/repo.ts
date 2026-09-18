import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Assignee, Completion, Profile, Reminder, ReminderInput, Snooze, Team } from './types';

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
  updateProfile(id: string, patch: Partial<Profile>): Promise<void>;
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
    const [teams, profiles, reminders, assignees, completions, snoozes] = await Promise.all([
      this.client.from('teams').select('*').order('sort'),
      this.client.from('profiles').select('*').order('name'),
      this.client.from('reminders').select('*').eq('archived', false),
      this.client.from('reminder_assignees').select('*'),
      this.client.from('completions').select('*').gte('occurrence_at', since),
      this.client.from('snoozes').select('*'),
    ]);
    const err = [teams, profiles, reminders, assignees, completions, snoozes].find((r) => r.error)?.error;
    if (err) throw err;
    return {
      teams: (teams.data ?? []) as Team[],
      profiles: (profiles.data ?? []) as Profile[],
      reminders: (reminders.data ?? []) as Reminder[],
      assignees: (assignees.data ?? []) as Assignee[],
      completions: (completions.data ?? []) as Completion[],
      snoozes: (snoozes.data ?? []) as Snooze[],
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, debounced)
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

  async updateProfile(id: string, patch: Partial<Profile>): Promise<void> {
    const { error } = await this.client.from('profiles').update(patch).eq('id', id);
    if (error) throw error;
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
