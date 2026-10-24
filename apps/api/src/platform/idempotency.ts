import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../auth/index.js';

/**
 * `Idempotency-Key` on the operator's two creating routes, `POST /accounts` and `POST /accounts/{id}/subscriptions`
 * (api-conventions.md §2): a repeat with the same key from the same operator within 24 hours gets the first
 * response, so a double click or a retried request never provisions a second account. Kept in the API process
 * (ADR M15-0003): the console has a single operator and runs on one API process. Only successful responses are kept.
 * A repeat that arrives while the first is still running waits for it, so two concurrent posts run `fn` once.
 */

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

interface Entry {
  at: number;
  requestHash: string;
  /** The first request's answer, settled or still running. */
  body: Promise<unknown>;
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

export class OperatorIdempotency {
  private readonly entries = new Map<string, Entry>();

  /**
   * Runs `fn` once per operator, key and request. Without a key it just runs. A key that is not a UUID, or one first
   * used for a different request, is a 400.
   */
  async run<T>(
    input: {
      operatorId: string;
      header: string | string[] | undefined;
      path: string;
      body: unknown;
    },
    now: Date,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (input.header === undefined) return fn();
    const key = z.uuid().safeParse(input.header);
    if (!key.success) throw keyError('Expected a UUID');
    const requestHash = createHash('sha256')
      .update(JSON.stringify([input.path, canonical(input.body ?? null)]))
      .digest('hex');
    const id = `${input.operatorId}/${key.data}`;
    this.forget(now);
    const seen = this.entries.get(id);
    if (seen) {
      if (seen.requestHash !== requestHash) {
        throw keyError('This key was already used for a different request');
      }
      return (await seen.body) as T;
    }
    const body = fn();
    this.entries.set(id, { at: now.getTime(), requestHash, body });
    try {
      return await body;
    } catch (error) {
      // A refused request changed nothing: forget it, so a retry (or a waiting repeat's retry) runs again.
      if (this.entries.get(id)?.body === body) this.entries.delete(id);
      throw error;
    }
  }

  private forget(now: Date) {
    for (const [id, entry] of this.entries) {
      if (now.getTime() - entry.at >= IDEMPOTENCY_TTL_MS) this.entries.delete(id);
    }
  }
}
