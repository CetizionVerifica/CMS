import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { TABLES } from './support/tables.js';

/**
 * Catalogue checks that hold for every table, present and future: a table added without `firm_id`,
 * forced RLS, a policy, the no-delete grant set or an isolation fixture fails here.
 */

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

async function publicTables(): Promise<{ name: string; rls: boolean; force: boolean }[]> {
  const { rows } = await t.ownerQuery<{ name: string; rls: boolean; force: boolean }>(`
    SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname`);
  return rows;
}

describe('every table', () => {
  it('is declared in the Drizzle schema, and the other way round', async () => {
    expect((await publicTables()).map((r) => r.name)).toEqual(TABLES.map((x) => x.name));
  });

  it('has RLS enabled and forced', async () => {
    for (const table of await publicTables()) {
      expect({ table: table.name, rls: table.rls, force: table.force }).toEqual({
        table: table.name,
        rls: true,
        force: true,
      });
    }
  });

  it('has a tenant policy on firm_id (firm: on id)', async () => {
    const { rows } = await t.ownerQuery<{ table: string; qual: string; check: string }>(`
      SELECT tablename AS table, qual, with_check AS check FROM pg_policies WHERE schemaname = 'public'`);
    for (const { name } of TABLES) {
      const policies = rows.filter((p) => p.table === name);
      expect(policies.length, `${name} has no policy`).toBeGreaterThan(0);
      for (const p of policies) {
        const column = name === 'firm' ? 'id' : 'firm_id';
        expect(p.qual, name).toContain(`${column} = app_firm_id()`);
        expect(p.check, name).toContain(`${column} = app_firm_id()`);
      }
    }
  });

  it('carries a non-null firm_id that references firm', async () => {
    const { rows } = await t.ownerQuery<{ table: string; nullable: string }>(`
      SELECT table_name AS table, is_nullable AS nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'firm_id'`);
    for (const { name } of TABLES.filter((x) => x.name !== 'firm')) {
      expect(rows.find((r) => r.table === name)?.nullable, name).toBe('NO');
    }
    const fks = await t.ownerQuery<{ table: string }>(`
      SELECT DISTINCT tc.table_name AS table FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage cu ON cu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND cu.table_name = 'firm' AND cu.column_name = 'id'`);
    expect(fks.rows.map((r) => r.table).sort()).toEqual(
      TABLES.map((x) => x.name).filter((n) => n !== 'firm'),
    );
  });

  it('gives the app role no DELETE or TRUNCATE, and audit_event no UPDATE', async () => {
    const { rows } = await t.ownerQuery<{ table: string; privilege: string }>(`
      SELECT table_name AS table, privilege_type AS privilege FROM information_schema.role_table_grants
      WHERE grantee = 'canopy_app' AND table_schema = 'public'`);
    expect(rows.filter((r) => r.privilege === 'DELETE' || r.privilege === 'TRUNCATE')).toEqual([]);
    const audit = rows
      .filter((r) => r.table === 'audit_event')
      .map((r) => r.privilege)
      .sort();
    expect(audit).toEqual(['INSERT', 'SELECT']);
    const firm = rows
      .filter((r) => r.table === 'firm')
      .map((r) => r.privilege)
      .sort();
    expect(firm).toEqual(['SELECT', 'UPDATE']);
    for (const { name } of TABLES.filter((x) => !['audit_event', 'firm'].includes(x.name))) {
      const granted = rows
        .filter((r) => r.table === name)
        .map((r) => r.privilege)
        .sort();
      expect(granted, name).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    }
  });

  it('keeps updated_at current wherever the column exists', async () => {
    const { rows } = await t.ownerQuery<{ table: string }>(`
      SELECT event_object_table AS table FROM information_schema.triggers
      WHERE trigger_schema = 'public' AND action_statement LIKE '%canopy_touch_updated_at%'`);
    const withColumn = TABLES.filter((x) => x.columns.includes('updated_at')).map((x) => x.name);
    expect([...new Set(rows.map((r) => r.table))].sort()).toEqual(withColumn);
  });

  it('the app role cannot bypass RLS', async () => {
    const { rows } = await t.ownerQuery(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'canopy_app'`,
    );
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolcanlogin: false }]);
  });

  it('stores due dates and periods as date, event times as timestamptz', async () => {
    const { rows } = await t.ownerQuery<{ table: string; column: string; type: string }>(`
      SELECT table_name AS table, column_name AS column, data_type AS type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name ~ '(_date|_on|_at)$|^at$|^period_|^active_'`);
    for (const r of rows) {
      const expected = /(_at|^at)$/.test(r.column) ? 'timestamp with time zone' : 'date';
      expect(`${r.table}.${r.column}: ${r.type}`).toBe(`${r.table}.${r.column}: ${expected}`);
    }
  });
});
