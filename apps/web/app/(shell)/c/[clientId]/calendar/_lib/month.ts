// Calendar arithmetic for the month view: which month to show, its weeks, and moving between months. Dates are
// calendar dates ("YYYY-MM-DD", no time zone; root rule 4). Which instances fall due when is the API's answer.
import type { Period } from '../../../../../../lib/period';

/** "2024-11". */
export type Month = string;

const pad = (n: number) => String(n).padStart(2, '0');
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

function parts(month: Month): [number, number] {
  const match = MONTH.exec(month);
  if (!match) throw new RangeError(`Not a month: ${month}`);
  return [Number(match[1]), Number(match[2])];
}

/** The month `count` months after (or before) `month`. */
export function addMonths(month: Month, count: number): Month {
  const [year, m] = parts(month);
  const index = year * 12 + (m - 1) + count;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** The first and last day of a month. */
export function monthRange(month: Month): { from: string; to: string } {
  const [year, m] = parts(month);
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${pad(last)}` };
}

/** The FY label ("2024-25") a month falls in, for an FY starting in `fyStartMonth` (1-12). */
export function fyOf(month: Month, fyStartMonth: number): string {
  const [year, m] = parts(month);
  const start = m >= fyStartMonth ? year : year - 1;
  return `${start}-${pad((start + 1) % 100)}`;
}

/** The months a period covers, first to last. */
export function periodMonths(period: Period, fyStartMonth: number): Month[] {
  if (period.month) return [period.month];
  const first = addMonths(
    `${period.fy.slice(0, 4)}-${pad(fyStartMonth)}`,
    period.quarter ? (period.quarter - 1) * 3 : 0,
  );
  return Array.from({ length: period.quarter ? 3 : 12 }, (_, i) => addMonths(first, i));
}

/**
 * The month the calendar opens on: the period's own month, else this month when the period includes it, else the
 * period's first month.
 */
export function monthToShow(period: Period, fyStartMonth: number, today: string): Month {
  const months = periodMonths(period, fyStartMonth);
  const current = today.slice(0, 7);
  return months.includes(current) ? current : months[0]!;
}

/** Today's calendar date in a time zone, as "YYYY-MM-DD". */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * The month as weeks of seven dates, Monday first, padded with the neighbouring months' days so every week is full.
 */
export function monthWeeks(month: Month): string[][] {
  const [year, m] = parts(month);
  const first = new Date(Date.UTC(year, m - 1, 1));
  // getUTCDay: Sunday 0. Monday-first offset back to the week's start.
  const back = (first.getUTCDay() + 6) % 7;
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const cells = Math.ceil((back + last) / 7) * 7;
  const days = Array.from({ length: cells }, (_, i) => {
    const d = new Date(Date.UTC(year, m - 1, 1 - back + i));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  });
  return Array.from({ length: cells / 7 }, (_, w) => days.slice(w * 7, w * 7 + 7));
}

/** "November 2024". */
export function monthLabel(month: Month): string {
  const [year, m] = parts(month);
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, m - 1, 1)));
}

export const isMonth = (value: string | null | undefined): value is Month =>
  !!value && MONTH.test(value);
