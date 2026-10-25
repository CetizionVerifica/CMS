import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOperatorDatabase, type OperatorDatabase, type OperatorTx } from '../src/database.js';
import { DbError } from '../src/errors.js';
import * as r from '../src/repositories/index.js';
import { systemContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import {
  populateAuth,
  populateFirm,
  populateIdempotency,
  populateIso,
  populateIso2,
  populateSupport,
  type PopulatedFirm,
} from './support/populate.js';
import { PLATFORM_TABLES, TABLES } from './support/tables.js';

/**
 * Purging a deleted account (ADR M15-0002 decisions 3 and 6; migration 0035): only platform_purge_account removes a
 * firm's rows and audit trail, only for an account PENDING_DELETION for 30 days, and only that account's.
 */

let t: TestDatabase;
let op: OperatorDatabase;
let a: PopulatedFirm;
let b: PopulatedFirm;

const asOperator = <T>(fn: (tx: OperatorTx) => Promise<T>) => op.withOperator('purge-test', fn);
const tenantTables = TABLES.map((x) => x.name).filter((n) => n !== 'firm');

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
    if (e instanceof DbError) return e.code;
    return sqlState(e) ?? String(e);
  }
  return 'resolved';
}

/** Puts the firm in PENDING_DELETION requested `days` ago: the deletion clock only ever writes now(). */
async function pendingSince(firmId: string, days: number): Promise<void> {
  await t.ownerQuery(`BEGIN;
    SELECT set_config('app.firm_id', '${firmId}', true);
    ALTER TABLE firm DISABLE TRIGGER firm_deletion_clock;
    UPDATE firm SET status = 'PENDING_DELETION', status_before_deletion = 'ACTIVE', deletion_requested_at = now() - interval '${days} days'
      WHERE id = '${firmId}';
    ALTER TABLE firm ENABLE TRIGGER firm_deletion_clock;
    COMMIT;`);
}

/** Rows per tenant table for one firm, read as the owner. */
async function counts(firmId: string): Promise<Record<string, number>> {
  return t.ownerTransaction(async (client) => {
    await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmId]);
    const out: Record<string, number> = {};
    for (const table of tenantTables) {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${table}" WHERE firm_id = $1`,
        [firmId],
      );
      out[table] = Number(rows[0]!.n);
    }
    return out;
  });
}

/** A digest of every row per tenant table for one firm, read as the owner: the other firm's contents. */
async function contents(firmId: string): Promise<Record<string, string>> {
  return t.ownerTransaction(async (client) => {
    await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmId]);
    const out: Record<string, string> = {};
    for (const table of tenantTables) {
      const { rows } = await client.query<{ d: string }>(
        `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS d FROM "${table}" x WHERE firm_id = $1`,
        [firmId],
      );
      out[table] = rows[0]!.d;
    }
    return out;
  });
}

async function platformCounts(firmId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of PLATFORM_TABLES.map((x) => x.name)) {
    const { rows: cols } = await t.ownerQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'platform' AND table_name = $1 AND column_name = 'account_id'`,
      [table],
    );
    if (cols.length === 0) continue;
    const { rows } = await t.ownerQuery<{ n: string }>(
      `SELECT count(*) AS n FROM platform."${table}" WHERE account_id = $1`,
      [firmId],
    );
    out[table] = Number(rows[0]!.n);
  }
  return out;
}

/** The ACCOUNT_PURGE rows of the operator trail for one account, oldest first. */
async function purgeTrail(firmId: string): Promise<{ before: unknown; after: unknown }[]> {
  const { rows } = await t.ownerQuery<{ before: unknown; after: unknown }>(
    `SELECT before, after FROM platform.operator_audit_event
     WHERE account_id = $1 AND action = 'ACCOUNT_PURGE' ORDER BY at, id`,
    [firmId],
  );
  return rows;
}

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
    await populateIso(t.db, firm, label);
    await populateIso2(t.db, firm, label);
  }
}, 60_000);

afterAll(async () => {
  await op?.close();
  await t?.drop();
});

describe('platform_purge_account', () => {
  it('lists every public table that holds firm_id, children first', async () => {
    const listed = await t.ownerTransaction(async (client) => {
      await client.query('SET LOCAL ROLE canopy_purge');
      const { rows } = await client.query<{ tables: string[] }>(
        'SELECT canopy_purge_tables() AS tables',
      );
      return rows[0]!.tables;
    });
    const { rows: withFirm } = await t.ownerQuery<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'firm_id' ORDER BY 1`,
    );
    expect([...listed].sort()).toEqual(withFirm.map((x) => x.table_name));
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('is the operator’s alone: the app, jobs and lookup roles cannot call it', async () => {
    for (const role of ['canopy_app', 'canopy_jobs', 'canopy_lookup', 'canopy_platform']) {
      expect(
        await failure(
          t.ownerTransaction(async (client) => {
            await client.query(`SET LOCAL ROLE ${role}`);
            await client.query('SELECT platform_purge_account($1)', [b.firmId]);
          }),
        ),
      ).toBe('42501');
    }
    expect(
      await failure(
        t.db.withTenant(systemContext(b.firmId, 'purge-test'), (tx) =>
          tx.execute(sql`SELECT platform_purge_account(${b.firmId})`),
        ),
      ),
    ).toBe('42501');
  });

  it('refuses an unknown account, a live one and one inside its 30 days', async () => {
    expect(
      await failure(
        asOperator((tx) => r.platformAccounts.purge(tx, '01920000-0000-7000-8000-0000000000ff')),
      ),
    ).toBe('NOT_FOUND');
    expect(await failure(asOperator((tx) => r.platformAccounts.purge(tx, b.firmId)))).toBe(
      'INVALID_TRANSITION',
    );
    await pendingSince(b.firmId, 29);
    expect(await failure(asOperator((tx) => r.platformAccounts.purge(tx, b.firmId)))).toBe(
      'INVALID_TRANSITION',
    );
    expect(await asOperator((tx) => r.platformAccounts.dueForPurge(tx))).toEqual([]);
    expect((await counts(b.firmId)).audit_event).toBeGreaterThan(0);
  });

  it('nobody deletes audit rows of a live account, or of a pending one, or truncates or edits them', async () => {
    for (const role of ['canopy_app', 'canopy_operator', null]) {
      expect(
        await failure(
          t.ownerTransaction(async (client) => {
            await client.query(`SELECT set_config('app.firm_id', $1, true)`, [b.firmId]);
            if (role) await client.query(`SET LOCAL ROLE ${role}`);
            await client.query('DELETE FROM audit_event WHERE firm_id = $1', [b.firmId]);
          }),
        ),
      ).toBe('42501');
    }
    expect(await failure(t.ownerQuery('TRUNCATE audit_event CASCADE'))).toBe('42501');
    expect(
      await failure(
        t.ownerTransaction(async (client) => {
          await client.query(`SELECT set_config('app.firm_id', $1, true)`, [b.firmId]);
          await client.query(`UPDATE audit_event SET request_id = 'x' WHERE firm_id = $1`, [
            b.firmId,
          ]);
        }),
      ),
    ).toBe('42501');
  });

  it('nobody writes DELETED but the purge', async () => {
    for (const role of ['canopy_operator', null]) {
      expect(
        await failure(
          t.ownerTransaction(async (client) => {
            await client.query(`SELECT set_config('app.firm_id', $1, true)`, [b.firmId]);
            if (role) await client.query(`SET LOCAL ROLE ${role}`);
            await client.query(`UPDATE firm SET status = 'DELETED' WHERE id = $1`, [b.firmId]);
          }),
        ),
      ).toBe('42501');
    }
    expect(
      await failure(
        t.ownerTransaction(async (client) => {
          await client.query(
            `SELECT set_config('app.firm_id', '01920000-0000-7000-8000-0000000000fe', true)`,
          );
          await client.query(
            `INSERT INTO firm (id, name, settings, status) VALUES ('01920000-0000-7000-8000-0000000000fe', 'Riverbend', '{}', 'DELETED')`,
          );
        }),
      ),
    ).toBe('42501');
  });

  it('removes every row of the account, its audit trail included, and nothing of another', async () => {
    await pendingSince(b.firmId, 31);
    const before = await counts(b.firmId);
    // Every table holds rows of the account before the purge, so the counts below prove something.
    expect(Object.keys(before).filter((k) => before[k] === 0)).toEqual([]);
    const otherBefore = await contents(a.firmId);
    const platformBefore = await platformCounts(b.firmId);
    expect(await asOperator((tx) => r.platformAccounts.dueForPurge(tx))).toEqual([b.firmId]);

    const removed = await asOperator((tx) => r.platformAccounts.purge(tx, b.firmId));

    expect(removed).toEqual(before);
    expect(Object.values(await counts(b.firmId)).every((n) => n === 0)).toBe(true);
    expect(await contents(a.firmId)).toEqual(otherBefore);

    const tombstone = await asOperator((tx) => r.platformAccounts.get(tx, b.firmId));
    expect(tombstone).toMatchObject({
      id: b.firmId,
      status: 'DELETED',
      name: 'Second Ledger Consulting',
    });
    const { rows } = await t.ownerTransaction(async (client) => {
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [b.firmId]);
      return client.query<{ settings: unknown; profile: unknown }>(
        'SELECT settings, profile FROM firm WHERE id = $1',
        [b.firmId],
      );
    });
    expect(rows[0]).toEqual({ settings: {}, profile: {} });

    const { rows: trail } = await t.ownerQuery<{
      operator_id: string | null;
      before: unknown;
      after: unknown;
    }>(
      `SELECT operator_id, before, after FROM platform.operator_audit_event
       WHERE account_id = $1 AND action = 'ACCOUNT_PURGE'`,
      [b.firmId],
    );
    expect(trail).toEqual([
      {
        operator_id: null,
        before: { status: 'PENDING_DELETION' },
        after: { status: 'DELETED', rows: before },
      },
    ]);
    const platformAfter = await platformCounts(b.firmId);
    expect(platformAfter).toEqual({
      ...platformBefore,
      operator_audit_event: platformBefore.operator_audit_event! + 1,
    });
  });

  it('sweeps a deleted account again with zero counts and no trail row, and it stays deleted', async () => {
    const trailBefore = await purgeTrail(b.firmId);
    const zero = Object.fromEntries(tenantTables.map((n) => [n, 0]));
    expect(await asOperator((tx) => r.platformAccounts.purge(tx, b.firmId))).toEqual(zero);
    expect(await purgeTrail(b.firmId)).toEqual(trailBefore);
    expect(await asOperator((tx) => r.platformAccounts.dueForPurge(tx))).toEqual([]);
    expect(
      await failure(
        t.ownerTransaction(async (client) => {
          await client.query(`SELECT set_config('app.firm_id', $1, true)`, [b.firmId]);
          await client.query(`UPDATE firm SET status = 'ACTIVE' WHERE id = $1`, [b.firmId]);
        }),
      ),
    ).toBe('23514');
  });

  it('puts app.firm_id back as the caller had it', async () => {
    const other = '01920000-0000-7000-8000-0000000000fe';
    const after = await asOperator(async (tx) => {
      const unset = (
        await tx.execute<{ v: string }>(sql`SELECT current_setting('app.firm_id', true) AS v`)
      ).rows[0]!.v;
      await r.platformAccounts.purge(tx, b.firmId);
      const restored = (
        await tx.execute<{ v: string }>(sql`SELECT current_setting('app.firm_id', true) AS v`)
      ).rows[0]!.v;
      await tx.execute(sql`SELECT set_config('app.firm_id', ${other}, true)`);
      await r.platformAccounts.purge(tx, b.firmId);
      const kept = (
        await tx.execute<{ v: string }>(sql`SELECT current_setting('app.firm_id', true) AS v`)
      ).rows[0]!.v;
      return { unset, restored, kept };
    });
    expect(after).toEqual({ unset: '', restored: '', kept: other });
  });

  it('removes on the next call a write that waited on the purge and committed after it', async () => {
    const c = await t.admin.createFirm({ name: 'Third Ledger Advisory' });
    await pendingSince(c, 31);
    let insert: Promise<void> | undefined;
    let waited = false;
    const first = await asOperator(async (tx) => {
      const counts = await r.platformAccounts.purge(tx, c);
      // A tenant write starts while the purge holds the firm's lock: its foreign key to firm waits for the commit.
      insert = t.ownerTransaction(async (client) => {
        await client.query(`SELECT set_config('app.firm_id', $1, true)`, [c]);
        await client.query(
          `INSERT INTO audit_event (firm_id, actor_kind, action, entity_type, entity_id, request_id)
           VALUES ($1, 'SYSTEM', 'UPDATE', 'client', $1, 'purge-straggler')`,
          [c],
        );
        // ownerTransaction rolls back when fn returns; this write must land.
        await client.query('COMMIT');
      });
      for (let i = 0; i < 100; i++) {
        const { rows } = await t.ownerQuery<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO audit_event%'`,
        );
        waited = Number(rows[0]!.n) > 0;
        if (waited) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return counts;
    });
    await insert;
    expect(waited).toBe(true);
    expect(first.audit_event).toBe(0);
    expect((await counts(c)).audit_event).toBe(1);

    const second = await asOperator((tx) => r.platformAccounts.purge(tx, c));
    expect(second).toEqual({
      ...Object.fromEntries(tenantTables.map((n) => [n, 0])),
      audit_event: 1,
    });
    expect(Object.values(await counts(c)).every((n) => n === 0)).toBe(true);
    const trail = await purgeTrail(c);
    expect(trail).toHaveLength(2);
    expect(trail[1]).toEqual({
      before: { status: 'DELETED' },
      after: { status: 'DELETED', rows: second },
    });
  });

  it('the owner still cannot delete audit rows of a deleted account', async () => {
    for (const role of ['canopy_app', 'canopy_operator', null]) {
      expect(
        await failure(
          t.ownerTransaction(async (client) => {
            await client.query(`SELECT set_config('app.firm_id', $1, true)`, [b.firmId]);
            await client.query(
              `INSERT INTO audit_event (firm_id, actor_kind, action, entity_type, entity_id, request_id)
               VALUES ($1, 'SYSTEM', 'UPDATE', 'client', $1, 'purge-test')`,
              [b.firmId],
            );
            if (role) await client.query(`SET LOCAL ROLE ${role}`);
            await client.query('DELETE FROM audit_event WHERE firm_id = $1', [b.firmId]);
          }),
        ),
      ).toBe('42501');
    }
  });
});
