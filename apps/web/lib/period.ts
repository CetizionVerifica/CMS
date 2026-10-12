// The selected period lives in the URL (apps/web/CLAUDE.md): `?fy=2022-23`, plus `&q=Q3` or `&m=2022-10`.
// This file only reads and writes that query string. Which period is "this period", and which instances fall in a
// period, come from the API (engine output).
import { FyLabel } from '@canopy/contracts';

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
