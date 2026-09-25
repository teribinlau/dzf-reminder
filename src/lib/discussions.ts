// 讨论的纯函数：可见范围、参与的人、未读（不依赖 store，store 和界面都能用）
import { teamIdsOf } from './occurrences';
import type { Discussion, DiscussionComment, DiscussionMember, Profile, TeamMembership } from './types';

/**
 * 时间字符串 → 毫秒。服务器给的是 2026-09-25T08:53:38.042279+00:00（微秒、带时区），
 * 本机的是 2026-09-25T08:53:38.042Z，不能直接比字符串；小数点后多于 3 位的先截掉（老 Safari 不认）。
 */
export function ts(iso: string | null | undefined): number {
  if (!iso) return 0;
  const n = Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(n) ? 0 : n;
}

/** 客户端侧的可见范围（和数据库里的 can_see_discussion 一致；服务器 RLS 也会拦，演示模式靠这个） */
export function canSeeDiscussion(d: Discussion, members: DiscussionMember[], me: Profile, memberships: TeamMembership[] = []): boolean {
  if (!me.active) return false;
  if (me.role === 'admin') return true;
  if (d.created_by === me.id || d.visibility === 'company') return true;
  const mine = teamIdsOf(me, memberships);
  return members.some((m) => m.discussion_id === d.id && (m.user_id === me.id || (!!m.team_id && mine.includes(m.team_id))));
}

/** 范围里的人（不含工位账号和停用的）：全公司 = 所有人；否则 = 点名的人 + 范围班组的人（兼任也算）+ 发起人 */
export function participantsOf(d: Discussion, members: DiscussionMember[], profiles: Profile[], memberships: TeamMembership[] = []): Profile[] {
  const people = profiles.filter((p) => p.active && !p.is_station);
  if (d.visibility === 'company') return people;
  const rows = members.filter((m) => m.discussion_id === d.id);
  const userIds = new Set(rows.map((m) => m.user_id).filter((x): x is string => !!x));
  const teamIds = new Set(rows.map((m) => m.team_id).filter((x): x is string => !!x));
  return people.filter((p) => p.id === d.created_by || userIds.has(p.id) || teamIdsOf(p, memberships).some((id) => teamIds.has(id)));
}

/** 范围里点到的人数（新建 / 编辑时底部显示「N 人参与」） */
export function countParticipants(
  visibility: Discussion['visibility'],
  userIds: string[],
  teamIds: string[],
  creatorId: string,
  profiles: Profile[],
  memberships: TeamMembership[] = [],
): number {
  const people = profiles.filter((p) => p.active && !p.is_station);
  if (visibility === 'company') return people.length;
  return people.filter((p) => p.id === creatorId || userIds.includes(p.id) || teamIdsOf(p, memberships).some((id) => teamIds.includes(id))).length;
}

/**
 * 我读到了哪一刻（毫秒）；undefined = 别人的讨论、我从没打开过。
 * 没打开过自己发起的讨论 = 读到了发起的那一刻（别人的回复照样算新的）；
 * 最近的动静是我自己弄的（留言 / 结束 / 改内容）= 那时候我肯定正看着，之前的都算看过了。
 */
export function readPoint(d: Discussion, meId: string, readAt: string | undefined): number | undefined {
  const base = readAt ?? (d.created_by === meId ? d.created_at : undefined);
  const mine = d.last_activity_by === meId ? ts(d.last_activity_at) : 0;
  if (base === undefined) return mine || undefined;
  return Math.max(ts(base), mine);
}

export interface UnreadInfo {
  /** 有我没看过的动静（新留言 / 改了内容 / 结束了 / 重新打开了） */
  unread: boolean;
  /** 从没打开过的新讨论 */
  isNew: boolean;
  /** 我没看过的别人的留言条数（只算已经加载的） */
  count: number;
}

/**
 * 未读：比较讨论的「最近动静」和我的已读位置（两个都是服务器时间，不受各人电脑时钟影响）。
 * 从没打开过的别人的讨论：还没结束的才算新的（新同事入职不会冒出一堆早就结束的旧讨论）。
 */
export function unreadOf(d: Discussion, meId: string, readAt: string | undefined, comments: DiscussionComment[]): UnreadInfo {
  const read = readPoint(d, meId, readAt);
  if (read === undefined) {
    if (d.closed_at) return { unread: false, isNew: false, count: 0 };
    return { unread: true, isNew: true, count: 0 };
  }
  const count = comments.filter((c) => c.discussion_id === d.id && c.author_id !== meId && ts(c.created_at) > read).length;
  const activity = ts(d.last_activity_at) > read && d.last_activity_by !== meId;
  return { unread: activity || count > 0, isNew: false, count };
}

/**
 * 日历上的筛选（全部 / 指派给我 / 我创建的 / 某个班组）用在有截止日期的讨论上：
 * - 指派给我 = 我在范围里：全公司的、我发起的、点了我或我的班组（兼任也算）的；管理员「能看到」但没被拉进来的不算
 * - 班组 = 范围里有这个班组，或者是这个班组的人发起的
 */
export function matchDiscussionFilter(
  d: Discussion,
  filter: string,
  members: DiscussionMember[],
  me: Profile,
  profiles: Profile[],
  memberships: TeamMembership[] = [],
): boolean {
  if (filter === 'created') return d.created_by === me.id;
  const rows = members.filter((m) => m.discussion_id === d.id);
  if (filter === 'mine') {
    if (d.visibility === 'company' || d.created_by === me.id) return true;
    const mine = teamIdsOf(me, memberships);
    return rows.some((m) => m.user_id === me.id || (!!m.team_id && mine.includes(m.team_id)));
  }
  if (filter.startsWith('team:')) {
    const teamId = filter.slice(5);
    return rows.some((m) => m.team_id === teamId) || profiles.find((p) => p.id === d.created_by)?.team_id === teamId;
  }
  return true;
}
