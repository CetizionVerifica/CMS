import { z } from 'zod';

/** Error codes (docs/contracts/api-conventions.md §5). Clients branch on `code` only; `message` is for humans. */
export const ErrorCode = z.enum([
  'VALIDATION',
  'UNAUTHENTICATED',
  'MFA_REQUIRED',
  'FORBIDDEN',
  'ACCESS_EXPIRED',
  'ACCOUNT_SUSPENDED',
  'PLAN_LIMIT_REACHED',
  'FEATURE_NOT_ENABLED',
  'FEATURE_NOT_READY',
  'NOT_FOUND',
  'STALE_VERSION',
  'INVALID_TRANSITION',
  'DUPLICATE',
  'IMPORT_STATE',
  'FIRM_CHOICE_REQUIRED',
  'FILE_TOO_LARGE',
  'UNSUPPORTED_FILE',
  'REASON_REQUIRED',
  'DATE_IN_FUTURE',
  'EVIDENCE_REQUIRED',
  'EVIDENCE_NOT_READY',
  'RULE_INVALID',
  'IMPORT_BLOCKED',
  'RATE_LIMITED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** HTTP status for each error code. */
export const ERROR_HTTP_STATUS = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 401,
  FORBIDDEN: 403,
  ACCESS_EXPIRED: 403,
  ACCOUNT_SUSPENDED: 403,
  PLAN_LIMIT_REACHED: 403,
  FEATURE_NOT_ENABLED: 403,
  FEATURE_NOT_READY: 409,
  NOT_FOUND: 404,
  STALE_VERSION: 409,
  INVALID_TRANSITION: 409,
  DUPLICATE: 409,
  IMPORT_STATE: 409,
  FIRM_CHOICE_REQUIRED: 409,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE: 415,
  REASON_REQUIRED: 422,
  DATE_IN_FUTURE: 422,
  EVIDENCE_REQUIRED: 422,
  EVIDENCE_NOT_READY: 422,
  RULE_INVALID: 422,
  IMPORT_BLOCKED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const satisfies Record<ErrorCode, number>;

/**
 * Error response body. `details` never carries personal data from evidence or another tenant's data.
 * Per-code `details` shapes ship with the request/response schemas.
 */
export const ErrorEnvelope = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  requestId: z.string().min(1),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
