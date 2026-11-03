// 盘点页的数据：盘点列表、打开的那次盘点的全部行和照片、实时同步、离线补传。
//
// 记录（空 / 半 / 满 / 无 / 异、还能放、实数、备注）先改本地、再发服务器；发不出去（断网、服务器没回）的
// 存在本机（localStorage，按盘点 + 账号），每 10 秒、网络恢复、切回前台时补发。补发带的是现场点的时间，
// 服务器上已经有更晚的记录就不覆盖（数据库函数 stocktake_mark 里判断）。
// 加货、照片、导入、结束这些要联网，失败直接提示。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import type { StockMark, Stocktake, StocktakePhoto, StocktakeProgress, StocktakeRow, StocktakeImportRow } from './types';
import { applyMark, markOf, sameMark, sortRows } from './stocktake';
import { shrinkImage } from './images';
import type { StocktakeEvent } from './repo';
import i18n from '../i18n';

interface PendingMark {
  mark: StockMark;
  at: string;
  name: string;
}

/** 服务器收到了、明确拒绝的错误带 Postgres / PostgREST 的 code；没有 code 的是网络 / 网关问题，可以重试 */
export function isNetworkError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  if (!err) return false;
  if (typeof err.code === 'string' && err.code) return false;
  return true;
}

function errText(e: unknown): string {
  const err = e as { message?: unknown; code?: unknown } | null;
  const msg = typeof err?.message === 'string' ? err.message : String(e);
  if (/closed/i.test(msg)) return i18n.t('stock.err.closed');
  // 数据库还没升级（迁移 0013）：「无」存不进去
  if (err?.code === '23514' && /status/i.test(msg)) return i18n.t('stock.err.needUpgrade');
  if (err?.code === '42501' || /not allowed/i.test(msg)) return i18n.t('stock.err.denied');
  return msg;
}

const pendingKey = (takeId: string, userId: string) => `dzf-st-pending-v1:${takeId}:${userId}`;
const SIGN_KEY = 'dzf-st-sign-v1';

function readPending(key: string): Record<number, PendingMark> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<number, PendingMark>) : {};
  } catch {
    return {};
  }
}

export interface StocktakeData {
  ready: boolean;
  listLoaded: boolean;
  takes: Stocktake[];
  progress: Record<string, StocktakeProgress>;
  take: Stocktake | null;
  rows: StocktakeRow[];
  photos: StocktakePhoto[];
  loading: boolean;
  loadError: string | null;
  pending: number;
  /** 工位账号（多人共用的手机 / 电脑）：记录署谁的名 */
  signName: string;
  setSignName(name: string): void;
  needSign: boolean;
  reloadList(): Promise<void>;
  reloadTake(): Promise<void>;
  mark(row: StocktakeRow, m: StockMark): void;
  flush(): Promise<void>;
  addFound(loc: string, sku: string, qty: number | null, note: string): Promise<boolean>;
  deleteFound(row: StocktakeRow): Promise<void>;
  addPhotos(loc: string, files: File[]): Promise<number>;
  removePhoto(p: StocktakePhoto): Promise<void>;
  importTake(meta: Pick<Stocktake, 'hall' | 'title' | 'exported_at'>, rows: StocktakeImportRow[], onProgress?: (n: number) => void): Promise<string | null>;
  setTakeStatus(id: string, status: Stocktake['status']): Promise<void>;
  deleteTake(id: string): Promise<boolean>;
  actions: StocktakeActions;
}

/** 卡片只要这几个动作（引用稳定），这样点一个库位不会让整条通道的卡片都重画 */
export interface StocktakeActions {
  mark: StocktakeData['mark'];
  addFound: StocktakeData['addFound'];
  deleteFound: StocktakeData['deleteFound'];
  addPhotos: StocktakeData['addPhotos'];
  removePhoto: StocktakeData['removePhoto'];
}

export const StocktakeCtx = createContext<StocktakeData | null>(null);
export const StocktakeActionsCtx = createContext<StocktakeActions | null>(null);

export function useStocktakeActions(): StocktakeActions {
  const v = useContext(StocktakeActionsCtx);
  if (!v) throw new Error('StocktakeActionsCtx missing');
  return v;
}

export function useStocktakeCtx(): StocktakeData {
  const v = useContext(StocktakeCtx);
  if (!v) throw new Error('StocktakeCtx missing');
  return v;
}

export function useStocktakeData(active: boolean): StocktakeData {
  const repo = useStore((s) => s.repo);
  const me = useStore((s) => s.me);
  const takeId = useStore((s) => s.stTake);
  const pushToast = useStore((s) => s.pushToast);

  const [ready, setReady] = useState(true);
  const [listLoaded, setListLoaded] = useState(false);
  const [takes, setTakes] = useState<Stocktake[]>([]);
  const [progressList, setProgressList] = useState<StocktakeProgress[]>([]);
  const [rows, setRows] = useState<StocktakeRow[]>([]);
  const [photos, setPhotos] = useState<StocktakePhoto[]>([]);
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

  const pending = useRef<Record<number, PendingMark>>({});
  const loadedTake = useRef<string | null>(null);
  const flushing = useRef(false);
  const userId = me?.id ?? '';
  const key = takeId && userId ? pendingKey(takeId, userId) : '';

  const persist = useCallback(() => {
    if (!key) return;
    const n = Object.keys(pending.current).length;
    try {
      if (n) localStorage.setItem(key, JSON.stringify(pending.current));
      else localStorage.removeItem(key);
    } catch {
      /* 存不下就只在内存里 */
    }
    setPendingN(n);
  }, [key]);

  const replaceRow = useCallback((r: StocktakeRow) => {
    setRows((list) => {
      const i = list.findIndex((x) => x.id === r.id);
      if (i < 0) return sortRows([...list, r]);
      const next = list.slice();
      next[i] = r;
      return next;
    });
  }, []);

  // ---------- 列表 ----------
  const reloadList = useCallback(async () => {
    try {
      const res = await repo.listStocktakes();
      setReady(res.ready);
      setTakes(res.takes);
      setProgressList(res.progress);
      setListLoaded(true);
    } catch (e) {
      if (!isNetworkError(e)) pushToast({ title: i18n.t('stock.err.load'), body: errText(e), kind: 'error' });
      setListLoaded(true);
    }
  }, [repo, pushToast]);

  // ---------- 打开的这次盘点 ----------
  const flush = useCallback(async () => {
    if (flushing.current || !key) return;
    const ids = Object.keys(pending.current).map(Number);
    if (!ids.length) return;
    flushing.current = true;
    let reload = false;
    try {
      for (const id of ids) {
        const p = pending.current[id];
        if (!p) continue;
        try {
          const server = await repo.markStocktakeRow(id, p.mark, p.name, p.at);
          const cur = pending.current[id];
          // 发送期间本地又改过：等下一轮发新的，这次的结果不覆盖本地
          if (cur && cur.at === p.at && sameMark(cur.mark, p.mark)) {
            delete pending.current[id];
            replaceRow(server);
          }
        } catch (e) {
          if (isNetworkError(e)) break; // 还是不通：留着下次再发
          delete pending.current[id];
          reload = true;
          pushToast({ title: i18n.t('stock.err.save'), body: errText(e), kind: 'error' });
        }
      }
    } finally {
      flushing.current = false;
      persist();
    }
    if (reload) void reloadTakeRef.current();
  }, [key, repo, replaceRow, persist, pushToast]);

  const reloadTake = useCallback(async () => {
    const id = takeId;
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await repo.loadStocktake(id);
      if (useStore.getState().stTake !== id) return;
      // 本机还没发出去的记录盖在服务器数据上面（刷新页面后也看得到自己刚点的）
      const saved = key ? readPending(key) : {};
      pending.current = saved;
      const merged = res.rows.map((r) => {
        const p = saved[r.id];
        return p ? applyMark(r, p.mark, p.name, userId, p.at) : r;
      });
      // 已经不存在的行（被删了）丢掉
      for (const k of Object.keys(saved)) if (!res.rows.some((r) => r.id === Number(k))) delete pending.current[Number(k)];
      setRows(sortRows(merged));
      setPhotos(res.photos);
      loadedTake.current = id;
      persist();
      void flush();
    } catch (e) {
      setLoadError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [takeId, repo, key, userId, persist, flush]);
  const reloadTakeRef = useRef(reloadTake);
  reloadTakeRef.current = reloadTake;

  // 进「盘点」页签时加载列表；换了盘点就加载那一次
  useEffect(() => {
    if (active) void reloadList();
  }, [active, reloadList]);
  useEffect(() => {
    if (!takeId) {
      setRows([]);
      setPhotos([]);
      loadedTake.current = null;
      pending.current = {};
      setPendingN(0);
      return;
    }
    if (loadedTake.current !== takeId) {
      setRows([]);
      setPhotos([]);
    }
    void reloadTake();
  }, [takeId, reloadTake]);

  // 实时：别人点的、导入的、结束的
  useEffect(() => {
    const off = repo.subscribeStocktakes((e: StocktakeEvent) => {
      const cur = useStore.getState().stTake;
      if (e.table === 'stocktakes') {
        void reloadList();
        return;
      }
      if (e.table === 'stocktake_rows') {
        if (e.type === 'DELETE') {
          setRows((list) => list.filter((r) => r.id !== e.oldId));
          return;
        }
        const r = e.row as unknown as StocktakeRow;
        if (!r || r.stocktake_id !== cur) return;
        if (pending.current[r.id]) return; // 本机有还没发出去的更新的记录
        replaceRow(r);
        return;
      }
      if (e.type === 'DELETE') {
        setPhotos((list) => list.filter((p) => p.id !== e.oldId));
        return;
      }
      const p = e.row as unknown as StocktakePhoto;
      if (!p || p.stocktake_id !== cur) return;
      setPhotos((list) => (list.some((x) => x.id === p.id) ? list : [...list, p]));
    });
    return off;
  }, [repo, reloadList, replaceRow]);

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

  const mark = useCallback(
    (row: StocktakeRow, m: StockMark) => {
      if (!key) return;
      if (sameMark(markOf(row), m)) return;
      const at = new Date().toISOString();
      pending.current[row.id] = { mark: m, at, name: signer };
      replaceRow(applyMark(row, m, signer, userId, at));
      persist();
      void flush();
    },
    [key, signer, userId, replaceRow, persist, flush],
  );

  const addFound = useCallback(
    async (loc: string, sku: string, qty: number | null, note: string) => {
      if (!takeId) return false;
      try {
        const r = await repo.addFoundRow(takeId, loc, sku, qty, note, signer, new Date().toISOString());
        replaceRow(r);
        return true;
      } catch (e) {
        pushToast({ title: i18n.t('stock.err.found'), body: isNetworkError(e) ? i18n.t('stock.err.offline') : errText(e), kind: 'error' });
        return false;
      }
    },
    [takeId, repo, signer, replaceRow, pushToast],
  );

  const deleteFound = useCallback(
    async (row: StocktakeRow) => {
      try {
        await repo.deleteFoundRow(row.id);
        setRows((list) => list.filter((r) => r.id !== row.id));
      } catch (e) {
        pushToast({ title: i18n.t('stock.err.save'), body: isNetworkError(e) ? i18n.t('stock.err.offline') : errText(e), kind: 'error' });
      }
    },
    [repo, pushToast],
  );

  const addPhotos = useCallback(
    async (loc: string, files: File[]) => {
      if (!takeId || !me) return 0;
      let ok = 0;
      for (const f of files) {
        try {
          const small = await shrinkImage(f);
          const p = await repo.addStocktakePhoto(takeId, loc, me.id, signer, small);
          setPhotos((list) => (list.some((x) => x.id === p.id) ? list : [...list, p]));
          ok += 1;
        } catch (e) {
          pushToast({ title: i18n.t('stock.err.photo'), body: isNetworkError(e) ? i18n.t('stock.err.offline') : errText(e), kind: 'error' });
          break;
        }
      }
      return ok;
    },
    [takeId, me, repo, signer, pushToast],
  );

  const removePhoto = useCallback(
    async (p: StocktakePhoto) => {
      try {
        await repo.removeStocktakePhoto(p);
        setPhotos((list) => list.filter((x) => x.id !== p.id));
      } catch (e) {
        pushToast({ title: i18n.t('stock.err.photo'), body: errText(e), kind: 'error' });
      }
    },
    [repo, pushToast],
  );

  const importTake = useCallback(
    async (meta: Pick<Stocktake, 'hall' | 'title' | 'exported_at'>, list: StocktakeImportRow[], onProgress?: (n: number) => void) => {
      if (!me) return null;
      try {
        const id = await repo.createStocktake(meta, list, me.id, onProgress);
        await reloadList();
        return id;
      } catch (e) {
        pushToast({ title: i18n.t('stock.err.import'), body: errText(e), kind: 'error' });
        return null;
      }
    },
    [me, repo, reloadList, pushToast],
  );

  const setTakeStatus = useCallback(
    async (id: string, status: Stocktake['status']) => {
      try {
        if (status === 'closed') await flush();
        await repo.setStocktakeStatus(id, status);
        await reloadList();
      } catch (e) {
        pushToast({ title: i18n.t('stock.err.save'), body: errText(e), kind: 'error' });
      }
    },
    [repo, reloadList, flush, pushToast],
  );

  const deleteTake = useCallback(
    async (id: string) => {
      try {
        await repo.deleteStocktake(id);
        if (useStore.getState().stTake === id) useStore.getState().setStNav({ stTake: null });
        await reloadList();
        return true;
      } catch (e) {
        pushToast({ title: i18n.t('stock.err.save'), body: errText(e), kind: 'error' });
        return false;
      }
    },
    [repo, reloadList, pushToast],
  );

  const progress = useMemo(() => Object.fromEntries(progressList.map((p) => [p.stocktake_id, p])), [progressList]);
  const actions = useMemo(() => ({ mark, addFound, deleteFound, addPhotos, removePhoto }), [mark, addFound, deleteFound, addPhotos, removePhoto]);
  const take = takes.find((t) => t.id === takeId) ?? null;

  return {
    ready,
    listLoaded,
    takes,
    progress,
    take,
    rows,
    photos,
    loading,
    loadError,
    pending: pendingN,
    signName,
    setSignName,
    needSign,
    reloadList,
    reloadTake,
    mark,
    flush,
    addFound,
    deleteFound,
    addPhotos,
    removePhoto,
    importTake,
    setTakeStatus,
    deleteTake,
    actions,
  };
}
