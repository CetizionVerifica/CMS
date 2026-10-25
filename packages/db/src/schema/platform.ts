import type { PlanLimits } from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  inet,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { idColumn, instant } from './columns.js';
import { operatorAuditActionEnum } from './enums.js';
import { firm } from './firm.js';

/**
 * The platform operator's tables (ADR M15-0001 decisions 5-9, 12). They sit in their own schema, outside every
 * tenant: no `firm_id` RLS, and `canopy_app` has no USAGE on the schema, so customer requests cannot reach them.
 * `canopy_operator` reads and writes them (migration 0020). Accounts are firms; `account_id` references `firm`.
 */
export const platform = pgSchema('platform');

/** A plan. Limits are numbers or null for unlimited; prices are not stored. */
export const plan = platform.table(
  'plan',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    limits: jsonb('limits').$type<PlanLimits>().notNull(),
    features: text('features')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    retiredAt: instant('retired_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  () => [check('plan_code_check', sql`code ~ '^[A-Z][A-Z0-9_]{1,39}$'`)],
);

/** Per-account limit and feature changes on top of the plan; one row per account at most. */
export const accountOverride = platform.table(
  'account_override',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => firm.id),
    limits: jsonb('limits').$type<Partial<PlanLimits>>().notNull().default({}),
    features: text('features')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Plan features turned off for this account (the console's add-on switch, ADR M16-0001 decision 2). */
    removedFeatures: text('removed_features')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    note: text('note'),
    version: integer('version').notNull().default(1),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  () => [
    // A flag is either added or removed, not both (contracts AccountOverride).
    check('account_override_features_check', sql`not (features && removed_features)`),
  ],
);

/** PlanetPulse staff who sign in to the operator console. Created only by the deploy-time CLI. */
export const operator = platform.table(
  'operator',
  {
    id: idColumn(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    disabledAt: instant('disabled_at'),
  },
  (t) => [uniqueIndex('operator_email_key').on(sql`lower(${t.email})`)],
);

/** Password and TOTP for an operator; MFA is always on (enrolled by the CLI). */
export const operatorCredential = platform.table(
  'operator_credential',
  {
    operatorId: uuid('operator_id')
      .primaryKey()
      .references(() => operator.id),
    passwordHash: text('password_hash').notNull(),
    mfaSealedSecret: text('mfa_sealed_secret').notNull(),
    mfaLastStep: bigint('mfa_last_step', { mode: 'number' }),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: instant('locked_until'),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  () => [
    check('operator_credential_failed_attempts_check', sql`failed_attempts >= 0`),
    check(
      'operator_credential_password_hash_check',
      sql`password_hash ~ '^scrypt\\$[0-9]+\\$[0-9]+\\$[0-9]+\\$[A-Za-z0-9_-]+\\$[A-Za-z0-9_-]+$'`,
    ),
    check(
      'operator_credential_mfa_secret_check',
      sql`mfa_sealed_secret ~ '^v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$'`,
    ),
  ],
);

/** Operator sessions (`op_sid`): only the token's SHA-256 is stored. */
export const operatorSession = platform.table(
  'operator_session',
  {
    id: idColumn(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    tokenHash: text('token_hash').notNull(),
    csrfToken: text('csrf_token').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    lastSeenAt: instant('last_seen_at').notNull().defaultNow(),
    expiresAt: instant('expires_at').notNull(),
    revokedAt: instant('revoked_at'),
    ip: inet('ip'),
  },
  (t) => [
    uniqueIndex('operator_session_token_hash_key').on(t.tokenHash),
    index('operator_session_operator_idx').on(t.operatorId),
    check('operator_session_token_hash_check', sql`token_hash ~ '^[0-9a-f]{64}$'`),
    check('operator_session_expiry_check', sql`expires_at > created_at`),
  ],
);

/** Offline billing periods (ADR M15-0001 decision 6). */
export const subscription = platform.table(
  'subscription',
  {
    id: idColumn(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => firm.id),
    planCode: text('plan_code')
      .notNull()
      .references(() => plan.code),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    invoiceNumber: text('invoice_number'),
    paidOn: date('paid_on', { mode: 'string' }),
    recordedAt: instant('recorded_at').notNull().defaultNow(),
    recordedById: uuid('recorded_by_id')
      .notNull()
      .references(() => operator.id),
  },
  (t) => [
    index('subscription_account_idx').on(t.accountId, t.endsOn),
    check('subscription_period_check', sql`ends_on >= starts_on`),
    check('subscription_amount_check', sql`amount_paise >= 0`),
  ],
);

/** Nightly usage per account (M9), one row per account and day. */
export const usageSnapshot = platform.table(
  'usage_snapshot',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => firm.id),
    takenOn: date('taken_on', { mode: 'string' }).notNull(),
    companies: integer('companies').notNull(),
    units: integer('units').notNull(),
    users: integer('users').notNull(),
    storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull(),
    activeUsers30d: integer('active_users_30d').notNull(),
    instances: integer('instances').notNull(),
  },
  (t) => [
    primaryKey({ name: 'usage_snapshot_pkey', columns: [t.accountId, t.takenOn] }),
    check(
      'usage_snapshot_counts_check',
      sql`companies >= 0 and units >= 0 and users >= 0 and storage_bytes >= 0 and active_users_30d >= 0 and instances >= 0`,
    ),
  ],
);

/**
 * Append-only operator audit (ADR M15-0001 decision 12): INSERT and SELECT only. `operator_id` is null for the
 * system (jobs). `account_id` has no foreign key so the trail outlives nothing it points at.
 */
export const operatorAuditEvent = platform.table(
  'operator_audit_event',
  {
    id: idColumn(),
    at: instant('at').notNull().defaultNow(),
    operatorId: uuid('operator_id').references(() => operator.id),
    action: operatorAuditActionEnum('action').notNull(),
    accountId: uuid('account_id'),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    reason: text('reason'),
    requestId: text('request_id').notNull(),
    ip: inet('ip'),
  },
  (t) => [
    index('operator_audit_event_account_idx').on(t.accountId, t.at),
    index('operator_audit_event_at_idx').on(t.at),
    // A support grant ends once in the trail, by revoke or by expiry (app_record_support_expiry inserts with
    // ON CONFLICT DO NOTHING and no conflict target, which needs no SELECT on the trail). Only those two sources: any
    // other END that names a grant (a support session's, say) is not the grant's end.
    uniqueIndex('operator_audit_event_support_end_key')
      .on(sql`(after->>'grantId')`)
      .where(sql`action = 'SUPPORT_ACCESS_END' and after->>'source' in ('grant', 'expiry')`),
    check('operator_audit_event_request_id_check', sql`length(request_id) between 1 and 200`),
  ],
);
