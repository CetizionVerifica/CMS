import { randomUUID } from 'node:crypto';
import { DEFAULT_FIRM_SETTINGS, ENDPOINTS, type RequestContext } from '@canopy/contracts';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import { MemoryExportFiles } from '../reports/files.js';
import { REGISTER_HEADERS } from '../reports/register-xlsx.js';
import { InProcessRunner } from '../reports/service.js';
import { PostgresReportsStore, registerFilter } from './db-store.js';
import {
  createTestDb,
  OPEN_COUNT,
  seedFirm,
  type FirmWorld,
  type TestDb,
} from './testing/postgres.js';

/**
 * M10's Postgres adapter over M3's repositories, through the API with row-level security on: two firms, unit
 * scope, every register page, export details, the EXPORT audit event in the same transaction, and job reads.
 */

const NOW = new Date('2026-10-12T06:00:00Z');
let t: TestDb;
let a: FirmWorld;
let b: FirmWorld;
let store: PostgresReportsStore;
const files = new MemoryExportFiles();
const runner = new InProcessRunner();
const auth = createTestAuth();
let app: ReturnType<typeof buildServer>;

beforeAll(async () => {
  t = await createTestDb();
  a = await seedFirm(t.db, await t.createFirm('Kestrel Advisory'), 'Kestrel');
  b = await seedFirm(t.db, await t.createFirm('Second Ledger'), 'Ledger');
  store = new PostgresReportsStore(t.db);
  app = buildServer({ authStore: auth.store, clock: () => NOW, reports: { store, files, runner } });
});

afterAll(async () => {
  await app.close();
  await t.drop();
});

function as(world: FirmWorld, who: keyof FirmWorld['people']) {
  const m = world.memberships[who];
  return auth.signIn({
    firmId: world.firmId,
    personId: world.people[who],
    memberships: [{ role: m.role, clientId: m.clientId ?? null, unitIds: m.unitIds ?? null }],
    principal: { firmClientIds: [world.clientId] },
  }).headers;
}

function ctxOf(world: FirmWorld): RequestContext {
  return {
    requestId: `m10-${randomUUID()}`,
    firmId: world.firmId,
    personId: world.people.firmAdmin,
    memberships: [
      {
        id: randomUUID(),
        firmId: world.firmId,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        archivedAt: null,
        version: 1,
        personId: world.people.firmAdmin,
        role: 'FIRM_ADMIN',
        clientId: null,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: null,
      },
    ],
    clientIds: [world.clientId],
    mfaSatisfied: true,
    asOf: '2026-10-12' as RequestContext['asOf'],
  };
}

const ids = (list: { id: string }[]) => list.map((i) => i.id).sort();

describe('PostgresReportsStore through the API', () => {
  it('counts every instance of the client in the overview, across register pages', async () => {
    const res = await app.inject({
      url: `/api/v1/clients/${a.clientId}/overview?fy=2026-27`,
      headers: as(a, 'firmAdmin'),
    });
    expect(res.statusCode).toBe(200);
    const { result } = ENDPOINTS.clientOverview.response.parse(res.json());
    const all = Object.values(result.instanceIds).flat().sort();
    expect(all).toEqual(ids([...a.open, a.approved, a.submitted, a.notApplicable]));
    expect(result.counts.COMPLIED).toBe(1);
    expect(result.instanceIds.COMPLIED).toEqual([a.approved.id]);
    expect(result.instanceIds.SUBMITTED).toEqual([a.submitted.id]);
    expect(result.instanceIds.NOT_APPLICABLE).toEqual([a.notApplicable.id]);
    expect(result.counts.OVERDUE + result.counts.DUE_SOON + result.counts.UPCOMING).toBe(
      OPEN_COUNT,
    );
  });

  it('limits an owner to their unit', async () => {
    const res = await app.inject({
      url: `/api/v1/clients/${a.clientId}/breakdowns?by=unit&fy=2026-27`,
      headers: as(a, 'owner'),
    });
    expect(res.statusCode).toBe(200);
    const breakdown = ENDPOINTS.breakdown.response.parse(res.json());
    expect(breakdown.rows.map((r) => r.label)).toEqual(['Plant']);
    expect(Object.values(breakdown.rows[0]!.result.instanceIds).flat().sort()).toEqual(
      ids([...a.open, a.approved]),
    );
  });

  it("never shows one firm's client to another firm", async () => {
    const other = await app.inject({
      url: `/api/v1/clients/${a.clientId}/overview?fy=2026-27`,
      headers: as(b, 'firmAdmin'),
    });
    expect(other.statusCode).toBe(404);
    // Even asked directly, the store reads nothing of firm A in firm B's tenant.
    const wrongTenant = { ...ctxOf(b), clientIds: [a.clientId] };
    expect(await store.registerRows(wrongTenant, a.clientId, {})).toEqual([]);
    expect(await store.clients(wrongTenant, [a.clientId])).toEqual([]);
    expect(await store.unit(wrongTenant, a.clientId, a.unit1)).toBeNull();
    expect(await store.exportDetails(wrongTenant, a.clientId, [a.approved.id])).toEqual(new Map());
  });

  it('gives the portfolio one row per client of the firm', async () => {
    const res = await app.inject({
      url: '/api/v1/portfolio?fy=2026-27',
      headers: as(b, 'firmAdmin'),
    });
    expect(res.statusCode).toBe(200);
    const { items } = ENDPOINTS.portfolio.response.parse(res.json());
    expect(items.map((i) => i.clientId)).toEqual([b.clientId]);
  });

  it('exports the register with obligation text, NA reasons and first comments, and audits it', async () => {
    const headers = as(a, 'viewer');
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/clients/${a.clientId}/exports`,
      headers,
      payload: { kind: 'REGISTER_XLSX', filters: '' },
    });
    expect(created.statusCode).toBe(202);
    const jobId = created.json().id as string;
    expect((await t.audit(a.firmId)).get(jobId)).toBe('EXPORT');
    await runner.idle();

    const job = await app.inject({ url: `/api/v1/exports/${jobId}`, headers });
    expect(job.json()).toMatchObject({ status: 'DONE', requestedById: a.people.viewer });
    const key = await store.exportStorageKey(ctxOf(a), jobId);
    expect(key).toMatch(new RegExp(`^exports/${a.firmId}/${a.clientId}/${jobId}/`));

    const book = new ExcelJS.Workbook();
    await book.xlsx.load(files.files.get(key!)!.bytes as unknown as ArrayBuffer);
    const rows = book.worksheets[0]!.getSheetValues().filter(Boolean) as unknown[][];
    expect(rows[0]!.slice(1)).toEqual([...REGISTER_HEADERS]);
    expect(rows).toHaveLength(1 + OPEN_COUNT + 3);
    const byStatus = (status: string) => rows.filter((r) => r[9] === status);
    expect(byStatus('Complied')[0]![16]).toBe('Challan attached');
    expect(byStatus('Not Applicable')[0]![16]).toBe('No boilers on site.');
    expect(rows[1]![4]).toBe('Keep the daily safety register up to date.');
    expect(rows[1]![6]).toBe('Factories with 10 or more workers.');
    expect(rows[1]![13]).toBe('Kestrel Metals Group/ Kestrel Aluminium/ Plant');

    const download = await app.inject({ url: `/api/v1/exports/${jobId}/download-url`, headers });
    expect(download.statusCode).toBe(200);
    // Another person of the same client cannot see the job.
    const theirs = await app.inject({
      url: `/api/v1/exports/${jobId}`,
      headers: as(a, 'approver'),
    });
    expect(theirs.statusCode).toBe(404);
  });

  it('builds a certificate from the unit with its company and location', async () => {
    expect(await store.unit(ctxOf(a), a.clientId, a.unit2)).toEqual({
      id: a.unit2,
      name: 'Head Office',
      companyName: 'Kestrel Aluminium',
      locationLabel: 'India / West Bengal / Riverbend',
    });
    expect(await store.unit(ctxOf(a), b.clientId, a.unit2)).toBeNull();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/clients/${a.clientId}/exports`,
      headers: as(a, 'firmAdmin'),
      payload: { kind: 'CERTIFICATE_PDF', unitId: a.unit2, fy: '2026-27' },
    });
    expect(res.statusCode).toBe(202);
    await runner.idle();
    const job = await store.getExportJob(ctxOf(a), res.json().id);
    expect(job).toMatchObject({
      status: 'DONE',
      fileName: 'compliance-certificate-head-office-fy-2026-27.pdf',
    });
  });
});

describe('PostgresReportsStore reads', () => {
  it('reads the firm settings and the latest audit time per client', async () => {
    expect(await store.firmSettings(ctxOf(a))).toEqual(DEFAULT_FIRM_SETTINGS);
    const before = await store.lastActivity(ctxOf(b), [b.clientId, a.clientId]);
    expect(before).toEqual(
      new Map([
        [b.clientId, null],
        [a.clientId, null],
      ]),
    );
    await store.createExportJob(ctxOf(b), {
      clientId: b.clientId,
      kind: 'ACT_REPORT_XLSX',
      params: {},
    });
    const after = await store.lastActivity(ctxOf(b), [b.clientId]);
    expect(after.get(b.clientId)).toEqual(expect.any(String));
  });

  it('lists clients in name order and nothing for no ids', async () => {
    expect(await store.clients(ctxOf(a), [])).toEqual([]);
    const [client] = await store.clients(ctxOf(a), [a.clientId]);
    expect(client).toMatchObject({ id: a.clientId, name: 'Kestrel Metals Group' });
  });

  it('applies the register filters in the database', async () => {
    const ctx = ctxOf(a);
    expect(await store.registerRows(ctx, a.clientId, { unitIds: [] })).toEqual([]);
    const unit2 = await store.registerRows(ctx, a.clientId, { unitIds: [a.unit2] });
    expect(ids(unit2)).toEqual(ids([a.submitted, a.notApplicable]));
    const submitted = await store.registerRows(ctx, a.clientId, { workflowState: ['SUBMITTED'] });
    expect(ids(submitted)).toEqual([a.submitted.id]);
    const april = await store.registerRows(ctx, a.clientId, {
      dueFrom: '2026-04-01' as never,
      dueTo: '2026-04-30' as never,
    });
    expect(april).toHaveLength(30);
    expect(april.map((r) => r.dueDate)).toEqual([...april.map((r) => r.dueDate)].sort());
  });

  it('turns repository errors into API errors', async () => {
    await expect(store.getExportJob(ctxOf(a), 'not-a-uuid')).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('maps an empty list filter to no rows without asking the database', () => {
    expect(registerFilter({ criticality: [] })).toBeNull();
    expect(registerFilter({ workflowState: [] })).toBeNull();
    expect(registerFilter({ domain: [] })).toBeNull();
    expect(registerFilter({ unitIds: ['u'], q: 'boiler' })).toMatchObject({
      unitIds: ['u'],
      q: 'boiler',
    });
  });
});
