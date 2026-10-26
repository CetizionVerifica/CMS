import { describe, expect, it } from 'vitest';
import { ApiError } from '../../auth/index.js';
import { pageOf } from './paging.js';

const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
const cursorOf = (id: string) => Buffer.from(id, 'utf8').toString('base64url');

describe('pageOf: pages of a list M16 sorts itself', () => {
  it('pages after the cursor row, in the list order, with a total on request', () => {
    const first = pageOf(rows, { limit: 2, count: true });
    expect(first).toEqual({
      items: [{ id: 'a' }, { id: 'b' }],
      nextCursor: cursorOf('b'),
      total: 5,
    });
    const second = pageOf(rows, { limit: 2, cursor: first.nextCursor! });
    expect(second).toEqual({ items: [{ id: 'c' }, { id: 'd' }], nextCursor: cursorOf('d') });
    expect(pageOf(rows, { limit: 2, cursor: second.nextCursor! })).toEqual({
      items: [{ id: 'e' }],
      nextCursor: null,
    });
    expect(pageOf(rows, { limit: 5 }).nextCursor).toBeNull();
    expect(pageOf([], { limit: 5, count: true })).toEqual({
      items: [],
      nextCursor: null,
      total: 0,
    });
  });

  it('refuses a cursor that names no row of the list (400 VALIDATION)', () => {
    try {
      pageOf(rows, { limit: 2, cursor: cursorOf('z') });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('VALIDATION');
      expect((error as ApiError).details).toMatchObject({ issues: [{ path: ['cursor'] }] });
    }
  });
});
