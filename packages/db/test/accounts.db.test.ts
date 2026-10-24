import { randomBytes } from 'node:crypto';
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
import {
  populateAuth,
  populateFirm,
  populateIdempotency,
  populateSupport,
  type PopulatedFirm,
} from './support/populate.js';
import { TABLES } from './support/tables.js';

/**
 * Customer accounts and the operator wall (ADR M15-0001 decisions 2, 4, 8, 10-12; ADR M3-0002): what canopy_operator
 * can and cannot reach, the platform_* functions, the app's own account reads, support grants and support tokens.
 */

let t: TestDatabase;
let op: OperatorDatabase;
let a: PopulatedFirm;
let b: PopulatedFirm;

const OPERATOR_ID = '01920000-0000-7000-8000-0000000000aa';
const hash = () => randomBytes(32).toString('hex');
const soon = () => new Date(Date.now() + 60_000).toISOString();
const NOW = () => new Date().toISOString();

const asOperator = <T>(fn: (tx: OperatorTx) => Promise<T>) => op.withOperator('accounts-test', fn);
const inFirm = <T>(firmId: string, fn: (tx: TenantTx) => Promise<T>) =>
  t.db.withTenant(systemContext(firmId, 'accounts-test'), fn);

function sqlState(error: unknown): string | undefined {
  let e: unknown = error;
  while (e && typeof e === 'object') {
    if ('code' in e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    e = 'cause' in e ? e.cause : undefined;
  }
  return undefined;
}
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof DbError && !sqlState(e)) return e.code;
    return sqlState(e) ?? (e instanceof DbError ? e.code : String(e));
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
  operatorId: OPERATOR_ID,
  requestId: 'accounts-test',
  ...over,
});

beforeAll(async () => {
  t = await createTestDatabase();
  op = createOperatorDatabase({ connectionString: t.url, max: 2 });
  a = await populateFirm(t.db, await t.admin.createFirm({ name: 'Demo Advisory' }), 'a');
  b = await populateFirm(t.db, await t.admin.createFirm({ name: 'Second Ledger Consulting' }), 'b');
  for (const [firm, label] of [
    [a, 'a'],
    [b, 'b'],
  ] as const) {
    await populateAuth(t.db, firm, label);
    await populateIdempotency(t.db, firm, label);
    await populateSupport(t.db, firm, label);
  }
}, 60_000);

afterAll(async () => {
  await op?.close();
  await t?.drop();
});

describe('the operator wall', () => {
  const clientTables = TABLES.map((x) => x.name).filter(
    (n) => n !== 'firm' && n !== 'support_grant',
  );

  it.each(clientTables)('canopy_operator cannot read %s at all', async (table) => {
    expect(
      await failure(asOperator((tx) => tx.execute(sql.raw(`SELECT count(*) FROM "${table}"`)))),
    ).toBe('42501');
  });

  it('reads every account row, but not its settings through a tenant policy', async () => {
    const accounts = await asOperator((tx) => r.platformAccounts.list(tx));
    expect(accounts.map((x) => x.id)).toEqual(expect.arrayContaining([a.firmId, b.firmId]));
    expect(accounts.find((x) => x.id === a.firmId)).toMatchObject({
      kind: 'CONSULTANCY',
      status: 'ACTIVE',
      planCode: 'CONSULTANCY',
    });
  });

  it('reads support grants by their non-personal columns only', async () => {
    const live = await asOperator((tx) => r.platformSupport.live(tx, NOW()));
    expect(live.map((g) => g.accountId).sort()).toEqual([a.firmId, b.firmId].sort());
    const listed = await asOperator((tx) => r.platformSupport.list(tx, a.firmId, NOW()));
    expect(listed).toEqual([expect.objectContaining({ accountId: a.firmId, status: 'ACTIVE' })]);
    expect(Object.keys(listed[0]!).sort()).toEqual(
      ['accountId', 'endsAt', 'id', 'level', 'revokedAt', 'startsAt', 'status'].sort(),
    );
    expect(
      await failure(asOperator((tx) => tx.execute(sql`SELECT granted_by_id FROM support_grant`))),
    ).toBe('42501');
  });

  it('cannot change a firm’s settings, and changes nothing of a DELETED account', async () => {
    expect(
      await failure(
        asOperator((tx) =>
          tx.execute(sql`UPDATE firm SET settings = settings WHERE id = ${a.firmId}`),
        ),
      ),
    ).toBe('42501');
    await t.ownerTransaction(async (client) => {
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [b.firmId]);
      await client.query(`UPDATE firm SET status = 'DELETED' WHERE id = $1`, [b.firmId]);
      await client.query('SET LOCAL ROLE canopy_operator');
      await client.query(`SELECT set_config('app.firm_id', '', true)`);
      const { rowCount } = await client.query(`UPDATE firm SET name = 'Renamed' WHERE id = $1`, [
        b.firmId,
      ]);
      expect(rowCount).toBe(0);
    });
  });

  it('a tenant context does not leak into the operator transaction', async () => {
    const n = await asOperator(async (tx) => {
      const { rows } = await tx.execute<{ id: string | null }>(sql`SELECT app_firm_id() AS id`);
      return rows[0]!.id;
    });
    expect(n).toBeNull();
  });
});

describe('the app role and account columns', () => {
  it('may rename its firm but not change its status, plan or trial', async () => {
    await inFirm(a.firmId, (tx) =>
      tx.execute(sql`UPDATE firm SET name = 'Demo Advisory' WHERE id = ${a.firmId}`),
    );
    for (const set of [`status = 'ACTIVE'`, `plan_code = 'STARTER'`, `trial_ends_on = NULL`]) {
      expect(
        await failure(inFirm(a.firmId, (tx) => tx.execute(sql.raw(`UPDATE firm SET ${set}`)))),
        set,
      ).toBe('42501');
    }
  });

  it('cannot reach schema platform', async () => {
    for (const table of ['plan', 'operator', 'operator_audit_event', 'subscription']) {
      expect(
        await failure(
          inFirm(a.firmId, (tx) => tx.execute(sql.raw(`SELECT 1 FROM platform.${table}`))),
        ),
        table,
      ).toBe('42501');
    }
  });

  it('cannot call the platform functions', async () => {
    expect(
      await failure(
        inFirm(a.firmId, (tx) => tx.execute(sql`SELECT * FROM platform_usage(${a.firmId})`)),
      ),
    ).toBe('42501');
  });
});

describe('operator audit', () => {
  const insert = sql`
    INSERT INTO platform.operator_audit_event (operator_id, action, account_id, request_id)
    VALUES (NULL, 'OPERATOR_LOGIN', NULL, 'accounts-test') RETURNING id`;

  it('the operator appends and reads, but never updates or deletes', async () => {
    const id = await asOperator(
      async (tx) => (await tx.execute<{ id: string }>(insert)).rows[0]!.id,
    );
    for (const statement of [
      `UPDATE platform.operator_audit_event SET reason = 'x' WHERE id = '${id}'`,
      `DELETE FROM platform.operator_audit_event WHERE id = '${id}'`,
      `TRUNCATE platform.operator_audit_event`,
    ]) {
      expect(await failure(asOperator((tx) => tx.execute(sql.raw(statement)))), statement).toBe(
        '42501',
      );
    }
  });

  it('the owner cannot change it either', async () => {
    const { rows } = await t.ownerQuery<{ id: string }>(`
      INSERT INTO platform.operator_audit_event (action, request_id) VALUES ('OPERATOR_LOGIN', 'owner') RETURNING id`);
    for (const statement of [
      `UPDATE platform.operator_audit_event SET reason = 'x' WHERE id = '${rows[0]!.id}'`,
      `DELETE FROM platform.operator_audit_event WHERE id = '${rows[0]!.id}'`,
      `TRUNCATE platform.operator_audit_event`,
    ]) {
      expect(await failure(t.ownerQuery(statement)), statement).toBe('42501');
    }
  });
});

describe('the app’s own account', () => {
  it('reads its kind, status, plan limits and whole-firm usage', async () => {
    const view = await inFirm(a.firmId, (tx) => r.account.get(tx));
    expect(view).toMatchObject({
      id: a.firmId,
      kind: 'CONSULTANCY',
      status: 'ACTIVE',
      trialEndsOn: null,
      entitlements: {
        planCode: 'CONSULTANCY',
        limits: { companies: null, units: null, users: null, storageBytes: null },
      },
    });
    // populateFirm writes one company and one unit per client; the support person is not a user.
    expect(view.usage).toMatchObject({ companies: 2, units: 2 });
  });

  it('counts the whole firm for a user who sees one client', async () => {
    const ctx: TenantContext = {
      firmId: a.firmId,
      personId: null,
      clientIds: [a.clientIds[0]],
      requestId: 'accounts-test',
    };
    const usage = await t.db.withTenant(ctx, (tx) => r.account.usage(tx));
    expect(usage).toMatchObject({ companies: 2, units: 2 });
  });

  it('lays the account override over the plan', async () => {
    await asOperator(async (tx) => {
      const current = (await r.platformAccounts.get(tx, a.firmId))!;
      await r.platformAccounts.update(tx, a.firmId, current.version, { planCode: 'STARTER' });
    });
    await asOperator((tx) =>
      tx
        .insert(s.accountOverride)
        .values({ accountId: a.firmId, limits: { units: 10 }, features: ['importer'] }),
    );
    const view = await inFirm(a.firmId, (tx) => r.account.get(tx));
    expect(view.entitlements).toEqual({
      planCode: 'STARTER',
      limits: { companies: 1, units: 10, users: 25, storageBytes: 10737418240 },
      features: ['importer'],
    });
    expect(await asOperator((tx) => r.platformAccounts.entitlements(tx, a.firmId))).toEqual(
      view.entitlements,
    );
  });

  it('app_usage refuses a transaction with no tenant', async () => {
    const result = await failure(
      t.ownerTransaction(async (client) => {
        await client.query('SET LOCAL ROLE canopy_app');
        await client.query('SELECT * FROM app_usage()');
      }),
    );
    expect(result).toBe('42501');
  });
});

describe('the owner accepting their invite', () => {
  async function accept(account: { accountId: string; ownerId: string; inviteId: string }) {
    await inFirm(account.accountId, async (tx) => {
      const tokenId = await r.loginTokens.create(tx, {
        personId: account.ownerId,
        kind: 'INVITE',
        inviteId: account.inviteId,
        tokenHash: hash(),
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      await r.invites.accept(tx, {
        inviteId: account.inviteId,
        tokenId,
        passwordHash: 'scrypt$32768$8$1$salt$owner',
        now: NOW(),
      });
    });
  }
  const operatorTrail = (accountId: string) =>
    t.ownerQuery<{ action: string; operator_id: string | null; after: unknown }>(
      `SELECT action, operator_id, after FROM platform.operator_audit_event
       WHERE account_id = '${accountId}' AND action = 'ACCOUNT_ACTIVATE'`,
    );

  it('opens a trial account as TRIAL, with its audit row, outbox event and operator entry', async () => {
    const fresh = await asOperator((tx) =>
      r.platformAccounts.create(tx, newAccount({ name: 'Kestrel Aluminium' })),
    );
    await accept(fresh);
    const record = await asOperator((tx) => r.platformAccounts.get(tx, fresh.accountId));
    expect(record).toMatchObject({ status: 'TRIAL', version: 2, onboardedAt: expect.any(String) });
    const audit = await inFirm(fresh.accountId, (tx) =>
      tx
        .select({
          actorId: s.auditEvent.actorId,
          actorKind: s.auditEvent.actorKind,
          action: s.auditEvent.action,
          before: s.auditEvent.before,
          after: s.auditEvent.after,
        })
        .from(s.auditEvent)
        .where(sql`${s.auditEvent.entityType} = 'account'`),
    );
    expect(audit).toEqual([
      {
        actorId: fresh.ownerId,
        actorKind: 'PERSON',
        action: 'TRANSITION',
        before: { status: 'PROVISIONING' },
        after: { status: 'TRIAL' },
      },
    ]);
    const events = await inFirm(fresh.accountId, (tx) =>
      tx
        .select({
          actor: s.domainEvent.actor,
          version: s.domainEvent.aggregateVersion,
          data: s.domainEvent.data,
        })
        .from(s.domainEvent)
        .where(sql`${s.domainEvent.type} = 'account.status_changed'`),
    );
    expect(events).toEqual([
      {
        actor: { kind: 'PERSON', personId: fresh.ownerId },
        version: 2,
        data: { accountId: fresh.accountId, from: 'PROVISIONING', to: 'TRIAL' },
      },
    ]);
    expect((await operatorTrail(fresh.accountId)).rows).toEqual([
      { action: 'ACCOUNT_ACTIVATE', operator_id: null, after: { status: 'TRIAL' } },
    ]);
  });

  it('opens an account with no trial as ACTIVE', async () => {
    const fresh = await asOperator((tx) =>
      r.platformAccounts.create(
        tx,
        newAccount({
          name: 'Kestrel Fibres',
          client: null,
          kind: 'CONSULTANCY',
          planCode: 'CONSULTANCY',
          trialEndsOn: null,
        }),
      ),
    );
    await accept(fresh);
    expect(await asOperator((tx) => r.platformAccounts.get(tx, fresh.accountId))).toMatchObject({
      status: 'ACTIVE',
      version: 2,
    });
  });

  it('changes nothing when an admin of a working account accepts', async () => {
    const before = await asOperator((tx) => r.platformAccounts.get(tx, a.firmId));
    const invite = await inFirm(a.firmId, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO person (display_name, name_normalized, status)
        VALUES ('Second Admin', 'second admin', 'UNCLAIMED') RETURNING id`);
      const personId = rows[0]!.id;
      return r.invites.create(
        tx,
        {
          personId,
          email: 'second.admin@demo-advisory.example',
          grant: {
            role: 'FIRM_ADMIN',
            clientId: null,
            consultantClientIds: null,
            unitIds: null,
            expiresAt: null,
          },
          createdById: personId,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
        NOW(),
      );
    });
    await accept({
      accountId: a.firmId,
      ownerId: invite.invite.personId,
      inviteId: invite.invite.id,
    });
    expect(await asOperator((tx) => r.platformAccounts.get(tx, a.firmId))).toEqual(before);
    expect((await operatorTrail(a.firmId)).rows).toEqual([]);
  });
});

describe('provisioning', () => {
  let created: Awaited<ReturnType<typeof r.platformAccounts.create>>;

  beforeAll(async () => {
    created = await asOperator((tx) => r.platformAccounts.create(tx, newAccount()));
  });

  it('creates a PROVISIONING enterprise with its client, an invited owner and a FIRM_ADMIN invite', async () => {
    const record = await asOperator((tx) => r.platformAccounts.get(tx, created.accountId));
    expect(record).toMatchObject({
      name: 'Kestrel Metals Group',
      kind: 'ENTERPRISE',
      status: 'PROVISIONING',
      planCode: 'BUSINESS',
      trialEndsOn: '2026-11-23',
      version: 1,
    });
    expect(created.clientId).not.toBeNull();
    const people = await inFirm(created.accountId, (tx) =>
      tx.select({ status: s.person.status }).from(s.person),
    );
    expect(people).toEqual([{ status: 'INVITED' }]);
    const invites = await inFirm(created.accountId, (tx) =>
      tx.select({ role: s.authInvite.role, clientId: s.authInvite.clientId }).from(s.authInvite),
    );
    expect(invites).toEqual([{ role: 'FIRM_ADMIN', clientId: null }]);
  });

  it('writes account.created and person.invited with the operator as actor', async () => {
    const events = await inFirm(created.accountId, (tx) =>
      tx
        .select({ type: s.domainEvent.type, actor: s.domainEvent.actor })
        .from(s.domainEvent)
        .orderBy(s.domainEvent.type),
    );
    expect(events).toEqual([
      { type: 'account.created', actor: { kind: 'OPERATOR', operatorId: OPERATOR_ID } },
      { type: 'person.invited', actor: { kind: 'OPERATOR', operatorId: OPERATOR_ID } },
    ]);
  });

  it('provisions only once, and gives a consultancy no client', async () => {
    expect(
      await failure(
        asOperator((tx) =>
          tx.execute(sql`
            SELECT * FROM platform_provision_account(${created.accountId}, NULL, NULL, 'X', 'x',
              'x@kestrel-metals.example', now() + interval '1 day', ${OPERATOR_ID}, 'r')`),
        ),
      ),
    ).toBe('23514');
    expect(
      await failure(
        asOperator((tx) =>
          r.platformAccounts.create(
            tx,
            newAccount({
              name: 'Osprey Textiles Group',
              kind: 'CONSULTANCY',
              planCode: 'CONSULTANCY',
            }),
          ),
        ),
      ),
    ).toBe('VALIDATION');
  });

  it('records operator changes in the account’s own trail, with account fields only', async () => {
    await asOperator(async (tx) => {
      const { after } = await r.platformAccounts.update(tx, created.accountId, 1, {
        status: 'TRIAL',
      });
      expect(after).toMatchObject({ status: 'TRIAL', version: 2 });
      await r.platformAccounts.recordEvent(tx, {
        accountId: created.accountId,
        action: 'TRANSITION',
        before: { status: 'PROVISIONING' },
        after: { status: 'TRIAL' },
        reason: null,
        requestId: 'accounts-test',
        operatorId: OPERATOR_ID,
        event: { type: 'account.status_changed', data: { from: 'PROVISIONING', to: 'TRIAL' } },
      });
    });
    const audit = await inFirm(created.accountId, (tx) =>
      tx
        .select({
          actorKind: s.auditEvent.actorKind,
          entityType: s.auditEvent.entityType,
          after: s.auditEvent.after,
        })
        .from(s.auditEvent),
    );
    expect(audit).toEqual([
      { actorKind: 'OPERATOR', entityType: 'account', after: { status: 'TRIAL' } },
    ]);
    expect(
      await failure(
        asOperator((tx) =>
          r.platformAccounts.recordEvent(tx, {
            accountId: created.accountId,
            action: 'UPDATE',
            before: null,
            after: { email: 'asha.rao@kestrel-metals.example' },
            reason: null,
            requestId: 'accounts-test',
            operatorId: OPERATOR_ID,
            event: null,
          }),
        ),
      ),
    ).toBe('VALIDATION');
    expect(
      await failure(
        asOperator((tx) => r.platformAccounts.update(tx, created.accountId, 1, { name: 'Stale' })),
      ),
    ).toBe('STALE_VERSION');
  });

  it('records account actions only, with no person field at any depth', async () => {
    const event = (over: Partial<r.AccountEvent>): r.AccountEvent => ({
      accountId: created.accountId,
      action: 'UPDATE',
      before: null,
      after: { planCode: 'BUSINESS' },
      reason: null,
      requestId: 'accounts-test',
      operatorId: OPERATOR_ID,
      event: null,
      ...over,
    });
    for (const bad of [
      event({ after: { owner: { email: 'asha.rao@kestrel-metals.example' } } }),
      event({ before: { changes: [{ displayName: 'Asha Rao' }] } }),
      event({ action: 'EVIDENCE_ADD' }),
      event({ action: 'LOGIN' }),
    ]) {
      expect(
        await failure(asOperator((tx) => r.platformAccounts.recordEvent(tx, bad))),
        JSON.stringify(bad),
      ).not.toBe('resolved');
    }
    expect(await failure(asOperator((tx) => r.platformAccounts.recordEvent(tx, event({}))))).toBe(
      'resolved',
    );
  });

  it('counts usage without reading a row', async () => {
    expect(await asOperator((tx) => r.platformAccounts.usage(tx, created.accountId))).toEqual({
      companies: 0,
      units: 0,
      users: 1,
      storageBytes: 0,
      instances: 0,
      activeUsers30d: 0,
    });
  });
});

describe('support access', () => {
  let adminId: string;

  beforeAll(async () => {
    const [admin] = await inFirm(a.firmId, (tx) =>
      tx
        .select({ id: s.person.id })
        .from(s.person)
        .where(sql`${s.person.email} = 'admin@a.example'`),
    );
    adminId = admin!.id;
  });

  it('a new ADMIN grant ends the live one and gives one FIRM_ADMIN membership until it ends', async () => {
    const { grant, ended } = await inFirm(a.firmId, (tx) =>
      r.supportGrants.create(tx, { level: 'ADMIN', days: 7, grantedById: adminId, now: NOW() }),
    );
    expect(ended?.status).toBe('REVOKED');
    expect(grant).toMatchObject({ level: 'ADMIN', status: 'ACTIVE', accountId: a.firmId });
    const memberships = await inFirm(a.firmId, (tx) =>
      tx
        .select({ role: s.membership.role, expiresAt: s.membership.expiresAt })
        .from(s.membership)
        .where(sql`${s.membership.personId} = ${grant.supportPersonId} AND archived_at IS NULL`),
    );
    expect(memberships).toEqual([{ role: 'FIRM_ADMIN', expiresAt: new Date(grant.endsAt) }]);
  });

  it('a READ_ONLY grant gives a VIEWER membership per client', async () => {
    const { grant } = await inFirm(a.firmId, (tx) =>
      r.supportGrants.create(tx, { level: 'READ_ONLY', days: 1, grantedById: adminId, now: NOW() }),
    );
    const roles = await inFirm(a.firmId, (tx) =>
      tx
        .select({ role: s.membership.role, clientId: s.membership.clientId })
        .from(s.membership)
        .where(sql`${s.membership.personId} = ${grant.supportPersonId} AND archived_at IS NULL`),
    );
    expect(roles.map((x) => x.role)).toEqual(['VIEWER', 'VIEWER']);
    expect(roles.map((x) => x.clientId).sort()).toEqual([...a.clientIds].sort());
    expect((await inFirm(a.firmId, (tx) => r.supportGrants.list(tx, NOW())))[0]!.id).toBe(grant.id);
  });

  it('issues a one-time token for a live grant of the named account only, and signs it in once', async () => {
    const live = (await inFirm(a.firmId, (tx) => r.supportGrants.live(tx, NOW())))!;
    const tokenHash = hash();
    expect(
      await failure(
        asOperator((tx) =>
          r.platformSupport.issueToken(tx, {
            accountId: b.firmId,
            grantId: live.id,
            tokenHash,
            expiresAt: soon(),
          }),
        ),
      ),
    ).toBe('P0002');
    await asOperator((tx) =>
      r.platformSupport.issueToken(tx, {
        accountId: a.firmId,
        grantId: live.id,
        tokenHash,
        expiresAt: soon(),
      }),
    );
    expect(await t.db.findSupportToken(tokenHash)).toMatchObject({
      firmId: a.firmId,
      personId: live.supportPersonId,
      supportGrantId: live.id,
      grantLive: true,
      accountStatus: 'ACTIVE',
      usedAt: null,
    });
    // Never through the magic-link and invite lookup.
    expect(await t.db.findLoginToken(tokenHash)).toBeNull();
  });

  it('refuses a token that outlives 90 seconds, and for a revoked grant', async () => {
    const live = (await inFirm(a.firmId, (tx) => r.supportGrants.live(tx, NOW())))!;
    const late = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(
      await failure(
        asOperator((tx) =>
          r.platformSupport.issueToken(tx, {
            accountId: a.firmId,
            grantId: live.id,
            tokenHash: hash(),
            expiresAt: late,
          }),
        ),
      ),
    ).toBe('VALIDATION');
    await inFirm(a.firmId, (tx) => r.supportGrants.revoke(tx, live.id, adminId, NOW()));
    expect(
      await failure(
        asOperator((tx) =>
          r.platformSupport.issueToken(tx, {
            accountId: a.firmId,
            grantId: live.id,
            tokenHash: hash(),
            expiresAt: soon(),
          }),
        ),
      ),
    ).toBe('VALIDATION');
  });

  it('signs a support session out when its grant is revoked', async () => {
    const { grant } = await inFirm(a.firmId, (tx) =>
      r.supportGrants.create(tx, { level: 'ADMIN', days: 1, grantedById: adminId, now: NOW() }),
    );
    const tokenHash = hash();
    await inFirm(a.firmId, (tx) =>
      r.sessions.create(tx, {
        personId: grant.supportPersonId,
        tokenHash,
        csrfToken: 'k'.repeat(43),
        mfaSatisfied: true,
        expiresAt: '2099-01-01T00:00:00.000Z',
        method: 'SUPPORT',
        supportGrantId: grant.id,
      }),
    );
    expect(await t.db.findSession(tokenHash)).toMatchObject({
      supportGrantId: grant.id,
      accountStatus: 'ACTIVE',
    });
    const { sessionsEnded } = await inFirm(a.firmId, (tx) =>
      r.supportGrants.revoke(tx, grant.id, adminId, NOW()),
    );
    expect(sessionsEnded).toBe(1);
    expect(await t.db.findSession(tokenHash)).toBeNull();
  });

  it('a SUPPORT session needs a grant, and only a SUPPORT session has one', async () => {
    const base = {
      personId: adminId,
      tokenHash: hash(),
      csrfToken: 'k'.repeat(43),
      mfaSatisfied: true,
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    expect(
      await failure(
        inFirm(a.firmId, (tx) => r.sessions.create(tx, { ...base, method: 'SUPPORT' })),
      ),
    ).toBe('VALIDATION');
    expect(
      await failure(
        inFirm(a.firmId, (tx) =>
          r.sessions.create(tx, { ...base, method: 'PASSWORD', supportGrantId: a.firmId }),
        ),
      ),
    ).toBe('VALIDATION');
  });

  it('nobody in the account edits, disables or archives the support person, or makes another one', async () => {
    const live = await inFirm(a.firmId, (tx) => r.supportGrants.list(tx, NOW()));
    const supportId = live[0]!.supportPersonId;
    for (const set of [
      `display_name = 'Someone else'`,
      `status = 'DISABLED'`,
      `archived_at = now()`,
      `email = 'x@a.example'`,
    ]) {
      const result = await inFirm(a.firmId, (tx) =>
        tx.execute(sql.raw(`UPDATE person SET ${set} WHERE id = '${supportId}'`)),
      );
      expect(result.rowCount, set).toBe(0);
    }
    expect(
      await failure(
        inFirm(a.firmId, (tx) =>
          tx.execute(sql`UPDATE person SET support = true WHERE id = ${adminId}`),
        ),
      ),
    ).toBe('42501');
    const person = await inFirm(a.firmId, (tx) => r.people.require(tx, supportId));
    expect(person).toMatchObject({
      displayName: 'PlanetPulse support',
      status: 'ACTIVE',
      support: true,
    });
    expect((await inFirm(a.firmId, (tx) => r.people.require(tx, adminId))).support).toBeUndefined();
  });

  it('the support person gets no password, magic link, invite or plain session, whoever writes it', async () => {
    const supportId = (await inFirm(a.firmId, (tx) => r.supportGrants.list(tx, NOW())))[0]!
      .supportPersonId;
    const refusals = [
      await failure(
        inFirm(a.firmId, (tx) =>
          r.credentials.setPassword(tx, supportId, 'scrypt$32768$8$1$salt$support'),
        ),
      ),
      await failure(
        inFirm(a.firmId, (tx) =>
          r.loginTokens.create(tx, {
            personId: supportId,
            kind: 'MAGIC_LINK',
            inviteId: null,
            tokenHash: hash(),
            expiresAt: '2099-01-01T00:00:00.000Z',
          }),
        ),
      ),
      await failure(
        inFirm(a.firmId, (tx) =>
          r.sessions.create(tx, {
            personId: supportId,
            method: 'MAGIC_LINK',
            tokenHash: hash(),
            csrfToken: 'k'.repeat(43),
            mfaSatisfied: true,
            expiresAt: '2099-01-01T00:00:00.000Z',
          }),
        ),
      ),
      await failure(
        inFirm(a.firmId, (tx) =>
          tx.execute(sql`
            INSERT INTO auth_invite (person_id, email, role, created_by_id, expires_at)
            VALUES (${supportId}, 'support@planetpulse.life', 'FIRM_ADMIN', ${adminId}, '2099-01-01')`),
        ),
      ),
      // The owner is held to it too.
      await failure(
        t.ownerQuery(
          `INSERT INTO auth_credential (firm_id, person_id, password_hash)
           VALUES ($1, $2, 'scrypt$32768$8$1$salt$support')`,
          [a.firmId, supportId],
        ),
      ),
    ];
    // The repositories report FORBIDDEN; raw statements see the SQLSTATE.
    expect(refusals).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', '42501', '42501']);
  });

  it('the sign-in lookups ignore a support person’s token or plain session even if one is written', async () => {
    const supportId = (await inFirm(a.firmId, (tx) => r.supportGrants.list(tx, NOW())))[0]!
      .supportPersonId;
    const tokenHash = hash();
    const sessionHash = hash();
    // Written past the triggers, as a restore or a hand edit could.
    await t.ownerQuery(`
      DO $$ BEGIN
        PERFORM set_config('session_replication_role', 'replica', true),
          set_config('app.firm_id', '${a.firmId}', true);
        INSERT INTO auth_token (firm_id, person_id, kind, token_hash, expires_at)
          VALUES ('${a.firmId}', '${supportId}', 'MAGIC_LINK', '${tokenHash}', '2099-01-01');
        INSERT INTO auth_session (firm_id, person_id, token_hash, csrf_token, mfa_satisfied, method, expires_at)
          VALUES ('${a.firmId}', '${supportId}', '${sessionHash}', '${'k'.repeat(43)}', true, 'MAGIC_LINK', '2099-01-01');
      END $$`);
    expect(await t.db.findLoginToken(tokenHash)).toBeNull();
    expect(await t.db.findSession(sessionHash)).toBeNull();
  });

  it('a grant is revoked, never re-pointed or stretched, and lasts at most 30 days', async () => {
    const live = (await inFirm(a.firmId, (tx) => r.supportGrants.list(tx, NOW())))[0]!;
    for (const set of [
      sql`support_person_id = ${adminId}`,
      sql`ends_at = ends_at + interval '1 year'`,
      sql`level = 'ADMIN'`,
    ]) {
      expect(
        await failure(
          inFirm(a.firmId, (tx) =>
            tx.execute(sql`UPDATE support_grant SET ${set} WHERE id = ${live.id}`),
          ),
        ),
      ).toBe('42501');
    }
    expect(
      await failure(
        inFirm(a.firmId, (tx) =>
          tx.execute(sql`
            INSERT INTO support_grant (level, starts_at, ends_at, granted_by_id, support_person_id)
            VALUES ('READ_ONLY', now(), now() + interval '31 days', ${adminId}, ${live.supportPersonId})`),
        ),
      ),
    ).toBe('23514');
  });

  it('issues no support token for a grant pointed at anyone but the support person', async () => {
    const grantId = '01920000-0000-7000-8000-0000000000c4';
    await t.ownerQuery(`
      DO $$ BEGIN
        PERFORM set_config('app.firm_id', '${a.firmId}', true);
        INSERT INTO support_grant (id, firm_id, level, starts_at, ends_at, granted_by_id, support_person_id)
          VALUES ('${grantId}', '${a.firmId}', 'ADMIN', now() - interval '1 minute', now() + interval '1 day',
                  '${adminId}', '${adminId}');
      END $$`);
    const tokenHash = hash();
    expect(
      await failure(
        asOperator((tx) =>
          r.platformSupport.issueToken(tx, {
            accountId: a.firmId,
            grantId,
            tokenHash,
            expiresAt: soon(),
          }),
        ),
      ),
    ).not.toBe('resolved');
    expect(await t.db.findSupportToken(tokenHash)).toBeNull();
  });

  it('the support person is never a sign-in candidate', async () => {
    expect(await t.db.findLoginCandidates('support@planetpulse.life')).toEqual([]);
    const [admin] = await t.db.findLoginCandidates('admin@a.example');
    expect(admin).toMatchObject({ firmId: a.firmId, accountStatus: 'ACTIVE' });
  });
});

describe('the deletion clock', () => {
  it('is the database’s: requesting deletion stamps now, and nobody moves it after', async () => {
    const account = await asOperator((tx) =>
      r.platformAccounts.create(
        tx,
        newAccount({
          name: 'Osprey Textiles Group',
          kind: 'CONSULTANCY',
          planCode: 'CONSULTANCY',
          client: null,
          owner: { displayName: 'Ravi Menon', email: 'ravi.menon@osprey-textiles.example' },
        }),
      ),
    );
    const id = account.accountId;
    await asOperator((tx) => r.platformAccounts.update(tx, id, 1, { status: 'TRIAL' }));
    const before = Date.now();
    const { after } = await asOperator((tx) =>
      r.platformAccounts.update(tx, id, 2, {
        status: 'PENDING_DELETION',
        statusBeforeDeletion: 'TRIAL',
        deletionRequestedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    // The operator's backdated time is ignored (audit of #140, Medium 2).
    expect(Date.parse(after.deletionRequestedAt!)).toBeGreaterThanOrEqual(before - 5_000);
    expect(
      await failure(
        asOperator((tx) =>
          r.platformAccounts.update(tx, id, 3, { deletionRequestedAt: '2019-01-01T00:00:00.000Z' }),
        ),
      ),
    ).not.toBe('resolved');
    expect(
      await failure(
        t.ownerQuery(`
          DO $$ BEGIN
            PERFORM set_config('app.firm_id', '${id}', true);
            UPDATE firm SET deletion_requested_at = '2019-01-01' WHERE id = '${id}';
          END $$`),
      ),
    ).toBe('23514');
    // Cancelling clears it.
    const cancelled = await asOperator((tx) =>
      r.platformAccounts.update(tx, id, 3, {
        status: 'TRIAL',
        statusBeforeDeletion: null,
        deletionRequestedAt: null,
      }),
    );
    expect(cancelled.after).toMatchObject({ status: 'TRIAL', deletionRequestedAt: null });
  });
});
