import { useMemo } from 'react';
import { useStore } from './store';
import { canSeeDiscussion, matchDiscussionFilter, ts, unreadOf, type UnreadInfo } from './discussions';
import type { Discussion } from './types';

export interface DiscussionsState {
  /** 进行中：最近有动静的排前面 */
  open: Discussion[];
  /** 已结束：最近结束的排前面 */
  closed: Discussion[];
  unread: Map<string, UnreadInfo>;
  /** 有未读的讨论个数（「讨论」入口上的数字） */
  unreadTotal: number;
  /** 我在各讨论里读到的位置 */
  readAt: Map<string, string>;
}

const EMPTY: DiscussionsState = { open: [], closed: [], unread: new Map(), unreadTotal: 0, readAt: new Map() };

/** 从 store 派生：我能看到的讨论 + 未读情况 */
export function useDiscussions(): DiscussionsState {
  const discussions = useStore((s) => s.discussions);
  const members = useStore((s) => s.discussionMembers);
  const comments = useStore((s) => s.comments);
  const reads = useStore((s) => s.discussionReads);
  const memberships = useStore((s) => s.memberships);
  const me = useStore((s) => s.me);
  return useMemo(() => {
    if (!me) return EMPTY;
    const readAt = new Map(reads.filter((r) => r.user_id === me.id).map((r) => [r.discussion_id, r.last_read_at]));
    const visible = discussions.filter((d) => canSeeDiscussion(d, members, me, memberships));
    const unread = new Map<string, UnreadInfo>();
    let unreadTotal = 0;
    for (const d of visible) {
      const u = unreadOf(d, me.id, readAt.get(d.id), comments);
      unread.set(d.id, u);
      if (u.unread) unreadTotal += 1;
    }
    const open = visible.filter((d) => !d.closed_at).sort((a, b) => ts(b.last_activity_at) - ts(a.last_activity_at));
    const closed = visible.filter((d) => d.closed_at).sort((a, b) => ts(b.closed_at) - ts(a.closed_at));
    return { open, closed, unread, unreadTotal, readAt };
  }, [discussions, members, comments, reads, memberships, me]);
}

/**
 * 日历用：有截止日期的讨论，按日期（YYYY-MM-DD）分好；同一天里进行中的排前面。
 * applyFilter = 跟着日历顶上的筛选走（迷你月历的小圆点不筛，和提醒一样）。
 */
export function useDueDiscussions(applyFilter = true): { byDay: Map<string, Discussion[]>; unread: Map<string, UnreadInfo> } {
  const { open, closed, unread } = useDiscussions();
  const members = useStore((s) => s.discussionMembers);
  const profiles = useStore((s) => s.profiles);
  const memberships = useStore((s) => s.memberships);
  const filter = useStore((s) => s.filter);
  const me = useStore((s) => s.me);
  const byDay = useMemo(() => {
    const byDay = new Map<string, Discussion[]>();
    if (!me) return byDay;
    const byCreated = (a: Discussion, b: Discussion) => ts(a.created_at) - ts(b.created_at);
    for (const d of [...open.slice().sort(byCreated), ...closed.slice().sort(byCreated)]) {
      if (!d.due_date) continue;
      if (applyFilter && !matchDiscussionFilter(d, filter, members, me, profiles, memberships)) continue;
      const list = byDay.get(d.due_date) ?? [];
      list.push(d);
      byDay.set(d.due_date, list);
    }
    return byDay;
  }, [open, closed, members, profiles, memberships, filter, me, applyFilter]);
  return { byDay, unread };
}
