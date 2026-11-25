// 演示模式的货架库存（「整理」里扫库位看货、给合并建议用）。手写的几个固定场景，测试也用这一份：
//   B2-05-06-02  JQKJ 两种货、占 12.5% 托 → 能并到 05-09-01（同 SKU、1 层、同通道）、03-26-01、04-08-02、06-07-01 …
//   B2-07-03-01  有待出          B2-07-04-01  有不良品        B2-07-05-01  两个客户的货
//   B2-07-06-01  货没有尺寸      B2-07-07-02  找不到目标      B2-07-08-01  系统里是空的
//   B2-07-11-01  KYT 的货（那个系统 30 小时没同步 → 提醒数据旧）
// 清单里那几条演示任务（demo.ts 的 demoTidy）的来源、目标这里也都有货。
import { parseRackSnapshot, type RackApiRow, type RackSnapshot } from './tidySuggest';

type Dims = [number, number, number];

/** 产品尺寸（cm）；不在这里的 = 没有尺寸 */
const DIMS: Record<string, Dims> = {
  'JQKJ-DEMO-5770': [40, 30, 20],
  'JQKJ-DEMO-5771': [60, 40, 40],
  'JQKJ-DEMO-5772': [30, 20, 10],
  'JQKJ-DEMO-5773': [30, 30, 30],
  'B359-5691165': [50, 40, 25],
  'A898-AIR-X-FRONT-BRAKEDISC': [35, 35, 8],
  'A898-OTHER-02': [40, 30, 30],
  'Y001-2511ZXC-CDQ': [20, 15, 10],
  'Y001-OTHER-01': [30, 20, 15],
  'B029-L-4TUOVT': [120, 20, 10],
  'B029-OTHER-03': [40, 30, 20],
  'BY100-HP102-1PCS': [40, 30, 30],
  'BY100-OTHER-04': [30, 30, 20],
  'H206-DEMO-BIG': [100, 80, 60],
};

/** [显示库位, 系统里的库位号（'' = 同显示）, 来源下标, SKU, 在库, 待出, 库存类型, 客户] */
const ROWS: [string, string, number, string, number, number, string, string][] = [
  // —— 扫 B2-05-06-02：JQKJ（盘古），5770 ×6 + 5772 ×10 = 0.204 m³ = 12.5% 托 ——
  ['B2-05-06-02', '', 3, 'JQKJ-DEMO-5770', 6, 0, '', 'JQKJ'],
  ['B2-05-06-02', '', 3, 'JQKJ-DEMO-5772', 10, 0, '', 'JQKJ'],
  // 能并的：
  ['B2-05-09-01', '020100500901', 3, 'JQKJ-DEMO-5770', 20, 0, '', 'JQKJ'], // 同 SKU · 1 层 · 同通道（12 位旧码）
  ['B2-03-26-01', '020100302601', 3, 'JQKJ-DEMO-5770', 9, 0, '', 'JQKJ'], // 同 SKU · 1 层 · 同厅
  ['B2-04-08-02', '', 3, 'JQKJ-DEMO-5772', 30, 0, '', 'JQKJ'], // 同 SKU · 2 层 · 同通道
  ['B2-06-07-01', '', 3, 'JQKJ-DEMO-5771', 4, 0, '', 'JQKJ'], // 同客户 · 1 层
  ['B2-11-20-01', '', 3, 'JQKJ-DEMO-5771', 2, 0, '', 'JQKJ'],
  ['B3-05-12-01', '', 3, 'JQKJ-DEMO-5771', 1, 0, '', 'JQKJ'], // 别的厅
  // 不给的：
  ['B2-05-06-03', '', 3, 'JQKJ-DEMO-5772', 5, 0, '', 'JQKJ'], // 比来源高
  ['B2-05-12-01', '', 3, 'JQKJ-DEMO-5771', 12, 0, '', 'JQKJ'], // 并进去超过 80%
  ['B2-05-10-01', '', 3, 'B359-5691165', 6, 0, '', 'B359'], // 别的客户
  ['B2-07-09-01', '', 6, 'JQKJ-DEMO-5773', 4, 0, '', 'JQKJ'], // 同客户，别的系统
  ['B2-07-10-01', '', 3, 'JQKJ-DEMO-NODIM', 3, 0, '', 'JQKJ'], // 那里的货没有尺寸
  // —— 不给建议的几种来源 ——
  ['B2-07-03-01', '', 3, 'A898-AIR-X-FRONT-BRAKEDISC', 8, 3, '', 'A898'], // 有待出
  ['B2-07-04-01', '', 3, 'A898-AIR-X-FRONT-BRAKEDISC', 5, 0, '', 'A898'],
  ['B2-07-04-01', '', 3, 'A898-AIR-X-FRONT-BRAKEDISC', 2, 0, '不良品', 'A898'], // 有不良品
  ['B2-07-05-01', '', 3, 'JQKJ-DEMO-5770', 2, 0, '', 'JQKJ'],
  ['B2-07-05-01', '', 3, 'B359-5691165', 1, 0, '', 'B359'], // 两个客户
  ['B2-07-06-01', '', 3, 'A651-DEMO-01', 12, 0, '', 'A651'], // 没有尺寸
  ['B2-07-07-02', '', 3, 'H206-DEMO-BIG', 1, 0, '', 'H206'], // 这个客户只有这一托
  ['B2-07-11-01', '', 4, 'Y001-OTHER-01', 10, 0, '', 'Y001'], // KYT：能并到 B2-12-12-01
  // —— 演示清单里的任务（来源 → 目标）——
  ['B2-14-34-01', '', 3, 'B359-5691165', 4, 0, '', 'B359'],
  ['B2-14-47-01', '', 3, 'B359-5691165', 6, 0, '', 'B359'],
  ['B2-02-21-01', '020100202101', 3, 'JQKJ-DEMO-5770', 3, 0, '', 'JQKJ'],
  ['B2-02-21-01', '020100202101', 3, 'JQKJ-DEMO-5771', 2, 1, '', 'JQKJ'],
  ['B2-02-21-01', '020100202101', 3, 'JQKJ-DEMO-5772', 1, 0, '', 'JQKJ'],
  ['B2-13-05-01', '', 4, 'Y001-2511ZXC-CDQ', 4, 0, '', 'Y001'],
  ['B2-12-12-01', '', 4, 'Y001-OTHER-01', 40, 0, '', 'Y001'],
  ['B2-08-15-01', '', 3, 'A898-AIR-X-FRONT-BRAKEDISC', 2, 0, '', 'A898'],
  ['B2-09-08-01', '', 3, 'A898-OTHER-02', 12, 0, '', 'A898'],
  ['B4-14-07-01', '', 3, 'B029-L-4TUOVT', 1, 0, '', 'B029'],
  ['B3-04-10-01', '', 3, 'B029-OTHER-03', 20, 0, '', 'B029'],
  ['B1-08-05-01', '', 6, 'BY100-HP102-1PCS', 3, 0, '', 'BY100'],
  ['B1-09-07-01', '', 6, 'BY100-OTHER-04', 30, 0, '', 'BY100'],
  // 不是货架托位的（地库排、暂存区）：接口会给，这边不算
  ['B3-10-05-01', '', 3, 'B029-OTHER-03', 6, 0, '', 'B029'],
  ['B2-ZC', '', 3, 'A651-DEMO-01', 5, 0, '暂存', 'A651'],
];

/** 演示：/api/stock?hall=1,2,3,4&dims=1 回来的样子（KYT 30 小时没同步，海派还是基线） */
export function demoRackSnapshot(now = Date.now()): RackSnapshot {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ago = (h: number) => new Date(now - h * 3600000).toISOString();
  const dt = (h: number) => {
    const d = new Date(now - h * 3600000);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const rows: RackApiRow[] = ROWS.map((r) => [...r, DIMS[r[3]] ?? null]);
  const snap = {
    v: 1,
    hall: '1,2,3,4',
    at: new Date(now).toISOString(),
    sync: {
      B3: { dt: dt(2), n: 4210, host: 'wms.teknihall.cn', wh: 'B3', at: ago(2) },
      DECGN: { dt: dt(30), n: 655, host: 'szkyt.wms.yunwms.com', wh: 'DECGN', at: ago(30) },
      HP: { dt: '09-30', n: null, host: '', at: null, base: true },
      DZF: { dt: dt(1), n: 1302, host: 'dzf.wms.yunwms.com', wh: 'DZFDA', at: ago(1) },
    },
    rows,
  };
  return parseRackSnapshot(JSON.parse(JSON.stringify(snap)));
}
