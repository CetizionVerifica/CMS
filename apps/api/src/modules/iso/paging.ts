import { ApiError } from '../../auth/index.js';

/**
 * A page of a list M16 sorts itself (a client's certificates, by expiry): the rows after the cursor's row, in the
 * list's order. The cursor is the last row's id, as M3's keyset pages carry it; a cursor that names no row of the list
 * is a 400, since the list it came from has changed.
 */

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

const encode = (id: string) => Buffer.from(id, 'utf8').toString('base64url');
const decode = (cursor: string) => Buffer.from(cursor, 'base64url').toString('utf8');

export function pageOf<T extends { id: string }>(
  rows: readonly T[],
  page: { limit: number; cursor?: string | undefined; count?: boolean | undefined },
): Paged<T> {
  let start = 0;
  if (page.cursor !== undefined) {
    const at = rows.findIndex((r) => r.id === decode(page.cursor!));
    if (at < 0) {
      throw new ApiError('VALIDATION', {
        issues: [{ path: ['cursor'], message: 'This cursor is not from this list' }],
      });
    }
    start = at + 1;
  }
  const items = rows.slice(start, start + page.limit);
  const more = start + page.limit < rows.length;
  return {
    items,
    nextCursor: more ? encode(items[items.length - 1]!.id) : null,
    ...(page.count === true ? { total: rows.length } : {}),
  };
}
