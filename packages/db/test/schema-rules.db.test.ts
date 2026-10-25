import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { PLATFORM_TABLES, TABLES } from './support/tables.js';

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

function sqlState(error: unknown): string | undefined {
  let e: unknown = error;
  while (e && typeof e === 'object') {
    if ('code' in e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    e = 'cause' in e ? e.cause : undefined;
  }
  return undefined;
}

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

  it('has tenant policies on firm_id (firm: on id) covering select, insert and update', async () => {
    const { rows } = await t.ownerQuery<{
      table: string;
      cmd: string;
      qual: string | null;
      check: string | null;
    }>(`
      SELECT tablename AS table, cmd, qual, with_check AS check FROM pg_policies
      WHERE schemaname = 'public' AND roles NOT IN ('{canopy_lookup}', '{canopy_operator}')`);
    for (const { name } of TABLES) {
      const policies = rows.filter((p) => p.table === name);
      const commands = new Set(policies.map((p) => p.cmd));
      expect(
        commands.has('ALL') || ['SELECT', 'INSERT', 'UPDATE'].every((c) => commands.has(c)),
        `${name} policies: ${[...commands].join(', ')}`,
      ).toBe(true);
      const column = name === 'firm' ? 'id' : 'firm_id';
      for (const p of policies) {
        for (const expression of [p.qual, p.check]) {
          if (expression !== null)
            expect(expression, `${name} ${p.cmd}`).toContain(`${column} = app_firm_id()`);
        }
        if (p.cmd !== 'INSERT') expect(p.qual, `${name} ${p.cmd}`).not.toBeNull();
        if (p.cmd !== 'SELECT' && p.cmd !== 'DELETE') {
          expect(p.check, `${name} ${p.cmd}`).not.toBeNull();
        }
      }
    }
  });

  it('limits canopy_lookup to read policies and column grants on ids', async () => {
    const policies = await t.ownerQuery<{ table: string; cmd: string; roles: string[] }>(`
      SELECT tablename AS table, cmd, roles::text[] AS roles FROM pg_policies
      WHERE schemaname = 'public' AND 'canopy_lookup' = ANY (roles)`);
    for (const p of policies.rows) {
      expect(`${p.table} ${p.cmd} ${p.roles.join(',')}`).toBe(`${p.table} SELECT canopy_lookup`);
    }
    const tables = await t.ownerQuery(`
      SELECT table_name FROM information_schema.role_table_grants
      WHERE grantee = 'canopy_lookup' AND table_schema = 'public'`);
    expect(tables.rows).toEqual([]);
    const role = await t.ownerQuery(`
      SELECT rolsuper, rolbypassrls, rolcanlogin,
             pg_has_role('canopy_app', 'canopy_lookup', 'MEMBER') AS app_member,
             has_schema_privilege('canopy_lookup', 'public', 'CREATE') AS can_create
      FROM pg_roles WHERE rolname = 'canopy_lookup'`);
    expect(role.rows).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcanlogin: false,
        app_member: false,
        can_create: false,
      },
    ]);
    const owned = await t.ownerQuery<{ name: string; definer: boolean; config: string[] | null }>(`
      SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = 'canopy_lookup'`);
    expect(owned.rows.length).toBeGreaterThan(0);
    for (const f of owned.rows) {
      expect(f.definer, f.name).toBe(true);
      expect(f.config, f.name).toContain('search_path=public, pg_temp');
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
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
        AND cu.table_name = 'firm' AND cu.column_name = 'id'`);
    expect(fks.rows.map((r) => r.table).sort()).toEqual(
      TABLES.map((x) => x.name).filter((n) => n !== 'firm'),
    );
  });

  const DELETABLE = ['import_issue', 'idempotency_key'];

  it('gives the app role no TRUNCATE, DELETE only on import_issue and idempotency_key, and audit_event no UPDATE', async () => {
    const { rows } = await t.ownerQuery<{ table: string; privilege: string }>(`
      SELECT table_name AS table, privilege_type AS privilege FROM information_schema.role_table_grants
      WHERE grantee = 'canopy_app' AND table_schema = 'public'`);
    // import_issue is regenerated by each analysis (migration 0009) and expired idempotency keys are
    // purged (migration 0015); nothing else is ever deleted.
    expect(
      rows.filter(
        (r) =>
          r.privilege === 'TRUNCATE' || (r.privilege === 'DELETE' && !DELETABLE.includes(r.table)),
      ),
    ).toEqual([]);
    const audit = rows
      .filter((r) => r.table === 'audit_event')
      .map((r) => r.privilege)
      .sort();
    expect(audit).toEqual(['INSERT', 'SELECT']);
    const firm = rows
      .filter((r) => r.table === 'firm')
      .map((r) => r.privilege)
      .sort();
    expect(firm).toEqual(['SELECT']);
    // An account admin renames the firm and edits its settings, never its status or plan (ADR M15-0001 decision 8).
    const columns = await t.ownerQuery<{ column: string }>(`
      SELECT column_name AS column FROM information_schema.column_privileges
      WHERE grantee = 'canopy_app' AND table_schema = 'public' AND table_name = 'firm'
        AND privilege_type = 'UPDATE' ORDER BY column_name`);
    expect(columns.rows.map((r) => r.column)).toEqual(['name', 'settings', 'version']);
    // A support grant is revoked, never re-pointed or stretched (audit of #140, Low 4).
    const grantColumns = await t.ownerQuery<{ column: string }>(`
      SELECT column_name AS column FROM information_schema.column_privileges
      WHERE grantee = 'canopy_app' AND table_schema = 'public' AND table_name = 'support_grant'
        AND privilege_type = 'UPDATE' ORDER BY column_name`);
    expect(grantColumns.rows.map((r) => r.column)).toEqual([
      'revoked_at',
      'revoked_by_id',
      'updated_at',
    ]);
    expect(
      rows
        .filter((r) => r.table === 'support_grant')
        .map((r) => r.privilege)
        .sort(),
    ).toEqual(['INSERT', 'SELECT']);
    for (const { name } of TABLES.filter(
      (x) => !['audit_event', 'firm', 'support_grant'].includes(x.name),
    )) {
      const granted = rows
        .filter((r) => r.table === name)
        .map((r) => r.privilege)
        .sort();
      expect(granted, name).toEqual(
        DELETABLE.includes(name)
          ? ['DELETE', 'INSERT', 'SELECT', 'UPDATE']
          : ['INSERT', 'SELECT', 'UPDATE'],
      );
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

  it('gives pg-boss a schema of its own role, closed to the app and every other role (ADR M3-0004)', async () => {
    const { rows } = await t.ownerQuery<{ owner: string; open: string[] }>(`
      SELECT pg_get_userbyid(n.nspowner) AS owner,
        ARRAY(SELECT r FROM unnest(ARRAY['canopy_app', 'canopy_lookup', 'canopy_platform', 'canopy_operator']) r
              WHERE has_schema_privilege(r, n.oid, 'USAGE') OR has_schema_privilege(r, n.oid, 'CREATE')) AS open
      FROM pg_namespace n WHERE n.nspname = 'pgboss'`);
    expect(rows).toEqual([{ owner: 'canopy_jobs', open: [] }]);
    const role = await t.ownerQuery(`
      SELECT rolsuper, rolbypassrls, rolcanlogin,
        pg_has_role('canopy_jobs', 'canopy_app', 'MEMBER') AS jobs_is_app,
        pg_has_role('canopy_app', 'canopy_jobs', 'MEMBER') AS app_is_jobs
      FROM pg_roles WHERE rolname = 'canopy_jobs'`);
    expect(role.rows).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcanlogin: false,
        jobs_is_app: false,
        app_is_jobs: false,
      },
    ]);
  });

  it('a tenant transaction cannot reach the job queue', async () => {
    const firm = await t.admin.createFirm({ name: 'Queue Probe Advisory' });
    const error: unknown = await t.db
      .withTenant(systemContext(firm, 'schema-rules'), (tx) =>
        tx.execute(sql`CREATE TABLE pgboss.probe (id int)`),
      )
      .catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
  });

  it('stores due dates and periods as date, event times as timestamptz', async () => {
    const { rows } = await t.ownerQuery<{ table: string; column: string; type: string }>(`
      SELECT table_name AS table, column_name AS column, data_type AS type FROM information_schema.columns
      WHERE table_schema IN ('public', 'platform')
        AND column_name ~ '(_date|_on|_at)$|^at$|^period_|^active_'
        AND NOT (table_schema = 'platform' AND column_name = 'active_users_30d')`);
    for (const r of rows) {
      const expected = /(_at|^at)$/.test(r.column) ? 'timestamp with time zone' : 'date';
      expect(`${r.table}.${r.column}: ${r.type}`).toBe(`${r.table}.${r.column}: ${expected}`);
    }
  });
});

/** The operator side (ADR M15-0001 decisions 2, 8 and 12). */
describe('platform schema and operator roles', () => {
  async function tableGrants(role: string, schema: string) {
    const { rows } = await t.ownerQuery<{ table: string; privilege: string }>(
      `SELECT table_name AS table, privilege_type AS privilege FROM information_schema.role_table_grants
       WHERE grantee = $1 AND table_schema = $2 ORDER BY 1, 2`,
      [role, schema],
    );
    const out: Record<string, string[]> = {};
    for (const r of rows) (out[r.table] ??= []).push(r.privilege);
    return out;
  }

  it('declares every platform table in Drizzle, and the other way round', async () => {
    const { rows } = await t.ownerQuery<{ name: string }>(`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'platform' AND c.relkind IN ('r', 'p') ORDER BY c.relname`);
    expect(rows.map((r) => r.name)).toEqual(PLATFORM_TABLES.map((x) => x.name));
  });

  it('keeps the app role out of schema platform', async () => {
    const { rows } = await t.ownerQuery(
      `SELECT has_schema_privilege('canopy_app', 'platform', 'USAGE') AS usage`,
    );
    expect(rows).toEqual([{ usage: false }]);
    expect(await tableGrants('canopy_app', 'platform')).toEqual({});
  });

  it('gives canopy_operator the platform tables, append-only audit, and no client tables', async () => {
    const platform = await tableGrants('canopy_operator', 'platform');
    for (const { name } of PLATFORM_TABLES) {
      expect(platform[name], name).toEqual(
        name === 'operator_audit_event' ? ['INSERT', 'SELECT'] : ['INSERT', 'SELECT', 'UPDATE'],
      );
    }
    expect(await tableGrants('canopy_operator', 'public')).toEqual({ firm: ['SELECT'] });
    const columns = await t.ownerQuery<{ table: string; column: string; privilege: string }>(`
      SELECT table_name AS table, column_name AS column, privilege_type AS privilege
      FROM information_schema.column_privileges
      WHERE grantee = 'canopy_operator' AND table_schema = 'public' AND table_name <> 'firm'
      ORDER BY 1, 3, 2`);
    expect(columns.rows).toEqual(
      ['ends_at', 'firm_id', 'id', 'level', 'revoked_at', 'starts_at'].map((column) => ({
        table: 'support_grant',
        column,
        privilege: 'SELECT',
      })),
    );
    const updates = await t.ownerQuery<{ column: string }>(`
      SELECT column_name AS column FROM information_schema.column_privileges
      WHERE grantee = 'canopy_operator' AND table_name = 'firm' AND privilege_type = 'UPDATE'
      ORDER BY 1`);
    expect(updates.rows.map((r) => r.column)).toEqual([
      'deletion_requested_at',
      'name',
      'onboarded_at',
      'plan_code',
      'profile',
      'status',
      'status_before_deletion',
      'trial_ends_on',
      'version',
    ]);
  });

  it('gives canopy_operator its own policies on firm and support_grant only, never DELETED firms to update', async () => {
    const { rows } = await t.ownerQuery<{ table: string; cmd: string; qual: string | null }>(`
      SELECT tablename AS table, cmd, qual FROM pg_policies
      WHERE 'canopy_operator' = ANY (roles) ORDER BY 1, 2`);
    expect(rows.map((r) => `${r.table} ${r.cmd}`)).toEqual([
      'firm SELECT',
      'firm UPDATE',
      'support_grant SELECT',
    ]);
    expect(rows.find((r) => r.cmd === 'UPDATE')?.qual).toContain('DELETED');
  });

  it('makes canopy_operator and canopy_platform plain roles outside the app role', async () => {
    const { rows } = await t.ownerQuery(`
      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin,
             pg_has_role('canopy_app', oid, 'MEMBER') AS app_member,
             has_schema_privilege(oid, 'public', 'CREATE') AS can_create
      FROM pg_roles WHERE rolname IN ('canopy_operator', 'canopy_platform') ORDER BY rolname`);
    expect(rows).toEqual(
      ['canopy_operator', 'canopy_platform'].map((rolname) => ({
        rolname,
        rolsuper: false,
        rolbypassrls: false,
        rolcanlogin: false,
        app_member: false,
        can_create: false,
      })),
    );
    const operatorIsPlatform = await t.ownerQuery(
      `SELECT pg_has_role('canopy_operator', 'canopy_platform', 'MEMBER') AS m`,
    );
    expect(operatorIsPlatform.rows).toEqual([{ m: false }]);
  });

  it('runs every cross-wall write as a canopy_platform definer function the operator alone may call', async () => {
    const { rows } = await t.ownerQuery<{
      name: string;
      definer: boolean;
      config: string[] | null;
      operator: boolean;
      app: boolean;
    }>(`
      SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config,
             has_function_privilege('canopy_operator', p.oid, 'EXECUTE') AS operator,
             has_function_privilege('canopy_app', p.oid, 'EXECUTE') AS app
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = 'canopy_platform'
      ORDER BY p.proname`);
    expect(rows.map((r) => r.name)).toEqual([
      'app_account',
      'app_end_trial',
      'app_mark_iso_catalogue_copied',
      'app_mark_library_copied',
      'app_record_support_expiry',
      'app_subscription_ends_on',
      'app_take_usage_snapshot',
      'app_usage',
      'canopy_activate_account',
      'canopy_audit_support_grant',
      'platform_create_account',
      'platform_issue_support_token',
      'platform_provision_account',
      'platform_record_account_event',
      'platform_resend_owner_invite',
      'platform_usage',
    ]);
    for (const f of rows) {
      expect(f.definer, f.name).toBe(true);
      expect(f.config, f.name).toContain('search_path=public, pg_temp');
      // app_* are the app's own reads of its account; every platform_* is the operator's; the trigger is nobody's.
      expect({ operator: f.operator, app: f.app }, f.name).toEqual(
        f.name.startsWith('app_')
          ? { operator: false, app: true }
          : f.name.startsWith('platform_')
            ? { operator: true, app: false }
            : { operator: false, app: false },
      );
    }
  });
});
