import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildServer } from '../server.js';
import { ApiError } from './errors.js';
import { authorize, requireClient } from './plugin.js';
import { createTestAuth } from './testing.js';
import { sameToken } from './tokens.js';

const CLIENT = randomUUID();
const OTHER_CLIENT = randomUUID();
const { store, signIn } = createTestAuth();
const app = buildServer({ authStore: store, clock: () => new Date('2026-10-11T20:00:00Z') });

app.get('/whoami', { config: { auth: 'session' } }, async (req) => req.ctx);
app.get('/me-ish', { config: { auth: 'session-pre-mfa' } }, async (req) => ({
  mfa: req.ctx.mfaSatisfied,
}));
app.get('/pre-mfa-read', { config: { auth: 'session-pre-mfa' } }, async (req) => {
  authorize(req, 'client.read', { type: 'client', clientId: req.ctx.clientIds[0] ?? null });
  return { ok: true };
});
app.post('/clients/:clientId/things', { config: { auth: 'session' } }, async (req) => {
  const { clientId } = req.params as { clientId: string };
  authorize(req, 'entity.write', { type: 'unit', clientId });
  return { ok: true, asOf: req.ctx.asOf };
});
app.post('/move', { config: { auth: 'session' } }, async (req) => {
  const body = z.strictObject({ clientId: z.string() }).parse(req.body);
  requireClient(req.ctx, body.clientId);
  return { ok: true };
});
app.get('/open', { config: { auth: 'public' } }, async (req) => ({ hasCtx: hasCtx(req) }));
app.get('/boom', { config: { auth: 'public' } }, async () => {
  throw new Error('secret detail');
});
app.post(
  '/typed',
  {
    config: { auth: 'public' },
    schema: { body: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  },
  async () => ({ ok: true }),
);

function hasCtx(req: { ctx: unknown }): boolean {
  try {
    return req.ctx !== undefined;
  } catch {
    return false;
  }
}

afterAll(() => app.close());

describe('route registration', () => {
  it('refuses a route without config.auth', async () => {
    const bare = buildServer();
    expect(() => bare.get('/x', async () => 'x')).toThrow(/declare config.auth/);
    expect(() => bare.get('/y', { config: { auth: 'nope' as 'public' } }, async () => 'y')).toThrow(
      /declare config.auth/,
    );
    await bare.close();
  });

  it('serves public routes without a session and without req.ctx', async () => {
    expect((await app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ url: '/open' })).json()).toEqual({ hasCtx: false });
  });
});

describe('session routes', () => {
  it('returns 401 UNAUTHENTICATED without or with an unknown session cookie', async () => {
    for (const headers of [{}, { cookie: 'sid=nope' }]) {
      const res = await app.inject({ url: '/whoami', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      expect(res.json().requestId).toEqual(expect.any(String));
    }
  });

  it('sets req.ctx from the session', async () => {
    const actor = signIn({ memberships: [{ role: 'CLIENT_ADMIN', clientId: CLIENT }] });
    const res = await app.inject({ url: '/whoami', headers: actor.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      firmId: actor.firmId,
      personId: actor.personId,
      clientIds: [CLIENT],
      asOf: '2026-10-12',
    });
  });

  it('returns MFA_REQUIRED for firm roles until MFA, except on pre-MFA routes', async () => {
    const actor = signIn({ memberships: [{ role: 'FIRM_ADMIN' }], mfaSatisfied: false });
    const res = await app.inject({ url: '/whoami', headers: actor.headers });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      error: { code: 'MFA_REQUIRED', details: { enrolled: true } },
    });
    const pre = await app.inject({ url: '/me-ish', headers: actor.headers });
    expect(pre.json()).toEqual({ mfa: false });
    // authorize() on a pre-MFA route still demands MFA.
    const read = await app.inject({ url: '/pre-mfa-read', headers: actor.headers });
    expect(read.statusCode).toBe(401);
    expect(read.json()).toMatchObject({
      error: { code: 'MFA_REQUIRED', details: { enrolled: true } },
    });
    const done = signIn({
      memberships: [{ role: 'FIRM_ADMIN' }],
      principal: { firmClientIds: [CLIENT] },
    });
    expect((await app.inject({ url: '/pre-mfa-read', headers: done.headers })).statusCode).toBe(
      200,
    );
  });

  it('returns 403 ACCESS_EXPIRED when every membership has expired', async () => {
    const actor = signIn({
      memberships: [{ role: 'VIEWER', clientId: CLIENT, expiresAt: '2026-10-01T00:00:00Z' }],
    });
    const res = await app.inject({ url: '/whoami', headers: actor.headers });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'ACCESS_EXPIRED' } });
  });

  it('requires the CSRF header on state-changing requests', async () => {
    const actor = signIn({ memberships: [{ role: 'CLIENT_ADMIN', clientId: CLIENT }] });
    const url = `/clients/${CLIENT}/things`;
    const missing = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: actor.headers.cookie! },
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const wrong = await app.inject({
      method: 'POST',
      url,
      headers: { ...actor.headers, 'x-csrf-token': 'wrong' },
    });
    expect(wrong.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url, headers: actor.headers });
    expect(ok.statusCode).toBe(200);
  });

  it('reports a path clientId outside the actor clients as 404, before the handler runs', async () => {
    const actor = signIn({ memberships: [{ role: 'CLIENT_ADMIN', clientId: CLIENT }] });
    const res = await app.inject({
      method: 'POST',
      url: `/clients/${OTHER_CLIENT}/things`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('computes asOf in the path client time zone', async () => {
    const actor = signIn({ memberships: [{ role: 'CLIENT_ADMIN', clientId: CLIENT }] });
    store.timeZones.set(`${actor.firmId}/${CLIENT}`, 'UTC');
    const res = await app.inject({
      method: 'POST',
      url: `/clients/${CLIENT}/things`,
      headers: actor.headers,
    });
    expect(res.json()).toEqual({ ok: true, asOf: '2026-10-11' });
  });

  it('authorize() answers FORBIDDEN with the action when can() says no', async () => {
    const actor = signIn({ memberships: [{ role: 'VIEWER', clientId: CLIENT }] });
    const res = await app.inject({
      method: 'POST',
      url: `/clients/${CLIENT}/things`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: 'FORBIDDEN', details: { action: 'entity.write' } },
    });
  });

  it('requireClient() answers NOT_FOUND for a client outside the context', async () => {
    const actor = signIn({ memberships: [{ role: 'OWNER', clientId: CLIENT }] });
    const out = await app.inject({
      method: 'POST',
      url: '/move',
      headers: actor.headers,
      payload: { clientId: OTHER_CLIENT },
    });
    expect(out.statusCode).toBe(404);
    const inside = await app.inject({
      method: 'POST',
      url: '/move',
      headers: actor.headers,
      payload: { clientId: CLIENT },
    });
    expect(inside.statusCode).toBe(200);
  });
});

describe('error envelope', () => {
  it('renders Zod and schema validation errors as VALIDATION', async () => {
    const actor = signIn({ memberships: [{ role: 'OWNER', clientId: CLIENT }] });
    const zod = await app.inject({
      method: 'POST',
      url: '/move',
      headers: actor.headers,
      payload: { clientId: 1 },
    });
    expect(zod.statusCode).toBe(400);
    expect(zod.json()).toMatchObject({
      error: { code: 'VALIDATION', details: { issues: [{ path: 'clientId' }] } },
    });
    const schema = await app.inject({ method: 'POST', url: '/typed', payload: {} });
    expect(schema.statusCode).toBe(400);
    expect(schema.json()).toMatchObject({ error: { code: 'VALIDATION' } });
  });

  it('maps unknown routes to NOT_FOUND and hides unexpected errors as INTERNAL', async () => {
    const missing = await app.inject({ url: '/nowhere' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const boom = await app.inject({ url: '/boom' });
    expect(boom.statusCode).toBe(500);
    expect(boom.json().error).toEqual({ code: 'INTERNAL', message: 'Something went wrong.' });
  });

  it('maps framework 4xx errors to contract codes', async () => {
    const big = Fastify({ bodyLimit: 10 });
    const { registerAuth } = await import('./plugin.js');
    registerAuth(big, { store });
    big.post('/b', { config: { auth: 'public' } }, async () => ({ ok: true }));
    big.get('/limited', { config: { auth: 'public' } }, async () => {
      throw Object.assign(new Error('slow down'), { statusCode: 429 });
    });
    big.get('/gone', { config: { auth: 'public' } }, async () => {
      throw Object.assign(new Error('gone'), { statusCode: 404 });
    });
    big.get('/odd', { config: { auth: 'public' } }, async () => {
      throw Object.assign(new Error('odd'), { statusCode: 418 });
    });
    const tooLarge = await big.inject({
      method: 'POST',
      url: '/b',
      payload: { a: 'xxxxxxxxxxxx' },
    });
    expect(tooLarge.json()).toMatchObject({ error: { code: 'FILE_TOO_LARGE' } });
    const unsupported = await big.inject({
      method: 'POST',
      url: '/b',
      headers: { 'content-type': 'application/x-nope' },
      payload: 'x',
    });
    expect(unsupported.json()).toMatchObject({ error: { code: 'UNSUPPORTED_FILE' } });
    expect((await big.inject({ url: '/limited' })).json()).toMatchObject({
      error: { code: 'RATE_LIMITED' },
    });
    expect((await big.inject({ url: '/gone' })).json()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect((await big.inject({ url: '/odd' })).json()).toMatchObject({
      error: { code: 'VALIDATION' },
    });
    await big.close();
  });

  it('keeps ApiError details and default messages', () => {
    const error = new ApiError('MFA_REQUIRED', { enrolled: false });
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe('Two-step verification is required.');
    expect(new ApiError('NOT_FOUND', undefined, 'No such unit.').message).toBe('No such unit.');
  });
});

describe('rate limit', () => {
  it('limits every route per client IP and answers RATE_LIMITED with retryAfterSeconds', async () => {
    const limited = buildServer({ rateLimit: { max: 2, timeWindow: 60_000 } });
    expect((await limited.inject({ url: '/health' })).statusCode).toBe(200);
    expect((await limited.inject({ url: '/nowhere' })).statusCode).toBe(404);
    const third = await limited.inject({ url: '/health' });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: 60 } },
    });
    const other = await limited.inject({ url: '/health', remoteAddress: '10.0.0.2' });
    expect(other.statusCode).toBe(200);
    await limited.close();
  });
});

describe('per-route rate limit', () => {
  it('trips config.routeLimit on its own counter, behind the API-wide limit', async () => {
    const limited = buildServer();
    limited.post(
      '/login-ish',
      { config: { auth: 'public', routeLimit: { max: 2, timeWindow: 60_000 } } },
      async () => ({ ok: true }),
    );
    for (let i = 0; i < 2; i++) {
      expect((await limited.inject({ method: 'POST', url: '/login-ish' })).statusCode).toBe(200);
    }
    const third = await limited.inject({ method: 'POST', url: '/login-ish' });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: 60 } },
    });
    // Other routes keep their own (API-wide) budget.
    expect((await limited.inject({ url: '/health' })).statusCode).toBe(200);
    await limited.close();
  });

  it('shares one budget between a GET route and its automatic HEAD route', async () => {
    const limited = buildServer();
    limited.get(
      '/invite-ish/:token',
      { config: { auth: 'public', routeLimit: { max: 2, timeWindow: 60_000 } } },
      async () => ({ ok: true }),
    );
    expect((await limited.inject({ url: '/invite-ish/a' })).statusCode).toBe(200);
    expect((await limited.inject({ method: 'HEAD', url: '/invite-ish/b' })).statusCode).toBe(200);
    expect((await limited.inject({ url: '/invite-ish/c' })).statusCode).toBe(429);
    await limited.close();
  });

  it('refuses the plugin config.rateLimit, which would never fire', async () => {
    const bare = buildServer();
    expect(() =>
      bare.get('/x', { config: { auth: 'public', rateLimit: { max: 1 } } }, async () => 'x'),
    ).toThrow(/use config.routeLimit/);
    await bare.close();
  });
});

describe('tokens', () => {
  it('compares tokens in constant time, rejecting different lengths', () => {
    expect(sameToken('abc', 'abc')).toBe(true);
    expect(sameToken('abc', 'abd')).toBe(false);
    expect(sameToken('abc', 'abcd')).toBe(false);
  });
});
