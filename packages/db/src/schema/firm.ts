import type { FirmSettings } from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The consultancy tenant. Every other table carries `firm_id` pointing here.
 * The app role can read and update its own firm only; firms are created by `createFirm` on the owner connection.
 */
export const firm = pgTable(
  'firm',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`canopy_uuid_v7()`),
    name: text('name').notNull(),
    settings: jsonb('settings').$type<FirmSettings>().notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
  },
  () => [
    check('firm_version_check', sql`version >= 1`),
    pgPolicy('tenant_isolation', {
      for: 'all',
      to: 'public',
      using: sql`id = app_firm_id()`,
      withCheck: sql`id = app_firm_id()`,
    }),
  ],
);
