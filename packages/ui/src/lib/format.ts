// Display formatting only (foundations §9). Values, counts, statuses and day counts come from the API; these helpers
// never compute compliance facts.

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Short month name for 1-12. */
export const monthShort = (month: number): string => MONTHS[(month - 1 + 12) % 12]!;
/** Long month name for 1-12. */
export const monthLong = (month: number): string => MONTHS_LONG[(month - 1 + 12) % 12]!;

/**
 * Formats a calendar date string (YYYY-MM-DD, no time zone) as "31 Mar 2027". It reads the parts directly, so the
 * browser's time zone can never shift the day (root CLAUDE.md: dates are dates).
 */
export function formatDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return `${Number(m[3])} ${monthShort(Number(m[2]))} ${m[1]}`;
}

/** Formats a count with Indian grouping by default (1,00,000); pass 'en-GB' for 100,000. */
export function formatNumber(value: number, locale: 'en-IN' | 'en-GB' = 'en-IN'): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}

/** Percent without decimals, unless under 1% (then one decimal): "82%", "0.4%". */
export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return `${Math.round(percent * 10) / 10}%`;
  return `${Math.round(percent)}%`;
}

/** Warns in development only. Never pass personal data or evidence details (root CLAUDE.md rule 6). */
export function devWarn(message: string): void {
  const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV;
  if (env !== 'production') console.warn(`[@canopy/ui] ${message}`);
}
