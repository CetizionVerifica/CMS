import type { LocalDate } from '@canopy/contracts';
import { addDays, compareDates, localDateIn } from '@canopy/engine';
import { ApiError } from '../../auth/index.js';

/**
 * Pure helpers for the evidence vault and audit trail reads: turning the contract's query bounds into the
 * half-open instant ranges M3's repositories take, and limiting a unit filter to what a person may see.
 */

/** Further than any UTC offset (UTC-12 to UTC+14) from midnight UTC on the same date. */
const SEARCH_MS = 18 * 60 * 60 * 1000;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The first instant of `date` in `timeZone`. Root rule 4: the comparison goes through the engine's
 * `localDateIn`, searching the millisecond at which the local date turns to `date` (offsets, including old
 * ones with seconds, are whole milliseconds).
 */
export function startOfDayIn(date: LocalDate, timeZone: string): string {
  const midnightUtc = Date.parse(`${date}T00:00:00.000Z`);
  let before = midnightUtc - SEARCH_MS;
  let onOrAfter = midnightUtc + SEARCH_MS;
  while (onOrAfter - before > 1) {
    const mid = Math.floor((before + onOrAfter) / 2);
    if (compareDates(localDateIn(iso(mid), timeZone), date) >= 0) onOrAfter = mid;
    else before = mid;
  }
  return iso(onOrAfter);
}

/** The first and last calendar dates a `LocalDate` can name; nothing lies outside them. */
const FIRST_DATE = '0001-01-01';
const LAST_DATE = '9999-12-31';

/**
 * `uploadedFrom`/`uploadedTo`, inclusive client calendar dates, as the half-open instants [from, to). A bound
 * at the first or last date excludes nothing, so it is left out: its instant would fall outside the years
 * an instant can name.
 */
export function uploadWindow(
  query: { uploadedFrom?: LocalDate | undefined; uploadedTo?: LocalDate | undefined },
  timeZone: string,
): { uploadedFrom?: string; uploadedTo?: string } {
  const { uploadedFrom: from, uploadedTo: to } = query;
  return {
    ...(from === undefined || from <= FIRST_DATE
      ? {}
      : { uploadedFrom: startOfDayIn(from, timeZone) }),
    ...(to === undefined || to >= LAST_DATE
      ? {}
      : { uploadedTo: startOfDayIn(addDays(to, 1), timeZone) }),
  };
}

/**
 * The contract's inclusive `to` as the repository's exclusive bound. Instants are compared to the
 * millisecond (M3 reads them as `Date`), so the bound is the next millisecond.
 */
export function exclusiveTo(to: string): string {
  return iso(Date.parse(to) + 1);
}

/**
 * The units to filter by: the ones asked for, limited to the person's `scope` (null = every unit). An
 * empty result matches nothing.
 */
export function scopedUnits(
  asked: readonly string[] | undefined,
  scope: readonly string[] | null,
): string[] | undefined {
  if (scope === null) return asked === undefined ? undefined : [...asked];
  if (asked === undefined) return [...scope];
  return asked.filter((id) => scope.includes(id));
}

/** A page cursor these lists hand out (an id, base64url); anything else is a 400 on `cursor`. */
export function requireCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    throw new ApiError('VALIDATION', { issues: [{ path: ['cursor'], message: 'Invalid cursor' }] });
  }
  return cursor;
}
