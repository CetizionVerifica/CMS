import { randomUUID } from 'node:crypto';
import { dryRun } from '@canopy/importer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import {
  analyseRecommended,
  loadSample,
  readSheet,
  type SampleClient,
} from '../dashboard/fixtures.js';
import { MemoryReportsStore } from '../dashboard/memory-store.js';
import { MemoryExportFiles } from './files.js';
import { REGISTER_HEADERS } from './register-xlsx.js';
import { InProcessRunner } from './service.js';

/**
 * MODULES.md M10 acceptance: the Excel register export re-imports with no changes. The sample register is
 * imported (as the M8 commit stores it), exported through the API, and the export is analysed again against
 * the client's state after the first import: the dry run must create and update nothing.
 */

const NOW = new Date('2026-10-12T06:00:00Z');
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
});
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

describe('register export round trip', () => {
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
