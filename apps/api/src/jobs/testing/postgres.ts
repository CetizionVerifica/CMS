import { randomBytes } from 'node:crypto';
import {
  createAdminDatabase,
  createDatabase,
  systemContext,
  tenantSettings,
  type AdminDatabase,
  type Database,
} from '@canopy/db';
import pg from 'pg';

/**
 * A throwaway, migrated database for one test file, created from DATABASE_URL (CI: the `db` job's Postgres 16).
 * `count` reads one firm's rows as the owner, outside the code under test. It filters on `firm_id` and also sets
 * the firm's tenant settings, so it is right whether or not the owner login bypasses RLS (a superuser locally).
 */
export interface JobTestDatabase {
  url: string;
  admin: AdminDatabase;
  db: Database;
  count(firmId: string, table: string, where?: string, values?: unknown[]): Promise<number>;
  drop(): Promise<void>;
}

export async function createJobTestDatabase(base: string): Promise<JobTestDatabase> {
  const name = `canopy_jobs_${randomBytes(6).toString('hex')}`;
  const server = new pg.Client({ connectionString: base });
  await server.connect();
  await server.query(`CREATE DATABASE ${name}`);
  await server.end();

  const url = new URL(base);
  url.pathname = `/${name}`;
  const admin = createAdminDatabase({ connectionString: url.toString() });
  await admin.migrate();
  const db = createDatabase({ connectionString: url.toString(), max: 4 });
  const owner = new pg.Pool({ connectionString: url.toString(), max: 2 });

  return {
    url: url.toString(),
    admin,
    db,
    async count(firmId, table, where = 'true', values = []) {
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        for (const [key, value] of Object.entries(tenantSettings(systemContext(firmId, 'count')))) {
          await client.query('SELECT set_config($1, $2, true)', [key, value]);
        }
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${table} WHERE firm_id = $${values.length + 1} AND (${where})`,
          [...values, firmId],
        );
        return Number(rows[0]!.n);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    },
    async drop() {
      await Promise.all([db.close(), admin.close(), owner.end()]);
      const cleanup = new pg.Client({ connectionString: base });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
