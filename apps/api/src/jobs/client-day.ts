import type { ClientSettings, LocalDate } from '@canopy/contracts';
import { addDays, fyBounds, fyStartYear, localDateIn } from '@canopy/engine';

/** A client's "today" and wall-clock time, from the job's instant and the client's time zone. */
export interface ClientDay {
  today: LocalDate;
  /** "HH:mm", 24-hour. */
  localTime: string;
}

export function clientDay(now: string, timeZone: string): ClientDay {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const part = (type: 'hour' | 'minute') => parts.find((p) => p.type === type)!.value;
  return { today: localDateIn(now, timeZone), localTime: `${part('hour')}:${part('minute')}` };
}

/**
 * True once the client's send time has passed today. "HH:mm" strings compare correctly as text. Missed days are
 * not caught up: a reminder planned for a day the jobs did not run is skipped, never sent late.
 */
export function sendTimeReached(day: ClientDay, settings: ClientSettings): boolean {
  return day.localTime >= settings.reminders.sendAtLocalTime;
}

/** The client's current and next financial year, as one due-date range. */
export function currentAndNextFy(
  today: LocalDate,
  fyStartMonth: number,
): { from: LocalDate; to: LocalDate } {
  const year = fyStartYear(today, fyStartMonth);
  return { from: fyBounds(year, fyStartMonth).from, to: fyBounds(year + 1, fyStartMonth).to };
}

/** Due dates the engine could plan a notification for on `today`, given the reminder offsets. */
export function reminderWindow(
  today: LocalDate,
  settings: ClientSettings,
): { from: LocalDate; to: LocalDate } {
  const { ownerDaysBefore, approverDaysAfter } = settings.reminders;
  return {
    from: addDays(today, -Math.max(0, ...approverDaysAfter)),
    to: addDays(today, Math.max(0, ...ownerDaysBefore)),
  };
}
