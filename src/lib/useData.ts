import { useMemo } from 'react';
import { useStore, type Filter } from './store';
import { buildOccurrences, canSee, teamIdsOf } from './occurrences';
import type { Occurrence } from './types';

/** 从 store 派生：窗口内的所有到期项（已按当前筛选过滤） */
export function useOccurrences(from: Date, to: Date, applyFilter = true, includeStale = false): Occurrence[] {
  const reminders = useStore((s) => s.reminders);
  const completions = useStore((s) => s.completions);
  const snoozes = useStore((s) => s.snoozes);
  const submissions = useStore((s) => s.submissions);
  const assignees = useStore((s) => s.assignees);
  const memberships = useStore((s) => s.memberships);
  const session = useStore((s) => s.session);
  const me = useStore((s) => s.me);
  const filter = useStore((s) => s.filter);
  const fromMs = from.getTime();
  const toMs = to.getTime();
  return useMemo(() => {
    if (!session || !me) return [];
    const visible = reminders.filter((r) => canSee(r, assignees, me, memberships));
    const all = buildOccurrences({ reminders: visible, completions, snoozes, submissions, userId: session.userId, from: new Date(fromMs), to: new Date(toMs) });
    const occs = includeStale ? all : all.filter((o) => !o.stale);
    if (!applyFilter) return occs;
    return occs.filter((o) => matchFilter(o, filter, assignees, me, memberships));
  }, [reminders, completions, snoozes, submissions, assignees, memberships, session, me, filter, fromMs, toMs, applyFilter, includeStale]);
}

function matchFilter(
  o: Occurrence,
  filter: Filter,
  assignees: ReturnType<typeof useStore.getState>['assignees'],
  me: NonNullable<ReturnType<typeof useStore.getState>['me']>,
  memberships: ReturnType<typeof useStore.getState>['memberships'],
): boolean {
  if (filter === 'all') return true;
  if (filter === 'created') return o.reminder.created_by === me.id;
  if (filter === 'mine') {
    const mine = teamIdsOf(me, memberships);
    return assignees.some((a) => a.reminder_id === o.reminder.id && (a.user_id === me.id || (a.team_id && mine.includes(a.team_id))));
  }
  if (filter.startsWith('team:')) {
    const teamId = filter.slice(5);
    return o.reminder.team_id === teamId || assignees.some((a) => a.reminder_id === o.reminder.id && a.team_id === teamId);
  }
  return true;
}

/** 当前选中的到期项 */
export function useSelected(occs: Occurrence[]): Occurrence | null {
  const key = useStore((s) => s.selectedKey);
  return useMemo(() => occs.find((o) => o.key === key) ?? null, [occs, key]);
}
