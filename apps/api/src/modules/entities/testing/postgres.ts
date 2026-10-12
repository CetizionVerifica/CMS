import { randomBytes } from 'node:crypto';
import { createAdminDatabase, createDatabase, type AdminDatabase, type Database } from '@canopy/db';
import pg from 'pg';

/**
 * A throwaway, migrated database per test file, created from DATABASE_URL (CI: the `db` job's Postgres 16). The
 * DATABASE_URL user needs CREATEDB and owns the tables, as in CI and local dev.
 */
export interface TestDatabase {
  admin: AdminDatabase;
  db: Database;
  drop(): Promise<void>;
}

export async function createTestDatabase(url: string): Promise<TestDatabase> {
  const base = new URL(url);
  const name = `m6_test_${randomBytes(6).toString('hex')}`;
  const server = new pg.Client({ connectionString: base.toString() });
  await server.connect();
  await server.query(`CREATE DATABASE ${name}`);
  await server.end();

  const target = new URL(base);
  target.pathname = `/${name}`;
  const admin = createAdminDatabase({ connectionString: target.toString() });
  await admin.migrate();
  const db = createDatabase({ connectionString: target.toString(), max: 4 });
  return {
    admin,
    db,
    async drop() {
      await Promise.all([db.close(), admin.close()]);
      const cleanup = new pg.Client({ connectionString: base.toString() });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
