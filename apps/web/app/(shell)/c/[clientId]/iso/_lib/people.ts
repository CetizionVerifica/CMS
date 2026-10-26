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
