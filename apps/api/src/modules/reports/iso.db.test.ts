import {
  ExportJob,
  FyLabel,
  LocalDate,
  type RequestContext,
  type ReviewInputKey,
  type IsoFileSubjectType,
  type ReviewInputSource,
} from '@canopy/contracts';
import {
  auditChecklistItems,
  auditFindings,
  auditProgrammes,
  certifications,
  contextItems,
  controlledDocuments,
  documentRevisions,
  externalAudits,
  internalAudits,
  isoActions,
  isoCatalogue,
  isoFiles,
  managementReviews,
  managementSystems,
  nonconformities,
  objectiveReadings,
  objectives,
  obligations,
  people,
  reviewInputs,
  reviewOutputs,
  riskControls,
  riskItems,
  systemContext,
  type TenantTx,
} from '@canopy/db';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
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
import { pdfText } from './testing/pdf-text.js';
import {
  actionRecord,
  auditRecord,
  controlRecord,
  incidentFields,
  ncRecord,
  riskRecord,
} from './testing/iso-records.js';

/**
 * ISO-11d on Postgres (docs/iso/model.md §9, plan §3.3): the NC log, the risk register and the internal audit report
 * read through M3's repositories, with M3's unit scope in SQL, every page of a list, and the names of archived people.
 * Firm A has two systems (Plant system on Plant, Office system on Head Office); firm B has none.
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
let reviews: Awaited<ReturnType<typeof seedReviews>>;

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
    const riskAction = await isoActions.create(
      tx,
      fields(
        actionRecord(
          cast,
          { type: 'RISK_ITEM', id: hazard.id },
          { controlHierarchy: 'ENGINEERING' },
        ),
      ),
    );
    // Internal audits: a reported audit of Plant with a finding that raised the gauge NC and one with an
    // improvement action; and a planned audit of the office system's units, led by the office owner.
    const lead = await person('Lead Auditor');
    const programme = async (managementSystemId: string) =>
      (
        await auditProgrammes.create(tx, {
          clientId: world.clientId,
          managementSystemId,
          fy: FyLabel.parse('2026-27'),
          notes: null,
        })
      ).id;
    const plantProgramme = await programme(plantSystem);
    const reportedAudit = await internalAudits.create(
      tx,
      fields(
        auditRecord(cast, {
          programmeId: plantProgramme,
          leadAuditorId: lead,
          auditeeIds: [world.people.owner],
          reportedToIds: [world.people.approver],
          unitIds: [world.unit1],
          clauseIds: [clause87!.id],
          state: 'REPORTED',
          summary: 'Calibration control is weak.',
          reportedOn: d('2026-09-12'),
        }),
      ),
    );
    const ncFinding = await auditFindings.create(tx, {
      clientId: world.clientId,
      internalAuditId: reportedAudit.id,
      externalAuditId: null,
      type: 'MINOR_NC',
      clauseIds: [clause87!.id],
      unitId: world.unit1,
      description: 'Gauge 14 out of calibration',
      nonconformityId: gauge.id,
    });
    const ofi = await auditFindings.create(tx, {
      clientId: world.clientId,
      internalAuditId: reportedAudit.id,
      externalAuditId: null,
      type: 'OFI',
      clauseIds: [],
      unitId: null,
      description: 'Label the scrap bins',
      nonconformityId: null,
    });
    await auditChecklistItems.create(tx, {
      clientId: world.clientId,
      internalAuditId: reportedAudit.id,
      clauseId: clause87!.id,
      unitId: world.unit1,
      question: 'Are gauges calibrated on schedule?',
      auditorNote: null,
      result: 'FINDING',
      findingId: ncFinding.id,
      notAuditedReason: null,
    });
    await isoActions.create(
      tx,
      fields(actionRecord(cast, { type: 'AUDIT_FINDING', id: ofi.id }, { text: 'Buy bin labels' })),
    );
    const plannedAudit = await internalAudits.create(
      tx,
      fields(
        auditRecord(cast, {
          programmeId: await programme(officeSystem),
          title: 'Office safety audit',
          leadAuditorId: officeOwner,
        }),
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
      reportedAudit,
      plannedAudit,
      incident,
      aspect,
      riskAction,
      ncFinding,
      iso9001: iso9001.id,
      iso45001: iso45001.id,
    };
  });
}

/**
 * Management reviews of a "Site system" on both units (ISO-11d part 3): a HELD review whose stored figures name
 * records of every kind the pack labels, at Plant and at Head Office, chaired by the office owner with the approver
 * attending; and a PLANNED one, computed through M3's gather and the engine when the pack is made.
 */
async function seedReviews(world: FirmWorld, iso: Awaited<ReturnType<typeof seedIso>>) {
  return t.db.withTenant(systemContext(world.firmId, 'm10-iso-reviews'), async (tx: TenantTx) => {
    const input = (standardId: string, key: ReviewInputKey, source: ReviewInputSource) => ({
      standardId,
      key,
      clauseNumber: '9.3.2',
      item: key === 'INCIDENTS' ? null : 'c',
      title: `Input ${key.toLowerCase()}`,
      source,
    });
    await isoCatalogue.createReviewInputDefs(tx, [
      input(iso.iso9001, 'NONCONFORMITIES', 'NONCONFORMITIES'),
      input(iso.iso9001, 'CUSTOMER_SATISFACTION', 'MANUAL'),
      input(iso.iso9001, 'AUDIT_RESULTS', 'AUDIT_RESULTS'),
      input(iso.iso9001, 'RISK_ACTIONS', 'RISKS'),
      input(iso.iso9001, 'CONTEXT_CHANGES', 'CONTEXT'),
      input(iso.iso45001, 'INCIDENTS', 'INCIDENTS'),
      input(iso.iso45001, 'COMPLIANCE_EVALUATION', 'COMPLIANCE_EVALUATION'),
    ]);
    await isoCatalogue.createReviewOutputDefs(tx, [
      {
        standardId: iso.iso9001,
        key: 'IMPROVEMENT',
        clauseNumber: '9.3.3',
        item: 'a',
        title: 'Improvement',
      },
    ]);
    const site = await managementSystems.create(tx, {
      clientId: world.clientId,
      name: 'Site system',
      standardIds: [iso.iso9001, iso.iso45001],
      scopeStatement: null,
      unitIds: [world.unit1, world.unit2],
      status: 'IMPLEMENTING',
      reviewIntervalMonths: 12,
      climateChangeRelevant: null,
      climateChangeRationale: null,
      climateDecidedOn: null,
    });
    const review = async (fields: Partial<Parameters<typeof managementReviews.create>[1]>) => {
      const made = await managementReviews.create(tx, {
        clientId: world.clientId,
        managementSystemId: site.id,
        standards: ['ISO_9001', 'ISO_45001'],
        plannedOn: d('2026-09-30'),
        heldOn: null,
        chairId: iso.officeOwner,
        attendeeIds: [world.people.approver],
        minutes: null,
        state: 'PLANNED',
        cancelReason: null,
        ...fields,
      });
      await reviewInputs.addForReview(tx, made, [iso.iso9001, iso.iso45001]);
      await reviewOutputs.addForReview(tx, made, [iso.iso9001]);
      return made;
    };
    const held = await review({ state: 'HELD', heldOn: d('2026-09-30'), minutes: 'Guarding' });
    const figures = (source: ReviewInputSource, list: [string, number, string[]][]) => ({
      source,
      since: d('2026-04-01'),
      asOf: d('2026-09-30'),
      figures: list.map(([key, value, ids]) => ({ key, value, ids })),
    });
    const stored: Partial<Record<ReviewInputKey, ReturnType<typeof figures>>> = {
      NONCONFORMITIES: figures('NONCONFORMITIES', [
        ['raised', 2, [iso.gauge.id, iso.complaint.id]],
        ['open', 1, [iso.gauge.id]],
      ]),
      INCIDENTS: figures('INCIDENTS', [
        ['incidents', 1, [iso.incident.id]],
        ['lostDays', 4, [iso.incident.id]],
      ]),
      AUDIT_RESULTS: figures('AUDIT_RESULTS', [
        ['internalAuditsReported', 1, [iso.reportedAudit.id]],
        ['findingsMinorNc', 1, [iso.ncFinding.id]],
      ]),
      RISK_ACTIONS: figures('RISKS', [
        ['itemsAdded', 1, [iso.aspect.id]],
        ['treatmentActionsOpen', 1, [iso.riskAction.id]],
      ]),
      CONTEXT_CHANGES: figures('CONTEXT', [['climateDecided', 1, [site.id]]]),
      COMPLIANCE_EVALUATION: figures('COMPLIANCE_EVALUATION', [
        ['statutoryInstancesDue', 1, [world.approved.id]],
        ['statutoryScore', 100, []],
      ]),
    };
    const defs = await isoCatalogue.reviewDefs(tx);
    for (const row of await reviewInputs.forReview(tx, held.id)) {
      const key = defs.inputs.find((def) => def.id === row.inputDefId)!.key;
      const notes = key === 'INCIDENTS' ? 'Roller line injury' : `Notes on ${key.toLowerCase()}`;
      const noted = await reviewInputs.update(tx, row.id, row.version, { notes });
      if (stored[key]) await reviewInputs.storeFigures(tx, noted.id, stored[key], '1.2.0');
    }
    const planned = await review({ plannedOn: d('2027-03-15') });
    await isoActions.create(tx, {
      clientId: world.clientId,
      subject: { type: 'MANAGEMENT_REVIEW', id: held.id },
      text: 'Buy two light curtains',
      resources: null,
      ownerId: world.people.owner,
      dueOn: d('2026-12-01'),
      doneOn: null,
      state: 'OPEN',
      effectivenessNote: null,
      cancelReason: null,
      controlHierarchy: null,
      outputKey: 'IMPROVEMENT',
    });
    return { held, planned };
  });
}

beforeAll(async () => {
  t = await createTestDb();
  a = await seedFirm(t.db, await t.createFirm('Kestrel Advisory'), 'Kestrel');
  b = await seedFirm(t.db, await t.createFirm('Osprey Ledger'), 'Osprey');
  seeded = await seedIso(a);
  reviews = await seedReviews(a, seeded);
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

describe('the internal audit report on Postgres', () => {
  function create(world: FirmWorld, internalAuditId: string, as: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/clients/${world.clientId}/exports`,
      headers: as,
      payload: { kind: 'ISO_AUDIT_REPORT_PDF', filters: `internalAuditId=${internalAuditId}` },
    });
  }

  async function report(internalAuditId: string, as: Record<string, string>): Promise<string> {
    const res = await create(a, internalAuditId, as);
    expect(res.statusCode).toBe(202);
    const job = ExportJob.parse(res.json());
    await runner.idle();
    const read = await app.inject({ url: `/api/v1/exports/${job.id}`, headers: as });
    expect(ExportJob.parse(read.json()).status).toBe('DONE');
    const ctx = {
      requestId: 'm10-iso-read',
      firmId: a.firmId,
      personId: job.requestedById,
      memberships: [],
      clientIds: [a.clientId],
      mfaSatisfied: true,
    } as unknown as RequestContext;
    const key = await new PostgresReportsStore(t.db).exportStorageKey(ctx, job.id);
    return pdfText(files.files.get(key!)!.bytes);
  }

  it('prints the audit, its people, checklist, findings with their NC numbers and actions', async () => {
    const text = await report(seeded.reportedAudit.id, admin(a));
    for (const words of [
      'Kestrel Metals Group / Plant system / audit programme FY 2026-27',
      'Units: Plant',
      'Clauses: ISO 9001 8.7',
      'Lead auditor: Lead Auditor',
      'Auditees: Kestrel Owner',
      'Reported to: Kestrel Approver',
      'Calibration control is weak.',
      'ISO 9001 8.7 · Plant · Finding',
      '1. Minor nonconformity · Plant · raised NC 1',
      '2. Opportunity for improvement · The whole system',
      'Improvement action: Buy bin labels · Kestrel Owner',
    ]) {
      expect(text).toContain(words);
    }
    // The office audit's archived lead keeps their name.
    expect(await report(seeded.plannedAudit.id, admin(a))).toContain('Lead auditor: Office Owner');
  });

  it("limits a unit-limited approver to their units' audits and those naming them", async () => {
    const office = headers(a, 'APPROVER', a.people.viewer, [a.unit2]);
    expect((await create(a, seeded.reportedAudit.id, office)).statusCode).toBe(404);
    expect(await report(seeded.plannedAudit.id, office)).toContain('Office safety audit');
    const plant = headers(a, 'APPROVER', a.people.viewer, [a.unit1]);
    expect((await create(a, seeded.plannedAudit.id, plant)).statusCode).toBe(404);
    const named = headers(a, 'APPROVER', a.people.approver, [a.unit2]);
    expect(await report(seeded.reportedAudit.id, named)).toContain('Casthouse process audit');
  });

  it("never reads another firm's audit", async () => {
    expect((await create(b, seeded.reportedAudit.id, admin(b))).statusCode).toBe(404);
  });
});

describe('the management review pack on Postgres', () => {
  function create(world: FirmWorld, managementReviewId: string, as: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/clients/${world.clientId}/exports`,
      headers: as,
      payload: { kind: 'ISO_REVIEW_PACK_PDF', filters: `managementReviewId=${managementReviewId}` },
    });
  }

  async function pack(managementReviewId: string, as: Record<string, string>): Promise<string> {
    const res = await create(a, managementReviewId, as);
    expect(res.statusCode).toBe(202);
    const job = ExportJob.parse(res.json());
    await runner.idle();
    const read = await app.inject({ url: `/api/v1/exports/${job.id}`, headers: as });
    expect(ExportJob.parse(read.json()).status).toBe('DONE');
    const ctx = {
      requestId: 'm10-iso-read',
      firmId: a.firmId,
      personId: job.requestedById,
      memberships: [],
      clientIds: [a.clientId],
      mfaSatisfied: true,
    } as unknown as RequestContext;
    const key = await new PostgresReportsStore(t.db).exportStorageKey(ctx, job.id);
    return pdfText(files.files.get(key!)!.bytes);
  }

  it('prints the stored figures with their heading and a reference for every kind of record', async () => {
    const text = await pack(reviews.held.id, admin(a));
    for (const words of [
      'Kestrel Metals Group / Site system / ISO 9001, ISO 45001',
      'Chair: Office Owner',
      'Attendees: Kestrel Approver',
      'Input nonconformities (ISO 9001 9.3.2 c)',
      'Input incidents (ISO 45001 9.3.2)',
      'Figures for 2026-04-01 to 2026-09-30, recorded',
      '(engine 1.2.0)',
      'Raised: 2',
      'Records: NC 1; NC 2',
      'Records: NC 3',
      'Notes: Roller line injury',
      'Records: Casthouse process audit',
      'Records: Minor nonconformity: Gauge 14 out of calibration',
      'Records: Degreasing: A late alloy delivery stops the line',
      'Records: Recalibrate the gauge',
      'Records: Site system',
      'Statutory compliance score: 100',
      'Input customer_satisfaction',
      'Notes: Notes on customer_satisfaction',
      'Improvement (ISO 9001 9.3.3 a)',
      'Buy two light curtains · Kestrel Owner · due 2026-12-01 · Open',
    ]) {
      expect(text).toContain(words);
    }
    expect(text).toContain(`Records: Daily safety register, due ${a.approved.dueDate}`);
  });

  it('keeps the values for an approver of Plant, with fewer references and the incidents withheld', async () => {
    const plant = headers(a, 'APPROVER', a.people.viewer, [a.unit1]);
    const text = await pack(reviews.held.id, plant);
    expect(text).toContain('Raised: 2 (1 you can open)');
    expect(text).toContain('Records: NC 1');
    expect(text).not.toContain('NC 2');
    expect(text).toContain('Figures and notes withheld: they count incidents you may not open');
    expect(text).not.toContain('Roller line injury');
    // The approver attends: the incidents show, with the references they may open.
    const attendee = headers(a, 'APPROVER', a.people.approver, [a.unit1]);
    const attended = await pack(reviews.held.id, attendee);
    expect(attended).toContain('Notes: Roller line injury');
    expect(attended).toContain('Incidents and near misses: 1');
    // Named on the incident (its investigator): its reference, so the row.
    const investigator = headers(a, 'APPROVER', seeded.investigator, [a.unit1]);
    expect(await pack(reviews.held.id, investigator)).toContain('Records: NC 3');
  });

  it('prints the stored figures unchanged after the records change', async () => {
    await t.db.withTenant(systemContext(a.firmId, 'm10-iso-edit'), async (tx: TenantTx) => {
      const gauge = await nonconformities.require(tx, seeded.gauge.id);
      await nonconformities.archive(tx, gauge.id, gauge.version);
    });
    const text = await pack(reviews.held.id, admin(a));
    expect(text).toContain('Raised: 2');
    expect(text).toContain('Open: 1');
    expect(text).toContain('Records: NC 1; NC 2');
  });

  it('computes a planned review as of the day the pack is made, and refuses another firm', async () => {
    const text = await pack(reviews.planned.id, admin(a));
    expect(text).toContain('Draft: this review is planned and not yet held.');
    expect(text).toMatch(/Draft: figures for \d{4}-\d{2}-\d{2} to 2026-10-12/);
    expect(text).toContain('Raised: 0');
    expect((await create(b, reviews.held.id, admin(b))).statusCode).toBe(404);
    const office = headers(a, 'APPROVER', a.people.viewer, [a.unit2]);
    expect(await pack(reviews.planned.id, office)).toContain('Draft');
  });
});

describe("the client archive's ISO data on Postgres", () => {
  const SHA = 'a'.repeat(64);
  let extra: Awaited<ReturnType<typeof seedArchive>>;

  /** The records only the archive reads, and ISO files: one clean, one pending, one clean but removed. */
  async function seedArchive(world: FirmWorld) {
    return t.db.withTenant(systemContext(world.firmId, 'm10-iso-archive'), async (tx: TenantTx) => {
      const context = await contextItems.create(tx, {
        clientId: world.clientId,
        managementSystemId: seeded.plantSystem,
        kind: 'INTERNAL_ISSUE',
        text: 'Alloy prices',
        needs: null,
        climateRelated: false,
        reviewedOn: null,
      });
      const doc = (code: string, title: string, status: 'ACTIVE' | 'OBSOLETE') =>
        controlledDocuments.create(tx, {
          clientId: world.clientId,
          managementSystemId: seeded.plantSystem,
          code,
          title,
          type: 'PROCEDURE',
          clauseIds: [],
          status,
          currentRevisionId: null,
          ownerId: world.people.owner,
          approverId: world.people.approver,
          reviewDueOn: null,
          lastReviewedOn: null,
          retention: null,
          issuer: null,
          externalRef: null,
        });
      const document = await doc('QP-07', 'Calibration procedure', 'ACTIVE');
      // The document list reads ACTIVE ones unless asked: the archive asks for every status.
      const obsolete = await doc('QP-01', 'Old calibration procedure', 'OBSOLETE');
      const revision = await documentRevisions.create(tx, {
        clientId: world.clientId,
        documentId: document.id,
        revision: 'A',
        changeNote: 'First issue',
        state: 'DRAFT',
        preparedById: world.people.owner,
        approvedById: null,
        approvedAt: null,
        sendBackReason: null,
      });
      const objective = await objectives.create(tx, {
        clientId: world.clientId,
        managementSystemId: seeded.plantSystem,
        standards: ['ISO_9001'],
        text: 'Cut customer complaints',
        target: 10,
        unitOfMeasure: 'complaints a year',
        baseline: 24,
        direction: 'DECREASE',
        readingRule: { kind: 'MONTHLY', day: 5, offsetMonths: 1 },
        riskItemIds: [],
        ownerId: world.people.owner,
        dueOn: d('2027-03-31'),
        closedOn: null,
        outcome: null,
      });
      const reading = await objectiveReadings.create(tx, {
        clientId: world.clientId,
        objectiveId: objective.id,
        periodStart: d('2026-05-01'),
        periodEnd: d('2026-05-31'),
        value: 3,
        note: null,
        recordedById: world.people.owner,
      });
      const external = await externalAudits.create(tx, {
        clientId: world.clientId,
        managementSystemId: seeded.plantSystem,
        standardIds: [seeded.iso9001],
        type: 'SURVEILLANCE_1',
        body: 'Osprey Certification',
        leadAuditorName: null,
        startOn: d('2026-07-01'),
        endOn: d('2026-07-02'),
        recommendation: null,
        responseDueOn: null,
        state: 'HELD',
        cancelReason: null,
      });
      const certificate = await certifications.create(tx, {
        clientId: world.clientId,
        managementSystemId: seeded.plantSystem,
        standardId: seeded.iso9001,
        body: 'Osprey Certification',
        certificateNumber: null,
        issuedOn: null,
        expiresOn: null,
        scopeText: null,
        unitIds: [],
      });
      const file = async (
        subject: { type: IsoFileSubjectType; id: string },
        fileName: string,
        body: string | null,
      ) => {
        const made = await isoFiles.create(tx, {
          clientId: world.clientId,
          subject,
          fileName,
          mimeType: 'application/pdf',
          sizeBytes: 10,
          sha256: SHA,
          storageKey: `evidence/${world.firmId}/${world.clientId}/iso/${subject.type}/${subject.id}/${fileName}`,
          uploadedById: world.people.owner,
        });
        if (body !== null) {
          await isoFiles.setScanStatus(tx, made.id, 'CLEAN');
          files.files.set(made.storageKey, { bytes: Buffer.from(body), contentType: 'text/plain' });
        }
        return made;
      };
      const certificateFile = await file(
        { type: 'certification', id: certificate.id },
        'certificate.pdf',
        'the certificate',
      );
      await file({ type: 'document_revision', id: revision.id }, 'draft.pdf', null);
      const removed = await file(
        { type: 'nonconformity', id: seeded.complaint.id },
        'old.pdf',
        'x',
      );
      await isoFiles.archive(tx, removed.id, 'Uploaded in error');
      return {
        context,
        document,
        obsolete,
        revision,
        objective,
        reading,
        external,
        certificateFile,
      };
    });
  }

  beforeAll(async () => {
    extra = await seedArchive(a);
  });

  async function archive(world: FirmWorld): Promise<JSZip> {
    const as = admin(world);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/clients/${world.clientId}/exports`,
      headers: as,
      payload: { kind: 'CLIENT_ARCHIVE_ZIP' },
    });
    expect(res.statusCode, res.body).toBe(202);
    const job = ExportJob.parse(res.json());
    await runner.idle();
    const read = await app.inject({ url: `/api/v1/exports/${job.id}`, headers: as });
    expect(ExportJob.parse(read.json()).status).toBe('DONE');
    const ctx = {
      requestId: 'm10-iso-read',
      firmId: world.firmId,
      personId: job.requestedById,
      memberships: [],
      clientIds: [world.clientId],
      mfaSatisfied: true,
    } as unknown as RequestContext;
    const key = await new PostgresReportsStore(t.db).exportStorageKey(ctx, job.id);
    return JSZip.loadAsync(files.files.get(key!)!.bytes);
  }

  async function sheets(zip: JSZip): Promise<Map<string, Record<string, unknown>[]>> {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await zip.file('iso/records.xlsx')!.async('arraybuffer')) as ArrayBuffer);
    return new Map(
      book.worksheets.map((sheet) => {
        const [header, ...rows] = (sheet.getSheetValues() as unknown[][])
          .filter(Boolean)
          .map((row) => row.slice(1));
        return [
          sheet.name,
          rows.map((row) => Object.fromEntries(header!.map((h, i) => [h, row[i] ?? '']))),
        ];
      }),
    );
  }

  for (const on of [true, false]) {
    it(`holds every kind of ISO record, the held review's figures and the clean files, add-on ${on ? 'on' : 'off'}`, async () => {
      await t.setFeatures(a.firmId, on ? ['isoManagement'] : []);
      const zip = await archive(a);
      await t.setFeatures(a.firmId, ['isoManagement']);
      const book = await sheets(zip);
      const ids = (name: string) => book.get(name)!.map((row) => row.id);
      expect(ids('Management systems')).toEqual(
        expect.arrayContaining([seeded.plantSystem, seeded.officeSystem]),
      );
      expect(ids('Context items')).toContain(extra.context.id);
      expect(ids('Documents')).toEqual(
        expect.arrayContaining([extra.document.id, extra.obsolete.id]),
      );
      expect(ids('Document revisions')).toContain(extra.revision.id);
      expect(ids('Certifications')).toHaveLength(1);
      expect(ids('External audits')).toEqual([extra.external.id]);
      expect(ids('Objectives')).toEqual([extra.objective.id]);
      expect(ids('Objective readings')).toEqual([extra.reading.id]);
      expect(ids('Internal audits')).toEqual(
        expect.arrayContaining([seeded.reportedAudit.id, seeded.plannedAudit.id]),
      );
      expect(ids('Audit findings')).toContain(seeded.ncFinding.id);
      expect(ids('Audit checklists').length).toBeGreaterThan(0);
      expect(ids('Audit programmes').length).toBeGreaterThan(0);
      expect(book.get('Clause checklist')).toBeDefined();
      expect(ids('Actions')).toContain(seeded.riskAction.id);
      expect(ids('Management reviews')).toEqual(
        expect.arrayContaining([reviews.held.id, reviews.planned.id]),
      );
      expect(book.get('Review inputs')!.map((row) => row.notes)).toContain('Roller line injury');
      expect(book.get('Review outputs')!.length).toBe(2);
      expect(book.get('Names')).toContainEqual({
        kind: 'Person',
        id: seeded.officeOwner,
        name: 'Office Owner',
      });

      // Only the held review's stored figures, as stored, with their window, recording time and engine version.
      const figures = book.get('Review figures')!;
      expect(new Set(figures.map((row) => row.managementReviewId))).toEqual(
        new Set([reviews.held.id]),
      );
      const raised = figures.filter((row) => row.figure === 'raised');
      expect(raised.map((row) => row.id)).toEqual([seeded.gauge.id, seeded.complaint.id]);
      expect(raised[0]).toMatchObject({
        inputKey: 'NONCONFORMITIES',
        source: 'NONCONFORMITIES',
        since: '2026-04-01',
        asOf: '2026-09-30',
        figuresEngineVersion: '1.2.0',
        value: 2,
      });
      expect(String(raised[0]!.figuresStoredAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(figures.find((row) => row.figure === 'statutoryScore')).toMatchObject({
        value: 100,
        id: '',
      });

      const clean = `iso/certification/${extra.certificateFile.certificationId}/certificate.pdf`;
      expect(await zip.file(clean)!.async('string')).toBe('the certificate');
      const isoFilesIn = Object.keys(zip.files).filter(
        (n) =>
          n.startsWith('iso/') && !n.endsWith('.xlsx') && !n.endsWith('.csv') && !zip.files[n]!.dir,
      );
      expect(isoFilesIn).toEqual([clean]);
      const readme = await zip.file('README.txt')!.async('string');
      expect(readme).toContain('ISO files included: 1.');
      expect(readme).toContain('Left out: 1 ISO file(s)');
      expect(zip.file('iso/nc-log.xlsx')).not.toBeNull();
      expect(zip.file('iso/risk-register.xlsx')).not.toBeNull();
    });
  }

  it("never reads another firm's ISO records or files", async () => {
    const zip = await archive(b);
    const book = await sheets(zip);
    for (const [name, rows] of book) {
      if (name !== 'Names') expect(rows, name).toEqual([]);
    }
    expect(await zip.file('README.txt')!.async('string')).toContain('ISO files included: 0.');
  });
});
