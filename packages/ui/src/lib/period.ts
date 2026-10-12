// Period labels for the PeriodPicker (spec 03). Label formatting only: which instances fall in a period, and which
// period is "this period", come from the engine through the API. Nothing here decides a due date or a status.

import { monthLong, monthShort } from './format';

export type Quarter = 1 | 2 | 3 | 4;

/** A reporting period. `fy` is "2022-23"; set at most one of quarter or month (YYYY-MM). */
export type Period = { fy: string; quarter?: Quarter; month?: string };

export type PeriodMonth = { value: string; year: number; month: number };

/** First calendar year of an FY key: "2022-23" → 2022. */
export function fyStartYear(fy: string): number {
  return Number(fy.slice(0, 4));
}

/** "2022-23" → "FY 2022–23" (en dash, foundations §9). */
export function fyLabel(fy: string): string {
  return `FY ${fy.replace('-', '–')}`;
}

/** The twelve months of an FY in order, for laying out the month grid. Apr … Mar when the FY starts in April. */
export function fyMonths(fy: string, fyStartMonth = 4): PeriodMonth[] {
  const first = fyStartYear(fy);
  return Array.from({ length: 12 }, (_, i) => {
    const offset = fyStartMonth - 1 + i;
    const year = first + Math.floor(offset / 12);
    const month = (offset % 12) + 1;
    return { value: `${year}-${String(month).padStart(2, '0')}`, year, month };
  });
}

/** The three months of a quarter within the FY grid. */
export function quarterMonths(fy: string, quarter: Quarter, fyStartMonth = 4): PeriodMonth[] {
  return fyMonths(fy, fyStartMonth).slice((quarter - 1) * 3, quarter * 3);
}

function parseMonth(value: string): { year: number; month: number } {
  return { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)) };
}

/** "Oct 2022" */
export function monthLabel(value: string): string {
  const { year, month } = parseMonth(value);
  return `${monthShort(month)} ${year}`;
}

/** "October 2022" */
export function monthName(value: string): string {
  const { year, month } = parseMonth(value);
  return `${monthLong(month)} ${year}`;
}

/** "Q3 Oct–Dec" */
export function quarterLabel(fy: string, quarter: Quarter, fyStartMonth = 4): string {
  const months = quarterMonths(fy, quarter, fyStartMonth);
  return `Q${quarter} ${monthShort(months[0]!.month)}–${monthShort(months[2]!.month)}`;
}

/** Visible chip text: "FY 2022–23", "FY 2022–23 · Q3" or "FY 2022–23 · Oct 2022". */
export function periodLabel(p: Period): string {
  if (p.month) return `${fyLabel(p.fy)} · ${monthLabel(p.month)}`;
  if (p.quarter) return `${fyLabel(p.fy)} · Q${p.quarter}`;
  return fyLabel(p.fy);
}

/** Spoken name: "FY 2022–23, quarter 3" or "FY 2022–23, October 2022". */
export function periodName(p: Period): string {
  if (p.month) return `${fyLabel(p.fy)}, ${monthName(p.month)}`;
  if (p.quarter) return `${fyLabel(p.fy)}, quarter ${p.quarter}`;
  return fyLabel(p.fy);
}

export function samePeriod(a: Period | undefined, b: Period | undefined): boolean {
  return !!a && !!b && a.fy === b.fy && a.quarter === b.quarter && a.month === b.month;
}
