import type { ApiError, ErrorCode, Id } from '@canopy/contracts';
import { ERROR_HTTP_STATUS } from '@canopy/contracts';
import type { z } from 'zod';

type Details<C extends ErrorCode> = Extract<ApiError, { error: { code: C } }>['error']['details'];

/**
 * An error the API reports with a stable code (docs/contracts/api-conventions.md §5). `details` follow
 * ERROR_DETAILS for the code and never carry personal data from evidence or another tenant.
 */
export class HttpError<C extends ErrorCode = ErrorCode> extends Error {
  readonly status: number;

  constructor(
    readonly code: C,
    message: string,
    readonly details?: Details<C>,
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = ERROR_HTTP_STATUS[code];
  }
}

export const notFound = (): HttpError<'NOT_FOUND'> => new HttpError('NOT_FOUND', 'Not found');

export const forbidden = (action: string): HttpError<'FORBIDDEN'> =>
  new HttpError('FORBIDDEN', `Not allowed: ${action}`, { action });

export const stale = (currentVersion: number): HttpError<'STALE_VERSION'> =>
  new HttpError('STALE_VERSION', 'Someone else changed this record; reload it and try again.', {
    currentVersion,
  });

export const duplicate = (field: string, existingId: Id): HttpError<'DUPLICATE'> =>
  new HttpError('DUPLICATE', `A record with this ${field} already exists.`, { field, existingId });

export const invalid = (message: string, path: (string | number)[] = []): HttpError<'VALIDATION'> =>
  new HttpError('VALIDATION', message, { issues: [{ path, message }] });

/** 400 VALIDATION from a Zod error, with paths prefixed by where the value came from. */
export function fromZod(error: z.ZodError, where: string): HttpError<'VALIDATION'> {
  return new HttpError('VALIDATION', `Invalid ${where}`, {
    issues: error.issues.map((issue) => ({
      path: [where, ...issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p))],
      message: issue.message,
    })),
  });
}
