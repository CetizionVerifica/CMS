import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  createAdminDatabase,
  createDatabase,
  type AdminDatabase,
  type Database,
} from '../../src/database.js';

/**
 * A throwaway database per test file, created from DATABASE_URL (CI: the `db` job's Postgres 16).
 * The DATABASE_URL user needs CREATEDB; it also owns the tables, as in CI and local dev.
 */
export interface TestDatabase {
  url: string;
  admin: AdminDatabase;
  db: Database;
  /** Runs SQL as the owner, outside any tenant context. For assertions about privileges and triggers. */
  ownerQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
  /** Runs `fn` in a transaction on the owner connection that is rolled back afterwards. */
  ownerTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  drop(): Promise<void>;
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; db tests need Postgres 16 (pnpm db:up).');
  return url;
}

export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const base = new URL(databaseUrl());
  const name = `canopy_test_${randomBytes(6).toString('hex')}`;
  const server = new pg.Client({ connectionString: base.toString() });
  await server.connect();
  await server.query(`CREATE DATABASE ${name}`);
  await server.end();

  const url = new URL(base);
  url.pathname = `/${name}`;
  const admin = createAdminDatabase({ connectionString: url.toString() });
  if (options.migrate !== false) await admin.migrate();
  const db = createDatabase({ connectionString: url.toString(), max: 4 });
  const owner = new pg.Pool({ connectionString: url.toString(), max: 2 });

  return {
    url: url.toString(),
    admin,
    db,
    ownerQuery: (text, values) => owner.query(text, values),
    async ownerTransaction(fn) {
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        return await fn(client);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    },
    async drop() {
      await Promise.all([db.close(), admin.close(), owner.end()]);
      const cleanup = new pg.Client({ connectionString: base.toString() });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
