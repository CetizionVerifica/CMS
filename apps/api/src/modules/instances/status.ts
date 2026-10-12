import type { DerivedStatus, InstanceStatusInput, LocalDate } from '@canopy/contracts';
import { engine, localDateIn } from '@canopy/engine';

/** The status columns of a register row. Always from the engine; the API never works status out itself. */
export interface RowStatus {
  status: DerivedStatus;
  /** Days past due when OVERDUE, else null (InstanceRow.overdueDays). */
  overdueDays: number | null;
}

export function rowStatus(
  instance: InstanceStatusInput,
  asOf: LocalDate,
  settings: { dueSoonDays: number },
): RowStatus {
  const { status, overdueDays } = engine.deriveStatus(instance, asOf, settings);
  return { status, overdueDays };
}

/** "Today" for a client: the calendar date of `now` (a UTC instant) in the client's time zone. */
export function clientToday(now: string, timeZone: string): LocalDate {
  return localDateIn(now, timeZone);
}
