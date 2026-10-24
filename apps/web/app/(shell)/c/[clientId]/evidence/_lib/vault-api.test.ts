// @vitest-environment node
// Node, as on the server: M0's mock server (behind lib/api/mock.ts) reads its fixtures from disk.
import { MAX_PAGE_LIMIT } from '@canopy/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createApiClient, type ApiClient } from '../../../../../../lib/api/client';
import {
  MOCK_CLIENTS,
  MOCK_MFA_CODE,
  MOCK_PASSWORD,
  mockFetch,
} from '../../../../../../lib/api/mock';
import { instanceHref, loadLookups, loadVault, vaultQuery } from './vault-api';

const CLIENT = MOCK_CLIENTS.demoMetals;
const api = (cookie?: string) =>
  createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie });

async function as(email: string, mfa = false): Promise<ApiClient> {
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (mfa) cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  return api(cookie);
}
const q = (s: string) => vaultQuery(new URLSearchParams(s));

describe('vaultQuery', () => {
  it('keeps the vault’s valid filters and drops everything else', () => {
    expect(q('')).toBe('');
    expect(q('q=challan&scanStatus=CLEAN,PENDING&view=x&limit=5&cursor=c')).toBe(
      'q=challan&scanStatus=CLEAN%2CPENDING',
    );
    expect(q('scanStatus=SHINY&unitId=not-an-id&uploadedFrom=15/11/2024')).toBe('');
    expect(q('uploadedFrom=2024-11-01&uploadedTo=2024-11-30')).toBe(
      'uploadedFrom=2024-11-01&uploadedTo=2024-11-30',
    );
    // A backwards range keeps its start.
    expect(q('uploadedFrom=2024-11-30&uploadedTo=2024-11-01')).toBe('uploadedFrom=2024-11-30');
    expect(q('q=')).toBe('');
  });
});

describe('loadVault', () => {
  it('loads the client’s files newest first, with the count on the first page', async () => {
    const consultant = await as('consultant@demo.test', true);
    const page = await loadVault(consultant, CLIENT, '');
    expect(page.total).toBeGreaterThanOrEqual(page.rows.length);
    const times = page.rows.map((e) => e.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    for (const e of page.rows) expect(e.clientId).toBe(CLIENT);

    const clean = await loadVault(consultant, CLIENT, 'scanStatus=CLEAN');
    for (const e of clean.rows) expect(e.scanStatus).toBe('CLEAN');
  });

  it('asks for exactly the query, and the next page without the count', async () => {
    const call = vi.fn(async () => ({ data: { items: [], nextCursor: null } }));
    await loadVault({ call } as never, CLIENT, 'q=challan');
    await loadVault({ call } as never, CLIENT, 'q=challan', 'next');
    expect(call).toHaveBeenNthCalledWith(1, 'evidenceVault', {
      params: { clientId: CLIENT },
      query: { q: 'challan', limit: String(MAX_PAGE_LIMIT), count: 'true' },
    });
    expect(call).toHaveBeenNthCalledWith(2, 'evidenceVault', {
      params: { clientId: CLIENT },
      query: { q: 'challan', limit: String(MAX_PAGE_LIMIT), cursor: 'next' },
    });
  });
});

describe('loadLookups', () => {
  it('names the client’s people and lists its units, sorted', async () => {
    const consultant = await as('consultant@demo.test', true);
    const { names, units } = await loadLookups(consultant, CLIENT);
    expect(Object.keys(names).length).toBeGreaterThan(0);
    expect(units.length).toBeGreaterThan(0);
    expect(units.map((u) => u.label)).toEqual([...units.map((u) => u.label)].sort());
  });

  it('works without them when the lists fail', async () => {
    const call = vi.fn(async () => {
      throw new Error('down');
    });
    expect(await loadLookups({ call } as never, CLIENT)).toEqual({ names: {}, units: [] });
  });

  it('links a file to its instance’s drawer', () => {
    expect(instanceHref(CLIENT, 'a b')).toBe(`/c/${CLIENT}/register/a%20b`);
  });
});
