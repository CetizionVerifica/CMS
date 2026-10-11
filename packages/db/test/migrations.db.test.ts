import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { populateFirm } from './support/populate.js';
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
      await populateFirm(t.db, await t.admin.createFirm({ name }), label);
    }
  },
};

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
});
