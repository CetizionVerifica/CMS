import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient, isApiError, queryString } from './client';
import {
  MOCK_APPROVALS_WAITING,
  MOCK_CLIENTS,
  MOCK_FIRM_INVITE_TOKEN,
  MOCK_INVITE_TOKEN,
  MOCK_MFA_CODE,
  MOCK_PASSWORD,
  MOCK_TOTP_SECRET,
  MOCK_UNENROLLED_EMAIL,
  mockFetch,
} from './mock';

const api = (cookie?: string, csrfToken?: string) =>
  createApiClient({ baseUrl: 'http://api.test/', fetch: mockFetch, cookie, csrfToken });

async function sessionFor(email: string, mfa = false): Promise<string> {
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (mfa) cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  return cookie;
}

describe('API client against the mock', () => {
  it('returns Me from login too', async () => {
    const { data } = await api().login({ email: 'owner@demo.test', password: MOCK_PASSWORD });
    expect(data.clients.map((c) => c.name)).toEqual(['Demo Metals']);
  });

  it('signs in and reads /me', async () => {
    const cookie = await sessionFor('owner@demo.test');
    const me = (await api(cookie).me()).data;
    expect(me.person.displayName).toBe('Owner 01');
    expect(me.clients.map((c) => c.id)).toEqual([MOCK_CLIENTS.demoMetals]);
    // As the API: an owner never owes MFA, and `satisfied` says this session has not passed it.
    expect(me.mfa).toEqual({ required: false, enrolled: false, satisfied: false });
    expect(me.clients[0]).toMatchObject({
      unitCount: 3,
      fyStartMonth: 4,
      timeZone: 'Asia/Kolkata',
    });
    expect(me.clients[0]?.period.current).toEqual({ fy: '2024-25', quarter: 3 });
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
    await expect(api(cookie).verifyMfa('000000')).rejects.toMatchObject({ code: 'VALIDATION' });
    const verified = await sessionFor('consultant@demo.test', true);
    const rows = (await api(verified).portfolio()).data.items;
    expect(rows.map((r) => r.clientName)).toEqual(['Demo Metals', 'Northwind Textiles']);
    expect(rows[0]!.result.counts.OVERDUE).toBe(5);
  });

  it('enrols a firm user who has no authenticator, as the API does', async () => {
    const cookie = await sessionFor(MOCK_UNENROLLED_EMAIL);
    expect((await api(cookie).me()).data.mfa).toEqual({
      required: true,
      enrolled: false,
      satisfied: false,
    });
    await expect(api(cookie).portfolio()).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
      details: { enrolled: false },
    });
    const { otpauthUrl } = (await api(cookie).enrollMfa()).data;
    expect(otpauthUrl).toMatch(
      /^otpauth:\/\/totp\/PlanetPulse%20Compliance%3Anewconsultant%40demo\.test\?/,
    );
    expect(new URL(otpauthUrl).searchParams.get('secret')).toBe(MOCK_TOTP_SECRET);
    const verified = await sessionFor(MOCK_UNENROLLED_EMAIL, true);
    expect((await api(verified).me()).data.mfa).toEqual({
      required: true,
      enrolled: true,
      satisfied: true,
    });
    // Once set up, enrolment can't start again.
    await expect(api(verified).enrollMfa()).rejects.toMatchObject({ code: 'DUPLICATE' });
    await expect(api(await sessionFor('consultant@demo.test')).enrollMfa()).rejects.toMatchObject({
      code: 'DUPLICATE',
    });
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

  it('counts the approvals waiting for an approver, and forbids it for an owner', async () => {
    const approver = await sessionFor('approver@demo.test');
    expect(await api(approver).approvalsWaiting()).toBe(MOCK_APPROVALS_WAITING);
    const { data } = await api(approver).call('myApprovals', { query: { limit: '5' } });
    expect(data).toEqual({ items: [], nextCursor: null });
    expect(await api(approver).approvalsWaiting()).toBe(MOCK_APPROVALS_WAITING);
    const owner = await sessionFor('owner@demo.test');
    await expect(api(owner).approvalsWaiting()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('signs a viewer in to one client, with no MFA step and no approvals', async () => {
    const viewer = await sessionFor('viewer@demo.test');
    const me = (await api(viewer).me()).data;
    expect(me.person.displayName).toBe('Viewer 01');
    expect(me.clients.map((c) => c.id)).toEqual([MOCK_CLIENTS.demoMetals]);
    expect(me.mfa.required).toBe(false);
    await expect(api(viewer).approvalsWaiting()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api(viewer).portfolio()).rejects.toMatchObject({ code: 'FORBIDDEN' });
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

  it('has a firm-role invitee set up MFA before choosing a password (F14)', async () => {
    expect((await api().invite(MOCK_INVITE_TOKEN)).data.mfaRequired).toBe(false);
    await expect(api().enrollInviteMfa(MOCK_INVITE_TOKEN)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await api().invite(MOCK_FIRM_INVITE_TOKEN)).data).toMatchObject({
      role: 'CONSULTANT',
      mfaRequired: true,
    });
    const setup = (await api().enrollInviteMfa(MOCK_FIRM_INVITE_TOKEN)).data;
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    await expect(
      api().acceptInvite(MOCK_FIRM_INVITE_TOKEN, { password: 'a-long-enough-password' }),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    const ok = await api().acceptInvite(MOCK_FIRM_INVITE_TOKEN, {
      password: 'a-long-enough-password',
      mfaCode: '123456',
    });
    expect(ok.data.mfa).toMatchObject({ required: true, satisfied: true });
  });
});

describe('API client transport', () => {
  it('sends cookie, request id, forwarded-for and CSRF headers, and the /api/v1 prefix', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchSpy as unknown as typeof fetch,
      cookie: 'pp_session=x',
      csrfToken: 'csrf-token-0123456789',
      requestId: 'req-1',
      forwardedFor: '203.0.113.7, 10.0.0.2',
    });
    await client.logout();
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/auth/logout');
    expect(init.headers).toMatchObject({
      cookie: 'pp_session=x',
      'x-request-id': 'req-1',
      'x-forwarded-for': '203.0.113.7, 10.0.0.2',
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

  it('calls any endpoint by name, with its query serialised and its response parsed', async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ items: [], nextCursor: null, total: 7 }), { status: 200 }),
    );
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const { data } = await client.call('myTasks', { query: { limit: '20', count: 'true' } });
    expect(data).toEqual({ items: [], nextCursor: null, total: 7 });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://api.test/api/v1/me/tasks?limit=20&count=true');
    await client
      .call('approveInstance', { params: { id: 'i/1' }, body: { version: 3 } })
      .catch(() => undefined);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('http://api.test/api/v1/instances/i%2F1/approve');
    expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe('POST');
  });

  it('writes a query string the API reads: arrays comma-separated, empty values left out', () => {
    expect(queryString(undefined)).toBe('');
    expect(queryString({ a: undefined, b: null })).toBe('');
    expect(queryString({ status: ['OVERDUE', 'DUE_SOON'], limit: 5, q: 'a b&c' })).toBe(
      '?status=OVERDUE%2CDUE_SOON&limit=5&q=a+b%26c',
    );
    expect(() => queryString({ filter: { a: 1 } })).toThrow('Query parameter filter');
    expect(() => queryString({ ids: ['a', { b: 1 }] })).toThrow('Query parameter ids');
  });

  it('matches any code when none is given', () => {
    expect(isApiError(new ApiError(400, 'VALIDATION', 'x'))).toBe(true);
    expect(isApiError(new Error('x'))).toBe(false);
  });
});
