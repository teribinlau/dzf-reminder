// 「仓库 → 整理」的数据：整理清单、实时同步、离线补传。
//
// 加任务（3D 页「加入整理」、手机报空托盘）和现场操作（已搬 / 有问题 / 搬走了 …）都是先改本地、再发服务器；
// 发不出去（断网、服务器没回）的按顺序存在本机（localStorage，按账号），每 10 秒、网络恢复、切回前台时补发。
// 补发带的是现场点的时间，服务器上已经有更晚的操作就不覆盖（数据库函数 tidy_act 里判断）。
// 补发时连着的现场操作几条一起发（各是各的任务；同一条任务的操作还是按点的顺序）—— 批量取消几百条也就几秒。
// 「出过移库文件」要联网，失败直接提示。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import type { TidyAct, TidyDraft, TidyTask } from './types';
import type { TidyEvent } from './repo';
import { addBlocked, applyTidyAct, draftToTask, headActs } from './tidy';
import { isNetworkError } from './useStocktakeData';
import i18n from '../i18n';

type ActOp = { op: 'act'; id: string; act: TidyAct; name: string; at: string };
type PendingOp = { op: 'add'; drafts: TidyDraft[]; name: string; at: string } | ActOp;

/** 补发现场操作时，一次并着发几条 */
const ACT_BATCH = 6;

const pendingKey = (userId: string) => `dzf-tidy-pending-v1:${userId}`;
/** 工位账号署谁的名：和盘点用同一个（这个标签页里选一次就行） */
const SIGN_KEY = 'dzf-st-sign-v1';

function readPending(key: string): PendingOp[] {
  try {
    const raw = localStorage.getItem(key);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as PendingOp[]) : [];
  } catch {
    return [];
  }
}

function errText(e: unknown): string {
  const err = e as { message?: unknown; code?: unknown } | null;
  const msg = typeof err?.message === 'string' ? err.message : String(e);
  if (err?.code === '42501' || /not allowed/i.test(msg)) return i18n.t('tidy.err.denied');
  if (err?.code === '23505') return i18n.t('tidy.err.targetLeaving');
  if (/bad target/i.test(msg)) return i18n.t('tidy.err.badTarget');
  return msg;
}

/** 没发出去的操作盖在服务器数据上面（刷新页面后也看得到自己刚点的） */
function applyOps(server: TidyTask[], ops: PendingOp[], userId: string | null, admin: boolean): TidyTask[] {
  if (!ops.length) return server;
  const list = server.slice();
  const at = (id: string) => list.findIndex((t) => t.id === id);
  for (const o of ops) {
    if (o.op === 'add') {
      for (const d of o.drafts) if (at(d.id) < 0) list.push(draftToTask(d, userId, o.name, o.at));
    } else {
      const i = at(o.id);
      if (i >= 0) list[i] = applyTidyAct(list[i], o.act, { userId, name: o.name, at: o.at, admin });
    }
  }
  return list;
}

export interface TidyData {
  /** false = 数据库里还没有整理的表（迁移 0014 没跑） */
  ready: boolean;
  loaded: boolean;
  tasks: TidyTask[];
  loading: boolean;
  loadError: string | null;
  /** 还没发出去的操作有几个 */
  pending: number;
  /** 工位账号（多人共用的手机 / 电脑）：操作署谁的名 */
  signName: string;
  setSignName(name: string): void;
  needSign: boolean;
  /** 现在能不能往清单里加（已登录、表在、工位账号选了名字） */
  canAdd: boolean;
  reload(): Promise<void>;
  flush(): Promise<void>;
  /** 加任务：返回加进去几条、几条因为和清单里的撞了没加，还有加进去的那几条（本机先显示的样子，可以接着操作） */
  add(drafts: TidyDraft[]): { added: number; blocked: number; tasks: TidyTask[] };
  /** 一次现场操作；状态对不上（别人已经处理了）返回 false */
  act(task: TidyTask, a: TidyAct): boolean;
  /** 同一个操作一次做很多条（批量取消、都已导入）；返回真正改了几条 */
  actMany(tasks: TidyTask[], a: TidyAct): number;
  /** 管理员：这些任务出过移库文件了（要联网） */
  markExported(ids: string[]): Promise<boolean>;
}

export const TidyCtx = createContext<TidyData | null>(null);

export function useTidyCtx(): TidyData {
  const v = useContext(TidyCtx);
  if (!v) throw new Error('TidyCtx missing');
  return v;
}

export function useTidyData(active: boolean): TidyData {
  const repo = useStore((s) => s.repo);
  const me = useStore((s) => s.me);
  const pushToast = useStore((s) => s.pushToast);
  const userId = me?.id ?? '';
  const admin = me?.role === 'admin';
  const key = userId ? pendingKey(userId) : '';

  const [ready, setReady] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [tasks, setTasks] = useState<TidyTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingN, setPendingN] = useState(0);
  const [signName, setSignNameState] = useState(() => {
    try {
      return sessionStorage.getItem(SIGN_KEY) ?? '';
    } catch {
      return '';
    }
  });

  const ops = useRef<PendingOp[]>([]);
  const opsKey = useRef('');
  const flushing = useRef(false);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  // 换了账号：本机没发出去的操作跟着换
  if (opsKey.current !== key) {
    opsKey.current = key;
    ops.current = key ? readPending(key) : [];
  }

  const persist = useCallback(() => {
    if (!key) return;
    const n = ops.current.length;
    try {
      if (n) localStorage.setItem(key, JSON.stringify(ops.current));
      else localStorage.removeItem(key);
    } catch {
      /* 存不下就只在内存里 */
    }
    setPendingN(n);
  }, [key]);

  /** 服务器来的一行：本机还有没发出去的操作就盖在上面 */
  const putRow = useCallback(
    (row: TidyTask) => {
      const mine = ops.current.filter((o) => o.op === 'act' && o.id === row.id);
      const next = mine.length ? applyOps([row], mine, userId || null, admin)[0] : row;
      setTasks((list) => {
        const i = list.findIndex((x) => x.id === row.id);
        if (i < 0) return [...list, next];
        const copy = list.slice();
        copy[i] = next;
        return copy;
      });
    },
    [userId, admin],
  );

  const reload = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await repo.listTidy();
      setReady(res.ready);
      setTasks(applyOps(res.tasks, ops.current, userId, admin));
      setLoaded(true);
      setPendingN(ops.current.length);
    } catch (e) {
      // 断网：留着上次的清单接着用
      if (!isNetworkError(e) || !tasksRef.current.length) setLoadError(isNetworkError(e) ? i18n.t('tidy.err.offline') : errText(e));
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [repo, userId, admin]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  const flush = useCallback(async () => {
    if (flushing.current || !key || !ops.current.length) return;
    flushing.current = true;
    let needReload = false;
    const notAdded: string[] = [];
    const errs: string[] = [];
    try {
      while (ops.current.length) {
        const o = ops.current[0];
        if (o.op === 'add') {
          try {
            const rows = await repo.addTidy(o.drafts, o.name);
            ops.current = ops.current.filter((x) => x !== o);
            rows.forEach(putRow);
            const got = new Set(rows.map((r) => r.id));
            const missing = o.drafts.filter((d) => !got.has(d.id)).map((d) => d.id);
            if (missing.length) {
              // 没加上的：可能是撞了（别人刚加过），也可能是上次其实已经加上、只是回信丢了 —— 重新拉一次清单就知道
              notAdded.push(...missing);
              needReload = true;
            }
          } catch (e) {
            if (isNetworkError(e)) break; // 还是不通：留着下次再发
            ops.current = ops.current.filter((x) => x !== o);
            needReload = true;
            errs.push(errText(e));
          }
          continue;
        }
        // 排在最前面的一串现场操作：各是各的任务的，几条一起发
        const batch = headActs(ops.current, ACT_BATCH) as ActOp[];
        if (!batch.length) {
          ops.current = ops.current.slice(1); // 认不得的一条（本机存坏了）：丢掉，不然会卡在这里
          continue;
        }
        const res = await Promise.allSettled(batch.map((x) => repo.actTidy(x.id, x.act, x.name, x.at)));
        const sent = new Set<PendingOp>();
        const rows: TidyTask[] = [];
        let offline = false;
        res.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            sent.add(batch[i]);
            rows.push(r.value);
          } else if (isNetworkError(r.reason)) offline = true; // 这条留着下次再发
          else {
            sent.add(batch[i]);
            needReload = true;
            errs.push(errText(r.reason));
          }
        });
        ops.current = ops.current.filter((x) => !sent.has(x));
        rows.forEach(putRow);
        if (offline) break;
        if (ops.current.length) persist(); // 发一批存一次：中途关掉应用，发过的不会再发一遍
      }
    } finally {
      flushing.current = false;
      persist();
    }
    if (errs.length) {
      // 一次补发只提示一回（批量操作失败时不刷屏）
      const kinds = [...new Set(errs)];
      pushToast({ title: errs.length > 1 ? i18n.t('tidy.err.saveN', { count: errs.length }) : i18n.t('tidy.err.save'), body: kinds.slice(0, 2).join('；'), kind: 'error' });
    }
    if (needReload) {
      await reloadRef.current();
      const have = new Set(tasksRef.current.map((t) => t.id));
      const lost = notAdded.filter((id) => !have.has(id)).length;
      if (lost) pushToast({ title: i18n.t('tidy.err.notAdded', { count: lost }), body: i18n.t('tidy.err.notAddedWhy'), kind: 'error' });
    }
  }, [key, repo, putRow, persist, pushToast]);

  // 进「仓库」页时加载；本机留着没发出去的操作就接着发
  useEffect(() => {
    if (!active || !userId) return;
    void reload().then(() => flush());
  }, [active, userId, reload, flush]);

  // 实时：别人加的、搬的、取消的
  useEffect(() => {
    const off = repo.subscribeTidy((e: TidyEvent) => {
      if (e.type === 'DELETE') {
        setTasks((list) => list.filter((t) => t.id !== e.oldId));
        return;
      }
      if (e.row && typeof e.row.id === 'string') putRow({ ...e.row, lines: Array.isArray(e.row.lines) ? e.row.lines : [] });
    });
    return off;
  }, [repo, putRow]);

  // 补发：每 10 秒、网络恢复、切回前台
  useEffect(() => {
    if (!pendingN) return;
    const timer = window.setInterval(() => void flush(), 10000);
    const on = () => void flush();
    const vis = () => document.visibilityState === 'visible' && void flush();
    window.addEventListener('online', on);
    document.addEventListener('visibilitychange', vis);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', on);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [pendingN, flush]);

  const needSign = !!me?.is_station && !signName;
  const signer = me?.is_station ? signName : (me?.name ?? '');

  const setSignName = useCallback((name: string) => {
    setSignNameState(name);
    try {
      sessionStorage.setItem(SIGN_KEY, name);
    } catch {
      /* ignore */
    }
  }, []);

  const add = useCallback(
    (drafts: TidyDraft[]) => {
      if (!key || !drafts.length) return { added: 0, blocked: 0, tasks: [] };
      const at = new Date().toISOString();
      const okDrafts: TidyDraft[] = [];
      const made: TidyTask[] = [];
      // 一条条看能不能加（前面加的也算进去）
      const virtual = tasksRef.current.slice();
      for (const d of drafts) {
        if (addBlocked(virtual, d)) continue;
        const row = draftToTask(d, userId, signer, at);
        okDrafts.push(d);
        made.push(row);
        virtual.push(row);
      }
      if (okDrafts.length) {
        ops.current = [...ops.current, { op: 'add', drafts: okDrafts, name: signer, at }];
        setTasks((list) => [...list, ...made.filter((d) => !list.some((t) => t.id === d.id))]);
        persist();
        void flush();
      }
      return { added: okDrafts.length, blocked: drafts.length - okDrafts.length, tasks: made };
    },
    [key, userId, signer, persist, flush],
  );

  const act = useCallback(
    (task: TidyTask, a: TidyAct) => {
      if (!key) return false;
      const at = new Date().toISOString();
      const cur = tasksRef.current.find((t) => t.id === task.id) ?? task;
      const next = applyTidyAct(cur, a, { userId, name: signer, at, admin });
      if (next === cur) return false;
      ops.current = [...ops.current, { op: 'act', id: task.id, act: a, name: signer, at }];
      setTasks((list) => list.map((t) => (t.id === task.id ? next : t)));
      persist();
      void flush();
      return true;
    },
    [key, userId, signer, admin, persist, flush],
  );

  const actMany = useCallback(
    (list: TidyTask[], a: TidyAct) => {
      if (!key || !list.length) return 0;
      const at = new Date().toISOString();
      const cur = new Map(tasksRef.current.map((t) => [t.id, t]));
      const next = new Map<string, TidyTask>();
      const more: PendingOp[] = [];
      for (const task of list) {
        if (next.has(task.id)) continue;
        const c = cur.get(task.id) ?? task;
        const n = applyTidyAct(c, a, { userId, name: signer, at, admin });
        if (n === c) continue;
        next.set(task.id, n);
        more.push({ op: 'act', id: task.id, act: a, name: signer, at });
      }
      if (!more.length) return 0;
      ops.current = [...ops.current, ...more];
      setTasks((all) => all.map((t) => next.get(t.id) ?? t));
      persist();
      void flush();
      return more.length;
    },
    [key, userId, signer, admin, persist, flush],
  );

  const markExported = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return true;
      try {
        await flush();
        const rows = await repo.markTidyExported(ids);
        rows.forEach(putRow);
        return true;
      } catch (e) {
        pushToast({ title: i18n.t('tidy.err.save'), body: isNetworkError(e) ? i18n.t('tidy.err.offline') : errText(e), kind: 'error' });
        return false;
      }
    },
    [repo, flush, putRow, pushToast],
  );

  const canAdd = !!userId && ready && loaded && !needSign && !!me?.active;

  return useMemo(
    () => ({ ready, loaded, tasks, loading, loadError, pending: pendingN, signName, setSignName, needSign, canAdd, reload, flush, add, act, actMany, markExported }),
    [ready, loaded, tasks, loading, loadError, pendingN, signName, setSignName, needSign, canAdd, reload, flush, add, act, actMany, markExported],
  );
}
