import { randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_FIRM_SETTINGS } from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOperatorDatabase,
  type OperatorDatabase,
  type OperatorTx,
  type TenantTx,
} from '../src/database.js';
import { DbError } from '../src/errors.js';
import * as r from '../src/repositories/index.js';
import * as s from '../src/schema/index.js';
import { systemContext, type TenantContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { populateFirm, type PopulatedFirm } from './support/populate.js';

/**
 * The operator's own storage (ADR M15-0001 decisions 5-9, 12; ADR M3-0003): operators, credentials and
 * sessions, plans and overrides, subscriptions and renewals, usage snapshots, the operator audit, the owner invite
 * resend and the M9 account jobs.
 */

let t: TestDatabase;
let op: OperatorDatabase;
let a: PopulatedFirm;

const hash = () => randomBytes(32).toString('hex');
const PASSWORD = 'scrypt$32768$8$1$salt$operator';
const SECRET = 'v1.aaaa.bbbb.cccc';
const NOW = '2026-10-24T08:00:00.000Z';
const LATER = '2026-10-24T09:00:00.000Z';

const asOperator = <T>(fn: (tx: OperatorTx) => Promise<T>) => op.withOperator('platform-test', fn);
const inFirm = <T>(firmId: string, fn: (tx: TenantTx) => Promise<T>) =>
  t.db.withTenant(systemContext(firmId, 'platform-test'), fn);

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return e instanceof DbError ? e.code : String(e);
  }
  return 'resolved';
}

const newAccount = (over: Partial<r.NewAccount> = {}): r.NewAccount => ({
  name: 'Kestrel Metals Group',
  kind: 'ENTERPRISE',
  planCode: 'BUSINESS',
  trialEndsOn: '2026-11-23',
  settings: DEFAULT_FIRM_SETTINGS,
  profile: {
    legalName: 'Kestrel Metals Group Private Limited',
    gstin: null,
    timeZone: 'Asia/Kolkata',
    fyStartMonth: 4,
  },
  client: { name: 'Kestrel Metals Group', settings: DEFAULT_CLIENT_SETTINGS },
  owner: { displayName: 'Asha Rao', email: 'asha.rao@kestrel-metals.example' },
  inviteExpiresAt: '2099-01-01T00:00:00.000Z',
  operatorId: '01920000-0000-7000-8000-0000000000aa',
  requestId: 'platform-test',
  ...over,
});

let operator: Awaited<ReturnType<typeof r.operators.create>>;

beforeAll(async () => {
  t = await createTestDatabase();
  op = createOperatorDatabase({ connectionString: t.url, max: 2 });
  a = await populateFirm(t.db, await t.admin.createFirm({ name: 'Demo Advisory' }), 'a');
  operator = await asOperator((tx) =>
    r.operators.create(tx, {
      email: 'Shyam.Ops@planetpulse.life',
      displayName: 'PlanetPulse operator',
      passwordHash: PASSWORD,
      mfaSealedSecret: SECRET,
    }),
  );
}, 60_000);

afterAll(async () => {
  await op?.close();
  await t?.drop();
});

describe('operators', () => {
  it('finds an operator for sign-in by email, ignoring case', async () => {
    const found = await asOperator((tx) =>
      r.operators.findForLogin(tx, 'shyam.ops@PLANETPULSE.life'),
    );
    expect(found).toEqual({
      operator,
      passwordHash: PASSWORD,
      mfaSealedSecret: SECRET,
      mfaLastStep: null,
      failedAttempts: 0,
      lockedUntil: null,
    });
    expect(await asOperator((tx) => r.operators.findForLogin(tx, 'nobody@planetpulse.life'))).toBe(
      null,
    );
    expect(await asOperator((tx) => r.operators.get(tx, operator.id))).toEqual(operator);
    expect(await asOperator((tx) => r.operators.list(tx))).toEqual([operator]);
  });

  it('refuses a second operator with the same email in any case', async () => {
    expect(
      await code(
        asOperator((tx) =>
          r.operators.create(tx, {
            email: 'shyam.ops@planetpulse.life',
            displayName: 'Copy',
            passwordHash: PASSWORD,
            mfaSealedSecret: SECRET,
          }),
        ),
      ),
    ).toBe('DUPLICATE');
  });

  it('locks sign-in on the fifth failure in a row, and a password reset clears it', async () => {
    const lockout = { attempts: 5, minutes: 15 };
    for (let i = 0; i < 4; i++) {
      expect(
        await asOperator((tx) => r.operators.recordFailure(tx, operator.id, NOW, lockout)),
      ).toEqual({ lockedUntil: null });
    }
    expect(
      await asOperator((tx) => r.operators.recordFailure(tx, operator.id, NOW, lockout)),
    ).toEqual({ lockedUntil: '2026-10-24T08:15:00.000Z' });
    let found = await asOperator((tx) => r.operators.findForLogin(tx, operator.email));
    expect(found).toMatchObject({ failedAttempts: 0, lockedUntil: '2026-10-24T08:15:00.000Z' });
    await asOperator((tx) => r.operators.recordFailure(tx, operator.id, NOW, lockout));
    await asOperator((tx) => r.operators.resetFailures(tx, operator.id));
    found = await asOperator((tx) => r.operators.findForLogin(tx, operator.email));
    expect(found).toMatchObject({ failedAttempts: 0 });
    await asOperator((tx) =>
      r.operators.setPassword(tx, operator.id, 'scrypt$32768$8$1$salt$second'),
    );
    found = await asOperator((tx) => r.operators.findForLogin(tx, operator.email));
    expect(found).toMatchObject({
      passwordHash: 'scrypt$32768$8$1$salt$second',
      failedAttempts: 0,
      lockedUntil: null,
    });
    expect(await code(asOperator((tx) => r.operators.setPassword(tx, operator.id, 'plain')))).toBe(
      'VALIDATION',
    );
  });

  it('accepts each TOTP step once, and re-enrolment starts the steps again', async () => {
    expect(await asOperator((tx) => r.operators.acceptMfaStep(tx, operator.id, 100))).toBe(true);
    expect(await asOperator((tx) => r.operators.acceptMfaStep(tx, operator.id, 100))).toBe(false);
    expect(await asOperator((tx) => r.operators.acceptMfaStep(tx, operator.id, 99))).toBe(false);
    expect(await asOperator((tx) => r.operators.acceptMfaStep(tx, operator.id, 101))).toBe(true);
    await asOperator((tx) => r.operators.setMfa(tx, operator.id, 'v1.dddd.eeee.ffff'));
    expect(await asOperator((tx) => r.operators.findForLogin(tx, operator.email))).toMatchObject({
      mfaSealedSecret: 'v1.dddd.eeee.ffff',
      mfaLastStep: null,
    });
    expect(await asOperator((tx) => r.operators.acceptMfaStep(tx, operator.id, 50))).toBe(true);
  });
});

describe('operator sessions', () => {
  const open = (tokenHash: string, expiresAt = '2026-10-24T20:00:00.000Z') =>
    asOperator((tx) =>
      r.operatorSessions.create(tx, {
        operatorId: operator.id,
        tokenHash,
        csrfToken: 'csrf-token-of-sixteen',
        expiresAt,
        ip: '203.0.113.7',
        createdAt: NOW,
      }),
    );

  it('finds an open session by its token hash, until it expires or is revoked', async () => {
    const token = hash();
    const session = await open(token);
    expect(session).toEqual({
      id: expect.any(String),
      operatorId: operator.id,
      csrfToken: 'csrf-token-of-sixteen',
      createdAt: NOW,
      lastSeenAt: NOW,
      expiresAt: '2026-10-24T20:00:00.000Z',
    });
    const found = await asOperator((tx) => r.operatorSessions.find(tx, token, LATER));
    expect(found).toEqual({ session, operator: expect.objectContaining({ id: operator.id }) });
    await asOperator((tx) => r.operatorSessions.touch(tx, session.id, LATER));
    expect(
      (await asOperator((tx) => r.operatorSessions.find(tx, token, LATER)))?.session.lastSeenAt,
    ).toBe(LATER);
    expect(
      await asOperator((tx) => r.operatorSessions.find(tx, token, '2026-10-24T20:00:00.000Z')),
    ).toBe(null);
    expect(await asOperator((tx) => r.operatorSessions.revoke(tx, session.id, LATER))).toBe(true);
    expect(await asOperator((tx) => r.operatorSessions.revoke(tx, session.id, LATER))).toBe(false);
    expect(await asOperator((tx) => r.operatorSessions.find(tx, token, LATER))).toBe(null);
  });

  it('ends every session of a disabled operator, who is then never found', async () => {
    const second = await asOperator((tx) =>
      r.operators.create(tx, {
        email: 'second.ops@planetpulse.life',
        displayName: 'Second operator',
        passwordHash: PASSWORD,
        mfaSealedSecret: SECRET,
      }),
    );
    const token = hash();
    await asOperator((tx) =>
      r.operatorSessions.create(tx, {
        operatorId: second.id,
        tokenHash: token,
        csrfToken: 'csrf-token-of-sixteen',
        expiresAt: '2099-01-01T00:00:00.000Z',
        ip: null,
      }),
    );
    expect(await asOperator((tx) => r.operators.disable(tx, second.id, LATER))).toBe(true);
    expect(await asOperator((tx) => r.operators.disable(tx, second.id, LATER))).toBe(false);
    expect(await asOperator((tx) => r.operatorSessions.find(tx, token, LATER))).toBe(null);
    const { rows } = await t.ownerQuery<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked FROM platform.operator_session WHERE operator_id = $1`,
      [second.id],
    );
    expect(rows).toEqual([{ revoked: true }]);
  });

  it('refuses a token that is not a SHA-256 hash', async () => {
    expect(await code(open('not-a-hash'))).toBe('VALIDATION');
  });
});

describe('plans and overrides', () => {
  it('lists the seeded plans and creates, retires and restores one', async () => {
    const codes = (await asOperator((tx) => r.plans.list(tx))).map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['BUSINESS', 'CONSULTANCY']));
    const change = {
      name: 'Pilot',
      limits: { companies: 1, units: 2, users: 5, storageBytes: 1_000_000 },
      features: ['importer'],
      retired: false,
    };
    const created = await asOperator((tx) => r.plans.upsert(tx, 'PILOT', change, NOW));
    expect(created).toEqual({
      before: null,
      after: {
        code: 'PILOT',
        name: 'Pilot',
        limits: change.limits,
        features: ['importer'],
        retiredAt: null,
      },
    });
    const retired = await asOperator((tx) =>
      r.plans.upsert(tx, 'PILOT', { ...change, retired: true }, NOW),
    );
    expect(retired.after.retiredAt).toBe(NOW);
    // Retiring again keeps the first retirement time.
    const again = await asOperator((tx) =>
      r.plans.upsert(tx, 'PILOT', { ...change, retired: true }, LATER),
    );
    expect(again.after.retiredAt).toBe(NOW);
    const restored = await asOperator((tx) => r.plans.upsert(tx, 'PILOT', change, LATER));
    expect(restored.before?.retiredAt).toBe(NOW);
    expect(restored.after.retiredAt).toBe(null);
    expect(await code(asOperator((tx) => r.plans.upsert(tx, 'pilot', change, NOW)))).toBe(
      'VALIDATION',
    );
  });

  it('overlays an account override on its plan', async () => {
    expect(await asOperator((tx) => r.accountOverrides.get(tx, a.firmId))).toBe(null);
    const first = await asOperator((tx) =>
      r.accountOverrides.put(tx, a.firmId, {
        limits: { users: 40 },
        features: ['earlyAccess'],
        note: 'Pilot extension',
      }),
    );
    expect(first.before).toBe(null);
    const second = await asOperator((tx) =>
      r.accountOverrides.put(tx, a.firmId, { limits: { users: 45 }, features: [], note: null }),
    );
    expect(second.before).toEqual(first.after);
    expect(second.after).toEqual({
      limits: { users: 45 },
      features: [],
      removedFeatures: [],
      note: null,
    });
    const entitlements = await asOperator((tx) => r.platformAccounts.entitlements(tx, a.firmId));
    expect(entitlements.limits.users).toBe(45);
    const { rows } = await t.ownerQuery<{ version: number }>(
      `SELECT version FROM platform.account_override WHERE account_id = $1`,
      [a.firmId],
    );
    expect(rows).toEqual([{ version: 2 }]);
  });
});

describe('subscriptions and renewals', () => {
  let trial: string;

  beforeAll(async () => {
    trial = await asOperator(async (tx) => {
      const created = await r.platformAccounts.create(
        tx,
        newAccount({ name: 'Osprey Textiles Group', trialEndsOn: '2026-11-05' }),
      );
      await r.platformAccounts.update(tx, created.accountId, 1, { status: 'TRIAL' });
      return created.accountId;
    });
  });

  it('records billing periods and lists them latest first', async () => {
    const record = (startsOn: string, endsOn: string) =>
      asOperator((tx) =>
        r.subscriptions.record(tx, {
          accountId: a.firmId,
          planCode: 'CONSULTANCY',
          startsOn,
          endsOn,
          amountPaise: 1_200_000_00,
          invoiceNumber: 'PP-2026-001',
          paidOn: startsOn,
          recordedById: operator.id,
        }),
      );
    const first = await record('2025-11-01', '2026-10-31');
    const second = await record('2026-11-01', '2026-11-20');
    expect(second).toMatchObject({
      accountId: a.firmId,
      endsOn: '2026-11-20',
      recordedAt: expect.any(String),
    });
    expect((await asOperator((tx) => r.subscriptions.list(tx, a.firmId))).map((x) => x.id)).toEqual(
      [second.id, first.id],
    );
    expect(await code(record('2026-12-01', '2026-11-01'))).toBe('VALIDATION');
  });

  it('lists the latest subscriptions and trials ending in the window, soonest first', async () => {
    const due = await asOperator((tx) => r.subscriptions.renewals(tx, '2026-10-24', 30));
    expect(due).toEqual([
      {
        accountId: trial,
        name: 'Osprey Textiles Group',
        status: 'TRIAL',
        planCode: 'BUSINESS',
        endsOn: '2026-11-05',
        kind: 'TRIAL',
      },
      {
        accountId: a.firmId,
        name: 'Demo Advisory',
        status: 'ACTIVE',
        planCode: 'CONSULTANCY',
        endsOn: '2026-11-20',
        kind: 'SUBSCRIPTION',
      },
    ]);
    // The earlier period ending 2026-10-31 is not the latest, so it never shows.
    expect(await asOperator((tx) => r.subscriptions.renewals(tx, '2026-10-24', 12))).toEqual([
      expect.objectContaining({ accountId: trial }),
    ]);
  });

  it('tells the account itself only its own latest subscription’s last day', async () => {
    expect(await inFirm(a.firmId, (tx) => r.accountJobs.subscriptionEndsOn(tx))).toBe('2026-11-20');
    // A trial account with no subscription, and another account's context, see no date of a's.
    expect(await inFirm(trial, (tx) => r.accountJobs.subscriptionEndsOn(tx))).toBeNull();
    // Any tenant context of the account may ask, as for app_account(); the table itself stays closed to it.
    const { rows } = await t.db.withTenant(
      { firmId: a.firmId, personId: randomUUID(), clientIds: 'ALL', requestId: 'platform-test' },
      (tx) =>
        tx.execute<{ ends_on: string }>(sql`SELECT app_subscription_ends_on()::text AS ends_on`),
    );
    expect(rows).toEqual([{ ends_on: '2026-11-20' }]);
    const denied = await inFirm(a.firmId, (tx) =>
      tx.execute(sql`SELECT ends_on FROM platform.subscription`),
    ).then(
      () => 'resolved',
      (e: unknown) => String((e as { cause?: { code?: string } }).cause?.code ?? e),
    );
    expect(denied).toBe('42501');
  });
});

describe('usage snapshots', () => {
  it('takes the day’s snapshot in the account’s own context, replacing one already taken', async () => {
    await inFirm(a.firmId, (tx) => r.accountJobs.takeUsageSnapshot(tx, '2026-10-23'));
    await inFirm(a.firmId, (tx) => r.accountJobs.takeUsageSnapshot(tx, '2026-10-24'));
    await inFirm(a.firmId, (tx) => r.accountJobs.takeUsageSnapshot(tx, '2026-10-24'));
    const usage = await asOperator((tx) => r.platformAccounts.usage(tx, a.firmId));
    const snapshots = await asOperator((tx) =>
      r.usageSnapshots.list(tx, a.firmId, '2026-10-24', '2026-10-31'),
    );
    expect(snapshots).toEqual([
      {
        accountId: a.firmId,
        takenOn: '2026-10-24',
        usage: {
          companies: usage.companies,
          units: usage.units,
          users: usage.users,
          storageBytes: usage.storageBytes,
        },
        activeUsers30d: expect.any(Number),
        instances: expect.any(Number),
      },
    ]);
    expect(
      await asOperator((tx) => r.usageSnapshots.list(tx, a.firmId, '2026-10-01', '2026-10-31')),
    ).toHaveLength(2);
  });

  it('refuses a person’s context, which could see only part of the firm', async () => {
    const person: TenantContext = {
      firmId: a.firmId,
      personId: '01920000-0000-7000-8000-0000000000bb',
      clientIds: [a.clientIds[0]],
      requestId: 'platform-test',
    };
    expect(
      await code(
        t.db.withTenant(person, (tx) => r.accountJobs.takeUsageSnapshot(tx, '2026-10-25')),
      ),
    ).toBe('FORBIDDEN');
  });

  it('refuses firm staff, scoped or firm-wide: the jobs run in the system context only (audit of #171, Low 3)', async () => {
    const staff = (clientIds: TenantContext['clientIds']): TenantContext => ({
      firmId: a.firmId,
      personId: '01920000-0000-7000-8000-0000000000bb',
      clientIds,
      firmStaff: true,
      requestId: 'platform-test',
    });
    for (const ctx of [staff([a.clientIds[0]!]), staff('ALL')]) {
      expect(
        await code(
          t.db.withTenant(ctx, (tx) =>
            r.accountJobs.endTrial(tx, '2099-01-01T00:00:00.000Z', 'trial-end'),
          ),
        ),
      ).toBe('FORBIDDEN');
      expect(
        await code(t.db.withTenant(ctx, (tx) => r.accountJobs.takeUsageSnapshot(tx, '2026-10-25'))),
      ).toBe('FORBIDDEN');
      expect(await code(t.db.withTenant(ctx, (tx) => r.accountJobs.markLibraryCopied(tx)))).toBe(
        'FORBIDDEN',
      );
    }
  });
});

describe('the operator audit', () => {
  const entry = (over: Partial<r.NewOperatorAuditEvent> = {}): r.NewOperatorAuditEvent => ({
    operatorId: operator.id,
    action: 'PLAN_CHANGE',
    accountId: a.firmId,
    before: { planCode: 'CONSULTANCY' },
    after: { planCode: 'BUSINESS' },
    reason: 'Upgrade agreed',
    requestId: 'platform-test',
    ip: '203.0.113.7',
    ...over,
  });

  it('appends entries and pages through them newest first, by account and action', async () => {
    const first = await asOperator((tx) => r.operatorAudit.append(tx, entry()));
    expect(first).toMatchObject({
      action: 'PLAN_CHANGE',
      ip: '203.0.113.7',
      at: expect.any(String),
    });
    await asOperator((tx) =>
      r.operatorAudit.append(tx, entry({ action: 'OPERATOR_LOGIN', accountId: null })),
    );
    const third = await asOperator((tx) => r.operatorAudit.append(tx, entry({ reason: null })));
    const page = await asOperator((tx) =>
      r.operatorAudit.query(tx, { accountId: a.firmId, action: 'PLAN_CHANGE', limit: 1 }),
    );
    expect(page.items.map((x) => x.id)).toEqual([third.id]);
    const next = await asOperator((tx) =>
      r.operatorAudit.query(tx, {
        accountId: a.firmId,
        action: 'PLAN_CHANGE',
        limit: 1,
        cursor: page.nextCursor,
      }),
    );
    expect(next).toEqual({ items: [first], nextCursor: null });
    const logins = await asOperator((tx) =>
      r.operatorAudit.query(tx, { action: 'OPERATOR_LOGIN' }),
    );
    expect(logins.items).toHaveLength(1);
    const none = await asOperator((tx) =>
      r.operatorAudit.query(tx, { from: '2099-01-01T00:00:00.000Z' }),
    );
    expect(none.items).toEqual([]);
  });

  it('never takes a person’s name or email', async () => {
    for (const side of ['before', 'after'] as const) {
      expect(
        await code(
          asOperator((tx) =>
            r.operatorAudit.append(
              tx,
              entry({ [side]: { ownerEmail: 'asha.rao@kestrel-metals.example' } }),
            ),
          ),
        ),
      ).toBe('VALIDATION');
      // At any depth, as platform_record_account_event checks (audit of #171, Low 2).
      expect(
        await code(
          asOperator((tx) =>
            r.operatorAudit.append(
              tx,
              entry({ [side]: { owner: { email: 'asha.rao@kestrel-metals.example' } } }),
            ),
          ),
        ),
      ).toBe('VALIDATION');
      expect(
        await code(
          asOperator((tx) =>
            r.operatorAudit.append(
              tx,
              entry({ [side]: { people: [{ displayName: 'Asha Rao' }] } }),
            ),
          ),
        ),
      ).toBe('VALIDATION');
    }
  });
});

describe('the owner invite resend', () => {
  // Checked against the database's now(), so the expiry moves with the clock.
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  it('revokes the owner’s open invite, writes a new one and person.invited', async () => {
    const created = await asOperator((tx) =>
      r.platformAccounts.create(tx, newAccount({ name: 'Kestrel Aluminium' })),
    );
    const inviteId = await asOperator((tx) =>
      r.ownerInvites.resend(tx, {
        accountId: created.accountId,
        expiresAt: inDays(3),
        operatorId: operator.id,
        requestId: 'resend-test',
      }),
    );
    expect(inviteId).not.toBe(created.inviteId);
    const invites = await inFirm(created.accountId, (tx) =>
      tx
        .select({
          id: s.authInvite.id,
          personId: s.authInvite.personId,
          role: s.authInvite.role,
          revoked: sql<boolean>`${s.authInvite.revokedAt} is not null`,
        })
        .from(s.authInvite)
        .orderBy(s.authInvite.createdAt),
    );
    expect(invites).toEqual([
      { id: created.inviteId, personId: created.ownerId, role: 'FIRM_ADMIN', revoked: true },
      { id: inviteId, personId: created.ownerId, role: 'FIRM_ADMIN', revoked: false },
    ]);
    const events = await inFirm(created.accountId, (tx) =>
      tx
        .select({ actor: s.domainEvent.actor, data: s.domainEvent.data })
        .from(s.domainEvent)
        .where(sql`${s.domainEvent.requestId} = 'resend-test'`),
    );
    expect(events).toEqual([
      {
        actor: { kind: 'OPERATOR', operatorId: operator.id },
        data: { personId: created.ownerId, inviteId, role: 'FIRM_ADMIN', clientId: null },
      },
    ]);
  });

  it('only for a PROVISIONING account that exists, with a near expiry', async () => {
    const resend = (accountId: string, expiresAt = inDays(3)) =>
      asOperator((tx) =>
        r.ownerInvites.resend(tx, {
          accountId,
          expiresAt,
          operatorId: operator.id,
          requestId: 'resend-test',
        }),
      );
    expect(await code(resend(a.firmId))).toBe('VALIDATION');
    expect(await code(resend('01920000-0000-7000-8000-0000000000cc'))).toBe('NOT_FOUND');
    expect(await code(resend(a.firmId, '2020-01-01T00:00:00.000Z'))).toBe('VALIDATION');
    const provisioning = await asOperator((tx) =>
      r.platformAccounts.create(tx, newAccount({ name: 'Kestrel Fibres' })),
    );
    expect(await code(resend(provisioning.accountId, inDays(31)))).toBe('VALIDATION');
    expect(await code(resend(provisioning.accountId, '2020-01-01T00:00:00.000Z'))).toBe(
      'VALIDATION',
    );
    expect(await code(resend(provisioning.accountId))).toBe('resolved');
  });
});

describe('the trial end', () => {
  async function trialEnding(trialEndsOn: string, timeZone = 'Asia/Kolkata') {
    return asOperator(async (tx) => {
      const created = await r.platformAccounts.create(
        tx,
        newAccount({
          name: 'Kestrel Fibres',
          trialEndsOn,
          profile: { ...newAccount().profile, timeZone },
        }),
      );
      await r.platformAccounts.update(tx, created.accountId, 1, { status: 'TRIAL' });
      return created.accountId;
    });
  }
  const end = (accountId: string, now: string) =>
    inFirm(accountId, (tx) => r.accountJobs.endTrial(tx, now, 'trial-end'));

  it('suspends the day after trial_ends_on in the account’s time zone, with its trail', async () => {
    const id = await trialEnding('2026-10-23');
    // 2026-10-23T18:00Z is still the 23rd in Kolkata (23:30).
    expect(await end(id, '2026-10-23T18:00:00.000Z')).toBe(false);
    // 18:30Z is midnight in Kolkata: the 24th.
    expect(await end(id, '2026-10-23T18:30:00.000Z')).toBe(true);
    expect(await end(id, '2026-10-23T19:00:00.000Z')).toBe(false);
    expect(await asOperator((tx) => r.platformAccounts.get(tx, id))).toMatchObject({
      status: 'SUSPENDED',
      version: 3,
    });
    const audit = await inFirm(id, (tx) =>
      tx
        .select({ actorKind: s.auditEvent.actorKind, after: s.auditEvent.after })
        .from(s.auditEvent)
        .where(sql`${s.auditEvent.entityType} = 'account'`),
    );
    expect(audit).toEqual([{ actorKind: 'SYSTEM', after: { status: 'SUSPENDED' } }]);
    const events = await inFirm(id, (tx) =>
      tx
        .select({ actor: s.domainEvent.actor, data: s.domainEvent.data })
        .from(s.domainEvent)
        .where(sql`${s.domainEvent.type} = 'account.status_changed'`),
    );
    expect(events).toEqual([
      {
        actor: { kind: 'SYSTEM', job: 'trial-end' },
        data: { accountId: id, from: 'TRIAL', to: 'SUSPENDED' },
      },
    ]);
    const trail = await asOperator((tx) =>
      r.operatorAudit.query(tx, { accountId: id, action: 'ACCOUNT_SUSPEND' }),
    );
    expect(trail.items).toEqual([
      expect.objectContaining({ operatorId: null, reason: 'Trial ended' }),
    ]);
  });

  it('follows the account’s own time zone', async () => {
    const id = await trialEnding('2026-10-23', 'America/New_York');
    // Midnight in Kolkata is still the 23rd in New York.
    expect(await end(id, '2026-10-23T18:30:00.000Z')).toBe(false);
    expect(await end(id, '2026-10-24T04:00:00.000Z')).toBe(true);
  });

  it('leaves an ACTIVE account alone', async () => {
    expect(await end(a.firmId, '2099-01-01T00:00:00.000Z')).toBe(false);
  });
});
