// @vitest-environment node
// Node, as on the server: M0's mock server (behind lib/api/mock.ts) answers the account routes, so each action runs
// against it and the result is read back from the mock API.
import { SupportGrant } from '@canopy/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../../../lib/api/client';
import { MOCK_MFA_CODE, MOCK_PASSWORD, mockFetch } from '../../../lib/api/mock';
import { nextHeaders, nextNavigation, request, resetRequest } from '../../../lib/test/next-mocks';

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => nextHeaders);
vi.mock('next/navigation', () => nextNavigation);
vi.mock('next/cache', () => ({ revalidatePath }));

const actions = await import('./actions');

const api = (cookie?: string) =>
  createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie });

async function signIn(email: string, mfa = false) {
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (mfa) cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  const [name, value] = cookie.split('=') as [string, string];
  request.cookies.set(name, decodeURIComponent(value));
}

const grants = async () =>
  (
    await createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch,
      cookie: `pp_session=${request.cookies.get('pp_session')}`,
    }).call('listSupportGrants')
  ).data.items.map((g) => SupportGrant.parse(g));

beforeEach(() => {
  resetRequest();
  revalidatePath.mockReset();
});

describe('account actions', () => {
  it('lets support in for the chosen days, ends it, and says when it already ended', async () => {
    await signIn('admin@demo.test', true);
    expect(await actions.grantSupportAction({ level: 'READ_ONLY', days: 3 })).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith('/account');
    const live = (await grants()).find((g) => g.status === 'ACTIVE')!;
    expect(live.level).toBe('READ_ONLY');
    expect(Date.parse(live.endsAt) - Date.parse(live.startsAt)).toBe(3 * 86_400_000);

    expect(await actions.revokeSupportAction(live.id)).toEqual({ ok: true });
    expect((await grants()).find((g) => g.id === live.id)?.status).toBe('REVOKED');
    expect(await actions.revokeSupportAction(live.id)).toEqual({
      ok: false,
      message: 'That access has already ended. The page now shows the latest.',
    });
  });

  it('answers an id that is not one without calling the API', async () => {
    expect(await actions.revokeSupportAction('not-an-id')).toEqual({
      ok: false,
      message: 'That access has already ended. The page now shows the latest.',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses days outside 1 to 30 before calling the API', async () => {
    await signIn('admin@demo.test', true);
    expect(await actions.grantSupportAction({ level: 'ADMIN', days: 31 })).toEqual({
      ok: false,
      message: 'Choose a level and between 1 and 30 days.',
    });
  });
});
