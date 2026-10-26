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

const { loadMoreApprovals } = await import('./actions');

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

describe('loadMoreApprovals', () => {
  it('refuses arguments that aren’t what the inbox sends', async () => {
    await signIn('approver@demo.test');
    await expect(loadMoreApprovals('../x', 'mine', 'abc')).rejects.toThrow();
    await expect(loadMoreApprovals(CLIENT, 'everyone' as never, 'abc')).rejects.toThrow();
    await expect(loadMoreApprovals(CLIENT, 'mine', '')).rejects.toThrow();
    await expect(loadMoreApprovals(CLIENT, 'mine', 'abc', 'BOTH' as never)).rejects.toThrow();
  });

  it('keeps the Source filter on the next page', async () => {
    const consultant = await signIn('consultant@demo.test', true);
    const { data } = await consultant.call('listInstances', {
      params: { clientId: CLIENT },
      query: { workflowState: 'SUBMITTED', source: 'LAW', sort: 'dueDate', limit: '1' },
    });
    expect(data.nextCursor).not.toBeNull();
    const more = await loadMoreApprovals(CLIENT, 'client', data.nextCursor!, 'LAW');
    for (const row of more.rows) expect(row.workflowState).toBe('SUBMITTED');
  });

  it('loads the next page as the signed-in person', async () => {
    const consultant = await signIn('consultant@demo.test', true);
    const { data } = await consultant.call('listInstances', {
      params: { clientId: CLIENT },
      query: { workflowState: 'SUBMITTED', sort: 'dueDate', limit: '1' },
    });
    expect(data.nextCursor).not.toBeNull();
    const more = await loadMoreApprovals(CLIENT, 'client', data.nextCursor!);
    expect(more.total).toBeUndefined();
    for (const row of more.rows) expect(row.workflowState).toBe('SUBMITTED');
  });
});
