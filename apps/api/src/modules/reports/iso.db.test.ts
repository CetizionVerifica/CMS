import { ExportJob, LocalDate, type RequestContext } from '@canopy/contracts';
import {
  isoActions,
  isoCatalogue,
  managementSystems,
  nonconformities,
  obligations,
  people,
  riskControls,
  riskItems,
  systemContext,
  type TenantTx,
} from '@canopy/db';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountView, createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import { PostgresReportsStore } from '../dashboard/db-store.js';
import {
  createTestDb,
  seedFirm,
  type FirmWorld,
  type TestDb,
} from '../dashboard/testing/postgres.js';
import { MemoryExportFiles } from './files.js';
import { NC_LOG_HEADERS, RISK_REGISTER_HEADERS } from './iso-registers.js';
import { InProcessRunner } from './service.js';
import {
  actionRecord,
  controlRecord,
  incidentFields,
  ncRecord,
  riskRecord,
} from './testing/iso-records.js';

/**
 * ISO-11d part 1 on Postgres (docs/iso/model.md §9, plan §3.3): the NC log and the risk register read through M3's
 * repositories, with M3's unit scope in SQL, every page of a list, and the names of archived people. Firm A has two
 * systems (Plant system on Plant, Office system on Head Office); firm B has none.
 */

const NOW = new Date('2026-10-12T06:00:00Z');
const d = (value: string) => LocalDate.parse(value);
let t: TestDb;
let a: FirmWorld;
let b: FirmWorld;
const files = new MemoryExportFiles();
const runner = new InProcessRunner();
const auth = createTestAuth();
let app: ReturnType<typeof buildServer>;
let seeded: Awaited<ReturnType<typeof seedIso>>;

/** Writes the ISO records through M3's repositories as the system context, as M16 would have. */
async function seedIso(world: FirmWorld) {
  return t.db.withTenant(systemContext(world.firmId, 'm10-iso-exports'), async (tx: TenantTx) => {
    const standard = async (code: 'ISO_9001' | 'ISO_45001', topic: string) =>
      (await isoCatalogue.standards(tx)).find((s) => s.code === code) ??
      isoCatalogue.createStandard(tx, { code, edition: '2015+A1:2024', title: code, topic });
    const iso9001 = await standard('ISO_9001', 'Quality management');
    const iso45001 = await standard('ISO_45001', 'Occupational health and safety');
    const [clause87] = await isoCatalogue.createClauses(tx, [
      {
        standardId: iso9001.id,
        number: '8.7',
        title: 'Clause 8.7',
        summary: 'Our own summary.',
        parentId: null,
        hlsKey: '8.7',
        assessable: true,
        exclusionAllowed: false,
      },
    ]);
    const person = async (name: string) =>
      (
        await people.create(tx, {
          displayName: name,
          nameNormalized: name.toLowerCase(),
          email: null,
          status: 'UNCLAIMED',
        })
      ).id;
    const officeOwner = await person('Office Owner');
    const investigator = await person('Line Investigator');
    const system = async (name: string, unitIds: string[], standardIds: string[]) =>
      (
        await managementSystems.create(tx, {
          clientId: world.clientId,
          name,
          standardIds,
          scopeStatement: null,
          unitIds,
          status: 'IMPLEMENTING',
          reviewIntervalMonths: 12,
          climateChangeRelevant: null,
          climateChangeRationale: null,
          climateDecidedOn: null,
        })
      ).id;
    const plantSystem = await system('Plant system', [world.unit1], [iso9001.id]);
    const officeSystem = await system('Office system', [world.unit2], [iso9001.id, iso45001.id]);
    const cast = {
      firmId: world.firmId,
      clientId: world.clientId,
      ownerId: world.people.owner,
      approverId: world.people.approver,
    };
    /** A fixture as M3's create takes it: no stored columns (and no NC number, which the database sets). */
    const STORED = ['id', 'firmId', 'createdAt', 'updatedAt', 'archivedAt', 'version', 'number'];
    const fields = <T extends object>(row: T) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !STORED.includes(key))) as Omit<
        T,
        'id' | 'firmId' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'version' | 'number'
      >;
    const nc = (row: ReturnType<typeof ncRecord>) => nonconformities.create(tx, fields(row));
    const gauge = await nc(
      ncRecord(cast, {
        number: 1,
        managementSystemId: plantSystem,
        unitId: world.unit1,
        clauseIds: [clause87!.id],
        dueOn: d('2026-10-01'),
      }),
    );
    const complaint = await nc(
      ncRecord(cast, {
        number: 2,
        managementSystemId: officeSystem,
        unitId: world.unit2,
        source: 'COMPLAINT',
        severity: 'MAJOR',
        description: 'Customer received the wrong grade',
        reportedOn: d('2026-08-01'),
        dueOn: d('2026-08-15'),
        ownerId: officeOwner,
        disposition: 'CONCESSION',
        dispositionAuthorisedById: world.people.firmAdmin,
      }),
    );
    const incident = await nc(
      ncRecord(cast, {
        number: 3,
        managementSystemId: officeSystem,
        unitId: world.unit2,
        source: 'INCIDENT',
        standards: ['ISO_45001'],
        description: 'Hand caught in a roller',
        reportedOn: d('2026-10-01'),
        ownerId: officeOwner,
        incident: incidentFields({ investigatorIds: [investigator] }),
      }),
    );
    // A system-wide NC (no unit) of the Plant system.
    const wide = await nc(
      ncRecord(cast, {
        number: 4,
        managementSystemId: plantSystem,
        description: 'Supplier list out of date',
        reportedOn: d('2026-07-01'),
        dueOn: d('2027-01-31'),
      }),
    );
    // More NCs than one page of M3's list: the export reads every page.
    for (let n = 0; n < 205; n += 1) {
      await nc(
        ncRecord(cast, {
          number: 5 + n,
          managementSystemId: plantSystem,
          unitId: world.unit1,
          source: 'OTHER',
          description: `Housekeeping finding ${n}`,
          reportedOn: d('2026-04-01'),
        }),
      );
    }
    await isoActions.create(
      tx,
      fields(
        actionRecord(cast, { type: 'NONCONFORMITY', id: incident.id }, { dueOn: d('2026-10-05') }),
      ),
    );

    const law = await obligations.query(tx, { limit: 1 });
    const risk = (row: ReturnType<typeof riskRecord>) => riskItems.create(tx, fields(row));
    const aspect = await risk(
      riskRecord(cast, {
        managementSystemId: plantSystem,
        kind: 'RISK',
        unitId: world.unit1,
        activity: 'Degreasing',
        likelihood: 4,
        severity: 4,
        rating: 16,
        significant: true,
      }),
    );
    const hazard = await risk(
      riskRecord(cast, {
        managementSystemId: officeSystem,
        kind: 'HAZARD',
        unitId: world.unit2,
        activity: 'Roller line',
        impact: 'Crush injury',
        routine: true,
        personsExposed: ['WORKER'],
        condition: 'NORMAL',
        likelihood: 2,
        severity: 3,
        rating: 6,
        significant: true,
        obligationIds: [law.items[0]!.id],
        ownerId: officeOwner,
      }),
    );
    await risk(
      riskRecord(cast, {
        managementSystemId: plantSystem,
        kind: 'OPPORTUNITY',
        activity: 'Scrap resale',
        rating: 9,
      }),
    );
    await riskControls.create(
      tx,
      fields(controlRecord(cast, hazard.id, { text: 'Two-hand start', hierarchy: 'ENGINEERING' })),
    );
    await riskControls.create(
      tx,
      fields(controlRecord(cast, aspect.id, { text: 'Extraction hood' })),
    );
    await isoActions.create(
      tx,
      fields(
        actionRecord(
          cast,
          { type: 'RISK_ITEM', id: hazard.id },
          { controlHierarchy: 'ENGINEERING' },
        ),
      ),
    );
    // An archived owner keeps their name in the log.
    await people.archive(tx, officeOwner, 1);
    return {
      plantSystem,
      officeSystem,
      officeOwner,
      investigator,
      law: law.items[0]!,
      gauge,
      complaint,
      wide,
    };
  });
}

beforeAll(async () => {
  t = await createTestDb();
  a = await seedFirm(t.db, await t.createFirm('Kestrel Advisory'), 'Kestrel');
  b = await seedFirm(t.db, await t.createFirm('Osprey Ledger'), 'Osprey');
  seeded = await seedIso(a);
  app = buildServer({
    authStore: auth.store,
    clock: () => NOW,
    reports: {
      store: new PostgresReportsStore(t.db),
      files,
      runner,
      exportRateLimit: { max: 1000, timeWindow: '1 minute' },
    },
  });
  for (const world of [a, b]) {
    await t.setFeatures(world.firmId, ['isoManagement']);
    const view = accountView(world.firmId);
    auth.store.accounts.set(
      world.firmId,
      accountView(world.firmId, {
        entitlements: { ...view.entitlements, features: ['isoManagement'] },
      }),
    );
  }
});

afterAll(async () => {
  await app?.close();
  await t.drop();
});

type Role = 'FIRM_ADMIN' | 'APPROVER';
function headers(world: FirmWorld, role: Role, personId: string, unitIds?: string[]) {
  return auth.signIn({
    firmId: world.firmId,
    personId,
    memberships: [role === 'FIRM_ADMIN' ? { role } : { role, clientId: world.clientId, unitIds }],
    principal: { firmClientIds: [world.clientId] },
  }).headers;
}
const admin = (world: FirmWorld) => headers(world, 'FIRM_ADMIN', world.people.firmAdmin);

type Cell = string | number | null;

async function exported(
  world: FirmWorld,
  kind: 'ISO_NC_LOG_XLSX' | 'ISO_RISK_REGISTER_XLSX',
  filters: string,
  as: Record<string, string>,
): Promise<Cell[][]> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/clients/${world.clientId}/exports`,
    headers: as,
    payload: { kind, filters },
  });
  expect(res.statusCode).toBe(202);
  const job = ExportJob.parse(res.json());
  await runner.idle();
  const store = new PostgresReportsStore(t.db);
  const ctx = {
    requestId: 'm10-iso-read',
    firmId: world.firmId,
    personId: job.requestedById,
    memberships: [],
    clientIds: [world.clientId],
    mfaSatisfied: true,
  } as unknown as RequestContext;
  const read = await app.inject({ url: `/api/v1/exports/${job.id}`, headers: as });
  expect(ExportJob.parse(read.json()).status).toBe('DONE');
  const key = await store.exportStorageKey(ctx, job.id);
  const bytes = files.files.get(key!)!.bytes;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const lines: Cell[][] = [];
  workbook.worksheets[0]!.eachRow((row) => {
    lines.push(Array.from((row.values as Cell[]).slice(1), (v) => v ?? null));
  });
  const first = kind === 'ISO_NC_LOG_XLSX' ? NC_LOG_HEADERS[0] : RISK_REGISTER_HEADERS[0];
  return lines.slice(lines.findIndex((line) => line[0] === first) + 1);
}

const nc = (name: (typeof NC_LOG_HEADERS)[number]) => NC_LOG_HEADERS.indexOf(name);
const risk = (name: (typeof RISK_REGISTER_HEADERS)[number]) => RISK_REGISTER_HEADERS.indexOf(name);
// The database numbers NCs in the order written: the four named ones are 1 to 4, the housekeeping ones 5 on.
const named = (rows: Cell[][]) => rows.filter((r) => Number(r[0]) <= 4).map((r) => r[0]);

describe('the NC log on Postgres', () => {
  it('reads every page, newest first, with the names of archived people', async () => {
    const rows = await exported(a, 'ISO_NC_LOG_XLSX', '', admin(a));
    expect(rows).toHaveLength(209);
    expect(named(rows)).toEqual([3, 1, 2, 4]);
    const incident = rows[0]!;
    expect(incident[nc('Owner')]).toBe('Office Owner');
    expect(incident[nc('Unit')]).toBe('Head Office');
    expect(incident[nc('Management system')]).toBe('Office system');
    expect(incident[nc('Timing')]).toBe('Overdue');
    expect(incident[nc('Days overdue')]).toBe(7);
    expect(incident[nc('Occurred on')]).toBe('2026-10-01');
    const gauge = rows[1]!;
    expect(gauge[nc('Clauses')]).toBe('ISO 9001 8.7');
    expect(gauge[nc('Owner')]).toBe('Kestrel Owner');
    expect(gauge[nc('Reported by')]).toBe('Kestrel Approver');
    expect(rows.find((r) => r[0] === 4)![nc('Unit')]).toBe('The whole system');
    expect(rows[2]![nc('Disposition authorised by')]).toBe('Kestrel Firm Admin');
  });

  it("applies M3's filters in SQL and M10's after the read", async () => {
    const office = await exported(
      a,
      'ISO_NC_LOG_XLSX',
      `managementSystemId=${seeded.officeSystem}`,
      admin(a),
    );
    expect(office.map((r) => r[0])).toEqual([3, 2]);
    // Both Head Office NCs are open: the complaint was due 2026-08-15, the incident's action 2026-10-05.
    const overdue = await exported(
      a,
      'ISO_NC_LOG_XLSX',
      `overdue=true&unitId=${a.unit2}`,
      admin(a),
    );
    expect(overdue.map((r) => r[0])).toEqual([3, 2]);
    const late = await exported(a, 'ISO_NC_LOG_XLSX', 'overdue=false&source=PROCESS', admin(a));
    expect(late.map((r) => r[0])).toEqual([4]);
    const incidents = await exported(a, 'ISO_NC_LOG_XLSX', 'incident=true', admin(a));
    expect(incidents.map((r) => r[0])).toEqual([3]);
    const owner = await exported(a, 'ISO_NC_LOG_XLSX', `ownerId=${seeded.officeOwner}`, admin(a));
    expect(owner.map((r) => r[0])).toEqual([3, 2]);
    const text = await exported(a, 'ISO_NC_LOG_XLSX', 'q=supplier list', admin(a));
    expect(text.map((r) => r[0])).toEqual([4]);
  });

  it("limits an approver of Plant to Plant's NCs, its system's own, and those naming them", async () => {
    const plant = headers(a, 'APPROVER', a.people.viewer, [a.unit1]);
    expect(named(await exported(a, 'ISO_NC_LOG_XLSX', '', plant))).toEqual([1, 4]);
    const investigator = headers(a, 'APPROVER', seeded.investigator, [a.unit1]);
    expect(named(await exported(a, 'ISO_NC_LOG_XLSX', '', investigator))).toEqual([3, 1, 4]);
    // The approver named on every NC sees them all, whatever their units.
    const approver = headers(a, 'APPROVER', a.people.approver, [a.unit1]);
    expect(named(await exported(a, 'ISO_NC_LOG_XLSX', '', approver))).toEqual([3, 1, 2, 4]);
  });

  it("never reads another firm's records", async () => {
    expect(await exported(b, 'ISO_NC_LOG_XLSX', '', admin(b))).toEqual([]);
  });
});

describe('the risk register on Postgres', () => {
  it('prints every item with its controls, actions and statutory links', async () => {
    const rows = await exported(a, 'ISO_RISK_REGISTER_XLSX', '', admin(a));
    expect(rows.map((r) => r[risk('Activity')])).toEqual([
      'Degreasing',
      'Scrap resale',
      'Roller line',
    ]);
    const hazard = rows[2]!;
    expect(hazard[risk('Controls in place')]).toBe('Two-hand start (Engineering)');
    expect(hazard[risk('Open treatment actions')]).toBe(1);
    expect(hazard[risk('Statutory obligations')]).toBe(seeded.law.title);
    expect(hazard[risk('Owner')]).toBe('Office Owner');
    expect(rows[0]![risk('Controls in place')]).toBe('Extraction hood');
  });

  it('applies the filters and the unit scope', async () => {
    const hazards = await exported(a, 'ISO_RISK_REGISTER_XLSX', 'kind=HAZARD', admin(a));
    expect(hazards.map((r) => r[risk('Activity')])).toEqual(['Roller line']);
    const plant = headers(a, 'APPROVER', a.people.viewer, [a.unit1]);
    const scoped = await exported(a, 'ISO_RISK_REGISTER_XLSX', '', plant);
    expect(scoped.map((r) => r[risk('Activity')])).toEqual(['Degreasing', 'Scrap resale']);
    const owner = headers(a, 'APPROVER', seeded.officeOwner, [a.unit1]);
    const own = await exported(a, 'ISO_RISK_REGISTER_XLSX', '', owner);
    expect(own.map((r) => r[risk('Activity')])).toEqual([
      'Degreasing',
      'Scrap resale',
      'Roller line',
    ]);
  });
});
