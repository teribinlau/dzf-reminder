import { get, set } from 'idb-keyval';
import type { Snapshot } from './repo';

const KEY = 'dzf-reminder-snapshot-v1';

export async function readCache(): Promise<{ snapshot: Snapshot; savedAt: string } | null> {
  try {
    const v = await get<{ snapshot: Snapshot; savedAt: string }>(KEY);
    if (!v) return null;
    // 旧版本缓存里没有的表补成空数组
    v.snapshot.submissions ??= [];
    v.snapshot.snoozes ??= [];
    v.snapshot.memberships ??= [];
    v.snapshot.attachments ??= [];
    v.snapshot.discussions ??= [];
    v.snapshot.discussionMembers ??= [];
    v.snapshot.comments ??= [];
    v.snapshot.discussionFiles ??= [];
    v.snapshot.discussionReads ??= [];
    v.snapshot.discussionsReady ??= true;
    // v0.6.0 之前的缓存里讨论没有截止日期
    v.snapshot.discussions = v.snapshot.discussions.map((d) => ({ ...d, due_date: d.due_date ?? null }));
    return v;
  } catch {
    return null;
  }
}

export async function writeCache(snapshot: Snapshot): Promise<void> {
  try {
    await set(KEY, { snapshot, savedAt: new Date().toISOString() });
  } catch {
    /* 私密模式等情况下忽略 */
  }
}

/** 断网时排队的写操作，恢复后按顺序重放 */
export interface QueuedOp {
  id: string;
  kind: 'completion' | 'snooze';
  payload: unknown;
  queuedAt: string;
}

const QKEY = 'dzf-reminder-queue-v1';

export async function readQueue(): Promise<QueuedOp[]> {
  try {
    return (await get<QueuedOp[]>(QKEY)) ?? [];
  } catch {
    return [];
  }
}

export async function writeQueue(ops: QueuedOp[]): Promise<void> {
  try {
    await set(QKEY, ops);
  } catch {
    /* ignore */
  }
}
