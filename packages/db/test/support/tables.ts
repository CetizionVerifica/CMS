import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../src/schema/index.js';

/** Every table the Drizzle schema declares, by SQL name. */
export const TABLES: { name: string; table: PgTable; columns: string[] }[] = (
  Object.values(schema) as unknown[]
)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => {
    const config = getTableConfig(table);
    return { name: config.name, table, columns: config.columns.map((c) => c.name) };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/** The column holding the tenant: `id` on firm, `firm_id` everywhere else. */
export function tenantColumn(name: string): string {
  return name === 'firm' ? 'id' : 'firm_id';
}

/** Tables scoped to one client: `client` itself and every table with a `client_id` column. */
export function clientColumn(name: string): string | null {
  if (name === 'client') return 'id';
  return TABLES.find((t) => t.name === name)?.columns.includes('client_id') ? 'client_id' : null;
}
