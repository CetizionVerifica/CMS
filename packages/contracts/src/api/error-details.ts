import { z } from 'zod';
import { type ErrorCode, ErrorCode as ErrorCodeSchema } from '../errors.js';
import { InstanceAction, ImportBatchStatus, ScanStatus, WorkflowState } from '../enums.js';
import { Id, Instant, LocalDate, Name } from '../primitives.js';
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
  NOT_FOUND: null,
  STALE_VERSION: z.strictObject({ currentVersion: z.int().min(1) }),
  INVALID_TRANSITION: z.strictObject({ from: WorkflowState, action: InstanceAction }),
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
