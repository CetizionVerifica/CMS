import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  uniqueIndex,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { firmIdColumn, idColumn, instant } from './columns.js';
import { roleEnum } from './enums.js';
import { client, person } from './tenancy.js';

/**
 * Sign-in storage for M5 (`AccountStore` in apps/api/src/auth/accounts.ts). Raw tokens are never stored: only
 * their SHA-256 (hex). A person reaches their own rows; firm staff contexts (firm admins, consultants, system
 * jobs) reach every row of the firm. Lookups before a tenant is known go through the SECURITY DEFINER functions
 * of migration 0012, which run as `canopy_lookup` (`lookup_read` policies) and read only the granted columns.
 */

const selfOrStaff = sql`firm_id = app_firm_id() and (person_id = app_person_id() or app_firm_staff())`;

function selfOrStaffPolicies(extra?: ReturnType<typeof sql>) {
  const rule = extra
    ? sql`firm_id = app_firm_id() and (person_id = app_person_id() or app_firm_staff() or ${extra})`
    : selfOrStaff;
  return [
    pgPolicy('tenant_isolation', { for: 'all', to: 'public', using: rule, withCheck: rule }),
    pgPolicy('lookup_read', { for: 'select', to: 'canopy_lookup', using: sql`true` }),
  ];
}

const sha256Hex = (column: string) => sql.raw(`${column} ~ '^[0-9a-f]{64}$'`);

/** Password and MFA state, one row per person. */
export const authCredential = pgTable(
  'auth_credential',
  {
    id: idColumn(),
    firmId: firmIdColumn(),
    personId: uuid('person_id').notNull(),
    /** scrypt hash in the M5 format; null until a password is set. */
    passwordHash: text('password_hash'),
    /** TOTP secret sealed by M5's SecretBox; never returned by a pre-tenant lookup. */
    mfaSealedSecret: text('mfa_sealed_secret'),
    mfaEnrolledAt: instant('mfa_enrolled_at'),
    /** Last accepted TOTP time step; codes for this step or earlier are refused. */
    mfaLastStep: bigint('mfa_last_step', { mode: 'number' }),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: instant('locked_until'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'auth_credential_person_fk',
      columns: [t.firmId, t.personId],
      foreignColumns: [person.firmId, person.id],
    }),
    uniqueIndex('auth_credential_person_key').on(t.personId),
    check('auth_credential_failed_attempts_check', sql`failed_attempts >= 0`),
    check(
      'auth_credential_mfa_check',
      sql`(mfa_enrolled_at is null or mfa_sealed_secret is not null) and (mfa_last_step is null or mfa_last_step >= 0)`,
    ),
    ...selfOrStaffPolicies(),
  ],
);

/** A signed-in browser session, found by the hash of its cookie token. */
export const authSession = pgTable(
  'auth_session',
  {
    id: idColumn(),
    firmId: firmIdColumn(),
    personId: uuid('person_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Compared with the X-CSRF-Token header; useless without the session cookie. */
    csrfToken: text('csrf_token').notNull(),
    mfaSatisfied: boolean('mfa_satisfied').notNull().default(false),
    /** How the person signed in. */
    method: text('method').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    lastSeenAt: instant('last_seen_at').notNull().defaultNow(),
    expiresAt: instant('expires_at').notNull(),
    revokedAt: instant('revoked_at'),
  },
  (t) => [
    foreignKey({
      name: 'auth_session_person_fk',
      columns: [t.firmId, t.personId],
      foreignColumns: [person.firmId, person.id],
    }),
    uniqueIndex('auth_session_token_key').on(t.tokenHash),
    index('auth_session_person_idx').on(t.personId),
    check('auth_session_token_hash_check', sha256Hex('token_hash')),
    check('auth_session_csrf_check', sql`length(csrf_token) >= 32`),
    check('auth_session_method_check', sql`method in ('PASSWORD', 'MAGIC_LINK', 'INVITE')`),
    check('auth_session_expiry_check', sql`expires_at > created_at`),
    ...selfOrStaffPolicies(),
  ],
);

/**
 * An invitation to sign in, with the membership it grants on acceptance. Client admins see the invites of their
 * clients (`client_id`); firm-level invites (null client) are for firm staff.
 */
export const authInvite = pgTable(
  'auth_invite',
  {
    id: idColumn(),
    firmId: firmIdColumn(),
    personId: uuid('person_id').notNull(),
    email: text('email').notNull(),
    role: roleEnum('role').notNull(),
    clientId: uuid('client_id'),
    consultantClientIds: uuid('consultant_client_ids').array(),
    unitIds: uuid('unit_ids').array(),
    /** Expiry of the granted membership (viewers), not of the invite. */
    membershipExpiresAt: instant('membership_expires_at'),
    createdById: uuid('created_by_id').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    expiresAt: instant('expires_at').notNull(),
    acceptedAt: instant('accepted_at'),
    revokedAt: instant('revoked_at'),
  },
  (t) => [
    unique('auth_invite_firm_key').on(t.firmId, t.id),
    unique('auth_invite_person_key').on(t.firmId, t.id, t.personId),
    foreignKey({
      name: 'auth_invite_person_fk',
      columns: [t.firmId, t.personId],
      foreignColumns: [person.firmId, person.id],
    }),
    foreignKey({
      name: 'auth_invite_created_by_fk',
      columns: [t.firmId, t.createdById],
      foreignColumns: [person.firmId, person.id],
    }),
    foreignKey({
      name: 'auth_invite_client_fk',
      columns: [t.firmId, t.clientId],
      foreignColumns: [client.firmId, client.id],
    }),
    index('auth_invite_person_idx').on(t.personId),
    index('auth_invite_client_idx').on(t.clientId),
    // The same shape rules as membership (README decision 11).
    check(
      'auth_invite_client_role_check',
      sql`(role in ('FIRM_ADMIN', 'CONSULTANT')) = (client_id is null)`,
    ),
    check(
      'auth_invite_consultant_check',
      sql`(role = 'CONSULTANT') = (consultant_client_ids is not null)`,
    ),
    check(
      'auth_invite_unit_ids_check',
      sql`unit_ids is null or (role in ('OWNER', 'APPROVER') and cardinality(unit_ids) >= 1)`,
    ),
    check(
      'auth_invite_viewer_expiry_check',
      sql`role <> 'VIEWER' or membership_expires_at is not null`,
    ),
    check('auth_invite_closed_check', sql`accepted_at is null or revoked_at is null`),
    ...selfOrStaffPolicies(sql`(client_id is not null and app_can_see_client(client_id))`),
  ],
);

/** A one-time sign-in link: a magic link, or the link of an invite. */
export const authToken = pgTable(
  'auth_token',
  {
    id: idColumn(),
    firmId: firmIdColumn(),
    personId: uuid('person_id').notNull(),
    kind: text('kind').notNull(),
    inviteId: uuid('invite_id'),
    tokenHash: text('token_hash').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    expiresAt: instant('expires_at').notNull(),
    usedAt: instant('used_at'),
  },
  (t) => [
    foreignKey({
      name: 'auth_token_person_fk',
      columns: [t.firmId, t.personId],
      foreignColumns: [person.firmId, person.id],
    }),
    // An invite's link is always for the invited person.
    foreignKey({
      name: 'auth_token_invite_fk',
      columns: [t.firmId, t.inviteId, t.personId],
      foreignColumns: [authInvite.firmId, authInvite.id, authInvite.personId],
    }),
    uniqueIndex('auth_token_hash_key').on(t.tokenHash),
    index('auth_token_person_idx').on(t.personId),
    index('auth_token_invite_idx').on(t.inviteId),
    check('auth_token_hash_check', sha256Hex('token_hash')),
    check(
      'auth_token_kind_check',
      sql`(kind = 'MAGIC_LINK' and invite_id is null) or (kind = 'INVITE' and invite_id is not null)`,
    ),
    // Tokens of an invite are visible wherever the invite is (the subquery runs under auth_invite's RLS).
    ...selfOrStaffPolicies(
      sql`(invite_id is not null and exists (select 1 from auth_invite i where i.id = invite_id))`,
    ),
  ],
);
