import type {
  InferredRule,
  LocalDate,
  MonthDay,
  RecurrenceRule,
  TimelineType,
} from '@canopy/contracts';
import { addMonths, clampedDate, compareDates, daysBetween, toParts } from './dates.js';
import { generateInstances, type Calendar } from './recurrence.js';

/**
 * Rule inference for import (docs/adr/0001): given the due dates a register holds for one obligation, find the
 * RecurrenceRule that regenerates them best.
 *
 * Candidates are generated over the window the register covers (`coverage`, default: first to last due date) and
 * compared with the dates as a multiset: `confidence` = matched dates / max(expected, generated), so a register that
 * starts mid-year is not penalised for the months it does not hold.
 *  1. The best periodic rule wins: highest confidence, then the fewest periods a year, then the preference order
 *     (ONGOING obligations try ONGOING_REVIEW first; TIME_BASED ones ANNUAL, QUARTERLY, HALF_YEARLY, MONTHLY).
 *  2. When periodic rules of different frequencies all match every date (a window too short to tell, such as one
 *     date), the rule is ambiguous and its confidence is halved so import flags it TO_REVIEW.
 *  3. FIXED_DATES is tried only when no periodic rule matches every date, for two to four distinct month/days, and
 *     only wins when strictly better. From a window shorter than a year its confidence is halved too, because the
 *     dates the register does not cover are unknown.
 * Quarter and half-year offsets are tried up to 31 days before the period end and 60 days after it.
 */

export interface InferOptions {
  /** The span the register covers (e.g. the FY it was exported for). Defaults to the first and last due date. */
  coverage?: { from: LocalDate; to: LocalDate };
}

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
): { periodic: RecurrenceRule[]; fixed: RecurrenceRule | null } {
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
  return {
    periodic: timelineType === 'ONGOING' ? [...ongoing, ...periodic] : [...periodic, ...ongoing],
    // One month/day is ANNUAL already.
    fixed:
      monthDays.length > 1 && monthDays.length <= MAX_FIXED_DATES
        ? { kind: 'FIXED_DATES', dates: monthDays }
        : null,
  };
}

/** Periods a year; lower means a sparser rule. */
const PER_YEAR = { MONTH: 12, QUARTER: 4, HALF_YEAR: 2, YEAR: 1 } as const;
function perYear(rule: RecurrenceRule): number {
  switch (rule.kind) {
    case 'MONTHLY':
      return 12;
    case 'QUARTERLY':
      return 4;
    case 'HALF_YEARLY':
      return 2;
    case 'ONGOING_REVIEW':
      return PER_YEAR[rule.every];
    default:
      return 1;
  }
}

/** Infers the recurrence rule behind a register's due dates for one obligation. */
export function inferRule(
  dueDates: readonly LocalDate[],
  timelineType: TimelineType,
  cal: Calendar,
  options: InferOptions = {},
): InferredRule {
  if (dueDates.length === 0) throw new RangeError('inferRule needs at least one due date');
  const expected = [...dueDates].sort(compareDates);
  const first = expected[0] as LocalDate;
  const last = expected.at(-1) as LocalDate;
  const coverage = options.coverage;
  const window = {
    from: coverage && compareDates(coverage.from, first) < 0 ? coverage.from : first,
    to: coverage && compareDates(coverage.to, last) > 0 ? coverage.to : last,
  };
  const scoreRule = (rule: RecurrenceRule): Scored =>
    score(
      rule,
      expected,
      generateInstances(rule, window, cal).map((p) => p.dueDate),
    );

  const { periodic, fixed } = candidates(expected, timelineType, cal.fyStartMonth);
  const scored = periodic.map(scoreRule);
  let best = scored[0] as Scored;
  for (const result of scored) {
    if (
      result.confidence > best.confidence ||
      (result.confidence === best.confidence && perYear(result.rule) < perYear(best.rule))
    ) {
      best = result;
    }
  }
  const shortWindow = daysBetween(window.from, window.to) < 364;
  if (best.confidence === 1) {
    const exactFrequencies = new Set(
      scored.filter((r) => r.confidence === 1).map((r) => perYear(r.rule)),
    );
    return exactFrequencies.size > 1 ? { ...best, confidence: 0.5 } : best;
  }
  if (fixed) {
    const result = scoreRule(fixed);
    const confidence = shortWindow ? result.confidence / 2 : result.confidence;
    if (confidence >= best.confidence) return { ...result, confidence };
  }
  return best;
}
