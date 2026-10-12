import { randomUUID } from 'node:crypto';
import {
  ApiErrorResponse,
  ERROR_DETAILS,
  Invite,
  InvitePreview,
  Me,
  MfaEnrollment,
  type Role,
} from '@canopy/contracts';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer, trustProxyFromEnv } from '../server.js';
import { LOCKOUT } from './accounts.js';
import { hashPassword } from './passwords.js';
import {
  clientSummary,
  InMemoryAuthStore,
  membership,
  person as personFixture,
  type MembershipInput,
} from './testing.js';
import { redactUrl } from './tokens.js';
import { base32Decode, hotp, totpStep } from './totp.js';
import { AuthService, MFA_SESSION_FAILURES } from './service.js';
import { SecretBox } from './secretbox.js';

const KEY = Buffer.alloc(32, 1).toString('base64');
const PASSWORD = 'a long enough password';
let now = new Date('2026-10-12T00:00:00Z');
const clock = () => now;

let store: InMemoryAuthStore;
let app: FastifyInstance;
let service: AuthService;
const apps: FastifyInstance[] = [];

function makeApp(rateLimit = { max: 10_000, timeWindow: 60_000 }) {
  const built = buildServer({ accountStore: store, authSecretKey: KEY, clock, rateLimit });
  built.get('/api/v1/probe', { config: { auth: 'session' } }, async (req) => ({
    personId: req.ctx.personId,
  }));
  apps.push(built);
  return built;
}

beforeEach(() => {
  now = new Date('2026-10-12T00:00:00Z');
  store = new InMemoryAuthStore();
  app = makeApp();
  service = new AuthService({ store, secrets: new SecretBox(KEY), clock });
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

interface Seed {
  firmId?: string;
  personId?: string;
  email?: string | null;
  password?: string | null;
  status?: 'UNCLAIMED' | 'INVITED' | 'ACTIVE' | 'DISABLED';
  memberships?: MembershipInput[];
}

async function seed(input: Seed = {}) {
  const firmId = input.firmId ?? randomUUID();
  const personId = input.personId ?? randomUUID();
  const status = input.status ?? 'ACTIVE';
  const email = input.email === undefined ? `${personId.slice(0, 8)}@example.com` : input.email;
  store.firms.set(firmId, `Firm ${firmId.slice(0, 4)}`);
  store.people.set(`${firmId}/${personId}`, {
    displayName: 'Asha Rao',
    email,
    status,
    passwordHash: input.password === null ? null : await hashPassword(input.password ?? PASSWORD),
    failedAttempts: 0,
    lockedUntil: null,
  });
  const memberships = (input.memberships ?? []).map((m) => membership({ firmId, personId, ...m }));
  for (const m of memberships) {
    if (m.clientId) store.clients.set(`${firmId}/${m.clientId}`, clientSummary({ id: m.clientId }));
  }
  store.principals.set(`${firmId}/${personId}`, {
    person: personFixture({ id: personId, firmId, status, email }),
    memberships,
    mfaEnrolled: false,
    mfaRequiredForFirmRoles: true,
    firmClientIds: memberships.flatMap((m) => (m.clientId ? [m.clientId] : [])),
  });
  return { firmId, personId, email: email ?? '' };
}

function sessionHeaders(res: LightMyRequestResponse) {
  const cookie = res.cookies.find((c) => c.name === 'sid');
  if (!cookie) throw new Error('no session cookie');
  return { cookie: `sid=${cookie.value}`, 'x-csrf-token': Me.parse(res.json()).csrfToken };
}

/** The error code, after checking the body is a contract `ApiErrorResponse`. */
function errorCode(res: LightMyRequestResponse) {
  return ApiErrorResponse.parse(res.json()).error.code;
}

let address = 0;

// Each call comes from its own address, so the per-IP login limit doesn't interfere with flow tests.
async function login(email: string, password = PASSWORD, firmId?: string) {
  address += 1;
  return app.inject({
    remoteAddress: `10.1.${Math.floor(address / 250)}.${address % 250}`,
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password, ...(firmId ? { firmId } : {}) },
  });
}

describe('POST /auth/login', () => {
  it('signs in with a secure session cookie and serves /me', async () => {
    const client = randomUUID();
    const person = await seed({ memberships: [{ role: 'OWNER', clientId: client }] });
    const res = await login(person.email.toUpperCase());
    expect(res.statusCode).toBe(200);
    expect(Me.parse(res.json())).toMatchObject({
      person: { id: person.personId, displayName: 'Asha Rao', email: person.email },
      clients: [{ id: client }],
      mfa: { required: false, enrolled: false, satisfied: false },
    });
    const cookie = res.cookies.find((c) => c.name === 'sid')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(store.audit).toContainEqual(
      expect.objectContaining({
        type: 'LOGIN',
        data: { personId: person.personId, method: 'PASSWORD' },
      }),
    );

    const me = await app.inject({ url: '/api/v1/me', headers: sessionHeaders(res) });
    expect(me.statusCode).toBe(200);
    expect(Me.parse(me.json())).toEqual(res.json());
  });

  it('answers every failure the same way', async () => {
    const person = await seed({ memberships: [{ role: 'OWNER' }] });
    await seed({
      email: 'disabled@example.com',
      status: 'DISABLED',
      memberships: [{ role: 'OWNER' }],
    });
    await seed({ email: 'nopass@example.com', password: null, memberships: [{ role: 'OWNER' }] });
    for (const res of [
      await login(person.email, 'wrong password!!'),
      await login('nobody@example.com'),
      await login('disabled@example.com'),
      await login('nopass@example.com'),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(errorCode(res)).toBe('UNAUTHENTICATED');
      expect(res.json().error).toEqual({
        code: 'UNAUTHENTICATED',
        message: 'Email or password is not correct.',
      });
    }
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not an email', password: 'x' },
    });
    expect(bad.statusCode).toBe(400);
    expect(errorCode(bad)).toBe('VALIDATION');
  });

  // Twelve scrypt checks (N = 2^15): quick alone, but past 5 s on a loaded CI runner.
  it(`locks the account for ${LOCKOUT.minutes} minutes after ${LOCKOUT.attempts} failures`, async () => {
    const person = await seed({ memberships: [{ role: 'OWNER' }] });
    for (let i = 0; i < LOCKOUT.attempts; i++) await login(person.email, 'wrong password!!');
    expect((await login(person.email)).statusCode).toBe(401);
    now = new Date(now.getTime() + LOCKOUT.minutes * 60_000 + 1000);
    expect((await login(person.email)).statusCode).toBe(200);
  }, 30_000);

  it('asks which firm when the email and password match people in two firms', async () => {
    const a = await seed({ email: 'shared@example.com', memberships: [{ role: 'OWNER' }] });
    const b = await seed({ email: 'shared@example.com', memberships: [{ role: 'VIEWER' }] });
    const first = await login('shared@example.com');
    expect(first.statusCode).toBe(409);
    expect(first.cookies).toHaveLength(0);
    const choice = ApiErrorResponse.parse(first.json()).error;
    expect(choice.code).toBe('FIRM_CHOICE_REQUIRED');
    expect(
      ERROR_DETAILS.FIRM_CHOICE_REQUIRED.parse(choice.details)
        .firms.map((f) => f.id)
        .sort(),
    ).toEqual([a.firmId, b.firmId].sort());
    const second = await login('shared@example.com', PASSWORD, b.firmId);
    expect(second.statusCode).toBe(200);
    expect(Me.parse(second.json()).person).toMatchObject({ id: b.personId, firmId: b.firmId });
    expect((await login('shared@example.com', PASSWORD, a.firmId)).statusCode).toBe(200);
  });

  it('is rate limited per IP', async () => {
    const limited = makeApp();
    for (let i = 0; i < 10; i++) {
      await limited.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} });
    }
    const res = await limited.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} });
    expect(res.statusCode).toBe(429);
    expect(errorCode(res)).toBe('RATE_LIMITED');
  });
});

describe('magic links', () => {
  it('always answers 202 and asks M9 to email ACTIVE people only', async () => {
    const person = await seed({ memberships: [{ role: 'OWNER' }] });
    await seed({ email: 'invited@example.com', status: 'INVITED' });
    for (const email of [person.email, 'nobody@example.com', 'invited@example.com']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link',
        payload: { email },
      });
      expect(res.statusCode).toBe(202);
    }
    expect(store.outbox).toEqual([
      {
        firmId: person.firmId,
        type: 'auth.magic_link_requested',
        data: { personId: person.personId },
      },
    ]);
  });

  it('asks for at most one link a minute per person', async () => {
    const person = await seed({ memberships: [{ role: 'OWNER' }] });
    const ask = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link',
        payload: { email: person.email },
      });
    expect((await ask()).statusCode).toBe(202);
    expect((await ask()).statusCode).toBe(202);
    expect(store.outbox).toHaveLength(1);
    now = new Date(now.getTime() + 61_000);
    await ask();
    expect(store.outbox).toHaveLength(2);
  });

  it('signs in once with an unexpired link', async () => {
    const person = await seed({ memberships: [{ role: 'OWNER' }] });
    const { token, expiresAt } = await service.issueLoginToken({ ...person, kind: 'MAGIC_LINK' });
    expect(expiresAt).toBe('2026-10-12T00:15:00.000Z');
    expect([...store.tokens.values()][0]!.tokenHash).not.toBe(token);
    const verify = (t: string) =>
      app.inject({ method: 'POST', url: '/api/v1/auth/magic-link/verify', payload: { token: t } });
    const ok = await verify(token);
    expect(ok.statusCode).toBe(200);
    expect(Me.parse(ok.json()).person.id).toBe(person.personId);
    expect(ok.cookies.some((c) => c.name === 'sid')).toBe(true);
    expect((await verify(token)).statusCode).toBe(401);

    const late = await service.issueLoginToken({ ...person, kind: 'MAGIC_LINK' });
    now = new Date(now.getTime() + 16 * 60_000);
    expect((await verify(late.token)).json().error.code).toBe('UNAUTHENTICATED');
    expect((await verify('x'.repeat(43))).statusCode).toBe(401);
  });

  it('does not accept an invite token as a magic link', async () => {
    const person = await seed({ memberships: [{ role: 'OWNER' }] });
    const { token } = await service.issueLoginToken({
      ...person,
      kind: 'INVITE',
      inviteId: randomUUID(),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      payload: { token },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('MFA', () => {
  async function adminSession() {
    const person = await seed({ memberships: [{ role: 'FIRM_ADMIN' }] });
    const res = await login(person.email);
    return { person, res, headers: sessionHeaders(res) };
  }

  const codeFor = (secret: string, at: Date) => hotp(base32Decode(secret), totpStep(at));

  it('blocks firm roles until a TOTP code is verified, then refuses replays', async () => {
    const { res, headers } = await adminSession();
    expect(Me.parse(res.json()).mfa).toEqual({
      required: true,
      enrolled: false,
      satisfied: false,
    });
    const blocked = await app.inject({ url: '/api/v1/probe', headers });
    expect(blocked.json().error).toMatchObject({
      code: 'MFA_REQUIRED',
      details: { enrolled: false },
    });

    const verifyFirst = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers,
      payload: { code: '123456' },
    });
    expect(verifyFirst.json().error.code).toBe('MFA_REQUIRED');

    const enroll = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers });
    expect(enroll.statusCode).toBe(200);
    const { otpauthUrl } = MfaEnrollment.parse(enroll.json());
    const secret = new URL(otpauthUrl).searchParams.get('secret')!;
    expect(otpauthUrl).toContain('PlanetPulse');
    expect(JSON.stringify([...store.mfa.values()])).not.toContain(secret);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers,
      payload: { code: codeFor(secret, new Date(now.getTime() + 5 * 60_000)) },
    });
    expect(wrong.statusCode).toBe(400);

    const code = codeFor(secret, now);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers,
      payload: { code },
    });
    expect(ok.statusCode).toBe(200);
    expect(Me.parse(ok.json()).mfa).toEqual({ required: true, enrolled: true, satisfied: true });
    expect((await app.inject({ url: '/api/v1/probe', headers })).statusCode).toBe(200);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers,
      payload: { code },
    });
    expect(replay.statusCode).toBe(400);
    const again = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers });
    expect(errorCode(again)).toBe('DUPLICATE');
  });

  it('requires a code in every new session once enrolled', async () => {
    const { person, headers } = await adminSession();
    const { otpauthUrl } = MfaEnrollment.parse(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers })).json(),
    );
    const secret = new URL(otpauthUrl).searchParams.get('secret')!;
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers,
      payload: { code: codeFor(secret, now) },
    });
    now = new Date(now.getTime() + 60_000);
    const next = await login(person.email);
    expect(Me.parse(next.json()).mfa).toEqual({
      required: true,
      enrolled: true,
      satisfied: false,
    });
    const nextHeaders = sessionHeaders(next);
    expect((await app.inject({ url: '/api/v1/probe', headers: nextHeaders })).statusCode).toBe(401);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: nextHeaders,
      payload: { code: codeFor(secret, now) },
    });
    expect((await app.inject({ url: '/api/v1/probe', headers: nextHeaders })).statusCode).toBe(200);
  });
});

describe('MFA failures', () => {
  const wrongCode = (secret: string) =>
    hotp(base32Decode(secret), totpStep(new Date(now.getTime() + 5 * 60_000)));

  async function enrolled() {
    const person = await seed({ memberships: [{ role: 'FIRM_ADMIN' }] });
    const headers = sessionHeaders(await login(person.email));
    const { otpauthUrl } = MfaEnrollment.parse(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers })).json(),
    );
    return { person, headers, secret: new URL(otpauthUrl).searchParams.get('secret')! };
  }

  // From a new address each time, as a distributed guesser would: the per-IP limit does not stop them.
  const verify = (headers: Record<string, string>, code: string) => {
    address += 1;
    return app.inject({
      remoteAddress: `10.2.${Math.floor(address / 250)}.${address % 250}`,
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers,
      payload: { code },
    });
  };

  it(`revokes the session after ${MFA_SESSION_FAILURES} wrong codes`, async () => {
    const { headers, secret } = await enrolled();
    for (let i = 1; i < MFA_SESSION_FAILURES; i++) {
      expect(errorCode(await verify(headers, wrongCode(secret)))).toBe('VALIDATION');
    }
    expect(errorCode(await verify(headers, wrongCode(secret)))).toBe('UNAUTHENTICATED');
    expect((await app.inject({ url: '/api/v1/me', headers })).statusCode).toBe(401);
  });

  it(`locks the account after ${LOCKOUT.attempts} wrong codes, even across new sign-ins`, async () => {
    const { person, headers: first, secret } = await enrolled();
    for (let i = 0; i < 4; i++) await verify(first, wrongCode(secret));
    const second = sessionHeaders(await login(person.email));
    for (let i = 0; i < 4; i++) await verify(second, wrongCode(secret));
    const third = sessionHeaders(await login(person.email));
    expect(errorCode(await verify(third, wrongCode(secret)))).toBe('VALIDATION');
    expect(errorCode(await verify(third, wrongCode(secret)))).toBe('UNAUTHENTICATED');
    for (const headers of [first, second, third]) {
      expect((await app.inject({ url: '/api/v1/me', headers })).statusCode).toBe(401);
    }
    expect((await login(person.email)).statusCode).toBe(401);
    now = new Date(now.getTime() + (LOCKOUT.minutes + 1) * 60_000);
    const back = sessionHeaders(await login(person.email));
    expect((await verify(back, hotp(base32Decode(secret), totpStep(now)))).statusCode).toBe(200);
    expect(store.people.get(`${person.firmId}/${person.personId}`)!.failedAttempts).toBe(0);
  });
}, 30_000);

describe('POST /auth/logout', () => {
  it('needs the CSRF header, then ends the session and clears the cookie', async () => {
    const person = await seed({ memberships: [{ role: 'OWNER' }] });
    const headers = sessionHeaders(await login(person.email));
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: headers.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers });
    expect(out.statusCode).toBe(204);
    expect(out.cookies.find((c) => c.name === 'sid')?.value).toBe('');
    expect((await app.inject({ url: '/api/v1/me', headers })).statusCode).toBe(401);
  });
});

describe('invites', () => {
  const CLIENT = randomUUID();

  async function setup(role: Role = 'CLIENT_ADMIN') {
    const firmId = randomUUID();
    const manager = await seed({
      firmId,
      memberships: [
        role === 'FIRM_ADMIN' || role === 'CONSULTANT'
          ? { role, ...(role === 'CONSULTANT' ? { consultantClientIds: [CLIENT] } : {}) }
          : { role, clientId: CLIENT },
      ],
    });
    const p = store.principals.get(`${firmId}/${manager.personId}`)!;
    store.principals.set(`${firmId}/${manager.personId}`, {
      ...p,
      mfaEnrolled: true,
      firmClientIds: [CLIENT],
    });
    const res = await login(manager.email);
    // Firm roles need MFA; mark the session done for these tests.
    for (const [hash, s] of store.sessions) store.sessions.set(hash, { ...s, mfaSatisfied: true });
    const imported = await seed({ firmId, email: null, status: 'UNCLAIMED', password: null });
    return { firmId, manager, headers: sessionHeaders(res), imported };
  }

  const invite = (headers: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers,
      payload: { consultantClientIds: null, unitIds: null, expiresAt: null, ...payload },
    });

  it('lets a client admin invite an imported person, who claims the account', async () => {
    const { firmId, manager, headers, imported } = await setup();
    const res = await invite(headers, {
      personId: imported.personId,
      email: 'new.owner@example.com',
      role: 'OWNER',
      clientId: CLIENT,
    });
    expect(res.statusCode).toBe(201);
    const created = Invite.parse(res.json());
    expect(created).toMatchObject({
      personId: imported.personId,
      status: 'PENDING',
      role: 'OWNER',
      invitedById: manager.personId,
      linkExpiresAt: '2026-10-19T00:00:00.000Z',
    });
    const inviteId = created.id;
    expect(store.outbox).toContainEqual({
      firmId,
      type: 'person.invited',
      data: { personId: imported.personId, inviteId, role: 'OWNER', clientId: CLIENT },
    });
    expect(store.people.get(`${firmId}/${imported.personId}`)).toMatchObject({
      status: 'INVITED',
      email: 'new.owner@example.com',
    });

    const { token } = await service.issueLoginToken({
      firmId,
      personId: imported.personId,
      kind: 'INVITE',
      inviteId,
    });
    const details = await app.inject({ url: `/api/v1/invites/${token}` });
    expect(InvitePreview.parse(details.json())).toEqual({
      email: 'new.owner@example.com',
      displayName: 'Asha Rao',
      firmName: expect.any(String),
      clientName: 'Client',
      role: 'OWNER',
      linkExpiresAt: created.linkExpiresAt,
    });

    const weak = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
      payload: { password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
      payload: { password: PASSWORD, displayName: 'Asha R. Rao' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(Me.parse(accepted.json())).toMatchObject({
      person: { id: imported.personId, displayName: 'Asha R. Rao', status: 'ACTIVE' },
      clients: [{ id: CLIENT }],
    });
    expect(store.outbox.map((e) => e.type)).toEqual(
      expect.arrayContaining(['person.claimed', 'membership.changed']),
    );
    const me = await app.inject({ url: '/api/v1/me', headers: sessionHeaders(accepted) });
    expect(Me.parse(me.json()).memberships).toMatchObject([{ role: 'OWNER', clientId: CLIENT }]);
    expect((await app.inject({ url: `/api/v1/invites/${token}` })).statusCode).toBe(404);
    expect((await login('new.owner@example.com')).statusCode).toBe(200);
  });

  it('enforces who may grant which role and the membership shape', async () => {
    const { headers, imported } = await setup();
    const base = { personId: imported.personId, email: 'x@example.com' };
    const cases: [Record<string, unknown>, number][] = [
      [{ role: 'CONSULTANT', clientId: null, consultantClientIds: [CLIENT] }, 403],
      [{ role: 'OWNER', clientId: randomUUID() }, 403],
      [{ role: 'VIEWER', clientId: CLIENT }, 400],
      [{ role: 'CLIENT_ADMIN', clientId: CLIENT, unitIds: [randomUUID()] }, 400],
      [{ role: 'OWNER', clientId: CLIENT, personId: randomUUID() }, 404],
    ];
    for (const [payload, status] of cases) {
      expect((await invite(headers, { ...base, ...payload })).statusCode).toBe(status);
    }
    const owner = await setup('OWNER');
    expect(
      (
        await invite(owner.headers, {
          ...base,
          personId: owner.imported.personId,
          role: 'OWNER',
          clientId: CLIENT,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("refuses, as not found, a person who holds or is offered a role outside the inviter's scope", async () => {
    for (const role of ['CLIENT_ADMIN', 'CONSULTANT'] as const) {
      const { firmId, manager, headers } = await setup(role);
      const unclaimed = { firmId, email: null, status: 'UNCLAIMED', password: null } as const;
      const otherClient = await seed({
        ...unclaimed,
        memberships: [{ role: 'APPROVER', clientId: randomUUID() }],
      });
      const firmStaff = await seed({
        ...unclaimed,
        memberships: [{ role: 'CONSULTANT', consultantClientIds: [CLIENT] }],
      });
      const offered = await seed(unclaimed);
      const open = await store.createInvite({
        firmId,
        personId: offered.personId,
        displayName: null,
        email: 'offered@example.com',
        grant: {
          role: 'APPROVER',
          clientId: randomUUID(),
          consultantClientIds: null,
          unitIds: null,
          expiresAt: null,
        },
        invitedById: manager.personId,
        linkExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        requestId: 'seed',
        now,
      });
      for (const target of [otherClient, firmStaff, offered]) {
        const res = await invite(headers, {
          personId: target.personId,
          email: 'attacker@example.com',
          role: 'OWNER',
          clientId: CLIENT,
        });
        expect(errorCode(res), role).toBe('NOT_FOUND');
      }
      expect(store.invites.get(open.id)!.status).toBe('PENDING');
      expect([...store.invites.values()].filter((i) => i.firmId === firmId)).toHaveLength(1);
    }
  });

  it("invites an imported person whose roles are all in the inviter's scope", async () => {
    const { firmId, headers } = await setup();
    const local = await seed({
      firmId,
      email: null,
      status: 'UNCLAIMED',
      password: null,
      memberships: [{ role: 'OWNER', clientId: CLIENT }],
    });
    const res = await invite(headers, {
      personId: local.personId,
      email: 'local@example.com',
      role: 'APPROVER',
      clientId: CLIENT,
    });
    expect(res.statusCode).toBe(201);
  });

  it('refuses people who already have an account', async () => {
    const { firmId, headers } = await setup();
    const active = await seed({ firmId, memberships: [{ role: 'VIEWER', clientId: CLIENT }] });
    const res = await invite(headers, {
      personId: active.personId,
      email: active.email,
      role: 'OWNER',
      clientId: CLIENT,
    });
    expect(ApiErrorResponse.parse(res.json()).error).toMatchObject({
      code: 'DUPLICATE',
      details: { field: 'personId', existingId: active.personId },
    });
  });

  it('invites a new person by name, and refuses an email someone in the firm already has', async () => {
    const { firmId, headers } = await setup();
    const res = await invite(headers, {
      displayName: 'Ravi Kumar',
      email: 'ravi@example.com',
      role: 'APPROVER',
      clientId: CLIENT,
    });
    expect(res.statusCode).toBe(201);
    const created = Invite.parse(res.json());
    expect(store.people.get(`${firmId}/${created.personId}`)).toMatchObject({
      displayName: 'Ravi Kumar',
      status: 'INVITED',
      email: 'ravi@example.com',
    });
    expect(store.audit).toContainEqual({
      firmId,
      type: 'CREATE',
      data: { personId: created.personId },
    });
    const taken = await invite(headers, {
      displayName: 'Someone Else',
      email: 'RAVI@example.com',
      role: 'OWNER',
      clientId: CLIENT,
    });
    expect(ApiErrorResponse.parse(taken.json()).error).toMatchObject({
      code: 'DUPLICATE',
      details: { field: 'email', existingId: created.personId },
    });
    const neither = await invite(headers, {
      email: 'n@example.com',
      role: 'OWNER',
      clientId: CLIENT,
    });
    expect(errorCode(neither)).toBe('VALIDATION');
  });

  it('lets a firm admin invite a consultant', async () => {
    const { headers, imported } = await setup('FIRM_ADMIN');
    const res = await invite(headers, {
      personId: imported.personId,
      email: 'consultant@example.com',
      role: 'CONSULTANT',
      clientId: null,
      consultantClientIds: [CLIENT],
    });
    expect(res.statusCode).toBe(201);
  });

  it('revokes an open invite so its link stops working', async () => {
    const { firmId, headers, imported } = await setup();
    const { id: inviteId } = Invite.parse(
      (
        await invite(headers, {
          personId: imported.personId,
          email: 'r@example.com',
          role: 'OWNER',
          clientId: CLIENT,
        })
      ).json(),
    );
    const { token } = await service.issueLoginToken({
      firmId,
      personId: imported.personId,
      kind: 'INVITE',
      inviteId,
    });
    const revoke = () =>
      app.inject({ method: 'POST', url: `/api/v1/invites/${inviteId}/revoke`, headers });
    const revoked = await revoke();
    expect(revoked.statusCode).toBe(200);
    expect(Invite.parse(revoked.json())).toMatchObject({ id: inviteId, status: 'REVOKED' });
    expect((await app.inject({ url: `/api/v1/invites/${token}` })).statusCode).toBe(404);
    expect(errorCode(await revoke())).toBe('INVALID_TRANSITION');
    const other = await setup();
    const elsewhere = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/${inviteId}/revoke`,
      headers: other.headers,
    });
    expect(elsewhere.statusCode).toBe(404);
  });

  it('expires invite links after 7 days', async () => {
    const { firmId, headers, imported } = await setup();
    const { id: inviteId } = Invite.parse(
      (
        await invite(headers, {
          personId: imported.personId,
          email: 'e@example.com',
          role: 'OWNER',
          clientId: CLIENT,
        })
      ).json(),
    );
    const { token } = await service.issueLoginToken({
      firmId,
      personId: imported.personId,
      kind: 'INVITE',
      inviteId,
    });
    now = new Date(now.getTime() + 7 * 24 * 3600_000 + 1000);
    expect((await app.inject({ url: `/api/v1/invites/${token}` })).statusCode).toBe(404);
    // Keep the manager's session alive past the invite's expiry: an expired invite cannot be revoked.
    for (const [hash, s] of store.sessions) {
      store.sessions.set(hash, { ...s, expiresAt: '2099-01-01T00:00:00Z' });
    }
    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/${inviteId}/revoke`,
      headers,
    });
    expect(errorCode(revoke)).toBe('INVALID_TRANSITION');
  });
});

describe('server wiring', () => {
  it('needs AUTH_SECRET_KEY to serve sign-in routes', () => {
    const previous = process.env.AUTH_SECRET_KEY;
    delete process.env.AUTH_SECRET_KEY;
    expect(() => buildServer({ accountStore: store })).toThrow(/AUTH_SECRET_KEY/);
    process.env.AUTH_SECRET_KEY = previous;
  });

  it('reads TRUST_PROXY', () => {
    expect(trustProxyFromEnv(undefined)).toBe(false);
    expect(trustProxyFromEnv('false')).toBe(false);
    expect(trustProxyFromEnv('true')).toBe(true);
    expect(trustProxyFromEnv('10.0.0.0/8')).toBe('10.0.0.0/8');
  });

  it('redacts tokens from logged URLs', () => {
    expect(redactUrl('/api/v1/invites/abcDEF123/accept')).toBe('/api/v1/invites/[redacted]/accept');
    expect(redactUrl('/login?token=abc&x=1')).toBe('/login?token=[redacted]&x=1');
    expect(redactUrl('/api/v1/me')).toBe('/api/v1/me');
  });
});
