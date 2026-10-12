import type { ClientSettings } from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, clientPolicy, firmWidePolicies, instant, versionColumn } from './columns.js';
import { personStatusEnum, roleEnum } from './enums.js';

/** Tenancy, entities and people (docs/contracts/domain-model.md §3). */

/** Customer organisation group, e.g. "Kestrel Metals Group". Its own id is the client scope. */
export const client = pgTable(
  'client',
  {
    ...baseColumns(),
    version: versionColumn(),
    name: text('name').notNull(),
    settings: jsonb('settings').$type<ClientSettings>().notNull(),
  },
  (t) => [
    unique('client_firm_key').on(t.firmId, t.id),
    check('client_version_check', sql`version >= 1`),
    clientPolicy('id'),
  ],
);

/** Country / state / city, shared by the firm's clients. */
export const location = pgTable(
  'location',
  {
    ...baseColumns(),
    country: text('country').notNull(),
    countryCode: text('country_code').notNull(),
    state: text('state'),
    stateCode: text('state_code'),
    city: text('city'),
  },
  (t) => [
    unique('location_firm_key').on(t.firmId, t.id),
    uniqueIndex('location_path_key')
      .on(
        t.firmId,
        t.countryCode,
        sql`coalesce(lower(${t.state}), '')`,
        sql`coalesce(lower(${t.city}), '')`,
      )
      .where(sql`archived_at is null`),
    check('location_country_code_check', sql`country_code ~ '^[A-Z]{2}$'`),
    check('location_state_code_check', sql`state_code is null or state_code ~ '^[A-Z]{2,3}$'`),
    ...firmWidePolicies({ insert: 'any' }),
  ],
);

/** e.g. "Kestrel Aluminium". */
export const company = pgTable(
  'company',
  {
    ...baseColumns(),
    version: versionColumn(),
    clientId: uuid('client_id').notNull(),
    name: text('name').notNull(),
  },
  (t) => [
    unique('company_scope_key').on(t.firmId, t.clientId, t.id),
    foreignKey({
      name: 'company_client_fk',
      columns: [t.firmId, t.clientId],
      foreignColumns: [client.firmId, client.id],
    }),
    uniqueIndex('company_name_key')
      .on(t.clientId, t.name)
      .where(sql`archived_at is null`),
    check('company_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** Plant, site or office, e.g. "Plant". */
export const unit = pgTable(
  'unit',
  {
    ...baseColumns(),
    version: versionColumn(),
    clientId: uuid('client_id').notNull(),
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    locationId: uuid('location_id').notNull(),
  },
  (t) => [
    unique('unit_scope_key').on(t.firmId, t.clientId, t.id),
    foreignKey({
      name: 'unit_company_fk',
      columns: [t.firmId, t.clientId, t.companyId],
      foreignColumns: [company.firmId, company.clientId, company.id],
    }),
    foreignKey({
      name: 'unit_location_fk',
      columns: [t.firmId, t.locationId],
      foreignColumns: [location.firmId, location.id],
    }),
    uniqueIndex('unit_name_key')
      .on(t.companyId, t.name)
      .where(sql`archived_at is null`),
    index('unit_location_idx').on(t.locationId),
    check('unit_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** Per client, with the other spellings that resolve to it on import. */
export const department = pgTable(
  'department',
  {
    ...baseColumns(),
    version: versionColumn(),
    clientId: uuid('client_id').notNull(),
    name: text('name').notNull(),
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [
    unique('department_scope_key').on(t.firmId, t.clientId, t.id),
    foreignKey({
      name: 'department_client_fk',
      columns: [t.firmId, t.clientId],
      foreignColumns: [client.firmId, client.id],
    }),
    uniqueIndex('department_name_key')
      .on(t.clientId, t.name)
      .where(sql`archived_at is null`),
    check('department_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** A person known to the firm: staff, client users, and people created by import (UNCLAIMED, no email). */
export const person = pgTable(
  'person',
  {
    ...baseColumns(),
    version: versionColumn(),
    displayName: text('display_name').notNull(),
    nameNormalized: text('name_normalized').notNull(),
    email: text('email'),
    status: personStatusEnum('status').notNull(),
  },
  (t) => [
    unique('person_firm_key').on(t.firmId, t.id),
    index('person_name_normalized_idx').on(t.firmId, t.nameNormalized),
    uniqueIndex('person_email_key')
      .on(t.firmId, sql`lower(${t.email})`)
      .where(sql`email is not null and archived_at is null`),
    // Sign-in looks a person up by email across firms (canopy_login_candidates).
    index('person_email_lookup_idx')
      .on(sql`lower(${t.email})`)
      .where(sql`email is not null and archived_at is null`),
    check(
      'person_name_normalized_check',
      sql`name_normalized = lower(name_normalized) and name_normalized !~ '[\\t\\n\\r\\f\\v]|  '`,
    ),
    check(
      'person_email_status_check',
      sql`(status <> 'UNCLAIMED' or email is null) and (status not in ('INVITED', 'ACTIVE') or email is not null)`,
    ),
    check('person_version_check', sql`version >= 1`),
    // Firm staff see everyone. Client contexts see themselves and the people of their clients
    // (a membership, assignment or instance there). They cannot change anyone holding a firm role or
    // working for a client they cannot see.
    pgPolicy('tenant_read', {
      for: 'select',
      to: 'public',
      using: sql`firm_id = app_firm_id() and (app_firm_staff() or id = app_person_id() or app_person_visible(id))`,
    }),
    pgPolicy('tenant_insert', {
      for: 'insert',
      to: 'public',
      withCheck: sql`firm_id = app_firm_id()`,
    }),
    pgPolicy('tenant_update', {
      for: 'update',
      to: 'public',
      using: sql`firm_id = app_firm_id() and (app_firm_staff() or ((id = app_person_id() or app_person_visible(id)) and not app_person_has_firm_role(id) and (app_all_clients() or not app_person_in_hidden_client(id))))`,
      withCheck: sql`firm_id = app_firm_id()`,
    }),
    // Sign-in candidates by email, before a tenant is known (migration 0012; granted columns only).
    pgPolicy('lookup_read', { for: 'select', to: 'canopy_lookup', using: sql`true` }),
  ],
);

/** A person's role in the firm (no client) or in one client (README decision 11). */
export const membership = pgTable(
  'membership',
  {
    ...baseColumns(),
    version: versionColumn(),
    personId: uuid('person_id').notNull(),
    role: roleEnum('role').notNull(),
    clientId: uuid('client_id'),
    consultantClientIds: uuid('consultant_client_ids').array(),
    unitIds: uuid('unit_ids').array(),
    expiresAt: instant('expires_at'),
  },
  (t) => [
    foreignKey({
      name: 'membership_person_fk',
      columns: [t.firmId, t.personId],
      foreignColumns: [person.firmId, person.id],
    }),
    foreignKey({
      name: 'membership_client_fk',
      columns: [t.firmId, t.clientId],
      foreignColumns: [client.firmId, client.id],
    }),
    index('membership_person_idx').on(t.personId),
    index('membership_client_idx').on(t.clientId),
    check(
      'membership_client_role_check',
      sql`(role in ('FIRM_ADMIN', 'CONSULTANT')) = (client_id is null)`,
    ),
    check(
      'membership_consultant_check',
      sql`(role = 'CONSULTANT') = (consultant_client_ids is not null)`,
    ),
    check(
      'membership_unit_ids_check',
      sql`unit_ids is null or (role in ('OWNER', 'APPROVER') and cardinality(unit_ids) >= 1)`,
    ),
    check('membership_viewer_expiry_check', sql`role <> 'VIEWER' or expires_at is not null`),
    check('membership_version_check', sql`version >= 1`),
    // A person always sees their own memberships, so the request context can be built from them.
    pgPolicy('tenant_isolation', {
      for: 'all',
      to: 'public',
      using: sql`firm_id = app_firm_id() and (app_can_see_client(client_id) or person_id = app_person_id())`,
      withCheck: sql`firm_id = app_firm_id() and app_can_see_client(client_id)`,
    }),
  ],
);
