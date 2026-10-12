// The URL period (`?fy=2022-23&q=Q3` or `&m=2022-10`) as the dashboard API's query: `{ fy }` for a whole FY, or the
// inclusive `{ from, to }` dates of a quarter or month. Calendar arithmetic only; which instances fall in the range
// is the API's job. Kept here until M11 adds a shared helper to lib/period.ts (requested), then this file goes.
import type { Period } from '../../../../../lib/period';

export type PeriodQuery = { fy?: string; from?: string; to?: string };

const pad = (n: number) => String(n).padStart(2, '0');

function lastDay(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one; UTC so the runtime's zone never shifts it.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthRange(year: number, month: number, months: number): { from: string; to: string } {
  const endIndex = year * 12 + (month - 1) + months - 1;
  const endYear = Math.floor(endIndex / 12);
  const endMonth = (endIndex % 12) + 1;
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${endYear}-${pad(endMonth)}-${pad(lastDay(endYear, endMonth))}`,
  };
}

/** `fyStartMonth` is 1-12 (4 = April, the Indian FY). */
export function periodQuery(period: Period | undefined, fyStartMonth: number): PeriodQuery {
  if (!period) return {};
  if (period.month) {
    const [y, m] = period.month.split('-').map(Number) as [number, number];
    return monthRange(y, m, 1);
  }
  if (!period.quarter) return { fy: period.fy };
  const startYear = Number(period.fy.slice(0, 4));
  const index = startYear * 12 + (fyStartMonth - 1) + (period.quarter - 1) * 3;
  return monthRange(Math.floor(index / 12), (index % 12) + 1, 3);
}
