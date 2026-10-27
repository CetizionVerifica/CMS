import { randomUUID } from 'node:crypto';
import { ExportJob, FindingType, type RequestContext } from '@canopy/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorld } from '../dashboard/testing/world.js';
import { NO_SELF_AUDIT } from './audit-report-pdf.js';
import { findingTypeWords } from './iso-words.js';
import { addIsoAudits, addIsoRecords, auditRecord } from './testing/iso-records.js';
import { pdfText } from './testing/pdf-text.js';

/**
 * ISO-11d part 2 (docs/iso/model.md §3.7, §3.9, §9): the internal audit report PDF through the export route and the
 * worker on the memory store: its content, the draft and cancelled headings, the independence note, and the
 * requester's unit scope (plan §3.3). The same read on Postgres is in iso.db.test.ts.
 */

const w = createWorld();
const records = addIsoRecords(w);
const audits = addIsoAudits(w, records);
afterAll(() => w.app.close());
beforeEach(() => {
  w.setIso(true);
  w.store.firms.delete(w.firmId);
});

const admin = () => w.as('FIRM_ADMIN').headers;

function startExport(internalAuditId: string, headers = admin()) {
  return w.app.inject({
    method: 'POST',
    url: `/api/v1/clients/${w.clientId}/exports`,
    headers,
    payload: { kind: 'ISO_AUDIT_REPORT_PDF', filters: `internalAuditId=${internalAuditId}` },
  });
}

const ctx = { firmId: w.firmId } as RequestContext;

/** The finished report's text and file name. */
async function report(internalAuditId: string, headers = admin()) {
  const res = await startExport(internalAuditId, headers);
  expect(res.statusCode).toBe(202);
  const job = ExportJob.parse(res.json());
  await w.runner.idle();
  const done = await w.store.getExportJob(ctx, job.id);
  expect(done?.status).toBe('DONE');
  const bytes = w.files.files.get((await w.store.exportStorageKey(ctx, job.id))!)!.bytes;
  return { text: pdfText(bytes), fileName: done!.fileName };
}

describe('the internal audit report', () => {
  it('prints a reported audit: plan, people, independence, summary, checklist and findings', async () => {
    const { text, fileName } = await report(audits.reported.id);
    expect(fileName).toBe('internal-audit-report-2026-09-08.pdf');
    for (const words of [
      'Internal audit report',
      'Casthouse process audit',
      'Beta Group / Plant system / audit programme FY 2026-27',
      'State: Reported',
      'Planned: 2026-09-08 to 2026-09-09',
      'Reported on: 2026-09-12',
      'Units: Plant',
      'Clauses: ISO 9001 8.7',
      'Lead auditor: Lead Auditor',
      'Auditors: Second Auditor',
      'Auditees: Person Owner',
      'Reported to: Person Approver',
      NO_SELF_AUDIT,
      'Calibration control is weak; housekeeping is good.',
      'ISO 9001 8.7 · Plant · Finding',
      'Are gauges calibrated on schedule?',
      "Auditor's note: Gauge 14 overdue",
      'ISO 9001 8.7 · Plant · Conforms',
      'ISO 9001 8.7 · Plant · Not audited',
      'Not audited because: Furnace down for relining',
      '1. Minor nonconformity · Plant · raised NC 1',
      'Gauge 14 out of calibration',
      '2. Opportunity for improvement · The whole system',
      'Improvement action: Buy bin labels · Person Owner · due 2026-11-15 · Open',
    ]) {
      expect(text).toContain(words);
    }
    expect(text).not.toContain('Draft');
  });

  it('marks an audit not yet reported as a draft and prints its independence note', async () => {
    const { text } = await report(audits.planned.id);
    expect(text).toContain('Draft: this audit is planned and not yet reported.');
    expect(text).toContain('Office system');
    expect(text).toContain("Units: The system's units");
    expect(text).toContain('The lead audits the office they run');
    expect(text).not.toContain(NO_SELF_AUDIT);
    expect(text).toContain('Reported on: Not yet reported');
    expect(text).toContain('No summary yet.');
    expect(text).toContain('No checklist rows.');
    expect(text).toContain('No findings.');
  });

  it('prints why a cancelled audit was cancelled', async () => {
    const cancelled = auditRecord(w, {
      programmeId: audits.reported.programmeId,
      leadAuditorId: audits.leadId,
      state: 'CANCELLED',
      cancelReason: 'Plant shut for the monsoon',
    });
    w.store.iso.audits.push(cancelled);
    const { text } = await report(cancelled.id);
    expect(text).toContain('Cancelled: Plant shut for the monsoon');
    expect(text).not.toContain('Draft');
  });

  it('answers 404 at create for an archived, unknown or other-client audit, and queues nothing', async () => {
    const other = auditRecord(
      { firmId: w.firmId, clientId: w.secondClientId },
      { programmeId: audits.reported.programmeId, leadAuditorId: audits.leadId },
    );
    w.store.iso.audits.push(other);
    const jobs = w.store.jobs.size;
    for (const id of [audits.archived.id, randomUUID(), other.id]) {
      const res = await startExport(id);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    expect(w.store.jobs.size).toBe(jobs);
  });

  it("keeps a unit-limited approver to their units' audits and those naming them", async () => {
    const plant = w.as('APPROVER', { unitIds: [w.unit1] }).headers;
    const office = w.as('APPROVER', { unitIds: [w.unit2] }).headers;
    expect((await report(audits.reported.id, plant)).text).toContain('Casthouse process audit');
    expect((await startExport(audits.planned.id, plant)).statusCode).toBe(404);
    // The office audit names no unit: the office system's units (Head Office) decide.
    expect((await report(audits.planned.id, office)).text).toContain('Office safety audit');
    expect((await startExport(audits.reported.id, office)).statusCode).toBe(404);
    // Named on the audit (reported to): readable from any unit.
    const named = w.as('APPROVER', { unitIds: [w.unit2] }, w.approverId).headers;
    expect((await report(audits.reported.id, named)).text).toContain('Casthouse process audit');
    // An approver of the whole client reads both.
    expect((await report(audits.planned.id, w.as('APPROVER').headers)).text).toContain(
      'Office safety audit',
    );
  });

  it('fails a job whose audit was archived after it was queued, and stores nothing', async () => {
    const audit = auditRecord(w, {
      programmeId: audits.reported.programmeId,
      leadAuditorId: audits.leadId,
    });
    w.store.iso.audits.push(audit);
    const res = await startExport(audit.id);
    expect(res.statusCode).toBe(202);
    const job = ExportJob.parse(res.json());
    const files = w.files.files.size;
    w.store.iso.audits.splice(w.store.iso.audits.indexOf(audit), 1, {
      ...audit,
      archivedAt: '2026-10-01T00:00:00.000Z',
    });
    await w.runner.idle();
    expect((await w.store.getExportJob(ctx, job.id))?.status).toBe('FAILED');
    expect(w.files.files.size).toBe(files);
  });
});

describe('finding words', () => {
  it('uses the model words for NC findings and OFIs, the rule for the rest', () => {
    expect(FindingType.options.map(findingTypeWords)).toEqual([
      'Major nonconformity',
      'Minor nonconformity',
      'Observation',
      'Opportunity for improvement',
      'Good practice',
    ]);
  });
});
