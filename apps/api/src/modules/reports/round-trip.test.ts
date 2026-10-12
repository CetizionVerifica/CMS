import { randomUUID } from 'node:crypto';
import { asLocalDate } from '@canopy/engine';
import { dryRun, fingerprintInstance } from '@canopy/importer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import {
  analyseRecommended,
  loadSample,
  readSheet,
  type SampleClient,
} from '../dashboard/testing/fixtures.js';
import { MemoryReportsStore, type MemoryRow } from '../dashboard/memory-store.js';
import { MemoryExportFiles } from './files.js';
import { REGISTER_HEADERS } from './register-xlsx.js';
import { InProcessRunner } from './service.js';

/**
 * MODULES.md M10 acceptance: the Excel register export re-imports with no changes. The sample register is
 * imported (as the M8 commit stores it), exported through the API, and the export is analysed again against
 * the client's state after the first import: the dry run must create and update nothing.
 */

const NOW = new Date('2026-10-12T06:00:00Z');
// Loading and re-analysing the 424-row sample register is CPU-bound; on a loaded CI runner (every package's
// tests in parallel, as in the merge queue) it can take several times its local 1-2 s.
const SLOW = { timeout: 60_000 };
const store = new MemoryReportsStore(() => NOW);
const files = new MemoryExportFiles();
const runner = new InProcessRunner();
const { store: authStore, signIn } = createTestAuth();
const app = buildServer({ authStore, clock: () => NOW, reports: { store, files, runner } });
let sample: SampleClient;
let headers: Record<string, string>;

beforeAll(async () => {
  const firmId = randomUUID();
  sample = await loadSample(store, firmId);
  headers = signIn({
    firmId,
    memberships: [{ role: 'FIRM_ADMIN' }],
    principal: { firmClientIds: [sample.clientId] },
  }).headers;
}, SLOW.timeout);
afterAll(() => app.close());

async function exportRegister(filters = ''): Promise<Uint8Array> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/clients/${sample.clientId}/exports`,
    headers,
    payload: { kind: 'REGISTER_XLSX', filters },
  });
  expect(res.statusCode).toBe(202);
  await runner.idle();
  const job = await app.inject({ url: `/api/v1/exports/${res.json().id}`, headers });
  expect(job.json()).toMatchObject({
    status: 'DONE',
    fileName: 'compliance-register-all-dates.xlsx',
  });
  const [file] = [...files.files.values()];
  return file!.bytes;
}

describe('register export round trip', SLOW, () => {
  it('exports every instance under the 19 sample headers, in order', async () => {
    const sheet = await readSheet(await exportRegister(), 'export.xlsx');
    expect(sheet.headers).toEqual([...REGISTER_HEADERS]);
    expect(sheet.rows).toHaveLength(422);
  });

  it('re-imports with no changes', async () => {
    files.files.clear();
    const sheet = await readSheet(await exportRegister(), 'export.xlsx');
    const again = analyseRecommended(sheet, sample.state);
    const { report, instanceOutcomes } = dryRun(again, sample.state);
    expect(report.create).toEqual({
      acts: 0,
      categories: 0,
      departments: 0,
      people: 0,
      obligations: 0,
      assignments: 0,
      instances: 0,
      companies: 0,
      units: 0,
      locations: 0,
    });
    expect(report.update.obligations).toBe(0);
    expect(report.update.assignments).toBe(0);
    expect(report.unchanged.instances + report.update.instances).toBe(422);
    expect(report.blockingErrors).toBe(0);
    expect(report.skippedRows).toBe(0);

    // The importer's own notes from the first import (a folded duplicate row, an assumed completion date)
    // are comments the register has no column for. An instance the dry run still counts as updated may
    // differ from what is stored only by those notes: every field matches and the comments it brings are
    // already on the instance, in order. Comments are append-only, so re-importing cannot change them.
    const stored = new Map(sample.analysis.plan.instances.map((i) => [i.key, i]));
    const updated = again.plan.instances.filter((i) => instanceOutcomes.get(i.key) === 'UPDATE');
    expect(updated.length).toBe(report.update.instances);
    for (const incoming of updated) {
      const before = stored.get(incoming.key)!;
      expect({ ...incoming, rowNumbers: [], comments: [] }).toEqual({
        ...before,
        rowNumbers: [],
        comments: [],
      });
      expect(before.comments.slice(0, incoming.comments.length)).toEqual(incoming.comments);
      expect(before.comments.length).toBeGreaterThan(incoming.comments.length);
    }
  });
});

describe('register export round trip after work in the app', SLOW, () => {
  it('re-imports approved work unchanged and shows submitted or sent-back work as still pending', async () => {
    // Three open sample instances worked in the app: one approved, one submitted, one sent back.
    const { instances } = sample.analysis.plan;
    const picked = instances
      .map((plan, index) => ({ plan, row: sample.rows[index]! }))
      .filter(({ plan }) => plan.workflowState === 'OPEN' && plan.comments.length === 0)
      .slice(0, 3);
    expect(picked).toHaveLength(3);
    const [approved, submitted, sentBack] = picked as [
      (typeof picked)[number],
      (typeof picked)[number],
      (typeof picked)[number],
    ];
    const saved = picked.map(({ row }) => ({ row, before: { ...row } }));
    const work: [MemoryRow, Partial<MemoryRow>][] = [
      [approved.row, { workflowState: 'APPROVED', completedOn: asLocalDate('2022-05-10') }],
      [
        submitted.row,
        {
          workflowState: 'SUBMITTED',
          pendingKind: 'COMPLETION',
          completedOn: asLocalDate('2022-05-11'),
        },
      ],
      [sentBack.row, { workflowState: 'SENT_BACK' }],
    ];
    for (const [row, change] of work) Object.assign(row, change);

    try {
      files.files.clear();
      const sheet = await readSheet(await exportRegister(), 'export.xlsx');
      // The stored state after the approval; submitted and sent-back work is not in the importer's state model.
      const approvedPlan = { ...approved.plan, workflowState: 'APPROVED' as const };
      approvedPlan.completedOn = asLocalDate('2022-05-10');
      const state = {
        ...sample.state,
        instances: {
          ...sample.state.instances,
          [approved.plan.key]: fingerprintInstance(approvedPlan),
        },
      };
      const again = analyseRecommended(sheet, state);
      const { report, instanceOutcomes } = dryRun(again, state);
      expect(report.blockingErrors).toBe(0);
      expect(report.create.instances).toBe(0);

      // Approved in the app: "Complied" with its Activity Date, read back as the same instance.
      expect(instanceOutcomes.get(approved.plan.key)).toBe('UNCHANGED');

      // Submitted or sent back: the register has no word for work in progress, so the row is "Pending" with
      // no Activity Date and reads back as the open instance it was before the work started (ADR M10-0001 §8).
      const incoming = new Map(again.plan.instances.map((i) => [i.key, i]));
      for (const { plan } of [submitted, sentBack]) {
        const read = incoming.get(plan.key)!;
        const row = sheet.rows.find((r) => r.rowNumber === read.rowNumbers[0])!;
        expect(row.cells['Compliance Status']).toBe('Pending');
        expect(row.cells['Activity Date'] ?? null).toBeNull();
        expect({ ...read, rowNumbers: [] }).toEqual({ ...plan, rowNumbers: [] });
        expect(instanceOutcomes.get(plan.key)).toBe('UNCHANGED');
      }
    } finally {
      for (const { row, before } of saved) Object.assign(row, before);
    }
  });
});
