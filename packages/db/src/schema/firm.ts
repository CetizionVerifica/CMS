import type { AccountProfile, FirmSettings } from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { accountKindEnum, accountStatusEnum } from './enums.js';
import { plan } from './platform.js';

/**
 * The tenant: a customer account (ADR M15-0001). Every other table carries `firm_id` pointing here.
 * The app role can read its own firm and update only its name and settings (column grants, migration 0020); the
 * account columns belong to the operator role. Firms are created by `platform_create_account` (operator) or
 * `createFirm` on the owner connection (deploy, seed, tests).
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
    kind: accountKindEnum('kind').notNull().default('CONSULTANCY'),
    status: accountStatusEnum('status').notNull().default('ACTIVE'),
    /** A `platform.plan` code (foreign key in migration 0019; the plan rows are seeded there). */
    planCode: text('plan_code')
      .notNull()
      .default('CONSULTANCY')
      .references(() => plan.code),
    /** Last day of the trial, in the account's time zone. */
    trialEndsOn: date('trial_ends_on', { mode: 'string' }),
    onboardedAt: timestamp('onboarded_at', { withTimezone: true, mode: 'date' }),
    /** When the M6 master library copy finished; the owner can accept only after it (ADR M15-0001 decision 8). */
    libraryCopiedAt: timestamp('library_copied_at', { withTimezone: true, mode: 'date' }),
    /**
     * When M6 copied the ISO catalogue into the account (docs/iso/plan.md §4.3), set once by
     * `app_mark_iso_catalogue_copied()`; until then every ISO route answers FEATURE_NOT_READY.
     */
    isoCatalogueCopiedAt: timestamp('iso_catalogue_copied_at', {
      withTimezone: true,
      mode: 'date',
    }),
    /** ADR M15-0002: when the operator asked for deletion, and the status a cancel returns to. */
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true, mode: 'date' }),
    statusBeforeDeletion: accountStatusEnum('status_before_deletion'),
    /** Legal name, GSTIN, time zone and FY start the operator recorded (contracts `AccountProfile`). */
    profile: jsonb('profile').$type<Partial<AccountProfile>>().notNull().default({}),
  },
  () => [
    check('firm_version_check', sql`version >= 1`),
    check('firm_plan_code_check', sql`plan_code ~ '^[A-Z][A-Z0-9_]{1,39}$'`),
    check('firm_trial_check', sql`status <> 'TRIAL' or trial_ends_on is not null`),
    check(
      'firm_deletion_check',
      sql`(status = 'PENDING_DELETION') = (deletion_requested_at is not null and status_before_deletion is not null) or status = 'DELETED'`,
    ),
    check(
      'firm_status_before_deletion_check',
      sql`status_before_deletion is null or status_before_deletion in ('TRIAL', 'ACTIVE', 'SUSPENDED')`,
    ),
    // Read by every context of the firm; settings changed by firm staff only. The app role has no
    // INSERT grant: createFirm inserts on the owner connection, acting as the new firm.
    pgPolicy('tenant_read', { for: 'select', to: 'public', using: sql`id = app_firm_id()` }),
    pgPolicy('tenant_insert', { for: 'insert', to: 'public', withCheck: sql`id = app_firm_id()` }),
    pgPolicy('tenant_update', {
      for: 'update',
      to: 'public',
      using: sql`id = app_firm_id() and app_firm_staff()`,
      withCheck: sql`id = app_firm_id() and app_firm_staff()`,
    }),
    // The SECURITY DEFINER lookups run as canopy_lookup (migration 0007), which can read only the id.
    pgPolicy('lookup_read', { for: 'select', to: 'canopy_lookup', using: sql`true` }),
  ],
);
