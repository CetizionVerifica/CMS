// @vitest-environment node
// Node, as on the server: M0's mock server reads its fixtures from disk.
import { describe, expect, it } from 'vitest';

import { createApiClient } from './client';
import { MOCK_CLIENTS, MOCK_MFA_CODE, MOCK_PASSWORD, mockFetch } from './mock';
import { CLIENT_MAP } from './mock-delegate';

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
});
