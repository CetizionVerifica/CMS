// Periods and due dates per recurrence rule, written out for test doubles: firm B's fixture and the mock server's
// rule preview. A plain reading of packages/engine/CLAUDE.md, not the engine; product code calls the engine.
import type { z } from 'zod';
import type { RecurrenceRule as RuleSchema } from '../schemas/library.js';

/** Input type, so plain date strings are accepted. */
type RecurrenceRule = z.input<typeof RuleSchema>;

const pad = (n: number) => String(n).padStart(2, '0');
const DAY = 86_400_000;
const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => fromMs(toMs(date) + days * DAY);
export const lastDayOf = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();
export function monthAdd(year: number, month: number, add: number) {
  const total = year * 12 + (month - 1) + add;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}
export const dateOf = (year: number, month: number, day: number | 'LAST') =>
  `${year}-${pad(month)}-${pad(day === 'LAST' ? lastDayOf(year, month) : Math.min(day, lastDayOf(year, month)))}`;
export function span(year: number, month: number, length: number) {
  const end = monthAdd(year, month, length - 1);
  return {
    periodStart: dateOf(year, month, 1),
    periodEnd: dateOf(end.year, end.month, 'LAST'),
  };
}

export interface Period {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
}

/** Periods of one FY starting at (year, month), written out per rule kind. */
export function periodsIn(rule: RecurrenceRule, year: number, month: number): Period[] {
  const slices = (length: number) =>
    Array.from({ length: 12 / length }, (_, i) => {
      const start = monthAdd(year, month, i * length);
      return span(start.year, start.month, length);
    });
  const fyEnd = span(year, month, 12).periodEnd;
  /** The occurrence of a month/day inside this FY. */
  const inFy = (m: number, d: number) => {
    const y = m >= month ? year : year + 1;
    return dateOf(y, m, d);
  };
  switch (rule.kind) {
    case 'MONTHLY':
      return slices(1).map((p) => {
        const due = monthAdd(
          Number(p.periodStart.slice(0, 4)),
          Number(p.periodStart.slice(5, 7)),
          rule.offsetMonths,
        );
        return { ...p, dueDate: dateOf(due.year, due.month, rule.day) };
      });
    case 'QUARTERLY':
    case 'HALF_YEARLY':
      return slices(rule.kind === 'QUARTERLY' ? 3 : 6).map((p) => ({
        ...p,
        dueDate: addDays(p.periodEnd, rule.days),
      }));
    case 'ANNUAL':
      return [{ ...span(year, month, 12), dueDate: inFy(rule.month, rule.day) }];
    case 'FIXED_DATES': {
      const length = 12 / rule.dates.length;
      return rule.dates.map(({ month: m, day: d }) => {
        const dueDate = inFy(m, d);
        const start = monthAdd(Number(dueDate.slice(0, 4)), m, -length);
        return { ...span(start.year, start.month, length), dueDate };
      });
    }
    case 'ONGOING_REVIEW': {
      const length = { MONTH: 1, QUARTER: 3, HALF_YEAR: 6, YEAR: 12 }[rule.every];
      return slices(length).map((p) => ({ ...p, dueDate: p.periodEnd }));
    }
    case 'ONE_TIME':
      return rule.dueDate >= dateOf(year, month, 1) && rule.dueDate <= fyEnd
        ? [{ periodStart: rule.dueDate, periodEnd: rule.dueDate, dueDate: rule.dueDate }]
        : [];
    case 'EVENT_DRIVEN':
      return [];
  }
}

/** Periods whose due date falls in [from, to], for a client whose FY starts in `fyStartMonth`. */
export function previewPeriods(
  rule: RecurrenceRule,
  from: string,
  to: string,
  fyStartMonth: number,
): Period[] {
  const year = Number(from.slice(0, 4));
  const periods: Period[] = [];
  // Start one FY early: a period of the previous FY can fall due inside the range.
  for (let fy = year - 2; `${fy}` <= to.slice(0, 4); fy += 1) {
    periods.push(...periodsIn(rule, fy, fyStartMonth));
  }
  return periods.filter((p) => from <= p.dueDate && p.dueDate <= to);
}
