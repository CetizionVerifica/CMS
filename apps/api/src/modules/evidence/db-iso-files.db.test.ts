import { IsoFileView, type IsoFileSubject } from '@canopy/contracts';
import {
  auditEvents,
  certifications,
  clauseAssessments,
  controlledDocuments,
  documentRevisions,
  externalAudits,
  isoCatalogue,
  isoFiles,
  managementSystems,
  systemContext,
  type TenantContext,
  type TenantTx,
} from '@canopy/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../auth/index.js';
import {
  createTestDb,
  d,
  seedFixture,
  type Fixture,
  type TestDb,
} from '../instances/testing/fixture.js';
import { createIsoFiles, isoStorageKey, type IsoFileCaller } from './index.js';
import { createMemoryStorage } from './testing/storage.js';

/**
 * ISO-15: M7's ISO file service against Postgres with RLS on (docs/iso/model.md §6). Each call runs in the caller's
 * tenant transaction: confirm, downloadUrl and remove write exactly one AuditEvent on the ISO subject naming the file
 * id only; uploadUrl and list write none; a refused call writes none; a rolled-back caller leaves nothing.
 * Uses the four subjects ISO-2d stores files on: clause assessments, document revisions, external audits and
 * certifications. Now is 2026-10-20.
 */

const NOW = new Date('2026-10-20T06:00:00Z');
const SHA = 'c'.repeat(64);

let testDb: TestDb;
let f: Fixture;
let other: Fixture;
const files = createMemoryStorage();
const service = createIsoFiles({ storage: files.storage, clock: () => NOW });
const subjects = {} as Record<
  'clause_assessment' | 'document_revision' | 'external_audit' | 'certification',
  IsoFileSubject
>;
let otherSubject: IsoFileSubject;

const caller = (): IsoFileCaller => ({
  firmId: f.firmId,
  personId: f.people.owner,
  requestId: 'iso-files-test',
});
const tenant = (): TenantContext => ({
  firmId: f.firmId,
  personId: f.people.owner,
  clientIds: [f.clientId],
  requestId: 'iso-files-test',
});
const inTenant = <T>(fn: (tx: TenantTx) => Promise<T>) => testDb.db.withTenant(tenant(), fn);
const asSystem = <T>(fixture: Fixture, fn: (tx: TenantTx) => Promise<T>) =>
  testDb.db.withTenant(systemContext(fixture.firmId, 'iso-files-test'), fn);

/** The ApiError code a call fails with; 'resolved' when it does not fail. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  return 'resolved';
}

/** The audit trail of one ISO subject, oldest first. */
async function trail(subject: IsoFileSubject) {
  const page = await asSystem(f, (tx) =>
    auditEvents.query(tx, { entityType: subject.type, entityId: subject.id, limit: 200 }),
  );
  return [...page.items].reverse();
}

/** Every audit row of the fixture firm, as `id → action`. */
const auditIds = async () => (await testDb.written(f.firmId)).audit;

/** Ask for a ticket, then do the client's PUT (into the memory store). */
async function upload(
  subject: IsoFileSubject,
  stored = { mimeType: 'application/pdf', sizeBytes: 4096 },
  name = 'Gap analysis.pdf',
) {
  const ticket = await inTenant((tx) =>
    service.uploadUrl(tx, caller(), subject, {
      fileName: name,
      mimeType: 'application/pdf',
      sizeBytes: 4096,
    }),
  );
  files.put(
    isoStorageKey({ firmId: f.firmId, clientId: f.clientId, subject, uploadId: ticket.uploadId }),
    stored,
  );
  return ticket;
}

async function addFile(subject: IsoFileSubject, name = 'Gap analysis.pdf') {
  const ticket = await upload(subject, undefined, name);
  return inTenant((tx) =>
    service.confirm(tx, caller(), subject, {
      uploadId: ticket.uploadId,
      fileName: name,
      sha256: SHA,
    }),
  );
}

const scan = (id: string, status: 'CLEAN' | 'INFECTED') =>
  asSystem(f, (tx) => isoFiles.setScanStatus(tx, id, status));

/** A management system with one checklist row, a document revision, an external audit and a certificate. */
async function seedIso(fixture: Fixture) {
  return asSystem(fixture, async (tx) => {
    const standard = await isoCatalogue.createStandard(tx, {
      code: 'ISO_9001',
      edition: '2015+A1:2024',
      title: 'ISO 9001',
      topic: 'Quality management',
    });
    await isoCatalogue.createClauses(tx, [
      {
        standardId: standard.id,
        number: '4.1',
        title: 'Clause 4.1',
        summary: 'Our own summary.',
        parentId: null,
        hlsKey: '4.1',
        assessable: true,
        exclusionAllowed: false,
      },
    ]);
    const system = await managementSystems.create(tx, {
      clientId: fixture.clientId,
      name: 'Kestrel quality system',
      standardIds: [standard.id],
      scopeStatement: null,
      unitIds: [],
      status: 'PLANNING',
      reviewIntervalMonths: 12,
      climateChangeRelevant: null,
      climateChangeRationale: null,
      climateDecidedOn: null,
    });
    const [row] = await clauseAssessments.addForStandards(tx, system, [standard.id]);
    const document = await controlledDocuments.create(tx, {
      clientId: fixture.clientId,
      managementSystemId: system.id,
      code: 'QP-01',
      title: 'Control of documents',
      type: 'PROCEDURE',
      clauseIds: [],
      status: 'ACTIVE',
      currentRevisionId: null,
      ownerId: fixture.people.owner,
      approverId: fixture.people.approver,
      reviewDueOn: null,
      lastReviewedOn: null,
      retention: null,
      issuer: null,
      externalRef: null,
    });
    const revision = await documentRevisions.create(tx, {
      clientId: fixture.clientId,
      documentId: document.id,
      revision: 'A',
      changeNote: 'First issue',
      state: 'DRAFT',
      preparedById: fixture.people.owner,
      approvedById: null,
      approvedAt: null,
      sendBackReason: null,
    });
    const visit = await externalAudits.create(tx, {
      clientId: fixture.clientId,
      managementSystemId: system.id,
      standardIds: [standard.id],
      type: 'SURVEILLANCE_1',
      body: 'Osprey Certification',
      leadAuditorName: 'A. Auditor',
      startOn: d('2026-09-01'),
      endOn: d('2026-09-02'),
      recommendation: null,
      responseDueOn: null,
      state: 'PLANNED',
      cancelReason: null,
    });
    const certificate = await certifications.create(tx, {
      clientId: fixture.clientId,
      managementSystemId: system.id,
      standardId: standard.id,
      body: 'Osprey Certification',
      certificateNumber: null,
      issuedOn: null,
      expiresOn: null,
      scopeText: null,
      unitIds: [],
    });
    return {
      clause_assessment: { type: 'clause_assessment', id: row!.id },
      document_revision: { type: 'document_revision', id: revision.id },
      external_audit: { type: 'external_audit', id: visit.id },
      certification: { type: 'certification', id: certificate.id },
    } as const;
  });
}

beforeAll(async () => {
  testDb = await createTestDb();
  f = await seedFixture(testDb.db, await testDb.createFirm('Iso files firm'), 'I');
  other = await seedFixture(testDb.db, await testDb.createFirm('Other firm'), 'J');
  Object.assign(subjects, await seedIso(f));
  otherSubject = (await seedIso(other)).clause_assessment;
}, 120_000);

afterAll(async () => {
  await testDb?.drop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('uploadUrl', () => {
  it('signs a 5-minute PUT under evidence/<firm>/<client>/iso/<type>/<id>/ and writes nothing', async () => {
    const before = await auditIds();
    const subject = subjects.clause_assessment;
    const ticket = await upload(subject);
    const key = isoStorageKey({
      firmId: f.firmId,
      clientId: f.clientId,
      subject,
      uploadId: ticket.uploadId,
    });
    expect(key).toBe(
      `evidence/${f.firmId}/${f.clientId}/iso/clause_assessment/${subject.id}/${ticket.uploadId}`,
    );
    expect(ticket.url).toContain(encodeURIComponent(key));
    expect(ticket.headers).toEqual({ 'Content-Type': 'application/pdf', 'Content-Length': '4096' });
    expect(ticket.expiresAt).toBe('2026-10-20T06:05:00.000Z');
    expect(await auditIds()).toEqual(before);
  });

  it("names the subject record's firm in the key, never the caller's (#301 audit)", async () => {
    const subject = subjects.document_revision;
    const ticket = await inTenant((tx) =>
      service.uploadUrl(tx, { ...caller(), firmId: other.firmId }, subject, {
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
      }),
    );
    const key = isoStorageKey({
      firmId: f.firmId,
      clientId: f.clientId,
      subject,
      uploadId: ticket.uploadId,
    });
    expect(ticket.url).toContain(encodeURIComponent(key));
    files.put(key, { mimeType: 'application/pdf', sizeBytes: 10 });
    const file = await inTenant((tx) =>
      service.confirm(tx, { ...caller(), firmId: other.firmId }, subject, {
        uploadId: ticket.uploadId,
        fileName: 'a.pdf',
        sha256: SHA,
      }),
    );
    expect((await asSystem(f, (tx) => isoFiles.require(tx, file.id))).storageKey).toBe(key);
  });

  it('refuses a type, size or name the evidence rules refuse, and a subject it cannot see', async () => {
    const subject = subjects.certification;
    const ask = (file: { fileName: string; mimeType: string; sizeBytes: number }, on = subject) =>
      failure(inTenant((tx) => service.uploadUrl(tx, caller(), on, file)));
    expect(await ask({ fileName: 'run.exe', mimeType: 'application/pdf', sizeBytes: 10 })).toBe(
      'VALIDATION',
    );
    expect(await ask({ fileName: 'a.pdf', mimeType: 'image/png', sizeBytes: 10 })).toBe(
      'VALIDATION',
    );
    expect(await ask({ fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 0 })).toBe(
      'VALIDATION',
    );
    expect(
      await ask({
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 25 * 1024 * 1024 + 1,
      }),
    ).toBe('VALIDATION');
    expect(await ask({ fileName: '../', mimeType: 'application/pdf', sizeBytes: 10 })).toBe(
      'VALIDATION',
    );
    const pdf = { fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 };
    expect(await ask(pdf, otherSubject)).toBe('NOT_FOUND');
    expect(
      await ask(pdf, { type: 'certification', id: '01920000-0000-7000-8000-0000000000ff' }),
    ).toBe('NOT_FOUND');
  });
});

describe('confirm', () => {
  it.each(Object.keys(subjects) as (keyof typeof subjects)[])(
    'records a PENDING file on a %s and one EVIDENCE_ADD naming its id',
    async (type) => {
      const subject = subjects[type];
      const before = await auditIds();
      const file = await addFile(subject, 'C:\\scans\\Visit report.pdf');
      expect(IsoFileView.parse(file)).toEqual(file);
      expect(file).not.toHaveProperty('storageKey');
      expect(file).toMatchObject({
        subject,
        clientId: f.clientId,
        fileName: 'Visit report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4096,
        sha256: SHA,
        scanStatus: 'PENDING',
        uploadedById: f.people.owner,
        archivedAt: null,
        removeReason: null,
      });
      const added = [...(await auditIds())].filter(([id]) => !before.has(id));
      expect(added.map(([, action]) => action)).toEqual(['EVIDENCE_ADD']);
      const event = (await trail(subject)).find((e) => e.id === added[0]![0])!;
      expect(event).toMatchObject({
        clientId: f.clientId,
        actorId: f.people.owner,
        actorKind: 'PERSON',
        requestId: 'iso-files-test',
        entityType: type,
        entityId: subject.id,
        before: null,
        after: { fileId: file.id },
        reason: null,
      });
    },
  );

  it('refuses an upload id with nothing stored, or a stored type the rules refuse, and writes nothing', async () => {
    const subject = subjects.external_audit;
    const before = await auditIds();
    const confirm = (uploadId: string, fileName = 'a.pdf') =>
      failure(
        inTenant((tx) =>
          service.confirm(tx, caller(), subject, { uploadId, fileName, sha256: SHA }),
        ),
      );
    expect(await confirm('01920000-0000-7000-8000-0000000000aa')).toBe('VALIDATION');
    // An upload id ends the storage key, so a path is refused before any key is built (#301 audit).
    expect(await confirm('../..')).toBe('VALIDATION');
    expect(await confirm(`../../${subjects.certification.id}/x`)).toBe('VALIDATION');
    const png = await upload(subject, { mimeType: 'image/png', sizeBytes: 10 });
    expect(await confirm(png.uploadId)).toBe('VALIDATION');
    const empty = await upload(subject, { mimeType: 'application/pdf', sizeBytes: 0 });
    expect(await confirm(empty.uploadId)).toBe('VALIDATION');
    // A ticket for one subject does not confirm on another: the key names the subject.
    const elsewhere = await upload(subjects.certification);
    expect(await confirm(elsewhere.uploadId)).toBe('VALIDATION');
    expect(
      await failure(
        inTenant((tx) =>
          service.confirm(tx, caller(), otherSubject, {
            uploadId: elsewhere.uploadId,
            fileName: 'a.pdf',
            sha256: SHA,
          }),
        ),
      ),
    ).toBe('NOT_FOUND');
    expect(await auditIds()).toEqual(before);
  });

  it('leaves neither the row nor its event when the caller rolls back', async () => {
    const subject = subjects.document_revision;
    const ticket = await upload(subject);
    const before = await auditIds();
    const listed = await inTenant((tx) => service.list(tx, subject, { includeRemoved: true }));
    let created: IsoFileView | undefined;
    await expect(
      inTenant(async (tx) => {
        created = await service.confirm(tx, caller(), subject, {
          uploadId: ticket.uploadId,
          fileName: 'Draft.pdf',
          sha256: SHA,
        });
        throw new Error('the caller failed after confirming');
      }),
    ).rejects.toThrow('the caller failed after confirming');
    expect(created).toBeDefined();
    expect(await inTenant((tx) => service.get(tx, created!.id))).toBeNull();
    expect(await inTenant((tx) => service.list(tx, subject, { includeRemoved: true }))).toEqual(
      listed,
    );
    expect(await auditIds()).toEqual(before);
  });
});

describe('list and get', () => {
  it("lists a subject's live files oldest first, removed ones only when asked, and writes nothing", async () => {
    const subject = subjects.certification;
    const first = await addFile(subject, 'Certificate.pdf');
    const second = await addFile(subject, 'Scope annex.pdf');
    await inTenant((tx) => service.remove(tx, caller(), second.id, 'Wrong annex.'));
    const before = await auditIds();
    const live = await inTenant((tx) => service.list(tx, subject));
    expect(live.map((file) => file.id)).toContain(first.id);
    expect(live.map((file) => file.id)).not.toContain(second.id);
    const all = await inTenant((tx) => service.list(tx, subject, { includeRemoved: true }));
    expect(all.map((file) => file.id).slice(-2)).toEqual([first.id, second.id]);
    expect(all.every((file) => !('storageKey' in file))).toBe(true);
    expect(await inTenant((tx) => service.get(tx, second.id))).toMatchObject({
      id: second.id,
      subject,
      removeReason: 'Wrong annex.',
    });
    expect(
      await inTenant((tx) => service.get(tx, '01920000-0000-7000-8000-0000000000bb')),
    ).toBeNull();
    expect(await auditIds()).toEqual(before);
  });

  it('shows another tenant nothing', async () => {
    const file = await addFile(subjects.clause_assessment);
    const outsider = await testDb.db.withTenant(
      { firmId: other.firmId, personId: other.people.owner, clientIds: 'ALL', requestId: 'x' },
      async (tx) => ({
        get: await service.get(tx, file.id),
        list: await service.list(tx, subjects.clause_assessment),
        download: await failure(
          service.downloadUrl(
            tx,
            { firmId: other.firmId, personId: other.people.owner, requestId: 'x' },
            file.id,
          ),
        ),
      }),
    );
    expect(outsider).toEqual({ get: null, list: [], download: 'NOT_FOUND' });
  });
});

describe('downloadUrl', () => {
  it('signs a 5-minute GET for a CLEAN file only, with one EVIDENCE_DOWNLOAD on the subject', async () => {
    const subject = subjects.external_audit;
    const file = await addFile(subject, 'Stage 2 report.pdf');
    let before = await auditIds();
    expect(await failure(inTenant((tx) => service.downloadUrl(tx, caller(), file.id)))).toBe(
      'EVIDENCE_NOT_READY',
    );
    expect(await auditIds()).toEqual(before);

    await scan(file.id, 'CLEAN');
    before = await auditIds();
    const signed = await inTenant((tx) => service.downloadUrl(tx, caller(), file.id));
    const key = (await asSystem(f, (tx) => isoFiles.require(tx, file.id))).storageKey;
    expect(signed).toEqual({
      url: `https://storage.test/get/${encodeURIComponent(key)}?expires=300`,
      expiresAt: '2026-10-20T06:05:00.000Z',
    });
    expect(
      key.startsWith(`evidence/${f.firmId}/${f.clientId}/iso/external_audit/${subject.id}/`),
    ).toBe(true);
    const added = [...(await auditIds())].filter(([id]) => !before.has(id));
    expect(added.map(([, action]) => action)).toEqual(['EVIDENCE_DOWNLOAD']);
    const event = (await trail(subject)).find((e) => e.id === added[0]![0])!;
    expect(event).toMatchObject({
      entityType: 'external_audit',
      entityId: subject.id,
      before: null,
      after: { fileId: file.id },
    });
    expect(JSON.stringify(event)).not.toContain('Stage 2 report');
    expect(JSON.stringify(event)).not.toContain('storage.test');
  });

  it('refuses an INFECTED file, a removed one and an unknown id, and writes nothing', async () => {
    const infected = await addFile(subjects.certification);
    await scan(infected.id, 'INFECTED');
    const removed = await addFile(subjects.certification);
    await scan(removed.id, 'CLEAN');
    await inTenant((tx) => service.remove(tx, caller(), removed.id, 'Duplicate.'));
    const before = await auditIds();
    const download = (id: string) =>
      failure(inTenant((tx) => service.downloadUrl(tx, caller(), id)));
    expect(await download(infected.id)).toBe('EVIDENCE_NOT_READY');
    expect(await download(removed.id)).toBe('NOT_FOUND');
    expect(await download('01920000-0000-7000-8000-0000000000cc')).toBe('NOT_FOUND');
    expect(await auditIds()).toEqual(before);
  });
});

describe('remove', () => {
  it('archives the file with its reason (never deletes it), with one EVIDENCE_REMOVE on the subject', async () => {
    const subject = subjects.clause_assessment;
    const file = await addFile(subject, 'Old gap analysis.pdf');
    const before = await auditIds();
    const removed = await inTenant((tx) =>
      service.remove(tx, caller(), file.id, '  Superseded by the new analysis.  '),
    );
    expect(removed).toMatchObject({
      id: file.id,
      removeReason: 'Superseded by the new analysis.',
      archivedAt: expect.any(String),
    });
    const row = await asSystem(f, (tx) => isoFiles.require(tx, file.id));
    expect(row.archivedAt).not.toBeNull();
    const added = [...(await auditIds())].filter(([id]) => !before.has(id));
    expect(added.map(([, action]) => action)).toEqual(['EVIDENCE_REMOVE']);
    const event = (await trail(subject)).find((e) => e.id === added[0]![0])!;
    expect(event).toMatchObject({
      entityType: 'clause_assessment',
      entityId: subject.id,
      before: null,
      after: { fileId: file.id },
      reason: 'Superseded by the new analysis.',
    });
  });

  it('refuses a blank reason and a file already removed, and writes nothing', async () => {
    const file = await addFile(subjects.document_revision);
    const remove = (reason: string) =>
      failure(inTenant((tx) => service.remove(tx, caller(), file.id, reason)));
    let before = await auditIds();
    expect(await remove('   ')).toBe('REASON_REQUIRED');
    expect(await auditIds()).toEqual(before);
    await inTenant((tx) => service.remove(tx, caller(), file.id, 'Wrong file.'));
    before = await auditIds();
    expect(await remove('Again.')).toBe('NOT_FOUND');
    expect(await auditIds()).toEqual(before);
  });

  it('answers NOT_FOUND when the file goes between the read and the archive', async () => {
    const file = await addFile(subjects.document_revision);
    const before = await auditIds();
    const archive = isoFiles.archive.bind(isoFiles);
    vi.spyOn(isoFiles, 'archive').mockImplementationOnce(async (tx, id, reason) => {
      // Another request removes it first.
      await archive(tx, id, reason);
      return archive(tx, id, reason);
    });
    expect(await failure(inTenant((tx) => service.remove(tx, caller(), file.id, 'Raced.')))).toBe(
      'NOT_FOUND',
    );
    expect(await auditIds()).toEqual(before);
  });
});

it('logs no signed URL, file name or content on any call', async () => {
  const written: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      written.push(args.map(String).join(' '));
    });
  }
  const write = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(write);
  vi.spyOn(process.stderr, 'write').mockImplementation(write);

  const subject = subjects.certification;
  const file = await addFile(subject, 'Injured worker statement.pdf');
  await inTenant((tx) => service.list(tx, subject));
  await scan(file.id, 'CLEAN');
  const signed = await inTenant((tx) => service.downloadUrl(tx, caller(), file.id));
  await inTenant((tx) => service.remove(tx, caller(), file.id, 'Moved to the NC.'));
  vi.restoreAllMocks();

  const output = written.join('\n');
  expect(output).not.toContain('Injured worker');
  expect(output).not.toContain(signed.url);
  expect(output).not.toContain('storage.test');
});
