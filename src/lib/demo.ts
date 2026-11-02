// 演示模式：没有配置 Supabase 时使用的内存数据，让界面可以在 Vercel 上直接预览。
import { DISCUSSION_WINDOW_DAYS, type CommentDraft, type FileBucket, type Repo, type Session, type Snapshot, type StocktakeEvent, type SubmissionMeta } from './repo';
import type {
  Assignee,
  Attachment,
  Completion,
  Discussion,
  DiscussionComment,
  DiscussionFile,
  DiscussionInput,
  DiscussionMember,
  DiscussionRead,
  Profile,
  Reminder,
  ReminderInput,
  Snooze,
  StockMark,
  Stocktake,
  StocktakeImportRow,
  StocktakePhoto,
  StocktakeProgress,
  StocktakeRow,
  Submission,
  Team,
  TeamMembership,
} from './types';
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

/** 演示用的「库道示意图」：一张现画的 SVG */
const DEMO_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<rect width="1200" height="800" fill="#e9e6df"/>
${Array.from({ length: 6 }, (_, i) => `<rect x="${80 + i * 180}" y="120" width="120" height="560" rx="10" fill="${i === 2 ? '#6b4fbb' : '#c9c5bb'}"/><text x="${140 + i * 180}" y="100" font-family="sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="#121212">0${i + 1}L</text>`).join('')}
<text x="600" y="750" font-family="sans-serif" font-size="30" text-anchor="middle" fill="#6f6c65">B6 · 03L 本次盘点</text>
</svg>`;

/** 讨论里的两张演示图：B3 门口现状 / 摆放示意 */
const DEMO_GATE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
<rect width="1200" height="900" fill="#d9d4ca"/>
<rect x="0" y="560" width="1200" height="340" fill="#b9b2a5"/>
<rect x="360" y="120" width="480" height="440" fill="#5f5c55"/>
<rect x="380" y="140" width="440" height="420" fill="#8b867c"/>
${Array.from({ length: 5 }, (_, i) => `<rect x="${130 + i * 190}" y="${600 + (i % 2) * 70}" width="150" height="110" rx="6" fill="${i < 2 ? '#c8261f' : '#0e7c6b'}" opacity="0.9"/>`).join('')}
<text x="600" y="100" font-family="sans-serif" font-size="40" font-weight="700" text-anchor="middle" fill="#121212">B3 · 13:40</text>
</svg>`;
const DEMO_PLAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<rect width="1200" height="800" fill="#f6f5f1"/>
<rect x="80" y="120" width="360" height="560" rx="16" fill="#c8261f" opacity="0.18" stroke="#c8261f" stroke-width="6"/>
<rect x="760" y="120" width="360" height="560" rx="16" fill="#0e7c6b" opacity="0.18" stroke="#0e7c6b" stroke-width="6"/>
<rect x="480" y="80" width="240" height="640" fill="none" stroke="#d9a400" stroke-width="8" stroke-dasharray="24 18"/>
<text x="260" y="420" font-family="sans-serif" font-size="56" font-weight="800" text-anchor="middle" fill="#c8261f">DPD</text>
<text x="940" y="420" font-family="sans-serif" font-size="56" font-weight="800" text-anchor="middle" fill="#0e7c6b">FedEx</text>
<text x="600" y="420" font-family="sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="#121212">2 m</text>
</svg>`;

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

/** 柏林今天往后 dayOffset 天的日期 YYYY-MM-DD（讨论的截止日期用） */
function ymdIn(dayOffset: number): string {
  const now = toZonedTime(new Date(), TZ);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 从今天（柏林）数到这周五还有几天；今天就是周五 = 0，周六 / 周日 = 下周五 */
function daysToFriday(): number {
  return (5 - toZonedTime(new Date(), TZ).getDay() + 7) % 7;
}

/** 现在往前推 minutes 分钟，返回 ISO */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

function discussion(p: Partial<Discussion> & { title: string; created_by: string; created_at: string }): Discussion {
  return {
    id: uid(),
    body: '',
    created_by_name: '',
    visibility: 'members',
    closed_at: null,
    conclusion: '',
    due_date: null,
    comment_count: 0,
    last_activity_at: p.created_at,
    last_activity_by: p.created_by,
    updated_at: p.created_at,
    ...p,
  };
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
    title_de: null,
    notes_de: null,
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
    // Notion 同步函数 v3 起同时写德语版：固定词翻译、名字按对照表换、手写的备注原样
    title_de: 'Container 14:00 · FFAU8439517 · teknihall',
    notes_de: 'Wareneingangs-Nr.: RVH005-260720-0002\nContainer: 40"HQ\nHinweis: 9月18日取消后重新预约至今日 13:30-14:00',
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
    // 有一天写了完成留言（演示「留言并完成」）
    const n1 = d === 2 ? '司机 16:40 才到，16:30 前的单都已签出，后面 3 单转明天' : '';
    if (d !== 4) completions.push({ id: uid(), reminder_id: r1.id, occurrence_at: at(-d, '16:30'), completed_by: who[d % 3], completed_by_name: '', completed_at: at(-d, d % 2 ? '16:12' : '16:25'), note: n1 });
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
  completions.push({ id: uid(), reminder_id: r9.id, occurrence_at: r9.due_at, completed_by: 'u-li', completed_by_name: '', completed_at: at(0, '15:21'), note: '06L 第 3 层少 2 箱，已在表里标红' });
  // 兼任班组：小李主职盘点组，也帮入库组做事；Stefan 入库组兼出库组
  const memberships: TeamMembership[] = [
    { profile_id: 'u-li', team_id: T_IN },
    { profile_id: 'u-stefan', team_id: T_OUT },
  ];
  // 附件：月底盘点挂一张库道示意图 + 一份说明（演示文件是现画的占位图）
  const attachments: Attachment[] = [
    { id: uid(), reminder_id: r9.id, uploaded_by: DEMO_USERS.admin, file_path: 'demo-img/b6-lanes.svg', file_name: 'B6 库道示意.jpg', size: 412300, mime: 'image/jpeg', created_at: at(-1, '09:10') },
    { id: uid(), reminder_id: r9.id, uploaded_by: DEMO_USERS.admin, file_path: 'demo-file/inventur.pdf', file_name: '盘点操作说明.pdf', size: 188000, mime: 'application/pdf', created_at: at(-1, '09:11') },
  ];
  // ---------------------------------------------------------------------------
  // 讨论
  // ---------------------------------------------------------------------------
  const d1 = discussion({
    title: 'B3 门口的托盘总把通道堵住，怎么摆比较好？',
    body: '下午 DPD / FedEx 两边的托盘都往 B3 门口推，14:00 入库到柜时叉车过不去。\n照片是今天 13:40 拍的。大家看看有什么办法，周五前定下来。',
    created_by: 'u-markus',
    created_at: ago(26 * 60),
    due_date: ymdIn(daysToFriday()),
  });
  const d2 = discussion({
    title: '年底盘点放哪天？',
    body: '今年年底盘点需要全员参加一天，客户要求 12 月最后一周完成。附件是去年的安排，大家说一下哪天不方便。',
    created_by: DEMO_USERS.admin,
    visibility: 'company',
    created_at: ago(3 * 24 * 60),
    due_date: ymdIn(6),
  });
  const d3 = discussion({
    title: '新胶带机试用反馈',
    body: '打包台 1 换了新的胶带机，大家用了一周觉得怎么样？',
    created_by: DEMO_USERS.member,
    created_at: ago(9 * 24 * 60),
    closed_at: ago(2 * 24 * 60),
    conclusion: '效果不错，下周再买两台，放打包台 3 和 5。',
    due_date: ymdIn(-3),
    last_activity_by: DEMO_USERS.member,
    last_activity_at: ago(2 * 24 * 60),
  });
  const d4 = discussion({
    title: 'B1 区库位编号调整方案',
    body: '按新的货架编号规则调整 B1 区，旧标签统一换掉。',
    created_by: DEMO_USERS.admin,
    visibility: 'company',
    created_at: ago(160 * 24 * 60),
    closed_at: ago(150 * 24 * 60),
    conclusion: '按方案 B 执行，旧标签 5 月底前全部换完。',
    last_activity_by: DEMO_USERS.admin,
    last_activity_at: ago(150 * 24 * 60),
  });
  const discussions = [d1, d2, d3, d4];
  const discussionMembers: DiscussionMember[] = [
    { id: uid(), discussion_id: d1.id, user_id: null, team_id: T_OUT },
    { id: uid(), discussion_id: d1.id, user_id: 'u-wang', team_id: null },
    { id: uid(), discussion_id: d3.id, user_id: null, team_id: T_OUT },
  ];
  const c = (d: Discussion, author_id: string, minutesAgo: number, body: string, author_name = ''): DiscussionComment => ({
    id: uid(),
    discussion_id: d.id,
    author_id,
    author_name,
    body,
    created_at: ago(minutesAgo),
  });
  const comments: DiscussionComment[] = [
    c(d1, DEMO_USERS.member, 25 * 60, '建议 DPD 靠左、FedEx 靠右，中间留 2 米给叉车。我画了个图：'),
    c(d1, 'u-wang', 24 * 60, '入库这边 14:00 到柜，13:30 以后通道必须是空的。'),
    c(d1, 'u-markus', 3 * 60, '那就这样：13:30 前两边托盘都推到门两侧的黄线里，DPD 的司机 16:30 来之前不往中间放。'),
    c(d1, 'u-stefan', 40, 'Einverstanden. Ich klebe morgen die gelben Linien nach.'),
    c(d2, 'u-li', 2 * 24 * 60, '12 月 27 日（周六）比较好，那天没有到柜。'),
    c(d2, 'u-stefan', 20 * 60, 'Am 27. bin ich leider nicht da – ginge auch der 30.?'),
    c(d2, 'u-wang', 90, '30 号也可以，我都行。https://www.notion.so/614b65287de44dd4b9ba189892cb2387 这是去年的盘点表。'),
    c(d3, 'u-markus', 8 * 24 * 60, '比旧的快很多，封箱也平整。'),
    c(d3, DEMO_USERS.station, 7 * 24 * 60, '打包台 3 也想要一台。', 'Stefan Koch'),
    c(d3, DEMO_USERS.member, 2 * 24 * 60 + 5, '好，我去申请再买两台。'),
    c(d4, 'u-li', 158 * 24 * 60, '方案 B 好，盘点的时候不容易看错。'),
    c(d4, 'u-markus', 155 * 24 * 60, '同意，出库这边没问题。'),
  ];
  for (const d of discussions) {
    const mine = comments.filter((x) => x.discussion_id === d.id);
    d.comment_count = mine.length;
    const last = mine[mine.length - 1];
    if (last && !d.closed_at) {
      d.last_activity_at = last.created_at;
      d.last_activity_by = last.author_id;
    }
  }
  const discussionFiles: DiscussionFile[] = [
    { id: uid(), discussion_id: d1.id, comment_id: null, uploaded_by: 'u-markus', file_path: 'demo-img/b3-gate.svg', file_name: 'B3 门口 13-40.jpg', size: 386000, mime: 'image/jpeg', created_at: d1.created_at },
    { id: uid(), discussion_id: d1.id, comment_id: comments[0].id, uploaded_by: DEMO_USERS.member, file_path: 'demo-img/b3-plan.svg', file_name: '摆放示意.jpg', size: 204000, mime: 'image/jpeg', created_at: comments[0].created_at },
    { id: uid(), discussion_id: d2.id, comment_id: null, uploaded_by: DEMO_USERS.admin, file_path: 'demo-file/inventur-2025.pdf', file_name: '2025 年底盘点安排.pdf', size: 142000, mime: 'application/pdf', created_at: d2.created_at },
  ];
  // 已读位置：Jia 看过年底盘点（在 Stefan 留言之前）；Ahmed 看过托盘那条（在 Markus 定方案之前）
  const discussionReads: DiscussionRead[] = [
    { discussion_id: d2.id, user_id: DEMO_USERS.admin, last_read_at: comments[4].created_at },
    { discussion_id: d1.id, user_id: DEMO_USERS.member, last_read_at: comments[1].created_at },
    { discussion_id: d3.id, user_id: DEMO_USERS.admin, last_read_at: d3.last_activity_at },
  ];
  return {
    teams,
    profiles,
    memberships,
    reminders,
    assignees,
    completions,
    snoozes: [],
    submissions,
    attachments,
    discussions,
    discussionMembers,
    comments,
    discussionFiles,
    discussionReads,
    discussionsReady: true,
  };
}


// ---------------------------------------------------------------------------
// 演示用的盘点：4 厅 01 排、02/03 排、04/05 排的前几个位（数字是编的，SKU 都是 DEMO-…）
// ---------------------------------------------------------------------------
export const DEMO_TAKE_ID = 'st-demo-4';
const DEMO_CLOSED_ID = 'st-demo-3';

/** (排, 位, 层) → [系统, SKU, 在库, 待出, 标签][] ；没写的库位是空的 */
const DEMO_STOCK: Record<string, [string, string, number, number, string][]> = {
  '1-1-1': [['盘古', 'JQKJ-DEMO-5770', 48, 0, '']],
  '1-1-2': [['盘古', 'AL0066-DEMO-K2', 16, 6, ''], ['DECGN', 'Y190-DEMO-M5', 5, 0, '']],
  '1-2-1': [['DZF', 'BY1173-DEMO-01', 24, 24, '']],
  '1-2-2': [['盘古', 'B456-DEMO-RACK', 30, 2, '']],
  '1-2-3': [['盘古', 'H005-DEMO-TV55', 20, 0, '含不良 2']],
  '1-3-1': [['盘古', 'JQKJ-DEMO-5771', 12, 0, '']],
  '1-3-3': [['盘古', 'A856-DEMO-V5', 8, 0, '']],
  '2-1-1': [['盘古', 'AL0066-DEMO-D3', 40, 4, '']],
  '2-1-3': [['盘古', 'JQKJ-DEMO-5772', 60, 0, '']],
  '3-1-1': [['盘古', 'B311-DEMO-RANGER', 8, 3, ''], ['盘古', 'B311-DEMO-AURA', 4, 0, ''], ['DECGN', 'Y008-DEMO-SC', 2, 0, '']],
  '2-2-1': [['DZF', 'AIR0008-DEMO-EB', 100, 10, '']],
  '2-2-2': [['盘古', 'YIKOU-DEMO-01', 36, 0, '']],
  '3-2-1': [['盘古', 'L188-DEMO-MAT', 15, 0, '']],
  '3-2-2': [['DECGN', 'Y206-DEMO-BAT', 6, 6, '']],
  '2-3-1': [['盘古', 'G828-DEMO-CH', 22, 0, '']],
  '3-3-2': [['盘古', 'H083-DEMO-LAMP', 18, 4, '']],
  '4-1-1': [['盘古', 'JQKJ-DEMO-5773', 9, 0, '']],
  '5-1-2': [['盘古', 'A101-DEMO-H2', 5, 5, '']],
  '4-2-3': [['DZF', 'DZFD002-DEMO-SOFA', 3, 0, '']],
};

function demoStocktakeRows(takeId: string, hall: string): StocktakeRow[] {
  const plan: { aisle: string; racks: number[]; positions: number }[] = [
    { aisle: '01', racks: [1], positions: 3 },
    { aisle: '02-03', racks: [2, 3], positions: 3 },
    { aisle: '04-05', racks: [4, 5], positions: 2 },
  ];
  const rows: StocktakeRow[] = [];
  let n = 0;
  const pad = (x: number) => String(x).padStart(2, '0');
  const push = (aisle: string, pos: number, loc: string, first: boolean, item: [string, string, number, number, string] | null, extra = false) => {
    n += 1;
    const [wms, sku, onhand, out, tag] = item ?? ['', '', 0, 0, ''];
    rows.push({
      id: n,
      stocktake_id: takeId,
      seq: n,
      serial: `${hall}-${String(n).padStart(3, '0')}`,
      aisle,
      pos,
      loc,
      codes: [loc],
      is_first: first,
      sku,
      wms,
      customer: sku.split('-')[0] ?? '',
      lo: onhand - out,
      hi: onhand,
      tag,
      extra,
      info: { orig: loc, wh: wms === '盘古' ? 'B3' : wms === 'DZF' ? 'DZFDA' : wms },
      added: false,
      added_by: null,
      status: null,
      can_add: null,
      actual: null,
      note: '',
      counted_by: null,
      counted_by_name: '',
      counted_at: null,
    });
  };
  for (const a of plan) {
    for (let pos = 1; pos <= a.positions; pos++) {
      for (const rack of a.racks) {
        for (let tier = 1; tier <= 3; tier++) {
          const loc = `B${hall}-${pad(rack)}-${pad(pos)}-${pad(tier)}`;
          const items = DEMO_STOCK[`${rack}-${pos}-${tier}`] ?? [];
          if (!items.length) push(a.aisle, pos, loc, true, null);
          items.forEach((it, i) => push(a.aisle, pos, loc, i === 0, it));
        }
      }
    }
    if (a.aisle === '01') push('01', 45, `B${hall}-01-45-03`, true, null, true);
  }
  return rows;
}

function demoStocktakes(): { takes: Stocktake[]; rows: StocktakeRow[] } {
  const now = Date.now();
  const takes: Stocktake[] = [
    { id: DEMO_TAKE_ID, hall: '4', title: '4厅 库位空位盘点', exported_at: new Date(now - 40 * 60000).toISOString(), status: 'open', created_by: DEMO_USERS.admin, created_at: new Date(now - 35 * 60000).toISOString(), closed_at: null },
    { id: DEMO_CLOSED_ID, hall: '3', title: '3厅 库位空位盘点', exported_at: new Date(now - 6 * 86400000).toISOString(), status: 'closed', created_by: DEMO_USERS.admin, created_at: new Date(now - 6 * 86400000).toISOString(), closed_at: new Date(now - 5 * 86400000).toISOString() },
  ];
  const rows = demoStocktakeRows(DEMO_TAKE_ID, '4');
  // 已经有人盘了几个
  const at = new Date(now - 12 * 60000).toISOString();
  const mark = (loc: string, status: StocktakeRow['status'], extra: Partial<StocktakeRow> = {}) => {
    const r = rows.find((x) => x.loc === loc && x.is_first);
    if (r) Object.assign(r, { status, counted_by: DEMO_USERS.member, counted_by_name: 'Ahmed', counted_at: at, ...extra });
  };
  mark('B4-01-01-01', 'full');
  mark('B4-01-01-02', 'half', { can_add: 8 });
  mark('B4-01-01-03', 'empty');
  mark('B4-01-02-01', 'empty');
  const closedRows = demoStocktakeRows(DEMO_CLOSED_ID, '3').map((r, i) => ({ ...r, id: 10000 + i, status: r.is_first ? (r.hi > 0 ? 'full' : 'empty') : null, counted_by_name: 'Lena', counted_at: takes[1].closed_at })) as StocktakeRow[];
  return { takes, rows: [...rows, ...closedRows] };
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

  /** 演示模式没有真的登录：「仓库」页里会改成让人输访问口令 */
  async accessToken(): Promise<string | null> {
    return null;
  }

  async loadAll(): Promise<Snapshot> {
    const snap = JSON.parse(JSON.stringify(this.data)) as Snapshot;
    // 和服务器一样：留言只给最近 DISCUSSION_WINDOW_DAYS 天的，已读位置只给自己的
    const since = new Date(Date.now() - DISCUSSION_WINDOW_DAYS * 86400000).toISOString();
    snap.comments = snap.comments.filter((c) => c.created_at >= since);
    snap.discussionFiles = snap.discussionFiles.filter((f) => !f.comment_id || f.created_at >= since);
    snap.discussionReads = snap.discussionReads.filter((r) => r.user_id === this.session?.userId);
    snap.discussions.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
    return snap;
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
    return this.fileUrl('submissions', s.file_path);
  }

  async addAttachment(reminderId: string, userId: string, file: File): Promise<Attachment> {
    const row: Attachment = { id: uid(), reminder_id: reminderId, uploaded_by: userId, file_path: 'demo/' + uid(), file_name: file.name, size: file.size, mime: file.type, created_at: new Date().toISOString() };
    this.blobs.set(row.file_path, URL.createObjectURL(file));
    this.data.attachments.push(row);
    this.emit();
    return row;
  }

  async removeAttachment(a: Attachment): Promise<void> {
    this.data.attachments = this.data.attachments.filter((x) => x.id !== a.id);
    this.blobs.delete(a.file_path);
    this.emit();
  }

  async fileUrl(_bucket: FileBucket, path: string): Promise<string> {
    const u = this.blobs.get(path);
    if (u) return u;
    // 预置的演示文件：图片给一张现画的占位图，其他给一个空文件
    const svg = path === 'demo-img/b3-gate.svg' ? DEMO_GATE_SVG : path === 'demo-img/b3-plan.svg' ? DEMO_PLAN_SVG : DEMO_IMAGE_SVG;
    const blob = path.startsWith('demo-img/') ? new Blob([svg], { type: 'image/svg+xml' }) : new Blob(['demo'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    this.blobs.set(path, url);
    return url;
  }

  async fileUrls(bucket: FileBucket, paths: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const p of paths) out[p] = await this.fileUrl(bucket, p);
    return out;
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

  // ---------------------------------------------------------------------------
  // 讨论（演示模式：数据在内存里，时间用本机时钟）
  // ---------------------------------------------------------------------------
  private findDiscussion(id: string): Discussion {
    const d = this.data.discussions.find((x) => x.id === id);
    if (!d) throw new Error('not found');
    return d;
  }

  private touch(d: Discussion, by: string | null) {
    const now = new Date().toISOString();
    d.last_activity_at = now;
    d.last_activity_by = by;
    d.updated_at = now;
  }

  private applyDiscussionMembers(discussionId: string, input: DiscussionInput) {
    this.data.discussionMembers = this.data.discussionMembers.filter((m) => m.discussion_id !== discussionId);
    if (input.visibility === 'company') return;
    input.member_user_ids.forEach((user_id) => this.data.discussionMembers.push({ id: uid(), discussion_id: discussionId, user_id, team_id: null }));
    input.member_team_ids.forEach((team_id) => this.data.discussionMembers.push({ id: uid(), discussion_id: discussionId, user_id: null, team_id }));
  }

  async createDiscussion(input: DiscussionInput, userId: string): Promise<string> {
    const d = discussion({
      title: input.title,
      body: input.body,
      visibility: input.visibility,
      created_by: userId,
      created_by_name: input.created_by_name,
      due_date: input.due_date,
      created_at: new Date().toISOString(),
    });
    this.data.discussions.push(d);
    this.applyDiscussionMembers(d.id, input);
    this.emit();
    return d.id;
  }

  async updateDiscussion(id: string, input: DiscussionInput): Promise<void> {
    const d = this.findDiscussion(id);
    if (d.closed_at) throw new Error('discussion is closed');
    Object.assign(d, { title: input.title, body: input.body, visibility: input.visibility, due_date: input.due_date });
    this.touch(d, this.session?.userId ?? null);
    this.applyDiscussionMembers(id, input);
    this.emit();
  }

  async setDiscussionClosed(id: string, closed: boolean, conclusion?: string): Promise<void> {
    const d = this.findDiscussion(id);
    if (d.created_by !== this.session?.userId) throw new Error('only the creator can close / reopen this discussion');
    d.closed_at = closed ? new Date().toISOString() : null;
    if (closed) d.conclusion = conclusion ?? '';
    this.touch(d, this.session.userId);
    this.emit();
  }

  async deleteDiscussion(id: string): Promise<void> {
    for (const f of this.data.discussionFiles.filter((x) => x.discussion_id === id)) this.blobs.delete(f.file_path);
    this.data.discussions = this.data.discussions.filter((x) => x.id !== id);
    this.data.discussionMembers = this.data.discussionMembers.filter((x) => x.discussion_id !== id);
    this.data.comments = this.data.comments.filter((x) => x.discussion_id !== id);
    this.data.discussionFiles = this.data.discussionFiles.filter((x) => x.discussion_id !== id);
    this.data.discussionReads = this.data.discussionReads.filter((x) => x.discussion_id !== id);
    this.emit();
  }

  private demoFile(discussionId: string, userId: string, file: File, commentId: string | null): DiscussionFile {
    const row: DiscussionFile = {
      id: uid(),
      discussion_id: discussionId,
      comment_id: commentId,
      uploaded_by: userId,
      file_path: 'demo/' + uid(),
      file_name: file.name,
      size: file.size,
      mime: file.type,
      created_at: new Date().toISOString(),
    };
    this.blobs.set(row.file_path, URL.createObjectURL(file));
    return row;
  }

  async addDiscussionFile(discussionId: string, userId: string, file: File): Promise<DiscussionFile> {
    const row = this.demoFile(discussionId, userId, file, null);
    this.data.discussionFiles.push(row);
    this.emit();
    return row;
  }

  async removeDiscussionFile(f: DiscussionFile): Promise<void> {
    this.data.discussionFiles = this.data.discussionFiles.filter((x) => x.id !== f.id);
    this.blobs.delete(f.file_path);
    this.emit();
  }

  async addComment(c: CommentDraft, files: File[], onProgress?: (done: number) => void): Promise<{ comment: DiscussionComment; files: DiscussionFile[] }> {
    const d = this.findDiscussion(c.discussion_id);
    if (d.closed_at) throw new Error('discussion is closed');
    const comment: DiscussionComment = { ...c, id: uid(), created_at: new Date().toISOString() };
    const rows: DiscussionFile[] = [];
    for (const f of files) {
      rows.push(this.demoFile(c.discussion_id, c.author_id, f, comment.id));
      onProgress?.(rows.length);
    }
    this.data.comments.push(comment);
    this.data.discussionFiles.push(...rows);
    d.comment_count += 1;
    d.last_activity_at = comment.created_at;
    d.last_activity_by = c.author_id;
    this.emit();
    return { comment, files: rows };
  }

  async removeComment(c: DiscussionComment, files: DiscussionFile[]): Promise<void> {
    this.data.comments = this.data.comments.filter((x) => x.id !== c.id);
    this.data.discussionFiles = this.data.discussionFiles.filter((x) => x.comment_id !== c.id);
    files.forEach((f) => this.blobs.delete(f.file_path));
    const d = this.data.discussions.find((x) => x.id === c.discussion_id);
    if (d) d.comment_count = Math.max(0, d.comment_count - 1);
    this.emit();
  }

  async markDiscussionRead(discussionId: string, userId: string, at: string): Promise<void> {
    const r = this.data.discussionReads.find((x) => x.discussion_id === discussionId && x.user_id === userId);
    if (r) {
      if (at > r.last_read_at) r.last_read_at = at;
    } else this.data.discussionReads.push({ discussion_id: discussionId, user_id: userId, last_read_at: at });
    this.emit();
  }

  async loadThread(discussionId: string): Promise<{ comments: DiscussionComment[]; files: DiscussionFile[] }> {
    const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
    return {
      comments: copy(this.data.comments.filter((x) => x.discussion_id === discussionId)),
      files: copy(this.data.discussionFiles.filter((x) => x.discussion_id === discussionId)),
    };
  }

  // ---------------------------------------------------------------------------
  // 库位空位盘点（演示：内存里，规则和数据库里的函数一样）
  // ---------------------------------------------------------------------------
  private st = demoStocktakes();
  private stPhotos: StocktakePhoto[] = [];
  private stListeners = new Set<(e: StocktakeEvent) => void>();
  private stNextId = 50000;

  private stEmit(e: StocktakeEvent) {
    this.stListeners.forEach((l) => l(e));
  }

  /** 测试用：window.__dzfOffline = true 时模拟断网（只在演示模式） */
  private stNet() {
    if ((globalThis as { __dzfOffline?: boolean }).__dzfOffline) throw new TypeError('Failed to fetch');
  }

  private stMe() {
    return this.data.profiles.find((p) => p.id === this.session?.userId) ?? null;
  }

  private stAt(at: string | null): string {
    const now = Date.now();
    const t = at ? Date.parse(at) : now;
    return new Date(Math.min(now, Math.max(Number.isNaN(t) ? now : t, now - 86400000))).toISOString();
  }

  private stOpen(takeId: string) {
    const t = this.st.takes.find((x) => x.id === takeId);
    if (!t) throw Object.assign(new Error('stocktake not found'), { code: 'P0002' });
    if (t.status !== 'open') throw Object.assign(new Error('stocktake is closed'), { code: '42501' });
    return t;
  }

  async listStocktakes(): Promise<{ ready: boolean; takes: Stocktake[]; progress: StocktakeProgress[] }> {
    this.stNet();
    const progress = this.st.takes.map((t) => {
      const heads = this.st.rows.filter((r) => r.stocktake_id === t.id && r.is_first && !r.added);
      return { stocktake_id: t.id, locations: heads.length, counted: heads.filter((r) => r.status).length };
    });
    const takes = [...this.st.takes].sort((a, b) => b.created_at.localeCompare(a.created_at));
    return JSON.parse(JSON.stringify({ ready: true, takes, progress }));
  }

  async loadStocktake(id: string): Promise<{ rows: StocktakeRow[]; photos: StocktakePhoto[] }> {
    this.stNet();
    const rows = this.st.rows.filter((r) => r.stocktake_id === id);
    const photos = this.stPhotos.filter((p) => p.stocktake_id === id);
    return JSON.parse(JSON.stringify({ rows, photos }));
  }

  async createStocktake(meta: Pick<Stocktake, 'hall' | 'title' | 'exported_at'>, rows: StocktakeImportRow[], userId: string, onProgress?: (done: number) => void): Promise<string> {
    this.stNet();
    const id = 'st-' + uid();
    const take: Stocktake = { ...meta, id, status: 'open', created_by: userId, created_at: new Date().toISOString(), closed_at: null };
    this.st.takes.push(take);
    for (let i = 0; i < rows.length; i++) {
      this.st.rows.push({ ...rows[i], id: this.stNextId++, stocktake_id: id, added: false, added_by: null, status: null, can_add: null, actual: null, note: '', counted_by: null, counted_by_name: '', counted_at: null });
      if ((i + 1) % 500 === 0) onProgress?.(i + 1);
    }
    onProgress?.(rows.length);
    this.stEmit({ table: 'stocktakes', type: 'INSERT', row: { ...take } });
    return id;
  }

  async setStocktakeStatus(id: string, status: Stocktake['status']): Promise<void> {
    this.stNet();
    const t = this.st.takes.find((x) => x.id === id);
    if (!t || this.stMe()?.role !== 'admin') throw new Error('not allowed');
    t.status = status;
    t.closed_at = status === 'closed' ? new Date().toISOString() : null;
    this.stEmit({ table: 'stocktakes', type: 'UPDATE', row: { ...t } });
  }

  async deleteStocktake(id: string): Promise<void> {
    this.stNet();
    if (this.stMe()?.role !== 'admin') throw new Error('not allowed');
    this.st.takes = this.st.takes.filter((t) => t.id !== id);
    this.st.rows = this.st.rows.filter((r) => r.stocktake_id !== id);
    this.stPhotos = this.stPhotos.filter((p) => p.stocktake_id !== id);
    this.stEmit({ table: 'stocktakes', type: 'DELETE', oldId: id });
  }

  async markStocktakeRow(rowId: number, m: StockMark, name: string, at: string): Promise<StocktakeRow> {
    this.stNet();
    const r = this.st.rows.find((x) => x.id === rowId);
    if (!r) throw Object.assign(new Error('row not found'), { code: 'P0002' });
    this.stOpen(r.stocktake_id);
    const when = this.stAt(at);
    if (r.counted_at && when < r.counted_at) return JSON.parse(JSON.stringify(r));
    const status = r.is_first ? m.status : null;
    const note = (m.note ?? '').trim().slice(0, 500);
    const clear = status === null && m.actual === null && note === '';
    Object.assign(r, {
      status,
      can_add: status === 'half' ? m.can_add : null,
      actual: m.actual,
      note,
      counted_by: clear ? null : this.session?.userId ?? null,
      counted_by_name: clear ? '' : name.trim() || this.stMe()?.name || '',
      counted_at: clear ? null : when,
    });
    this.stEmit({ table: 'stocktake_rows', type: 'UPDATE', row: { ...r } });
    return JSON.parse(JSON.stringify(r));
  }

  async addFoundRow(takeId: string, loc: string, sku: string, qty: number | null, note: string, name: string, at: string): Promise<StocktakeRow> {
    this.stNet();
    this.stOpen(takeId);
    const base = this.st.rows.find((r) => r.stocktake_id === takeId && r.loc === loc && r.is_first && !r.added);
    if (!base) throw Object.assign(new Error('unknown location'), { code: 'P0002' });
    const cleanSku = sku.trim().toUpperCase().slice(0, 80);
    const cleanNote = note.trim().slice(0, 500);
    if (!cleanSku && !cleanNote) throw Object.assign(new Error('sku or note is required'), { code: '22023' });
    const same = this.st.rows.filter((r) => r.stocktake_id === takeId && r.loc === loc);
    let n = same.filter((r) => r.added).length + 1;
    while (same.some((r) => r.serial === `${base.serial}+${n}`)) n += 1;
    const row: StocktakeRow = {
      ...base,
      id: this.stNextId++,
      seq: Math.max(...same.map((r) => r.seq)),
      serial: `${base.serial}+${n}`,
      is_first: false,
      sku: cleanSku,
      wms: '',
      customer: '',
      lo: 0,
      hi: 0,
      tag: '',
      info: {},
      added: true,
      added_by: this.session?.userId ?? null,
      status: null,
      can_add: null,
      actual: qty,
      note: cleanNote,
      counted_by: this.session?.userId ?? null,
      counted_by_name: name.trim() || this.stMe()?.name || '',
      counted_at: this.stAt(at),
    };
    this.st.rows.push(row);
    this.stEmit({ table: 'stocktake_rows', type: 'INSERT', row: { ...row } });
    return JSON.parse(JSON.stringify(row));
  }

  async deleteFoundRow(rowId: number): Promise<void> {
    this.stNet();
    const r = this.st.rows.find((x) => x.id === rowId);
    if (!r) return;
    if (!r.added || (r.added_by !== this.session?.userId && this.stMe()?.role !== 'admin')) throw Object.assign(new Error('not allowed'), { code: '42501' });
    this.stOpen(r.stocktake_id);
    this.st.rows = this.st.rows.filter((x) => x.id !== rowId);
    this.stEmit({ table: 'stocktake_rows', type: 'DELETE', oldId: rowId });
  }

  async addStocktakePhoto(takeId: string, loc: string, userId: string, name: string, file: File): Promise<StocktakePhoto> {
    this.stNet();
    this.stOpen(takeId);
    const p: StocktakePhoto = { id: uid(), stocktake_id: takeId, loc, file_path: `${takeId}/${uid()}`, file_name: file.name, size: file.size, mime: file.type, uploaded_by: userId, uploaded_by_name: name, created_at: new Date().toISOString() };
    this.blobs.set(p.file_path, URL.createObjectURL(file));
    this.stPhotos.push(p);
    this.stEmit({ table: 'stocktake_photos', type: 'INSERT', row: { ...p } });
    return { ...p };
  }

  async removeStocktakePhoto(p: StocktakePhoto): Promise<void> {
    this.stNet();
    if (p.uploaded_by !== this.session?.userId && this.stMe()?.role !== 'admin') throw new Error('not allowed');
    this.stPhotos = this.stPhotos.filter((x) => x.id !== p.id);
    this.blobs.delete(p.file_path);
    this.stEmit({ table: 'stocktake_photos', type: 'DELETE', oldId: p.id });
  }

  subscribeStocktakes(onEvent: (e: StocktakeEvent) => void): () => void {
    this.stListeners.add(onEvent);
    return () => this.stListeners.delete(onEvent);
  }
}
