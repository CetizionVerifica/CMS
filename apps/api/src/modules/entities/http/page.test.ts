import { describe, expect, it } from 'vitest';
import { FIRM_A, ids, testApp, uid } from '../testing/world.js';

/**
 * The contract allows `limit=200`, which is also the most a store list returns (M3's MAX_LIMIT), so a full-size
 * page cannot read a 201st row to see whether another page follows (M14 finding F13).
 */
describe('a page at the contract maximum', () => {
  const AT = '2026-10-01T00:00:00Z';

  function withDepartments(extra: number) {
    const world = testApp();
    // Client A already has 2 departments (Human Resources and HR).
    for (let i = 0; i < extra; i++) {
      world.store.seed('departments', {
        id: uid(10_000 + i),
        firmId: FIRM_A,
        createdAt: AT,
        updatedAt: AT,
        archivedAt: null,
        version: 1,
        clientId: ids.clientA,
        name: `Dept ${String(i).padStart(3, '0')}`,
        aliases: [],
      });
    }
    return world;
  }
  type Body = { items: { id: string }[]; nextCursor: string | null; total?: number };

  it('returns 200 rows and a cursor when more follow, then the rest', async () => {
    const { call } = withDepartments(199); // 201 in all
    const first = await call(
      'consultant',
      'GET',
      `/clients/${ids.clientA}/departments?limit=200&count=true`,
    );
    expect(first.status).toBe(200);
    const page1 = first.body as Body;
    expect(page1.items).toHaveLength(200);
    expect(page1.total).toBe(201);
    expect(page1.nextCursor).not.toBeNull();
    const second = await call(
      'consultant',
      'GET',
      `/clients/${ids.clientA}/departments?limit=200&cursor=${page1.nextCursor}`,
    );
    const page2 = second.body as Body;
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.items, ...page2.items].map((d) => d.id)).size).toBe(201);
  });

  it('returns no cursor when exactly 200 rows match', async () => {
    const { call } = withDepartments(198);
    const res = await call('consultant', 'GET', `/clients/${ids.clientA}/departments?limit=200`);
    expect(res.status).toBe(200);
    expect((res.body as Body).items).toHaveLength(200);
    expect((res.body as Body).nextCursor).toBeNull();
  });

  it('still reads one row ahead below the maximum', async () => {
    const { call } = withDepartments(0);
    const res = await call('consultant', 'GET', `/clients/${ids.clientA}/departments?limit=1`);
    expect((res.body as Body).items).toHaveLength(1);
    expect((res.body as Body).nextCursor).not.toBeNull();
  });
});
