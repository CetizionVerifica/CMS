import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createOperatorDatabase } from '../src/database.js';
import * as s from '../src/schema/index.js';
import { systemContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/**
 * A login that is a superuser, has BYPASSRLS or owns the tables could leave RLS with RESET ROLE inside
 * withTenant. In production createDatabase refuses such logins; a plain member of canopy_app works and
 * stays inside RLS even after RESET ROLE (audit finding 2 on PR #16).
 */

let t: TestDatabase;
let firmId: string;
const login = `canopy_login_${randomBytes(4).toString('hex')}`;
const password = randomBytes(12).toString('hex');
const suMember = `${login}_su`;
const bypass = `${login}_bypass`;
const bypassMember = `${login}_bym`;
const owner = `${login}_owner`;
const ownerMember = `${login}_ownm`;
const lookupMember = `${login}_lkm`;
const platformMember = `${login}_plm`;
const operatorMember = `${login}_opm`;
const operatorPlatformMember = `${login}_opp`;
// The operator console's own login (ADR M3-0002): a member of canopy_operator and nothing else.
const operatorLogin = `${login}_op`;

function urlAs(user: string, pass: string): string {
  const url = new URL(t.url);
  url.username = user;
  url.password = pass;
  return url.toString();
}

beforeAll(async () => {
  t = await createTestDatabase();
  firmId = await t.admin.createFirm({ name: 'Demo Advisory' });
  await t.admin.createFirm({ name: 'Second Ledger Consulting' });
  await t.ownerQuery(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE canopy_app`);
  // Logins that are plain themselves but can SET ROLE to a privileged role (re-audit finding B).
  const { rows } = await t.ownerQuery<{ me: string }>('SELECT current_user AS me');
  await t.ownerQuery(
    `CREATE ROLE ${suMember} LOGIN PASSWORD '${password}' IN ROLE canopy_app, "${rows[0]!.me}"`,
  );
  await t.ownerQuery(`CREATE ROLE ${bypass} NOLOGIN BYPASSRLS`);
  await t.ownerQuery(
    `CREATE ROLE ${bypassMember} LOGIN PASSWORD '${password}' IN ROLE canopy_app, ${bypass}`,
  );
  await t.ownerQuery(`CREATE ROLE ${owner} NOLOGIN`);
  await t.ownerQuery(`CREATE TABLE public.login_probe (id int)`);
  await t.ownerQuery(`ALTER TABLE public.login_probe OWNER TO ${owner}`);
  await t.ownerQuery(
    `CREATE ROLE ${ownerMember} LOGIN PASSWORD '${password}' IN ROLE canopy_app, ${owner}`,
  );
  await t.ownerQuery(
    `CREATE ROLE ${lookupMember} LOGIN PASSWORD '${password}' IN ROLE canopy_app, canopy_lookup`,
  );
  await t.ownerQuery(
    `CREATE ROLE ${platformMember} LOGIN PASSWORD '${password}' IN ROLE canopy_app, canopy_platform`,
  );
  await t.ownerQuery(
    `CREATE ROLE ${operatorMember} LOGIN PASSWORD '${password}' IN ROLE canopy_app, canopy_operator`,
  );
  await t.ownerQuery(
    `CREATE ROLE ${operatorLogin} LOGIN PASSWORD '${password}' IN ROLE canopy_operator`,
  );
  await t.ownerQuery(
    `CREATE ROLE ${operatorPlatformMember} LOGIN PASSWORD '${password}' IN ROLE canopy_operator, canopy_platform`,
  );
});

afterAll(async () => {
  await t?.ownerQuery('DROP TABLE IF EXISTS public.login_probe');
  for (const role of [
    login,
    suMember,
    bypassMember,
    bypass,
    ownerMember,
    owner,
    lookupMember,
    platformMember,
    operatorMember,
    operatorLogin,
    operatorPlatformMember,
  ]) {
    await t?.ownerQuery(`DROP ROLE IF EXISTS ${role}`);
  }
  await t?.drop();
});

describe('privileged logins', () => {
  it('are refused when the policy says refuse', async () => {
    const db = createDatabase({ connectionString: t.url, privilegedLogin: 'refuse' });
    try {
      await expect(db.withTenant(systemContext(firmId, 'r'), async () => 1)).rejects.toThrow(
        /Refusing tenant connections: the login is a superuser/,
      );
    } finally {
      await db.close();
    }
  });

  it.each([
    ['a superuser', () => suMember, /the login is a member of \w+, which is a superuser/],
    ['a BYPASSRLS role', () => bypassMember, /the login is a member of \w+, which has BYPASSRLS/],
    ['a table owner', () => ownerMember, /the login is a member of \w+, which owns tables/],
    [
      'canopy_lookup',
      () => lookupMember,
      /the login is a member of canopy_lookup, which reads across firms/,
    ],
    [
      'canopy_platform',
      () => platformMember,
      /the login is a member of canopy_platform, which writes across firms/,
    ],
    [
      'canopy_operator',
      () => operatorMember,
      /the login is a member of canopy_operator, which reads every account/,
    ],
  ])('are refused when the login is a member of %s', async (_label, user, reason) => {
    const db = createDatabase({
      connectionString: urlAs(user(), password),
      privilegedLogin: 'refuse',
    });
    try {
      await expect(db.withTenant(systemContext(firmId, 'r'), async () => 1)).rejects.toThrow(
        reason,
      );
    } finally {
      await db.close();
    }
  });

  it('are refused by default in production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const db = createDatabase({ connectionString: t.url });
    process.env.NODE_ENV = previous;
    try {
      await expect(db.withTenant(systemContext(firmId, 'r'), async () => 1)).rejects.toThrow(
        /Refusing/,
      );
    } finally {
      await db.close();
    }
  });

  it('a non-owner member of canopy_app is accepted and RESET ROLE does not escape RLS', async () => {
    const db = createDatabase({
      connectionString: urlAs(login, password),
      privilegedLogin: 'refuse',
    });
    try {
      const firms = await db.withTenant(systemContext(firmId, 'r'), async (tx) => {
        await tx.execute(sql`RESET ROLE`);
        return tx.select({ id: s.firm.id }).from(s.firm);
      });
      expect(firms.map((f) => f.id)).toEqual([firmId]);
      // The check runs once per Database and is cached.
      await db.withTenant(systemContext(firmId, 'r'), async () => 1);
    } finally {
      await db.close();
    }
  });
});

describe('operator logins', () => {
  it('refuse a superuser, a canopy_platform member and a canopy_app member', async () => {
    for (const [url, reason] of [
      [t.url, /Refusing operator connections: the login is a superuser/],
      [urlAs(operatorPlatformMember, password), /canopy_platform, which writes across firms/],
      // A console login that could SET ROLE canopy_app could set any firm's settings (audit of #140, Medium 1).
      [urlAs(operatorMember, password), /canopy_app, which acts inside tenants/],
      [
        urlAs(login, password),
        /Refusing operator connections: the login is a member of canopy_app/,
      ],
    ] as const) {
      const db = createOperatorDatabase({ connectionString: url, privilegedLogin: 'refuse' });
      try {
        await expect(db.withOperator('r', async () => 1)).rejects.toThrow(reason);
      } finally {
        await db.close();
      }
    }
  });

  it('accept the console login, which reads accounts and no client data even after RESET ROLE', async () => {
    const db = createOperatorDatabase({
      connectionString: urlAs(operatorLogin, password),
      privilegedLogin: 'refuse',
    });
    try {
      const n = await db.withOperator('r', async (tx) => {
        const { rows } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM firm`);
        return rows[0]!.n;
      });
      expect(n).toBe(2);
      // As itself the login has no grant on any tenant table, and it cannot become the app role.
      for (const statement of [sql`RESET ROLE`, sql.raw('SET LOCAL ROLE canopy_app')]) {
        const outcome = await db
          .withOperator('r', async (tx) => {
            await tx.execute(statement);
            await tx.execute(sql`SELECT count(*)::int AS n FROM client`);
            return 'read';
          })
          .catch((e: unknown) => String((e as { cause?: { code?: string } }).cause?.code ?? e));
        expect(outcome).toBe('42501');
      }
    } finally {
      await db.close();
    }
  });
});

describe('idle connections', () => {
  it('a server-closed idle client (57P01) does not crash the process, and the next query reconnects', async () => {
    const codes: string[] = [];
    const db = createDatabase({
      connectionString: urlAs(login, password),
      max: 1,
      onIdleError: (code) => codes.push(code),
    });
    const unhandled: unknown[] = [];
    const onError = (e: unknown) => unhandled.push(e);
    process.on('uncaughtException', onError);
    try {
      const pid = await db.withTenant(systemContext(firmId, 'r'), async (tx) => {
        const { rows } = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        return rows[0]!.pid;
      });
      await t.ownerQuery(`SELECT pg_terminate_backend(${Number(pid)})`);
      await new Promise((r) => setTimeout(r, 100));
      const again = await db.withTenant(systemContext(firmId, 'r'), async (tx) =>
        tx.select({ id: s.firm.id }).from(s.firm),
      );
      expect(again.map((f) => f.id)).toEqual([firmId]);
      expect(unhandled).toEqual([]);
      expect(codes).toEqual(['57P01']);
    } finally {
      process.off('uncaughtException', onError);
      await db.close();
    }
  });
});
