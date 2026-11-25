// 「整理」里扫库位用的货架库存（1–4 厅，每行带产品尺寸）。
//
// 进「整理」页时取一次，放在内存里大家共用（面板开开关关不重新取）；过了 10 分钟再用到时在后台换一份新的
// —— 库存是各系统点「同步库存」书签推上去的，一天也就变几次，不用每扫一次都取。
// 没取到（断网、登录过期、那边出错）：有上一份就接着用上一份，并且说清楚是多久前的；没有就只能报空托盘。
// 不存到本机：这是全仓各客户的库存，只留在内存里，关掉应用就没了。
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { StockFetchError, type Repo } from './repo';
import { useStore } from './store';
import { buildRack, type RackModel } from './tidySuggest';

export interface RackStock {
  /** 取到过的库存；还没取到过 = null */
  model: RackModel | null;
  /** 这一份是什么时候取的（ms）；没有 = 0 */
  loadedAt: number;
  loading: boolean;
  /** 最近一次没取到的原因；取到了 = null */
  error: 'auth' | 'net' | 'server' | null;
  detail: string;
}

/** 一份库存用这么久，过了再用到就换新的 */
export const RACK_TTL_MS = 10 * 60 * 1000;
/** 刚失败过，这么久之内不自动重试（手动点「再取一次」不受这个限制） */
const RETRY_GAP_MS = 5000;

const EMPTY: RackStock = { model: null, loadedAt: 0, loading: false, error: null, detail: '' };
let state: RackStock = EMPTY;
/** 这份库存是哪个账号取的（换了账号就丢掉） */
let owner = '';
let triedAt = 0;
const listeners = new Set<() => void>();

function put(patch: Partial<RackStock>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

async function load(repo: Repo, userId: string): Promise<void> {
  if (owner !== userId) {
    owner = userId;
    state = EMPTY;
  } else if (state.loading) return;
  triedAt = Date.now();
  put({ loading: true });
  try {
    const snap = await repo.stockRacks();
    if (owner !== userId) return; // 取的时候换了账号
    put({ model: buildRack(snap), loadedAt: Date.now(), loading: false, error: null, detail: '' });
  } catch (e) {
    if (owner !== userId) return;
    const err = e instanceof StockFetchError ? e : new StockFetchError('server', String((e as Error)?.message ?? e));
    put({ loading: false, error: err.code, detail: err.detail });
  }
}

export interface RackStockApi extends RackStock {
  /** 用到库存了：没有、或者太旧，就在后台取一份 */
  touch(): void;
  /** 现在就重新取 */
  refresh(): void;
}

/** want = 现在用不用得上（在「整理」页上、清单能用）；用得上才取 */
export function useRackStock(want: boolean): RackStockApi {
  const repo = useStore((s) => s.repo);
  const userId = useStore((s) => s.me?.id ?? '');
  const cur = useSyncExternalStore(subscribe, () => state);

  const touch = useCallback(() => {
    if (!userId) return;
    const now = Date.now();
    const mine = owner === userId;
    if (mine && state.loading) return;
    const fresh = mine && !!state.model && now - state.loadedAt <= RACK_TTL_MS;
    if (fresh) return;
    if (mine && state.error && now - triedAt < RETRY_GAP_MS) return;
    void load(repo, userId);
  }, [repo, userId]);

  const refresh = useCallback(() => {
    if (userId) void load(repo, userId);
  }, [repo, userId]);

  useEffect(() => {
    if (want) touch();
  }, [want, touch]);

  // 换了账号、还没来得及重新取：别把上一个账号的库存给出去
  const mine = owner === userId ? cur : EMPTY;
  return { ...mine, touch, refresh };
}
