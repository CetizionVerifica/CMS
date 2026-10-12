import { Id } from '@canopy/contracts';
import { z } from 'zod';
import type { ListQuery, Repo } from '../store.js';
import { invalid } from './errors.js';

/**
 * Cursor pagination (api-conventions.md §3). The cursor is opaque to clients: the sort key and id of the last row
 * of the previous page, base64url-encoded.
 */

const CursorShape = z.strictObject({ k: z.string(), id: Id });

export function encodeCursor(key: string, id: string): string {
  return Buffer.from(JSON.stringify({ k: key, id })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { key: string; id: string } | null {
  if (cursor === undefined) return null;
  try {
    const parsed = CursorShape.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return { key: parsed.k, id: parsed.id };
  } catch {
    throw invalid('Unknown cursor; start again from the first page.', ['query', 'cursor']);
  }
}

export interface PageParams {
  limit: number;
  cursor?: string | undefined;
  count?: boolean | undefined;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

/** One page of `repo` rows, sorted by `orderBy` then id. */
export async function pageOf<T extends { id: Id }>(
  repo: Repo<T>,
  page: PageParams,
  query: Omit<ListQuery<T>, 'after' | 'limit' | 'count'>,
): Promise<Page<T>> {
  const result = await repo.list({
    ...query,
    after: decodeCursor(page.cursor),
    limit: page.limit + 1,
    count: page.count === true,
  });
  const items = result.items.slice(0, page.limit);
  const last = items[items.length - 1];
  const nextCursor =
    result.items.length > page.limit && last
      ? encodeCursor(String(last[query.orderBy]), last.id)
      : null;
  return {
    items,
    nextCursor,
    ...(page.count === true ? { total: result.total ?? 0 } : {}),
  };
}
