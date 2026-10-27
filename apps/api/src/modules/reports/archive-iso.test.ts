import { createHash, randomUUID } from 'node:crypto';
import { ExportJob, type IsoFileSubjectType } from '@canopy/contracts';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorld } from '../dashboard/testing/world.js';
import { addIsoAudits, addIsoRecords, addIsoReviews } from './testing/iso-records.js';

/**
 * ISO-11d part 4 (docs/iso/model.md §9): the client archive's `iso/` folder on the memory store, with the add-on on
 * and off: the NC log and risk register workbooks, the register of the other records with each held review's stored
 * figures, the clean ISO files with their index, and the withheld ones counted in the README. The same read on
 * Postgres is in iso.db.test.ts.
 */

const w = createWorld();
const records = addIsoRecords(w);
const audits = addIsoAudits(w, records);
const reviews = addIsoReviews(w, records);
afterAll(() => w.app.close());
beforeEach(() => w.store.firms.delete(w.firmId));

const ctx = { firmId: w.firmId } as Parameters<typeof w.store.exportStorageKey>[0];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Stores an ISO file row and (unless `stored` is false) its object. */
function isoFile(
  subjectType: IsoFileSubjectType,
  subjectId: string,
  fileName: string,
  body: string,
  fields: { scanStatus?: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED'; archived?: boolean } = {},
  stored = true,
) {
  const id = randomUUID();
  const storageKey = `evidence/${w.firmId}/${w.clientId}/iso/${id}`;
  w.store.iso.files.push({
    id,
    firmId: w.firmId,
    clientId: w.clientId,
    subjectType,
    subjectId,
    fileName,
    sizeBytes: body.length,
    sha256: sha(body),
    uploadedAt: `2026-10-0${w.store.iso.files.length + 1}T06:00:00.000Z`,
    storageKey,
    scanStatus: fields.scanStatus ?? 'CLEAN',
    archived: fields.archived,
  });
  if (stored)
    w.files.files.set(storageKey, { bytes: Buffer.from(body), contentType: 'text/plain' });
}

isoFile('nonconformity', records.ncs.gauge.id, 'gauge-14.pdf', 'calibration due');
isoFile('nonconformity', records.ncs.gauge.id, 'gauge-14.pdf', 'certificate renewed');
isoFile('internal_audit', audits.reported.id, '../plan.pdf', 'audit plan');
isoFile('management_review', reviews.held.id, 'minutes.pdf', 'scan pending', {
  scanStatus: 'PENDING',
});
isoFile('management_review', reviews.held.id, 'bad.exe', 'infected', { scanStatus: 'INFECTED' });
isoFile('management_review', reviews.held.id, 'old.pdf', 'removed', { archived: true });
isoFile('risk_item', records.risks.hazard.id, 'lost.pdf', 'gone', {}, false);
// Another client's file never reaches this archive.
w.store.iso.files.push({ ...w.store.iso.files[0]!, id: randomUUID(), clientId: w.secondClientId });

async function archive() {
  const headers = w.as('FIRM_ADMIN').headers;
  const res = await w.app.inject({
    method: 'POST',
    url: `/api/v1/clients/${w.clientId}/exports`,
    headers,
    payload: { kind: 'CLIENT_ARCHIVE_ZIP' },
  });
  expect(res.statusCode, res.body).toBe(202);
  await w.runner.idle();
  const job = ExportJob.parse(res.json());
  expect((await w.store.getExportJob(ctx, job.id))?.status).toBe('DONE');
  const file = w.files.files.get((await w.store.exportStorageKey(ctx, job.id))!)!;
  return JSZip.loadAsync(file.bytes);
}

async function workbook(zip: JSZip, path: string) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((await zip.file(path)!.async('arraybuffer')) as ArrayBuffer);
  return book;
}

/** A sheet's rows as objects keyed by its header row. */
function table(book: ExcelJS.Workbook, name: string): Record<string, unknown>[] {
  const sheet = book.getWorksheet(name);
  expect(sheet, name).toBeDefined();
  const [header, ...rows] = (sheet!.getSheetValues() as unknown[][])
    .filter(Boolean)
    .map((row) => row.slice(1));
  return rows.map((row) => Object.fromEntries(header!.map((h, i) => [h, row[i] ?? ''])));
}

const isoEntries = (zip: JSZip) =>
  Object.keys(zip.files)
    .filter((name) => name.startsWith('iso/') && !zip.files[name]!.dir)
    .sort();

describe('ISO data in the client archive', () => {
  for (const on of [true, false]) {
    it(`holds the ISO workbooks, records and clean files, add-on ${on ? 'on' : 'off'}`, async () => {
      w.setIso(on);
      const zip = await archive();
      const gauge = `iso/nonconformity/${records.ncs.gauge.id}`;
      expect(isoEntries(zip)).toEqual(
        [
          `${gauge}/2 gauge-14.pdf`,
          `${gauge}/gauge-14.pdf`,
          `iso/internal_audit/${audits.reported.id}/_plan.pdf`,
          'iso/index.csv',
          'iso/nc-log.xlsx',
          'iso/records.xlsx',
          'iso/risk-register.xlsx',
        ].sort(),
      );
      expect(await zip.file(`${gauge}/2 gauge-14.pdf`)!.async('string')).toBe(
        'certificate renewed',
      );

      const index = (await zip.file('iso/index.csv')!.async('string')).trim().split('\r\n');
      expect(index[0]).toBe('File,Record type,Record id,Uploaded at,Size (bytes),SHA-256');
      expect(index).toHaveLength(4);
      expect(index[1]).toBe(
        [
          `nonconformity/${records.ncs.gauge.id}/gauge-14.pdf`,
          'nonconformity',
          records.ncs.gauge.id,
          '2026-10-01T06:00:00.000Z',
          'calibration due'.length,
          sha('calibration due'),
        ].join(','),
      );

      const readme = await zip.file('README.txt')!.async('string');
      expect(readme).toContain('ISO files included: 3.');
      expect(readme).toContain('Left out: 2 ISO file(s) whose virus scan is pending');
      expect(readme).toContain('Not found in storage: 1 ISO file(s).');
      expect(readme).toContain('iso/records.xlsx');

      // The NC log over the whole client; the risk register with its archived risk.
      const ncLog = (await workbook(zip, 'iso/nc-log.xlsx')).worksheets[0]!;
      const ncText = JSON.stringify(ncLog.getSheetValues());
      for (const nc of Object.values(records.ncs).filter((n) => n.archivedAt === null)) {
        expect(ncText).toContain(nc.description);
      }
      expect(ncText).not.toContain('Only the records of your units');
      const risks = (await workbook(zip, 'iso/risk-register.xlsx')).worksheets[0]!;
      expect(risks.rowCount).toBeGreaterThan(Object.keys(records.risks).length);

      const book = await workbook(zip, 'iso/records.xlsx');
      expect(book.worksheets.map((s) => s.name)).toEqual([
        'Audit programmes',
        'Internal audits',
        'Audit checklists',
        'Audit findings',
        'Actions',
        'Management reviews',
        'Review inputs',
        'Review outputs',
        'Review figures',
        'Names',
      ]);
      const auditRows = table(book, 'Internal audits');
      expect(auditRows.map((r) => r.id)).toEqual(
        expect.arrayContaining([audits.reported.id, audits.planned.id, audits.archived.id]),
      );
      const reported = auditRows.find((r) => r.id === audits.reported.id)!;
      expect(reported.title).toBe(audits.reported.title);
      expect(reported.auditeeIds).toBe(audits.reported.auditeeIds.join('; '));

      const reviewRows = table(book, 'Management reviews');
      expect(reviewRows.map((r) => r.state).sort()).toEqual([
        'CANCELLED',
        'CLOSED',
        'HELD',
        'PLANNED',
      ]);
      const inputs = table(book, 'Review inputs');
      expect(inputs.map((r) => r.notes)).toEqual(
        expect.arrayContaining([
          'Two raised',
          'One lost-time injury on the roller line',
          'Survey score 4.2 of 5',
          'From the paper register',
        ]),
      );
      expect(Object.keys(inputs[0]!)).not.toContain('sourceFigures');
      expect(table(book, 'Review outputs').map((r) => r.decision)).toContain(
        'Fit guards on every roller',
      );
      const actions = table(book, 'Actions');
      expect(actions.map((r) => r.text)).toContain('Buy two light curtains');
      expect(actions.find((r) => r.text === 'Buy two light curtains')!.subject).toBe(
        JSON.stringify({ type: 'MANAGEMENT_REVIEW', id: reviews.held.id }),
      );
      const names = table(book, 'Names');
      expect(names).toContainEqual({
        kind: 'Person',
        id: reviews.attendeeId,
        name: 'Review Attendee',
      });
    });
  }

  it("carries each held review's stored figures in full, with window, recording time and engine version", async () => {
    w.setIso(true);
    const book = await workbook(await archive(), 'iso/records.xlsx');
    const figures = table(book, 'Review figures');
    const stored = reviews.stored;
    const expected = (
      input: typeof stored.ncs,
      key: string,
      rows: { figure: string; value: number; id: string }[],
    ) =>
      rows.map((r) => ({
        managementReviewId: reviews.held.id,
        inputKey: key,
        source: input.source,
        since: input.since,
        asOf: input.asOf,
        figuresStoredAt: '2026-09-30T12:30:00.000Z',
        figuresEngineVersion: '1.2.0',
        ...r,
      }));
    const ncs = records.ncs;
    // The planned review's draft figures and the cancelled one's are never in the archive: it computes none.
    expect(figures.map(({ reviewInputId: _, ...row }) => row)).toEqual([
      ...expected(stored.ncs, 'NONCONFORMITIES', [
        { figure: 'raised', value: 2, id: ncs.gauge.id },
        { figure: 'raised', value: 2, id: ncs.complaint.id },
        { figure: 'open', value: 1, id: ncs.gauge.id },
      ]),
      ...expected(stored.incidents, 'INCIDENTS', [
        { figure: 'incidents', value: 1, id: ncs.incident.id },
        { figure: 'lostDays', value: 4, id: ncs.incident.id },
      ]),
    ]);
  });
});
