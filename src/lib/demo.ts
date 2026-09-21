// 演示模式：没有配置 Supabase 时使用的内存数据，让界面可以在 Vercel 上直接预览。
import type { Repo, Session, Snapshot, SubmissionMeta } from './repo';
import type { Assignee, Completion, Profile, Reminder, ReminderInput, Snooze, Submission, Team, TeamMembership } from './types';
import { localToUtc } from './recurrence';
import { toZonedTime } from 'date-fns-tz';
import { TZ } from './types';

const T_IN = '11111111-1111-4111-8111-111111111111';
const T_OUT = '22222222-2222-4222-8222-222222222222';
const T_INV = '33333333-3333-4333-8333-333333333333';
const T_MGMT = '44444444-4444-4444-8444-444444444444';

export const DEMO_USERS = {
  admin: 'u-jia',
  member: 'u-ahmed',
  station: 'u-station-1',
};

function uid(): string {
  return 'd-' + Math.random().toString(36).slice(2, 10);
}

/** 今天（柏林时间）某个 HH:mm，偏移 dayOffset 天，返回 ISO */
function at(dayOffset: number, hm: string): string {
  const now = toZonedTime(new Date(), TZ);
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
  return localToUtc(d.getFullYear(), d.getMonth() + 1, d.getDate(), h, m).toISOString();
}

function reminder(p: Partial<Reminder> & { title: string; due_at: string; created_by: string }): Reminder {
  return {
    id: uid(),
    notes: '',
    tz: TZ,
    rrule: null,
    skip_holidays: true,
    remind_before_min: 15,
    overdue_repeat_min: 30,
    priority: 'medium',
    visibility: 'team',
    team_id: null,
    link: '',
    completion_mode: 'any',
    require_upload: false,
    archived: false,
    source: null,
    source_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...p,
  };
}

function buildSnapshot(): Snapshot {
  const teams: Team[] = [
    { id: T_IN, name_zh: '入库组', name_de: 'Wareneingang', color: '#3B7A2A', sort: 1 },
    { id: T_OUT, name_zh: '出库组', name_de: 'Versand', color: '#0E7C6B', sort: 2 },
    { id: T_INV, name_zh: '盘点组', name_de: 'Inventur', color: '#6B4FBB', sort: 3 },
    { id: T_MGMT, name_zh: '管理', name_de: 'Verwaltung', color: '#A8560A', sort: 4 },
  ];
  const profiles: Profile[] = [
    { id: DEMO_USERS.admin, email: 'jia@dzf.local', name: 'Jia Liu', team_id: T_MGMT, role: 'admin', lang: 'zh-CN', is_station: false, active: true },
    { id: 'u-markus', email: 'markus@dzf.local', name: 'Markus Weber', team_id: T_OUT, role: 'admin', lang: 'de-DE', is_station: false, active: true },
    { id: DEMO_USERS.member, email: 'ahmed@dzf.local', name: 'Ahmed Karim', team_id: T_OUT, role: 'member', lang: 'de-DE', is_station: false, active: true },
    { id: 'u-wang', email: 'wang@dzf.local', name: '小王', team_id: T_IN, role: 'member', lang: 'zh-CN', is_station: false, active: true },
    { id: 'u-li', email: 'li@dzf.local', name: '小李', team_id: T_INV, role: 'member', lang: 'zh-CN', is_station: false, active: true },
    { id: 'u-elena', email: 'elena@dzf.local', name: 'Elena Petrova', team_id: T_OUT, role: 'member', lang: 'de-DE', is_station: false, active: false },
    { id: 'u-stefan', email: 'stefan@dzf.local', name: 'Stefan Koch', team_id: T_IN, role: 'member', lang: 'de-DE', is_station: false, active: true },
    { id: DEMO_USERS.station, email: 'station1@dzf.local', name: '出库工位 1', team_id: T_OUT, role: 'member', lang: 'zh-CN', is_station: true, active: true },
  ];
  const r1 = reminder({
    title: 'DPD 截单 — 完成打包并签出所有 DPD 订单',
    notes: '所有 DPD 渠道（Classic / Predict）的订单必须在 16:30 前完成打包并在 WMS 签出，之后到的订单转次日。司机不等人，托盘先推到 B3 门口。',
    due_at: at(-10, '16:30'),
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    priority: 'high',
    visibility: 'company',
    team_id: T_OUT,
    created_by: DEMO_USERS.admin,
    link: 'https://dzf.wms.yunwms.com/',
  });
  const r2 = reminder({
    title: 'FedEx 取件 — 托盘放到 B3 装货口，随附交接单',
    due_at: at(-10, '17:00'),
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    priority: 'high',
    visibility: 'company',
    team_id: T_OUT,
    created_by: DEMO_USERS.admin,
  });
  const r3 = reminder({
    title: '到柜 14:00 · FFAU8439517 · 盘古',
    notes: '入库单号：RVH005-260720-0002\n货柜：40"HQ\n备注：9月18日取消后重新预约至今日 13:30-14:00',
    due_at: at(0, '14:00'),
    remind_before_min: 30,
    overdue_repeat_min: 60,
    priority: 'medium',
    team_id: T_IN,
    link: 'https://www.notion.so/614b65287de44dd4b9ba189892cb2387',
    source: 'notion',
    source_key: 'demo:page:1',
    created_by: DEMO_USERS.admin,
  });
  const r4 = reminder({
    title: 'B6 盘点 06L 库道 — 核对 LT0002EU / LT0012 手写备注',
    due_at: at(0, '10:00'),
    team_id: T_INV,
    created_by: DEMO_USERS.admin,
  });
  const r5 = reminder({
    title: '核实库位 020101302702 — 8-31 移库后半移的余量',
    due_at: at(-1, '16:00'),
    priority: 'high',
    team_id: T_INV,
    created_by: DEMO_USERS.admin,
  });
  const r6 = reminder({
    title: 'Raben 整托发货 — 打印标签并备货 2 托',
    notes: 'Raben 司机 09:30 到，2 托 B696 整托。标签用 Raben 模板，托盘贴四面。',
    due_at: at(1, '09:00'),
    remind_before_min: 60,
    team_id: T_OUT,
    created_by: DEMO_USERS.member,
  });
  const r7 = reminder({
    title: 'B1 区 Regal 02–11 库位标签打印 — Regal 01 试贴确认后开工',
    due_at: at(1, '15:00'),
    visibility: 'private',
    priority: 'low',
    team_id: T_MGMT,
    created_by: DEMO_USERS.admin,
  });
  const r8 = reminder({
    title: '周报：库存差异汇总发给各客户',
    due_at: at(-12, '12:00'),
    rrule: 'FREQ=WEEKLY;BYDAY=FR',
    team_id: T_MGMT,
    visibility: 'private',
    created_by: DEMO_USERS.admin,
  });
  const r9 = reminder({
    title: '月底盘点 — 每人把自己库道的盘点表填好传上来',
    notes: '用下面的模板，按库道填数量和差异，拍照或存成 Excel 都行。交了文件才算完成。',
    due_at: at(0, '17:00'),
    remind_before_min: 60,
    team_id: T_INV,
    visibility: 'company',
    completion_mode: 'each',
    require_upload: true,
    link: '盘点表模板 https://docs.google.com/spreadsheets/d/1abc\nB6 库道 SKU 清单 https://www.notion.so/614b65287de44dd4b9ba189892cb2387',
    created_by: DEMO_USERS.admin,
  });
  const reminders = [r1, r2, r3, r4, r5, r6, r7, r8, r9];
  const assignees: Assignee[] = [
    { id: uid(), reminder_id: r1.id, user_id: null, team_id: T_OUT },
    { id: uid(), reminder_id: r2.id, user_id: 'u-markus', team_id: null },
    { id: uid(), reminder_id: r3.id, user_id: 'u-wang', team_id: null },
    { id: uid(), reminder_id: r3.id, user_id: DEMO_USERS.member, team_id: null },
    { id: uid(), reminder_id: r4.id, user_id: 'u-li', team_id: null },
    { id: uid(), reminder_id: r5.id, user_id: 'u-li', team_id: null },
    { id: uid(), reminder_id: r6.id, user_id: DEMO_USERS.member, team_id: null },
    { id: uid(), reminder_id: r6.id, user_id: null, team_id: T_OUT },
    { id: uid(), reminder_id: r7.id, user_id: DEMO_USERS.admin, team_id: null },
    { id: uid(), reminder_id: r8.id, user_id: DEMO_USERS.admin, team_id: null },
    { id: uid(), reminder_id: r9.id, user_id: null, team_id: T_INV },
    { id: uid(), reminder_id: r9.id, user_id: 'u-wang', team_id: null },
    { id: uid(), reminder_id: r9.id, user_id: 'u-stefan', team_id: null },
  ];
  const completions: Completion[] = [
    { id: uid(), reminder_id: r4.id, occurrence_at: r4.due_at, completed_by: 'u-li', completed_by_name: '', completed_at: at(0, '09:48'), note: '' },
  ];
  // 过去 10 个工作日的 DPD / FedEx 都已完成，只留两天「未完成」做演示
  const who = [DEMO_USERS.member, 'u-wang', 'u-markus'];
  for (let d = 1; d <= 12; d++) {
    const wd = toZonedTime(new Date(at(-d, '12:00')), TZ).getDay();
    if (wd === 0 || wd === 6) continue;
    if (d !== 4) completions.push({ id: uid(), reminder_id: r1.id, occurrence_at: at(-d, '16:30'), completed_by: who[d % 3], completed_by_name: '', completed_at: at(-d, d % 2 ? '16:12' : '16:25'), note: '' });
    if (d !== 6) completions.push({ id: uid(), reminder_id: r2.id, occurrence_at: at(-d, '17:00'), completed_by: 'u-markus', completed_by_name: '', completed_at: at(-d, '16:58'), note: '' });
  }
  // 上周五的周报也完成了
  for (let d = 1; d <= 12; d++) {
    if (toZonedTime(new Date(at(-d, '12:00')), TZ).getDay() === 5) {
      completions.push({ id: uid(), reminder_id: r8.id, occurrence_at: at(-d, '12:00'), completed_by: DEMO_USERS.admin, completed_by_name: '', completed_at: at(-d, '11:40'), note: '' });
    }
  }
  // 盘点表：小李已经交了一份并完成，小王 / Stefan 还没交
  const submissions: Submission[] = [
    { id: uid(), reminder_id: r9.id, occurrence_at: r9.due_at, uploaded_by: 'u-li', uploaded_by_name: '', file_path: 'demo/inv-06L.xlsx', file_name: '盘点表_06L_小李.xlsx', size: 48213, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', created_at: at(0, '15:20') },
  ];
  completions.push({ id: uid(), reminder_id: r9.id, occurrence_at: r9.due_at, completed_by: 'u-li', completed_by_name: '', completed_at: at(0, '15:21'), note: '' });
  // 兼任班组：小李主职盘点组，也帮入库组做事；Stefan 入库组兼出库组
  const memberships: TeamMembership[] = [
    { profile_id: 'u-li', team_id: T_IN },
    { profile_id: 'u-stefan', team_id: T_OUT },
  ];
  return { teams, profiles, memberships, reminders, assignees, completions, snoozes: [], submissions };
}

export class DemoRepo implements Repo {
  mode = 'demo' as const;
  private data: Snapshot = buildSnapshot();
  private session: Session | null = null;
  private listeners = new Set<() => void>();
  private authListeners = new Set<(s: Session | null) => void>();

  private emit() {
    this.listeners.forEach((l) => l());
  }

  async getSession(): Promise<Session | null> {
    return this.session;
  }

  onAuthChange(cb: (s: Session | null) => void): () => void {
    this.authListeners.add(cb);
    return () => this.authListeners.delete(cb);
  }

  async signInWithEmail(): Promise<void> {
    throw new Error('demo');
  }

  async verifyEmailCode(): Promise<void> {
    throw new Error('demo');
  }

  async signInDemo(userId: string): Promise<void> {
    const p = this.data.profiles.find((x) => x.id === userId);
    this.session = p ? { userId: p.id, email: p.email } : null;
    this.authListeners.forEach((l) => l(this.session));
  }

  async signOut(): Promise<void> {
    this.session = null;
    this.authListeners.forEach((l) => l(null));
  }

  async loadAll(): Promise<Snapshot> {
    return JSON.parse(JSON.stringify(this.data)) as Snapshot;
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  private applyAssignees(reminderId: string, input: ReminderInput) {
    this.data.assignees = this.data.assignees.filter((a) => a.reminder_id !== reminderId);
    input.assignee_user_ids.forEach((user_id) => this.data.assignees.push({ id: uid(), reminder_id: reminderId, user_id, team_id: null }));
    input.assignee_team_ids.forEach((team_id) => this.data.assignees.push({ id: uid(), reminder_id: reminderId, user_id: null, team_id }));
  }

  async createReminder(input: ReminderInput, userId: string): Promise<string> {
    const r = reminder({ ...input, created_by: userId });
    this.data.reminders.push(r);
    this.applyAssignees(r.id, input);
    this.emit();
    return r.id;
  }

  async updateReminder(id: string, input: ReminderInput): Promise<void> {
    const r = this.data.reminders.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, input, { updated_at: new Date().toISOString() });
    this.applyAssignees(id, input);
    this.emit();
  }

  async deleteReminder(id: string): Promise<void> {
    this.data.reminders = this.data.reminders.filter((x) => x.id !== id);
    this.emit();
  }

  async addCompletion(c: Omit<Completion, 'id' | 'completed_at'>): Promise<void> {
    this.data.completions = this.data.completions.filter(
      (x) => !(x.reminder_id === c.reminder_id && x.occurrence_at === c.occurrence_at && x.completed_by === c.completed_by),
    );
    this.data.completions.push({ ...c, id: uid(), completed_at: new Date().toISOString() });
    this.emit();
  }

  async removeCompletion(id: string): Promise<void> {
    this.data.completions = this.data.completions.filter((x) => x.id !== id);
    this.emit();
  }

  async setSnooze(s: Omit<Snooze, 'id'>): Promise<void> {
    this.data.snoozes = this.data.snoozes.filter(
      (x) => !(x.reminder_id === s.reminder_id && x.user_id === s.user_id && x.occurrence_at === s.occurrence_at),
    );
    this.data.snoozes.push({ ...s, id: uid() });
    this.emit();
  }

  async clearSnooze(reminderId: string, userId: string, occurrenceAt: string): Promise<void> {
    this.data.snoozes = this.data.snoozes.filter(
      (x) => !(x.reminder_id === reminderId && x.user_id === userId && x.occurrence_at === occurrenceAt),
    );
    this.emit();
  }

  private blobs = new Map<string, string>(); // 演示模式：文件只存在内存里

  async addSubmission(meta: SubmissionMeta, file: File): Promise<Submission> {
    const row: Submission = { ...meta, id: uid(), file_path: 'demo/' + uid(), file_name: file.name, size: file.size, mime: file.type, created_at: new Date().toISOString() };
    this.blobs.set(row.file_path, URL.createObjectURL(file));
    this.data.submissions.push(row);
    this.emit();
    return row;
  }

  async removeSubmission(s: Submission): Promise<void> {
    this.data.submissions = this.data.submissions.filter((x) => x.id !== s.id);
    this.blobs.delete(s.file_path);
    this.emit();
  }

  async submissionUrl(s: Submission): Promise<string> {
    const u = this.blobs.get(s.file_path);
    if (u) return u;
    // 预置的演示文件：给一个空文件
    const url = URL.createObjectURL(new Blob(['demo'], { type: 'text/plain' }));
    this.blobs.set(s.file_path, url);
    return url;
  }

  async updateProfile(id: string, patch: Partial<Profile>): Promise<void> {
    const p = this.data.profiles.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
    this.emit();
  }

  async setMemberships(profileId: string, teamIds: string[]): Promise<void> {
    this.data.memberships = this.data.memberships.filter((m) => m.profile_id !== profileId);
    for (const team_id of teamIds) this.data.memberships.push({ profile_id: profileId, team_id });
    this.emit();
  }

  async upsertTeam(team: Partial<Team> & { name_zh: string; name_de: string; color: string }): Promise<void> {
    const existing = team.id ? this.data.teams.find((t) => t.id === team.id) : undefined;
    if (existing) Object.assign(existing, team);
    else this.data.teams.push({ id: uid(), sort: this.data.teams.length + 1, ...team } as Team);
    this.emit();
  }

  async deleteTeam(id: string): Promise<void> {
    this.data.teams = this.data.teams.filter((t) => t.id !== id);
    this.data.memberships = this.data.memberships.filter((m) => m.team_id !== id);
    this.emit();
  }
}
