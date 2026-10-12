// Calendar-date helpers for the DateInput's calendar grid. Values are YYYY-MM-DD strings with no time zone; the UTC
// Date is used only to count days and find weekdays, so the viewer's time zone can never move a date.
// Due-date maths stays in packages/engine (root CLAUDE.md rule 3); these helpers only lay out and parse input.

import { monthLong, monthShort } from './format';

const pad = (n: number) => String(n).padStart(2, '0');

export function toIso(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parts(iso: string): { year: number; month: number; day: number } {
  return {
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidIso(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const { year, month, day } = parts(iso);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function addDays(iso: string, days: number): string {
  const { year, month, day } = parts(iso);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Same day in another month, clamped to that month's length (31 Jan + 1 month → 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const { year, month, day } = parts(iso);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return toIso(y, m, Math.min(day, daysInMonth(y, m)));
}

/** Day of week with Monday = 0 … Sunday = 6. */
export function weekdayMon0(iso: string): number {
  const { year, month, day } = parts(iso);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/** Weeks (Monday first) covering the month that contains `iso`; days outside the month are null. */
export function monthWeeks(iso: string): (string | null)[][] {
  const { year, month } = parts(iso);
  const first = toIso(year, month, 1);
  const lead = weekdayMon0(first);
  const days: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= daysInMonth(year, month); d += 1) days.push(toIso(year, month, d));
  while (days.length % 7) days.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

/**
 * Parses what a person typed: "31 Mar 2027", "31 March 2027", "31/03/2027", "31-03-2027" or "2027-03-31".
 * Day first, as in India. Returns null when it is not a real date.
 */
export function parseDateInput(text: string): string | null {
  const t = text.trim();
  let iso: string | null = null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) iso = toIso(Number(m[1]), Number(m[2]), Number(m[3]));
  if (!iso) {
    const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
    if (numeric) iso = toIso(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  }
  if (!iso) {
    const named = /^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/.exec(t);
    if (named) {
      const name = named[2]!.toLowerCase();
      const month =
        Array.from({ length: 12 }, (_, i) => i + 1).find(
          (n) => monthShort(n).toLowerCase() === name || monthLong(n).toLowerCase() === name,
        ) ?? 0;
      if (month > 0) iso = toIso(Number(named[3]), month, Number(named[1]));
    }
  }
  return iso && isValidIso(iso) ? iso : null;
}
