import { randomBytes, randomUUID } from 'node:crypto';
import {
  ApiErrorResponse,
  ClientPeriods,
  DEFAULT_CLIENT_SETTINGS,
  LocalDate,
  Invite,
  InvitePreview,
  Me,
  MfaEnrollment,
  type Role,
} from '@canopy/contracts';
import {
  clients,
  createAdminDatabase,
  createDatabase,
  credentials,
  memberships,
  people,
  systemContext,
  type AdminDatabase,
  type Database,
} from '@canopy/db';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { LOCKOUT } from './accounts.js';
import { createDbAccountStore } from './db-store.js';
import { hashPassword } from './passwords.js';
import { SecretBox } from './secretbox.js';
import { AuthService } from './service.js';
import { base32Decode, hotp, totpStep } from './totp.js';

// The M5 flows against M3's tables and RLS on Postgres 16 (CI `db` job). Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;

const KEY = Buffer.alloc(32, 7).toString('base64');
const PASSWORD = 'a long enough password';
let now = new Date('2026-10-12T04:00:00Z');
const clock = () => now;
// 2026-10-12 in Asia/Kolkata is in Q3 of FY 2026-27; instances due Apr 2025 to Mar 2027 make two FYs available.
const PERIODS = ClientPeriods.parse({
  current: { fy: '2026-27', quarter: 3 },
  availableFys: ['2025-26', '2026-27'],
  availableUntil: '2027-03',
});

describe.skipIf(!url)('database AccountStore', () => {
  let name: string;
  let admin: AdminDatabase;
  let db: Database;
  let owner: pg.Pool;
  let app: FastifyInstance;
  let service: AuthService;
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
    const store = createDbAccountStore(db, {
      generatedRange: async () => ({
        from: LocalDate.parse('2025-04-30'),
        to: LocalDate.parse('2027-03-31'),
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
      clients.create(tx, { name: 'Aditya Birla Group', settings: DEFAULT_CLIENT_SETTINGS }),
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
          name: 'Aditya Birla Group',
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
      clientName: 'Aditya Birla Group',
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
});
