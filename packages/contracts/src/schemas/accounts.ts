import { z } from 'zod';
import {
  AccountKind,
  AccountStatus,
  OperatorAuditAction,
  SupportAccessLevel,
  SupportGrantStatus,
} from '../enums.js';
import {
  Email,
  Gstin,
  Id,
  Instant,
  LocalDate,
  Month,
  Name,
  PlanCode,
  TimeZone,
} from '../primitives.js';

/**
 * Customer accounts, plans and the platform operator (ADR M15-0001, docs/contracts/domain-model.md §9).
 * An account is a firm; the operator sits outside every tenant.
 */

/** A limit: a whole number, or null for unlimited. */
const Limit = z.int().min(0).nullable();

export const PlanLimits = z.strictObject({
  companies: Limit,
  units: Limit,
  users: Limit,
  storageBytes: Limit,
});
export type PlanLimits = z.infer<typeof PlanLimits>;

/** Feature flag names, e.g. "importer"; lower camelCase. */
export const FeatureFlag = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]{1,39}$/, 'Expected a camelCase flag');

/** A plan. Data, not code: the operator edits names and limits without a release. Prices are not stored. */
export const Plan = z.strictObject({
  code: PlanCode,
  name: Name,
  limits: PlanLimits,
  features: z.array(FeatureFlag),
  /** Retired plans stay on the accounts that have them but cannot be chosen for new ones. */
  retiredAt: Instant.nullable(),
});
export type Plan = z.infer<typeof Plan>;

/** Per-account changes on top of the plan. A key that is absent keeps the plan's value. */
export const AccountOverride = z.strictObject({
  limits: PlanLimits.partial(),
  features: z.array(FeatureFlag),
  note: z.string().trim().max(2000).nullable(),
});
export type AccountOverride = z.infer<typeof AccountOverride>;

/** Counted usage, compared with the limits. `users` excludes support people. */
export const Usage = z.strictObject({
  companies: z.int().min(0),
  units: z.int().min(0),
  users: z.int().min(0),
  storageBytes: z.int().min(0),
});
export type Usage = z.infer<typeof Usage>;

/** What `entitlements(account)` returns: plan limits overlaid with the account override. */
export const Entitlements = z.strictObject({
  planCode: PlanCode,
  limits: PlanLimits,
  features: z.array(FeatureFlag),
});
export type Entitlements = z.infer<typeof Entitlements>;

/** The account as its own people see it (`Me.account`). */
export const AccountSummary = z.strictObject({
  kind: AccountKind,
  status: AccountStatus,
  trialEndsOn: LocalDate.nullable(),
});
export type AccountSummary = z.infer<typeof AccountSummary>;

/** An offline billing period the operator records (ADR M15-0001 decision 6). Amounts are in paise. */
export const Subscription = z
  .strictObject({
    id: Id,
    accountId: Id,
    planCode: PlanCode,
    startsOn: LocalDate,
    endsOn: LocalDate,
    amountPaise: z.int().min(0),
    invoiceNumber: z.string().trim().min(1).max(100).nullable(),
    paidOn: LocalDate.nullable(),
    recordedAt: Instant,
    recordedById: Id,
  })
  .refine((s) => s.endsOn >= s.startsOn, {
    path: ['endsOn'],
    message: 'endsOn must not be before startsOn',
  });
export type Subscription = z.infer<typeof Subscription>;

/** Nightly usage count per account (M9). */
export const UsageSnapshot = z.strictObject({
  accountId: Id,
  takenOn: LocalDate,
  usage: Usage,
  activeUsers30d: z.int().min(0),
  instances: z.int().min(0),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;

/** A PlanetPulse staff member who can sign in to the operator console. */
export const PlatformOperator = z.strictObject({
  id: Id,
  email: Email,
  displayName: Name,
  createdAt: Instant,
  disabledAt: Instant.nullable(),
});
export type PlatformOperator = z.infer<typeof PlatformOperator>;

/** Append-only operator audit (ADR M15-0001 decision 12). `operatorId` is null for the system (jobs). */
export const OperatorAuditEvent = z.strictObject({
  id: Id,
  at: Instant,
  operatorId: Id.nullable(),
  action: OperatorAuditAction,
  accountId: Id.nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().trim().min(1).max(2000).nullable(),
  requestId: z.string().min(1).max(200),
  ip: z.string().max(100).nullable(),
});
export type OperatorAuditEvent = z.infer<typeof OperatorAuditEvent>;

/** Time-boxed PlanetPulse support access an account admin grants (ADR M15-0001 decision 11). */
export const SupportGrant = z
  .strictObject({
    id: Id,
    accountId: Id,
    level: SupportAccessLevel,
    status: SupportGrantStatus,
    startsAt: Instant,
    endsAt: Instant,
    grantedById: Id,
    revokedAt: Instant.nullable(),
    revokedById: Id.nullable(),
    /** The support person the grant's memberships belong to. */
    supportPersonId: Id,
  })
  .refine((g) => Date.parse(g.endsAt) > Date.parse(g.startsAt), {
    path: ['endsAt'],
    message: 'endsAt must be after startsAt',
  })
  .refine((g) => (g.status === 'REVOKED') === (g.revokedAt !== null), {
    path: ['revokedAt'],
    message: 'revokedAt is set exactly when the grant is REVOKED',
  });
export type SupportGrant = z.infer<typeof SupportGrant>;

/**
 * A support grant as the operator sees it: only the columns `canopy_operator` may read (ADR M15-0001 decision 8), no
 * person ids.
 */
export const OperatorSupportGrant = z
  .strictObject({
    id: Id,
    accountId: Id,
    level: SupportAccessLevel,
    status: SupportGrantStatus,
    startsAt: Instant,
    endsAt: Instant,
    revokedAt: Instant.nullable(),
  })
  .refine((g) => Date.parse(g.endsAt) > Date.parse(g.startsAt), {
    path: ['endsAt'],
    message: 'endsAt must be after startsAt',
  })
  .refine((g) => (g.status === 'REVOKED') === (g.revokedAt !== null), {
    path: ['revokedAt'],
    message: 'revokedAt is set exactly when the grant is REVOKED',
  });
export type OperatorSupportGrant = z.infer<typeof OperatorSupportGrant>;

/** Profile details the operator records for an account. */
export const AccountProfile = z.strictObject({
  legalName: Name,
  gstin: Gstin.nullable(),
  timeZone: TimeZone,
  fyStartMonth: Month,
});
export type AccountProfile = z.infer<typeof AccountProfile>;

/**
 * The operator's view of an account: never any client data, only the firm row, plan and counts. The owner's name and
 * email live in `person` and `invite`, which the operator may not read (ADR M15-0001 decision 8); the owner has
 * accepted once `status` has left PROVISIONING.
 */
export const Account = z.strictObject({
  id: Id,
  name: Name,
  kind: AccountKind,
  status: AccountStatus,
  profile: AccountProfile,
  planCode: PlanCode,
  entitlements: Entitlements,
  usage: Usage,
  trialEndsOn: LocalDate.nullable(),
  /** When the master library was copied in (ADR M15-0001 decision 7); null while a new account waits for it. */
  libraryCopiedAt: Instant.nullable(),
  onboardedAt: Instant.nullable(),
  deletionRequestedAt: Instant.nullable(),
  /** When the purge may run: `deletionRequestedAt` + the grace period. */
  purgeAfter: Instant.nullable(),
  createdAt: Instant,
  version: z.int().min(1),
});
export type Account = z.infer<typeof Account>;
