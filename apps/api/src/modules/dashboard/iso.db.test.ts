import { randomUUID } from 'node:crypto';
import { ENDPOINTS, ExportJob, type RequestContext } from '@canopy/contracts';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountView, createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import { MemoryExportFiles } from '../reports/files.js';
import { REGISTER_HEADERS } from '../reports/register-xlsx.js';
import { InProcessRunner, runExport, IdempotencyCache } from '../reports/service.js';
import { PostgresReportsStore } from './db-store.js';
import {
  createTestDb,
  OPEN_COUNT,
  seedFirm,
  seedIsoActivities,
  type FirmWorld,
  type IsoActivities,
  type TestDb,
} from './testing/postgres.js';

/**
 * ISO-11b on Postgres (docs/iso/plan.md §4.4-4.6): M3's act-kind filter behind M10's reads, the account's features
 * as the export worker reads them, and an account with ISO activities keeping its statutory numbers. Firm A has ISO
 * activities, firm B the same laws and none.
 */

const NOW = new Date('2026-10-12T06:00:00Z');
let t: TestDb;
let a: FirmWorld;
let b: FirmWorld;
let iso: IsoActivities;
let store: PostgresReportsStore;
const files = new MemoryExportFiles();
const runner = new InProcessRunner();
const auth = createTestAuth();
let app: ReturnType<typeof buildServer>;

beforeAll(async () => {
  t = await createTestDb();
  a = await seedFirm(t.db, await t.createFirm('Kestrel Advisory'), 'Kestrel');
  b = await seedFirm(t.db, await t.createFirm('Osprey Ledger'), 'Osprey');
  iso = await seedIsoActivities(t.db, a);
  store = new PostgresReportsStore(t.db);
  app = buildServer({ authStore: auth.store, clock: () => NOW, reports: { store, files, runner } });
});

afterAll(async () => {
  await app.close();
  await t.drop();
});

/** The console's switch for firm A: the account override the API and the worker read, and M5's request check. */
async function setIso(on: boolean) {
  const features = on ? ['isoManagement'] : [];
  await t.setFeatures(a.firmId, features);
  const view = accountView(a.firmId);
  auth.store.accounts.set(
    a.firmId,
    accountView(a.firmId, { entitlements: { ...view.entitlements, features } }),
  );
}

beforeEach(() => setIso(false));

function headers(world: FirmWorld) {
  return auth.signIn({
    firmId: world.firmId,
    personId: world.people.firmAdmin,
    memberships: [{ role: 'FIRM_ADMIN' }],
    principal: { firmClientIds: [world.clientId] },
  }).headers;
}

function ctxOf(world: FirmWorld): RequestContext {
  return {
    requestId: `m10-iso-${randomUUID()}`,
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

const sorted = (list: { id: string }[]) => list.map((i) => i.id).sort();
const isoIds = () => sorted([...iso.open, iso.approved]);
const lawIds = (w: FirmWorld) => sorted([...w.open, w.approved, w.submitted, w.notApplicable]);

describe('the store on Postgres', () => {
  it('reads laws, ISO activities or both by act kind, and nothing for an empty list', async () => {
    const read = async (actKinds?: ('STATUTE' | 'STANDARD')[]) =>
      sorted(await store.registerRows(ctxOf(a), a.clientId, actKinds ? { actKinds } : {}));
    expect(await read(['STATUTE'])).toEqual(lawIds(a));
    expect(await read(['STANDARD'])).toEqual(isoIds());
    expect(await read()).toEqual([...lawIds(a), ...isoIds()].sort());
    expect(await read([])).toEqual([]);
  });

  it("reads the account's features fresh, and only its own", async () => {
    expect(await store.accountFeatures(ctxOf(a))).toEqual([]);
    await setIso(true);
    expect(await store.accountFeatures(ctxOf(a))).toEqual(['isoManagement']);
    expect(await store.accountFeatures(ctxOf(b))).toEqual([]);
    await setIso(false);
    expect(await store.accountFeatures(ctxOf(a))).toEqual([]);
  });
});

describe('statutory numbers with ISO activities in the account', () => {
  for (const on of [false, true]) {
    it(`the overview counts the laws only, as for an account without ISO, add-on ${on ? 'on' : 'off'}`, async () => {
      await setIso(on);
      const overview = async (w: FirmWorld) => {
        const res = await app.inject({
          url: `/api/v1/clients/${w.clientId}/overview?fy=2026-27`,
          headers: headers(w),
        });
        expect(res.statusCode).toBe(200);
        return ENDPOINTS.clientOverview.response.parse(res.json()).result;
      };
      const [withIso, without] = [await overview(a), await overview(b)];
      expect(Object.values(withIso.instanceIds).flat().sort()).toEqual(lawIds(a));
      expect(withIso.counts).toEqual(without.counts);
      expect(withIso.score).toBe(without.score);
      expect(withIso.counts.OVERDUE + withIso.counts.DUE_SOON + withIso.counts.UPCOMING).toBe(
        OPEN_COUNT,
      );
    });
  }
});

describe('the register export and the worker on Postgres', () => {
  async function exportRows(filters: string, between?: () => Promise<void>) {
    const h = headers(a);
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/clients/${a.clientId}/exports`,
      headers: h,
      payload: { kind: 'REGISTER_XLSX', filters },
    });
    expect(created.statusCode).toBe(202);
    const job = ExportJob.parse(created.json());
    await between?.();
    await runner.idle();
    expect((await store.getExportJob(ctxOf(a), job.id))?.status).toBe('DONE');
    const key = await store.exportStorageKey(ctxOf(a), job.id);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(files.files.get(key!)!.bytes as unknown as ArrayBuffer);
    const act = REGISTER_HEADERS.indexOf('Act') + 1;
    return (book.worksheets[0]!.getSheetValues().filter(Boolean) as unknown[][])
      .slice(1)
      .map((row) => String(row[act]));
  }
  const ISO_ACT = 'Environmental management systems';
  const isoCount = (acts: string[]) => acts.filter((name) => name === ISO_ACT).length;

  it('lists ISO activities for source=ISO while the add-on is on', async () => {
    await setIso(true);
    expect(await exportRows('source=ISO')).toEqual(Array(isoIds().length).fill(ISO_ACT));
    const all = await exportRows('');
    expect(all).toHaveLength(lawIds(a).length + isoIds().length);
  });

  it('leaves them out while it is off, and when the switch goes off before the worker runs', async () => {
    const off = await exportRows('source=ISO');
    expect(isoCount(off)).toBe(0);
    expect(off).toHaveLength(lawIds(a).length);
    // Hold the in-process worker until the switch is off: the job is queued with the add-on on.
    await setIso(true);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const original = runner.run.bind(runner);
    runner.run = (task) => original(() => held.then(task));
    try {
      const late = await exportRows('source=ISO', async () => {
        await setIso(false);
        release();
      });
      expect(isoCount(late)).toBe(0);
    } finally {
      runner.run = original;
    }
  });

  it('fails a queued ISO export kind once the account has no add-on', async () => {
    const ctx = ctxOf(a);
    const job = await store.createExportJob(ctx, {
      clientId: a.clientId,
      kind: 'ISO_NC_LOG_XLSX',
      params: { filters: '', unitId: null, fy: null, asOf: '2026-10-12' },
    });
    const errors: string[] = [];
    await runExport(
      {
        store,
        clock: () => NOW,
        files,
        runner,
        idempotency: new IdempotencyCache(),
        onExportError: ({ error }) => errors.push(error),
      },
      ctx,
      job,
    );
    expect((await store.getExportJob(ctx, job.id))?.status).toBe('FAILED');
    expect(errors).toEqual(['ApiError']);
  });
});
