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
    const one = await asOperator((tx) => r.platformSupport.get(tx, listed[0]!.id, NOW()));
    expect(one).toEqual(listed[0]);
    const later = new Date(Date.parse(listed[0]!.endsAt) + 1000).toISOString();
    expect(await asOperator((tx) => r.platformSupport.get(tx, listed[0]!.id, later))).toMatchObject(
      { status: 'EXPIRED' },
    );
    expect(
      await asOperator((tx) =>
        r.platformSupport.get(tx, '01920000-0000-7000-8000-0000000000ff', NOW()),
      ),
    ).toBeNull();
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
      // A tombstone as the purge leaves one (migration 0035 lets only the purge write DELETED).
      await client.query('ALTER TABLE firm DISABLE TRIGGER firm_deleted_by_purge');
      await client.query(`UPDATE firm SET status = 'DELETED' WHERE id = $1`, [b.firmId]);
      await client.query('ALTER TABLE firm ENABLE TRIGGER firm_deleted_by_purge');
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

  it('serialises usage checks per firm with lockUsage, and leaves other firms alone', async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const first = inFirm(a.firmId, async (tx) => {
      await r.account.lockUsage(tx);
      locked();
      await held;
      order.push('first done');
    });
    await lockTaken;
    const second = inFirm(a.firmId, async (tx) => {
      await r.account.lockUsage(tx);
      order.push('second locked');
    });
    // Another firm's lock is a different key, so it does not wait.
    await inFirm(b.firmId, (tx) => r.account.lockUsage(tx));
    order.push('other firm locked');
    // The second transaction is queued behind the first's advisory lock before the first lets go.
    for (let waiting = 0; waiting === 0;) {
      const { rows } = await t.ownerQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
         WHERE d.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`,
      );
      waiting = rows[0]!.n;
    }
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['other firm locked', 'first done', 'second locked']);
  });

  it('reads no features without a firm in context', async () => {
    const error = await t.db
      .withTenant(systemContext(a.firmId, 'accounts-test'), async (tx) => {
        await tx.execute(sql`SELECT set_config('app.firm_id', '', true)`);
        return r.account.features(tx);
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('NOT_FOUND');
  });

  it('refuses lockUsage with no firm in context rather than lock nothing', async () => {
    const error = await t.db
      .withTenant(systemContext(a.firmId, 'accounts-test'), async (tx) => {
        await tx.execute(sql`SELECT set_config('app.firm_id', '', true)`);
        return r.account.lockUsage(tx);
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('NOT_FOUND');
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

  it('takes the override’s removed features away, even when the plan has them (ADR M16-0001)', async () => {
    const before = await asOperator(async (tx) => ({
      account: (await r.platformAccounts.get(tx, a.firmId))!,
      override: await r.accountOverrides.get(tx, a.firmId),
    }));
    const features = async () => {
      const tenant = (await inFirm(a.firmId, (tx) => r.account.get(tx))).entitlements.features;
      // The features-only read (M5's per-request check) agrees with the full account view.
      expect(await inFirm(a.firmId, (tx) => r.account.features(tx))).toEqual(tenant);
      const operator = (await asOperator((tx) => r.platformAccounts.entitlements(tx, a.firmId)))
        .features;
      return { tenant, operator };
    };
    await asOperator(async (tx) => {
      await r.plans.upsert(
        tx,
        'ISO_PILOT',
        {
          name: 'ISO pilot',
          limits: { companies: 1, units: 5, users: 10, storageBytes: 1_000_000 },
          features: ['importer', 'isoManagement'],
          retired: false,
        },
        '2026-10-25T09:00:00.000Z',
      );
      await r.platformAccounts.update(tx, a.firmId, before.account.version, {
        planCode: 'ISO_PILOT',
      });
    });
    const put = (override: Parameters<typeof r.accountOverrides.put>[2]) =>
      asOperator((tx) => r.accountOverrides.put(tx, a.firmId, override));

    // In the plan and removed: off. Added and not in the plan: on. Removing a flag the plan lacks changes nothing.
    const off = await put({
      limits: {},
      features: ['bulkExport'],
      removedFeatures: ['isoManagement', 'neverInPlan'],
      note: 'ISO switched off',
    });
    expect(off.after.removedFeatures).toEqual(['isoManagement', 'neverInPlan']);
    expect(await features()).toEqual({
      tenant: ['bulkExport', 'importer'],
      operator: ['bulkExport', 'importer'],
    });

    // A put without removedFeatures removes nothing, so the plan's isoManagement is back.
    const on = await put({ limits: {}, features: [], note: 'ISO switched on' });
    expect(on.after.removedFeatures).toEqual([]);
    const all = ['importer', 'isoManagement'];
    expect(await features()).toEqual({ tenant: all, operator: all });

    // The table refuses a flag that is both added and removed, as the contract does.
    const both = await failure(
      t.ownerQuery(
        `UPDATE platform.account_override SET features = '{isoManagement}', removed_features = '{isoManagement}'
         WHERE account_id = $1`,
        [a.firmId],
      ),
    );
    expect(both).toBe('23514');

    await asOperator(async (tx) => {
      const current = (await r.platformAccounts.get(tx, a.firmId))!;
      await r.platformAccounts.update(tx, a.firmId, current.version, {
        planCode: before.account.planCode,
      });
      if (before.override) await r.accountOverrides.put(tx, a.firmId, before.override);
    });
  });

  it('leaves a malformed flag out of account.features rather than fail every request', async () => {
    const before = await t.ownerQuery<{ features: string[] }>(
      'SELECT features FROM platform.account_override WHERE account_id = $1',
      [a.firmId],
    );
    await t.ownerQuery(
      `INSERT INTO platform.account_override (account_id, features) VALUES ($1, '{bulkExport,"Not a flag"}')
       ON CONFLICT (account_id) DO UPDATE SET features = excluded.features`,
      [a.firmId],
    );
    const features = await inFirm(a.firmId, (tx) => r.account.features(tx));
    expect(features).toContain('bulkExport');
    expect(features).not.toContain('Not a flag');
    await t.ownerQuery('UPDATE platform.account_override SET features = $2 WHERE account_id = $1', [
      a.firmId,
      before.rows[0]?.features ?? [],
    ]);
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

describe('the ISO catalogue marker (docs/iso/plan.md §4.3)', () => {
  const contexts = (firm: PopulatedFirm) =>
    ({
      system: systemContext(firm.firmId, 'accounts-test'),
      firmAdmin: {
        firmId: firm.firmId,
        personId: '01920000-0000-7000-8000-0000000000bb',
        clientIds: 'ALL',
        requestId: 'accounts-test',
      },
      consultant: {
        firmId: firm.firmId,
        personId: '01920000-0000-7000-8000-0000000000bb',
        clientIds: [firm.clientIds[0]!],
        firmStaff: true,
        requestId: 'accounts-test',
      },
      client: {
        firmId: firm.firmId,
        personId: '01920000-0000-7000-8000-0000000000bb',
        clientIds: [firm.clientIds[0]!],
        requestId: 'accounts-test',
      },
    }) satisfies Record<string, TenantContext>;
  const readAll = async (firm: PopulatedFirm) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(contexts(firm)).map(
          async ([name, ctx]) =>
            [name, await t.db.withTenant(ctx, (tx) => r.account.isoCatalogueCopiedAt(tx))] as const,
        ),
      ),
    );
  const setStatus = (firm: PopulatedFirm, status: string, trialEndsOn: string | null) =>
    t.ownerQuery('UPDATE firm SET status = $2, trial_ends_on = $3 WHERE id = $1', [
      firm.firmId,
      status,
      trialEndsOn,
    ]);
  const unmark = () => t.ownerQuery('UPDATE firm SET iso_catalogue_copied_at = NULL');

  it('sets once in the account’s system context and reads the same in every context', async () => {
    await unmark();
    const before = await asOperator((tx) => r.platformAccounts.get(tx, a.firmId));
    expect(before).toMatchObject({ status: 'ACTIVE', isoCatalogueCopiedAt: null });
    expect(await readAll(a)).toEqual({
      system: null,
      firmAdmin: null,
      consultant: null,
      client: null,
    });

    // Only the system context may mark: not a firm admin, a consultant or a client user.
    const { system, ...people } = contexts(a);
    for (const [name, ctx] of Object.entries(people)) {
      expect(
        await failure(t.db.withTenant(ctx, (tx) => r.accountJobs.markIsoCatalogueCopied(tx))),
        name,
      ).toBe('FORBIDDEN');
    }
    // Nor may the app role write the column itself, even as the system job.
    expect(
      await failure(
        t.db.withTenant(system, (tx) =>
          tx.execute(sql`UPDATE firm SET iso_catalogue_copied_at = now() WHERE id = app_firm_id()`),
        ),
      ),
    ).toBe('42501');

    expect(await inFirm(a.firmId, (tx) => r.accountJobs.markIsoCatalogueCopied(tx))).toBe(true);
    const at = await inFirm(a.firmId, (tx) => r.account.isoCatalogueCopiedAt(tx));
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await inFirm(a.firmId, (tx) => r.accountJobs.markIsoCatalogueCopied(tx))).toBe(false);
    expect(await readAll(a)).toEqual({ system: at, firmAdmin: at, consultant: at, client: at });
    const after = await asOperator((tx) => r.platformAccounts.get(tx, a.firmId));
    expect(after).toEqual({ ...before, isoCatalogueCopiedAt: at });
    // The other account is untouched.
    expect(await readAll(b)).toEqual({
      system: null,
      firmAdmin: null,
      consultant: null,
      client: null,
    });
    await unmark();
  });

  it('a failed copy rolls the mark back, and a second copy waits for the first', async () => {
    await unmark();
    expect(
      await failure(
        inFirm(a.firmId, async (tx) => {
          expect(await r.accountJobs.markIsoCatalogueCopied(tx)).toBe(true);
          throw new Error('copy failed');
        }),
      ),
    ).toContain('copy failed');
    expect(await inFirm(a.firmId, (tx) => r.account.isoCatalogueCopiedAt(tx))).toBeNull();

    let releaseFirst!: () => void;
    const firstHolds = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstMarked!: () => void;
    const marked = new Promise<void>((resolve) => (firstMarked = resolve));
    const first = inFirm(a.firmId, async (tx) => {
      const result = await r.accountJobs.markIsoCatalogueCopied(tx);
      firstMarked();
      await firstHolds;
      return result;
    });
    await marked;
    const second = inFirm(a.firmId, (tx) => r.accountJobs.markIsoCatalogueCopied(tx));
    await new Promise((resolve) => setTimeout(resolve, 200));
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([true, false]);
    await unmark();
  });

  it('works in TRIAL and ACTIVE, and marks nothing in any other status', async () => {
    await unmark();
    try {
      await setStatus(b, 'TRIAL', '2099-01-01');
      expect(await inFirm(b.firmId, (tx) => r.accountJobs.markIsoCatalogueCopied(tx))).toBe(true);
      await unmark();
      for (const status of ['SUSPENDED', 'PROVISIONING']) {
        await setStatus(b, status, null);
        expect(
          await inFirm(b.firmId, (tx) => r.accountJobs.markIsoCatalogueCopied(tx)),
          status,
        ).toBe(false);
        expect(await inFirm(b.firmId, (tx) => r.account.isoCatalogueCopiedAt(tx))).toBeNull();
      }
    } finally {
      await setStatus(b, 'ACTIVE', null);
      await unmark();
    }
  });

  it('computes the effective features in one SQL function, sorted and distinct', async () => {
    const effective = async (
      plan: string[] | null,
      added: string[] | null,
      removed: string[] | null,
    ) =>
      (
        await t.ownerQuery<{ f: string[] }>(
          'SELECT canopy_effective_features($1::text[], $2::text[], $3::text[]) AS f',
          [plan, added, removed],
        )
      ).rows[0]!.f;
    expect(await effective(['importer', 'isoManagement'], null, null)).toEqual([
      'importer',
      'isoManagement',
    ]);
    expect(await effective(['isoManagement'], ['bulkExport', 'isoManagement'], null)).toEqual([
      'bulkExport',
      'isoManagement',
    ]);
    expect(
      await effective(['importer', 'isoManagement'], ['bulkExport'], ['isoManagement']),
    ).toEqual(['bulkExport', 'importer']);
    expect(await effective([], null, ['isoManagement'])).toEqual([]);
    // Pure, so the planner may fold it, and it reads no table.
    const { rows } = await t.ownerQuery<{ volatile: string; body: string }>(
      `SELECT provolatile AS volatile, prosrc AS body FROM pg_proc WHERE proname = 'canopy_effective_features'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.volatile).toBe('i');
    expect(rows[0]!.body).not.toMatch(/\bfrom\s+(?!unnest)/i);
  });
});

describe('the owner accepting their invite', () => {
  async function accept(
    account: { accountId: string; ownerId: string; inviteId: string },
    copied = true,
  ) {
    if (copied) await inFirm(account.accountId, (tx) => r.accountJobs.markLibraryCopied(tx));
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

  it('waits for the library copy: nothing opens before it, and the copy is recorded once', async () => {
    const fresh = await asOperator((tx) =>
      r.platformAccounts.create(tx, newAccount({ name: 'Riverbend Works' })),
    );
    expect(await failure(accept(fresh, false))).toBe('VALIDATION');
    const before = await asOperator((tx) => r.platformAccounts.get(tx, fresh.accountId));
    expect(before).toMatchObject({ status: 'PROVISIONING', libraryCopiedAt: null, version: 1 });
    expect(await inFirm(fresh.accountId, (tx) => r.account.libraryCopied(tx))).toBe(false);
    expect(await inFirm(fresh.accountId, (tx) => r.accountJobs.markLibraryCopied(tx))).toBe(true);
    const copied = await asOperator((tx) => r.platformAccounts.get(tx, fresh.accountId));
    // Set once: a retried event leaves the first time alone.
    expect(await inFirm(fresh.accountId, (tx) => r.accountJobs.markLibraryCopied(tx))).toBe(false);
    expect(await asOperator((tx) => r.platformAccounts.get(tx, fresh.accountId))).toEqual(copied);
    expect(await inFirm(fresh.accountId, (tx) => r.account.libraryCopied(tx))).toBe(true);
    await accept(fresh, false);
    expect(await asOperator((tx) => r.platformAccounts.get(tx, fresh.accountId))).toMatchObject({
      status: 'TRIAL',
      libraryCopiedAt: copied!.libraryCopiedAt,
    });
  });

  it('records the copy only for a PROVISIONING account, in a firm-wide context', async () => {
    const before = await asOperator((tx) => r.platformAccounts.get(tx, a.firmId));
    expect(before?.status).toBe('ACTIVE');
    expect(await inFirm(a.firmId, (tx) => r.accountJobs.markLibraryCopied(tx))).toBe(false);
    expect(await asOperator((tx) => r.platformAccounts.get(tx, a.firmId))).toEqual(before);
    const person: TenantContext = {
      firmId: a.firmId,
      personId: '01920000-0000-7000-8000-0000000000bb',
      clientIds: [a.clientIds[0]],
      requestId: 'accounts-test',
    };
    expect(
      await failure(t.db.withTenant(person, (tx) => r.accountJobs.markLibraryCopied(tx))),
    ).toBe('FORBIDDEN');
  });

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
    ).toBe('NOT_FOUND');
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

  it('writes SUPPORT_ACCESS_START and SUPPORT_ACCESS_END to the operator trail with the grant, once each', async () => {
    const first = await inFirm(a.firmId, (tx) =>
      r.supportGrants.create(tx, { level: 'ADMIN', days: 1, grantedById: adminId, now: NOW() }),
    );
    const { grant, ended } = await inFirm(a.firmId, (tx) =>
      r.supportGrants.create(tx, { level: 'READ_ONLY', days: 3, grantedById: adminId, now: NOW() }),
    );
    expect(ended?.id).toBe(first.grant.id);
    await inFirm(a.firmId, (tx) => r.supportGrants.revoke(tx, grant.id, adminId, NOW()));
    // A revoke that finds nothing live changes no row, so it writes nothing.
    expect(
      await failure(inFirm(a.firmId, (tx) => r.supportGrants.revoke(tx, grant.id, adminId, NOW()))),
    ).toBe('NOT_FOUND');
    const { rows: trail } = await t.ownerQuery<{
      action: string;
      operator_id: string | null;
      account_id: string;
      before: unknown;
      after: Record<string, unknown>;
      request_id: string;
    }>(
      `SELECT action, operator_id, account_id, before, after, request_id FROM platform.operator_audit_event
       WHERE after->>'grantId' = '${grant.id}' ORDER BY at, id`,
    );
    expect(trail).toEqual([
      {
        action: 'SUPPORT_ACCESS_START',
        operator_id: null,
        account_id: a.firmId,
        before: null,
        after: {
          grantId: grant.id,
          level: 'READ_ONLY',
          startsAt: expect.any(String),
          endsAt: expect.any(String),
          source: 'grant',
        },
        request_id: 'accounts-test',
      },
      {
        action: 'SUPPORT_ACCESS_END',
        operator_id: null,
        account_id: a.firmId,
        before: { endsAt: expect.any(String) },
        after: {
          grantId: grant.id,
          level: 'READ_ONLY',
          revokedAt: expect.any(String),
          source: 'grant',
        },
        request_id: 'accounts-test',
      },
    ]);
    expect(Date.parse(trail[0]!.after.endsAt as string)).toBe(Date.parse(grant.endsAt));
    // The grant this one ended has its own END entry.
    const { rows: endedTrail } = await t.ownerQuery<{ action: string }>(
      `SELECT action FROM platform.operator_audit_event WHERE after->>'grantId' = '${ended!.id}' ORDER BY at, id`,
    );
    expect(endedTrail.map((e) => e.action)).toEqual(['SUPPORT_ACCESS_START', 'SUPPORT_ACCESS_END']);
  });

  it('closes a grant that ran out, with SUPPORT_ACCESS_END from expiry, once', async () => {
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const { grant } = await inFirm(a.firmId, (tx) =>
      r.supportGrants.create(tx, { level: 'READ_ONLY', days: 1, grantedById: adminId, now: past }),
    );
    // Only the account's system context may record it.
    const asAdmin: TenantContext = {
      firmId: a.firmId,
      personId: adminId,
      clientIds: 'ALL',
      requestId: 'accounts-test',
    };
    expect(
      await failure(
        t.db.withTenant(asAdmin, (tx) =>
          tx.execute(sql`SELECT app_record_support_expiry(${grant.id}, now())`),
        ),
      ),
    ).toBe('42501');
    // Another account's context finds nothing to record.
    const { rows: other } = await inFirm(b.firmId, (tx) =>
      tx.execute<{ recorded: boolean }>(
        sql`SELECT app_record_support_expiry(${grant.id}, now()) AS recorded`,
      ),
    );
    expect(other).toEqual([{ recorded: false }]);

    expect(await inFirm(a.firmId, (tx) => r.supportGrants.closeExpired(tx, NOW()))).toBe(1);
    expect(await inFirm(a.firmId, (tx) => r.supportGrants.closeExpired(tx, NOW()))).toBe(0);
    const { rows: trail } = await t.ownerQuery<{ action: string; after: Record<string, unknown> }>(
      `SELECT action, after FROM platform.operator_audit_event
       WHERE after->>'grantId' = '${grant.id}' ORDER BY at, id`,
    );
    expect(trail).toEqual([
      expect.objectContaining({ action: 'SUPPORT_ACCESS_START' }),
      {
        action: 'SUPPORT_ACCESS_END',
        after: {
          grantId: grant.id,
          level: 'READ_ONLY',
          endedAt: expect.any(String),
          source: 'expiry',
        },
      },
    ]);
    // The support person keeps no live membership, and a call after the close records nothing.
    const { rows: again } = await inFirm(a.firmId, (tx) =>
      tx.execute<{ recorded: boolean }>(
        sql`SELECT app_record_support_expiry(${grant.id}, now()) AS recorded`,
      ),
    );
    expect(again).toEqual([{ recorded: false }]);
  });

  it('records an expiry only for a grant that has run out by the database clock, whatever the caller says', async () => {
    const { grant } = await inFirm(a.firmId, (tx) =>
      r.supportGrants.create(tx, { level: 'READ_ONLY', days: 1, grantedById: adminId, now: NOW() }),
    );
    const { rows } = await inFirm(a.firmId, (tx) =>
      tx.execute<{ recorded: boolean }>(
        sql`SELECT app_record_support_expiry(${grant.id}, '2099-01-01T00:00:00Z'::timestamptz) AS recorded`,
      ),
    );
    expect(rows).toEqual([{ recorded: false }]);
    const { rows: trail } = await t.ownerQuery<{ action: string }>(
      `SELECT action FROM platform.operator_audit_event WHERE after->>'grantId' = '${grant.id}' ORDER BY at, id`,
    );
    expect(trail.map((e) => e.action)).toEqual(['SUPPORT_ACCESS_START']);
  });

  it('records an expiry once when two runs race on the same grant', async () => {
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const { grant } = await inFirm(a.firmId, (tx) =>
      r.supportGrants.create(tx, { level: 'READ_ONLY', days: 1, grantedById: adminId, now: past }),
    );
    const record = (holdMs: number) =>
      inFirm(a.firmId, async (tx) => {
        const { rows } = await tx.execute<{ recorded: boolean }>(
          sql`SELECT app_record_support_expiry(${grant.id}, now()) AS recorded`,
        );
        // The first run keeps its transaction open; the second insert waits on its entry, then does nothing.
        await new Promise((done) => setTimeout(done, holdMs));
        return rows[0]!.recorded;
      });
    const first = record(400);
    await new Promise((done) => setTimeout(done, 100));
    const second = record(0);
    expect(await Promise.all([first, second])).toEqual([true, false]);
    const { rows: ends } = await t.ownerQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.operator_audit_event
       WHERE action = 'SUPPORT_ACCESS_END' AND after->>'grantId' = '${grant.id}'`,
    );
    expect(ends).toEqual([{ n: 1 }]);
  });

  it('records the expiry of a grant whose support person holds no membership, once', async () => {
    const past = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const { grant } = await inFirm(a.firmId, (tx) =>
      r.supportGrants.create(tx, { level: 'READ_ONLY', days: 1, grantedById: adminId, now: past }),
    );
    // As on an account with no clients: the READ_ONLY grant made no VIEWER membership.
    await t.ownerQuery(
      `UPDATE membership SET archived_at = now()
       WHERE firm_id = $1 AND person_id = $2 AND expires_at = $3 AND archived_at IS NULL`,
      [a.firmId, grant.supportPersonId, grant.endsAt],
    );
    expect(await inFirm(a.firmId, (tx) => r.supportGrants.closeExpired(tx, NOW()))).toBe(0);
    expect(await inFirm(a.firmId, (tx) => r.supportGrants.closeExpired(tx, NOW()))).toBe(0);
    const { rows: trail } = await t.ownerQuery<{ action: string; source: string }>(
      `SELECT action, after->>'source' AS source FROM platform.operator_audit_event
       WHERE after->>'grantId' = '${grant.id}' ORDER BY at, id`,
    );
    expect(trail).toEqual([
      { action: 'SUPPORT_ACCESS_START', source: 'grant' },
      { action: 'SUPPORT_ACCESS_END', source: 'expiry' },
    ]);
  });

  it("keeps one END per grant for the grant's own ends only", async () => {
    const { grant } = await inFirm(a.firmId, (tx) =>
      r.supportGrants.create(tx, { level: 'READ_ONLY', days: 1, grantedById: adminId, now: NOW() }),
    );
    const end = (source: string) =>
      t.ownerQuery(
        `INSERT INTO platform.operator_audit_event (action, account_id, after, request_id)
         VALUES ('SUPPORT_ACCESS_END', $1, jsonb_build_object('grantId', $2::text, 'source', $3::text), 'accounts-test')`,
        [a.firmId, grant.id, source],
      );
    // Another source that names the grant, such as a support session's end, may appear any number of times.
    await end('session');
    await end('session');
    await end('grant');
    await expect(end('expiry')).rejects.toThrow(/operator_audit_event_support_end_key/);
  });

  it('lets a late revoke through when the expiry is already in the trail, keeping one END', async () => {
    const past = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { grant } = await inFirm(a.firmId, (tx) =>
      r.supportGrants.create(tx, { level: 'READ_ONLY', days: 1, grantedById: adminId, now: past }),
    );
    await inFirm(a.firmId, (tx) => r.supportGrants.closeExpired(tx, NOW()));
    // A caller whose clock still reads a time before the grant ended.
    const { grant: revoked } = await inFirm(a.firmId, (tx) =>
      r.supportGrants.revoke(tx, grant.id, adminId, past),
    );
    expect(revoked.status).toBe('REVOKED');
    const { rows: trail } = await t.ownerQuery<{ action: string; source: string }>(
      `SELECT action, after->>'source' AS source FROM platform.operator_audit_event
       WHERE after->>'grantId' = '${grant.id}' ORDER BY at, id`,
    );
    expect(trail).toEqual([
      { action: 'SUPPORT_ACCESS_START', source: 'grant' },
      { action: 'SUPPORT_ACCESS_END', source: 'expiry' },
    ]);
  });

  it('keeps a revoke final: the tenant cannot revive a revoked grant or rewrite who revoked it', async () => {
    const { grant } = await inFirm(a.firmId, (tx) =>
      r.supportGrants.create(tx, { level: 'READ_ONLY', days: 1, grantedById: adminId, now: NOW() }),
    );
    await inFirm(a.firmId, (tx) => r.supportGrants.revoke(tx, grant.id, adminId, NOW()));
    const update = (set: ReturnType<typeof sql>) =>
      failure(
        inFirm(a.firmId, (tx) =>
          tx.execute(sql`UPDATE support_grant SET ${set} WHERE id = ${grant.id}`),
        ),
      );
    expect(await update(sql`revoked_at = NULL, revoked_by_id = NULL`)).toBe('23514');
    expect(await update(sql`revoked_at = now() + interval '1 day'`)).toBe('23514');
    const [other] = await inFirm(a.firmId, (tx) =>
      tx
        .select({ id: s.person.id })
        .from(s.person)
        .where(sql`${s.person.id} <> ${adminId}`)
        .limit(1),
    );
    expect(await update(sql`revoked_by_id = ${other!.id}::uuid`)).toBe('23514');
    // A write that leaves the revoke as it was still goes through.
    expect(await update(sql`revoked_at = revoked_at`)).toBe('resolved');
    const { rows } = await t.ownerQuery<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked FROM support_grant WHERE id = '${grant.id}'`,
    );
    expect(rows).toEqual([{ revoked: true }]);
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
