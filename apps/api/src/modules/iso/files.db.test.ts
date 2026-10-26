import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { attach, createHarness, type Harness, type Reply } from './testing/fixture.js';

/**
 * ISO file routes through the `IsoFiles` port (model §6, plan §3.2-3.3, §7 item 2): the subject resolved and scoped
 * before the port is called, the subject's own write rule, locks, the revision in force read by every member, and the
 * file-type, size and reason answers. A refused request makes no port call.
 */

const NOW = new Date('2026-10-20T06:00:00Z');
let h: Harness;
let systemId: string;
let rowId: string;

beforeAll(async () => {
  h = await createHarness('File', NOW);
  systemId = (
    await h.ok('clientAdmin', 'POST', '/systems', {
      name: 'Stonebridge system',
      standardIds: [h.f.std9001],
      unitIds: [h.f.unitA],
    })
  ).id as string;
  const rows = (await h.ok('clientAdmin', 'GET', `/systems/${systemId}/checklist`)).items as {
    id: string;
    clauseNumber: string;
  }[];
  rowId = rows.find((r) => r.clauseNumber === '10.1')!.id;
  await h.ok('clientAdmin', 'PATCH', `/systems/${systemId}/checklist/${rowId}`, {
    version: 1,
    ownerId: h.f.people.owner,
    reason: 'Improvement lead',
  });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(() => {
  h.files.calls.length = 0;
});

const code = (reply: Reply) => (reply.body.error as { code?: string } | undefined)?.code;
const row = () => ({ type: 'clause_assessment', id: rowId }) as const;
const ticket = (subject: object, fields: Record<string, unknown> = {}) => ({
  subject,
  fileName: 'record.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  ...fields,
});

describe('adding files', () => {
  it('lets the row owner add, list, download and remove files on a checklist row', async () => {
    const file = await attach(h, 'owner', row(), 'record.pdf');
    expect(file).toMatchObject({ subject: row(), scanStatus: 'PENDING' });
    expect(h.files.calls.map((c) => c.method)).toEqual(['uploadUrl', 'confirm']);

    const notReady = await h.send('owner', 'GET', `/files/${file.id}/download-url`);
    expect(notReady.status).toBe(422);
    expect(code(notReady)).toBe('EVIDENCE_NOT_READY');
    await h.scan(file.id as string, 'CLEAN');
    expect((await h.ok('viewer', 'GET', `/files/${file.id}/download-url`)).url).toContain(
      file.id as string,
    );

    const listed = await h.ok(
      'viewer',
      'GET',
      `/files?subjectType=clause_assessment&subjectId=${rowId}`,
    );
    expect((listed.items as { id: string }[]).map((f) => f.id)).toContain(file.id);
    expect((await h.send('owner', 'POST', `/files/${file.id}/remove`, {})).status).toBe(422);
    const removed = await h.ok('owner', 'POST', `/files/${file.id}/remove`, {
      reason: 'Wrong year',
    });
    expect(removed.archivedAt).not.toBeNull();
    const after = await h.ok(
      'owner',
      'GET',
      `/files?subjectType=clause_assessment&subjectId=${rowId}`,
    );
    expect((after.items as { id: string }[]).map((f) => f.id)).not.toContain(file.id);
    const all = await h.ok(
      'owner',
      'GET',
      `/files?subjectType=clause_assessment&subjectId=${rowId}&includeRemoved=true`,
    );
    expect((all.items as { id: string }[]).map((f) => f.id)).toContain(file.id);
  });

  it('refuses without calling the port: other units, readers, unknown subjects, bad files', async () => {
    const refusals: [Parameters<Harness['send']>, number, string?][] = [
      [['otherOwner', 'POST', '/files/upload-url', ticket(row())], 404],
      [['viewer', 'POST', '/files/upload-url', ticket(row())], 403],
      [['approver', 'POST', '/files/upload-url', ticket(row())], 403],
      [['owner', 'POST', '/files/upload-url', ticket({ type: 'nonconformity', id: rowId })], 400],
      [['owner', 'POST', '/files/upload-url', ticket({ type: 'certification', id: rowId })], 404],
      [
        ['owner', 'POST', '/files/upload-url', ticket(row(), { sizeBytes: 10 ** 12 })],
        413,
        'FILE_TOO_LARGE',
      ],
      [
        ['owner', 'POST', '/files/upload-url', ticket(row(), { fileName: 'run.exe' })],
        415,
        'UNSUPPORTED_FILE',
      ],
      [['otherOwner', 'GET', `/files?subjectType=clause_assessment&subjectId=${rowId}`], 404],
      [['otherOwner', 'GET', '/files/01920000-0000-7000-8000-0000000000ab/download-url'], 404],
    ];
    for (const [args, status, errorCode] of refusals) {
      const reply = await h.send(...args);
      expect([args[0], args[2], reply.status]).toEqual([args[0], args[2], status]);
      if (errorCode !== undefined) expect(code(reply)).toBe(errorCode);
    }
    expect(h.files.calls).toEqual([]);
  });

  it('confirms only an upload this person was given', async () => {
    const issued = await h.ok('owner', 'POST', '/files/upload-url', ticket(row()));
    const stolen = await h.send('clientAdmin', 'POST', '/files', {
      subject: row(),
      uploadId: issued.uploadId,
      fileName: 'record.pdf',
      sha256: 'b'.repeat(64),
    });
    expect(stolen.status).toBe(400);
  });
});

describe('locks and the revision in force (model §6)', () => {
  it('locks a revision once submitted, reads the one in force for every member, and locks an obsolete document', async () => {
    const doc = await h.ok('clientAdmin', 'POST', '/documents', {
      managementSystemId: systemId,
      code: 'QM-1',
      title: 'Quality manual',
      type: 'MANUAL',
      ownerId: h.f.people.owner,
      approverId: h.f.people.approver,
    });
    const base = `/documents/${doc.id}/revisions`;
    const rev = await h.ok('owner', 'POST', base, { revision: '1', changeNote: 'First issue' });
    const subject = { type: 'document_revision', id: rev.id as string } as const;
    expect(
      (
        await h.send(
          'otherOwner',
          'GET',
          `/files?subjectType=document_revision&subjectId=${rev.id}`,
        )
      ).status,
    ).toBe(404);
    const file = await attach(h, 'owner', subject, 'manual.pdf');
    await h.scan(file.id as string, 'CLEAN');
    await h.ok('owner', 'POST', `${base}/${rev.id}/submit`, { version: 1 });

    h.files.calls.length = 0;
    const locked = await h.send('owner', 'POST', `/files/${file.id}/remove`, { reason: 'Replace' });
    expect(locked.status).toBe(409);
    expect((locked.body.error as { details: unknown }).details).toEqual({
      entity: 'document_revision',
      from: 'IN_REVIEW',
      action: 'UPDATE',
    });
    expect(h.files.calls).toEqual([]);

    await h.ok('approver', 'POST', `${base}/${rev.id}/approve`, { version: 2 });
    // In force: the owner of another unit reads its file, but never writes it.
    const theirs = await h.ok(
      'otherOwner',
      'GET',
      `/files?subjectType=document_revision&subjectId=${rev.id}`,
    );
    expect((theirs.items as { id: string }[]).map((f) => f.id)).toEqual([file.id]);
    expect((await h.ok('otherOwner', 'GET', `/files/${file.id}/download-url`)).url).toBeTruthy();
    expect((await h.send('otherOwner', 'POST', '/files/upload-url', ticket(subject))).status).toBe(
      404,
    );

    // The next revision's files stay within scope; an obsolete document locks its open revision's files.
    const next = await h.ok('owner', 'POST', base, { revision: '2' });
    const nextSubject = { type: 'document_revision', id: next.id as string } as const;
    await attach(h, 'owner', nextSubject, 'draft.pdf');
    expect(
      (
        await h.send(
          'otherOwner',
          'GET',
          `/files?subjectType=document_revision&subjectId=${next.id}`,
        )
      ).status,
    ).toBe(404);
    const version = (await h.ok('approver', 'GET', `/documents/${doc.id}`)).version as number;
    await h.ok('approver', 'POST', `/documents/${doc.id}/obsolete`, {
      version,
      reason: 'Withdrawn',
    });
    const obsolete = await h.send('owner', 'POST', '/files/upload-url', ticket(nextSubject));
    expect((obsolete.body.error as { details: unknown }).details).toEqual({
      entity: 'controlled_document',
      from: 'OBSOLETE',
      action: 'UPDATE',
    });
  });

  it('lets managers add files to a certificate and an external audit; owners read them in scope', async () => {
    const cert = await h.ok('clientAdmin', 'POST', '/certifications', {
      managementSystemId: systemId,
      standardId: h.f.std9001,
      body: 'Northwind Certification',
    });
    const subject = { type: 'certification', id: cert.id as string } as const;
    expect((await h.send('owner', 'POST', '/files/upload-url', ticket(subject))).status).toBe(403);
    const file = await attach(h, 'consultant', subject, 'certificate.pdf');
    const read = await h.ok(
      'owner',
      'GET',
      `/files?subjectType=certification&subjectId=${cert.id}`,
    );
    expect((read.items as { id: string }[]).map((f) => f.id)).toEqual([file.id]);
    expect((await h.send('otherOwner', 'GET', `/files/${file.id}/download-url`)).status).toBe(404);

    const visit = await h.ok('clientAdmin', 'POST', '/external-audits', {
      managementSystemId: systemId,
      standardIds: [h.f.std9001],
      type: 'STAGE_1',
      body: 'Northwind Certification',
      startOn: '2026-10-01',
      endOn: '2026-10-02',
    });
    const report = await attach(h, 'clientAdmin', {
      type: 'external_audit',
      id: visit.id as string,
    });
    expect(report.subject).toEqual({ type: 'external_audit', id: visit.id });
  });
});
