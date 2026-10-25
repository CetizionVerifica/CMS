import { sql } from 'drizzle-orm';
import { integer, pgPolicy, timestamp, uuid } from 'drizzle-orm/pg-core';
import { firm } from './firm.js';

/**
 * Column and policy helpers shared by every table (packages/db/CLAUDE.md rules 1, 4, 5).
 * The SQL functions they call (`canopy_uuid_v7`, `app_firm_id`, `app_can_see_client`) are created by migration 0000.
 */

/** Event times: UTC `timestamptz`, read as `Date`. */
export function instant(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' });
}

/** UUIDv7 primary key generated in the database. */
export function idColumn() {
  return uuid('id')
    .primaryKey()
    .default(sql`canopy_uuid_v7()`);
}

/** The tenant. Defaults to the transaction's tenant, so request code never passes it. */
export function firmIdColumn() {
  return uuid('firm_id')
    .notNull()
    .default(sql`app_firm_id()`)
    .references(() => firm.id);
}

/** `Base` from the contracts: id, firm, created/updated times and soft delete. */
export function baseColumns() {
  return {
    id: idColumn(),
    firmId: firmIdColumn(),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
    archivedAt: instant('archived_at'),
  };
}

/** `Versioned` from the contracts: optimistic concurrency, starts at 1. */
export function versionColumn() {
  return integer('version').notNull().default(1);
}

/**
 * Firm-wide rows (library, locations): every context of the firm reads them; only firm staff contexts
 * (firm admins, consultants, system jobs) change them. `insert: 'any'` lets client contexts add rows
 * too (a client admin may add a location).
 */
export function firmWidePolicies({ insert }: { insert: 'staff' | 'any' }) {
  const firm = sql`firm_id = app_firm_id()`;
  const staff = sql`firm_id = app_firm_id() and app_firm_staff()`;
  return [
    pgPolicy('tenant_read', { for: 'select', to: 'public', using: firm }),
    pgPolicy('tenant_insert', {
      for: 'insert',
      to: 'public',
      withCheck: insert === 'any' ? firm : staff,
    }),
    pgPolicy('tenant_update', { for: 'update', to: 'public', using: staff, withCheck: staff }),
  ];
}

/**
 * The account's copy of the ISO catalogue (docs/iso/model.md §1.2): every context of the firm reads it; only the
 * catalogue copy, a system job, writes it, so no staff context and no route changes it.
 */
export function cataloguePolicies() {
  const firm = sql`firm_id = app_firm_id()`;
  const job = sql`firm_id = app_firm_id() and app_system_job()`;
  return [
    pgPolicy('tenant_read', { for: 'select', to: 'public', using: firm }),
    pgPolicy('tenant_insert', { for: 'insert', to: 'public', withCheck: job }),
    pgPolicy('tenant_update', { for: 'update', to: 'public', using: job, withCheck: job }),
  ];
}

/** Client rows: the firm, and a client the transaction may see (all clients for firm-wide contexts). */
export function clientPolicy(column: 'client_id' | 'id' = 'client_id') {
  const rule = sql.raw(`firm_id = app_firm_id() and app_can_see_client(${column})`);
  return pgPolicy('tenant_isolation', { for: 'all', to: 'public', using: rule, withCheck: rule });
}

/**
 * Rows whose `client_id` may be null (firm-level records). Rows with a null client are visible only to
 * firm-wide contexts. `nullClientWrites` lets any context of the firm insert such rows (audit and outbox
 * records of a client user's login, say) without being able to read them back.
 */
export function optionalClientPolicy({ nullClientWrites }: { nullClientWrites: boolean }) {
  const using = sql`firm_id = app_firm_id() and app_can_see_client(client_id)`;
  const withCheck = nullClientWrites
    ? sql`firm_id = app_firm_id() and (client_id is null or app_can_see_client(client_id))`
    : using;
  return pgPolicy('tenant_isolation', { for: 'all', to: 'public', using, withCheck });
}
