// 黑森州（Hessen）法定节假日：固定日 + 按复活节推算的活动日
// 参考：1 月 1 日、耶稣受难日、复活节星期一、5 月 1 日、耶稣升天节、圣灵降临节星期一、
// 圣体节（黑森州有）、10 月 3 日、12 月 25/26 日

function easterSunday(year: number): Date {
  // Anonymous Gregorian algorithm
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const cache = new Map<number, Set<string>>();

/** 返回该年黑森州法定假日的 YYYY-MM-DD 集合（按本地日历日） */
export function hessenHolidays(year: number): Set<string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const easter = easterSunday(year);
  const set = new Set<string>([
    `${year}-01-01`,
    `${year}-05-01`,
    `${year}-10-03`,
    `${year}-12-25`,
    `${year}-12-26`,
    ymd(addDays(easter, -2)), // Karfreitag
    ymd(addDays(easter, 1)), // Ostermontag
    ymd(addDays(easter, 39)), // Christi Himmelfahrt
    ymd(addDays(easter, 50)), // Pfingstmontag
    ymd(addDays(easter, 60)), // Fronleichnam
  ]);
  cache.set(year, set);
  return set;
}

export function isHessenHoliday(localYmd: string): boolean {
  const year = Number(localYmd.slice(0, 4));
  return hessenHolidays(year).has(localYmd);
}
