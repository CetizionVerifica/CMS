import { randomBytes } from 'node:crypto';
import { DEFAULT_CLIENT_SETTINGS } from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '../src/database.js';
import { DbError } from '../src/errors.js';
import * as r from '../src/repositories/index.js';
import { systemContext, type TenantContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/**
 * Sign-in storage for M5 (ADR M3-0001): the pre-tenant lookups, and who reaches credentials, sessions,
 * invites and links through RLS. Isolation between firms is also covered table by table in isolation.db.test.ts.
 */

let t: TestDatabase;
let firmA: string;
let firmB: string;
let clientId: string;
let otherClientId: string;
let adminId: string;
let memberId: string;
let inviteeId: string;
let firmBTwinId: string;

const NOW = '2026-10-12T03:00:00.000Z';
const LATER = '2026-10-12T15:00:00.000Z';
// Session rows must expire after their created_at, which is the database clock, so tests use a far expiry.
const SESSION_EXPIRY = '2099-01-01T00:00:00.000Z';
// findLoginToken reports an invite open against the database clock too.
const INVITE_EXPIRY = '2098-01-01T00:00:00.000Z';
const hash = () => randomBytes(32).toString('hex');
const CSRF = 'k'.repeat(43);

const inFirm = <T>(firmId: string, fn: (tx: TenantTx) => Promise<T>) =>
  t.db.withTenant(systemContext(firmId, 'auth-test'), fn);
const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => inFirm(firmA, fn);
/** A client context acting as `personId` (not firm staff). */
const asClientUser = (personId: string | null, clients = [clientId]): TenantContext => ({
  firmId: firmA,
  personId,
  clientIds: clients,
  requestId: 'auth-test',
});
const as = <T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>) => t.db.withTenant(ctx, fn);

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return e instanceof DbError ? e.code : `not a DbError: ${String(e)}`;
  }
  return 'resolved';
}

beforeAll(async () => {
  t = await createTestDatabase();
  firmA = await t.admin.createFirm({ name: 'Demo Advisory' });
  firmB = await t.admin.createFirm({ name: 'Second Ledger Consulting' });
  await inA(async (tx) => {
    const client = await r.clients.create(tx, {
      name: 'Kestrel Metals Group',
      settings: DEFAULT_CLIENT_SETTINGS,
    });
    const other = await r.clients.create(tx, {
      name: 'Osprey Textiles Group',
      settings: DEFAULT_CLIENT_SETTINGS,
    });
    clientId = client.id;
    otherClientId = other.id;
    const admin = await r.people.create(tx, {
      displayName: 'Firm Admin',
      nameNormalized: 'firm admin',
      email: 'admin@demo.example',
      status: 'ACTIVE',
    });
    adminId = admin.id;
    await r.memberships.create(tx, {
      personId: adminId,
      role: 'FIRM_ADMIN',
      clientId: null,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: null,
    });
    const member = await r.people.create(tx, {
      displayName: 'Shared Name',
      nameNormalized: 'shared name',
      email: 'Shared@Example.com',
      status: 'ACTIVE',
    });
    memberId = member.id;
    await r.memberships.create(tx, {
      personId: memberId,
      role: 'CLIENT_ADMIN',
      clientId,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: null,
    });
    const invitee = await r.people.create(tx, {
      displayName: 'Owner 01',
      nameNormalized: 'owner 01',
      email: null,
      status: 'UNCLAIMED',
    });
    inviteeId = invitee.id;
    await r.people.create(tx, {
      displayName: 'Gone',
      nameNormalized: 'gone',
      email: 'gone@example.com',
      status: 'DISABLED',
    });
  });
  firmBTwinId = await inFirm(firmB, async (tx) => {
    const twin = await r.people.create(tx, {
      displayName: 'Shared Name',
      nameNormalized: 'shared name',
      email: 'shared@example.com',
      status: 'INVITED',
    });
    return twin.id;
  });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('login candidates', () => {
  it('finds the email in every firm, case-insensitively, with password and lock', async () => {
    await inA((tx) => r.credentials.setPassword(tx, memberId, 'scrypt$32768$8$1$salt$member'));
    const found = await t.db.findLoginCandidates('  SHARED@example.COM ');
    expect(found.sort((x, y) => x.firmName.localeCompare(y.firmName))).toEqual([
      {
        firmId: firmA,
        personId: memberId,
        firmName: 'Demo Advisory',
        status: 'ACTIVE',
        passwordHash: 'scrypt$32768$8$1$salt$member',
        lockedUntil: null,
        accountStatus: 'ACTIVE',
      },
      {
        firmId: firmB,
        personId: firmBTwinId,
        firmName: 'Second Ledger Consulting',
        status: 'INVITED',
        passwordHash: null,
        lockedUntil: null,
        accountStatus: 'ACTIVE',
      },
    ]);
    expect((await t.db.findLoginCandidates('gone@example.com')).map((c) => c.status)).toEqual([
      'DISABLED',
    ]);
    expect(await t.db.findLoginCandidates('nobody@example.com')).toEqual([]);
  });

  it('leaves out archived people', async () => {
    const id = await inA(async (tx) => {
      const p = await r.people.create(tx, {
        displayName: 'Archived',
        nameNormalized: 'archived',
        email: 'archived@example.com',
        status: 'ACTIVE',
      });
      await r.people.archive(tx, p.id, p.version);
      return p.id;
    });
    expect(id).toBeDefined();
    expect(await t.db.findLoginCandidates('archived@example.com')).toEqual([]);
  });

  it('refuses input that is not an email-sized string or a SHA-256 hex', async () => {
    expect(await code(t.db.findLoginCandidates(''))).toBe('VALIDATION');
    expect(await code(t.db.findSession('not-a-hash'))).toBe('VALIDATION');
    expect(await code(t.db.findLoginToken('A'.repeat(64)))).toBe('VALIDATION');
  });
});

describe('the lookup role', () => {
  it('can read the returned columns only, never the MFA secret', async () => {
    const { rows } = await t.ownerQuery<{ secret: boolean; hash: boolean; csrf: boolean }>(`
      SELECT has_column_privilege('canopy_lookup', 'auth_credential', 'mfa_sealed_secret', 'SELECT') AS secret,
             has_column_privilege('canopy_lookup', 'auth_credential', 'password_hash', 'SELECT') AS hash,
             has_column_privilege('canopy_lookup', 'auth_session', 'csrf_token', 'SELECT') AS csrf`);
    expect(rows).toEqual([{ secret: false, hash: true, csrf: true }]);
  });

  it('runs the lookups for canopy_app only', async () => {
    const { rows } = await t.ownerQuery<{ name: string; app: boolean; public: boolean }>(`
      SELECT p.proname AS name,
             has_function_privilege('canopy_app', p.oid, 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
      FROM pg_proc p WHERE p.proname IN
        ('canopy_login_candidates', 'canopy_find_session', 'canopy_find_login_token', 'canopy_list_firm_ids')
      ORDER BY 1`);
    expect(rows).toEqual(
      [
        'canopy_find_login_token',
        'canopy_find_session',
        'canopy_list_firm_ids',
        'canopy_login_candidates',
      ].map((name) => ({ name, app: true, public: false })),
    );
  });

  it('gives the app role nothing through the lookup policies', async () => {
    const n = await t.ownerTransaction(async (client) => {
      await client.query('SET LOCAL ROLE canopy_app');
      const { rows } = await client.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM auth_session) + (SELECT count(*) FROM person) + (SELECT count(*) FROM firm) AS n`,
      );
      return Number(rows[0]!.n);
    });
    expect(n).toBe(0);
  });
});

describe('credentials', () => {
  it('locks after the set number of failures in a row, and a password resets it', async () => {
    const lockout = { attempts: 3, minutes: 15 };
    const fail = () => inA((tx) => r.credentials.recordFailure(tx, inviteeId, NOW, lockout));
    expect(await fail()).toEqual({ lockedUntil: null });
    expect(await fail()).toEqual({ lockedUntil: null });
    expect(await fail()).toEqual({ lockedUntil: '2026-10-12T03:15:00.000Z' });
    expect(await inA((tx) => r.credentials.get(tx, inviteeId))).toEqual({
      personId: inviteeId,
      passwordHash: null,
      mfaEnrolled: false,
      failedAttempts: 0,
      lockedUntil: '2026-10-12T03:15:00.000Z',
    });
    await fail();
    await inA((tx) => r.credentials.resetFailures(tx, inviteeId));
    expect((await inA((tx) => r.credentials.get(tx, inviteeId)))?.failedAttempts).toBe(0);
    await inA((tx) => r.credentials.setPassword(tx, inviteeId, 'scrypt$32768$8$1$salt$x'));
    expect(await inA((tx) => r.credentials.get(tx, inviteeId))).toMatchObject({
      passwordHash: 'scrypt$32768$8$1$salt$x',
      lockedUntil: null,
    });
    expect(
      await code(
        inA((tx) => r.credentials.recordFailure(tx, inviteeId, NOW, { attempts: 0, minutes: 1 })),
      ),
    ).toBe('VALIDATION');
  });

  it('counts concurrent failures without losing any', async () => {
    const lockout = { attempts: 100, minutes: 1 };
    await Promise.all(
      Array.from({ length: 6 }, () =>
        inA((tx) => r.credentials.recordFailure(tx, adminId, NOW, lockout)),
      ),
    );
    expect((await inA((tx) => r.credentials.get(tx, adminId)))?.failedAttempts).toBe(6);
  });

  it('stores MFA and accepts each time step once, in order', async () => {
    expect(await inA((tx) => r.credentials.getMfa(tx, adminId))).toBeNull();
    expect(await inA((tx) => r.credentials.acceptMfaStep(tx, adminId, 5))).toBe(false);
    await inA((tx) =>
      r.credentials.saveMfa(tx, adminId, {
        sealedSecret: 'v1.iv.tag.sealed',
        enrolledAt: null,
        lastStep: null,
      }),
    );
    expect((await inA((tx) => r.credentials.get(tx, adminId)))?.mfaEnrolled).toBe(false);
    expect(await inA((tx) => r.credentials.acceptMfaStep(tx, adminId, 10))).toBe(true);
    expect(await inA((tx) => r.credentials.acceptMfaStep(tx, adminId, 10))).toBe(false);
    expect(await inA((tx) => r.credentials.acceptMfaStep(tx, adminId, 9))).toBe(false);
    expect(await inA((tx) => r.credentials.acceptMfaStep(tx, adminId, 11))).toBe(true);
    await inA((tx) =>
      r.credentials.saveMfa(tx, adminId, {
        sealedSecret: 'v1.iv.tag.sealed',
        enrolledAt: NOW,
        lastStep: 11,
      }),
    );
    expect(await inA((tx) => r.credentials.getMfa(tx, adminId))).toEqual({
      sealedSecret: 'v1.iv.tag.sealed',
      enrolledAt: NOW,
      lastStep: 11,
    });
    expect((await inA((tx) => r.credentials.get(tx, adminId)))?.mfaEnrolled).toBe(true);
  });

  it('is reachable by its person and firm staff, not by other client users or firms', async () => {
    expect(
      await as(asClientUser(memberId), (tx) => r.credentials.get(tx, memberId)),
    ).not.toBeNull();
    expect(await as(asClientUser(memberId), (tx) => r.credentials.getMfa(tx, adminId))).toBeNull();
    expect(await as(asClientUser(memberId), (tx) => r.credentials.get(tx, adminId))).toBeNull();
    expect(await as(asClientUser(null), (tx) => r.credentials.get(tx, memberId))).toBeNull();
    expect(await inFirm(firmB, (tx) => r.credentials.get(tx, memberId))).toBeNull();
    // A client user cannot set someone else's password; another firm cannot either.
    expect(
      await code(
        as(asClientUser(memberId), (tx) =>
          r.credentials.setPassword(tx, adminId, 'scrypt$32768$8$1$salt$evil'),
        ),
      ),
    ).not.toBe('resolved');
    expect(
      await code(
        inFirm(firmB, (tx) =>
          r.credentials.setPassword(tx, memberId, 'scrypt$32768$8$1$salt$evil'),
        ),
      ),
    ).not.toBe('resolved');
    expect((await inA((tx) => r.credentials.get(tx, memberId)))?.passwordHash).toBe(
      'scrypt$32768$8$1$salt$member',
    );
  });
});

describe('sessions', () => {
  it("takes the caller's clock as created and last seen, so a past clock still passes the expiry check", async () => {
    // NOW and LATER are before the database clock: without createdAt this insert fails the expiry check.
    const input = {
      personId: memberId,
      tokenHash: hash(),
      csrfToken: CSRF,
      mfaSatisfied: false,
      expiresAt: LATER,
      method: 'PASSWORD' as const,
      createdAt: NOW,
    };
    const session = await inA((tx) => r.sessions.create(tx, input));
    expect(session.expiresAt).toBe(LATER);
    const { rows } = await t.ownerQuery<{ created_at: Date; last_seen_at: Date }>(
      'SELECT created_at, last_seen_at FROM auth_session WHERE id = $1',
      [session.id],
    );
    expect(rows).toEqual([{ created_at: new Date(NOW), last_seen_at: new Date(NOW) }]);
    const withoutClock = { ...input, createdAt: undefined, tokenHash: hash() };
    expect(await code(inA((tx) => r.sessions.create(tx, withoutClock)))).not.toBe('resolved');
    for (const createdAt of [LATER, '2026-10-12T16:00:00.000Z', 'yesterday']) {
      expect(
        await code(inA((tx) => r.sessions.create(tx, { ...input, tokenHash: hash(), createdAt }))),
      ).toBe('VALIDATION');
    }
    expect(await inA((tx) => r.sessions.revoke(tx, session.id, LATER))).toBe(true);
  });

  it('stores a session, finds it by hash until revoked, and marks MFA', async () => {
    const tokenHash = hash();
    const session = await as(asClientUser(memberId), (tx) =>
      r.sessions.create(tx, {
        personId: memberId,
        tokenHash,
        csrfToken: CSRF,
        mfaSatisfied: false,
        expiresAt: SESSION_EXPIRY,
        method: 'PASSWORD',
      }),
    );
    expect(session).toEqual({
      id: session.id,
      firmId: firmA,
      personId: memberId,
      csrfToken: CSRF,
      mfaSatisfied: false,
      expiresAt: SESSION_EXPIRY,
    });
    expect(await t.db.findSession(tokenHash)).toEqual({
      ...session,
      accountStatus: 'ACTIVE',
      supportGrantId: null,
    });
    expect(await as(asClientUser(memberId), (tx) => r.sessions.markMfa(tx, session.id))).toBe(true);
    expect((await t.db.findSession(tokenHash))?.mfaSatisfied).toBe(true);
    await inA((tx) => r.sessions.touch(tx, session.id, NOW));
    // Another firm, or another client user, cannot revoke it.
    expect(await inFirm(firmB, (tx) => r.sessions.revoke(tx, session.id, NOW))).toBe(false);
    expect(await as(asClientUser(inviteeId), (tx) => r.sessions.revoke(tx, session.id, NOW))).toBe(
      false,
    );
    expect(await as(asClientUser(memberId), (tx) => r.sessions.revoke(tx, session.id, NOW))).toBe(
      true,
    );
    expect(await as(asClientUser(memberId), (tx) => r.sessions.revoke(tx, session.id, NOW))).toBe(
      false,
    );
    expect(await as(asClientUser(memberId), (tx) => r.sessions.markMfa(tx, session.id))).toBe(
      false,
    );
    expect(await t.db.findSession(tokenHash)).toBeNull();
    expect(await t.db.findSession(hash())).toBeNull();
  });

  it('cannot be created for someone else by a client user, and staff can end all of a person', async () => {
    const make = (ctx: TenantContext, personId: string) =>
      as(ctx, (tx) =>
        r.sessions.create(tx, {
          personId,
          tokenHash: hash(),
          csrfToken: CSRF,
          mfaSatisfied: false,
          expiresAt: SESSION_EXPIRY,
          method: 'MAGIC_LINK',
        }),
      );
    expect(await code(make(asClientUser(memberId), adminId))).not.toBe('resolved');
    expect(await code(make(asClientUser(memberId), memberId))).toBe('resolved');
    await make(systemContext(firmA, 'auth-test'), memberId);
    expect(await inA((tx) => r.sessions.revokeAllForPerson(tx, memberId, NOW))).toBe(2);
    expect(await inA((tx) => r.sessions.revokeAllForPerson(tx, memberId, NOW))).toBe(0);
    expect(
      await code(
        make(asClientUser(memberId), memberId).then(() =>
          inA((tx) =>
            r.sessions.create(tx, {
              personId: memberId,
              tokenHash: 'x',
              csrfToken: CSRF,
              mfaSatisfied: false,
              expiresAt: SESSION_EXPIRY,
              method: 'PASSWORD',
            }),
          ),
        ),
      ),
    ).toBe('VALIDATION');
  });

  it('keeps token hashes unique', async () => {
    const tokenHash = hash();
    const input = {
      personId: adminId,
      tokenHash,
      csrfToken: CSRF,
      mfaSatisfied: false,
      expiresAt: SESSION_EXPIRY,
      method: 'PASSWORD' as const,
    };
    await inA((tx) => r.sessions.create(tx, input));
    expect(await code(inA((tx) => r.sessions.create(tx, input)))).toBe('DUPLICATE');
  });
});

describe('magic links', () => {
  it('finds a link by hash and uses it once, before it expires', async () => {
    const tokenHash = hash();
    const id = await as(asClientUser(memberId), (tx) =>
      r.loginTokens.create(tx, {
        personId: memberId,
        kind: 'MAGIC_LINK',
        inviteId: null,
        tokenHash,
        expiresAt: '2026-10-12T03:15:00.000Z',
      }),
    );
    expect(await t.db.findLoginToken(tokenHash)).toEqual({
      id,
      firmId: firmA,
      personId: memberId,
      kind: 'MAGIC_LINK',
      inviteId: null,
      tokenHash,
      expiresAt: '2026-10-12T03:15:00.000Z',
      usedAt: null,
      inviteOpen: false,
    });
    expect(await inA((tx) => r.loginTokens.consume(tx, id, '2026-10-12T03:15:00.000Z'))).toBe(
      false,
    );
    expect(await inFirm(firmB, (tx) => r.loginTokens.consume(tx, id, NOW))).toBe(false);
    expect(await inA((tx) => r.loginTokens.consume(tx, id, NOW))).toBe(true);
    expect(await inA((tx) => r.loginTokens.consume(tx, id, NOW))).toBe(false);
    expect((await t.db.findLoginToken(tokenHash))?.usedAt).toBe(NOW);
    expect(await t.db.findLoginToken(hash())).toBeNull();
  });

  it('refuses an invite id on a magic link and a magic link shape on an invite token', async () => {
    const base = { personId: memberId, tokenHash: hash(), expiresAt: LATER };
    expect(
      await code(
        inA((tx) => r.loginTokens.create(tx, { ...base, kind: 'MAGIC_LINK', inviteId: adminId })),
      ),
    ).toBe('VALIDATION');
    expect(
      await code(
        inA((tx) => r.loginTokens.create(tx, { ...base, kind: 'INVITE', inviteId: null })),
      ),
    ).toBe('VALIDATION');
  });
});

describe('invites', () => {
  const grant = {
    role: 'OWNER' as const,
    clientId: '',
    consultantClientIds: null,
    unitIds: null,
    expiresAt: null,
  };
  const clientAdmin = () => asClientUser(memberId);

  it('reports an invite past its expiry by the database clock as not open', async () => {
    // Expires after NOW, the request time, but before the database clock (2026-10-13 or later).
    const expiresAt = '2026-10-12T04:00:00.000Z';
    const invitee = await inA((tx) =>
      r.people.create(tx, {
        displayName: 'Owner 03',
        nameNormalized: 'owner 03',
        email: null,
        status: 'UNCLAIMED',
      }),
    );
    const { invite } = await inA((tx) =>
      r.invites.create(
        tx,
        {
          personId: invitee.id,
          email: 'owner03@example.com',
          grant: { ...grant, clientId },
          createdById: memberId,
          expiresAt,
        },
        NOW,
      ),
    );
    const tokenHash = hash();
    await inA((tx) =>
      r.loginTokens.create(tx, {
        personId: invitee.id,
        kind: 'INVITE',
        inviteId: invite.id,
        tokenHash,
        expiresAt: INVITE_EXPIRY,
      }),
    );
    expect((await t.db.findLoginToken(tokenHash))?.inviteOpen).toBe(false);
    // The repository reads take the request time instead, so at NOW the invite is still open.
    expect(
      (await inA((tx) => r.invites.openForPerson(tx, invitee.id, NOW))).map((x) => x.id),
    ).toEqual([invite.id]);
  });

  it('invites a person, replaces an earlier invite, and accepts with a link', async () => {
    const newInvite = (email: string) => ({
      personId: inviteeId,
      email,
      grant: { ...grant, clientId },
      createdById: memberId,
      expiresAt: INVITE_EXPIRY,
    });
    const first = await inA((tx) => r.invites.create(tx, newInvite('owner01@example.com'), NOW));
    expect(first.person).toMatchObject({
      before: { status: 'UNCLAIMED', email: null },
      after: { status: 'INVITED', email: 'owner01@example.com' },
    });
    expect(first.revokedInviteIds).toEqual([]);
    expect(first.invite).toMatchObject({
      firmId: firmA,
      firmName: 'Demo Advisory',
      personId: inviteeId,
      grant: { role: 'OWNER', clientId },
      acceptedAt: null,
      revokedAt: null,
    });
    const firstToken = hash();
    // The invitee has no link to the client yet, so only firm staff see this invite (finding 1 on #39).
    expect(await as(clientAdmin(), (tx) => r.invites.get(tx, first.invite.id))).toBeNull();
    const firstTokenId = await inA((tx) =>
      r.loginTokens.create(tx, {
        personId: inviteeId,
        kind: 'INVITE',
        inviteId: first.invite.id,
        tokenHash: firstToken,
        expiresAt: INVITE_EXPIRY,
      }),
    );
    expect((await t.db.findLoginToken(firstToken))?.inviteOpen).toBe(true);

    const second = await inA((tx) => r.invites.create(tx, newInvite('owner01@example.com'), NOW));
    expect(second.revokedInviteIds).toEqual([first.invite.id]);
    // An invite's link is always for the invited person.
    expect(
      await code(
        inA((tx) =>
          r.loginTokens.create(tx, {
            personId: adminId,
            kind: 'INVITE',
            inviteId: second.invite.id,
            tokenHash: hash(),
            expiresAt: INVITE_EXPIRY,
          }),
        ),
      ),
    ).toBe('NOT_FOUND');
    expect((await t.db.findLoginToken(firstToken))?.inviteOpen).toBe(false);
    // The first invite's link cannot accept the second invite.
    expect(
      await code(
        inA((tx) =>
          r.invites.accept(tx, {
            inviteId: second.invite.id,
            tokenId: firstTokenId,
            passwordHash: 'scrypt$32768$8$1$salt$owner',
            now: NOW,
          }),
        ),
      ),
    ).toBe('NOT_FOUND');

    const tokenHash = hash();
    const tokenId = await inA((tx) =>
      r.loginTokens.create(tx, {
        personId: inviteeId,
        kind: 'INVITE',
        inviteId: second.invite.id,
        tokenHash,
        expiresAt: INVITE_EXPIRY,
      }),
    );
    // Accepting runs as the invitee, the context M5 builds from the link.
    const invitee: TenantContext = {
      firmId: firmA,
      personId: inviteeId,
      clientIds: [],
      requestId: 'auth-test',
    };
    const accepted = await as(systemContext(firmA, 'auth-test'), (tx) =>
      r.invites.accept(tx, {
        inviteId: second.invite.id,
        tokenId,
        passwordHash: 'scrypt$32768$8$1$salt$owner',
        now: NOW,
      }),
    );
    expect(accepted.person.after).toMatchObject({ status: 'ACTIVE', email: 'owner01@example.com' });
    expect(accepted.membership).toMatchObject({ personId: inviteeId, role: 'OWNER', clientId });
    expect(accepted.invite.acceptedAt).toBe(NOW);
    expect(await as(invitee, (tx) => r.credentials.get(tx, inviteeId))).toMatchObject({
      passwordHash: 'scrypt$32768$8$1$salt$owner',
    });
    expect(await t.db.findLoginToken(tokenHash)).toMatchObject({ usedAt: NOW, inviteOpen: false });
    expect(
      await code(
        inA((tx) =>
          r.invites.accept(tx, {
            inviteId: second.invite.id,
            tokenId,
            passwordHash: 'scrypt$32768$8$1$salt$x',
            now: NOW,
          }),
        ),
      ),
    ).toBe('NOT_FOUND');
    expect(await inA((tx) => r.invites.revoke(tx, second.invite.id, NOW))).toBeNull();
  });

  it('keeps invites to the clients a context sees, and revokes open ones', async () => {
    // Owner 02 already works in the other client (an import made them owner there), so its context sees them.
    const person = await inA(async (tx) => {
      const p = await r.people.create(tx, {
        displayName: 'Owner 02',
        nameNormalized: 'owner 02',
        email: null,
        status: 'UNCLAIMED',
      });
      await r.memberships.create(tx, {
        personId: p.id,
        role: 'OWNER',
        clientId: otherClientId,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: null,
      });
      return p;
    });
    const created = await inA((tx) =>
      r.invites.create(
        tx,
        {
          personId: person.id,
          email: 'owner02@example.com',
          grant: { ...grant, clientId: otherClientId },
          createdById: adminId,
          expiresAt: INVITE_EXPIRY,
        },
        NOW,
      ),
    );
    expect(await as(clientAdmin(), (tx) => r.invites.get(tx, created.invite.id))).toBeNull();
    const open = (ctx: () => Promise<r.Invite[]>) => ctx().then((xs) => xs.map((x) => x.id));
    expect(await open(() => inA((tx) => r.invites.openForPerson(tx, person.id, NOW)))).toEqual([
      created.invite.id,
    ]);
    expect(
      await open(() => as(clientAdmin(), (tx) => r.invites.openForPerson(tx, person.id, NOW))),
    ).toEqual([]);
    expect(
      await open(() => inFirm(firmB, (tx) => r.invites.openForPerson(tx, person.id, NOW))),
    ).toEqual([]);
    expect(
      await open(() => inA((tx) => r.invites.openForPerson(tx, person.id, INVITE_EXPIRY))),
    ).toEqual([]);
    expect(await code(inA((tx) => r.invites.openForPerson(tx, 'nope', NOW)))).toBe('VALIDATION');
    expect(
      await as(asClientUser(null, [otherClientId]), (tx) => r.invites.get(tx, created.invite.id)),
    ).not.toBeNull();
    expect(await inFirm(firmB, (tx) => r.invites.get(tx, created.invite.id))).toBeNull();
    expect(
      await as(clientAdmin(), (tx) => r.invites.revoke(tx, created.invite.id, NOW)),
    ).toBeNull();
    expect(await inFirm(firmB, (tx) => r.invites.revoke(tx, created.invite.id, NOW))).toBeNull();
    const revoked = await inA((tx) => r.invites.revoke(tx, created.invite.id, LATER));
    expect(revoked).toMatchObject({ id: created.invite.id, revokedAt: LATER });
    expect(await open(() => inA((tx) => r.invites.openForPerson(tx, person.id, LATER)))).toEqual(
      [],
    );
    expect(await inA((tx) => r.invites.revoke(tx, created.invite.id, LATER))).toBeNull();
    // A client admin cannot invite into a client it does not see.
    expect(
      await code(
        as(clientAdmin(), (tx) =>
          r.invites.create(
            tx,
            {
              personId: inviteeId,
              email: 'owner01@example.com',
              grant: { ...grant, clientId: otherClientId },
              createdById: memberId,
              expiresAt: INVITE_EXPIRY,
            },
            NOW,
          ),
        ),
      ),
    ).not.toBe('resolved');
  });

  it('keeps an active person as is and refuses a different email for them', async () => {
    const input = {
      personId: memberId,
      email: 'shared@example.com',
      grant: { ...grant, clientId: otherClientId },
      createdById: adminId,
      expiresAt: INVITE_EXPIRY,
    };
    const created = await inA((tx) => r.invites.create(tx, input, NOW));
    expect(created.person).toBeNull();
    expect(
      await code(inA((tx) => r.invites.create(tx, { ...input, email: 'other@example.com' }, NOW))),
    ).toBe('VALIDATION');
  });

  it('answers DUPLICATE for an email another person of the firm has', async () => {
    const person = await inA((tx) =>
      r.people.create(tx, {
        displayName: 'Owner 03',
        nameNormalized: 'owner 03',
        email: null,
        status: 'UNCLAIMED',
      }),
    );
    expect(
      await code(
        inA((tx) =>
          r.invites.create(
            tx,
            {
              personId: person.id,
              email: 'admin@demo.example',
              grant: { ...grant, clientId },
              createdById: adminId,
              expiresAt: INVITE_EXPIRY,
            },
            NOW,
          ),
        ),
      ),
    ).toBe('DUPLICATE');
  });
});

describe('audit of #39', () => {
  const pw = (tag: string) => `scrypt$32768$8$1$salt$${tag}`;

  it('finding 1: a client context cannot plant an invite for a firm admin, even with raw SQL', async () => {
    const plant = as(asClientUser(memberId), (tx) =>
      tx.execute(sql`
        INSERT INTO auth_invite (person_id, email, role, client_id, created_by_id, expires_at)
        VALUES (${adminId}, 'admin@demo.example', 'OWNER', ${clientId}, ${memberId}, now() + interval '1 day')`),
    );
    await expect(plant).rejects.toSatisfy((e) => sqlState(e) === '42501');
    // A visible person without a firm role still can be invited by the client context.
    const visible = await as(asClientUser(memberId), (tx) =>
      tx.execute(sql`
        INSERT INTO auth_invite (person_id, email, role, client_id, created_by_id, expires_at)
        VALUES (${memberId}, 'shared@example.com', 'APPROVER', ${clientId}, ${memberId}, now() + interval '1 day')`),
    );
    expect(visible.rowCount).toBe(1);
  });

  it('finding 1: accepting a client invite never sets a firm admin password', async () => {
    const before = (await inA((tx) => r.credentials.get(tx, adminId)))?.passwordHash ?? null;
    const tokenHash = hash();
    const { inviteId, tokenId } = await inA(async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO auth_invite (person_id, email, role, client_id, created_by_id, expires_at)
        VALUES (${adminId}, 'admin@demo.example', 'OWNER', ${clientId}, ${adminId}, now() + interval '1 day')
        RETURNING id`);
      const id = rows[0]!.id;
      const token = await r.loginTokens.create(tx, {
        personId: adminId,
        kind: 'INVITE',
        inviteId: id,
        tokenHash,
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      return { inviteId: id, tokenId: token };
    });
    expect(
      await code(
        inA((tx) =>
          r.invites.accept(tx, { inviteId, tokenId, passwordHash: pw('attacker'), now: NOW }),
        ),
      ),
    ).toBe('FORBIDDEN');
    expect((await inA((tx) => r.credentials.get(tx, adminId)))?.passwordHash ?? null).toBe(before);
    expect((await t.db.findLoginToken(tokenHash))?.usedAt).toBeNull();
  });

  it('finding 2: the pre-tenant lookups answer nothing inside a tenant transaction', async () => {
    const sessionHash = hash();
    await inA((tx) =>
      r.sessions.create(tx, {
        personId: memberId,
        tokenHash: sessionHash,
        csrfToken: CSRF,
        mfaSatisfied: false,
        expiresAt: SESSION_EXPIRY,
        method: 'PASSWORD',
      }),
    );
    expect(await t.db.findSession(sessionHash)).not.toBeNull();
    for (const ctx of [systemContext(firmB, 'auth-test'), systemContext(firmA, 'auth-test')]) {
      const counts = await as(ctx, async (tx) => {
        const n = async (q: ReturnType<typeof sql>) => (await tx.execute(q)).rows.length;
        return [
          await n(sql`SELECT * FROM canopy_login_candidates('shared@example.com')`),
          await n(sql`SELECT * FROM canopy_find_session(${sessionHash})`),
          await n(sql`SELECT * FROM canopy_find_login_token(${sessionHash})`),
        ];
      });
      expect(counts).toEqual([0, 0, 0]);
    }
    // Outside a tenant, after tenant transactions on the same pool, they answer again.
    expect((await t.db.findLoginCandidates('shared@example.com')).length).toBe(2);
  });

  it('finding 3: only scrypt hashes and sealed secrets are stored', async () => {
    expect(await code(inA((tx) => r.credentials.setPassword(tx, adminId, 'hunter2')))).toBe(
      'VALIDATION',
    );
    expect(
      await code(
        inA((tx) =>
          r.credentials.saveMfa(tx, adminId, {
            sealedSecret: 'JBSWY3DP',
            enrolledAt: null,
            lastStep: null,
          }),
        ),
      ),
    ).toBe('VALIDATION');
    for (const set of [sql`password_hash = 'hunter2'`, sql`mfa_sealed_secret = 'JBSWY3DP'`]) {
      await expect(
        inA((tx) =>
          tx.execute(sql`UPDATE auth_credential SET ${set} WHERE person_id = ${adminId}`),
        ),
      ).rejects.toSatisfy((e) => sqlState(e) === '23514');
    }
  });
});

function sqlState(error: unknown): string | undefined {
  let e: unknown = error;
  while (e && typeof e === 'object') {
    if ('code' in e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    e = 'cause' in e ? e.cause : undefined;
  }
  return undefined;
}
