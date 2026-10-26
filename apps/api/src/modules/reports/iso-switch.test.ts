import { randomUUID } from 'node:crypto';
import {
  ExportJob,
  ISO_EXPORT_KINDS,
  LocalDate,
  type ExportKind,
  type RequestContext,
} from '@canopy/contracts';
import ExcelJS from 'exceljs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { membership } from '../../auth/testing.js';
import type { RowFilter } from '../dashboard/ports.js';
import { createWorld, NOW } from '../dashboard/testing/world.js';
import { REGISTER_HEADERS } from './register-xlsx.js';
import { IdempotencyCache, runExport, type ReportsDeps } from './service.js';

/**
 * ISO-11b (docs/iso/plan.md §4.4-4.5, endpoints.md §6): the register export follows the register (`source` while the
 * ISO add-on is on, no ISO activity while it is off), the reports and the certificate are statutory, the ISO export
 * kinds answer 403 while the add-on is off, and the export worker re-checks the add-on when it runs.
 */

const w = createWorld();
const iso = w.addIsoRows();
afterAll(() => w.app.close());
beforeEach(() => w.setIso(false));

const ACT = REGISTER_HEADERS.indexOf('Act');
const admin = () => w.as('FIRM_ADMIN').headers;

async function startExport(headers: Record<string, string>, payload: Record<string, unknown>) {
  return w.app.inject({
    method: 'POST',
    url: `/api/v1/clients/${w.clientId}/exports`,
    headers,
    payload,
  });
}

/** The Act column of the finished register export, one entry per instance row. */
async function exportedActs(jobId: string): Promise<string[]> {
  const key = await w.store.exportStorageKey({ firmId: w.firmId } as RequestContext, jobId);
  const bytes = w.files.files.get(key!)!.bytes;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const acts: string[] = [];
  workbook.worksheets[0]!.eachRow((row, n) => {
    if (n > 1) acts.push(String((row.values as unknown[])[ACT + 1]));
  });
  return acts;
}

async function registerExport(filters: string) {
  const res = await startExport(admin(), { kind: 'REGISTER_XLSX', filters });
  expect(res.statusCode).toBe(202);
  return ExportJob.parse(res.json());
}

async function finished(job: ExportJob): Promise<string[]> {
  await w.runner.idle();
  expect((await w.store.getExportJob({ firmId: w.firmId } as RequestContext, job.id))?.status).toBe(
    'DONE',
  );
  return exportedActs(job.id);
}

const isoAct = w.isoAct.actName;
const count = (acts: string[], name: string) => acts.filter((a) => a === name).length;
const ISO_ROWS = Object.keys(iso).length;
// The base world's Beta Group rows: every one is under a law.
const LAW_ROWS = Object.values(w.rows).filter((r) => r.clientId === w.clientId).length;

describe('the register export follows the register', () => {
  it('lists laws and ISO activities with no source while the add-on is on', async () => {
    w.setIso(true);
    const acts = await finished(await registerExport(''));
    expect(acts).toHaveLength(LAW_ROWS + ISO_ROWS);
    expect(count(acts, isoAct)).toBe(ISO_ROWS);
  });

  it('lists only ISO activities for source=ISO and only laws for source=LAW while it is on', async () => {
    w.setIso(true);
    const isoOnly = await finished(await registerExport('source=ISO'));
    expect(isoOnly).toEqual(Array(ISO_ROWS).fill(isoAct));
    const laws = await finished(await registerExport('source=LAW'));
    expect(laws).toHaveLength(LAW_ROWS);
    expect(count(laws, isoAct)).toBe(0);
  });

  it('leaves ISO activities out while it is off, whatever source says', async () => {
    for (const filters of ['', 'source=LAW', 'source=ISO']) {
      const acts = await finished(await registerExport(filters));
      expect(acts).toHaveLength(LAW_ROWS);
      expect(count(acts, isoAct)).toBe(0);
    }
  });

  it('re-checks the add-on when it runs: a job queued while on, run after a switch-off, has no ISO activity', async () => {
    w.setIso(true);
    const job = await registerExport('source=ISO');
    w.setIso(false);
    const acts = await finished(job);
    expect(count(acts, isoAct)).toBe(0);
    expect(acts).toHaveLength(LAW_ROWS);
  });

  it('a job queued while off, run after a switch-on, follows the source it was asked for', async () => {
    const job = await registerExport('source=ISO');
    w.setIso(true);
    expect(await finished(job)).toEqual(Array(ISO_ROWS).fill(isoAct));
  });
});

/** Filters each ISO kind's body must carry (`ISO_EXPORT_FILTERS`): the audit and the review it is for. */
const ISO_FILTERS: Record<string, string> = {
  ISO_AUDIT_REPORT_PDF: `internalAuditId=${randomUUID()}`,
  ISO_REVIEW_PACK_PDF: `managementReviewId=${randomUUID()}`,
};
const isoBody = (kind: string) => ({ kind, filters: ISO_FILTERS[kind] ?? '' });

describe('ISO export kinds while the add-on is off (endpoints.md §6)', () => {
  /** A finished job of `kind` requested by `personId`, as an earlier switch-on would have left it. */
  async function storedJob(kind: ExportKind, personId: string): Promise<ExportJob> {
    const ctx = { firmId: w.firmId, personId, requestId: 'iso-job' } as RequestContext;
    const job = await w.store.createExportJob(ctx, {
      clientId: w.clientId,
      kind,
      params: { filters: '', unitId: null, fy: null, asOf: '2026-10-12' },
    });
    return w.store.setExportStatus(ctx, job.id, {
      status: 'DONE',
      fileName: 'iso.xlsx',
      storageKey: `exports/${w.firmId}/${w.clientId}/${job.id}/iso.xlsx`,
    });
  }

  for (const kind of ISO_EXPORT_KINDS) {
    it(`${kind}: create answers 403 FEATURE_NOT_ENABLED and queues nothing`, async () => {
      const jobs = w.store.jobs.size;
      const res = await startExport(admin(), isoBody(kind));
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatchObject({
        code: 'FEATURE_NOT_ENABLED',
        details: { feature: 'isoManagement' },
      });
      expect(w.store.jobs.size).toBe(jobs);
    });

    it(`${kind}: the role check comes first, so an owner gets FORBIDDEN`, async () => {
      const res = await startExport(w.as('OWNER').headers, isoBody(kind));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it(`${kind}: with the add-on on, create is still refused until M10 builds the kind`, async () => {
      w.setIso(true);
      const jobs = w.store.jobs.size;
      const res = await startExport(admin(), isoBody(kind));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION');
      expect(w.store.jobs.size).toBe(jobs);
    });

    it(`${kind}: reading the job and its download URL answer 403 while off, and open again when on`, async () => {
      const personId = randomUUID();
      const headers = w.as('FIRM_ADMIN', {}, personId).headers;
      const job = await storedJob(kind, personId);
      for (const url of [`/api/v1/exports/${job.id}`, `/api/v1/exports/${job.id}/download-url`]) {
        const res = await w.app.inject({ url, headers });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FEATURE_NOT_ENABLED');
      }
      w.setIso(true);
      const read = await w.app.inject({ url: `/api/v1/exports/${job.id}`, headers });
      expect(read.statusCode).toBe(200);
      expect(ExportJob.parse(read.json()).kind).toBe(kind);
      const url = await w.app.inject({ url: `/api/v1/exports/${job.id}/download-url`, headers });
      expect(url.statusCode).toBe(200);
    });

    it(`${kind}: another person's job stays NOT_FOUND, off as on`, async () => {
      const job = await storedJob(kind, randomUUID());
      const res = await w.app.inject({ url: `/api/v1/exports/${job.id}`, headers: admin() });
      expect(res.statusCode).toBe(404);
    });
  }

  it('leaves the statutory kinds open while the add-on is off', async () => {
    const res = await startExport(admin(), { kind: 'OVERDUE_REPORT_XLSX', filters: '' });
    expect(res.statusCode).toBe(202);
    await w.runner.idle();
  });
});

describe('the export worker', () => {
  const personId = randomUUID();
  const ctx: RequestContext = {
    requestId: 'iso-worker',
    firmId: w.firmId,
    personId,
    memberships: [membership({ role: 'FIRM_ADMIN', firmId: w.firmId, personId })],
    clientIds: [w.clientId],
    mfaSatisfied: true,
    asOf: LocalDate.parse('2026-10-12'),
  };
  const errors: { kind: ExportKind; error: string }[] = [];
  /** The worker's deps over a store that records each register read's act kinds. */
  function deps(reads: (readonly string[] | undefined)[] = []): ReportsDeps {
    const store = Object.assign(Object.create(w.store) as typeof w.store, {
      registerRows: (c: RequestContext, clientId: string, filter: RowFilter) => {
        reads.push(filter.actKinds);
        return w.store.registerRows(c, clientId, filter);
      },
    });
    return {
      store,
      clock: () => NOW,
      files: w.files,
      runner: w.runner,
      idempotency: new IdempotencyCache(),
      onExportError: ({ kind, error }) => errors.push({ kind, error }),
    };
  }
  const params = { filters: '', unitId: null, fy: null, asOf: '2026-10-12' };
  const queue = (kind: ExportKind, unitId: string | null = null) =>
    w.store.createExportJob(ctx, { clientId: w.clientId, kind, params: { ...params, unitId } });

  for (const on of [false, true]) {
    it(`reads STATUTE acts only for the reports and the certificate, add-on ${on ? 'on' : 'off'}`, async () => {
      w.setIso(on);
      for (const [kind, unitId] of [
        ['ACT_REPORT_XLSX', null],
        ['DEPARTMENT_REPORT_XLSX', null],
        ['OVERDUE_REPORT_XLSX', null],
        ['CERTIFICATE_PDF', w.unit1],
      ] as const) {
        const reads: (readonly string[] | undefined)[] = [];
        const job = await queue(kind, unitId);
        await runExport(deps(reads), ctx, job);
        expect((await w.store.getExportJob(ctx, job.id))?.status).toBe('DONE');
        expect(reads).toEqual([['STATUTE']]);
      }
    });

    it(`keeps every act kind in the client archive, add-on ${on ? 'on' : 'off'}`, async () => {
      w.setIso(on);
      const reads: (readonly string[] | undefined)[] = [];
      const job = await queue('CLIENT_ARCHIVE_ZIP');
      await runExport(deps(reads), ctx, job);
      expect((await w.store.getExportJob(ctx, job.id))?.status).toBe('DONE');
      expect(reads).toEqual([undefined]);
    });
  }

  for (const kind of ISO_EXPORT_KINDS) {
    it(`${kind}: a job queued before a switch-off fails when it runs, and nothing is stored`, async () => {
      const job = await queue(kind);
      const files = w.files.files.size;
      await runExport(deps(), ctx, job);
      expect((await w.store.getExportJob(ctx, job.id))?.status).toBe('FAILED');
      expect(w.files.files.size).toBe(files);
      expect(errors.at(-1)).toEqual({ kind, error: 'ApiError' });
    });
  }
});
