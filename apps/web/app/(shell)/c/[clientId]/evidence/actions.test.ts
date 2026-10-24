// @vitest-environment node
// Node, as on the server: M0's mock server (behind lib/api/mock.ts) reads its fixtures from disk.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../../../../../lib/api/client';
import { MOCK_CLIENTS, MOCK_MFA_CODE, MOCK_PASSWORD, mockFetch } from '../../../../../lib/api/mock';
import {
  nextHeaders,
  nextNavigation,
  request,
  resetRequest,
} from '../../../../../lib/test/next-mocks';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => nextHeaders);
vi.mock('next/navigation', () => nextNavigation);

const { loadMoreEvidence } = await import('./actions');

const CLIENT = MOCK_CLIENTS.demoMetals;
const api = (cookie?: string) =>
  createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie });

async function signIn(email: string, mfa = false) {
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (mfa) cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  const [name, value] = cookie.split('=') as [string, string];
  request.cookies.set(name, decodeURIComponent(value));
  return api(cookie);
}

beforeEach(() => resetRequest());

describe('loadMoreEvidence', () => {
  it('refuses arguments that aren’t what the vault sends', async () => {
    await signIn('consultant@demo.test', true);
    await expect(loadMoreEvidence('../x', '', 'abc')).rejects.toThrow();
    await expect(loadMoreEvidence(CLIENT, 'scanStatus=SHINY', 'abc')).rejects.toThrow();
    await expect(loadMoreEvidence(CLIENT, 'limit=1', 'abc')).rejects.toThrow();
    await expect(loadMoreEvidence(CLIENT, '', '')).rejects.toThrow();
  });

  it('loads the next page as the signed-in person', async () => {
    const consultant = await signIn('consultant@demo.test', true);
    const { data } = await consultant.call('evidenceVault', {
      params: { clientId: CLIENT },
      query: { limit: '1' },
    });
    expect(data.nextCursor).not.toBeNull();
    const more = await loadMoreEvidence(CLIENT, '', data.nextCursor!);
    expect(more.total).toBeUndefined();
    expect(more.rows.length).toBeGreaterThan(0);
  });
});
