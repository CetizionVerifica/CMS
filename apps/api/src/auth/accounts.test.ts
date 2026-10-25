import { randomUUID } from 'node:crypto';
import {
  ApiErrorResponse,
  ERROR_DETAILS,
  LocalDate,
  Me,
  type AccountStatus,
} from '@canopy/contracts';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { hashPassword } from './passwords.js';
import { SecretBox } from './secretbox.js';
import { AuthService } from './service.js';
import {
  accountView,
  clientSummary,
  InMemoryAuthStore,
  membership,
  person as personFixture,
  type MembershipInput,
} from './testing.js';
import { hashToken, newToken } from './tokens.js';
import { base32Decode, hotp, totpStep } from './totp.js';

/**
 * Accounts at sign-in and on every request (ADR M15-0001 decisions 4 and 11, endpoints.md §8): a SUSPENDED account
 * signs nobody in, PENDING_DELETION lets account admins reach only `/me`, logout and the export, plan limits on
 * invites, and PlanetPulse support sessions.
 */

const KEY = Buffer.alloc(32, 1).toString('base64');
const PASSWORD = 'a long enough password';
let now = new Date('2026-10-12T00:00:00Z');
const clock = () => now;
// Grants are judged against the database clock (real time), as `canopy_find_session` does.
const FAR = '2099-01-01T00:00:00.000Z';

let store: InMemoryAuthStore;
let app: FastifyInstance;
const apps: FastifyInstance[] = [];

beforeEach(() => {
  now = new Date('2026-10-12T00:00:00Z');
  store = new InMemoryAuthStore();
  app = buildServer({
    accountStore: store,
    authSecretKey: KEY,
    clock,
    rateLimit: { max: 10_000, timeWindow: 60_000 },
  });
  app.get('/api/v1/probe', { config: { auth: 'session' } }, async (req) => ({
    personId: req.ctx.personId,
  }));
  app.post(
    '/api/v1/probe-export',
    { config: { auth: 'session', whilePendingDeletion: true } },
    async () => ({ ok: true }),
  );
  apps.push(app);
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

async function seed(
  input: {
    firmId?: string;
    memberships?: MembershipInput[];
    status?: AccountStatus;
    support?: boolean;
    mfaEnrolled?: boolean;
  } = {},
) {
  const firmId = input.firmId ?? randomUUID();
  const personId = randomUUID();
  const email = input.support ? 'support@planetpulse.life' : `${personId.slice(0, 8)}@example.com`;
  store.firms.set(firmId, 'Kestrel Metals Group');
  if (input.status) store.accounts.set(firmId, accountView(firmId, { status: input.status }));
  store.people.set(`${firmId}/${personId}`, {
    displayName: input.support ? 'PlanetPulse support' : 'Asha Rao',
    email,
    status: 'ACTIVE',
    passwordHash: input.support ? null : await hashPassword(PASSWORD),
    failedAttempts: 0,
    lockedUntil: null,
    support: input.support ?? false,
  });
  const memberships = (input.memberships ?? [{ role: 'OWNER' as const }]).map((m) =>
    membership({ firmId, personId, ...m }),
  );
  for (const m of memberships) {
    if (m.clientId) store.clients.set(`${firmId}/${m.clientId}`, clientSummary({ id: m.clientId }));
  }
  store.principals.set(`${firmId}/${personId}`, {
    person: personFixture({ id: personId, firmId, email }),
    memberships,
    mfaEnrolled: input.mfaEnrolled ?? false,
    mfaRequiredForFirmRoles: true,
    firmClientIds: memberships.flatMap((m) => (m.clientId ? [m.clientId] : [])),
  });
  return { firmId, personId, email };
}

let address = 0;
function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  address += 1;
  return app.inject({
    remoteAddress: `10.2.${Math.floor(address / 250)}.${address % 250}`,
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    headers,
  });
}
const login = (email: string, password = PASSWORD) =>
  post('/api/v1/auth/login', { email, password });

function headersOf(res: LightMyRequestResponse) {
  const cookie = res.cookies.find((c) => c.name === 'sid');
  if (!cookie) throw new Error('no session cookie');
  return { cookie: `sid=${cookie.value}`, 'x-csrf-token': Me.parse(res.json()).csrfToken };
}

function error(res: LightMyRequestResponse) {
  const body = ApiErrorResponse.parse(res.json());
  return { status: res.statusCode, code: body.error.code, details: body.error.details };
}

const service = () => new AuthService({ store, secrets: new SecretBox(KEY), clock });

const suspend = (firmId: string, status: AccountStatus) =>
  store.accounts.set(firmId, accountView(firmId, { status }));

describe('a SUSPENDED account', () => {
  it('signs nobody in, but only says so after a correct password', async () => {
    const p = await seed({ status: 'SUSPENDED' });
    expect(error(await login(p.email))).toEqual({
      status: 403,
      code: 'ACCOUNT_SUSPENDED',
      details: { status: 'SUSPENDED' },
    });
    expect(ERROR_DETAILS.ACCOUNT_SUSPENDED.safeParse({ status: 'SUSPENDED' }).success).toBe(true);
    expect(error(await login(p.email, 'the wrong password!')).code).toBe('UNAUTHENTICATED');
  });

  it('ends what open sessions can do, /me included', async () => {
    const p = await seed();
    const headers = headersOf(await login(p.email));
    suspend(p.firmId, 'SUSPENDED');
    for (const url of ['/api/v1/probe', '/api/v1/me']) {
      expect(error(await app.inject({ url, headers })).code, url).toBe('ACCOUNT_SUSPENDED');
    }
    suspend(p.firmId, 'ACTIVE');
    expect((await app.inject({ url: '/api/v1/probe', headers })).statusCode).toBe(200);
  });

  it('sends no magic link, and keeps an unused one unused', async () => {
    const p = await seed();
    const link = await service().issueLoginToken({
      firmId: p.firmId,
      personId: p.personId,
      kind: 'MAGIC_LINK',
    });
    suspend(p.firmId, 'SUSPENDED');
    expect((await post('/api/v1/auth/magic-link', { email: p.email })).statusCode).toBe(202);
    expect(store.outbox.filter((e) => e.type === 'auth.magic_link_requested')).toEqual([]);
    expect(error(await post('/api/v1/auth/magic-link/verify', { token: link.token })).code).toBe(
      'ACCOUNT_SUSPENDED',
    );
    suspend(p.firmId, 'ACTIVE');
    expect((await post('/api/v1/auth/magic-link/verify', { token: link.token })).statusCode).toBe(
      200,
    );
  });
});

describe('an account PENDING_DELETION', () => {
  it('lets an account admin reach /me, logout and the export, and nothing else', async () => {
    const p = await seed({ memberships: [{ role: 'FIRM_ADMIN' }], status: 'PENDING_DELETION' });
    const res = await login(p.email);
    expect(res.statusCode).toBe(200);
    expect(Me.parse(res.json()).account).toEqual({
      kind: 'CONSULTANCY',
      status: 'PENDING_DELETION',
      trialEndsOn: null,
      features: [],
    });
    const headers = headersOf(res);
    for (const [hash, s] of store.sessions) store.sessions.set(hash, { ...s, mfaSatisfied: true });
    expect((await app.inject({ url: '/api/v1/me', headers })).statusCode).toBe(200);
    expect((await post('/api/v1/probe-export', {}, headers)).statusCode).toBe(200);
    expect(error(await app.inject({ url: '/api/v1/probe', headers })).code).toBe(
      'ACCOUNT_SUSPENDED',
    );
    expect((await post('/api/v1/auth/logout', {}, headers)).statusCode).toBe(204);
  });

  it('sends magic links to its account admins only', async () => {
    const fa = await seed({ memberships: [{ role: 'FIRM_ADMIN' }], status: 'PENDING_DELETION' });
    const ca = await seed({ firmId: fa.firmId, memberships: [{ role: 'CLIENT_ADMIN' }] });
    for (const p of [fa, ca]) {
      expect((await post('/api/v1/auth/magic-link', { email: p.email })).statusCode).toBe(202);
    }
    expect(
      store.outbox
        .filter((e) => e.type === 'auth.magic_link_requested')
        .map((e) => e.data.personId),
    ).toEqual([fa.personId]);
  });

  it('signs in nobody else', async () => {
    const p = await seed({ memberships: [{ role: 'CLIENT_ADMIN' }], status: 'PENDING_DELETION' });
    expect(error(await login(p.email))).toMatchObject({
      code: 'ACCOUNT_SUSPENDED',
      details: { status: 'PENDING_DELETION' },
    });
  });
});

describe('invites and accounts', () => {
  async function admin(users: { max: number | null; used: number }) {
    const client = randomUUID();
    const p = await seed({
      memberships: [{ role: 'CLIENT_ADMIN', clientId: client }],
    });
    store.accounts.set(
      p.firmId,
      accountView(p.firmId, {
        kind: 'ENTERPRISE',
        status: 'TRIAL',
        trialEndsOn: LocalDate.parse('2026-11-11'),
        entitlements: {
          planCode: 'STARTER',
          limits: { companies: 1, units: 3, users: users.max, storageBytes: null },
          features: [],
        },
        usage: { companies: 1, units: 1, users: users.used, storageBytes: 0 },
      }),
    );
    const headers = headersOf(await login(p.email));
    const send = (payload: Record<string, unknown>) =>
      post(
        '/api/v1/invites',
        {
          role: 'OWNER',
          clientId: client,
          consultantClientIds: null,
          unitIds: null,
          expiresAt: null,
          ...payload,
        },
        headers,
      );
    return { ...p, client, send };
  }

  it('refuses a new person past the plan’s user limit', async () => {
    const { send } = await admin({ max: 3, used: 3 });
    const res = await send({ displayName: 'Dev Iyer', email: 'dev.iyer@kestrel-metals.example' });
    expect(error(res)).toEqual({
      status: 403,
      code: 'PLAN_LIMIT_REACHED',
      details: { limit: 'users', max: 3, used: 3 },
    });
  });

  it('counts a re-invite whose earlier invite expired, but not one still open', async () => {
    const { send, firmId } = await admin({ max: 3, used: 2 });
    const first = await send({ displayName: 'Dev Iyer', email: 'dev.iyer@kestrel-metals.example' });
    expect(first.statusCode).toBe(201);
    expect(store.accounts.get(firmId)!.usage.users).toBe(3);
    const { personId, email } = store.invites.get(first.json().id as string)!;
    // The open invite already holds Dev's seat, so re-inviting at the limit takes no other.
    const again = await send({ personId, email });
    expect(again.statusCode).toBe(201);
    // Once it expires the seat is free, and here someone else has taken it.
    const open = store.invites.get(again.json().id as string)!;
    store.invites.set(open.id, { ...open, linkExpiresAt: '2026-01-01T00:00:00.000Z' });
    expect(error(await send({ personId, email }))).toEqual({
      status: 403,
      code: 'PLAN_LIMIT_REACHED',
      details: { limit: 'users', max: 3, used: 3 },
    });
  });

  it('invites under the limit, and shows the trial on /me', async () => {
    const { send, email } = await admin({ max: 3, used: 2 });
    const res = await send({ displayName: 'Dev Iyer', email: 'dev.iyer@kestrel-metals.example' });
    expect(res.statusCode).toBe(201);
    expect(Me.parse((await login(email)).json()).account).toEqual({
      kind: 'ENTERPRISE',
      status: 'TRIAL',
      trialEndsOn: '2026-11-11',
      features: [],
    });
  });

  it('lists the account’s add-ons on /me, as they are at each request', async () => {
    const { email, firmId } = await admin({ max: null, used: 0 });
    const account = store.accounts.get(firmId)!;
    const withFeatures = (features: string[]) =>
      store.accounts.set(firmId, {
        ...account,
        entitlements: { ...account.entitlements, features },
      });
    withFeatures(['isoManagement']);
    const res = await login(email);
    expect(Me.parse(res.json()).account?.features).toEqual(['isoManagement']);
    withFeatures([]);
    const me = await app.inject({ url: '/api/v1/me', headers: headersOf(res) });
    expect(Me.parse(me.json()).account?.features).toEqual([]);
  });

  it('never invites the PlanetPulse support person', async () => {
    const { send, firmId, client } = await admin({ max: null, used: 0 });
    const support = await seed({
      firmId,
      support: true,
      memberships: [{ role: 'VIEWER', clientId: client }],
    });
    const res = await send({ personId: support.personId, email: 'someone@kestrel-metals.example' });
    expect(error(res).code).toBe('NOT_FOUND');
  });

  it('cannot be accepted while the account is suspended', async () => {
    const { send, firmId } = await admin({ max: null, used: 0 });
    const created = await send({
      displayName: 'Dev Iyer',
      email: 'dev.iyer@kestrel-metals.example',
    });
    const inviteId = created.json().id as string;
    const invite = store.invites.get(inviteId)!;
    const { token } = await service().issueLoginToken({
      firmId,
      personId: invite.personId,
      kind: 'INVITE',
      inviteId,
    });
    suspend(firmId, 'SUSPENDED');
    const res = await post(`/api/v1/invites/${token}/accept`, { password: PASSWORD });
    expect(error(res).code).toBe('ACCOUNT_SUSPENDED');
    expect(store.invites.get(inviteId)!.status).toBe('PENDING');
  });

  async function provisioning(owner: boolean, copied = true) {
    const { send, firmId } = await admin({ max: null, used: 0 });
    if (!copied) store.libraryPending.add(firmId);
    const inviteId = (
      await send({ displayName: 'Asha Rao', email: 'asha.rao@kestrel-metals.example' })
    ).json().id as string;
    const invite = store.invites.get(inviteId)!;
    if (owner) {
      // The owner's own FIRM_ADMIN invite, as platform_provision_account writes it.
      store.invites.set(inviteId, {
        ...invite,
        role: 'FIRM_ADMIN',
        clientId: null,
        invitedById: invite.personId,
      });
    }
    const { token } = await service().issueLoginToken({
      firmId,
      personId: invite.personId,
      kind: 'INVITE',
      inviteId,
    });
    store.accounts.set(firmId, { ...store.accounts.get(firmId)!, status: 'PROVISIONING' });
    // The owner is a FIRM_ADMIN, so they set up MFA while accepting (docs/security/review.md F14).
    const body: Record<string, string> = { password: PASSWORD };
    if (owner) {
      const enroll = await post(`/api/v1/invites/${token}/mfa/enroll`, {});
      const secret = new URL(enroll.json().otpauthUrl as string).searchParams.get('secret')!;
      body.mfaCode = hotp(base32Decode(secret), totpStep(now));
    }
    const res = await post(`/api/v1/invites/${token}/accept`, body);
    return { res, firmId, inviteId, token, body };
  }

  it('lets the owner accept while PROVISIONING, which opens the account', async () => {
    const { res, firmId, inviteId } = await provisioning(true);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(store.invites.get(inviteId)!.status).toBe('ACCEPTED');
    expect(store.accounts.get(firmId)!.status).toBe('TRIAL');
  });

  it("waits for the library copy: the owner's invite is refused, then opens the account once copied", async () => {
    const { res, firmId, inviteId, token, body } = await provisioning(true, false);
    expect(error(res)).toMatchObject({
      code: 'ACCOUNT_SUSPENDED',
      details: { status: 'PROVISIONING' },
    });
    expect(store.invites.get(inviteId)!.status).toBe('PENDING');
    expect(store.accounts.get(firmId)!.status).toBe('PROVISIONING');
    store.libraryPending.delete(firmId);
    const again = await post(`/api/v1/invites/${token}/accept`, body);
    expect(again.statusCode, again.body).toBeLessThan(300);
    expect(store.accounts.get(firmId)!.status).toBe('TRIAL');
  });

  it('takes no other invite while PROVISIONING', async () => {
    const { res, firmId, inviteId } = await provisioning(false);
    expect(error(res)).toMatchObject({
      code: 'ACCOUNT_SUSPENDED',
      details: { status: 'PROVISIONING' },
    });
    expect(store.invites.get(inviteId)!.status).toBe('PENDING');
    expect(store.accounts.get(firmId)!.status).toBe('PROVISIONING');
  });
});

describe('the PlanetPulse support person', () => {
  it('is never a sign-in candidate: no password sign-in and no magic link', async () => {
    const p = await seed({ support: true, memberships: [{ role: 'FIRM_ADMIN' }] });
    expect(error(await login(p.email)).code).toBe('UNAUTHENTICATED');
    expect((await post('/api/v1/auth/magic-link', { email: p.email })).statusCode).toBe(202);
    expect(store.outbox).toEqual([]);
  });
});

describe('POST /auth/support/verify', () => {
  async function supportToken(
    options: { grantEndsAt?: string; expiresInSeconds?: number; status?: AccountStatus } = {},
  ) {
    const p = await seed({
      support: true,
      memberships: [{ role: 'FIRM_ADMIN' }],
      ...(options.status ? { status: options.status } : {}),
    });
    const grantId = randomUUID();
    const grantEndsAt = options.grantEndsAt ?? FAR;
    store.supportGrants.set(grantId, { endsAt: grantEndsAt, revoked: false });
    const token = newToken();
    store.supportTokens.set(hashToken(token), {
      id: randomUUID(),
      firmId: p.firmId,
      personId: p.personId,
      supportGrantId: grantId,
      grantEndsAt,
      grantLive: true,
      accountStatus: 'ACTIVE',
      expiresAt: new Date(now.getTime() + (options.expiresInSeconds ?? 60) * 1000).toISOString(),
      usedAt: null,
    });
    return { ...p, grantId, token };
  }
  const verify = (token: string) => post('/api/v1/auth/support/verify', { token });

  it('opens one MFA-satisfied session of at most two hours, once', async () => {
    const { token, personId } = await supportToken();
    const res = await verify(token);
    expect(res.statusCode).toBe(200);
    const me = Me.parse(res.json());
    expect(me).toMatchObject({
      person: { id: personId },
      mfa: { satisfied: true },
      session: { expiresAt: '2026-10-12T02:00:00.000Z' },
    });
    expect(store.audit).toContainEqual(
      expect.objectContaining({ type: 'LOGIN', data: { personId, method: 'SUPPORT' } }),
    );
    expect((await app.inject({ url: '/api/v1/probe', headers: headersOf(res) })).statusCode).toBe(
      200,
    );
    expect(error(await verify(token)).code).toBe('UNAUTHENTICATED');
  });

  it('ends the session at the grant’s end when that comes first', async () => {
    now = new Date('2098-12-31T23:30:00Z');
    const { token } = await supportToken({ grantEndsAt: '2099-01-01T00:00:00.000Z' });
    const me = Me.parse((await verify(token)).json());
    expect(me.session?.expiresAt).toBe('2099-01-01T00:00:00.000Z');
  });

  it('refuses a token past its minute, a revoked grant and a suspended account', async () => {
    const late = await supportToken();
    now = new Date(now.getTime() + 61_000);
    expect(error(await verify(late.token)).code).toBe('UNAUTHENTICATED');
    now = new Date('2026-10-12T00:00:00Z');

    const revoked = await supportToken();
    store.supportGrants.set(revoked.grantId, { endsAt: FAR, revoked: true });
    expect(error(await verify(revoked.token)).code).toBe('UNAUTHENTICATED');

    const paused = await supportToken({ status: 'SUSPENDED' });
    expect(error(await verify(paused.token)).code).toBe('ACCOUNT_SUSPENDED');
    expect(error(await verify('not-a-token-at-all')).code).toBe('UNAUTHENTICATED');
  });

  it('signs the session out when the grant is revoked', async () => {
    const { token, grantId } = await supportToken();
    const headers = headersOf(await verify(token));
    store.supportGrants.set(grantId, { endsAt: FAR, revoked: true });
    expect(error(await app.inject({ url: '/api/v1/probe', headers })).code).toBe('UNAUTHENTICATED');
  });

  it('is never reachable while the account is pending deletion', async () => {
    const { token, firmId } = await supportToken();
    const headers = headersOf(await verify(token));
    suspend(firmId, 'PENDING_DELETION');
    expect(error(await app.inject({ url: '/api/v1/me', headers })).code).toBe('ACCOUNT_SUSPENDED');
  });
});
