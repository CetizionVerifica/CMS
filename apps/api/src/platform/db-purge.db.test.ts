import { platformAccounts } from '@canopy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_PURGE, accountPurgeJob, runAccountPurge } from './db-purge.js';
import { createPlatformTestDatabase, type PlatformTestDatabase } from './db-testing.js';
import type { AccountObjects } from './purge-objects.js';

// The nightly account purge against Postgres 16 (CI `db` job), on the console's own login (ADR M15-0002 decision 5).
const url = process.env.DATABASE_URL;

describe.skipIf(!url)(ACCOUNT_PURGE, () => {
  let t: PlatformTestDatabase;
  let steps: string[];
  const objects: AccountObjects = {
    deletePrefix: async (prefix) => {
      steps.push(`files ${prefix}`);
      return 2;
    },
  };
  const deps = () => ({ db: t.operatorDb, objects });

  /** An account with one audit row, PENDING_DELETION since `days` ago (or ACTIVE with null). */
  async function account(name: string, days: number | null): Promise<string> {
    const id = await t.admin.createFirm({ name });
    await t.ownerQuery(
      id,
      `INSERT INTO audit_event (firm_id, actor_kind, action, entity_type, entity_id, request_id)
       VALUES ('${id}', 'SYSTEM', 'UPDATE', 'client', '${id}', 'purge-job-test')`,
    );
    if (days !== null) {
      // The deletion clock writes only now(); the test moves the request back in time around it.
      await t.ownerQuery(
        id,
        `ALTER TABLE firm DISABLE TRIGGER firm_deletion_clock;
         UPDATE firm SET status = 'PENDING_DELETION', status_before_deletion = 'ACTIVE',
           deletion_requested_at = now() - interval '${days} days' WHERE id = '${id}';
         ALTER TABLE firm ENABLE TRIGGER firm_deletion_clock;`,
      );
    }
    return id;
  }
  const status = (id: string) =>
    t.operatorDb.withOperator('test', async (tx) => (await platformAccounts.get(tx, id))!.status);

  beforeAll(async () => {
    t = await createPlatformTestDatabase(url!);
    steps = [];
  });
  afterAll(async () => t?.drop());

  it('does nothing on a night when no account is due', async () => {
    await account('Kestrel Fibres', null);
    await account('Osprey Textiles Group', 10);
    expect(await runAccountPurge(deps(), 'job:purge:empty')).toEqual({
      due: 0,
      purged: 0,
      notDue: 0,
      swept: 0,
      objects: 0,
      rows: 0,
    });
    expect(steps).toEqual([]);
  });

  it('deletes an account’s files, then its rows, once its 30 days are over', async () => {
    const gone = await account('Stonebridge Advisory', 31);
    const kept = await account('Highmoor Fabrics', 29);
    const original = steps.length;
    const purge = accountPurgeJob(t.operatorDb, {
      deletePrefix: async (prefix) => {
        // The files go while the account still has its rows.
        expect(await status(gone)).toBe('PENDING_DELETION');
        return objects.deletePrefix(prefix);
      },
    });
    expect(purge).toMatchObject({ name: ACCOUNT_PURGE, sendsMail: false, catchUp: true });

    expect(await purge.run({} as never, 'job:purge:1')).toEqual({
      due: 1,
      purged: 1,
      notDue: 0,
      swept: 0,
      objects: 6,
      rows: 1,
    });
    expect(steps.slice(original)).toEqual([
      `files evidence/${gone}/`,
      `files imports/${gone}/`,
      `files exports/${gone}/`,
    ]);
    expect(await status(gone)).toBe('DELETED');
    expect(await status(kept)).toBe('PENDING_DELETION');
    expect(
      await t.ownerQuery(kept, `SELECT 1 FROM audit_event WHERE firm_id = '${kept}'`),
    ).toHaveLength(1);
    expect(await t.ownerQuery(gone, `SELECT 1 FROM audit_event WHERE firm_id = '${gone}'`)).toEqual(
      [],
    );

    // The next night sweeps it again, files and rows, and finds nothing left.
    expect(await runAccountPurge(deps(), 'job:purge:2')).toMatchObject({
      due: 0,
      purged: 0,
      swept: 1,
      rows: 0,
    });
  });

  it('keeps the rows when the files fail, and finishes on the next run', async () => {
    const id = await account('Riverbend Works', 40);
    const failing: AccountObjects = {
      deletePrefix: async () => {
        throw new Error('storage unavailable');
      },
    };
    await expect(
      runAccountPurge({ db: t.operatorDb, objects: failing }, 'job:purge:3'),
    ).rejects.toThrow('storage unavailable');
    expect(await status(id)).toBe('PENDING_DELETION');
    expect(await runAccountPurge(deps(), 'job:purge:4')).toMatchObject({ due: 1, purged: 1 });
    expect(await status(id)).toBe('DELETED');
  });

  it('purges an account once when two runs overlap: the second waits for the lock, then skips it', async () => {
    const id = await account('Kestrelganj Mills', 35);
    let first = true;
    const slow: AccountObjects = {
      deletePrefix: async () => {
        if (first) {
          first = false;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return 0;
      },
    };
    const [a, b] = await Promise.all([
      runAccountPurge({ db: t.operatorDb, objects: slow }, 'job:purge:5a'),
      runAccountPurge({ db: t.operatorDb, objects: slow }, 'job:purge:5b'),
    ]);
    expect([a!.purged! + b!.purged!, a!.notDue! + b!.notDue!]).toEqual([1, 1]);
    expect(await status(id)).toBe('DELETED');
  });

  it('sweeps an account purged this past week again, and leaves older ones alone', async () => {
    const recent = await account('Highmoor Mills', 31);
    await runAccountPurge(deps(), 'job:purge:6');
    expect(await status(recent)).toBe('DELETED');
    const old = await account('Osprey Mills', 31);
    await runAccountPurge(deps(), 'job:purge:7');
    await t.ownerQuery(
      old,
      `ALTER TABLE firm DISABLE TRIGGER firm_deletion_clock;
       UPDATE firm SET deletion_requested_at = now() - interval '38 days' WHERE id = '${old}';
       ALTER TABLE firm ENABLE TRIGGER firm_deletion_clock;`,
    );
    // A write that committed after the purge's snapshot.
    await t.ownerQuery(
      recent,
      `INSERT INTO audit_event (firm_id, actor_kind, action, entity_type, entity_id, request_id)
       VALUES ('${recent}', 'SYSTEM', 'UPDATE', 'client', '${recent}', 'late-write')`,
    );
    steps = [];
    const report = await runAccountPurge(deps(), 'job:purge:8');
    expect(report).toMatchObject({ due: 0, rows: 1 });
    expect(steps).toEqual(
      expect.arrayContaining([
        `files evidence/${recent}/`,
        `files imports/${recent}/`,
        `files exports/${recent}/`,
      ]),
    );
    expect(steps.some((s) => s.includes(old))).toBe(false);
    expect(
      await t.ownerQuery(recent, `SELECT 1 FROM audit_event WHERE firm_id = '${recent}'`),
    ).toEqual([]);
  });
});
