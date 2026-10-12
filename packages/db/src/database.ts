import { DEFAULT_FIRM_SETTINGS, FirmSettings, Id, Name } from '@canopy/contracts';
import { eq, sql, type SQL } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { lookups, type AuthLookups } from './auth-lookups.js';
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

/**
 * Runs `fn` in a savepoint of `tx`: if it throws, only its changes roll back and the error is rethrown,
 * so the outer transaction can go on (bulk approve: one savepoint per item, then one summary event).
 * The tenant settings and role are those of `tx`; `SET LOCAL` inside a savepoint is undone with it.
 */
export function withSavepoint<T>(tx: TenantTx, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return tx.transaction((inner) => fn(inner as TenantTx));
}

/** The role every tenant transaction switches to (migration 0000). It has no BYPASSRLS. */
export const APP_ROLE = 'canopy_app';

/** Owner of the SECURITY DEFINER pre-tenant lookups (migration 0007); no request login may become it. */
const LOOKUP_ROLE = 'canopy_lookup';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export interface DatabaseOptions {
  /** Postgres URL. The user must be a member of `canopy_app`; in production it should not own the tables. */
  connectionString: string;
  /** Pool size (default 10). */
  max?: number;
  /**
   * What to do when the login is a superuser, has BYPASSRLS or owns the tables. Such a login could step
   * out of RLS with RESET ROLE. Default: 'refuse' when NODE_ENV is production, else 'allow' (local dev
   * and CI connect as the owner).
   */
  privilegedLogin?: 'refuse' | 'allow';
  /**
   * Told the SQLSTATE when the server closes an idle pooled client (57P01 on a restart, failover or
   * DROP DATABASE WITH (FORCE)). Default: a console warning with the code only, never the message.
   */
  onIdleError?: (sqlState: string) => void;
}

/**
 * `findLoginCandidates`, `findSession` and `findLoginToken` (AuthLookups) are the sign-in reads made before a
 * tenant is known: SECURITY DEFINER functions that return ids, hashes and states only (ADR M3-0001).
 */
export interface Database extends AuthLookups {
  /**
   * Runs `fn` in one transaction as the app role, with the tenant settings every RLS policy reads.
   * This is the only way request code reaches the database (packages/db/CLAUDE.md rule 2).
   */
  withTenant<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /**
   * Ids of every firm, for scheduled jobs that then run each firm in its own `withTenant`. It returns ids
   * and nothing else (ADR 0003).
   */
  listFirmIds(): Promise<string[]>;
  close(): Promise<void>;
}

function sqlStateOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function createPool(options: DatabaseOptions): pg.Pool {
  const pool = new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
  // An idle client the server closes emits 'error' on the pool, which crashes the process when nobody
  // listens. The pool has already removed that client and the next query opens a new one.
  const report =
    options.onIdleError ??
    ((code: string) =>
      console.warn(`@canopy/db: the server closed an idle connection (SQLSTATE ${code})`));
  pool.on('error', (error) => report(sqlStateOf(error)));
  return pool;
}

/**
 * Why a login may not serve requests, or null when it is a plain member of the app role. Checks every
 * role the login can become (pg_has_role MEMBER includes itself), since SET ROLE inside withTenant
 * could reach any of them.
 */
async function privilegedReason(db: Db): Promise<string | null> {
  const { rows } = await db.execute<{
    name: string;
    self: boolean;
    superuser: boolean;
    bypassrls: boolean;
    owner: boolean;
  }>(sql`
    SELECT r.rolname AS name, r.rolname = session_user AS self,
           r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
           EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                   JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relowner = r.oid) AS owner
    FROM pg_catalog.pg_roles r
    WHERE pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER')
    ORDER BY r.rolname = session_user DESC, r.rolname`);
  if (!rows[0]?.self) return 'the login role was not found';
  for (const role of rows) {
    const who = role.self ? 'the login' : `the login is a member of ${role.name}, which`;
    if (role.superuser) return `${who} is a superuser`;
    if (role.bypassrls) return `${who} has BYPASSRLS`;
    if (role.owner) return `${who} owns tables in schema public`;
    // Owns the pre-tenant lookups, which read across firms (migrations 0007, 0012).
    if (role.name === LOOKUP_ROLE)
      return role.self ? 'the login is canopy_lookup' : `${who} reads across firms`;
  }
  return null;
}

export function createDatabase(options: DatabaseOptions): Database {
  const pool = createPool(options);
  const db = drizzle(pool, { schema });
  const policy =
    options.privilegedLogin ?? (process.env.NODE_ENV === 'production' ? 'refuse' : 'allow');
  let loginChecked: Promise<void> | null = null;
  const checkLogin = () => {
    loginChecked ??= privilegedReason(db).then((reason) => {
      if (reason) {
        loginChecked = null;
        throw new Error(
          `Refusing tenant connections: ${reason}. Connect as a non-owner member of ${APP_ROLE} (ADR 0003).`,
        );
      }
    });
    return loginChecked;
  };
  /** One statement as the app role with no tenant context: only the SECURITY DEFINER lookups return rows. */
  const asApp = async (query: SQL) => {
    if (policy === 'refuse') await checkLogin();
    return db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
      return tx.execute<Record<string, unknown>>(query);
    });
  };
  return {
    async withTenant(ctx, fn) {
      const settings = tenantSettings(ctx);
      if (policy === 'refuse') await checkLogin();
      return db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
        await tx.execute(sql`
          SELECT set_config('app.firm_id', ${settings['app.firm_id']}, true),
                 set_config('app.person_id', ${settings['app.person_id']}, true),
                 set_config('app.client_ids', ${settings['app.client_ids']}, true),
                 set_config('app.all_clients', ${settings['app.all_clients']}, true),
                 set_config('app.firm_staff', ${settings['app.firm_staff']}, true),
                 set_config('app.request_id', ${settings['app.request_id']}, true)`);
        return fn(tx as TenantTx);
      });
    },
    async listFirmIds() {
      const { rows } = await asApp(sql`SELECT canopy_list_firm_ids() AS id`);
      return rows.map((r) => r.id as string);
    },
    ...lookups(asApp),
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
  /** Whether a firm with this id exists (seeds use it to stay idempotent). */
  firmExists(id: string): Promise<boolean>;
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
    async firmExists(id) {
      const firmId = Id.parse(id);
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.firm_id', ${firmId}, true)`);
        // Filter by id too: a superuser owner bypasses RLS and would see every firm.
        const rows = await tx
          .select({ id: schema.firm.id })
          .from(schema.firm)
          .where(eq(schema.firm.id, firmId));
        return rows.length === 1;
      });
    },
    close: () => pool.end(),
  };
}
