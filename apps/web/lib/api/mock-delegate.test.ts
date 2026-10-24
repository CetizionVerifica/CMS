// @vitest-environment node
// Node, as on the server: M0's mock server reads its fixtures from disk.
import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from './client';
import { MOCK_CLIENTS, MOCK_MFA_CODE, MOCK_PASSWORD, mockFetch } from './mock';
import { CLIENT_MAP, delegateToM0 } from './mock-delegate';

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
    expect((await fresh.delegateToM0('owner@demo.test', 'GET', url, undefined)).status).toBe(200);
    expect((globalThis as { __ppMockServer?: unknown }).__ppMockServer).toBe(first);
  });
});
