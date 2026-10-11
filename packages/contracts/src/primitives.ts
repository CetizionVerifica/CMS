import { z } from 'zod';

/**
 * Primitives shared by every entity (docs/contracts/domain-model.md §1).
 * These are shape checks only. Calendar maths (adding days, comparing to "today") belongs to packages/engine.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Lower-case RFC 9562 UUID. Server ids are v7; fixture ids are deterministic v5 (fixtures.md). */
export const Id = z.string().regex(UUID_PATTERN, 'Expected a lower-case UUID');
export type Id = z.infer<typeof Id>;

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in a month of a given year; month is 1-12. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** True when `value` is a real calendar date written as YYYY-MM-DD. */
export function isLocalDate(value: string): boolean {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** Calendar date "YYYY-MM-DD" with no time zone. Due dates, completion dates, periods. */
export const LocalDate = z
  .string()
  .refine(isLocalDate, { message: 'Expected a calendar date YYYY-MM-DD' })
  .brand<'LocalDate'>();
export type LocalDate = z.infer<typeof LocalDate>;

/** ISO 8601 UTC timestamp ending in "Z", e.g. "2026-10-11T09:17:43Z". Event and audit times. */
export const Instant = z.iso.datetime({ offset: false, local: false });
export type Instant = z.infer<typeof Instant>;

/** Month 1-12. */
export const Month = z.int().min(1).max(12);

/** A day in a month that exists in at least one year (29 Feb allowed). */
export const MonthDay = z
  .strictObject({ month: Month, day: z.int().min(1).max(31) })
  .refine((md) => md.day <= daysInMonth(2000, md.month), {
    message: 'Day does not exist in that month',
    path: ['day'],
  });
export type MonthDay = z.infer<typeof MonthDay>;

/** Financial year label "2022-23": the FY that starts in 2022 per the client's fyStartMonth. */
export const FyLabel = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Expected an FY label like 2022-23')
  .refine((fy) => (Number(fy.slice(0, 4)) + 1) % 100 === Number(fy.slice(5)), {
    message: 'FY end year must follow the start year',
  });
export type FyLabel = z.infer<typeof FyLabel>;

/** Trimmed, non-empty text. Empty strings are not valid values; use null instead. */
export const Text = z.string().trim().min(1);

/** Long free text (descriptions, comments). Trimmed, non-empty, line breaks preserved. */
export const LongText = z.string().trim().min(1).max(20_000);

/** Name-like text: trimmed, non-empty, at most 300 characters. */
export const Name = z.string().trim().min(1).max(300);

/** Lower-case hex SHA-256 digest. */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lower-case hex SHA-256');

/** ISO 3166-1 alpha-2 country code, e.g. "IN". */
export const CountryCode = z.string().regex(/^[A-Z]{2}$/, 'Expected an ISO 3166-1 alpha-2 code');

/** Indian state or union territory code as used in obligation refs, e.g. "WB". */
export const StateCode = z.string().regex(/^[A-Z]{2,3}$/, 'Expected an upper-case state code');

/** IANA time zone name, e.g. "Asia/Kolkata". */
export const TimeZone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Expected an IANA time zone' },
);

/** Wall-clock time "HH:mm" (24 hour). */
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

/** Fields every persisted entity carries. `firmId` is the tenant and is never accepted from request bodies. */
export const baseShape = {
  id: Id,
  firmId: Id,
  createdAt: Instant,
  updatedAt: Instant,
  /** Soft delete; there are no hard deletes. */
  archivedAt: Instant.nullable(),
};

/** Optimistic concurrency: starts at 1, +1 per write. */
export const versionedShape = {
  version: z.int().min(1),
};
