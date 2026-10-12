import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient, isApiError } from './client';
import { MOCK_CLIENTS, MOCK_INVITE_TOKEN, MOCK_MFA_CODE, MOCK_PASSWORD, mockFetch } from './mock';

const api = (cookie?: string, csrfToken?: string) =>
  createApiClient({ baseUrl: 'http://api.test/', fetch: mockFetch, cookie, csrfToken });

async function sessionFor(email: string, mfa = false): Promise<string> {
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (mfa) cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  return cookie;
}

describe('API client against the mock', () => {
  it('returns the contract Me from login, and the shell context from /me', async () => {
    const { data } = await api().login({ email: 'owner@demo.test', password: MOCK_PASSWORD });
    expect(data.clients).toEqual([{ id: MOCK_CLIENTS.demoMetals, name: 'Demo Metals' }]);
  });

  it('signs in and reads /me', async () => {
    const cookie = await sessionFor('owner@demo.test');
    const me = (await api(cookie).me()).data;
    expect(me.person.displayName).toBe('Owner 01');
    expect(me.clients.map((c) => c.id)).toEqual([MOCK_CLIENTS.demoMetals]);
    expect(me.mfa).toEqual({ required: false, enrolled: false, satisfied: true });
    expect(me.clients[0]).toMatchObject({
      unitCount: 3,
      fyStartMonth: 4,
      timeZone: 'Asia/Kolkata',
    });
    expect(me.clients[0]?.period.current).toEqual({ fy: '2022-23', quarter: 4 });
  });

  it('rejects a wrong password with the contract error code', async () => {
    const err = await api()
      .login({ email: 'owner@demo.test', password: 'nope' })
      .catch((e: unknown) => e);
    expect(isApiError(err, 'UNAUTHENTICATED')).toBe(true);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).requestId).toBe('mock');
  });

  it('needs MFA before firm users read data', async () => {
    const cookie = await sessionFor('consultant@demo.test');
    expect((await api(cookie).me()).data.mfa.satisfied).toBe(false);
    await expect(api(cookie).portfolio()).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    await expect(api(cookie).verifyMfa('000000')).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    const verified = await sessionFor('consultant@demo.test', true);
    const rows = (await api(verified).portfolio()).data.items;
    expect(rows.map((r) => r.clientName)).toEqual(['Demo Metals', 'Northwind Textiles']);
    expect(rows[0]!.result.counts.OVERDUE).toBe(5);
  });

  it('lets a firm admin see every client, and forbids the portfolio for client users', async () => {
    const admin = await sessionFor('admin@demo.test', true);
    expect((await api(admin).me()).data.clients).toHaveLength(3);
    const owner = await sessionFor('owner@demo.test');
    await expect(api(owner).portfolio()).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('answers 401 without a session and 404 for unknown routes', async () => {
    await expect(api().me()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(api('pp_session=bogus.1').me()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const cookie = await sessionFor('owner@demo.test');
    const client = createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie });
    await expect(client.invite('no-such-invite-token')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('logs out by clearing the cookie', async () => {
    const cookie = await sessionFor('owner@demo.test');
    const { setCookies } = await api(cookie).logout();
    expect(setCookies[0]).toContain('Max-Age=0');
  });

  it('handles magic links and invites', async () => {
    await expect(api().requestMagicLink('anyone@demo.test')).resolves.toMatchObject({
      data: null,
    });
    await expect(api().verifyMagicLink('expired-link-token-01')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const invite = (await api().invite(MOCK_INVITE_TOKEN)).data;
    expect(invite).toMatchObject({
      email: 'owner02@demo.test',
      displayName: 'Owner 02',
      clientName: 'Demo Metals',
    });
    await expect(
      api().acceptInvite(MOCK_INVITE_TOKEN, { password: 'short' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const ok = await api().acceptInvite(MOCK_INVITE_TOKEN, { password: 'a-long-enough-password' });
    expect(ok.setCookies[0]).toContain('pp_session=');
    expect(ok.data.person.displayName).toBe('Owner 01');
  });
});

describe('API client transport', () => {
  it('sends cookie, request id and CSRF headers, and the /api/v1 prefix', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchSpy as unknown as typeof fetch,
      cookie: 'pp_session=x',
      csrfToken: 'csrf-token-0123456789',
      requestId: 'req-1',
    });
    await client.logout();
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/auth/logout');
    expect(init.headers).toMatchObject({
      cookie: 'pp_session=x',
      'x-request-id': 'req-1',
      'x-csrf-token': 'csrf-token-0123456789',
    });
    await client.requestMagicLink('a@b.test');
    const [, postInit] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit];
    expect(postInit.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(postInit.body).toBe('{"email":"a@b.test"}');
    await client.me().catch(() => undefined);
    const [, getInit] = fetchSpy.mock.calls[2] as unknown as [string, RequestInit];
    expect(getInit.headers).not.toHaveProperty('x-csrf-token');
  });

  it('turns a non-contract error body into UNKNOWN', async () => {
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: (async () => new Response('gateway down', { status: 502 })) as typeof fetch,
    });
    await expect(client.me()).rejects.toMatchObject({ code: 'UNKNOWN', status: 502 });
  });

  it('rejects a response that does not match its schema, without echoing the body', async () => {
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: (async () =>
        new Response(JSON.stringify({ person: { displayName: 'Secret Name' } }), {
          status: 200,
        })) as typeof fetch,
    });
    const err = (await client.me().catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toContain('Unexpected response from GET /me');
    expect(err.message).not.toContain('Secret Name');
  });

  it('fills path parameters from the endpoint template, encoded', async () => {
    const fetchSpy = vi.fn(async (_url: string) => new Response('{}', { status: 404 }));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await client.invite('a/b?c').catch(() => undefined);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://api.test/api/v1/invites/a%2Fb%3Fc');
  });

  it('matches any code when none is given', () => {
    expect(isApiError(new ApiError(400, 'VALIDATION', 'x'))).toBe(true);
    expect(isApiError(new Error('x'))).toBe(false);
  });
});
