import { describe, expect, it } from 'vitest';
import { ApiError } from '../../auth/index.js';
import { IDEMPOTENCY_TTL_MS, keyedRequest, recordFor, replay, requestHash } from './idempotency.js';

const KEY = '0190f000-0000-7000-8000-00000000c0de';
const PERSON = '0190f000-0000-7000-8000-0000000000a1';
const NOW = new Date('2023-01-20T06:00:00Z');

function codeOf(fn: () => unknown): { code: string; details: unknown } {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return { code: error.code, details: error.details };
    throw error;
  }
  throw new Error('Expected an ApiError');
}

describe('Idempotency-Key (api-conventions.md §2)', () => {
  it('is absent without the header', () => {
    expect(keyedRequest(undefined, '/api/v1/instances/x/approve', { version: 1 })).toBeUndefined();
  });

  it('refuses a header that is not one UUID (400 VALIDATION)', () => {
    for (const bad of ['abc', '', [KEY, KEY]]) {
      expect(codeOf(() => keyedRequest(bad, '/x', {}))).toEqual({
        code: 'VALIDATION',
        details: { issues: [{ path: ['Idempotency-Key'], message: 'Expected a UUID' }] },
      });
    }
  });

  it('identifies the request by path without the query string, and body', () => {
    const request = keyedRequest(KEY, '/api/v1/instances/a/approve?x=1', { version: 3 })!;
    expect(request).toEqual({
      key: KEY,
      method: 'POST',
      path: '/api/v1/instances/a/approve',
      requestHash: requestHash('POST', '/api/v1/instances/a/approve', { version: 3 }),
    });
    expect(request.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the same body the same way whatever its key order', () => {
    const a = requestHash('POST', '/p', { version: 1, comment: 'x', nested: { b: 1, a: [2, 1] } });
    const b = requestHash('POST', '/p', { nested: { a: [2, 1], b: 1 }, comment: 'x', version: 1 });
    expect(a).toBe(b);
    expect(requestHash('POST', '/p', { version: 2 })).not.toBe(
      requestHash('POST', '/p', { version: 1 }),
    );
    expect(requestHash('POST', '/q', { version: 1 })).not.toBe(
      requestHash('POST', '/p', { version: 1 }),
    );
    expect(requestHash('POST', '/p', undefined)).toBe(requestHash('POST', '/p', null));
  });

  it('keeps a JSON copy of the response for 24 hours', () => {
    const request = keyedRequest(KEY, '/p', { version: 1 })!;
    const response = { id: 'i', at: new Date('2023-01-20T05:00:00Z'), skip: undefined };
    const record = recordFor(PERSON, request, response, NOW);
    expect(record).toEqual({
      personId: PERSON,
      key: KEY,
      method: 'POST',
      path: '/p',
      requestHash: request.requestHash,
      responseStatus: 200,
      responseBody: { id: 'i', at: '2023-01-20T05:00:00.000Z' },
      createdAt: '2023-01-20T06:00:00.000Z',
      expiresAt: new Date(NOW.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
    });
    expect(record.expiresAt).toBe('2023-01-21T06:00:00.000Z');
  });

  it('replays the first response for the same request, and refuses the key for another', () => {
    const first = keyedRequest(KEY, '/p', { version: 1 })!;
    const record = recordFor(PERSON, first, { ok: true }, NOW);
    expect(replay(record, first)).toEqual({ ok: true });
    for (const other of [
      keyedRequest(KEY, '/p', { version: 2 })!,
      keyedRequest(KEY, '/q', { version: 1 })!,
      { ...first, method: 'PATCH' as unknown as 'POST' },
    ]) {
      expect(codeOf(() => replay(record, other))).toEqual({
        code: 'VALIDATION',
        details: {
          issues: [
            {
              path: ['Idempotency-Key'],
              message: 'This key was already used for a different request',
            },
          ],
        },
      });
    }
  });
});
