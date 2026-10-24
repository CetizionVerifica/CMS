import { z } from 'zod';
import { SUPPORT_GRANT_DEFAULT_DAYS, SUPPORT_GRANT_MAX_DAYS } from '../defaults.js';
import { AccountKind, AccountStatus, OperatorAuditAction, SupportAccessLevel } from '../enums.js';
import { Email, Id, Instant, LocalDate, Month, Name, PlanCode, TimeZone } from '../primitives.js';
import {
  AccountOverride,
  AccountProfile,
  AccountSummary,
  Entitlements,
  FeatureFlag,
  PlanLimits,
  PlatformOperator,
  Usage,
} from '../schemas/accounts.js';
import { checkHasChanges, pageQueryShape, Reason, SearchText, versionField } from './common.js';

/**
 * Customer accounts (ADR M15-0001, docs/contracts/endpoints.md §8-9). Customer routes are under /api/v1; operator
 * routes are under /api/platform/v1 and use the operator session, never the customer one.
 */

// ---------- customer routes (/api/v1) ----------

/** `GET /account`: the account's plan, limits and usage, for its account admins. Read-only for customers. */
export const AccountView = z.strictObject({
  id: Id,
  name: Name,
  ...AccountSummary.shape,
  entitlements: Entitlements,
  usage: Usage,
});
export type AccountView = z.infer<typeof AccountView>;

/** `POST /account/support-grants`: let PlanetPulse support in for `days` days. */
export const SupportGrantCreateBody = z.strictObject({
  level: SupportAccessLevel,
  days: z.int().min(1).max(SUPPORT_GRANT_MAX_DAYS).default(SUPPORT_GRANT_DEFAULT_DAYS),
});
export type SupportGrantCreateBody = z.input<typeof SupportGrantCreateBody>;

/** `POST /auth/support/verify`: exchange the one-time support-session token the console opened the app with. */
export const SupportSessionVerifyBody = z.strictObject({ token: z.string().min(16).max(500) });
export type SupportSessionVerifyBody = z.infer<typeof SupportSessionVerifyBody>;

// ---------- operator routes (/api/platform/v1) ----------

/** Operators sign in with email, password and a TOTP code every time (ADR M15-0001 decision 9). */
export const OperatorLoginBody = z.strictObject({
  email: Email,
  password: z.string().min(1).max(200),
  code: z.string().regex(/^\d{6}$/, 'Expected a 6-digit code'),
});
export type OperatorLoginBody = z.infer<typeof OperatorLoginBody>;

/** `GET /me` on the operator API. */
export const OperatorMe = z.strictObject({
  operator: PlatformOperator,
  /** Send as `X-CSRF-Token` on every state-changing operator request. */
  csrfToken: z.string().min(16),
  session: z.strictObject({ expiresAt: Instant, idleExpiresAt: Instant }),
});
export type OperatorMe = z.infer<typeof OperatorMe>;

export const PlanUpsertBody = z.strictObject({
  name: Name,
  limits: PlanLimits,
  features: z.array(FeatureFlag).max(50),
  retired: z.boolean(),
});
export type PlanUpsertBody = z.infer<typeof PlanUpsertBody>;

export const AccountListQuery = z.strictObject({
  ...pageQueryShape,
  status: AccountStatus.optional(),
  kind: AccountKind.optional(),
  q: SearchText.optional(),
});
export type AccountListQuery = z.infer<typeof AccountListQuery>;

/**
 * `POST /accounts`: provision an account (ADR M15-0001 decision 10). Without `trialEndsOn` or `activeNow` the trial
 * runs `DEFAULT_TRIAL_DAYS` from today. `activeNow` skips the trial: the account goes ACTIVE when the owner accepts.
 */
export const AccountCreateBody = z
  .strictObject({
    name: Name,
    kind: AccountKind,
    planCode: PlanCode,
    legalName: Name,
    gstin: AccountProfile.shape.gstin.default(null),
    timeZone: TimeZone.default('Asia/Kolkata'),
    fyStartMonth: Month.default(4),
    trialEndsOn: LocalDate.optional(),
    activeNow: z.boolean().default(false),
    /** ENTERPRISE only: the name of the account's one client; defaults to `name`. */
    clientName: Name.optional(),
    owner: z.strictObject({ displayName: Name, email: Email }),
  })
  .superRefine((body, ctx) => {
    if (body.activeNow && body.trialEndsOn !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['trialEndsOn'],
        message: 'Give trialEndsOn or activeNow, not both',
      });
    }
    if (body.kind === 'CONSULTANCY' && body.clientName !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['clientName'],
        message: 'Only an ENTERPRISE account gets a client at provisioning',
      });
    }
  });
export type AccountCreateBody = z.input<typeof AccountCreateBody>;

export const AccountUpdateBody = z
  .strictObject({
    ...versionField,
    name: Name.optional(),
    profile: AccountProfile.partial().optional(),
  })
  .superRefine(checkHasChanges);
export type AccountUpdateBody = z.infer<typeof AccountUpdateBody>;

/**
 * `POST /accounts/{id}/status`: convert a trial, suspend or resume. Deletion has its own routes. `trialEndsOn` moves a
 * trial's end (only with `to: TRIAL`, from TRIAL or SUSPENDED).
 */
export const AccountStatusBody = z.strictObject({
  ...versionField,
  to: z.enum(['TRIAL', 'ACTIVE', 'SUSPENDED']),
  reason: Reason,
  trialEndsOn: LocalDate.optional(),
});
export type AccountStatusBody = z.infer<typeof AccountStatusBody>;

export const AccountPlanBody = z.strictObject({
  ...versionField,
  planCode: PlanCode,
  reason: Reason,
});
export type AccountPlanBody = z.infer<typeof AccountPlanBody>;

export const AccountOverrideBody = z.strictObject({
  ...versionField,
  override: AccountOverride,
  reason: Reason,
});
export type AccountOverrideBody = z.infer<typeof AccountOverrideBody>;

/** `POST /accounts/{id}/deletion`: `confirmName` must equal the account name exactly. */
export const AccountDeletionBody = z.strictObject({
  ...versionField,
  reason: Reason,
  confirmName: Name,
});
export type AccountDeletionBody = z.infer<typeof AccountDeletionBody>;

export const AccountReasonBody = z.strictObject({ ...versionField, reason: Reason });
export type AccountReasonBody = z.infer<typeof AccountReasonBody>;

export const SubscriptionCreateBody = z
  .strictObject({
    planCode: PlanCode,
    startsOn: LocalDate,
    endsOn: LocalDate,
    amountPaise: z.int().min(0),
    invoiceNumber: z.string().trim().min(1).max(100).nullable(),
    paidOn: LocalDate.nullable(),
  })
  .refine((s) => s.endsOn >= s.startsOn, {
    path: ['endsOn'],
    message: 'endsOn must not be before startsOn',
  });
export type SubscriptionCreateBody = z.infer<typeof SubscriptionCreateBody>;

export const UsageQuery = z.strictObject({ from: LocalDate, to: LocalDate });
export type UsageQuery = z.infer<typeof UsageQuery>;

export const RenewalQuery = z.strictObject({
  withinDays: z.coerce.number().int().min(1).max(365).default(30),
});
export type RenewalQuery = z.infer<typeof RenewalQuery>;

/** One account whose latest subscription ends within the window, or whose trial does. */
export const Renewal = z.strictObject({
  accountId: Id,
  name: Name,
  status: AccountStatus,
  planCode: PlanCode,
  /** The latest subscription's `endsOn`, or the trial end. */
  endsOn: LocalDate,
  kind: z.enum(['SUBSCRIPTION', 'TRIAL']),
});
export type Renewal = z.infer<typeof Renewal>;

export const OperatorAuditQuery = z.strictObject({
  ...pageQueryShape,
  accountId: Id.optional(),
  action: OperatorAuditAction.optional(),
  from: Instant.optional(),
  to: Instant.optional(),
});
export type OperatorAuditQuery = z.infer<typeof OperatorAuditQuery>;

/** `POST /support-grants/{id}/sessions`: open the customer app as the grant's support person. */
export const SupportSession = z.strictObject({
  /** Customer-app URL carrying a one-time token (valid 60 seconds) for `POST /auth/support/verify`. */
  url: z.url(),
  expiresAt: Instant,
});
export type SupportSession = z.infer<typeof SupportSession>;
