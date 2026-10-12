import { ERROR_HTTP_STATUS, type ErrorCode } from '@canopy/contracts';

/**
 * A failure the API reports as `{ error: { code, message, details? } }` (api-conventions.md §5).
 * Services throw it; the route layer turns it into the response. `details` never carries evidence
 * contents, employee names from evidence, or another tenant's data.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}
