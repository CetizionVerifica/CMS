import { randomBytes } from 'node:crypto';
import {
  DEFAULT_CLIENT_SETTINGS,
  LocalDate,
  type ComplianceInstance,
  type Role,
} from '@canopy/contracts';
import {
  acts,
  assignments,
  categories,
  clients,
  comments,
  companies,
  createAdminDatabase,
  createDatabase,
  departments,
  instances,
  locations,
  memberships,
  obligations,
  people,
  systemContext,
  units,
  type Database,
  type NewEntity,
  type TenantTx,
} from '@canopy/db';
import pg from 'pg';

/**
 * Postgres test data for M10's adapter: a throwaway database per test file (DATABASE_URL, as in the CI `db`
 * job) with firms written through M3's repositories as the system context. Not used by the server.
 */

export interface TestDb {
  db: Database;
  createFirm(name: string): Promise<string>;
  /** Audit actions per entity id for a firm, read as the database owner (no RLS), for assertions. */
  audit(firmId: string): Promise<Map<string, string>>;
  /** Sets the account's added features as the operator's override would (docs/iso/plan.md §4.1); [] clears them. */
  setFeatures(firmId: string, features: readonly string[]): Promise<void>;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; db tests need Postgres 16.');
  const base = new URL(url);
  const name = `canopy_m10_${randomBytes(6).toString('hex')}`;
  const server = new pg.Client({ connectionString: base.toString() });
  await server.connect();
  await server.query(`CREATE DATABASE ${name}`);
  await server.end();
  const target = new URL(base);
  target.pathname = `/${name}`;
  const admin = createAdminDatabase({ connectionString: target.toString() });
  await admin.migrate();
  const db = createDatabase({ connectionString: target.toString(), max: 4 });
  const owner = new pg.Client({ connectionString: target.toString() });
  await owner.connect();
  return {
    db,
    createFirm: (firmName) => admin.createFirm({ name: firmName }),
    async audit(firmId) {
      const result = await owner.query<{ entity_id: string; action: string }>(
        'SELECT entity_id, action FROM audit_event WHERE firm_id = $1',
        [firmId],
      );
      return new Map(result.rows.map((r) => [r.entity_id, r.action]));
    },
    async setFeatures(firmId, features) {
      await owner.query(
        `INSERT INTO platform.account_override (account_id, features) VALUES ($1, $2)
         ON CONFLICT (account_id) DO UPDATE SET features = EXCLUDED.features`,
        [firmId, [...features]],
      );
    },
    async drop() {
      await owner.end();
      await Promise.all([db.close(), admin.close()]);
      const cleanup = new pg.Client({ connectionString: base.toString() });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

const d = (s: string): LocalDate => LocalDate.parse(s);

/** Days after 2026-04-01 as a date. */
function day(n: number): LocalDate {
  const date = new Date(Date.UTC(2026, 3, 1 + n));
  return d(date.toISOString().slice(0, 10));
}

export interface FirmWorld {
  firmId: string;
  clientId: string;
  /** "Plant": the open instances and one approved. */
  unit1: string;
  /** "Head Office": one submitted and one not applicable. */
  unit2: string;
  people: { firmAdmin: string; owner: string; approver: string; viewer: string };
  /** The memberships each person signs in with (also stored, so RLS sees them). */
  memberships: Record<
    'firmAdmin' | 'owner' | 'approver' | 'viewer',
    { role: Role; clientId?: string; unitIds?: string[] }
  >;
  /** Open instances on unit 1, one per day from 2026-04-01: more than one register page. */
  open: ComplianceInstance[];
  approved: ComplianceInstance;
  submitted: ComplianceInstance;
  notApplicable: ComplianceInstance;
}

export const OPEN_COUNT = 205;

async function person(tx: TenantTx, name: string): Promise<string> {
  const created = await people.create(tx, {
    displayName: name,
    nameNormalized: name.toLowerCase(),
    email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.test`,
    status: 'ACTIVE',
  });
  return created.id;
}

/** Writes one client with two units and `OPEN_COUNT + 3` instances in FY 2026-27 for `firmId`. */
export async function seedFirm(db: Database, firmId: string, label: string): Promise<FirmWorld> {
  return db.withTenant(systemContext(firmId, `m10-${label}`), async (tx) => {
    const location = await locations.create(tx, {
      country: 'India',
      countryCode: 'IN',
      state: 'West Bengal',
      stateCode: 'WB',
      city: 'Riverbend',
    });
    const client = await clients.create(tx, {
      name: `${label} Metals Group`,
      settings: DEFAULT_CLIENT_SETTINGS,
    });
    const company = await companies.create(tx, {
      clientId: client.id,
      name: `${label} Aluminium`,
    });
    const unit = (name: string) =>
      units.create(tx, {
        clientId: client.id,
        companyId: company.id,
        name,
        locationId: location.id,
      });
    const unit1 = await unit('Plant');
    const unit2 = await unit('Head Office');
    const department = await departments.create(tx, {
      clientId: client.id,
      name: 'Safety',
      aliases: [],
    });
    const act = await acts.create(tx, {
      name: `Factories Act, 1948 (${label})`,
      shortName: null,
      jurisdiction: 'CENTRAL',
      stateCode: null,
      aliases: [],
    });
    const category = await categories.create(tx, { name: `Returns ${label}`, aliases: [] });
    const obligation = await obligations.create(tx, {
      externalRef: `HRS-CL-001-0000-${label.slice(0, 5)}`,
      domain: 'HRS',
      jurisdiction: 'CENTRAL',
      stateCode: null,
      actId: act.id,
      categoryId: category.id,
      title: 'Daily safety register',
      description: 'Keep the daily safety register up to date.',
      applicabilityText: 'Factories with 10 or more workers.',
      criticality: 'HIGH',
      timelineType: 'TIME_BASED',
      recurrenceRule: { kind: 'ANNUAL', month: 1, day: 31 },
      ruleStatus: 'CONFIRMED',
      evidenceRequired: false,
      forms: [{ label: 'Form 21', fileName: null, templateFileId: null }],
      logSheets: [],
      libraryVersion: 1,
    });

    const cast = {
      firmAdmin: await person(tx, `${label} Firm Admin`),
      owner: await person(tx, `${label} Owner`),
      approver: await person(tx, `${label} Approver`),
      viewer: await person(tx, `${label} Viewer`),
    };
    const roles: FirmWorld['memberships'] = {
      firmAdmin: { role: 'FIRM_ADMIN' },
      owner: { role: 'OWNER', clientId: client.id, unitIds: [unit1.id] },
      approver: { role: 'APPROVER', clientId: client.id },
      viewer: { role: 'VIEWER', clientId: client.id },
    };
    for (const key of Object.keys(cast) as (keyof typeof cast)[]) {
      const m = roles[key];
      await memberships.create(tx, {
        personId: cast[key],
        role: m.role,
        clientId: m.clientId ?? null,
        consultantClientIds: null,
        unitIds: m.unitIds ?? null,
        expiresAt: m.role === 'VIEWER' ? '2099-01-01T00:00:00Z' : null,
      });
    }

    const assignment = (unitId: string) =>
      assignments.create(tx, {
        clientId: client.id,
        unitId,
        obligationId: obligation.id,
        departmentId: department.id,
        defaultOwnerId: cast.owner,
        defaultApproverId: cast.approver,
        applicability: 'APPLICABLE',
        naReason: null,
        activeFrom: d('2026-04-01'),
        activeTo: null,
      });
    const a1 = await assignment(unit1.id);
    const a2 = await assignment(unit2.id);
    const instance = (
      assignmentId: string,
      unitId: string,
      n: number,
      state: Partial<NewEntity<ComplianceInstance>> = {},
    ) =>
      instances.create(tx, {
        clientId: client.id,
        unitId,
        assignmentId,
        periodStart: day(n),
        periodEnd: day(n),
        dueDate: day(n),
        workflowState: 'OPEN',
        pendingKind: null,
        completedOn: null,
        naReason: null,
        ownerId: cast.owner,
        approverId: cast.approver,
        submittedAt: null,
        approvedAt: null,
        dueDateOverridden: false,
        ...state,
      });

    const open: ComplianceInstance[] = [];
    for (let n = 0; n < OPEN_COUNT; n += 1) open.push(await instance(a1.id, unit1.id, n));
    const approved = await instance(a1.id, unit1.id, 300, {
      workflowState: 'APPROVED',
      completedOn: d('2026-10-01'),
      submittedAt: '2026-10-01T05:00:00Z',
      approvedAt: '2026-10-02T05:00:00Z',
    });
    for (const [body, kind] of [
      ['Challan attached', 'SUBMIT'],
      ['Approved', 'APPROVE'],
    ] as const) {
      await comments.create(tx, {
        instanceId: approved.id,
        clientId: client.id,
        authorId: cast.owner,
        kind,
        body,
      });
    }
    const submitted = await instance(a2.id, unit2.id, 301, {
      workflowState: 'SUBMITTED',
      pendingKind: 'COMPLETION',
      completedOn: d('2026-10-05'),
      submittedAt: '2026-10-05T05:00:00Z',
    });
    const notApplicable = await instance(a2.id, unit2.id, 302, {
      workflowState: 'NOT_APPLICABLE',
      completedOn: d('2026-10-03'),
      naReason: 'No boilers on site.',
      submittedAt: '2026-10-03T05:00:00Z',
      approvedAt: '2026-10-03T06:00:00Z',
    });
    return {
      firmId,
      clientId: client.id,
      unit1: unit1.id,
      unit2: unit2.id,
      people: cast,
      memberships: roles,
      open,
      approved,
      submitted,
      notApplicable,
    };
  });
}

/** ISO activities a world gains: instances under a STANDARD act, written as the catalogue copy would. */
export interface IsoActivities {
  /** One per day from 2026-04-01, unit 1, OPEN: due in the past, within the week and later. */
  open: ComplianceInstance[];
  approved: ComplianceInstance;
}

/**
 * Adds one STANDARD act (an ISO standard, as the system job copies it) with one obligation assigned to unit 1, and
 * ISO activity instances on the same days as some of the world's laws: they must never move a statutory number.
 */
export async function seedIsoActivities(db: Database, world: FirmWorld): Promise<IsoActivities> {
  return db.withTenant(systemContext(world.firmId, 'm10-iso'), async (tx) => {
    const act = await acts.create(tx, {
      name: 'Environmental management systems',
      shortName: 'ISO',
      jurisdiction: 'CENTRAL',
      stateCode: null,
      aliases: [],
      kind: 'STANDARD',
    });
    const category = await categories.create(tx, { name: 'ISO activities', aliases: [] });
    const department = await departments.create(tx, {
      clientId: world.clientId,
      name: 'Quality',
      aliases: [],
    });
    const obligation = await obligations.create(tx, {
      externalRef: `ISO-ACT-0001-${world.firmId.slice(0, 5)}`,
      domain: 'EHS',
      jurisdiction: 'CENTRAL',
      stateCode: null,
      actId: act.id,
      categoryId: category.id,
      title: 'Internal audit of the management system',
      description: 'Plan and hold the internal audit.',
      applicabilityText: null,
      criticality: 'CRITICAL',
      timelineType: 'TIME_BASED',
      recurrenceRule: { kind: 'ANNUAL', month: 1, day: 31 },
      ruleStatus: 'CONFIRMED',
      evidenceRequired: false,
      forms: [],
      logSheets: [],
      libraryVersion: 1,
    });
    const assignment = await assignments.create(tx, {
      clientId: world.clientId,
      unitId: world.unit1,
      obligationId: obligation.id,
      departmentId: department.id,
      defaultOwnerId: world.people.owner,
      defaultApproverId: world.people.approver,
      applicability: 'APPLICABLE',
      naReason: null,
      activeFrom: d('2026-04-01'),
      activeTo: null,
    });
    const instance = (n: number, state: Partial<NewEntity<ComplianceInstance>> = {}) =>
      instances.create(tx, {
        clientId: world.clientId,
        unitId: world.unit1,
        assignmentId: assignment.id,
        periodStart: day(n),
        periodEnd: day(n),
        dueDate: day(n),
        workflowState: 'OPEN',
        pendingKind: null,
        completedOn: null,
        naReason: null,
        ownerId: world.people.owner,
        approverId: world.people.approver,
        submittedAt: null,
        approvedAt: null,
        dueDateOverridden: false,
        ...state,
      });
    // 2026-04-01 (overdue at 2026-10-12), 2026-10-14 (due this week) and 2027-01-31 (upcoming).
    const open = [await instance(0), await instance(196), await instance(305)];
    const approved = await instance(150, {
      workflowState: 'APPROVED',
      completedOn: d('2026-08-20'),
      submittedAt: '2026-08-20T05:00:00Z',
      approvedAt: '2026-08-21T05:00:00Z',
    });
    return { open, approved };
  });
}
