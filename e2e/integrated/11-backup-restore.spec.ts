import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { systemContext, tenantSettings } from '@canopy/db';
import pg from 'pg';

import { seeded } from './helpers.js';
import {
  APP_LOGIN,
  APP_PASSWORD,
  E2E_DATABASE,
  FIRM_A,
  FIRM_B,
  RUN_DIR,
  databaseUrl,
} from './stack.js';

// The backup and restore drill (MODULES.md M14, docs/security/backup-restore.md), on every build: the run's database,
// after every other journey has written to it, is dumped with pg_dump, restored into a new database on the same
// server, and must come back whole: every table's rows, row-level security on with every policy, the migrations
// applied, and the app's login still held to its tenant. Needs pg_dump and pg_restore 16 or later on the PATH.
const RESTORED = `${E2E_DATABASE}_restore`;

async function query<T extends pg.QueryResultRow>(
  url: string,
  sql: string,
  params: unknown[] = [],
) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

type Run = <T extends pg.QueryResultRow>(sql: string) => Promise<T[]>;

/** Every table's row count and row-level security flags, and every policy, in a stable order. */
async function shape(run: Run) {
  const tables = await run<{ schema: string; name: string; rls: boolean; forced: boolean }>(
    `SELECT n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY 1, 2`,
  );
  const counts: Record<string, string> = {};
  for (const t of tables) {
    const [row] = await run<{ n: string }>(
      `SELECT count(*) AS n FROM ${pg.escapeIdentifier(t.schema)}.${pg.escapeIdentifier(t.name)}`,
    );
    counts[`${t.schema}.${t.name}`] = `${row!.n} rows, rls ${t.rls}/${t.forced}`;
  }
  const policies = await run<{ p: string }>(
    `SELECT schemaname || '.' || tablename || ' ' || policyname AS p FROM pg_policies ORDER BY 1`,
  );
  return { counts, policies: policies.map((r) => r.p) };
}

test('the database dumps and restores whole, with its tenant isolation', async () => {
  test.setTimeout(300_000);
  for (const tool of ['pg_dump', 'pg_restore']) {
    const version = execFileSync(tool, ['--version'], { encoding: 'utf8' });
    expect(Number(/(\d+)\./.exec(version)?.[1]), version).toBeGreaterThanOrEqual(16);
  }
  const base = process.env.DATABASE_URL!;
  const source = databaseUrl(base, E2E_DATABASE);
  const restored = databaseUrl(base, RESTORED);
  const dump = fileURLToPath(new URL('backup.dump', RUN_DIR));

  // The API and its jobs keep writing, as they would during a nightly backup. The dump and the counts it is checked
  // against read one exported snapshot, so they see exactly the same rows.
  const snapshot = new pg.Client({ connectionString: source });
  await snapshot.connect();
  let before: Awaited<ReturnType<typeof shape>>;
  const started = Date.now();
  try {
    await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const [{ id }] = (await snapshot.query<{ id: string }>('SELECT pg_export_snapshot() AS id'))
      .rows as [{ id: string }];
    before = await shape(async (sql) => (await snapshot.query(sql)).rows);
    execFileSync('pg_dump', [
      '--format=custom',
      `--snapshot=${id}`,
      '--file',
      dump,
      '--dbname',
      source,
    ]);
  } finally {
    await snapshot.query('COMMIT').catch(() => undefined);
    await snapshot.end();
  }
  const dumpedMs = Date.now() - started;

  await query(base, `DROP DATABASE IF EXISTS ${RESTORED} WITH (FORCE)`);
  await query(base, `CREATE DATABASE ${RESTORED}`);
  try {
    // Same server, so the roles the dump grants to (canopy_app, canopy_jobs, canopy_operator, ...) exist already.
    execFileSync('pg_restore', ['--exit-on-error', '--dbname', restored, dump]);
    const restoredMs = Date.now() - started - dumpedMs;
    console.log(
      `backup drill: ${Math.round(statSync(dump).size / 1024)} KiB dumped in ${dumpedMs} ms, restored in ${restoredMs} ms`,
    );

    const after = await shape(async (sql) => query(restored, sql));
    expect(after.counts).toEqual(before.counts);
    expect(after.policies).toEqual(before.policies);
    expect(after.policies.length).toBeGreaterThan(0);

    // The app's login reads the restored database through its tenant, and only its tenant.
    await query(base, `GRANT CONNECT ON DATABASE ${RESTORED} TO ${APP_LOGIN}`);
    const asApp = databaseUrl(base, RESTORED, [APP_LOGIN, APP_PASSWORD]);
    const { clients } = seeded();
    const instancesOf = async (firm: string) => {
      const client = new pg.Client({ connectionString: asApp });
      await client.connect();
      try {
        await client.query('BEGIN');
        // Exactly what withTenant sets for a firm-wide system context.
        for (const [name, value] of Object.entries(
          tenantSettings(systemContext(firm, 'e2e-restore')),
        )) {
          await client.query('SELECT set_config($1, $2, true)', [name, value]);
        }
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM compliance_instance WHERE client_id = $1`,
          [clients.kestrel],
        );
        await client.query('COMMIT');
        return Number(rows[0]!.n);
      } finally {
        await client.end();
      }
    };
    const [{ n: total }] = (await query<{ n: string }>(
      restored,
      `SELECT count(*) AS n FROM compliance_instance WHERE client_id = $1`,
      [clients.kestrel],
    )) as [{ n: string }];
    expect(Number(total)).toBeGreaterThan(0);
    expect(await instancesOf(FIRM_A)).toBe(Number(total));
    expect(await instancesOf(FIRM_B)).toBe(0);
  } finally {
    await query(base, `DROP DATABASE IF EXISTS ${RESTORED} WITH (FORCE)`);
  }
});
