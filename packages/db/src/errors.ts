import type { ErrorCode } from '@canopy/contracts';
import type { z } from 'zod';

/**
 * A repository failure the API can map straight to its error envelope (api-conventions.md §5).
 * The message names the table and constraint only: never row values, which may hold personal data.
 */
export class DbError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DbError';
    this.code = code;
  }
}

interface PgErrorLike {
  code: string;
  table?: string;
  constraint?: string;
}

function pgError(error: unknown): PgErrorLike | null {
  let e: unknown = error;
  for (let depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    if ('code' in e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
      return e as PgErrorLike;
    }
    e = 'cause' in e ? e.cause : undefined;
  }
  return null;
}

/** Postgres SQLSTATE → contract error code, for the errors a repository caller can cause. */
const SQLSTATE: Record<string, ErrorCode> = {
  '23505': 'DUPLICATE', // unique_violation
  '23503': 'NOT_FOUND', // foreign_key_violation: the referenced row is missing or in another tenant
  '23514': 'VALIDATION', // check_violation
  '23502': 'VALIDATION', // not_null_violation
  '22P02': 'VALIDATION', // invalid_text_representation (bad uuid, enum value)
  '42501': 'FORBIDDEN', // insufficient_privilege, including RLS WITH CHECK
};

/** Rethrows a database error as a DbError when it is one a caller can cause; anything else unchanged. */
export function rethrow(error: unknown): never {
  if (error instanceof DbError) throw error;
  const pg = pgError(error);
  const code = pg ? SQLSTATE[pg.code] : undefined;
  if (pg && code) {
    const where = [pg.table, pg.constraint].filter(Boolean).join('.');
    throw new DbError(code, `${code}${where ? ` (${where})` : ''}`, { cause: error });
  }
  throw error;
}

/** Parses repository input with a schema; failures are VALIDATION, naming fields, never values. */
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues
      .map((i) => i.path.map(String).join('.') || '(root)')
      .join(', ');
    throw new DbError('VALIDATION', `Invalid input: ${fields}`, { cause: result.error });
  }
  return result.data;
}
