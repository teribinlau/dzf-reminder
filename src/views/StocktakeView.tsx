import { useStore } from '../lib/store';
import { StocktakeActionsCtx, StocktakeCtx, useStocktakeData } from '../lib/useStocktakeData';
import { StocktakeHome } from '../components/stocktake/StocktakeHome';
import { StocktakeSession } from '../components/stocktake/StocktakeSession';

/**
 * 「仓库」→「盘点」：库位空位盘点（Claude 从三个 WMS 导出一个厅 → 管理员导入 → 大家用手机扫库位码、点空 / 半 / 满 / 异）。
 * 规则和《X厅_库位空位盘点表.xlsx》一样，见 lib/stocktake.ts。
 */
export function StocktakeView({ active }: { active: boolean }) {
  const data = useStocktakeData(active);
  const takeId = useStore((s) => s.stTake);
  return (
    <StocktakeCtx.Provider value={data}>
      <StocktakeActionsCtx.Provider value={data.actions}>
        <div className="st-view">{takeId ? <StocktakeSession active={active} /> : <StocktakeHome />}</div>
      </StocktakeActionsCtx.Provider>
    </StocktakeCtx.Provider>
  );
}
