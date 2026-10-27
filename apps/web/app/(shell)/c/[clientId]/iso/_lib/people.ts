// People and units as the ISO screens show them: by name, never by id.

export type PersonOption = { id: string; name: string };

/** A person's name, or "Someone" for a person the user can't list (the API still shows them the record). */
export function nameOf(people: readonly PersonOption[], id: string | null | undefined): string {
  if (!id) return 'Nobody yet';
  return people.find((p) => p.id === id)?.name ?? 'Someone';
}

/** Several names, joined: "Nisha Patil, Rohan Joshi". */
export function namesOf(people: readonly PersonOption[], ids: readonly string[]): string {
  return ids.length === 0 ? 'None' : ids.map((id) => nameOf(people, id)).join(', ');
}

/** Today's date where the client is (YYYY-MM-DD), for date pickers. Formatting only: no due-date rule uses it. */
export function clientToday(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The client-local calendar date of a UTC timestamp (root CLAUDE.md rule 4), as `YYYY-MM-DD`. */
export function clientDate(timestamp: string, timeZone: string): string {
  return clientToday(timeZone, new Date(timestamp));
}

/** The client-local wall time of a UTC timestamp, as `HH:MM`, for a time field. */
export function clientTime(timestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(timestamp));
}

/** Milliseconds the client's wall clock is ahead of UTC at `ms`. */
function zoneOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - ms;
}

/**
 * The UTC instant of a client-local date (`YYYY-MM-DD`) and wall time (`HH:MM`), as an ISO timestamp; null when either
 * is not one. Entry only: no rule compares it here, the API does.
 */
export function instantAt(date: string, time: string, timeZone: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!d || !t) return null;
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  let ms = wall - zoneOffset(wall, timeZone);
  ms = wall - zoneOffset(ms, timeZone);
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/** An href with its query; empty values left out. */
export function hrefWith(path: string, query: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

/** The first value of a search param. */
export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A comma-separated search param as a list, keeping only allowed values when given. */
export function listParam(
  value: string | string[] | undefined,
  allowed?: readonly string[],
): string[] {
  const text = first(value);
  if (!text) return [];
  const values = text.split(',').filter(Boolean);
  return allowed ? values.filter((v) => allowed.includes(v)) : values;
}
