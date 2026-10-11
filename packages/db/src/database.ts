import { DEFAULT_FIRM_SETTINGS, FirmSettings, Id, Name } from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import * as schema from './schema/index.js';
import { tenantSettings, type TenantContext } from './tenant-context.js';

export type Schema = typeof schema;
type Db = NodePgDatabase<Schema>;
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

declare const tenantBrand: unique symbol;

/**
 * A transaction running as the app role with a tenant context set. Repositories take this type, so code
 * cannot reach the database without going through `withTenant`.
 */
export type TenantTx = Transaction & { readonly [tenantBrand]: true };

/** The role every tenant transaction switches to (migration 0000). It has no BYPASSRLS. */
export const APP_ROLE = 'canopy_app';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export interface DatabaseOptions {
  /** Postgres URL. The user must be a member of `canopy_app`; in production it should not own the tables. */
  connectionString: string;
  /** Pool size (default 10). */
  max?: number;
}

export interface Database {
  /**
   * Runs `fn` in one transaction as the app role, with the tenant settings every RLS policy reads.
   * This is the only way request code reaches the database (packages/db/CLAUDE.md rule 2).
   */
  withTenant<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function createPool(options: DatabaseOptions): pg.Pool {
  return new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
}

export function createDatabase(options: DatabaseOptions): Database {
  const pool = createPool(options);
  const db = drizzle(pool, { schema });
  return {
    async withTenant(ctx, fn) {
      const settings = tenantSettings(ctx);
      return db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
        await tx.execute(sql`
          SELECT set_config('app.firm_id', ${settings['app.firm_id']}, true),
                 set_config('app.person_id', ${settings['app.person_id']}, true),
                 set_config('app.client_ids', ${settings['app.client_ids']}, true),
                 set_config('app.all_clients', ${settings['app.all_clients']}, true),
                 set_config('app.request_id', ${settings['app.request_id']}, true)`);
        return fn(tx as TenantTx);
      });
    },
    close: () => pool.end(),
  };
}

const NewFirm = z.strictObject({
  id: Id.optional(),
  name: Name,
  settings: FirmSettings.default(DEFAULT_FIRM_SETTINGS),
});
export type NewFirm = z.input<typeof NewFirm>;

/**
 * Owner-side operations that are not tenant work: migrations and creating firms (deploy, seed, tests).
 * Never use it in request code.
 */
export interface AdminDatabase {
  migrate(migrationsFolder?: string): Promise<void>;
  /** Creates a firm and returns its id. `id` is for deterministic seeds and fixtures. */
  createFirm(input: NewFirm): Promise<string>;
  close(): Promise<void>;
}

export function createAdminDatabase(options: DatabaseOptions): AdminDatabase {
  const pool = createPool({ ...options, max: options.max ?? 2 });
  const db = drizzle(pool, { schema });
  return {
    async migrate(migrationsFolder = MIGRATIONS_FOLDER) {
      await runMigrations(db, { migrationsFolder });
    },
    async createFirm(input) {
      const firm = NewFirm.parse(input);
      return db.transaction(async (tx) => {
        const id =
          firm.id ??
          (await tx.execute<{ id: string }>(sql`SELECT canopy_uuid_v7() AS id`)).rows[0]!.id;
        // The firm policy (id = app_firm_id()) binds the owner too, so act as the new firm.
        await tx.execute(sql`SELECT set_config('app.firm_id', ${id}, true)`);
        await tx.insert(schema.firm).values({ id, name: firm.name, settings: firm.settings });
        return id;
      });
    },
    close: () => pool.end(),
  };
}
