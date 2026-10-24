import { ERROR_HTTP_STATUS, type ErrorCode, type ErrorEnvelope } from '@canopy/contracts';

/** Codes contracts 1.5.0 adds (ADR M15-0001); listed here first so its merge finds a message for each. */
type AccountErrorCode = 'ACCOUNT_SUSPENDED' | 'PLAN_LIMIT_REACHED';

const DEFAULT_MESSAGES: Partial<Record<ErrorCode | AccountErrorCode, string>> = {
  VALIDATION: 'The request is not valid.',
  UNAUTHENTICATED: 'Sign in to continue.',
  MFA_REQUIRED: 'Two-step verification is required.',
  FORBIDDEN: 'You do not have permission to do this.',
  ACCESS_EXPIRED: 'Your access has expired.',
  ACCOUNT_SUSPENDED: 'Your account is paused. Contact PlanetPulse.',
  PLAN_LIMIT_REACHED: 'Your plan limit is reached. Contact PlanetPulse to upgrade.',
  NOT_FOUND: 'Not found.',
  STALE_VERSION: 'Someone else changed this; reload and try again.',
  INVALID_TRANSITION: 'This action is not allowed in the current state.',
  DUPLICATE: 'This already exists.',
  IMPORT_STATE: 'This import step is not available yet.',
  FIRM_CHOICE_REQUIRED: 'This email signs in to more than one firm; choose one.',
  FILE_TOO_LARGE: 'The file is too large.',
  UNSUPPORTED_FILE: 'This file type is not supported.',
  REASON_REQUIRED: 'A reason is required.',
  DATE_IN_FUTURE: 'The date cannot be in the future.',
  EVIDENCE_REQUIRED: 'Evidence is required.',
  EVIDENCE_NOT_READY: 'Evidence is still being checked.',
  RULE_INVALID: 'The recurrence rule is not valid.',
  IMPORT_BLOCKED: 'The import has blocking issues.',
  RATE_LIMITED: 'Too many attempts; try again later.',
  INTERNAL: 'Something went wrong.',
};

/**
 * An error with a stable contract code (docs/contracts/api-conventions.md §5). Throw it from hooks and
 * handlers; the error handler that `registerAuth` installs renders it as an `ErrorEnvelope`.
 * `details` must never carry personal data from evidence or another tenant's data.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, details?: Record<string, unknown>, message?: string) {
    super(message ?? DEFAULT_MESSAGES[code] ?? 'Something went wrong.');
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = ERROR_HTTP_STATUS[code];
    this.details = details;
  }
}

/** The response body for an error. */
export function errorEnvelope(error: ApiError, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
    requestId,
  };
}
