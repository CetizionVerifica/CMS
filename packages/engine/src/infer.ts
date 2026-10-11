import type {
  InferredRule,
  LocalDate,
  MonthDay,
  RecurrenceRule,
  TimelineType,
} from '@canopy/contracts';
import {
  addMonths,
  clampedDate,
  compareDates,
  daysBetween,
  fyBounds,
  fyStartYear,
  toParts,
} from './dates.js';
import { generateInstances, type Calendar } from './recurrence.js';

/**
 * Rule inference for import (docs/adr/0001): given the due dates a register holds for one obligation, find the
 * RecurrenceRule that regenerates them best.
 *
 * Every candidate is generated over the FYs the dates span and compared with the dates as a multiset.
 * `confidence` = matched dates / max(expected, generated). The highest confidence wins; ties go to the earlier
 * candidate in the preference order (ONGOING obligations prefer ONGOING_REVIEW, TIME_BASED ones prefer the named
 * periodic kinds; FIXED_DATES comes last and is only tried for at most four distinct dates a year, so drifting
 * monthly dates come back as MONTHLY with mismatches instead of a 12-date list). Quarter and half-year offsets are
 * tried up to 31 days before the period end and 60 days after it.
 */

const MAX_FIXED_DATES = 4;
/** Statutory "within N days" windows rarely pass these; beyond them a fixed date list reads better. */
const MAX_DAYS_BEFORE_END = 31;
const MAX_DAYS_AFTER_END = 60;

interface Scored {
  rule: RecurrenceRule;
  confidence: number;
  mismatches: InferredRule['mismatches'];
}

/** Matches `generated` against `expected` as multisets; unmatched expected dates pair with the nearest spare one. */
function score(
  rule: RecurrenceRule,
  expected: readonly LocalDate[],
  generated: LocalDate[],
): Scored {
  const spare = [...generated];
  const unmatched: LocalDate[] = [];
  for (const date of expected) {
    const at = spare.indexOf(date);
    if (at >= 0) spare.splice(at, 1);
    else unmatched.push(date);
  }
  const matched = expected.length - unmatched.length;
  const mismatches = unmatched.map((date) => {
    let best = -1;
    for (let i = 0; i < spare.length; i++) {
      const gap = Math.abs(daysBetween(date, spare[i] as LocalDate));
      if (best < 0 || gap < Math.abs(daysBetween(date, spare[best] as LocalDate))) best = i;
    }
    const generatedDate = best < 0 ? null : (spare.splice(best, 1)[0] as LocalDate);
    return { expected: date, generated: generatedDate };
  });
  return {
    rule,
    confidence: matched / Math.max(expected.length, generated.length),
    mismatches,
  };
}

/** Day offsets that would put each date on a quarter/half rule, before the period end and after the previous one. */
function anchorRules(
  kind: 'QUARTERLY' | 'HALF_YEARLY',
  dates: readonly LocalDate[],
  fyStartMonth: number,
): RecurrenceRule[] {
  const months = kind === 'QUARTERLY' ? 3 : 6;
  const before = new Set<number>([0]);
  const after = new Set<number>();
  for (const date of dates) {
    const { year, month } = toParts(date);
    // Months since the FY start, rounded down to the period, give the period containing the date.
    const sinceFyStart = (((month - fyStartMonth) % 12) + 12) % 12;
    const start = addMonths(year, month, -(sinceFyStart % months));
    const end = addMonths(start.year, start.month, months - 1);
    const prevEnd = addMonths(start.year, start.month, -1);
    const periodEnd = clampedDate(end.year, end.month, 'LAST');
    const previousEnd = clampedDate(prevEnd.year, prevEnd.month, 'LAST');
    before.add(daysBetween(date, periodEnd));
    after.add(daysBetween(previousEnd, date));
  }
  const rules: RecurrenceRule[] = [];
  for (const days of [...before].sort((a, b) => a - b)) {
    if (days <= MAX_DAYS_BEFORE_END) rules.push({ kind, anchor: 'PERIOD_END', days });
  }
  for (const days of [...after].sort((a, b) => a - b)) {
    if (days <= MAX_DAYS_AFTER_END) rules.push({ kind, anchor: 'AFTER_PERIOD_END', days });
  }
  return rules;
}

function distinctMonthDays(dates: readonly LocalDate[], fyStartMonth: number): MonthDay[] {
  const seen = new Map<string, MonthDay>();
  for (const date of dates) {
    const { month, day } = toParts(date);
    seen.set(`${month}-${day}`, { month, day });
  }
  const fyOrder = (md: MonthDay): number =>
    ((((md.month - fyStartMonth) % 12) + 12) % 12) * 100 + md.day;
  return [...seen.values()].sort((a, b) => fyOrder(a) - fyOrder(b));
}

function candidates(
  dates: readonly LocalDate[],
  timelineType: TimelineType,
  fyStartMonth: number,
): RecurrenceRule[] {
  const monthDays = distinctMonthDays(dates, fyStartMonth);
  const ongoing: RecurrenceRule[] = (['QUARTER', 'MONTH', 'HALF_YEAR', 'YEAR'] as const).map(
    (every) => ({
      kind: 'ONGOING_REVIEW',
      every,
    }),
  );
  const annual: RecurrenceRule[] = monthDays.map((md) => ({ kind: 'ANNUAL', ...md }));
  const days = [...new Set(dates.map((d) => toParts(d).day))].sort((a, b) => a - b);
  // A numeric due day is usually for the previous month (TDS by the 7th); "LAST" usually closes its own month.
  const monthly: RecurrenceRule[] = [
    { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    { kind: 'MONTHLY', day: 'LAST', offsetMonths: 1 },
    ...days.flatMap((day): RecurrenceRule[] => [
      { kind: 'MONTHLY', day, offsetMonths: 1 },
      { kind: 'MONTHLY', day, offsetMonths: 0 },
    ]),
  ];
  const periodic = [
    ...annual,
    ...anchorRules('QUARTERLY', dates, fyStartMonth),
    ...anchorRules('HALF_YEARLY', dates, fyStartMonth),
    ...monthly,
  ];
  const fixed: RecurrenceRule[] =
    monthDays.length <= MAX_FIXED_DATES ? [{ kind: 'FIXED_DATES', dates: monthDays }] : [];
  return timelineType === 'ONGOING'
    ? [...ongoing, ...periodic, ...fixed]
    : [...periodic, ...ongoing, ...fixed];
}

/** Infers the recurrence rule behind a register's due dates for one obligation. */
export function inferRule(
  dueDates: readonly LocalDate[],
  timelineType: TimelineType,
  cal: Calendar,
): InferredRule {
  if (dueDates.length === 0) throw new RangeError('inferRule needs at least one due date');
  const expected = [...dueDates].sort(compareDates);
  const range = {
    from: fyBounds(fyStartYear(expected[0] as LocalDate, cal.fyStartMonth), cal.fyStartMonth).from,
    to: fyBounds(fyStartYear(expected.at(-1) as LocalDate, cal.fyStartMonth), cal.fyStartMonth).to,
  };
  let best: Scored | null = null;
  for (const rule of candidates(expected, timelineType, cal.fyStartMonth)) {
    const generated = generateInstances(rule, range, cal).map((p) => p.dueDate);
    const result = score(rule, expected, generated);
    if (best === null || result.confidence > best.confidence) best = result;
  }
  return best as Scored;
}
