import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../../lib/api/client';
import { act } from './test-data';

vi.mock('server-only', () => ({}));
const { loadAllActs, toSearchParams } = await import('./library-data');

function fakeApi(pages: { items: ReturnType<typeof act>[]; nextCursor: string | null }[]) {
  const call = vi.fn(async (_name: string, req: { query: { cursor?: string } }) => {
    const index = req.query.cursor ? Number(req.query.cursor) : 0;
    return { data: pages[index]!, setCookies: [] };
  });
  return { api: { call } as unknown as ApiClient, call };
}

describe('loadAllActs', () => {
  it('follows the cursor until the last page', async () => {
    const { api, call } = fakeApi([
      { items: [act(1), act(2)], nextCursor: '1' },
      { items: [act(3)], nextCursor: null },
    ]);
    expect((await loadAllActs(api)).map((a) => a.name)).toEqual(['Act 1', 'Act 2', 'Act 3']);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenNthCalledWith(1, 'listActs', { query: { limit: '200' } });
    expect(call).toHaveBeenNthCalledWith(2, 'listActs', { query: { limit: '200', cursor: '1' } });
  });

  it('stops after 5 pages', async () => {
    const { api, call } = fakeApi(
      Array.from({ length: 7 }, (_, i) => ({ items: [act(i)], nextCursor: String(i + 1) })),
    );
    expect(await loadAllActs(api)).toHaveLength(5);
    expect(call).toHaveBeenCalledTimes(5);
  });
});

describe('toSearchParams', () => {
  it('keeps the first value of repeated keys and skips missing ones', () => {
    expect(
      toSearchParams({ q: 'pf', domain: ['HRS', 'EHS'], none: undefined, empty: [] }).toString(),
    ).toBe('q=pf&domain=HRS');
  });
});
