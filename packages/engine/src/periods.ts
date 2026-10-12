import type { ClientPeriods, LocalDate } from '@canopy/contracts';
import { compareDates, fyLabel, fyStartYear, fromParts, toParts } from './dates.js';

export interface ClientPeriodsInput {
  /** Today in the client's time zone (`localDateIn(now, client.timeZone)`). */
  today: LocalDate;
  fyStartMonth: number;
  /** First and last generated period dates for the client, both null when nothing is generated yet. */
  generatedFrom: LocalDate | null;
  generatedTo: LocalDate | null;
}

/**
 * The periods a client's period picker offers (contracts `ClientPeriods`): the FY and FY quarter containing `today`,
 * the current FY plus every FY from the first to the last generated date (generation is contiguous, so every FY in
 * between has instances), oldest first, and the last generated month.
 */
export function clientPeriods({
  today,
  fyStartMonth,
  generatedFrom,
  generatedTo,
}: ClientPeriodsInput): ClientPeriods {
  const currentStart = fyStartYear(today, fyStartMonth);
  const monthInFy = (toParts(today).month - fyStartMonth + 12) % 12;
  const current = { fy: fyLabel(today, fyStartMonth), quarter: Math.floor(monthInFy / 3) + 1 };

  if (generatedFrom === null || generatedTo === null) {
    if (generatedFrom !== generatedTo) {
      throw new RangeError('generatedFrom and generatedTo must both be dates or both be null');
    }
    return { current, availableFys: [current.fy], availableUntil: null };
  }
  if (compareDates(generatedFrom, generatedTo) > 0) {
    throw new RangeError(`generatedFrom ${generatedFrom} is after generatedTo ${generatedTo}`);
  }

  const firstGenerated = fyStartYear(generatedFrom, fyStartMonth);
  const lastGenerated = fyStartYear(generatedTo, fyStartMonth);
  const starts = new Set([currentStart]);
  for (let start = firstGenerated; start <= lastGenerated; start++) starts.add(start);
  const availableFys = [...starts]
    .sort((a, b) => a - b)
    .map((start) => fyLabel(fromParts(start, fyStartMonth, 1), fyStartMonth));
  return { current, availableFys, availableUntil: generatedTo.slice(0, 7) };
}
