import { EvidenceView, SignedUrl, UploadTicket, type ComplianceInstance } from '@canopy/contracts';
import { auditEvents, systemContext } from '@canopy/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import {
  addEvidence,
  addInstance,
  createTestDb,
  seedFixture,
  type Cast,
  type Fixture,
  type TestDb,
} from '../instances/testing/fixture.js';
import { storageKey } from './files.js';
import { createEvidenceService } from './service.js';
import { createMemoryStorage } from './testing/storage.js';

/**
 * M7 evidence routes against Postgres with RLS on (endpoints.md §4, api-conventions.md §6): upload, confirm,
 * scan, download and remove, each allowed role and a forbidden one, and how evidence gates submission.
 * Today is 2023-01-20.
 */

const NOW = new Date('2023-01-20T06:00:00Z');

let testDb: TestDb;
let app: FastifyInstance;
let f: Fixture;
let other: Fixture;
const auth = createTestAuth();
const files = createMemoryStorage();
const headers = {} as Record<keyof Cast, Record<string, string>>;
let firmBOwner: Record<string, string>;

beforeAll(async () => {
  testDb = await createTestDb();
  f = await seedFixture(testDb.db, await testDb.createFirm('Evidence firm'), 'E');
  other = await seedFixture(testDb.db, await testDb.createFirm('Other firm'), 'O');
  for (const key of Object.keys(f.people) as (keyof Cast)[]) {
    headers[key] = auth.signIn({
      firmId: f.firmId,
      personId: f.people[key],
      memberships: f.memberships[key],
      principal: { firmClientIds: [f.clientId] },
    }).headers;
  }
  firmBOwner = auth.signIn({
    firmId: other.firmId,
    personId: other.people.owner,
    memberships: other.memberships.owner,
  }).headers;
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
function fresh(
  state: 'OPEN' | 'SUBMITTED' | 'APPROVED' = 'OPEN',
  assignment: 'plain' | 'evidence' = 'plain',
): Promise<ComplianceInstance> {
  seq += 1;
  return addInstance(testDb.db, f, {
    assignment,
    periodStart: `${1900 + seq}-01-01`,
    dueDate: '2023-02-15',
    state,
  });
}

async function call(
  who: keyof Cast | Record<string, string>,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
) {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: typeof who === 'string' ? headers[who] : who,
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    status: res.statusCode,
    body: res.json() as Record<string, unknown> & {
      error?: { code: string; details?: Record<string, unknown> };
    },
  };
}

const pdf = { fileName: 'Form 21.pdf', mimeType: 'application/pdf', sizeBytes: 4096 };

/** Upload-url, then the client's PUT (into the memory store). */
async function upload(i: ComplianceInstance, who: keyof Cast = 'owner', stored = pdf) {
  const res = await call(who, 'POST', `/instances/${i.id}/evidence/upload-url`, pdf);
  expect(res.status).toBe(200);
  const ticket = UploadTicket.parse(res.body);
  files.put(
    storageKey({
      firmId: f.firmId,
      clientId: f.clientId,
      instanceId: i.id,
      uploadId: ticket.uploadId,
    }),
    { sizeBytes: stored.sizeBytes, mimeType: stored.mimeType },
  );
  return ticket;
}

function historyOf(id: string) {
  return testDb.db.withTenant(systemContext(f.firmId, 'assert'), (tx) =>
    auditEvents.forEntity(tx, 'instance', id),
  );
}

describe('upload and confirm', () => {
  it('signs a 5-minute PUT for exactly the declared type and size', async () => {
    const i = await fresh();
    const ticket = await upload(i);
    expect(ticket.headers).toEqual({ 'Content-Type': 'application/pdf', 'Content-Length': '4096' });
    expect(ticket.expiresAt).toBe('2023-01-20T06:05:00.000Z');
  });

  it('records a confirmed upload as PENDING, audited without the file name', async () => {
    const i = await fresh();
    const ticket = await upload(i);
    const res = await call('owner', 'POST', `/instances/${i.id}/evidence`, {
      uploadId: ticket.uploadId,
      fileName: 'Form 21.pdf',
      sha256: 'c'.repeat(64),
    });
    expect(res.status).toBe(201);
    const created = EvidenceView.parse(res.body);
    expect(created).toMatchObject({
      scanStatus: 'PENDING',
      sizeBytes: 4096,
      uploadedById: f.people.owner,
    });
    expect(res.body).not.toHaveProperty('storageKey');
    const [event] = await historyOf(i.id);
    expect(event).toMatchObject({
      action: 'EVIDENCE_ADD',
      after: { evidenceId: created.id, scanStatus: 'PENDING' },
    });
    expect(JSON.stringify(event)).not.toContain('Form 21');

    const list = await call('viewer', 'GET', `/instances/${i.id}/evidence`);
    expect(list.body.items).toEqual([expect.objectContaining({ id: created.id })]);
  });

  it('refuses a file type outside the list, and a confirm with nothing uploaded', async () => {
    const i = await fresh();
    const exe = await call('owner', 'POST', `/instances/${i.id}/evidence/upload-url`, {
      fileName: 'tool.exe',
      mimeType: 'application/x-msdownload',
      sizeBytes: 10,
    });
    expect(exe.status).toBe(400);
    const nothing = await call('owner', 'POST', `/instances/${i.id}/evidence`, {
      uploadId: '0190f000-0000-7000-8000-00000000abcd',
      fileName: 'Form 21.pdf',
      sha256: 'c'.repeat(64),
    });
    expect(nothing.status).toBe(400);
  });

  it('checks the stored object, not the declared one', async () => {
    const i = await fresh();
    const ticket = await upload(i, 'owner', { ...pdf, mimeType: 'application/x-msdownload' });
    const res = await call('owner', 'POST', `/instances/${i.id}/evidence`, {
      uploadId: ticket.uploadId,
      fileName: 'Form 21.pdf',
      sha256: 'c'.repeat(64),
    });
    expect(res.status).toBe(400);
  });

  it('confirms an upload id once (409 DUPLICATE the second time)', async () => {
    const i = await fresh();
    const ticket = await upload(i);
    const body = { uploadId: ticket.uploadId, fileName: 'Form 21.pdf', sha256: 'c'.repeat(64) };
    expect((await call('owner', 'POST', `/instances/${i.id}/evidence`, body)).status).toBe(201);
    const again = await call('owner', 'POST', `/instances/${i.id}/evidence`, body);
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('DUPLICATE');
  });

  it('is 409 on an approved instance, 403 for a viewer or an owner of another unit, 404 across firms', async () => {
    const done = await fresh('APPROVED');
    const late = await call(
      'clientAdmin',
      'POST',
      `/instances/${done.id}/evidence/upload-url`,
      pdf,
    );
    expect(late.body.error).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { from: 'APPROVED', action: 'UPLOAD_EVIDENCE' },
    });
    const i = await fresh();
    for (const who of ['viewer', 'otherOwner'] as const) {
      expect((await call(who, 'POST', `/instances/${i.id}/evidence/upload-url`, pdf)).status).toBe(
        403,
      );
    }
    expect(
      (await call(firmBOwner, 'POST', `/instances/${i.id}/evidence/upload-url`, pdf)).status,
    ).toBe(404);
    for (const who of ['firmAdmin', 'consultant', 'clientAdmin', 'approver'] as const) {
      expect((await call(who, 'POST', `/instances/${i.id}/evidence/upload-url`, pdf)).status).toBe(
        200,
      );
    }
  });
});

describe('scan, download and submission', () => {
  const service = () =>
    createEvidenceService({ db: testDb.db, storage: files.storage, clock: () => NOW });

  it('needs a clean file to submit, and downloads only a clean file, audited', async () => {
    const i = await fresh('OPEN', 'evidence');
    const ticket = await upload(i);
    const confirmed = await call('owner', 'POST', `/instances/${i.id}/evidence`, {
      uploadId: ticket.uploadId,
      fileName: 'Form 21.pdf',
      sha256: 'c'.repeat(64),
    });
    const id = confirmed.body.id as string;
    const submit = () =>
      call('owner', 'POST', `/instances/${i.id}/submit`, {
        version: i.version,
        completedOn: '2023-01-18',
        comment: 'Filed.',
      });

    const early = await submit();
    expect(early.body.error).toMatchObject({ code: 'EVIDENCE_NOT_READY' });
    const pending = await call('viewer', 'GET', `/evidence/${id}/download-url`);
    expect(pending.status).toBe(422);
    expect(pending.body.error).toMatchObject({
      code: 'EVIDENCE_NOT_READY',
      details: { scanStatus: 'PENDING' },
    });

    const scan = { firmId: f.firmId, requestId: 'scan-1', job: 'virus-scan' };
    expect(await service().scanned(scan, id, 'CLEAN')).toMatchObject({ scanStatus: 'CLEAN' });
    // A retried job keeps the first result.
    expect(await service().scanned(scan, id, 'INFECTED')).toMatchObject({ scanStatus: 'CLEAN' });

    const download = await call('viewer', 'GET', `/evidence/${id}/download-url`);
    expect(download.status).toBe(200);
    expect(SignedUrl.parse(download.body).expiresAt).toBe('2023-01-20T06:05:00.000Z');
    const history = await historyOf(i.id);
    expect(history.map((e) => e.action)).toEqual(['EVIDENCE_DOWNLOAD', 'UPDATE', 'EVIDENCE_ADD']);
    expect(history[1]).toMatchObject({
      actorKind: 'SYSTEM',
      after: { evidenceId: id, scanStatus: 'CLEAN' },
    });

    expect((await submit()).body).toMatchObject({ workflowState: 'SUBMITTED' });
  });

  it('never downloads an infected file', async () => {
    const i = await fresh('SUBMITTED');
    const file = await addEvidence(testDb.db, f, i, 'INFECTED');
    const res = await call('clientAdmin', 'GET', `/evidence/${file.id}/download-url`);
    expect(res.body.error).toMatchObject({
      code: 'EVIDENCE_NOT_READY',
      details: { scanStatus: 'INFECTED' },
    });
  });
});

describe('remove', () => {
  it('archives with a reason; the file leaves the list and cannot be downloaded', async () => {
    const i = await fresh('SUBMITTED');
    const file = await addEvidence(testDb.db, f, i);
    const res = await call('owner', 'POST', `/evidence/${file.id}/remove`, {
      reason: 'Wrong month.',
    });
    expect(res.status).toBe(200);
    expect(res.body.archivedAt).not.toBeNull();
    expect((await historyOf(i.id))[0]).toMatchObject({
      action: 'EVIDENCE_REMOVE',
      reason: 'Wrong month.',
      after: { evidenceId: file.id, archived: true },
    });
    expect((await call('viewer', 'GET', `/instances/${i.id}/evidence`)).body.items).toEqual([]);
    expect((await call('viewer', 'GET', `/evidence/${file.id}/download-url`)).status).toBe(404);
  });

  it('lets an owner remove only before approval; a client admin may after', async () => {
    const done = await fresh('APPROVED');
    const file = await addEvidence(testDb.db, f, done);
    const owner = await call('owner', 'POST', `/evidence/${file.id}/remove`, {
      reason: 'Mistake.',
    });
    expect(owner.status).toBe(403);
    const admin = await call('clientAdmin', 'POST', `/evidence/${file.id}/remove`, {
      reason: 'Mistake.',
    });
    expect(admin.status).toBe(200);
  });

  it('is 403 for an approver and a viewer, 400 without a reason', async () => {
    const i = await fresh('SUBMITTED');
    const file = await addEvidence(testDb.db, f, i);
    for (const who of ['approver', 'viewer'] as const) {
      expect((await call(who, 'POST', `/evidence/${file.id}/remove`, { reason: 'x' })).status).toBe(
        403,
      );
    }
    expect(
      (await call('owner', 'POST', `/evidence/${file.id}/remove`, { reason: '' })).status,
    ).toBe(400);
  });
});
