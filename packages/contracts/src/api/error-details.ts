import { z } from 'zod';
import { type ErrorCode, ErrorCode as ErrorCodeSchema } from '../errors.js';
import {
  AccountStatus,
  InstanceAction,
  ImportBatchStatus,
  IsoEntityType,
  PlanLimitKey,
  ScanStatus,
  WorkflowState,
} from '../enums.js';
import { Id, Instant, LocalDate, Name } from '../primitives.js';
import { FeatureFlag } from '../schemas/accounts.js';
import { Action } from '../schemas/context.js';

/**
 * `error.details` for each error code (api-conventions.md §5). Codes with no details send none.
 * Details never carry personal data from evidence or another tenant's data.
 */
export const ERROR_DETAILS = {
  VALIDATION: z.strictObject({
    issues: z.array(
      z.strictObject({ path: z.array(z.union([z.string(), z.int()])), message: z.string() }),
    ),
  }),
  UNAUTHENTICATED: null,
  MFA_REQUIRED: z.strictObject({ enrolled: z.boolean() }),
  FORBIDDEN: z.strictObject({ action: Action }),
  ACCESS_EXPIRED: z.strictObject({ expiredAt: Instant }),
  /** The account is not TRIAL or ACTIVE (ADR M15-0001 decision 4). */
  ACCOUNT_SUSPENDED: z.strictObject({ status: AccountStatus }),
  /** Creating one more would pass the plan's limit; `max` is the limit, `used` the current count. */
  PLAN_LIMIT_REACHED: z.strictObject({
    limit: PlanLimitKey,
    max: z.int().min(0),
    used: z.int().min(0),
  }),
  /** The route belongs to an add-on the account does not have (ADR M16-0001 decision 3); reads answer it too. */
  FEATURE_NOT_ENABLED: z.strictObject({ feature: FeatureFlag }),
  /** The add-on is on but its data is still being set up (the ISO catalogue copy, docs/iso/plan.md §4.3). */
  FEATURE_NOT_READY: z.strictObject({ feature: FeatureFlag }),
  NOT_FOUND: null,
  STALE_VERSION: z.strictObject({ currentVersion: z.int().min(1) }),
  /**
   * An instance action, (operator routes) an account status move, or an ISO action: `entity` names the record, `from`
   * its state (or N/A state) and `action` the machine action of docs/iso/model.md §4, or `UPDATE` for a field edit or a
   * new child row on a locked record (model §1.8).
   */
  INVALID_TRANSITION: z.union([
    z.strictObject({ from: WorkflowState, action: InstanceAction }),
    z.strictObject({ from: AccountStatus, to: AccountStatus }),
    z.strictObject({
      entity: IsoEntityType,
      from: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      action: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    }),
  ]),
  DUPLICATE: z.strictObject({ field: z.string().min(1), existingId: Id }),
  IMPORT_STATE: z.strictObject({
    status: ImportBatchStatus,
    expected: z.array(ImportBatchStatus).min(1),
  }),
  /** Sent only after the password matched in every firm listed. */
  FIRM_CHOICE_REQUIRED: z.strictObject({
    firms: z.array(z.strictObject({ id: Id, name: Name })).min(2),
  }),
  FILE_TOO_LARGE: z.strictObject({ maxBytes: z.int().min(1) }),
  UNSUPPORTED_FILE: z.strictObject({ allowed: z.array(z.string()).min(1) }),
  REASON_REQUIRED: null,
  DATE_IN_FUTURE: z.strictObject({ today: LocalDate }),
  EVIDENCE_REQUIRED: null,
  EVIDENCE_NOT_READY: z.strictObject({ scanStatus: ScanStatus }),
  RULE_INVALID: z.strictObject({
    issues: z.array(z.strictObject({ path: z.array(z.string()), message: z.string() })),
  }),
  IMPORT_BLOCKED: z.strictObject({ blockingIssueIds: z.array(Id).min(1) }),
  RATE_LIMITED: z.strictObject({ retryAfterSeconds: z.int().min(1) }),
  INTERNAL: null,
} as const satisfies Record<ErrorCode, z.ZodType | null>;

type DetailsOf<C extends ErrorCode> = (typeof ERROR_DETAILS)[C] extends z.ZodType
  ? z.infer<(typeof ERROR_DETAILS)[C]>
  : undefined;

/** An error response whose `details` match its code. */
export type ApiError = {
  [C in ErrorCode]: {
    error: { code: C; message: string; details?: DetailsOf<C> };
    requestId: string;
  };
}[ErrorCode];

/** ErrorEnvelope with `details` checked against the code. Providers and the mock server send this. */
export const ApiErrorResponse = z.strictObject({
  error: z.discriminatedUnion(
    'code',
    ErrorCodeSchema.options.map((code) => {
      const details = ERROR_DETAILS[code];
      return z.strictObject({
        code: z.literal(code),
        message: z.string().min(1),
        ...(details === null ? {} : { details: details.optional() }),
      });
    }) as unknown as [z.ZodObject, ...z.ZodObject[]],
  ),
  requestId: z.string().min(1),
});
