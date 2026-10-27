import { IsoFileView, SignedUrl, UploadTicket } from '@canopy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoStorageKey } from './modules/evidence/index.js';
import { createMemoryStorage } from './modules/evidence/testing/storage.js';
import { createHarness, type Harness } from './modules/iso/testing/fixture.js';
import { seedNc } from './modules/iso/testing/records.js';

/**
 * `server.ts` serves the ISO file routes exactly when it serves evidence: given evidence storage it builds M7's real
 * `IsoFiles` over it (ISO-14b), so an upload goes through the signed PUT, the stored object's check and the scan; with
 * no storage the routes are not there. The service's own rules are ISO-15's tests, the routes' rules M16's.
 */

const NOW = new Date('2026-10-20T06:00:00Z');
const memory = createMemoryStorage();
let wired: Harness;
let bare: Harness;

beforeAll(async () => {
  [wired, bare] = await Promise.all([
    createHarness('Wired', NOW, { files: { storage: memory.storage } }),
    createHarness('Bare', NOW, { files: 'none' }),
  ]);
}, 120_000);

afterAll(async () => {
  await Promise.all([wired?.close(), bare?.close()]);
});

const system = (h: Harness) =>
  h.ok('clientAdmin', 'POST', '/systems', {
    name: 'Riverbend system',
    standardIds: [h.f.std9001],
    unitIds: [h.f.unitA],
  });

describe('ISO file routes in buildServer', () => {
  it('uploads, scans, downloads and removes a file through the real service over evidence storage', async () => {
    const nc = await seedNc(wired, (await system(wired)).id as string, { unitId: wired.f.unitA });
    const subject = { type: 'nonconformity', id: nc.id } as const;
    const ticket = UploadTicket.parse(
      await wired.ok('owner', 'POST', '/files/upload-url', {
        subject,
        fileName: 'Calibration record.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4096,
      }),
    );
    const key = isoStorageKey({
      firmId: wired.f.firmId,
      clientId: wired.f.clientId,
      subject,
      uploadId: ticket.uploadId,
    });
    expect(ticket.url).toContain(encodeURIComponent(key));
    // Nothing stored yet: the real service checks the object, the fake would not.
    const early = await wired.send('owner', 'POST', '/files', {
      subject,
      uploadId: ticket.uploadId,
      fileName: 'Calibration record.pdf',
      sha256: 'b'.repeat(64),
    });
    expect(early.status).toBe(400);

    memory.put(key, { sizeBytes: 4096, mimeType: 'application/pdf' });
    const file = IsoFileView.parse(
      await wired.ok('owner', 'POST', '/files', {
        subject,
        uploadId: ticket.uploadId,
        fileName: 'Calibration record.pdf',
        sha256: 'b'.repeat(64),
      }),
    );
    expect(file).toMatchObject({
      subject,
      scanStatus: 'PENDING',
      uploadedById: wired.f.people.owner,
    });
    const listed = await wired.ok(
      'owner',
      'GET',
      `/files?subjectType=nonconformity&subjectId=${nc.id}`,
    );
    expect((listed.items as { id: string }[]).map((i) => i.id)).toEqual([file.id]);

    const pending = await wired.send('owner', 'GET', `/files/${file.id}/download-url`);
    expect([pending.status, (pending.body.error as { code: string }).code]).toEqual([
      422,
      'EVIDENCE_NOT_READY',
    ]);
    await wired.scan(file.id, 'CLEAN');
    const url = SignedUrl.parse(await wired.ok('owner', 'GET', `/files/${file.id}/download-url`));
    expect(url.url).toContain(encodeURIComponent(key));

    const removed = await wired.ok('owner', 'POST', `/files/${file.id}/remove`, {
      reason: 'Wrong record',
    });
    expect(removed).toMatchObject({ id: file.id, removeReason: 'Wrong record' });
    const { audit } = await wired.testDb.written(wired.f.firmId);
    const actions = [...audit.values()];
    for (const action of ['EVIDENCE_ADD', 'EVIDENCE_DOWNLOAD', 'EVIDENCE_REMOVE']) {
      expect(actions).toContain(action);
    }
  });

  it('serves no ISO file route without evidence storage', async () => {
    const nc = await seedNc(bare, (await system(bare)).id as string, { unitId: bare.f.unitA });
    const subject = { type: 'nonconformity', id: nc.id };
    const probes = [
      bare.send('owner', 'POST', '/files/upload-url', {
        subject,
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
      }),
      bare.send('owner', 'POST', '/files', {
        subject,
        uploadId: nc.id,
        fileName: 'a.pdf',
        sha256: 'c'.repeat(64),
      }),
      bare.send('owner', 'GET', `/files?subjectType=nonconformity&subjectId=${nc.id}`),
      bare.send('owner', 'GET', `/files/${nc.id}/download-url`),
      bare.send('owner', 'POST', `/files/${nc.id}/remove`, { reason: 'Not there' }),
    ];
    for (const reply of await Promise.all(probes)) {
      expect([reply.status, (reply.body.error as { code?: string } | undefined)?.code]).toEqual([
        404,
        'NOT_FOUND',
      ]);
    }
    // The ISO routes themselves are there.
    expect((await bare.send('owner', 'GET', '/systems')).status).toBe(200);
  });
});
