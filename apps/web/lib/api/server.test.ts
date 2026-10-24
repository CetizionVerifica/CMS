import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  nextHeaders,
  nextNavigation,
  RedirectError,
  request,
  resetRequest,
} from '../test/next-mocks';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => nextHeaders);
vi.mock('next/navigation', () => nextNavigation);

const { getMe, mfaPending, relayCookies, requireMe, serverApi, sessionApi, usingMockApi } =
  await import('./server');
const { MOCK_PASSWORD } = await import('./mock');

async function signIn(email: string, mfa = false) {
  const { setCookies } = await (await serverApi()).login({ email, password: MOCK_PASSWORD });
  await relayCookies(setCookies);
  if (mfa) await relayCookies((await (await sessionApi()).verifyMfa('123456')).setCookies);
}

const redirectOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => (e instanceof RedirectError ? e.url : Promise.reject(e)),
  );

describe('server API access', () => {
  beforeEach(() => {
    resetRequest();
    vi.unstubAllEnvs();
  });

  it('uses the in-process mock until CANOPY_API_URL is set', async () => {
    expect(await usingMockApi()).toBe(true);
    vi.stubEnv('CANOPY_API_URL', 'http://api.internal');
    expect(await usingMockApi()).toBe(false);
  });

  it('refuses the mock in production without the demo flag, whatever the Host header says', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    request.headers.set('host', 'localhost:3000');
    await expect(getMe()).rejects.toThrow('CANOPY_API_URL is not set');
    vi.stubEnv('CANOPY_DEMO_API', '1');
    expect(await usingMockApi()).toBe(true);
  });

  it('returns null without a session and sends the user to login with a return path', async () => {
    expect(await getMe()).toBeNull();
    expect(await redirectOf(requireMe('/c/x/register?fy=2022-23'))).toBe(
      '/login?next=%2Fc%2Fx%2Fregister%3Ffy%3D2022-23',
    );
  });

  it('relays the session cookie and reads the user', async () => {
    request.headers.set('x-request-id', 'req-9');
    await signIn('owner@demo.test');
    expect(request.set[0]).toMatchObject({
      name: 'pp_session',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
    });
    const me = await requireMe('/');
    expect(me.person.displayName).toBe('Owner 01');
    // A client user never owes MFA, though their session has not passed it (the API's Me says so too).
    expect(me.mfa).toEqual({ required: false, enrolled: false, satisfied: false });
  });

  it('reuses the user for the same session for five seconds', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-24T08:00:00Z'), toFake: ['Date'] });
    await signIn('owner@demo.test');
    const first = await getMe();
    vi.setSystemTime(Date.parse('2026-10-24T08:00:04Z'));
    expect(await getMe()).toBe(first);
    vi.setSystemTime(Date.parse('2026-10-24T08:00:05Z'));
    const later = await getMe();
    expect(later).not.toBe(first);
    expect(later).toEqual(first);
    vi.useRealTimers();
  });

  it('asks again once sign-in state changes, even when the cookie stays the same', async () => {
    await signIn('consultant@demo.test');
    const before = await getMe();
    expect(await getMe()).toBe(before);
    // As after MFA against an API that keeps the session cookie: nothing to set, but the user changed.
    await relayCookies([]);
    expect(await getMe()).not.toBe(before);
  });

  it('sends firm users without MFA to the verify step', async () => {
    await signIn('consultant@demo.test');
    expect(await redirectOf(requireMe('/portfolio'))).toBe('/login/verify?next=%2Fportfolio');
    await relayCookies((await (await sessionApi()).verifyMfa('123456')).setCookies);
    expect((await requireMe('/portfolio')).mfa.satisfied).toBe(true);
  });

  it('marks cookies Secure in production against a real API', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CANOPY_API_URL', 'https://api.example');
    await relayCookies(['pp_session=abc; Path=/; HttpOnly', 'broken']);
    expect(request.set).toEqual([
      { name: 'pp_session', value: 'abc', path: '/', httpOnly: true, secure: true },
    ]);
  });

  it('rethrows errors other than a missing session', async () => {
    vi.stubEnv('CANOPY_API_URL', 'http://127.0.0.1:9');
    await expect(getMe()).rejects.toThrow();
  });

  it('exports a sign-in helper used by other tests', async () => {
    await signIn('admin@demo.test', true);
    expect((await getMe())?.mfa.satisfied).toBe(true);
  });

  it('owes MFA only when the role requires it and the session has not passed it', () => {
    const me = (required: boolean, satisfied: boolean) =>
      ({ mfa: { required, enrolled: required, satisfied } }) as Parameters<typeof mfaPending>[0];
    expect(mfaPending(me(true, false))).toBe(true);
    expect(mfaPending(me(true, true))).toBe(false);
    expect(mfaPending(me(false, false))).toBe(false);
    expect(mfaPending(me(false, true))).toBe(false);
  });
});
