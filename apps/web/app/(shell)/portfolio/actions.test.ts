// @vitest-environment node
// Node, as on the server: M0's mock server (behind lib/api/mock.ts) answers POST /clients, so the action runs against
// it and the new client is read back from the mock API.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../../../lib/api/client';
import { MOCK_MFA_CODE, MOCK_PASSWORD, mockFetch } from '../../../lib/api/mock';
import { nextHeaders, nextNavigation, request, resetRequest } from '../../../lib/test/next-mocks';

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => nextHeaders);
vi.mock('next/navigation', () => nextNavigation);
vi.mock('next/cache', () => ({ revalidatePath }));

const { addClientAction } = await import('./actions');

const api = (cookie?: string) =>
  createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie });

async function signIn(email: string, mfa = false) {
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (mfa) cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  const [name, value] = cookie.split('=') as [string, string];
  request.cookies.set(name, decodeURIComponent(value));
}

beforeEach(() => {
  resetRequest();
  revalidatePath.mockReset();
});

describe('add a client', () => {
  it('creates the client for an account admin, who then sees it', async () => {
    await signIn('admin@demo.test', true);
    const result = await addClientAction('  Stonebridge Weaving Group ');
    expect(result).toEqual({ ok: true, id: expect.any(String) });
    expect(revalidatePath).toHaveBeenCalledWith('/portfolio');
    const { data } = await api(`pp_session=${request.cookies.get('pp_session')}`).call(
      'getClient',
      { params: { clientId: (result as { id: string }).id } },
    );
    expect(data.name).toBe('Stonebridge Weaving Group');
  });

  it('refuses anyone else, and a name that is not one, in sentences', async () => {
    await signIn('owner@demo.test');
    expect(await addClientAction('Highmoor Group')).toEqual({
      ok: false,
      message: 'Only account admins can add a client.',
    });
    expect(await addClientAction('   ')).toEqual({
      ok: false,
      message: 'Type a name of up to 300 characters.',
    });
    expect(await addClientAction('x'.repeat(301))).toEqual({
      ok: false,
      message: 'Type a name of up to 300 characters.',
    });
  });
});
