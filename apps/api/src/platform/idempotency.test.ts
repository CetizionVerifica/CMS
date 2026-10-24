import { describe, expect, it, vi } from 'vitest';
import { IDEMPOTENCY_TTL_MS, OperatorIdempotency } from './idempotency.js';

const KEY = '0192f3a1-0000-7000-8000-000000000001';
const t0 = new Date('2026-10-24T03:30:00.000Z');

describe('operator Idempotency-Key', () => {
  it('runs without a key every time', async () => {
    const cache = new OperatorIdempotency();
    const fn = vi.fn().mockResolvedValue({ id: 'a' });
    const input = { operatorId: 'op', header: undefined, path: '/accounts', body: { name: 'x' } };
    await cache.run(input, t0, fn);
    await cache.run(input, t0, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('answers a repeat with the first response for 24 hours, whatever the property order', async () => {
    const cache = new OperatorIdempotency();
    const fn = vi.fn().mockResolvedValueOnce({ id: 'a' }).mockResolvedValueOnce({ id: 'b' });
    const run = (body: unknown, at: Date) =>
      cache.run({ operatorId: 'op', header: KEY, path: '/accounts', body }, at, fn);
    expect(await run({ name: 'x', kind: 'ENTERPRISE' }, t0)).toEqual({ id: 'a' });
    expect(await run({ kind: 'ENTERPRISE', name: 'x' }, new Date(t0.getTime() + 60_000))).toEqual({
      id: 'a',
    });
    expect(fn).toHaveBeenCalledOnce();
    expect(
      await run({ name: 'x', kind: 'ENTERPRISE' }, new Date(t0.getTime() + IDEMPOTENCY_TTL_MS)),
    ).toEqual({
      id: 'b',
    });
  });

  it('keeps operators apart, and refuses a key reused for another request or not a UUID', async () => {
    const cache = new OperatorIdempotency();
    const fn = vi.fn().mockResolvedValue({ id: 'a' });
    await cache.run({ operatorId: 'op', header: KEY, path: '/accounts', body: { n: 1 } }, t0, fn);
    await cache.run(
      { operatorId: 'other', header: KEY, path: '/accounts', body: { n: 1 } },
      t0,
      fn,
    );
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(
      cache.run({ operatorId: 'op', header: KEY, path: '/accounts', body: { n: 2 } }, t0, fn),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      cache.run({ operatorId: 'op', header: 'nope', path: '/accounts', body: null }, t0, fn),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('keeps nothing when the request fails, so a retry runs again', async () => {
    const cache = new OperatorIdempotency();
    const fn = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ id: 'a' });
    const input = { operatorId: 'op', header: KEY, path: '/accounts', body: [1, { b: 2 }] };
    await expect(cache.run(input, t0, fn)).rejects.toThrow('down');
    expect(await cache.run(input, t0, fn)).toEqual({ id: 'a' });
  });

  it('runs once for two concurrent posts with the same key, and both get the first response', async () => {
    const cache = new OperatorIdempotency();
    let finish!: (value: { id: string }) => void;
    const fn = vi.fn(() => new Promise<{ id: string }>((resolve) => (finish = resolve)));
    const input = { operatorId: 'op', header: KEY, path: '/accounts', body: { name: 'x' } };
    const first = cache.run(input, t0, fn);
    const second = cache.run(input, t0, fn);
    finish({ id: 'a' });
    expect(await Promise.all([first, second])).toEqual([{ id: 'a' }, { id: 'a' }]);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('a repeat waiting on a first request that fails gets the same failure, and a later retry runs', async () => {
    const cache = new OperatorIdempotency();
    let fail!: (error: Error) => void;
    const fn = vi
      .fn()
      .mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
      .mockResolvedValueOnce({ id: 'b' });
    const input = { operatorId: 'op', header: KEY, path: '/accounts', body: { name: 'x' } };
    const first = cache.run(input, t0, fn);
    const second = cache.run(input, t0, fn);
    fail(new Error('down'));
    await expect(first).rejects.toThrow('down');
    await expect(second).rejects.toThrow('down');
    expect(await cache.run(input, t0, fn)).toEqual({ id: 'b' });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
