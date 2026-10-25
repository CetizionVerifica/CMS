import { randomBytes, randomUUID } from 'node:crypto';
import {
  ApiErrorResponse,
  ClientPeriods,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_FIRM_SETTINGS,
  LocalDate,
  Invite,
  InvitePreview,
  Me,
  MfaEnrollment,
  type Role,
} from '@canopy/contracts';
import {
  account,
  accountJobs,
  clients,
  companies,
  createAdminDatabase,
  createDatabase,
  createOperatorDatabase,
  platformAccounts,
  platformSupport,
  supportGrants,
  credentials,
  memberships,
  locations,
  people,
  systemContext,
  units,
  type AdminDatabase,
  type Database,
} from '@canopy/db';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { LOCKOUT, type AccountStore } from './accounts.js';
import { createDbAccountStore } from './db-store.js';
import { hashPassword } from './passwords.js';
import { SecretBox } from './secretbox.js';
import { hashToken } from './tokens.js';
import { AuthService } from './service.js';
import { base32Decode, hotp, totpStep } from './totp.js';

// The M5 flows against M3's tables and RLS on Postgres 16 (CI `db` job). Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;

const KEY = Buffer.alloc(32, 7).toString('base64');
const PASSWORD = 'a long enough password';
// Ten years ahead: M3's tables check that a login token or invite expires after its row is created (database time), so
// a clock in the past would fail once the wall clock passes it. Sessions take their creation time from this clock.
let now = new Date('2036-10-12T04:00:00Z');
const clock = () => now;
// 2036-10-12 in Asia/Kolkata is in Q3 of FY 2036-37; instances due Apr 2035 to Mar 2037 make two FYs available.
const PERIODS = ClientPeriods.parse({
  current: { fy: '2036-37', quarter: 3 },
  availableFys: ['2035-36', '2036-37'],
  availableUntil: '2037-03',
});

describe.skipIf(!url)('database AccountStore', () => {
  let name: string;
  let admin: AdminDatabase;
  let db: Database;
  let owner: pg.Pool;
  let app: FastifyInstance;
  let service: AuthService;
  let store: AccountStore;
  let address = 0;

  beforeAll(async () => {
    const base = new URL(url!);
    name = `canopy_m5_${randomBytes(6).toString('hex')}`;
    const server = new pg.Client({ connectionString: base.toString() });
    await server.connect();
    await server.query(`CREATE DATABASE ${name}`);
    await server.end();
    const target = new URL(base);
    target.pathname = `/${name}`;
    admin = createAdminDatabase({ connectionString: target.toString() });
    await admin.migrate();
    db = createDatabase({ connectionString: target.toString(), max: 4 });
    owner = new pg.Pool({ connectionString: target.toString(), max: 2 });
    // DROP DATABASE ... WITH (FORCE) in afterAll can end a client mid-close; without a listener the pool
    // re-emits that 57P01 as an unhandled error (the guard @canopy/db's createPool has).
    owner.on('error', () => {});
    store = createDbAccountStore(db, {
      generatedRange: async () => ({
        from: LocalDate.parse('2035-04-30'),
        to: LocalDate.parse('2037-03-31'),
      }),
      clock,
    });
    app = buildServer({
      accountStore: store,
      authSecretKey: KEY,
      clock,
      rateLimit: { max: 10_000, timeWindow: 60_000 },
    });
    service = new AuthService({ store, secrets: new SecretBox(KEY), clock });
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.close(), admin?.close(), owner?.end()]);
    const cleanup = new pg.Client({ connectionString: url });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end();
  });

  interface Seeded {
    firmId: string;
    clientId: string;
  }

  async function firmWithClient(): Promise<Seeded> {
    const firmId = await admin.createFirm({ name: `Firm ${randomUUID().slice(0, 6)}` });
    const client = await db.withTenant(systemContext(firmId, 'seed'), (tx) =>
      clients.create(tx, { name: 'Kestrel Metals Group', settings: DEFAULT_CLIENT_SETTINGS }),
    );
    return { firmId, clientId: client.id };
  }

  async function person(
    seeded: Seeded,
    input: { role?: Role; email?: string | null; password?: boolean } = {},
  ) {
    const email =
      input.email === undefined ? `${randomUUID().slice(0, 8)}@example.com` : input.email;
    return db.withTenant(systemContext(seeded.firmId, 'seed'), async (tx) => {
      const created = await people.create(tx, {
        displayName: 'Asha Rao',
        nameNormalized: 'asha rao',
        email,
        status: email === null ? 'UNCLAIMED' : 'ACTIVE',
      });
      if (input.role) {
        const firmRole = input.role === 'FIRM_ADMIN' || input.role === 'CONSULTANT';
        await memberships.create(tx, {
          personId: created.id,
          role: input.role,
          clientId: firmRole ? null : seeded.clientId,
          consultantClientIds: input.role === 'CONSULTANT' ? [seeded.clientId] : null,
          unitIds: null,
          expiresAt: null,
        });
      }
      if (input.password !== false && email !== null) {
        await credentials.setPassword(tx, created.id, await hashPassword(PASSWORD));
      }
      return { personId: created.id, email: email ?? '' };
    });
  }

  function login(email: string, password = PASSWORD) {
    address += 1;
    return app.inject({
      remoteAddress: `10.9.${Math.floor(address / 250)}.${address % 250}`,
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
  }

  function sessionHeaders(res: LightMyRequestResponse) {
    const cookie = res.cookies.find((c) => c.name === 'sid');
    if (!cookie) throw new Error(`no session cookie: ${res.body}`);
    return { cookie: `sid=${cookie.value}`, 'x-csrf-token': Me.parse(res.json()).csrfToken };
  }

  const errorCode = (res: LightMyRequestResponse) => ApiErrorResponse.parse(res.json()).error.code;

  async function rows(sql: string, values: unknown[]) {
    return (await owner.query(sql, values)).rows as Record<string, unknown>[];
  }

  it('signs a client admin in and serves Me with their client', async () => {
    const seeded = await firmWithClient();
    const ca = await person(seeded, { role: 'CLIENT_ADMIN' });
    const res = await login(ca.email.toUpperCase());
    expect(res.statusCode).toBe(200);
    const me = Me.parse(res.json());
    expect(me).toMatchObject({
      person: { id: ca.personId, status: 'ACTIVE' },
      memberships: [{ role: 'CLIENT_ADMIN', clientId: seeded.clientId }],
      clients: [
        {
          id: seeded.clientId,
          name: 'Kestrel Metals Group',
          timeZone: 'Asia/Kolkata',
          unitCount: 0,
          period: PERIODS,
        },
      ],
      mfa: { required: false, satisfied: false },
    });
    const again = await app.inject({ url: '/api/v1/me', headers: sessionHeaders(res) });
    expect(Me.parse(again.json())).toEqual(me);
    expect(
      await rows(`SELECT action, entity_id FROM audit_event WHERE firm_id = $1`, [seeded.firmId]),
    ).toContainEqual({ action: 'LOGIN', entity_id: ca.personId });

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: sessionHeaders(res),
    });
    expect(out.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/me', headers: sessionHeaders(res) })).statusCode).toBe(
      401,
    );
  });

  it("defaults to M3's generated range: a client without instances offers only its current FY", async () => {
    const seeded = await firmWithClient();
    const ca = await person(seeded, { role: 'CLIENT_ADMIN' });
    const plain = buildServer({
      accountStore: createDbAccountStore(db, { clock }),
      authSecretKey: KEY,
      clock,
      rateLimit: { max: 10_000, timeWindow: 60_000 },
    });
    try {
      const res = await plain.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: ca.email, password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      expect(Me.parse(res.json()).clients.map((c) => c.period)).toEqual([
        ClientPeriods.parse({
          current: { fy: '2036-37', quarter: 3 },
          availableFys: ['2036-37'],
          availableUntil: null,
        }),
      ]);
    } finally {
      await plain.close();
    }
  });

  it(`locks after ${LOCKOUT.attempts} failures, then unlocks`, async () => {
    const seeded = await firmWithClient();
    const ca = await person(seeded, { role: 'CLIENT_ADMIN' });
    for (let i = 0; i < LOCKOUT.attempts; i++) {
      expect((await login(ca.email, 'wrong password!!')).statusCode).toBe(401);
    }
    expect((await login(ca.email)).statusCode).toBe(401);
    now = new Date(now.getTime() + (LOCKOUT.minutes + 1) * 60_000);
    expect((await login(ca.email)).statusCode).toBe(200);
  });

  it('stamps a session with the service clock, so a clock in the past still signs in', async () => {
    const saved = now;
    now = new Date('2020-01-15T06:30:00Z');
    try {
      const seeded = await firmWithClient();
      const ca = await person(seeded, { role: 'CLIENT_ADMIN' });
      const res = await login(ca.email);
      expect(res.statusCode).toBe(200);
      expect(
        await rows(
          `SELECT created_at, last_seen_at, expires_at FROM auth_session WHERE person_id = $1`,
          [ca.personId],
        ),
      ).toEqual([
        {
          created_at: new Date('2020-01-15T06:30:00Z'),
          last_seen_at: new Date('2020-01-15T06:30:00Z'),
          expires_at: expect.any(Date),
        },
      ]);
      const me = await app.inject({ url: '/api/v1/me', headers: sessionHeaders(res) });
      expect(me.statusCode).toBe(200);
    } finally {
      now = saved;
    }
  });

  it('emails a magic link through the outbox and signs in once with it', async () => {
    const seeded = await firmWithClient();
    const ca = await person(seeded, { role: 'CLIENT_ADMIN' });
    const asked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email: ca.email },
    });
    expect(asked.statusCode).toBe(202);
    expect(
      await rows(`SELECT type, data FROM domain_event WHERE firm_id = $1`, [seeded.firmId]),
    ).toContainEqual({ type: 'auth.magic_link_requested', data: { personId: ca.personId } });
    const { token } = await service.issueLoginToken({
      firmId: seeded.firmId,
      personId: ca.personId,
      kind: 'MAGIC_LINK',
    });
    const verify = () =>
      app.inject({ method: 'POST', url: '/api/v1/auth/magic-link/verify', payload: { token } });
    const first = await verify();
    expect(Me.parse(first.json()).person.id).toBe(ca.personId);
    expect(errorCode(await verify())).toBe('UNAUTHENTICATED');
  });

  it('enrols a firm admin in MFA and refuses a replayed code', async () => {
    const seeded = await firmWithClient();
    const fa = await person(seeded, { role: 'FIRM_ADMIN' });
    const res = await login(fa.email);
    const headers = sessionHeaders(res);
    expect(Me.parse(res.json()).mfa).toEqual({ required: true, enrolled: false, satisfied: false });
    const enrolled = MfaEnrollment.parse(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers })).json(),
    );
    const secret = new URL(enrolled.otpauthUrl).searchParams.get('secret')!;
    const code = hotp(base32Decode(secret), totpStep(now));
    const verify = () =>
      app.inject({ method: 'POST', url: '/api/v1/auth/mfa/verify', headers, payload: { code } });
    const ok = await verify();
    expect(Me.parse(ok.json()).mfa).toEqual({ required: true, enrolled: true, satisfied: true });
    expect(errorCode(await verify())).toBe('VALIDATION');
    const stored = await rows(
      `SELECT mfa_sealed_secret FROM auth_credential WHERE person_id = $1`,
      [fa.personId],
    );
    expect(JSON.stringify(stored)).not.toContain(secret);
    // F14 mitigation 3: the completed setup, once, tells M9 to email the person.
    expect(
      await rows(
        `SELECT client_id, actor, data FROM domain_event WHERE firm_id = $1 AND type = 'person.mfa_enrolled'`,
        [seeded.firmId],
      ),
    ).toEqual([
      {
        client_id: null,
        actor: { kind: 'PERSON', personId: fa.personId },
        data: { personId: fa.personId, via: 'SETTINGS' },
      },
    ]);
  });

  it('records person.mfa_enrolled when a firm-role invitee sets up MFA while accepting', async () => {
    const seeded = await firmWithClient();
    const fa = await person(seeded, { role: 'FIRM_ADMIN' });
    const signedIn = await login(fa.email);
    const headers = sessionHeaders(signedIn);
    const own = MfaEnrollment.parse(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers })).json(),
    );
    const ownSecret = new URL(own.otpauthUrl).searchParams.get('secret')!;
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers,
      payload: { code: hotp(base32Decode(ownSecret), totpStep(now)) },
    });
    const imported = await person(seeded, { email: null });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers,
      payload: {
        personId: imported.personId,
        email: 'new.consultant@example.com',
        role: 'CONSULTANT',
        clientId: null,
        consultantClientIds: [seeded.clientId],
        unitIds: null,
        expiresAt: null,
      },
    });
    expect(res.statusCode).toBe(201);
    const { token } = await service.issueLoginToken({
      firmId: seeded.firmId,
      personId: imported.personId,
      kind: 'INVITE',
      inviteId: Invite.parse(res.json()).id,
    });
    const setup = MfaEnrollment.parse(
      (await app.inject({ method: 'POST', url: `/api/v1/invites/${token}/mfa/enroll` })).json(),
    );
    const secret = new URL(setup.otpauthUrl).searchParams.get('secret')!;
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
      payload: { password: PASSWORD, mfaCode: hotp(base32Decode(secret), totpStep(now)) },
    });
    expect(accepted.statusCode).toBe(200);
    const enrolled = await rows(
      `SELECT data FROM domain_event WHERE firm_id = $1 AND type = 'person.mfa_enrolled' ORDER BY id`,
      [seeded.firmId],
    );
    expect(enrolled).toEqual([
      { data: { personId: fa.personId, via: 'SETTINGS' } },
      { data: { personId: imported.personId, via: 'INVITE' } },
    ]);
  });

  it('locks a firm admin after ten wrong MFA codes across sign-ins and ends every session', async () => {
    const seeded = await firmWithClient();
    const fa = await person(seeded, { role: 'FIRM_ADMIN' });
    const first = sessionHeaders(await login(fa.email));
    const enrolled = MfaEnrollment.parse(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers: first })).json(),
    );
    const secret = new URL(enrolled.otpauthUrl).searchParams.get('secret')!;
    const verify = (headers: Record<string, string>, at: Date) =>
      app.inject({
        remoteAddress: `10.8.0.${(address += 1) % 250}`,
        method: 'POST',
        url: '/api/v1/auth/mfa/verify',
        headers,
        payload: { code: hotp(base32Decode(secret), totpStep(at)) },
      });
    const wrong = () => new Date(now.getTime() + 5 * 60_000);
    for (let i = 0; i < 4; i++) await verify(first, wrong());
    const second = sessionHeaders(await login(fa.email));
    for (let i = 0; i < 4; i++) await verify(second, wrong());
    const third = sessionHeaders(await login(fa.email));
    await verify(third, wrong());
    expect(errorCode(await verify(third, wrong()))).toBe('UNAUTHENTICATED');
    expect(
      await rows(
        `SELECT count(*)::int AS open FROM auth_session WHERE person_id = $1 AND revoked_at IS NULL`,
        [fa.personId],
      ),
    ).toEqual([{ open: 0 }]);
    expect((await login(fa.email)).statusCode).toBe(401);

    now = new Date(now.getTime() + (LOCKOUT.minutes + 1) * 60_000);
    const back = sessionHeaders(await login(fa.email));
    expect((await verify(back, now)).statusCode).toBe(200);
    expect(
      await rows(`SELECT failed_attempts FROM auth_credential WHERE person_id = $1`, [fa.personId]),
    ).toEqual([{ failed_attempts: 0 }]);
  });

  it("refuses to invite a person whose roles lie outside the inviter's clients", async () => {
    const seeded = await firmWithClient();
    const other = await db.withTenant(systemContext(seeded.firmId, 'seed'), (tx) =>
      clients.create(tx, { name: 'Osprey Holdings', settings: DEFAULT_CLIENT_SETTINGS }),
    );
    const ca = await person(seeded, { role: 'CLIENT_ADMIN' });
    const fa = await person(seeded, { role: 'FIRM_ADMIN' });
    const elsewhere = await person(
      { firmId: seeded.firmId, clientId: other.id },
      { role: 'APPROVER', email: null },
    );
    const offered = await person(seeded, { email: null });
    const open = await store.createInvite({
      firmId: seeded.firmId,
      personId: offered.personId,
      displayName: null,
      email: 'offered@example.com',
      grant: {
        role: 'APPROVER',
        clientId: other.id,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: null,
      },
      invitedById: fa.personId,
      linkExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      requestId: 'fa-invite',
      now,
    });
    const headers = sessionHeaders(await login(ca.email));
    for (const target of [elsewhere, offered]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invites',
        headers,
        payload: {
          personId: target.personId,
          email: 'attacker@example.com',
          role: 'OWNER',
          clientId: seeded.clientId,
          consultantClientIds: null,
          unitIds: null,
          expiresAt: null,
        },
      });
      expect(errorCode(res)).toBe('NOT_FOUND');
    }
    expect((await store.findInvite(seeded.firmId, open.id))!.status).toBe('PENDING');
    expect(
      await rows(`SELECT count(*)::int AS n FROM auth_invite WHERE person_id = ANY($1)`, [
        [elsewhere.personId, offered.personId],
      ]),
    ).toEqual([{ n: 1 }]);

    // Once that invite's link has expired it no longer counts, and the client admin may invite the person.
    now = new Date(now.getTime() + 2 * 86_400_000);
    const later = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: sessionHeaders(await login(ca.email)),
      payload: {
        personId: offered.personId,
        email: 'offered@example.com',
        role: 'OWNER',
        clientId: seeded.clientId,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: null,
      },
    });
    expect(later.statusCode).toBe(201);
  });

  it('invites an imported person, who claims the account and signs in', async () => {
    const seeded = await firmWithClient();
    const ca = await person(seeded, { role: 'CLIENT_ADMIN' });
    const imported = await person(seeded, { email: null });
    const headers = sessionHeaders(await login(ca.email));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers,
      payload: {
        personId: imported.personId,
        email: 'new.owner@example.com',
        role: 'OWNER',
        clientId: seeded.clientId,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: null,
      },
    });
    expect(res.statusCode).toBe(201);
    const invite = Invite.parse(res.json());
    expect(invite).toMatchObject({ status: 'PENDING', invitedById: ca.personId });

    const { token } = await service.issueLoginToken({
      firmId: seeded.firmId,
      personId: imported.personId,
      kind: 'INVITE',
      inviteId: invite.id,
    });
    const preview = InvitePreview.parse(
      (await app.inject({ url: `/api/v1/invites/${token}` })).json(),
    );
    expect(preview).toMatchObject({
      email: 'new.owner@example.com',
      displayName: 'Asha Rao',
      clientName: 'Kestrel Metals Group',
      role: 'OWNER',
    });
    const accept = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/invites/${token}/accept`,
        payload: { password: PASSWORD, displayName: 'Asha R. Rao' },
      });
    const accepted = await accept();
    expect(Me.parse(accepted.json())).toMatchObject({
      person: { id: imported.personId, displayName: 'Asha R. Rao', status: 'ACTIVE' },
      memberships: [{ role: 'OWNER', clientId: seeded.clientId }],
    });
    expect((await accept()).statusCode).toBe(404);
    expect((await login('new.owner@example.com')).statusCode).toBe(200);

    const events = await rows(`SELECT type FROM domain_event WHERE firm_id = $1`, [seeded.firmId]);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['person.invited', 'person.claimed', 'membership.changed']),
    );
    // An owner sets up no MFA while accepting, so nothing says it did.
    expect(events.map((e) => e.type)).not.toContain('person.mfa_enrolled');
    const audit = await rows(
      `SELECT action, entity_type FROM audit_event WHERE firm_id = $1 AND entity_id <> $2`,
      [seeded.firmId, ca.personId],
    );
    expect(audit).toEqual(
      expect.arrayContaining([
        { action: 'UPDATE', entity_type: 'person' },
        { action: 'MEMBERSHIP_CHANGE', entity_type: 'membership' },
      ]),
    );
  });

  it('invites a new person by name, refuses a taken email and revokes', async () => {
    const seeded = await firmWithClient();
    const ca = await person(seeded, { role: 'CLIENT_ADMIN' });
    const headers = sessionHeaders(await login(ca.email));
    const invite = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/invites',
        headers,
        payload: {
          role: 'APPROVER',
          clientId: seeded.clientId,
          consultantClientIds: null,
          unitIds: null,
          expiresAt: null,
          ...payload,
        },
      });
    const created = Invite.parse(
      (await invite({ displayName: 'Ravi Kumar', email: 'ravi@example.com' })).json(),
    );
    expect(
      await rows(`SELECT display_name, status, email FROM person WHERE id = $1`, [
        created.personId,
      ]),
    ).toEqual([{ display_name: 'Ravi Kumar', status: 'INVITED', email: 'ravi@example.com' }]);
    const taken = await invite({ displayName: 'Someone', email: ca.email.toUpperCase() });
    expect(ApiErrorResponse.parse(taken.json()).error).toMatchObject({
      code: 'DUPLICATE',
      details: { field: 'email', existingId: ca.personId },
    });

    const revoke = () =>
      app.inject({ method: 'POST', url: `/api/v1/invites/${created.id}/revoke`, headers });
    const revoked = await revoke();
    expect(Invite.parse(revoked.json()).status).toBe('REVOKED');
    expect(errorCode(await revoke())).toBe('INVALID_TRANSITION');

    const other = await firmWithClient();
    const stranger = await person(other, { role: 'CLIENT_ADMIN' });
    const elsewhere = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/${created.id}/revoke`,
      headers: sessionHeaders(await login(stranger.email)),
    });
    expect(elsewhere.statusCode).toBe(404);
  });

  it("counts only an owner's units and leaves archived clients out of Me", async () => {
    const seeded = await firmWithClient();
    const ctx = systemContext(seeded.firmId, 'seed');
    const { personId, email } = await db.withTenant(ctx, async (tx) => {
      const company = await companies.create(tx, {
        clientId: seeded.clientId,
        name: 'Kestrel Aluminium',
      });
      const location = await locations.create(tx, {
        country: 'India',
        countryCode: 'IN',
        state: 'West Bengal',
        stateCode: 'WB',
        city: 'Northfield',
      });
      const plant = await units.create(tx, {
        clientId: seeded.clientId,
        companyId: company.id,
        name: 'Northfield Plant',
        locationId: location.id,
      });
      await units.create(tx, {
        clientId: seeded.clientId,
        companyId: company.id,
        name: 'Southmoor Plant',
        locationId: location.id,
      });
      const archived = await clients.create(tx, {
        name: 'Osprey Holdings',
        settings: DEFAULT_CLIENT_SETTINGS,
      });
      await clients.archive(tx, archived.id, archived.version);
      const owner = await people.create(tx, {
        displayName: 'Meera Iyer',
        nameNormalized: 'meera iyer',
        email: `${randomUUID().slice(0, 8)}@example.com`,
        status: 'ACTIVE',
      });
      for (const clientId of [seeded.clientId, archived.id]) {
        await memberships.create(tx, {
          personId: owner.id,
          role: 'OWNER',
          clientId,
          consultantClientIds: null,
          unitIds: clientId === seeded.clientId ? [plant.id] : null,
          expiresAt: null,
        });
      }
      await credentials.setPassword(tx, owner.id, await hashPassword(PASSWORD));
      return { personId: owner.id, email: owner.email! };
    });
    const res = await login(email);
    expect(res.statusCode).toBe(200);
    const me = Me.parse(res.json());
    expect(me.person.id).toBe(personId);
    expect(me.clients.map((c) => [c.id, c.unitCount])).toEqual([[seeded.clientId, 1]]);
  });

  it('answers unknown people, tokens and invites with nothing', async () => {
    const seeded = await firmWithClient();
    const unknown = randomUUID();
    expect(await store.loadPrincipal(seeded.firmId, unknown)).toBeNull();
    expect(await store.findInvitee(seeded.firmId, unknown, now)).toBeNull();
    expect(await store.clientTimeZone(seeded.firmId, seeded.clientId)).toBe('Asia/Kolkata');
    expect(await store.clientTimeZone(seeded.firmId, unknown)).toBeNull();
    expect(await store.findLoginToken('0'.repeat(64))).toBeNull();
    await expect(
      store.revokeInvite(seeded.firmId, unknown, unknown, 'unknown-invite', now),
    ).resolves.toBeUndefined();
    expect(
      await store.acceptInvite({
        firmId: seeded.firmId,
        inviteId: unknown,
        tokenId: unknown,
        passwordHash: await hashPassword(PASSWORD),
        displayName: null,
        mfa: null,
        requestId: 'unknown-invite',
        now,
      }),
    ).toBe(false);
  });

  it('invites a consultant at firm level, named by email until they accept', async () => {
    const seeded = await firmWithClient();
    const fa = await person(seeded, { role: 'FIRM_ADMIN' });
    const created = await store.createInvite({
      firmId: seeded.firmId,
      personId: null,
      displayName: null,
      email: 'consultant@example.com',
      grant: {
        role: 'CONSULTANT',
        clientId: null,
        consultantClientIds: [seeded.clientId],
        unitIds: null,
        expiresAt: null,
      },
      invitedById: fa.personId,
      linkExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      requestId: 'firm-invite',
      now,
    });
    expect(created).toMatchObject({
      displayName: 'consultant@example.com',
      clientName: null,
      status: 'PENDING',
    });
    const { token } = await service.issueLoginToken({
      firmId: seeded.firmId,
      personId: created.personId,
      kind: 'INVITE',
      inviteId: created.id,
    });
    const stored = await store.findLoginToken(hashToken(token));
    expect(
      await store.acceptInvite({
        firmId: seeded.firmId,
        inviteId: created.id,
        tokenId: stored!.id,
        passwordHash: await hashPassword(PASSWORD),
        displayName: null,
        mfa: null,
        requestId: 'firm-invite',
        now,
      }),
    ).toBe(true);
    expect(await store.findInvite(seeded.firmId, created.id)).toMatchObject({
      status: 'ACCEPTED',
      clientName: null,
    });
  });

  it('reads the account, and refuses sign-in once the account is suspended', async () => {
    const seeded = await firmWithClient();
    const ca = await person(seeded, { role: 'CLIENT_ADMIN' });
    expect(await store.account(seeded.firmId)).toMatchObject({
      id: seeded.firmId,
      kind: 'CONSULTANCY',
      status: 'ACTIVE',
      usage: { users: 1 },
    });
    const res = await login(ca.email);
    expect(Me.parse(res.json()).account).toEqual({
      kind: 'CONSULTANCY',
      status: 'ACTIVE',
      trialEndsOn: null,
    });
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [seeded.firmId]);
      await client.query(`UPDATE firm SET status = 'SUSPENDED' WHERE id = $1`, [seeded.firmId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const again = await app.inject({ url: '/api/v1/me', headers: sessionHeaders(res) });
    expect(errorCode(again)).toBe('ACCOUNT_SUSPENDED');
    expect(errorCode(await login(ca.email))).toBe('ACCOUNT_SUSPENDED');
  });

  it('holds a seat per invite: a new person past the user limit is refused, a counted one is re-invited', async () => {
    const seeded = await firmWithClient();
    const fa = await person(seeded, { role: 'FIRM_ADMIN' });
    const newInvite = (personId: string | null, email: string) =>
      store.createInvite({
        firmId: seeded.firmId,
        personId,
        displayName: personId === null ? 'Dev Iyer' : null,
        email,
        grant: {
          role: 'OWNER',
          clientId: seeded.clientId,
          consultantClientIds: null,
          unitIds: null,
          expiresAt: null,
        },
        invitedById: fa.personId,
        linkExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        requestId: 'seat-invite',
        now,
      });
    await rows(`INSERT INTO platform.account_override (account_id, limits) VALUES ($1, $2)`, [
      seeded.firmId,
      { users: 2 },
    ]);
    const dev = await newInvite(null, 'dev.iyer@kestrel-metals.example');
    expect((await store.account(seeded.firmId))!.usage.users).toBe(2);
    // Dev's open invite already holds a seat, so re-inviting Dev at the limit takes no other.
    expect((await newInvite(dev.personId, dev.email)).status).toBe('PENDING');
    const refused = await newInvite(null, 'meera.nair@kestrel-metals.example').catch(
      (e: unknown) => e,
    );
    expect(refused).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      details: { limit: 'users', max: 2, used: 2 },
    });
    // The refused invite changed nothing: no person was created for it.
    expect(
      await rows(`SELECT count(*)::int AS n FROM person WHERE firm_id = $1`, [seeded.firmId]),
    ).toEqual([{ n: 2 }]);
  });

  it('queues simultaneous invites on the usage lock, so only one takes the last seat', async () => {
    const seeded = await firmWithClient();
    const fa = await person(seeded, { role: 'FIRM_ADMIN' });
    await rows(`INSERT INTO platform.account_override (account_id, limits) VALUES ($1, $2)`, [
      seeded.firmId,
      { users: 2 },
    ]);
    const invite = (email: string) =>
      store.createInvite({
        firmId: seeded.firmId,
        personId: null,
        displayName: 'Dev Iyer',
        email,
        grant: {
          role: 'OWNER',
          clientId: seeded.clientId,
          consultantClientIds: null,
          unitIds: null,
          expiresAt: null,
        },
        invitedById: fa.personId,
        linkExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        requestId: 'seat-race',
        now,
      });
    // Hold the account's usage lock, start both invites, and see both queue behind it before letting them go.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.withTenant(systemContext(seeded.firmId, 'seat-holder'), async (tx) => {
      await account.lockUsage(tx);
      locked();
      await held;
    });
    await lockTaken;
    const racing = Promise.allSettled([
      invite('dev.iyer@kestrel-metals.example'),
      invite('meera.nair@kestrel-metals.example'),
    ]);
    const waiting = async () =>
      (
        await rows(
          `SELECT count(*)::int AS n FROM pg_locks
           WHERE locktype = 'advisory' AND NOT granted
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
          [],
        )
      )[0]!.n as number;
    for (let i = 0; i < 200 && (await waiting()) < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await waiting()).toBe(2);
    release();
    await holder;
    const results = await racing;
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected')!;
    expect(refused.reason).toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
    expect((await store.account(seeded.firmId))!.usage.users).toBe(2);
  });

  it("waits for the library copy before the owner's invite opens a new account", async () => {
    const operator = createOperatorDatabase({ connectionString: owner.options.connectionString! });
    try {
      const created = await operator.withOperator('create', (tx) =>
        platformAccounts.create(tx, {
          name: 'Osprey Textiles Group',
          kind: 'ENTERPRISE',
          planCode: 'BUSINESS',
          trialEndsOn: '2036-11-11',
          settings: DEFAULT_FIRM_SETTINGS,
          profile: {
            legalName: 'Osprey Textiles Group Private Limited',
            gstin: null,
            timeZone: 'Asia/Kolkata',
            fyStartMonth: 4,
          },
          client: { name: 'Osprey Textiles Group', settings: DEFAULT_CLIENT_SETTINGS },
          owner: { displayName: 'Meera Iyer', email: 'meera.iyer@osprey-textiles.example' },
          inviteExpiresAt: '2099-01-01T00:00:00.000Z',
          operatorId: randomUUID(),
          requestId: 'create',
        }),
      );
      expect(await store.libraryCopied(created.accountId)).toBe(false);
      const { token } = await service.issueLoginToken({
        firmId: created.accountId,
        personId: created.ownerId,
        kind: 'INVITE',
        inviteId: created.inviteId,
      });
      // The owner is a FIRM_ADMIN, so they set up MFA while accepting (docs/security/review.md F14).
      const enroll = await app.inject({
        method: 'POST',
        url: `/api/v1/invites/${token}/mfa/enroll`,
      });
      expect(enroll.statusCode, enroll.body).toBe(200);
      const secret = new URL(MfaEnrollment.parse(enroll.json()).otpauthUrl).searchParams.get(
        'secret',
      )!;
      const mfaCode = hotp(base32Decode(secret), totpStep(now));
      const accept = () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/invites/${token}/accept`,
          payload: { password: PASSWORD, mfaCode },
        });
      const early = await accept();
      expect(errorCode(early)).toBe('ACCOUNT_SUSPENDED');
      expect(ApiErrorResponse.parse(early.json()).error.details).toEqual({
        status: 'PROVISIONING',
      });
      expect(await store.account(created.accountId)).toMatchObject({ status: 'PROVISIONING' });

      await db.withTenant(systemContext(created.accountId, 'copy'), (tx) =>
        accountJobs.markLibraryCopied(tx),
      );
      expect(await store.libraryCopied(created.accountId)).toBe(true);
      // The refused accept left the setup open; the enrolment commits with the accept that opens the account.
      expect((await store.getMfa(created.accountId, created.ownerId))?.enrolledAt).toBeNull();
      const opened = await accept();
      expect(opened.statusCode, opened.body).toBe(200);
      expect(await store.account(created.accountId)).toMatchObject({ status: 'TRIAL' });
      expect((await store.getMfa(created.accountId, created.ownerId))?.enrolledAt).toBe(
        now.toISOString(),
      );
    } finally {
      await operator.close();
    }
  });

  it('opens a support session from a console token, and ends it with the grant', async () => {
    const seeded = await firmWithClient();
    const fa = await person(seeded, { role: 'FIRM_ADMIN' });
    // The token's life is judged against the database clock, so this test runs on real time.
    const saved = now;
    now = new Date();
    const operator = createOperatorDatabase({ connectionString: owner.options.connectionString! });
    try {
      const { grant } = await db.withTenant(systemContext(seeded.firmId, 'grant'), (tx) =>
        supportGrants.create(tx, {
          level: 'ADMIN',
          days: 7,
          grantedById: fa.personId,
          now: now.toISOString(),
        }),
      );
      const token = randomBytes(32).toString('base64url');
      await operator.withOperator('console', (tx) =>
        platformSupport.issueToken(tx, {
          accountId: seeded.firmId,
          grantId: grant.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        }),
      );
      address += 1;
      const res = await app.inject({
        remoteAddress: `10.9.200.${address % 250}`,
        method: 'POST',
        url: '/api/v1/auth/support/verify',
        payload: { token },
      });
      expect(res.statusCode).toBe(200);
      const me = Me.parse(res.json());
      expect(me).toMatchObject({
        person: { id: grant.supportPersonId, support: true },
        mfa: { satisfied: true },
      });
      expect(Date.parse(me.session!.expiresAt) - now.getTime()).toBeLessThanOrEqual(2 * 3_600_000);
      const headers = sessionHeaders(res);
      expect((await app.inject({ url: '/api/v1/me', headers })).statusCode).toBe(200);
      await db.withTenant(systemContext(seeded.firmId, 'revoke'), (tx) =>
        supportGrants.revoke(tx, grant.id, fa.personId, new Date().toISOString()),
      );
      expect(errorCode(await app.inject({ url: '/api/v1/me', headers }))).toBe('UNAUTHENTICATED');
      expect(await store.findLoginCandidates('support@planetpulse.life')).toEqual([]);
    } finally {
      now = saved;
      await operator.close();
    }
  });
});
