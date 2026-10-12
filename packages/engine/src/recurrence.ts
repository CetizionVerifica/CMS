import type { EngineCalendar, GeneratedPeriod, LocalDate, RecurrenceRule } from '@canopy/contracts';
import {
  addDays,
  addMonths,
  clampedDate,
  compareDates,
  fromParts,
  fyBounds,
  fyStartYear,
  isoWeekday,
  toParts,
} from './dates.js';

/**
 * Recurrence: turns a RecurrenceRule into dated periods (packages/engine/CLAUDE.md, docs/adr/0001).
 *
 * Periods are aligned to the financial year (`fyStartMonth`, default April): months, quarters from the FY start,
 * halves from the FY start, and the FY itself. A period is returned when its (holiday-adjusted) due date falls in
 * the requested range, so FY 2022-23 holds the March 2022 TDS deposit due 7 April 2022. Output is sorted by due date
 * then period start, and `periodStart` is unique per rule, so `(assignmentId, periodStart)` is an idempotent key.
 */

export interface Calendar extends EngineCalendar {
  /** Extra non-working dates (public holidays). Sundays are always non-working. */
  holidays?: readonly LocalDate[];
}

export interface DateRange {
  from: LocalDate;
  to: LocalDate;
}

const MONTHS_PER_PERIOD = { MONTH: 1, QUARTER: 3, HALF_YEAR: 6, YEAR: 12 } as const;

/** Consecutive periods of `months` months covering the FY that starts in `fyYear`. */
function fyPeriods(fyYear: number, fyStartMonth: number, months: number): DateRange[] {
  const periods: DateRange[] = [];
  for (let offset = 0; offset < 12; offset += months) {
    const start = addMonths(fyYear, fyStartMonth, offset);
    const end = addMonths(start.year, start.month, months - 1);
    periods.push({
      from: fromParts(start.year, start.month, 1),
      to: clampedDate(end.year, end.month, 'LAST'),
    });
  }
  return periods;
}

/** The date a month/day falls on inside the FY that starts in `fyYear`, clamped (29 Feb becomes 28 Feb). */
function dateInFy(fyYear: number, fyStartMonth: number, month: number, day: number): LocalDate {
  return clampedDate(month >= fyStartMonth ? fyYear : fyYear + 1, month, day);
}

/** Unadjusted periods for the FYs `firstFy..lastFy`. */
function rawPeriods(
  rule: RecurrenceRule,
  firstFy: number,
  lastFy: number,
  fyStartMonth: number,
): GeneratedPeriod[] {
  const out: GeneratedPeriod[] = [];
  switch (rule.kind) {
    case 'ONE_TIME':
      return [{ periodStart: rule.dueDate, periodEnd: rule.dueDate, dueDate: rule.dueDate }];
    case 'EVENT_DRIVEN':
      // Instances are created when the event is recorded (eventInstance), never by the calendar.
      return [];
    case 'FIXED_DATES': {
      // Each fixed date closes a period that starts the day after the previous fixed date.
      const dues: LocalDate[] = [];
      for (let fy = firstFy - 1; fy <= lastFy; fy++) {
        const inFy = rule.dates.map((md) => dateInFy(fy, fyStartMonth, md.month, md.day));
        dues.push(...new Set(inFy));
      }
      dues.sort(compareDates);
      const unique = dues.filter((d, i) => i === 0 || d !== dues[i - 1]);
      for (let i = 1; i < unique.length; i++) {
        const due = unique[i] as LocalDate;
        out.push({
          periodStart: addDays(unique[i - 1] as LocalDate, 1),
          periodEnd: due,
          dueDate: due,
        });
      }
      return out;
    }
    default:
      break;
  }
  for (let fy = firstFy; fy <= lastFy; fy++) {
    switch (rule.kind) {
      case 'MONTHLY':
        for (const p of fyPeriods(fy, fyStartMonth, 1)) {
          const { year, month } = toParts(p.from);
          const dueMonth = addMonths(year, month, rule.offsetMonths);
          out.push({
            periodStart: p.from,
            periodEnd: p.to,
            dueDate: clampedDate(dueMonth.year, dueMonth.month, rule.day),
          });
        }
        break;
      case 'QUARTERLY':
      case 'HALF_YEARLY':
        for (const p of fyPeriods(fy, fyStartMonth, rule.kind === 'QUARTERLY' ? 3 : 6)) {
          const shift = rule.anchor === 'PERIOD_END' ? -rule.days : rule.days;
          out.push({ periodStart: p.from, periodEnd: p.to, dueDate: addDays(p.to, shift) });
        }
        break;
      case 'ANNUAL': {
        const p = fyBounds(fy, fyStartMonth);
        out.push({
          periodStart: p.from,
          periodEnd: p.to,
          dueDate: dateInFy(fy, fyStartMonth, rule.month, rule.day),
        });
        break;
      }
      case 'ONGOING_REVIEW':
        for (const p of fyPeriods(fy, fyStartMonth, MONTHS_PER_PERIOD[rule.every])) {
          out.push({ periodStart: p.from, periodEnd: p.to, dueDate: p.to });
        }
        break;
    }
  }
  return out;
}

function isNonWorkingDay(date: LocalDate, holidays: ReadonlySet<string>): boolean {
  return isoWeekday(date) === 7 || holidays.has(date);
}

/** Moves a due date off Sundays and holidays per the calendar's policy (NONE leaves it alone). */
export function adjustDueDate(date: LocalDate, cal: Calendar): LocalDate {
  if (cal.holidayPolicy === 'NONE') return date;
  const holidays = new Set<string>(cal.holidays ?? []);
  const step = cal.holidayPolicy === 'NEXT_WORKING_DAY' ? 1 : -1;
  let adjusted = date;
  while (isNonWorkingDay(adjusted, holidays)) adjusted = addDays(adjusted, step);
  return adjusted;
}

function checkRange(range: DateRange): void {
  if (compareDates(range.from, range.to) > 0) {
    throw new RangeError(`Range starts after it ends: ${range.from} > ${range.to}`);
  }
}

/** Periods of `rule` whose due date falls in `range` (inclusive), sorted by due date then period start. */
export function generateInstances(
  rule: RecurrenceRule,
  range: DateRange,
  cal: Calendar,
): GeneratedPeriod[] {
  checkRange(range);
  // Due dates can fall up to a year either side of their period, so look one FY wider than the range each way.
  const firstFy = fyStartYear(range.from, cal.fyStartMonth) - 1;
  const lastFy = fyStartYear(range.to, cal.fyStartMonth) + 1;
  return rawPeriods(rule, firstFy, lastFy, cal.fyStartMonth)
    .map((p) => ({ ...p, dueDate: adjustDueDate(p.dueDate, cal) }))
    .filter(
      (p) => compareDates(p.dueDate, range.from) >= 0 && compareDates(p.dueDate, range.to) <= 0,
    )
    .sort(
      (a, b) => compareDates(a.dueDate, b.dueDate) || compareDates(a.periodStart, b.periodStart),
    );
}

/** The instance an EVENT_DRIVEN rule creates when its event happens on `eventDate`. */
export function eventInstance(
  rule: Extract<RecurrenceRule, { kind: 'EVENT_DRIVEN' }>,
  eventDate: LocalDate,
  cal: Calendar,
): GeneratedPeriod {
  return {
    periodStart: eventDate,
    periodEnd: eventDate,
    dueDate: adjustDueDate(addDays(eventDate, rule.withinDays), cal),
  };
}
