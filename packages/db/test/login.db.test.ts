import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/database.js';
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
});

afterAll(async () => {
  await t?.ownerQuery(`DROP ROLE IF EXISTS ${login}`);
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
