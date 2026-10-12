// The selected period lives in the URL (apps/web/CLAUDE.md): `?fy=2022-23`, plus `&q=Q3` or `&m=2022-10`.
// This file reads and writes that query string, and turns a period into the dates an API query takes. Which period is
// "this period", and which instances fall in a period, come from the API (engine output).
import { FyLabel, LocalDate } from '@canopy/contracts';

export type Quarter = 1 | 2 | 3 | 4;
export type Period = { fy: string; quarter?: Quarter; month?: string };

type Params = { get(name: string): string | null };

const QUARTER = /^Q([1-4])$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The period in the URL, or undefined when there is none or it is malformed (pages then use the API default). */
export function periodFromParams(params: Params): Period | undefined {
  const fy = params.get('fy');
  if (!fy || !FyLabel.safeParse(fy).success) return undefined;
  const q = QUARTER.exec(params.get('q') ?? '');
  if (q) return { fy, quarter: Number(q[1]) as Quarter };
  const m = params.get('m');
  if (m && MONTH.test(m) && monthInFy(m, fy)) return { fy, month: m };
  return { fy };
}

/** A month belongs to an FY when it falls within the two calendar years the label names. */
function monthInFy(month: string, fy: string): boolean {
  const year = Number(month.slice(0, 4));
  const start = Number(fy.slice(0, 4));
  return year === start || year === start + 1;
}

/** Writes the period into a copy of the query string, keeping every other parameter (filters, sort, view). */
export function withPeriod(search: string | URLSearchParams, period: Period): URLSearchParams {
  const next = new URLSearchParams(search);
  next.set('fy', period.fy);
  next.delete('q');
  next.delete('m');
  if (period.quarter) next.set('q', `Q${period.quarter}`);
  else if (period.month) next.set('m', period.month);
  return next;
}

/** Query string for links that should carry the current period to another page ("" when there is none). */
export function periodQuery(period: Period | undefined): string {
  if (!period) return '';
  return `?${withPeriod('', period).toString()}`;
}

/** What the API takes for a period: a whole FY by label, or an inclusive range of calendar dates. */
export type PeriodApiQuery = { fy: string } | { from: LocalDate; to: LocalDate };

const pad = (n: number) => String(n).padStart(2, '0');

/** The first day of a calendar month and the last, as LocalDates. `month0` may run past 11 into later years. */
function monthRange(
  year: number,
  month0: number,
  months: number,
): { from: LocalDate; to: LocalDate } {
  const start = new Date(Date.UTC(year, month0, 1));
  const end = new Date(Date.UTC(year, month0 + months, 0));
  const iso = (d: Date) =>
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { from: LocalDate.parse(iso(start)), to: LocalDate.parse(iso(end)) };
}

/**
 * The selected period as API query values: `{ fy }` for a whole FY, otherwise the quarter's or month's first and last
 * day. Q3 of 2022-23 with an April FY start is `{ from: '2022-10-01', to: '2022-12-31' }`. Pages map `from`/`to` onto
 * the endpoint's own names (`dueFrom`/`dueTo`). Calendar arithmetic only; which instances fall in the range is the
 * API's decision.
 */
export function periodApiQuery(period: Period, fyStartMonth: number): PeriodApiQuery {
  if (!Number.isInteger(fyStartMonth) || fyStartMonth < 1 || fyStartMonth > 12) {
    throw new RangeError(`fyStartMonth must be an integer 1-12, got ${fyStartMonth}`);
  }
  if (period.month) {
    const [year, month] = period.month.split('-').map(Number) as [number, number];
    return monthRange(year, month - 1, 1);
  }
  if (period.quarter) {
    const fyStartYear = Number(period.fy.slice(0, 4));
    return monthRange(fyStartYear, fyStartMonth - 1 + (period.quarter - 1) * 3, 3);
  }
  return { fy: period.fy };
}
