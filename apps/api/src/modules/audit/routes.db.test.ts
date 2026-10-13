import {
  AuditEvent,
  EvidenceView,
  type ComplianceInstance,
  type Evidence,
} from '@canopy/contracts';
import { evidence, systemContext } from '@canopy/db';
import { addDays, localDateIn } from '@canopy/engine';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import { createMemoryStorage } from '../evidence/testing/storage.js';
import {
  addEvidence,
  addInstance,
  createTestDb,
  seedFixture,
  type Cast,
  type Fixture,
  type TestDb,
} from '../instances/testing/fixture.js';

/**
 * M7's evidence vault and audit trail reads against Postgres with RLS on (endpoints.md §4): who may read
 * them, unit scoping for APPROVER and OWNER, every filter, paging, and isolation from another firm. The
 * client's time zone is Asia/Kolkata (the default). Today is 2023-01-20.
 */

const NOW = new Date('2023-01-20T06:00:00Z');
const TZ = 'Asia/Kolkata';
const MISSING = '0190f000-0000-7000-8000-00000000dead';

let testDb: TestDb;
let app: FastifyInstance;
let f: Fixture;
let other: Fixture;
const auth = createTestAuth();
const files = createMemoryStorage();
const headers = {} as Record<keyof Cast, Record<string, string>>;
let otherAdmin: Record<string, string>;

/** Unit A: a submitted instance with a clean and a pending file. Unit B: one clean file. */
let onA: ComplianceInstance;
let onB: ComplianceInstance;
let cleanA: Evidence;
let pendingA: Evidence;
let cleanB: Evidence;
let archived: Evidence;
/** Each person in the firm, with the roles that read whole clients. */
const WHOLE_CLIENT = ['firmAdmin', 'consultant', 'clientAdmin', 'viewer'] as const;

beforeAll(async () => {
  testDb = await createTestDb();
  f = await seedFixture(testDb.db, await testDb.createFirm('Trail firm'), 'T');
  other = await seedFixture(testDb.db, await testDb.createFirm('Other trail firm'), 'U');
  for (const key of Object.keys(f.people) as (keyof Cast)[]) {
    headers[key] = auth.signIn({
      firmId: f.firmId,
      personId: f.people[key],
      memberships: f.memberships[key],
      principal: { firmClientIds: [f.clientId] },
    }).headers;
  }
  otherAdmin = auth.signIn({
    firmId: other.firmId,
    personId: other.people.clientAdmin,
    memberships: other.memberships.clientAdmin,
    principal: { firmClientIds: [other.clientId] },
  }).headers;
  app = buildServer({
    authStore: auth.store,
    database: testDb.db,
    evidenceStorage: files.storage,
    clock: () => NOW,
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
  });
  await app.ready();

  onA = await addInstance(testDb.db, f, {
    periodStart: '2022-01-01',
    dueDate: '2023-01-31',
    state: 'SUBMITTED',
  });
  onB = await addInstance(testDb.db, f, {
    assignment: 'unitB',
    periodStart: '2022-01-01',
    dueDate: '2023-01-31',
    state: 'SUBMITTED',
  });
  cleanA = await addEvidence(testDb.db, f, onA);
  pendingA = await addEvidence(testDb.db, f, onA, 'PENDING');
  cleanB = await addEvidence(testDb.db, f, onB);
  const gone = await addEvidence(testDb.db, f, onB);
  archived = await testDb.db.withTenant(systemContext(f.firmId, 'fixture-archive'), (tx) =>
    evidence.archive(tx, gone.id),
  );

  // Trail: a download on A (EVIDENCE_DOWNLOAD), then approvals of A and B (TRANSITION), and one event in
  // the other firm.
  expect((await get('viewer', `/evidence/${cleanA.id}/download-url`)).status).toBe(200);
  for (const i of [onA, onB]) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/instances/${i.id}/approve`,
      headers: headers.approver,
      payload: { version: i.version },
    });
    expect(res.statusCode).toBe(200);
  }
  const theirs = await addInstance(testDb.db, other, {
    periodStart: '2022-01-01',
    dueDate: '2023-01-31',
    state: 'SUBMITTED',
  });
  const approved = await app.inject({
    method: 'POST',
    url: `/api/v1/instances/${theirs.id}/approve`,
    headers: otherAdmin,
    payload: { version: theirs.version },
  });
  expect(approved.statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

async function get(who: keyof Cast | Record<string, string>, url: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    headers: typeof who === 'string' ? headers[who] : who,
  });
  return {
    status: res.statusCode,
    body: res.json() as {
      items: Record<string, unknown>[];
      nextCursor: string | null;
      error?: { code: string; details?: unknown };
    },
  };
}

const ids = (body: { items: Record<string, unknown>[] }) => body.items.map((item) => item.id);

/** Every item, following `nextCursor` one item per page. */
async function walk(who: keyof Cast, url: string): Promise<unknown[]> {
  const seen: unknown[] = [];
  let cursor: string | null = null;
  const join = url.includes('?') ? '&' : '?';
  do {
    const page = await get(
      who,
      `${url}${join}limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    expect(page.status).toBe(200);
    expect(page.body.items.length).toBeLessThanOrEqual(1);
    seen.push(...ids(page.body));
    cursor = page.body.nextCursor;
  } while (cursor !== null);
  return seen;
}

describe('GET /clients/{clientId}/evidence', () => {
  const vault = (query = '') => `/clients/${f.clientId}/evidence${query}`;

  it('lists live files, newest first, as metadata only, to every role that sees the whole client', async () => {
    for (const who of [...WHOLE_CLIENT, 'approver'] as const) {
      const res = await get(who, vault());
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([cleanB.id, pendingA.id, cleanA.id]);
      expect(res.body.nextCursor).toBeNull();
      for (const item of res.body.items) {
        expect(() => EvidenceView.parse(item)).not.toThrow();
        expect(item).not.toHaveProperty('storageKey');
      }
    }
    expect(ids((await get('viewer', vault())).body)).not.toContain(archived.id);
  });

  it('limits an owner to their units, whatever units they ask for', async () => {
    expect(ids((await get('owner', vault())).body)).toEqual([pendingA.id, cleanA.id]);
    expect(ids((await get('otherOwner', vault())).body)).toEqual([cleanB.id]);
    expect(ids((await get('owner', vault(`?unitId=${f.unitB}`))).body)).toEqual([]);
    expect(ids((await get('owner', vault(`?unitId=${f.unitA},${f.unitB}`))).body)).toEqual([
      pendingA.id,
      cleanA.id,
    ]);
  });

  it('filters by unit, act, department, scan status and file name', async () => {
    const list = async (query: string) => ids((await get('clientAdmin', vault(query))).body);
    expect(await list(`?unitId=${f.unitB}`)).toEqual([cleanB.id]);
    expect(await list(`?actId=${f.actId}`)).toHaveLength(3);
    expect(await list(`?actId=${MISSING}`)).toEqual([]);
    expect(await list(`?departmentId=${f.departmentId}`)).toHaveLength(3);
    expect(await list(`?departmentId=${MISSING}`)).toEqual([]);
    expect(await list('?scanStatus=PENDING')).toEqual([pendingA.id]);
    expect(await list('?scanStatus=CLEAN,PENDING')).toHaveLength(3);
    expect(await list(`?q=${cleanA.fileName.slice(8, 16).toUpperCase()}`)).toEqual([cleanA.id]);
  });

  it('filters by upload date as a calendar date in the client time zone, both ends inclusive', async () => {
    const day = localDateIn(cleanA.createdAt, TZ);
    const list = async (query: string) => ids((await get('clientAdmin', vault(query))).body);
    expect(await list(`?uploadedFrom=${day}&uploadedTo=${day}`)).toContain(cleanA.id);
    expect(await list(`?uploadedTo=${addDays(day, -1)}`)).toEqual([]);
    expect(await list('?uploadedFrom=0001-01-01&uploadedTo=9999-12-31')).toHaveLength(3);
    expect(await list(`?uploadedFrom=${addDays(day, 1)}`)).not.toContain(cleanA.id);
  });

  it('pages by cursor, one item at a time, over the same list', async () => {
    expect(await walk('consultant', vault())).toEqual([cleanB.id, pendingA.id, cleanA.id]);
  });

  it('refuses a bad cursor and a reversed date range (400)', async () => {
    for (const query of ['?cursor=nope', '?uploadedFrom=2023-01-20&uploadedTo=2023-01-19']) {
      const res = await get('clientAdmin', vault(query));
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION');
    }
  });

  it('shows another firm nothing', async () => {
    const res = await get(otherAdmin, vault());
    expect(res.status).toBe(404);
    expect(ids((await get(otherAdmin, `/clients/${other.clientId}/evidence`)).body)).toEqual([]);
  });
});

describe('GET /clients/{clientId}/audit', () => {
  const trail = (query = '') => `/clients/${f.clientId}/audit${query}`;

  it('lists the client trail, newest first, to every role that sees the whole client', async () => {
    for (const who of WHOLE_CLIENT) {
      const res = await get(who, trail());
      expect(res.status).toBe(200);
      const events = res.body.items.map((item) => AuditEvent.parse(item));
      expect(events.map((e) => e.action)).toEqual([
        'TRANSITION',
        'TRANSITION',
        'EVIDENCE_DOWNLOAD',
      ]);
      expect(events.map((e) => e.entityId)).toEqual([onB.id, onA.id, onA.id]);
      expect(new Set(events.map((e) => e.clientId))).toEqual(new Set([f.clientId]));
      const times = events.map((e) => Date.parse(e.at));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    }
  });

  it('refuses APPROVER and OWNER, who read only instance histories (403)', async () => {
    for (const who of ['approver', 'owner', 'otherOwner'] as const) {
      const res = await get(who, trail());
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    }
  });

  it('filters by entity, actor and action', async () => {
    const list = async (query: string) =>
      (await get('viewer', trail(query))).body.items.map((item) => AuditEvent.parse(item));
    expect((await list(`?entityType=instance&entityId=${onA.id}`)).map((e) => e.action)).toEqual([
      'TRANSITION',
      'EVIDENCE_DOWNLOAD',
    ]);
    expect(await list('?entityType=unit')).toEqual([]);
    expect((await list(`?actorId=${f.people.viewer}`)).map((e) => e.action)).toEqual([
      'EVIDENCE_DOWNLOAD',
    ]);
    expect(
      (await list('?action=EVIDENCE_DOWNLOAD,EVIDENCE_REMOVE')).map((e) => e.entityId),
    ).toEqual([onA.id]);
  });

  it('bounds `at` inclusively at both ends', async () => {
    const [download] = (await get('viewer', trail('?action=EVIDENCE_DOWNLOAD'))).body.items.map(
      (item) => AuditEvent.parse(item),
    );
    const at = download!.at;
    const list = async (query: string) => ids((await get('viewer', trail(query))).body);
    expect(await list(`?from=${at}&to=${at}`)).toEqual([download!.id]);
    const justBefore = new Date(Date.parse(at) - 1).toISOString();
    expect(await list(`?to=${justBefore}&action=EVIDENCE_DOWNLOAD`)).toEqual([]);
    expect(await list(`?from=${new Date(Date.parse(at) + 1).toISOString()}`)).not.toContain(
      download!.id,
    );
  });

  it('pages by cursor over the same list', async () => {
    const all = ids((await get('firmAdmin', trail())).body);
    expect(await walk('firmAdmin', trail())).toEqual(all);
  });

  it('refuses a bad cursor and a reversed range (400)', async () => {
    for (const query of [
      '?cursor=nope',
      '?from=2023-01-20T06:00:00Z&to=2023-01-20T05:59:59Z',
      '?entityType=nonsense',
    ]) {
      expect((await get('viewer', trail(query))).status).toBe(400);
    }
  });

  it('keeps each firm to its own trail', async () => {
    expect((await get(otherAdmin, trail())).status).toBe(404);
    const theirs = (await get(otherAdmin, `/clients/${other.clientId}/audit`)).body.items.map(
      (item) => AuditEvent.parse(item),
    );
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.clientId).toBe(other.clientId);
  });
});

describe('GET /instances/{id}/audit', () => {
  const history = (i: ComplianceInstance, query = '') => `/instances/${i.id}/audit${query}`;

  it("shows one instance's history, evidence events included, to its unit's people and whole-client roles", async () => {
    for (const who of [...WHOLE_CLIENT, 'approver', 'owner'] as const) {
      const res = await get(who, history(onA));
      expect(res.status).toBe(200);
      const events = res.body.items.map((item) => AuditEvent.parse(item));
      expect(events.map((e) => e.action)).toEqual(['TRANSITION', 'EVIDENCE_DOWNLOAD']);
      expect(new Set(events.map((e) => e.entityId))).toEqual(new Set([onA.id]));
    }
    expect((await get('otherOwner', history(onB))).body.items).toHaveLength(1);
  });

  it('refuses an owner of another unit (403), and is 404 for a missing instance or another firm', async () => {
    expect((await get('otherOwner', history(onA))).status).toBe(403);
    expect((await get('owner', history(onB))).status).toBe(403);
    expect((await get('viewer', `/instances/${MISSING}/audit`)).status).toBe(404);
    expect((await get(otherAdmin, history(onA))).status).toBe(404);
  });

  it('pages by cursor, and refuses a bad cursor or a filter it does not take (400)', async () => {
    expect(await walk('owner', history(onA))).toEqual(ids((await get('owner', history(onA))).body));
    expect((await get('owner', history(onA, '?cursor=nope'))).status).toBe(400);
    expect((await get('owner', history(onA, '?action=TRANSITION'))).status).toBe(400);
  });
});
