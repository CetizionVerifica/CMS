import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../src/schema/index.js';

type DeclaredTable = { name: string; table: PgTable; columns: string[] };

const ALL: (DeclaredTable & { schema: string })[] = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => {
    const config = getTableConfig(table);
    const columns = config.columns.map((c) => c.name);
    return { name: config.name, schema: config.schema ?? 'public', table, columns };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/** Every tenant table the Drizzle schema declares in `public`, by SQL name. */
export const TABLES: DeclaredTable[] = ALL.filter((t) => t.schema === 'public');

/** The operator tables in schema `platform` (ADR M15-0001 decision 2): no firm_id, no RLS. */
export const PLATFORM_TABLES: DeclaredTable[] = ALL.filter((t) => t.schema === 'platform');

/** The column holding the tenant: `id` on firm, `firm_id` everywhere else. */
export function tenantColumn(name: string): string {
  return name === 'firm' ? 'id' : 'firm_id';
}

/** Tables scoped to one client: `client` itself and every table with a `client_id` column. */
export function clientColumn(name: string): string | null {
  if (name === 'client') return 'id';
  return TABLES.find((t) => t.name === name)?.columns.includes('client_id') ? 'client_id' : null;
}
