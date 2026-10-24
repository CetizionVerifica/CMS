// @vitest-environment node
// Node, as on the server: M0's mock server (behind lib/api/mock.ts) reads its fixtures from disk.
import { MAX_BULK_ITEMS, MAX_PAGE_LIMIT } from '@canopy/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient, type ApiClient } from '../../../../../../lib/api/client';
import {
  MOCK_CLIENTS,
  MOCK_MFA_CODE,
  MOCK_PASSWORD,
  mockFetch,
} from '../../../../../../lib/api/mock';
import {
  approvableItems,
  approveItems,
  bulkMessage,
  chunks,
  exportState,
  loadFacets,
  loadPage,
  startExport,
} from './register-api';

const CLIENT = MOCK_CLIENTS.demoMetals;
const api = (cookie?: string, csrfToken?: string) =>
  createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie, csrfToken });

/** A signed-in client for a demo account, with the CSRF token state-changing calls need. */
async function as(email: string, mfa = false): Promise<ApiClient> {
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (mfa) cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  const { data } = await api(cookie).me();
  return api(cookie, data.csrfToken);
}

/** A stand-in API whose `call` answers by endpoint name. */
function fakeApi(answer: (name: string, request: unknown) => unknown) {
  const call = vi.fn(async (name: string, request: unknown) => ({
    data: await answer(name, request),
    setCookies: [],
  }));
  return { call } as unknown as Pick<ApiClient, 'call'> & { call: typeof call };
}

describe('loadPage', () => {
  it('loads the first page with its count, then the next page by cursor', async () => {
    const consultant = await as('consultant@demo.test', true);
    const first = await loadPage(consultant, CLIENT, 'sort=dueDate');
    expect(first.rows.length).toBeGreaterThan(0);
    expect(first.rows.length).toBeLessThanOrEqual(MAX_PAGE_LIMIT);
    expect(first.total).toBeGreaterThanOrEqual(first.rows.length);
    if (first.nextCursor) {
      const second = await loadPage(consultant, CLIENT, 'sort=dueDate', first.nextCursor);
      expect(second.total).toBeUndefined();
      expect(second.rows[0]!.id).not.toBe(first.rows[0]!.id);
    }
  });

  it('sends the register query, the page size and the count to the API', async () => {
    const fake = fakeApi(() => ({ items: [], nextCursor: null, total: 0 }));
    await loadPage(fake, CLIENT, 'status=OVERDUE&fy=2022-23');
    expect(fake.call).toHaveBeenCalledWith('listInstances', {
      params: { clientId: CLIENT },
      query: { status: 'OVERDUE', fy: '2022-23', limit: '200', count: 'true' },
    });
    await loadPage(fake, CLIENT, 'status=OVERDUE', 'c2');
    expect(fake.call).toHaveBeenLastCalledWith('listInstances', {
      params: { clientId: CLIENT },
      query: { status: 'OVERDUE', limit: '200', cursor: 'c2' },
    });
  });
});

describe('bulk approve', () => {
  it('splits items into requests of at most 200', () => {
    const items = Array.from({ length: 450 }, (_, i) => i);
    expect(chunks(items).map((c) => c.length)).toEqual([200, 200, 50]);
    expect(chunks([])).toEqual([]);
    expect(MAX_BULK_ITEMS).toBe(200);
  });

  it('sends every item with its version, 200 per request, and counts each result', async () => {
    const items = Array.from({ length: 450 }, (_, i) => ({
      id: `00000000-0000-5000-8000-${String(i).padStart(12, '0')}`,
      version: (i % 3) + 1,
    }));
    const fake = fakeApi((_name, request) => {
      const body = (request as { body: { items: { id: string }[] } }).body;
      return {
        results: body.items.map(({ id }, i) =>
          i === 0
            ? { id, ok: false, error: { code: 'STALE_VERSION', message: 'stale' } }
            : { id, ok: true },
        ),
      };
    });
    const outcome = await approveItems(fake, CLIENT, items);
    const sent = fake.call.mock.calls.map(
      ([, request]) => (request as { body: { items: unknown[] } }).body.items,
    );
    expect(sent.map((batch) => batch.length)).toEqual([200, 200, 50]);
    expect(sent.flat()).toEqual(items);
    expect(fake.call.mock.calls[0]![1]).toMatchObject({ params: { clientId: CLIENT } });
    expect(outcome).toEqual({ approved: 447, skipped: { changed: 3 } });
  });

  it('counts a request that fails as a whole and carries on with the next', async () => {
    const items = Array.from({ length: 250 }, (_, i) => ({
      id: `00000000-0000-5000-8000-${String(i).padStart(12, '0')}`,
      version: 1,
    }));
    let calls = 0;
    const fake = fakeApi((_name, request) => {
      calls += 1;
      if (calls === 1) throw new ApiError(403, 'FORBIDDEN', 'no');
      const body = (request as { body: { items: { id: string }[] } }).body;
      return { results: body.items.map(({ id }) => ({ id, ok: true })) };
    });
    expect(await approveItems(fake, CLIENT, items)).toEqual({
      approved: 50,
      skipped: { 'not-allowed': 200 },
    });
    const broken = fakeApi(() => {
      throw new TypeError('network down');
    });
    await expect(approveItems(broken, CLIENT, items)).rejects.toThrow('network down');
  });

  it('names each reason an item was not approved', async () => {
    const codes = ['INVALID_TRANSITION', 'NOT_FOUND', 'ACCESS_EXPIRED', 'EVIDENCE_REQUIRED'];
    const fake = fakeApi((_name, request) => {
      const body = (request as { body: { items: { id: string }[] } }).body;
      return {
        results: body.items.map(({ id }, i) =>
          i < codes.length
            ? { id, ok: false, error: { code: codes[i], message: 'no' } }
            : { id, ok: false },
        ),
      };
    });
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: `00000000-0000-5000-8000-${String(i).padStart(12, '0')}`,
      version: 1,
    }));
    expect(await approveItems(fake, CLIENT, items)).toEqual({
      approved: 0,
      skipped: { 'not-waiting': 1, 'not-allowed': 2, failed: 2 },
    });
  });

  it('approves a submission as its approver, and refuses one changed since it was read', async () => {
    const approver = await as('approver@demo.test');
    const waiting = await approvableItems(approver, CLIENT, 'sort=dueDate');
    expect(waiting.length).toBeGreaterThan(0);
    const item = waiting[0]!;
    expect(await approveItems(approver, CLIENT, [{ ...item, version: item.version + 5 }])).toEqual({
      approved: 0,
      skipped: { changed: 1 },
    });
    expect(await approveItems(approver, CLIENT, [item])).toEqual({ approved: 1, skipped: {} });
    const after = await approvableItems(approver, CLIENT, 'sort=dueDate');
    expect(after.map((i) => i.id)).not.toContain(item.id);
  });

  it('finds every matching row waiting for approval, across pages', async () => {
    let page = 0;
    const fake = fakeApi(() => {
      page += 1;
      const row = { id: `id-${page}`, version: page };
      return { items: [row], nextCursor: page < 3 ? `c${page}` : null };
    });
    expect(await approvableItems(fake, CLIENT, 'status=OVERDUE')).toEqual([
      { id: 'id-1', version: 1 },
      { id: 'id-2', version: 2 },
      { id: 'id-3', version: 3 },
    ]);
    expect(fake.call.mock.calls[0]![1]).toMatchObject({
      query: { status: 'OVERDUE', workflowState: 'SUBMITTED' },
    });
    expect(await approvableItems(fake, CLIENT, 'workflowState=SUBMITTED,OPEN')).toHaveLength(1);
    // A view of other workflow states has nothing to approve, and asks the API nothing.
    const calls = fake.call.mock.calls.length;
    expect(await approvableItems(fake, CLIENT, 'workflowState=APPROVED')).toEqual([]);
    expect(fake.call.mock.calls.length).toBe(calls);
  });

  it('says what happened in one sentence', () => {
    expect(bulkMessage({ approved: 1, skipped: {} })).toEqual({
      tone: 'success',
      message: 'Approved 1 instance.',
    });
    expect(bulkMessage({ approved: 0, skipped: {} })).toEqual({
      tone: 'warn',
      message: 'Nothing in this view is waiting for approval.',
    });
    expect(
      bulkMessage({
        approved: 12,
        skipped: { changed: 1, 'not-waiting': 2, 'not-allowed': 1, failed: 3 },
      }),
    ).toEqual({
      tone: 'warn',
      message:
        'Approved 12 instances. Not approved: 1 changed since you opened the register, 2 aren’t waiting for ' +
        'approval, 1 isn’t yours to approve, 3 couldn’t be approved.',
    });
    expect(
      bulkMessage({ approved: 0, skipped: { 'not-waiting': 1, 'not-allowed': 2 } }).message,
    ).toBe(
      'Approved 0 instances. Not approved: 1 isn’t waiting for approval, 2 aren’t yours to approve.',
    );
  });
});

describe('filter choices', () => {
  it('loads departments, Acts, units and categories, sorted by name', async () => {
    const consultant = await as('consultant@demo.test', true);
    const facets = await loadFacets(consultant, CLIENT);
    expect(facets.departments.length).toBeGreaterThan(0);
    expect(facets.units.length).toBeGreaterThan(0);
    expect(facets.acts.length).toBeGreaterThan(0);
    const labels = facets.departments.map((d) => d.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it('leaves a list without choices when it fails, and uses an Act’s short name', async () => {
    const fake = fakeApi((name) => {
      if (name === 'listUnits') throw new ApiError(403, 'FORBIDDEN', 'no');
      if (name === 'listActs') {
        return {
          items: [
            { id: 'a2', name: 'The Factories Act, 1948', shortName: 'Factories Act' },
            { id: 'a1', name: 'Building Act', shortName: null },
          ],
          nextCursor: null,
        };
      }
      return { items: [{ id: `${name}-1`, name: 'One' }], nextCursor: null };
    });
    expect(await loadFacets(fake, CLIENT)).toEqual({
      departments: [{ value: 'listDepartments-1', label: 'One' }],
      acts: [
        { value: 'a1', label: 'Building Act' },
        { value: 'a2', label: 'Factories Act' },
      ],
      units: [],
      categories: [{ value: 'listCategories-1', label: 'One' }],
    });
  });
});

describe('export', () => {
  it('starts an Excel export of this view and returns its download link when done', async () => {
    const consultant = await as('consultant@demo.test', true);
    const id = await startExport(consultant, CLIENT, 'status=OVERDUE&sort=dueDate');
    const state = await exportState(consultant, id);
    expect(state.status).toBe('ready');
    expect(state.status === 'ready' && state.url).toMatch(/^https?:\/\//);
  });

  it('reports a pending or failed export', async () => {
    for (const [status, expected] of [
      ['QUEUED', 'pending'],
      ['RUNNING', 'pending'],
      ['FAILED', 'failed'],
    ] as const) {
      const fake = fakeApi(() => ({ status }));
      expect(await exportState(fake, 'x')).toEqual({ status: expected });
      expect(fake.call).toHaveBeenCalledTimes(1);
    }
  });
});
