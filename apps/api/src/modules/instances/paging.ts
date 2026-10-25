import { REGISTER_READ_LIMIT, type RegisterFilter, type RegisterRow } from '@canopy/db';
import { ApiError } from '../../auth/index.js';

/**
 * Keyset paging over one or more register queries, merged in register order (due date, then id).
 *
 * The register repository filters in SQL but cannot apply derived status (engine work, root CLAUDE.md rule 3),
 * several categories at once, or several clients at once. So a page is filled by reading each source in
 * order from the same position, merging, and keeping the rows `keep` accepts, until the page is full or the
 * sources run out. A page can come back short with a `nextCursor` when the filter is sparse; clients keep
 * following `nextCursor` until it is null (api-conventions.md §3).
 *
 * The cursor is the register position `{ dueDate, id }` of the last row read, the same position the
 * repository's own cursor names, so it can be handed to every source.
 */

export interface RegisterSource {
  clientId: string;
  filter: RegisterFilter;
}

export type ReadRegister<R extends Position = RegisterRow> = (
  source: RegisterSource,
  page: { limit: number; cursor: string | undefined },
) => Promise<{ items: R[]; nextCursor: string | null }>;

/** A register position: what the merge orders by. */
export interface Position {
  dueDate: string;
  id: string;
}

/** Register queries per page before a short page is returned. */
export const MAX_READS_PER_PAGE = 10;

export function encodeCursor(position: Position): string {
  return Buffer.from(
    JSON.stringify({ dueDate: position.dueDate, id: position.id }),
    'utf8',
  ).toString('base64url');
}

function compare(a: Position, b: Position): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export async function mergedPage<R extends Position, T>(
  sources: readonly RegisterSource[],
  read: ReadRegister<R>,
  options: {
    limit: number;
    cursor: string | undefined;
    /** Maps a row to the item returned, or null to leave it out. */
    keep: (row: R) => T | null;
  },
): Promise<{ items: T[]; nextCursor: string | null }> {
  if (sources.length === 0) return { items: [], nextCursor: null };
  if (sources.length > 50) {
    throw new ApiError('VALIDATION', {
      issues: [{ path: [], message: 'Too many filter combinations; narrow the filter.' }],
    });
  }
  const items: T[] = [];
  let cursor = options.cursor;
  for (let reads = 0; reads < MAX_READS_PER_PAGE; reads++) {
    const need = options.limit - items.length;
    const pages = [];
    for (const source of sources) pages.push(await read(source, { limit: need, cursor }));
    // The first `need` rows of the merge are among the first `need` rows of each source.
    const merged = pages.flatMap((p) => p.items).sort(compare);
    const batch = merged.slice(0, need);
    const more = merged.length > need || pages.some((p) => p.nextCursor !== null);
    for (const row of batch) {
      const item = options.keep(row);
      if (item !== null) items.push(item);
    }
    const last = batch.at(-1);
    if (!more || last === undefined) return { items, nextCursor: null };
    cursor = encodeCursor(last);
    if (items.length === options.limit) break;
  }
  return { items, nextCursor: cursor ?? null };
}

/**
 * Rows per register query when counting: the repository's largest page for whole-client reads, so a count at
 * 10,000 instances is a handful of queries rather than fifty (security review F16).
 */
export const COUNT_PAGE_SIZE = REGISTER_READ_LIMIT;

/**
 * `?count=true`'s `total`: how many rows of all the sources `keep` accepts. The sources a list reads are
 * disjoint (one per category, or per client), so each is read through on its own and the counts added. Like
 * the page, this reads rows rather than counting in SQL, because derived status is engine work.
 */
export async function countMatching<R extends Position>(
  sources: readonly RegisterSource[],
  read: ReadRegister<R>,
  keep: (row: R) => boolean,
): Promise<number> {
  let total = 0;
  for (const source of sources) {
    let cursor: string | undefined;
    do {
      const page = await read(source, { limit: COUNT_PAGE_SIZE, cursor });
      for (const row of page.items) if (keep(row)) total += 1;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  }
  return total;
}
