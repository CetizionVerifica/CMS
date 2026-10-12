import type { ComplianceInstance } from '@canopy/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import {
  addInstance,
  createTestDb,
  seedFixture,
  type Cast,
  type Fixture,
  type TestDb,
} from './testing/fixture.js';

/**
 * `Idempotency-Key` on transitions and bulk approve against Postgres (api-conventions.md §2): a repeat by
 * the same person within 24 hours gets the first response and writes nothing; the key is per person; a
 * refused request is not kept; concurrent repeats change the instance once; a key reused for another
 * request is a 400. Today is 2023-01-20.
 */

const NOW = new Date('2023-01-20T06:00:00Z');
const LATER = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);

let testDb: TestDb;
let app: FastifyInstance;
let later: FastifyInstance;
let f: Fixture;
const auth = createTestAuth();
const headers = {} as Record<keyof Cast, Record<string, string>>;

beforeAll(async () => {
  testDb = await createTestDb();
  f = await seedFixture(testDb.db, await testDb.createFirm('Idempotent firm'), 'I');
  for (const key of Object.keys(f.people) as (keyof Cast)[]) {
    headers[key] = auth.signIn({
      firmId: f.firmId,
      personId: f.people[key],
      memberships: f.memberships[key],
      principal: { firmClientIds: [f.clientId] },
    }).headers;
  }
  const server = (clock: Date) =>
    buildServer({
      authStore: auth.store,
      database: testDb.db,
      clock: () => clock,
      rateLimit: { max: 100_000, timeWindow: '1 minute' },
    });
  app = server(NOW);
  later = server(LATER);
  await Promise.all([app.ready(), later.ready()]);
}, 120_000);

afterAll(async () => {
  await Promise.all([app?.close(), later?.close()]);
  await testDb?.drop();
});

let seq = 0;
function fresh(state: 'OPEN' | 'SUBMITTED' = 'SUBMITTED'): Promise<ComplianceInstance> {
  seq += 1;
  return addInstance(testDb.db, f, {
    assignment: 'plain',
    periodStart: `${1800 + seq}-01-01`,
    dueDate: '2023-02-15',
    state,
  });
}

let keys = 0;
const newKey = () => `0190f000-0000-7000-8000-${String(++keys).padStart(12, '0')}`;

async function post(
  who: keyof Cast,
  url: string,
  payload: object,
  key?: string,
  server: FastifyInstance = app,
) {
  const res = await server.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: { ...headers[who], ...(key === undefined ? {} : { 'idempotency-key': key }) },
    payload,
  });
  return {
    status: res.statusCode,
    body: res.json() as Record<string, unknown> & {
      error?: { code: string; details?: unknown };
    },
  };
}

/** How many audit and outbox rows the firm has. */
async function counts() {
  const { audit, outbox } = await testDb.written(f.firmId);
  return { audit: audit.size, outbox: outbox.size };
}

describe('transitions', () => {
  it('answers a repeat with the first response and changes nothing more', async () => {
    const i = await fresh();
    const key = newKey();
    const first = await post('approver', `/instances/${i.id}/approve`, { version: i.version }, key);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ workflowState: 'APPROVED', version: i.version + 1 });
    const before = await counts();

    const repeat = await post(
      'approver',
      `/instances/${i.id}/approve`,
      { version: i.version },
      key,
    );
    expect(repeat).toEqual(first);
    expect(await counts()).toEqual(before);

    // Without the key, the same request runs and is refused: the instance moved on.
    const unkeyed = await post('approver', `/instances/${i.id}/approve`, { version: i.version });
    expect(unkeyed.body.error).toMatchObject({ code: 'STALE_VERSION' });
  });

  it('replays the first response even after the instance changed again', async () => {
    const i = await fresh();
    const key = newKey();
    const first = await post('approver', `/instances/${i.id}/approve`, { version: i.version }, key);
    const reopened = await post('clientAdmin', `/instances/${i.id}/reopen`, {
      version: i.version + 1,
      reason: 'Wrong challan.',
    });
    expect(reopened.body).toMatchObject({ workflowState: 'OPEN' });
    const repeat = await post(
      'approver',
      `/instances/${i.id}/approve`,
      { version: i.version },
      key,
    );
    expect(repeat.body).toEqual(first.body);
  });

  it('refuses a key reused for a different request (400), writing nothing', async () => {
    const [a, b] = [await fresh(), await fresh()];
    const key = newKey();
    expect(
      (await post('approver', `/instances/${a.id}/approve`, { version: a.version }, key)).status,
    ).toBe(200);
    const before = await counts();
    for (const [url, body] of [
      [`/instances/${b.id}/approve`, { version: b.version }],
      [`/instances/${a.id}/approve`, { version: a.version, comment: 'Different body.' }],
      [`/instances/${a.id}/send-back`, { version: a.version, reason: 'Different action.' }],
    ] as const) {
      const res = await post('approver', url, body, key);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'VALIDATION',
        details: { issues: [{ path: ['Idempotency-Key'] }] },
      });
    }
    expect(await counts()).toEqual(before);
    expect(
      (await post('approver', `/instances/${b.id}/approve`, { version: b.version })).status,
    ).toBe(200);
  });

  it('refuses a key that is not a UUID before doing anything', async () => {
    const i = await fresh();
    const res = await post('approver', `/instances/${i.id}/approve`, { version: i.version }, 'abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION' });
    expect(
      (await post('approver', `/instances/${i.id}/approve`, { version: i.version })).status,
    ).toBe(200);
  });

  it('keeps keys per person', async () => {
    const [mine, theirs] = [await fresh('OPEN'), await fresh()];
    const key = newKey();
    const submitted = await post(
      'owner',
      `/instances/${mine.id}/submit`,
      { version: mine.version, completedOn: '2023-01-19', comment: 'Filed.' },
      key,
    );
    expect(submitted.body).toMatchObject({ workflowState: 'SUBMITTED' });
    const approved = await post(
      'approver',
      `/instances/${theirs.id}/approve`,
      { version: theirs.version },
      key,
    );
    expect(approved.body).toMatchObject({ id: theirs.id, workflowState: 'APPROVED' });
  });

  it('does not keep a refused request, so a corrected repeat with the key runs', async () => {
    const i = await fresh();
    const key = newKey();
    const stale = await post('approver', `/instances/${i.id}/approve`, { version: 99 }, key);
    expect(stale.body.error).toMatchObject({ code: 'STALE_VERSION' });
    const blank = await post(
      'approver',
      `/instances/${i.id}/send-back`,
      { version: i.version, reason: ' ' },
      newKey(),
    );
    expect(blank.status).toBe(400);
    const fixed = await post('approver', `/instances/${i.id}/approve`, { version: i.version }, key);
    expect(fixed.body).toMatchObject({ workflowState: 'APPROVED' });
  });

  it('changes the instance once when the same keyed request arrives twice at once', async () => {
    const i = await fresh();
    const key = newKey();
    const before = await counts();
    const [a, b] = await Promise.all([
      post('approver', `/instances/${i.id}/approve`, { version: i.version }, key),
      post('approver', `/instances/${i.id}/approve`, { version: i.version }, key),
    ]);
    expect(a.status).toBe(200);
    expect(b).toEqual(a);
    const after = await counts();
    // One TRANSITION audit event; its comment, approved and status events go to the outbox once.
    expect(after.audit - before.audit).toBe(1);
  });

  it('forgets a key after 24 hours', async () => {
    const i = await fresh();
    const key = newKey();
    const url = `/instances/${i.id}/approve`;
    expect((await post('approver', url, { version: i.version }, key)).status).toBe(200);
    const expired = await post('approver', url, { version: i.version }, key, later);
    expect(expired.body.error).toMatchObject({ code: 'STALE_VERSION' });
  });
});

describe('bulk approve', () => {
  it('answers a repeat with the first per-item results and writes nothing more', async () => {
    const [a, b] = [await fresh(), await fresh()];
    const key = newKey();
    const url = `/clients/${f.clientId}/instances/bulk-approve`;
    const body = {
      items: [
        { id: a.id, version: a.version },
        { id: b.id, version: 99 },
      ],
    };
    const first = await post('clientAdmin', url, body, key);
    expect(first.status).toBe(200);
    expect(first.body.results).toMatchObject([
      { id: a.id, ok: true },
      { id: b.id, ok: false, error: { code: 'STALE_VERSION' } },
    ]);
    const before = await counts();
    expect(await post('clientAdmin', url, body, key)).toEqual(first);
    expect(await counts()).toEqual(before);

    const other = await post(
      'clientAdmin',
      url,
      { items: [{ id: b.id, version: b.version }] },
      key,
    );
    expect(other.status).toBe(400);
  });

  it('keeps the key when nothing was approved', async () => {
    const i = await fresh();
    const key = newKey();
    const url = `/clients/${f.clientId}/instances/bulk-approve`;
    const body = { items: [{ id: i.id, version: 99 }] };
    const first = await post('clientAdmin', url, body, key);
    expect(first.body.results).toMatchObject([{ ok: false }]);
    expect(await post('clientAdmin', url, body, key)).toEqual(first);
  });

  it('approves each item once, and answers both with one result, when the same keyed request arrives twice at once', async () => {
    const [a, b] = [await fresh(), await fresh()];
    const key = newKey();
    const url = `/clients/${f.clientId}/instances/bulk-approve`;
    const body = {
      items: [
        { id: a.id, version: a.version },
        { id: b.id, version: b.version },
      ],
    };
    const before = await counts();
    const [one, two] = await Promise.all([
      post('clientAdmin', url, body, key),
      post('clientAdmin', url, body, key),
    ]);
    expect(one.status).toBe(200);
    // The later one rolls back whole and answers with the first one's results.
    expect(two).toEqual(one);
    expect(one.body.results).toMatchObject([
      { id: a.id, ok: true },
      { id: b.id, ok: true },
    ]);
    expect((await counts()).audit - before.audit).toBe(2);
  });
});
