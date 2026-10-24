import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgPolicy, pgTable, unique, uuid } from 'drizzle-orm/pg-core';
import { baseColumns, instant } from './columns.js';
import { supportAccessLevelEnum } from './enums.js';
import { person } from './tenancy.js';

/**
 * PlanetPulse support access an account admin grants (ADR M15-0001 decision 11). A tenant table: firm staff
 * contexts read and write it. `canopy_operator` reads it (`operator_read`, column grants in migration 0020) to
 * see whether a grant is live; it never writes it. The grant's memberships belong to `support_person_id` and
 * expire at `ends_at`.
 */
export const supportGrant = pgTable(
  'support_grant',
  {
    ...baseColumns(),
    level: supportAccessLevelEnum('level').notNull(),
    startsAt: instant('starts_at').notNull(),
    endsAt: instant('ends_at').notNull(),
    grantedById: uuid('granted_by_id').notNull(),
    supportPersonId: uuid('support_person_id').notNull(),
    revokedAt: instant('revoked_at'),
    revokedById: uuid('revoked_by_id'),
  },
  (t) => [
    unique('support_grant_firm_key').on(t.firmId, t.id),
    foreignKey({
      name: 'support_grant_granted_by_fk',
      columns: [t.firmId, t.grantedById],
      foreignColumns: [person.firmId, person.id],
    }),
    foreignKey({
      name: 'support_grant_support_person_fk',
      columns: [t.firmId, t.supportPersonId],
      foreignColumns: [person.firmId, person.id],
    }),
    foreignKey({
      name: 'support_grant_revoked_by_fk',
      columns: [t.firmId, t.revokedById],
      foreignColumns: [person.firmId, person.id],
    }),
    index('support_grant_firm_idx').on(t.firmId, t.startsAt),
    check('support_grant_period_check', sql`ends_at > starts_at`),
    // SUPPORT_GRANT_MAX_DAYS (audit of #140, Low 5).
    check('support_grant_length_check', sql`ends_at <= starts_at + interval '30 days'`),
    check('support_grant_revoked_check', sql`(revoked_at is null) = (revoked_by_id is null)`),
    pgPolicy('tenant_read', { for: 'select', to: 'public', using: sql`firm_id = app_firm_id()` }),
    pgPolicy('tenant_insert', {
      for: 'insert',
      to: 'public',
      withCheck: sql`firm_id = app_firm_id() and app_firm_staff()`,
    }),
    pgPolicy('tenant_update', {
      for: 'update',
      to: 'public',
      using: sql`firm_id = app_firm_id() and app_firm_staff()`,
      withCheck: sql`firm_id = app_firm_id() and app_firm_staff()`,
    }),
    pgPolicy('operator_read', { for: 'select', to: 'canopy_operator', using: sql`true` }),
  ],
);
