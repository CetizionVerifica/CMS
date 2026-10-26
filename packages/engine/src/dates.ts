import { Instant, isLocalDate, type LocalDate } from '@canopy/contracts';

/**
 * Calendar-date helpers. A LocalDate is an ISO "YYYY-MM-DD" string with no time zone.
 * All arithmetic goes through day numbers (days since 1970-01-01), never JS `Date`.
 */

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** Checks a string is a real calendar date and brands it, or throws a RangeError. */
export function asLocalDate(value: string): LocalDate {
  if (!isLocalDate(value)) throw new RangeError(`Not a calendar date YYYY-MM-DD: ${value}`);
  return value as LocalDate;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in a month of a given year; month is 1-12. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function toParts(date: LocalDate): DateParts {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

/** Builds a LocalDate from parts; throws if the date does not exist. */
export function fromParts(year: number, month: number, day: number): LocalDate {
  const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return asLocalDate(text);
}

/** The given day of a month, clamped to the month's last day ("LAST" is the last day). */
export function clampedDate(year: number, month: number, day: number | 'LAST'): LocalDate {
  const last = daysInMonth(year, month);
  return fromParts(year, month, day === 'LAST' ? last : Math.min(day, last));
}

/** Days since 1970-01-01 (proleptic Gregorian). */
export function toDayNumber(date: LocalDate): number {
  const { year, month, day } = toParts(date);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromDayNumber(dayNumber: number): LocalDate {
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return fromParts(year, month, day);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return fromDayNumber(toDayNumber(date) + days);
}

/** `to - from` in days: positive when `to` is later. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return toDayNumber(to) - toDayNumber(from);
}

/** -1, 0 or 1. LocalDates with four-digit years order as strings. */
export function compareDates(a: LocalDate, b: LocalDate): -1 | 0 | 1 {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  // 1970-01-01 was a Thursday (4).
  return ((((toDayNumber(date) + 3) % 7) + 7) % 7) + 1;
}

/** Year and month `delta` months after the given month. */
export function addMonths(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** `date` plus `months` calendar months, the day clamped to the month's end (29 Feb + 12 months is 28 Feb). */
export function addMonthsToDate(date: LocalDate, months: number): LocalDate {
  const { year, month, day } = toParts(date);
  const target = addMonths(year, month, months);
  return clampedDate(target.year, target.month, day);
}

function checkFyStartMonth(fyStartMonth: number): void {
  if (!Number.isInteger(fyStartMonth) || fyStartMonth < 1 || fyStartMonth > 12) {
    throw new RangeError(`fyStartMonth must be an integer 1-12, got ${fyStartMonth}`);
  }
}

/** The calendar year in which the financial year containing `date` starts. */
export function fyStartYear(date: LocalDate, fyStartMonth: number): number {
  checkFyStartMonth(fyStartMonth);
  const { year, month } = toParts(date);
  return month >= fyStartMonth ? year : year - 1;
}

/** First and last day of the financial year that starts in `startYear`. */
export function fyBounds(
  startYear: number,
  fyStartMonth: number,
): { from: LocalDate; to: LocalDate } {
  checkFyStartMonth(fyStartMonth);
  const from = fromParts(startYear, fyStartMonth, 1);
  const end = addMonths(startYear, fyStartMonth, 11);
  return { from, to: clampedDate(end.year, end.month, 'LAST') };
}

/** FY label like "2022-23" for the financial year containing `date`. */
export function fyLabel(date: LocalDate, fyStartMonth: number): string {
  const start = fyStartYear(date, fyStartMonth);
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Bounds of the financial year named by a label like "2022-23". */
export function fyRangeOf(label: string, fyStartMonth: number): { from: LocalDate; to: LocalDate } {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (!match || (Number(match[1]) + 1) % 100 !== Number(match[2])) {
    throw new RangeError(`Not an FY label like 2022-23: ${label}`);
  }
  return fyBounds(Number(match[1]), fyStartMonth);
}

/**
 * The calendar date an instant falls on in an IANA time zone: "today" for a client is
 * `localDateIn(now, client.settings.timeZone)`, with `now` passed in by the caller (the engine reads no clock).
 * Use it before comparing a timestamp with a due date. Throws a RangeError for a malformed instant or time zone.
 */
export function localDateIn(instant: string, timeZone: string): LocalDate {
  if (!Instant.safeParse(instant).success) {
    throw new RangeError(`Not a UTC instant like 2026-10-11T09:17:43Z: ${instant}`);
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: 'year' | 'month' | 'day'): number =>
    Number(parts.find((p) => p.type === type)?.value);
  return fromParts(part('year'), part('month'), part('day'));
}
