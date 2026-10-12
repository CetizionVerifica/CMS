import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '../src/database.js';
import { DbError } from '../src/errors.js';
import * as r from '../src/repositories/index.js';
import { systemContext, type TenantContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { populateFirm, type PopulatedFirm } from './support/populate.js';

/** M7's Idempotency-Key replay store (migrations 0014, 0015). Isolation is in isolation.db.test.ts. */

let t: TestDatabase;
let a: PopulatedFirm;
let ownerId: string;
let approverId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  a = await populateFirm(t.db, await t.admin.createFirm({ name: 'Demo Advisory' }), 'a');
  [ownerId, approverId] = a.rows['person']!.firmLevel as [string, string];
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

const asPerson = (personId: string): TenantContext => ({
  firmId: a.firmId,
  personId,
  clientIds: [a.clientIds[0]],
  requestId: 'idempotency-test',
});
const asSystem = () => systemContext(a.firmId, 'idempotency-test');
const as = <T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>) => t.db.withTenant(ctx, fn);

const record = (personId: string, key: string, created: string, expires: string) => ({
  personId,
  key,
  method: 'POST' as const,
  path: '/v1/instances/0192/submit',
  requestHash: 'a'.repeat(64),
  responseStatus: 201,
  responseBody: { id: '0192', state: 'SUBMITTED' },
  createdAt: created,
  expiresAt: expires,
});
const code = (e: unknown) => (e instanceof DbError ? e.code : String(e));
const NOW = new Date('2026-10-12T10:00:00.000Z');

describe('idempotencyKeys', () => {
  it('records a response and finds it for the same person only', async () => {
    const rec = record(ownerId, 'k-find', '2026-10-12T09:00:00.000Z', '2026-10-13T09:00:00.000Z');
    expect(await as(asPerson(ownerId), (tx) => r.idempotencyKeys.record(tx, rec))).toEqual(rec);
    expect(
      await as(asPerson(ownerId), (tx) => r.idempotencyKeys.find(tx, ownerId, 'k-find', NOW)),
    ).toEqual(rec);
    // Another person neither sees it nor collides with it.
    expect(
      await as(asPerson(approverId), (tx) => r.idempotencyKeys.find(tx, ownerId, 'k-find', NOW)),
    ).toBeNull();
    const theirs = { ...rec, personId: approverId };
    expect(await as(asPerson(approverId), (tx) => r.idempotencyKeys.record(tx, theirs))).toEqual(
      theirs,
    );
    // A person cannot write a key for someone else.
    const forged = { ...rec, key: 'k-forged', personId: approverId };
    await expect(
      as(asPerson(ownerId), (tx) => r.idempotencyKeys.record(tx, forged)),
    ).rejects.toSatisfy(
      (e) =>
        code(e) === 'FORBIDDEN' || String((e as Error).cause ?? e).includes('row-level security'),
    );
  });

  it('refuses a second record of an unexpired key, also from a concurrent transaction', async () => {
    const rec = record(ownerId, 'k-dup', '2026-10-12T09:00:00.000Z', '2026-10-13T09:00:00.000Z');
    await as(asPerson(ownerId), (tx) => r.idempotencyKeys.record(tx, rec));
    await expect(
      as(asPerson(ownerId), (tx) => r.idempotencyKeys.record(tx, { ...rec, responseStatus: 409 })),
    ).rejects.toSatisfy((e) => code(e) === 'DUPLICATE');

    const race = record(ownerId, 'k-race', '2026-10-12T09:00:00.000Z', '2026-10-13T09:00:00.000Z');
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        as(asPerson(ownerId), async (tx) => {
          const out = await r.idempotencyKeys.record(tx, race);
          await tx.execute(sql`SELECT pg_sleep(0.1)`);
          return out;
        }),
      ),
    );
    expect(results.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    const failed = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(code(failed.reason)).toBe('DUPLICATE');
  });

  it('treats an expired record as absent and replaces it', async () => {
    const old = record(ownerId, 'k-old', '2026-10-10T09:00:00.000Z', '2026-10-11T09:00:00.000Z');
    await as(asPerson(ownerId), (tx) => r.idempotencyKeys.record(tx, old));
    expect(
      await as(asPerson(ownerId), (tx) => r.idempotencyKeys.find(tx, ownerId, 'k-old', NOW)),
    ).toBeNull();
    const fresh = {
      ...record(ownerId, 'k-old', '2026-10-12T09:00:00.000Z', '2026-10-13T09:00:00.000Z'),
      responseStatus: 200,
    };
    expect(await as(asPerson(ownerId), (tx) => r.idempotencyKeys.record(tx, fresh))).toEqual(fresh);
    expect(
      await as(asPerson(ownerId), (tx) => r.idempotencyKeys.find(tx, ownerId, 'k-old', NOW)),
    ).toEqual(fresh);
  });

  it('purges only expired rows; a person context reaches only its own, and unexpired rows never go', async () => {
    const past = (key: string, personId = ownerId) =>
      record(personId, key, '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
    await as(asPerson(ownerId), (tx) => r.idempotencyKeys.record(tx, past('p-own')));
    await as(asPerson(approverId), (tx) =>
      r.idempotencyKeys.record(tx, past('p-other', approverId)),
    );
    const live = record(ownerId, 'p-live', '2026-10-12T09:00:00.000Z', '2099-01-01T00:00:00.000Z');
    await as(asPerson(ownerId), (tx) => r.idempotencyKeys.record(tx, live));

    // The owner's context purges the owner's expired row only.
    expect(await as(asPerson(ownerId), (tx) => r.idempotencyKeys.purgeExpired(tx, NOW))).toBe(1);
    // Asked to purge with a `now` past the live row's expiry, the policy still keeps it (now() is 2026).
    const far = new Date('2100-01-01T00:00:00Z');
    expect(await as(asSystem(), (tx) => r.idempotencyKeys.purgeExpired(tx, far, 10))).toBe(1);
    const raw = await as(asSystem(), (tx) =>
      tx.execute(sql`DELETE FROM idempotency_key WHERE key = 'p-live'`),
    );
    expect(raw.rowCount).toBe(0);
    expect(
      await as(asPerson(ownerId), (tx) => r.idempotencyKeys.find(tx, ownerId, 'p-live', NOW)),
    ).toEqual(live);
  });

  it('validates input and the database refuses malformed rows', async () => {
    const rec = record(ownerId, 'k-bad', '2026-10-12T09:00:00.000Z', '2026-10-13T09:00:00.000Z');
    for (const bad of [
      { ...rec, requestHash: 'not-a-hash' },
      { ...rec, key: '' },
      { ...rec, method: 'GET' },
      { ...rec, responseStatus: 99 },
      { ...rec, path: 'v1/no-slash' },
    ]) {
      await expect(
        as(asPerson(ownerId), (tx) => r.idempotencyKeys.record(tx, bad as typeof rec)),
      ).rejects.toSatisfy((e) => code(e) === 'VALIDATION');
    }
    await expect(
      as(asPerson(ownerId), (tx) =>
        r.idempotencyKeys.record(tx, { ...rec, expiresAt: rec.createdAt }),
      ),
    ).rejects.toSatisfy((e) => code(e) === 'VALIDATION');
  });
});
