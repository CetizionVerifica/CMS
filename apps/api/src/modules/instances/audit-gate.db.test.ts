import type { ComplianceInstance } from '@canopy/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import { registerInstanceRoutes } from './routes.js';
import type { InstanceService } from './service.js';
import {
  addInstance,
  createTestDb,
  seedFixture,
  type Cast,
  type Fixture,
  type TestDb,
} from './testing/fixture.js';

/**
 * The root CLAUDE.md gate M7 owns: every state-changing route writes its AuditEvent (rule 2), and its outbox
 * events (events.md §3), in the same transaction, and a refused request writes neither. One row per
 * non-GET route; a new route without a row fails the first test.
 */

const NOW = new Date('2023-01-20T06:00:00Z');

let testDb: TestDb;
let app: FastifyInstance;
let f: Fixture;
const auth = createTestAuth();
const headers = {} as Record<keyof Cast, Record<string, string>>;

beforeAll(async () => {
  testDb = await createTestDb();
  f = await seedFixture(testDb.db, await testDb.createFirm('Gate firm'), 'G');
  for (const key of Object.keys(f.people) as (keyof Cast)[]) {
    headers[key] = auth.signIn({
      firmId: f.firmId,
      personId: f.people[key],
      memberships: f.memberships[key],
      principal: { firmClientIds: [f.clientId] },
    }).headers;
  }
  app = buildServer({
    authStore: auth.store,
    database: testDb.db,
    clock: () => NOW,
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

let seq = 0;
function fresh(state: 'OPEN' | 'SUBMITTED' | 'APPROVED'): Promise<ComplianceInstance> {
  seq += 1;
  return addInstance(testDb.db, f, {
    periodStart: `${1990 + seq}-01-01`,
    dueDate: '2023-02-15',
    state,
  });
}

interface Request {
  who: keyof Cast;
  method: 'POST' | 'PATCH';
  url: string;
  payload: object;
}

interface GateCase {
  /** The instance state the request starts from. */
  from: 'OPEN' | 'SUBMITTED' | 'APPROVED';
  change(i: ComplianceInstance): Request;
  /** AuditEvent actions the change writes. */
  audit: string[];
  /** Outbox event types the change writes. */
  outbox: string[];
  /** A request refused after the instance is loaded, which must write nothing. */
  refused(i: ComplianceInstance): Request & { status: number };
}

const at = (i: ComplianceInstance, action: string) => `/instances/${i.id}/${action}`;

/** Keyed by `METHOD route`, as Fastify registers it under /api/v1. */
const GATE: Record<string, GateCase> = {
  'POST /instances/:id/submit': {
    from: 'OPEN',
    change: (i) => ({
      who: 'owner',
      method: 'POST',
      url: at(i, 'submit'),
      payload: { version: i.version, completedOn: '2023-01-15', comment: 'Filed.' },
    }),
    audit: ['TRANSITION'],
    outbox: ['comment.added', 'instance.submitted'],
    refused: (i) => ({
      who: 'owner',
      method: 'POST',
      url: at(i, 'submit'),
      payload: { version: i.version + 1, completedOn: '2023-01-15', comment: 'Filed.' },
      status: 409,
    }),
  },
  'POST /instances/:id/request-na': {
    from: 'OPEN',
    change: (i) => ({
      who: 'owner',
      method: 'POST',
      url: at(i, 'request-na'),
      payload: { version: i.version, reason: 'No boilers on site.' },
    }),
    audit: ['TRANSITION'],
    outbox: ['comment.added', 'instance.submitted'],
    refused: (i) => ({
      who: 'viewer',
      method: 'POST',
      url: at(i, 'request-na'),
      payload: { version: i.version, reason: 'No boilers on site.' },
      status: 403,
    }),
  },
  'POST /instances/:id/approve': {
    from: 'SUBMITTED',
    change: (i) => ({
      who: 'approver',
      method: 'POST',
      url: at(i, 'approve'),
      payload: { version: i.version },
    }),
    audit: ['TRANSITION'],
    outbox: ['comment.added', 'instance.approved'],
    refused: (i) => ({
      who: 'owner',
      method: 'POST',
      url: at(i, 'approve'),
      payload: { version: i.version },
      status: 403,
    }),
  },
  'POST /instances/:id/send-back': {
    from: 'SUBMITTED',
    change: (i) => ({
      who: 'approver',
      method: 'POST',
      url: at(i, 'send-back'),
      payload: { version: i.version, reason: 'Wrong challan.' },
    }),
    audit: ['TRANSITION'],
    outbox: ['comment.added', 'instance.sent_back'],
    refused: (i) => ({
      who: 'approver',
      method: 'POST',
      url: at(i, 'send-back'),
      payload: { version: i.version + 1, reason: 'Wrong challan.' },
      status: 409,
    }),
  },
  'POST /instances/:id/reopen': {
    from: 'APPROVED',
    change: (i) => ({
      who: 'clientAdmin',
      method: 'POST',
      url: at(i, 'reopen'),
      payload: { version: i.version, reason: 'Approved by mistake.' },
    }),
    audit: ['TRANSITION'],
    outbox: ['comment.added', 'instance.reopened'],
    refused: (i) => ({
      who: 'owner',
      method: 'POST',
      url: at(i, 'reopen'),
      payload: { version: i.version, reason: 'Approved by mistake.' },
      status: 403,
    }),
  },
  'POST /clients/:clientId/instances/bulk-approve': {
    from: 'SUBMITTED',
    change: (i) => ({
      who: 'approver',
      method: 'POST',
      url: `/clients/${f.clientId}/instances/bulk-approve`,
      payload: { items: [{ id: i.id, version: i.version }] },
    }),
    audit: ['TRANSITION'],
    outbox: ['comment.added', 'instance.approved', 'instance.bulk_approved'],
    // A stale item is reported per item (200) and writes nothing.
    refused: (i) => ({
      who: 'approver',
      method: 'POST',
      url: `/clients/${f.clientId}/instances/bulk-approve`,
      payload: { items: [{ id: i.id, version: i.version + 1 }] },
      status: 200,
    }),
  },
  'PATCH /instances/:id': {
    from: 'OPEN',
    change: (i) => ({
      who: 'clientAdmin',
      method: 'PATCH',
      url: `/instances/${i.id}`,
      payload: {
        version: i.version,
        dueDate: '2023-03-01',
        approverId: f.people.clientAdmin,
        reason: 'Extension; approver on leave.',
      },
    }),
    audit: ['DUE_DATE_CHANGE', 'REASSIGN'],
    outbox: ['instance.due_date_changed', 'instance.reassigned'],
    refused: (i) => ({
      who: 'clientAdmin',
      method: 'PATCH',
      url: `/instances/${i.id}`,
      payload: { version: i.version + 1, dueDate: '2023-03-01', reason: 'Extension.' },
      status: 409,
    }),
  },
  // A note changes no compliance state, so it writes no AuditEvent (ADR 0004 §9); it is still an event.
  'POST /instances/:id/comments': {
    from: 'OPEN',
    change: (i) => ({
      who: 'owner',
      method: 'POST',
      url: at(i, 'comments'),
      payload: { body: 'Challan uploaded to the portal.' },
    }),
    audit: [],
    outbox: ['comment.added'],
    refused: (i) => ({
      who: 'viewer',
      method: 'POST',
      url: at(i, 'comments'),
      payload: { body: 'Viewer note.' },
      status: 403,
    }),
  },
};

async function send(r: Request) {
  const res = await app.inject({
    method: r.method,
    url: `/api/v1${r.url}`,
    headers: headers[r.who],
    payload: r.payload,
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** What a request added to the firm's audit trail and outbox, as sorted kinds. */
async function writtenBy(run: () => Promise<{ status: number }>) {
  const before = await testDb.written(f.firmId);
  const res = await run();
  const after = await testDb.written(f.firmId);
  const added = (was: Map<string, string>, now: Map<string, string>) =>
    [...now]
      .filter(([id]) => !was.has(id))
      .map(([, kind]) => kind)
      .sort();
  return {
    status: res.status,
    audit: added(before.audit, after.audit),
    outbox: added(before.outbox, after.outbox),
  };
}

describe('every state-changing instance route writes its AuditEvent and outbox events', () => {
  it('has a row for every non-GET route M7 registers', async () => {
    const seen: string[] = [];
    const probe = Fastify();
    probe.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) {
        if (method !== 'GET' && method !== 'HEAD') seen.push(`${method} ${route.url}`);
      }
    });
    // Registration only: no handler runs, so no service is needed.
    registerInstanceRoutes(probe, {} as InstanceService);
    await probe.ready();
    expect(seen.sort()).toEqual(Object.keys(GATE).sort());
    await probe.close();
  });

  it.each(Object.entries(GATE))('%s', async (_route, gate) => {
    const changed = await fresh(gate.from);
    const change = await writtenBy(() => send(gate.change(changed)));
    expect(change.status).toBeLessThan(300);
    expect(change.audit).toEqual([...gate.audit].sort());
    expect(change.outbox).toEqual([...gate.outbox].sort());

    const untouched = await fresh(gate.from);
    const refusal = gate.refused(untouched);
    const refused = await writtenBy(() => send(refusal));
    expect(refused.status).toBe(refusal.status);
    expect(refused.audit).toEqual([]);
    expect(refused.outbox).toEqual([]);
  });
});
