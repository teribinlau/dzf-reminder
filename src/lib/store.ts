import { create } from 'zustand';
import type { Repo, Session, Snapshot } from './repo';
import { SupabaseRepo, hasSupabaseConfig } from './repo';
import { DemoRepo } from './demo';
import { DEFAULT_SETTINGS, type Assignee, type Completion, type Occurrence, type Profile, type Reminder, type ReminderInput, type Settings, type Snooze, type Submission, type Team } from './types';
import { readCache, readQueue, writeCache, writeQueue, type QueuedOp } from './cache';
import { downloadUpdate, installUpdate, setAutostart, showMainWindow } from './tauri';
import { hasSubmitted } from './occurrences';
import { MAX_UPLOAD_MB } from './repo';
import i18n from '../i18n';

export type View = 'calendar' | 'board' | 'settings';
export type Filter = 'all' | 'mine' | 'created' | `team:${string}`;
export type SettingsTab = 'general' | 'notifications' | 'accounts' | 'sync' | 'about';

export interface Toast {
  id: string;
  title: string;
  body: string;
  kind: 'info' | 'error' | 'reminder';
  occurrenceKey?: string;
}

const SETTINGS_KEY = 'dzf-reminder-settings-v1';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

function makeRepo(): Repo {
  return hasSupabaseConfig() ? new SupabaseRepo() : new DemoRepo();
}

interface State extends Snapshot {
  repo: Repo;
  mode: 'supabase' | 'demo';
  session: Session | null;
  authReady: boolean;
  me: Profile | null;
  loaded: boolean;
  fromCache: boolean;
  online: boolean;
  lastSync: Date | null;
  error: string | null;
  settings: Settings;
  mutedUntil: Date | null;
  updateReady: string | null; // 新版本已经下载好，等用户点重启

  // UI
  view: View;
  filter: Filter;
  selectedKey: string | null;
  showNew: boolean;
  editReminderId: string | null;
  settingsTab: SettingsTab;
  toasts: Toast[];
  pendingComplete: Occurrence | null; // 工位模式：等待选择完成人
  pendingFiles: File[]; // 需要回传的提醒：选好的文件先放这里，等选完是谁再一起传
  uploading: boolean;
  calendarAnchor: Date; // 日历当前显示的起始日
  mobileDetailOpen: boolean;

  // actions
  init(): Promise<void>;
  reload(): Promise<void>;
  signOut(): Promise<void>;
  setView(v: View): void;
  setFilter(f: Filter): void;
  select(key: string | null): void;
  openNew(): void;
  openEdit(id: string): void;
  closeModal(): void;
  setSettingsTab(t: SettingsTab): void;
  setCalendarAnchor(d: Date): void;
  updateSettings(patch: Partial<Settings>): void;
  pushToast(t: Omit<Toast, 'id'>): void;
  dismissToast(id: string): void;
  muteFor(minutes: number): void;
  /** 后台查新版本并下好（桌面版才有；网页版自动跳过） */
  checkUpdate(): Promise<string | null>;
  /** 安装下好的新版本并重启 */
  applyUpdate(): Promise<void>;

  createReminder(input: ReminderInput): Promise<void>;
  updateReminder(id: string, input: ReminderInput): Promise<void>;
  deleteReminder(id: string): Promise<void>;
  /** 点「完成」：工位模式先选人；需要回传的提醒没交文件就先打开详情 */
  requestComplete(o: Occurrence, files?: File[]): void;
  complete(o: Occurrence, actorName?: string, files?: File[]): Promise<void>;
  uncomplete(o: Occurrence): Promise<void>;
  /** 只上传文件，不标记完成（已完成后再补一份也走这里） */
  uploadSubmission(o: Occurrence, files: File[], actorName?: string): Promise<boolean>;
  deleteSubmission(s: Submission): Promise<void>;
  snooze(o: Occurrence, minutes: number): Promise<void>;
  cancelPendingComplete(): void;

  adminUpdateProfile(id: string, patch: Partial<Profile>): Promise<void>;
  adminUpsertTeam(team: Partial<Team> & { name_zh: string; name_de: string; color: string }): Promise<void>;
  adminDeleteTeam(id: string): Promise<void>;
  setMyLang(lang: Settings['lang']): Promise<void>;
}

let unsubscribeRealtime: (() => void) | null = null;

export const useStore = create<State>((set, get) => ({
  repo: makeRepo(),
  mode: hasSupabaseConfig() ? 'supabase' : 'demo',
  session: null,
  authReady: false,
  me: null,
  loaded: false,
  fromCache: false,
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  lastSync: null,
  error: null,
  settings: loadSettings(),
  mutedUntil: null,
  updateReady: null,
  teams: [],
  profiles: [],
  reminders: [],
  assignees: [],
  completions: [],
  snoozes: [],
  submissions: [],

  view: 'calendar',
  filter: 'all',
  selectedKey: null,
  showNew: false,
  editReminderId: null,
  settingsTab: 'general',
  toasts: [],
  pendingComplete: null,
  pendingFiles: [],
  uploading: false,
  calendarAnchor: new Date(),
  mobileDetailOpen: false,

  async init() {
    const { repo, settings } = get();
    void i18n.changeLanguage(settings.lang);
    window.addEventListener('online', () => {
      set({ online: true });
      void get().reload();
    });
    window.addEventListener('offline', () => set({ online: false }));

    const applySession = async (s: Session | null) => {
      set({ session: s, authReady: true });
      if (s) {
        await get().reload();
        unsubscribeRealtime?.();
        unsubscribeRealtime = repo.subscribe(() => void get().reload());
      } else {
        unsubscribeRealtime?.();
        unsubscribeRealtime = null;
        set({ me: null, loaded: false, reminders: [], assignees: [], completions: [], snoozes: [], submissions: [] });
      }
    };
    repo.onAuthChange((s) => void applySession(s));
    const s = await repo.getSession();
    await applySession(s);
    if (settings.autostart) void setAutostart(true);
  },

  async reload() {
    const { repo, session } = get();
    if (!session) return;
    try {
      const snap = await repo.loadAll();
      // 离线队列重放
      const queue = await readQueue();
      if (queue.length && get().online) {
        const remaining: QueuedOp[] = [];
        for (const op of queue) {
          try {
            if (op.kind === 'completion') await repo.addCompletion(op.payload as Omit<Completion, 'id' | 'completed_at'>);
            else await repo.setSnooze(op.payload as Omit<Snooze, 'id'>);
          } catch {
            remaining.push(op);
          }
        }
        await writeQueue(remaining);
      }
      const me = snap.profiles.find((p) => p.id === session.userId) ?? null;
      set({ ...snap, me, loaded: true, fromCache: false, lastSync: new Date(), error: null, online: true });
      void writeCache(snap);
      if (me && me.lang !== get().settings.lang && repo.mode === 'supabase') {
        // 服务器上的语言偏好优先（换电脑也一致）
        get().updateSettings({ lang: me.lang });
      }
    } catch (e) {
      const cached = await readCache();
      if (cached && !get().loaded) {
        const me = cached.snapshot.profiles.find((p) => p.id === session.userId) ?? null;
        set({ ...cached.snapshot, me, loaded: true, fromCache: true, lastSync: new Date(cached.savedAt) });
      }
      set({ error: (e as Error).message ?? String(e), online: navigator.onLine });
    }
  },

  async signOut() {
    await get().repo.signOut();
  },

  setView(view) {
    set({ view, mobileDetailOpen: false });
  },
  setFilter(filter) {
    set({ filter });
  },
  select(selectedKey) {
    set({ selectedKey, mobileDetailOpen: !!selectedKey });
  },
  openNew() {
    set({ showNew: true, editReminderId: null });
  },
  openEdit(id) {
    set({ showNew: true, editReminderId: id });
  },
  closeModal() {
    set({ showNew: false, editReminderId: null });
  },
  setSettingsTab(settingsTab) {
    set({ settingsTab });
  },
  setCalendarAnchor(calendarAnchor) {
    set({ calendarAnchor });
  },
  updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    set({ settings });
    if (patch.lang) void i18n.changeLanguage(patch.lang);
    if (patch.autostart !== undefined) void setAutostart(patch.autostart);
  },
  pushToast(t) {
    const id = Math.random().toString(36).slice(2);
    set({ toasts: [...get().toasts, { ...t, id }] });
    if (t.kind !== 'reminder') window.setTimeout(() => get().dismissToast(id), 6000);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  muteFor(minutes) {
    set({ mutedUntil: new Date(Date.now() + minutes * 60000) });
  },

  async checkUpdate() {
    const v = await downloadUpdate();
    if (v) set({ updateReady: v });
    return v;
  },

  async applyUpdate() {
    await installUpdate();
  },

  async createReminder(input) {
    const { repo, session } = get();
    if (!session) return;
    try {
      await repo.createReminder(input, session.userId);
      set({ showNew: false, editReminderId: null });
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: (e as Error).message, kind: 'error' });
    }
  },

  async updateReminder(id, input) {
    try {
      await get().repo.updateReminder(id, input);
      set({ showNew: false, editReminderId: null });
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: (e as Error).message, kind: 'error' });
    }
  },

  async deleteReminder(id) {
    try {
      await get().repo.deleteReminder(id);
      set({ selectedKey: null, showNew: false, editReminderId: null });
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: (e as Error).message, kind: 'error' });
    }
  },

  requestComplete(o, files) {
    const { me, session } = get();
    if (!me || !session) return;
    // 需要回传文件：没带文件、也没交过 → 打开详情让他上传（工位模式没选人之前只能按「有没有任何人交过」粗判，选人后再严格判）
    if (o.reminder.require_upload && !files?.length && !hasSubmitted(o, session.userId) && !(me.is_station && o.submissions.length)) {
      set({ selectedKey: o.key, mobileDetailOpen: true, view: get().view === 'settings' ? 'calendar' : get().view });
      get().pushToast({ title: i18n.t('submit.needUploadToast'), body: o.reminder.title, kind: 'info' });
      void showMainWindow();
      return;
    }
    if (me.is_station) set({ pendingComplete: o, pendingFiles: files ?? [] });
    else void get().complete(o, undefined, files);
  },

  cancelPendingComplete() {
    set({ pendingComplete: null, pendingFiles: [] });
  },

  async uploadSubmission(o, files, actorName) {
    const { repo, session, online } = get();
    if (!session) return false;
    if (!online || !navigator.onLine) {
      get().pushToast({ title: i18n.t('errors.needOnline'), body: '', kind: 'error' });
      return false;
    }
    const big = files.find((f) => f.size > MAX_UPLOAD_MB * 1024 * 1024);
    if (big) {
      get().pushToast({ title: i18n.t('errors.tooLarge', { n: MAX_UPLOAD_MB }), body: big.name, kind: 'error' });
      return false;
    }
    set({ uploading: true });
    try {
      for (const f of files) {
        const row = await repo.addSubmission(
          { reminder_id: o.reminder.id, occurrence_at: o.at.toISOString(), uploaded_by: session.userId, uploaded_by_name: actorName ?? '' },
          f,
        );
        set({ submissions: [...get().submissions, row] });
      }
      return true;
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.uploadFailed'), body: (e as Error).message, kind: 'error' });
      return false;
    } finally {
      set({ uploading: false });
    }
  },

  async deleteSubmission(sub) {
    try {
      await get().repo.removeSubmission(sub);
      set({ submissions: get().submissions.filter((x) => x.id !== sub.id) });
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: (e as Error).message, kind: 'error' });
    }
  },

  async complete(o, actorName, files) {
    const { repo, session, online } = get();
    if (!session) return;
    set({ pendingComplete: null, pendingFiles: [] });
    if (o.reminder.require_upload) {
      // 先传文件；没传成功就不算完成
      if (files?.length) {
        const ok = await get().uploadSubmission(o, files, actorName);
        if (!ok) return;
      } else if (!hasSubmitted(o, session.userId, actorName)) {
        get().pushToast({ title: i18n.t('submit.needUploadToast'), body: o.reminder.title, kind: 'info' });
        set({ selectedKey: o.key, mobileDetailOpen: true });
        return;
      }
    }
    const row: Omit<Completion, 'id' | 'completed_at'> = {
      reminder_id: o.reminder.id,
      occurrence_at: o.at.toISOString(),
      completed_by: session.userId,
      completed_by_name: actorName ?? '',
      note: '',
    };
    // 乐观更新
    set({
      completions: [...get().completions, { ...row, id: 'local-' + Math.random().toString(36).slice(2), completed_at: new Date().toISOString() }],
      toasts: get().toasts.filter((t) => t.occurrenceKey !== o.key),
    });
    try {
      await repo.addCompletion(row);
      await get().reload();
    } catch (e) {
      if (!online || !navigator.onLine) {
        const q = await readQueue();
        q.push({ id: Math.random().toString(36).slice(2), kind: 'completion', payload: row, queuedAt: new Date().toISOString() });
        await writeQueue(q);
        get().pushToast({ title: i18n.t('offline.queued'), body: '', kind: 'info' });
      } else {
        get().pushToast({ title: i18n.t('errors.saveFailed'), body: (e as Error).message, kind: 'error' });
        await get().reload();
      }
    }
  },

  async uncomplete(o) {
    const c = o.completion;
    if (!c) return;
    try {
      await get().repo.removeCompletion(c.id);
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: (e as Error).message, kind: 'error' });
    }
  },

  async snooze(o, minutes) {
    const { repo, session } = get();
    if (!session) return;
    const row: Omit<Snooze, 'id'> = {
      reminder_id: o.reminder.id,
      user_id: session.userId,
      occurrence_at: o.at.toISOString(),
      until: new Date(Date.now() + minutes * 60000).toISOString(),
    };
    set({ toasts: get().toasts.filter((t) => t.occurrenceKey !== o.key) });
    try {
      await repo.setSnooze(row);
      await get().reload();
    } catch {
      const q = await readQueue();
      q.push({ id: Math.random().toString(36).slice(2), kind: 'snooze', payload: row, queuedAt: new Date().toISOString() });
      await writeQueue(q);
      set({ snoozes: [...get().snoozes, { ...row, id: 'local-' + Math.random().toString(36).slice(2) }] });
    }
  },

  async adminUpdateProfile(id, patch) {
    try {
      await get().repo.updateProfile(id, patch);
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: (e as Error).message, kind: 'error' });
    }
  },
  async adminUpsertTeam(team) {
    try {
      await get().repo.upsertTeam(team);
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: (e as Error).message, kind: 'error' });
    }
  },
  async adminDeleteTeam(id) {
    try {
      await get().repo.deleteTeam(id);
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: (e as Error).message, kind: 'error' });
    }
  },
  async setMyLang(lang) {
    get().updateSettings({ lang });
    const { me, repo } = get();
    if (me && repo.mode === 'supabase') {
      try {
        await repo.updateProfile(me.id, { lang });
      } catch {
        /* 离线时下次再同步 */
      }
    }
  },
}));

export type { Assignee, Reminder };
