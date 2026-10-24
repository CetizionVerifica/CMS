import type { ComplianceInstance } from '@canopy/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import { registerAuditRoutes } from '../audit/routes.js';
import type { AuditService } from '../audit/service.js';
import { storageKey } from '../evidence/files.js';
import { registerEvidenceRoutes } from '../evidence/routes.js';
import type { EvidenceService } from '../evidence/service.js';
import { createMemoryStorage } from '../evidence/testing/storage.js';
import { registerInstanceRoutes } from './routes.js';
import type { InstanceService } from './service.js';
import {
  addEvidence,
  addInstance,
  createTestDb,
  seedFixture,
  type Cast,
  type Fixture,
  type TestDb,
} from './testing/fixture.js';

/**
 * The root CLAUDE.md gate M7 owns: every state-changing route writes its AuditEvent (rule 2), and its outbox
 * events (events.md §3), in the same transaction, and a refused request writes neither. One row per M7
 * route, reads included (a download is a GET that is audited, and a read must write nothing); a new route
 * without a row fails the first test.
 */

const NOW = new Date('2023-01-20T06:00:00Z');

let testDb: TestDb;
let app: FastifyInstance;
let f: Fixture;
const auth = createTestAuth();
const files = createMemoryStorage();
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
    evidenceStorage: files.storage,
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
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  payload?: object;
}

interface GateCase {
  /** The instance state the request starts from. */
  from: 'OPEN' | 'SUBMITTED' | 'APPROVED';
  change(i: ComplianceInstance): Request | Promise<Request>;
  /** AuditEvent actions the change writes. */
  audit: string[];
  /** Outbox event types the change writes. */
  outbox: string[];
  /** A request refused after the instance is loaded, which must write nothing. */
  refused(
    i: ComplianceInstance,
  ): (Request & { status: number }) | Promise<Request & { status: number }>;
}

const at = (i: ComplianceInstance, action: string) => `/instances/${i.id}/${action}`;

const read = (who: keyof Cast, url: string): Request => ({ who, method: 'GET', url });

/** An upload as the client does it: ask for a URL, PUT the bytes (here: into the memory store). */
async function uploaded(i: ComplianceInstance): Promise<string> {
  const ticket = await send({
    who: 'owner',
    method: 'POST',
    url: at(i, 'evidence/upload-url'),
    payload: { fileName: 'challan.pdf', mimeType: 'application/pdf', sizeBytes: 2048 },
  });
  const uploadId = ticket.body.uploadId as string;
  files.put(storageKey({ firmId: f.firmId, clientId: f.clientId, instanceId: i.id, uploadId }), {
    sizeBytes: 2048,
    mimeType: 'application/pdf',
  });
  return uploadId;
}

const confirmBody = (uploadId: string) => ({
  uploadId,
  fileName: 'challan.pdf',
  sha256: 'b'.repeat(64),
});

/** Keyed by `METHOD route`, as Fastify registers it under /api/v1. */
const GATE: Record<string, GateCase> = {
  'GET /clients/:clientId/instances': {
    from: 'OPEN',
    change: () => read('viewer', `/clients/${f.clientId}/instances`),
    audit: [],
    outbox: [],
    refused: () => ({
      ...read('viewer', `/clients/${f.clientId}/instances?sort=-dueDate`),
      status: 400,
    }),
  },
  'GET /instances/:id': {
    from: 'OPEN',
    change: (i) => read('owner', `/instances/${i.id}`),
    audit: [],
    outbox: [],
    refused: (i) => ({ ...read('otherOwner', `/instances/${i.id}`), status: 403 }),
  },
  'GET /me/approvals': {
    from: 'SUBMITTED',
    change: () => read('approver', '/me/approvals'),
    audit: [],
    outbox: [],
    refused: () => ({ ...read('owner', '/me/approvals'), status: 403 }),
  },
  'GET /me/tasks': {
    from: 'OPEN',
    change: () => read('owner', '/me/tasks'),
    audit: [],
    outbox: [],
    refused: () => ({ ...read('viewer', '/me/tasks'), status: 403 }),
  },
  'GET /instances/:id/comments': {
    from: 'OPEN',
    change: (i) => read('viewer', at(i, 'comments')),
    audit: [],
    outbox: [],
    refused: (i) => ({ ...read('otherOwner', at(i, 'comments')), status: 403 }),
  },
  // Signing a PUT stores nothing; the confirm below is the change.
  'POST /instances/:id/evidence/upload-url': {
    from: 'OPEN',
    change: (i) => ({
      who: 'owner',
      method: 'POST',
      url: at(i, 'evidence/upload-url'),
      payload: { fileName: 'challan.pdf', mimeType: 'application/pdf', sizeBytes: 2048 },
    }),
    audit: [],
    outbox: [],
    refused: (i) => ({
      who: 'viewer',
      method: 'POST',
      url: at(i, 'evidence/upload-url'),
      payload: { fileName: 'challan.pdf', mimeType: 'application/pdf', sizeBytes: 2048 },
      status: 403,
    }),
  },
  'POST /instances/:id/evidence': {
    from: 'OPEN',
    change: async (i) => ({
      who: 'owner',
      method: 'POST',
      url: at(i, 'evidence'),
      payload: confirmBody(await uploaded(i)),
    }),
    audit: ['EVIDENCE_ADD'],
    outbox: ['evidence.uploaded'],
    refused: async (i) => ({
      who: 'otherOwner',
      method: 'POST',
      url: at(i, 'evidence'),
      payload: confirmBody(await uploaded(i)),
      status: 403,
    }),
  },
  'GET /instances/:id/evidence': {
    from: 'OPEN',
    change: (i) => read('viewer', at(i, 'evidence')),
    audit: [],
    outbox: [],
    refused: (i) => ({ ...read('otherOwner', at(i, 'evidence')), status: 403 }),
  },
  'GET /clients/:clientId/evidence': {
    from: 'SUBMITTED',
    change: () => read('owner', `/clients/${f.clientId}/evidence`),
    audit: [],
    outbox: [],
    refused: () => ({
      ...read('owner', `/clients/${f.clientId}/evidence?cursor=nope`),
      status: 400,
    }),
  },
  'GET /clients/:clientId/audit': {
    from: 'OPEN',
    change: () => read('viewer', `/clients/${f.clientId}/audit`),
    audit: [],
    outbox: [],
    refused: () => ({ ...read('approver', `/clients/${f.clientId}/audit`), status: 403 }),
  },
  'GET /instances/:id/audit': {
    from: 'APPROVED',
    change: (i) => read('owner', at(i, 'audit')),
    audit: [],
    outbox: [],
    refused: (i) => ({ ...read('otherOwner', at(i, 'audit')), status: 403 }),
  },
  'GET /evidence/:id/download-url': {
    from: 'SUBMITTED',
    change: async (i) =>
      read('viewer', `/evidence/${(await addEvidence(testDb.db, f, i)).id}/download-url`),
    audit: ['EVIDENCE_DOWNLOAD'],
    outbox: ['evidence.downloaded'],
    refused: async (i) => ({
      ...read(
        'viewer',
        `/evidence/${(await addEvidence(testDb.db, f, i, 'PENDING')).id}/download-url`,
      ),
      status: 422,
    }),
  },
  'POST /evidence/:id/remove': {
    from: 'SUBMITTED',
    change: async (i) => ({
      who: 'owner',
      method: 'POST',
      url: `/evidence/${(await addEvidence(testDb.db, f, i)).id}/remove`,
      payload: { reason: 'Wrong month attached.' },
    }),
    audit: ['EVIDENCE_REMOVE'],
    outbox: ['evidence.removed'],
    refused: async (i) => ({
      who: 'viewer',
      method: 'POST',
      url: `/evidence/${(await addEvidence(testDb.db, f, i)).id}/remove`,
      payload: { reason: 'Wrong month attached.' },
      status: 403,
    }),
  },
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
    ...(r.payload === undefined ? {} : { payload: r.payload }),
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

describe('every M7 route writes exactly its AuditEvents and outbox events', () => {
  it('has a row for every route M7 registers', async () => {
    const seen: string[] = [];
    const probe = Fastify();
    probe.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) {
        if (method !== 'HEAD') seen.push(`${method} ${route.url}`);
      }
    });
    // Registration only: no handler runs, so no service is needed.
    registerInstanceRoutes(probe, {} as InstanceService);
    registerEvidenceRoutes(probe, {} as EvidenceService);
    registerAuditRoutes(probe, {} as AuditService);
    await probe.ready();
    expect(seen.sort()).toEqual(Object.keys(GATE).sort());
    await probe.close();
  });

  it.each(Object.entries(GATE))('%s', async (_route, gate) => {
    const changed = await fresh(gate.from);
    const request = await gate.change(changed);
    const change = await writtenBy(() => send(request));
    expect(change.status).toBeLessThan(300);
    expect(change.audit).toEqual([...gate.audit].sort());
    expect(change.outbox).toEqual([...gate.outbox].sort());

    const untouched = await fresh(gate.from);
    const refusal = await gate.refused(untouched);
    const refused = await writtenBy(() => send(refusal));
    expect(refused.status).toBe(refusal.status);
    expect(refused.audit).toEqual([]);
    expect(refused.outbox).toEqual([]);
  });
});
