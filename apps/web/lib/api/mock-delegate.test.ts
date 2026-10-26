// @vitest-environment node
// Node, as on the server: M0's mock server reads its fixtures from disk.
import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from './client';
import { MOCK_CLIENTS, MOCK_COMPANY_EMAIL, MOCK_MFA_CODE, MOCK_PASSWORD, mockFetch } from './mock';
import { CLIENT_MAP, delegateToM0, PERSON_MAP } from './mock-delegate';

const api = (cookie?: string) =>
  createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie });

async function sessionFor(email: string, mfa = false): Promise<string> {
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (mfa) cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  return cookie;
}

describe('routes the shell mock does not answer go to M0’s mock server', () => {
  it('lists a client’s instances under our client id, parsed by the contract schema', async () => {
    const owner = await sessionFor('owner@demo.test');
    const { data } = await api(owner).call('listInstances', {
      params: { clientId: MOCK_CLIENTS.demoMetals },
      query: { limit: '5' },
    });
    expect(data.items.length).toBeGreaterThan(0);
    // Firm B's ids never leak: the rows carry the client id the page asked for.
    for (const row of data.items) expect(row.clientId).toBe(MOCK_CLIENTS.demoMetals);
    expect(JSON.stringify(data)).not.toContain(CLIENT_MAP[0]!.theirs);
  });

  it('runs M0’s mock at firm B’s "today", so its work has come due', async () => {
    const owner = await sessionFor('owner@demo.test');
    const { data } = await api(owner).call('listInstances', {
      params: { clientId: MOCK_CLIENTS.demoMetals },
      query: { status: 'OVERDUE', limit: '1', count: 'true' },
    });
    // At the old 2023-03-15 nothing in firm B's data was due yet, so nothing could be overdue.
    expect(data.total).toBeGreaterThan(0);
  });

  it('gives each mapped client the financial year and periods M0 reports for its firm B client', async () => {
    const admin = await sessionFor('admin@demo.test', true);
    const ours = (await api(admin).me()).data.clients;
    const res = await delegateToM0(
      'admin@demo.test',
      ['isoManagement'],
      'GET',
      new URL('http://api.test/api/v1/me'),
      undefined,
    );
    const theirs = ((await res.json()) as { clients: typeof ours }).clients;
    for (const { ours: id } of CLIENT_MAP) {
      const shell = ours.find((c) => c.id === id)!;
      const m0 = theirs.find((c) => c.id === id)!;
      expect({ fyStartMonth: shell.fyStartMonth, period: shell.period }).toEqual({
        fyStartMonth: m0.fyStartMonth,
        period: m0.period,
      });
    }
    // Northwind Textiles stands in for Harbour Retail Group, which keeps a January financial year.
    expect(ours.find((c) => c.id === MOCK_CLIENTS.northwind)!.fyStartMonth).toBe(1);
  });

  it('answers the client overview for a firm user, with our client name', async () => {
    const consultant = await sessionFor('consultant@demo.test', true);
    const { data } = await api(consultant).call('clientOverview', {
      params: { clientId: MOCK_CLIENTS.northwind },
    });
    const text = JSON.stringify(data);
    expect(text).not.toContain('Harbour Retail Group');
    expect(text).not.toContain(CLIENT_MAP[1]!.theirs);
  });

  it('translates the signed-in person’s own id both ways, so “mine” matches what /me says', async () => {
    const owner = await sessionFor('owner@demo.test');
    const me = (await api(owner).me()).data.person.id;
    const theirs = PERSON_MAP['owner@demo.test']!;
    const list = async (ownerId: string) =>
      (
        await api(owner).call('listIsoRisks', {
          params: { clientId: MOCK_CLIENTS.demoMetals },
          query: { ownerId },
        })
      ).data;
    // The shell's own id reaches M0 as the firm B person: the same rows as `ownerId=me`.
    const mine = await list(me);
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.map((r) => r.id)).toEqual((await list('me')).items.map((r) => r.id));
    // And M0's answers come back under the shell's id, never firm B's.
    for (const risk of mine.items) expect(risk.ownerId).toBe(me);
    expect(JSON.stringify(mine)).not.toContain(theirs);
  });

  it('keeps each person to their own client, and has no data for an unmapped client', async () => {
    const owner = await sessionFor('owner@demo.test');
    await expect(
      api(owner).call('listInstances', { params: { clientId: MOCK_CLIENTS.northwind } }),
      // M0 answers 404 for a client outside the actor's scope, so it doesn't reveal that the client exists.
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const admin = await sessionFor('admin@demo.test', true);
    await expect(
      api(admin).call('clientOverview', { params: { clientId: MOCK_CLIENTS.sunrise } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('still needs a session and MFA before anything reaches M0', async () => {
    await expect(
      api().call('listInstances', { params: { clientId: MOCK_CLIENTS.demoMetals } }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const consultant = await sessionFor('consultant@demo.test');
    await expect(
      api(consultant).call('clientOverview', { params: { clientId: MOCK_CLIENTS.demoMetals } }),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });

  it('shares one server across copies of the module, as page renders and Server Actions load it', async () => {
    const owner = await sessionFor('owner@demo.test');
    const list = () =>
      api(owner).call('listInstances', {
        params: { clientId: MOCK_CLIENTS.demoMetals },
        query: { limit: '1' },
      });
    await list();
    const first = (globalThis as { __ppMockServer?: unknown }).__ppMockServer;
    expect(first).toBeDefined();
    vi.resetModules();
    const fresh = await import('./mock-delegate');
    const url = new URL(
      `http://api.test/api/v1/clients/${MOCK_CLIENTS.demoMetals}/instances?limit=1`,
    );
    expect((await fresh.delegateToM0('owner@demo.test', [], 'GET', url, undefined)).status).toBe(
      200,
    );
    expect((globalThis as { __ppMockServer?: unknown }).__ppMockServer).toBe(first);
  });
});

// ISO-7b: each demo user's own add-ons reach M0 as `x-mock-features`, so `/me` and every delegated route agree.
describe('the delegate forwards the signed-in account’s add-ons', () => {
  /** A raw request through the shell mock, for routes the typed client doesn't list (the ISO ones). */
  const get = (cookie: string, path: string) =>
    mockFetch(`http://api.test/api/v1${path}`, { headers: { cookie } });
  const isoSystems = `/clients/${MOCK_CLIENTS.demoMetals}/iso/systems`;
  /** How many instances Demo Metals' register lists, all of them or one `source`'s. */
  const registerTotal = async (cookie: string, source?: 'LAW' | 'ISO') =>
    (
      await api(cookie).call('listInstances', {
        params: { clientId: MOCK_CLIENTS.demoMetals },
        query: { count: 'true', limit: '1', ...(source ? { source } : {}) },
      })
    ).data.total ?? 0;

  it('sends the account’s features as the header, and an empty header for an account without add-ons', async () => {
    const inject = vi.fn();
    const shared = globalThis as { __ppMockServer?: unknown };
    const saved = shared.__ppMockServer;
    shared.__ppMockServer = Promise.resolve({
      inject: inject.mockResolvedValue({ statusCode: 204, headers: {}, body: '' }),
    });
    try {
      const url = new URL('http://api.test/api/v1/me');
      await delegateToM0('consultant@demo.test', ['isoManagement'], 'GET', url, undefined);
      await delegateToM0(MOCK_COMPANY_EMAIL, [], 'GET', url, undefined);
    } finally {
      shared.__ppMockServer = saved;
    }
    const sent = inject.mock.calls.map(
      ([req]) => (req as { headers: Record<string, string> }).headers,
    );
    expect(sent[0]).toMatchObject({ 'x-mock-features': 'isoManagement' });
    // Present but empty: leaving it out would give firm B's add-ons, which include ISO.
    expect(sent[1]).toMatchObject({ 'x-mock-features': '' });
  });

  it('agrees with the shell’s /me on each demo user’s add-ons', async () => {
    for (const [email, mfa] of [
      ['consultant@demo.test', true],
      ['owner@demo.test', false],
      [MOCK_COMPANY_EMAIL, true],
    ] as const) {
      const cookie = await sessionFor(email, mfa);
      const shell = (await api(cookie).me()).data.account?.features;
      const res = await delegateToM0(
        email,
        shell ?? [],
        'GET',
        new URL('http://api.test/api/v1/me'),
        undefined,
      );
      const m0 = ((await res.json()) as { account?: { features?: string[] } }).account?.features;
      expect(m0, email).toEqual(shell);
    }
  });

  it('refuses ISO routes and hides STANDARD work for the company admin, whose account has no add-ons', async () => {
    const company = await sessionFor(MOCK_COMPANY_EMAIL, true);
    const res = await get(company, isoSystems);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: 'FEATURE_NOT_ENABLED', details: { feature: 'isoManagement' } },
    });
    // The register lists the statutory work only: the same rows another demo user gets with the Law filter.
    const consultant = await sessionFor('consultant@demo.test', true);
    const law = await registerTotal(consultant, 'LAW');
    expect(law).toBeGreaterThan(0);
    expect(await registerTotal(company)).toBe(law);
  });

  it('shows ISO data to every other demo user', async () => {
    for (const [email, mfa] of [
      ['consultant@demo.test', true],
      ['admin@demo.test', true],
      ['owner@demo.test', false],
      ['approver@demo.test', false],
      ['viewer@demo.test', false],
    ] as const) {
      const cookie = await sessionFor(email, mfa);
      expect((await get(cookie, isoSystems)).status, email).toBe(200);
    }
    const consultant = await sessionFor('consultant@demo.test', true);
    const iso = await registerTotal(consultant, 'ISO');
    expect(iso).toBeGreaterThan(0);
    expect(await registerTotal(consultant)).toBe((await registerTotal(consultant, 'LAW')) + iso);
  });
});
