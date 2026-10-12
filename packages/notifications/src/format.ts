import type { LocalDate } from '@canopy/contracts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-07" → "7 Oct 2026". Reads the string, so no time zone can shift the day. */
export function formatDate(date: LocalDate): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** "1 day", "3 days". */
export function days(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/** Only http(s) links go into emails; anything else would be a script or tracking vector. */
export function safeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new RangeError(`Email links must be http(s): ${parsed.protocol}`);
  }
  return parsed.toString();
}
