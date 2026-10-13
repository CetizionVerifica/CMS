import { createHash } from 'node:crypto';
import type { IdempotencyRecord } from '@canopy/db';
import { z } from 'zod';
import { ApiError } from '../../auth/index.js';

/**
 * `Idempotency-Key` for transitions and bulk approve (api-conventions.md §2): a repeat with the same key
 * from the same person within 24 hours gets the first response. Only successful responses are kept: a
 * refused request changed nothing, so repeating it simply runs again. None of these responses carry a
 * signed URL (root CLAUDE.md rule 6), so they can be stored.
 */

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** What identifies one keyed request: the key, and the request it was first used for. */
export interface KeyedRequest {
  readonly key: string;
  readonly method: 'POST';
  readonly path: string;
  readonly requestHash: string;
}

function keyError(message: string): ApiError {
  return new ApiError('VALIDATION', { issues: [{ path: ['Idempotency-Key'], message }] });
}

/** Sorted keys, so the hash does not depend on property order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([method, path, canonical(body ?? null)]))
    .digest('hex');
}

/** The request's key, if it sent one; a header that is not a UUID is a 400. */
export function keyedRequest(
  header: string | string[] | undefined,
  path: string,
  body: unknown,
): KeyedRequest | undefined {
  if (header === undefined) return undefined;
  const parsed = z.uuid().safeParse(header);
  if (!parsed.success) throw keyError('Expected a UUID');
  const bare = path.split('?')[0]!;
  return {
    key: parsed.data,
    method: 'POST',
    path: bare,
    requestHash: requestHash('POST', bare, body),
  };
}

/** The first response for a repeat, or a 400 when the key was first used for a different request. */
export function replay<T>(record: IdempotencyRecord, request: KeyedRequest): T {
  if (
    record.method !== request.method ||
    record.path !== request.path ||
    record.requestHash !== request.requestHash
  ) {
    throw keyError('This key was already used for a different request');
  }
  return record.responseBody as T;
}

/** The row that keeps `response` as the answer to `request`. */
export function recordFor(
  personId: string,
  request: KeyedRequest,
  response: unknown,
  now: Date,
): IdempotencyRecord {
  return {
    personId,
    key: request.key,
    method: request.method,
    path: request.path,
    requestHash: request.requestHash,
    responseStatus: 200,
    responseBody: JSON.parse(JSON.stringify(response)) as IdempotencyRecord['responseBody'],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
  };
}
