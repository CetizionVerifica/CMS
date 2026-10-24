import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminDatabase, createDatabase, MIGRATIONS_FOLDER } from '../src/database.js';
import { createTestDatabase, databaseUrl, type TestDatabase } from './support/database.js';
import {
  populateAuth,
  populateFirm,
  populateIdempotency,
  populateSupport,
  type PopulatedFirm,
} from './support/populate.js';
import { TABLES, tenantColumn } from './support/tables.js';

/**
 * Migrations apply on an empty database and on a populated one (MODULES.md M3 Accept).
 * The populated run applies migrations one at a time; after each one that has a populate step in
 * POPULATE, it writes rows valid for the schema at that point, so every later migration runs against
 * existing data. A migration that changes existing tables adds a populate step for the state before it.
 */

interface Journal {
  entries: { idx: number; tag: string }[];
}
const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
) as Journal;

/** Rows written after the named migration has been applied. */
const POPULATE: Record<string, (t: TestDatabase) => Promise<void>> = {
  '0002_grants_and_triggers': async (t) => {
    for (const [name, label] of [
      ['Demo Advisory', 'a'],
      ['Second Ledger Consulting', 'b'],
    ] as const) {
      populated[label] = await populateFirm(t.db, await t.admin.createFirm({ name }), label);
    }
  },
  '0012_auth_lookups': async (t) => {
    for (const label of ['a', 'b'] as const) await populateAuth(t.db, populated[label]!, label);
  },
  '0015_idempotency_key_grants': async (t) => {
    for (const label of ['a', 'b'] as const)
      await populateIdempotency(t.db, populated[label]!, label);
  },
  '0020_platform_roles_and_functions': async (t) => {
    for (const label of ['a', 'b'] as const) await populateSupport(t.db, populated[label]!, label);
  },
};
const populated: Record<string, PopulatedFirm> = {};

/** A migrations folder holding only the first `count` journal entries. */
function folderWithFirst(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'canopy-migrations-'));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const partial: Journal = { ...journal, entries: journal.entries.slice(0, count) };
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(partial));
  return dir;
}

async function rowCounts(t: TestDatabase): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { name } of TABLES) {
    const { rows } = await t.ownerQuery<{ n: number }>(
      `SELECT count(DISTINCT ${tenantColumn(name)})::int + count(*)::int AS n FROM "${name}"`,
    );
    counts[name] = rows[0]!.n;
  }
  return counts;
}

let t: TestDatabase | undefined;
afterEach(async () => {
  await t?.drop();
  t = undefined;
});

describe('migrations', () => {
  it('every journal entry has its SQL file, in order', () => {
    journal.entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
      expect(existsSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`)), entry.tag).toBe(true);
    });
    expect(Object.keys(POPULATE).every((tag) => journal.entries.some((e) => e.tag === tag))).toBe(
      true,
    );
  });

  it('apply on an empty database, and a second run is a no-op', async () => {
    t = await createTestDatabase({ migrate: false });
    await t.admin.migrate();
    const applied = await t.ownerQuery(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
    );
    expect(applied.rows[0]).toEqual({ n: journal.entries.length });
    await t.admin.migrate();
    const again = await t.ownerQuery('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    expect(again.rows[0]).toEqual({ n: journal.entries.length });
  });

  it('apply one at a time on a populated database without losing rows', async () => {
    t = await createTestDatabase({ migrate: false });
    let populated = false;
    for (let i = 1; i <= journal.entries.length; i++) {
      await t.admin.migrate(folderWithFirst(i));
      const step = POPULATE[journal.entries[i - 1]!.tag];
      if (step) {
        await step(t);
        populated = true;
      }
    }
    expect(populated).toBe(true);
    const before = await rowCounts(t);
    await t.admin.migrate();
    expect(await rowCounts(t)).toEqual(before);
    for (const [table, n] of Object.entries(before)) expect(n, table).toBeGreaterThan(0);
  });

  it('apply as a non-superuser owner, and the SECURITY DEFINER lookups still see every firm', async () => {
    // Production owners are not superusers, and FORCE RLS binds the table owner (ADR 0003). An
    // administrator prepares the owner once (packages/db/CLAUDE.md, Deploy); this test does the same.
    const suffix = randomBytes(4).toString('hex');
    const owner = `canopy_owner_${suffix}`;
    const name = `canopy_test_owner_${suffix}`;
    const password = randomBytes(12).toString('hex');
    const base = new URL(databaseUrl());
    const server = new pg.Client({ connectionString: base.toString() });
    await server.connect();
    await server.query(
      `DO $$ BEGIN CREATE ROLE canopy_app NOLOGIN; EXCEPTION WHEN OTHERS THEN NULL; END $$`,
    );
    await server.query(
      `DO $$ BEGIN CREATE ROLE canopy_lookup NOLOGIN; EXCEPTION WHEN OTHERS THEN NULL; END $$`,
    );
    for (const role of ['canopy_operator', 'canopy_platform']) {
      await server.query(
        `DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN OTHERS THEN NULL; END $$`,
      );
    }
    // canopy_platform owns the account functions (migration 0020), so the owner must be able to SET ROLE to it.
    await server.query(
      `CREATE ROLE ${owner} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}' IN ROLE canopy_app, canopy_lookup, canopy_platform`,
    );
    // Functions with `SET app.all_clients` (migrations 0003, 0005) need this grant on a non-superuser.
    await server.query(`GRANT SET ON PARAMETER app.all_clients TO ${owner}`);
    await server.query(`CREATE DATABASE ${name} OWNER ${owner}`);
    const url = new URL(base);
    url.username = owner;
    url.password = password;
    url.pathname = `/${name}`;
    const admin = createAdminDatabase({ connectionString: url.toString() });
    const db = createDatabase({ connectionString: url.toString(), max: 2 });
    try {
      await admin.migrate();
      const firms = [
        await admin.createFirm({ name: 'Demo Advisory' }),
        await admin.createFirm({ name: 'Second Ledger Consulting' }),
      ];
      expect((await db.listFirmIds()).sort()).toEqual(firms.sort());
    } finally {
      await Promise.all([db.close(), admin.close()]);
      await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await server.query(`REVOKE SET ON PARAMETER app.all_clients FROM ${owner}`);
      await server.query(`DROP ROLE IF EXISTS ${owner}`);
      await server.end();
    }
  });
});
