import { randomBytes } from 'node:crypto';
import {
  DEFAULT_CLIENT_SETTINGS,
  LocalDate,
  type ComplianceInstance,
  type Role,
  type WorkflowState,
} from '@canopy/contracts';
import {
  acts,
  assignments,
  categories,
  clients,
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
 * Postgres fixtures for M7's db tests: a throwaway database per test file (DATABASE_URL, as in the CI `db`
 * job) and one firm with one client, written through M3's repositories as the system context.
 */

export interface TestDb {
  db: Database;
  /** Creates a firm as the owner (firms are not tenant work) and returns its id. */
  createFirm(name: string): Promise<string>;
  /** Ids and types of a firm's audit and outbox rows, read as the database owner (no RLS), for assertions. */
  written(firmId: string): Promise<{ audit: Map<string, string>; outbox: Map<string, string> }>;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; db tests need Postgres 16.');
  const base = new URL(url);
  const name = `canopy_api_${randomBytes(6).toString('hex')}`;
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
  const rows = async (sql: string, firmId: string) => {
    const result = await owner.query<{ id: string; kind: string }>(sql, [firmId]);
    return new Map(result.rows.map((r) => [r.id, r.kind]));
  };
  return {
    db,
    createFirm: (firmName) => admin.createFirm({ name: firmName }),
    async written(firmId) {
      return {
        audit: await rows('SELECT id, action AS kind FROM audit_event WHERE firm_id = $1', firmId),
        outbox: await rows('SELECT id, type AS kind FROM domain_event WHERE firm_id = $1', firmId),
      };
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

export const d = (s: string): LocalDate => LocalDate.parse(s);

/** People of the fixture firm, by the role they hold. */
export interface Cast {
  firmAdmin: string;
  consultant: string;
  clientAdmin: string;
  approver: string;
  /** OWNER of unit A only. */
  owner: string;
  /** OWNER of unit B only. */
  otherOwner: string;
  viewer: string;
}

export interface Fixture {
  firmId: string;
  clientId: string;
  unitA: string;
  unitB: string;
  departmentId: string;
  actId: string;
  categoryId: string;
  /** No evidence needed. */
  plainAssignment: string;
  /** Evidence required, on unit A. */
  evidenceAssignment: string;
  /** Plain obligation on unit B. */
  unitBAssignment: string;
  people: Cast;
  /** The memberships to sign each person in with. */
  memberships: Record<
    keyof Cast,
    {
      role: Role;
      clientId?: string | null;
      consultantClientIds?: string[] | null;
      unitIds?: string[] | null;
    }[]
  >;
}

async function person(tx: TenantTx, name: string): Promise<string> {
  const created = await people.create(tx, {
    displayName: name,
    nameNormalized: name.toLowerCase(),
    email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.test`,
    status: 'ACTIVE',
  });
  return created.id;
}

/** Writes the fixture firm. `firmId` comes from `AdminDatabase.createFirm`. */
export async function seedFixture(db: Database, firmId: string, label: string): Promise<Fixture> {
  return db.withTenant(systemContext(firmId, `fixture-${label}`), async (tx) => {
    const location = await locations.create(tx, {
      country: 'India',
      countryCode: 'IN',
      state: 'West Bengal',
      stateCode: 'WB',
      city: 'Belur',
    });
    const client = await clients.create(tx, {
      name: `${label} group`,
      settings: DEFAULT_CLIENT_SETTINGS,
    });
    const company = await companies.create(tx, { clientId: client.id, name: 'Hindalco' });
    const unitA = await units.create(tx, {
      clientId: client.id,
      companyId: company.id,
      name: 'Plant A',
      locationId: location.id,
    });
    const unitB = await units.create(tx, {
      clientId: client.id,
      companyId: company.id,
      name: 'Plant B',
      locationId: location.id,
    });
    const department = await departments.create(tx, {
      clientId: client.id,
      name: 'Human Resources',
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
    const obligation = (title: string, evidenceRequired: boolean) =>
      obligations.create(tx, {
        externalRef: null,
        domain: 'HRS',
        jurisdiction: 'CENTRAL',
        stateCode: null,
        actId: act.id,
        categoryId: category.id,
        title,
        description: `${title}: file it.`,
        applicabilityText: null,
        criticality: 'HIGH',
        timelineType: 'TIME_BASED',
        recurrenceRule: { kind: 'ANNUAL', month: 1, day: 31 },
        ruleStatus: 'CONFIRMED',
        evidenceRequired,
        forms: [{ label: 'Form 21', fileName: null, templateFileId: null }],
        logSheets: [],
        libraryVersion: 1,
      });
    const plain = await obligation('Annual return', false);
    const withEvidence = await obligation('Boiler inspection', true);

    const cast: Cast = {
      firmAdmin: await person(tx, `${label} Firm Admin`),
      consultant: await person(tx, `${label} Consultant`),
      clientAdmin: await person(tx, `${label} Client Admin`),
      approver: await person(tx, `${label} Approver`),
      owner: await person(tx, `${label} Owner`),
      otherOwner: await person(tx, `${label} Other Owner`),
      viewer: await person(tx, `${label} Viewer`),
    };
    const roles: Fixture['memberships'] = {
      firmAdmin: [{ role: 'FIRM_ADMIN', clientId: null }],
      consultant: [{ role: 'CONSULTANT', clientId: null, consultantClientIds: [client.id] }],
      clientAdmin: [{ role: 'CLIENT_ADMIN', clientId: client.id }],
      approver: [{ role: 'APPROVER', clientId: client.id, unitIds: null }],
      owner: [{ role: 'OWNER', clientId: client.id, unitIds: [unitA.id] }],
      otherOwner: [{ role: 'OWNER', clientId: client.id, unitIds: [unitB.id] }],
      viewer: [{ role: 'VIEWER', clientId: client.id }],
    };
    for (const key of Object.keys(cast) as (keyof Cast)[]) {
      for (const m of roles[key]) {
        await memberships.create(tx, {
          personId: cast[key],
          role: m.role,
          clientId: m.clientId ?? null,
          consultantClientIds: m.consultantClientIds ?? null,
          unitIds: m.unitIds ?? null,
          expiresAt: m.role === 'VIEWER' ? '2099-01-01T00:00:00Z' : null,
        });
      }
    }

    const assignment = (unitId: string, obligationId: string, owner: string) =>
      assignments.create(tx, {
        clientId: client.id,
        unitId,
        obligationId,
        departmentId: department.id,
        defaultOwnerId: owner,
        defaultApproverId: cast.approver,
        applicability: 'APPLICABLE',
        naReason: null,
        activeFrom: d('2022-04-01'),
        activeTo: null,
      });
    const plainAssignment = await assignment(unitA.id, plain.id, cast.owner);
    const evidenceAssignment = await assignment(unitA.id, withEvidence.id, cast.owner);
    const unitBAssignment = await assignment(unitB.id, plain.id, cast.otherOwner);

    return {
      firmId,
      clientId: client.id,
      unitA: unitA.id,
      unitB: unitB.id,
      departmentId: department.id,
      actId: act.id,
      categoryId: category.id,
      plainAssignment: plainAssignment.id,
      evidenceAssignment: evidenceAssignment.id,
      unitBAssignment: unitBAssignment.id,
      people: cast,
      memberships: roles,
    };
  });
}

/** Workflow fields for a valid instance in each state. */
const STATE: Record<WorkflowState, Partial<NewEntity<ComplianceInstance>>> = {
  OPEN: {},
  SENT_BACK: { workflowState: 'SENT_BACK', submittedAt: '2023-01-10T05:00:00Z' },
  SUBMITTED: {
    workflowState: 'SUBMITTED',
    pendingKind: 'COMPLETION',
    completedOn: d('2023-01-09'),
    submittedAt: '2023-01-10T05:00:00Z',
  },
  APPROVED: {
    workflowState: 'APPROVED',
    completedOn: d('2023-01-09'),
    submittedAt: '2023-01-10T05:00:00Z',
    approvedAt: '2023-01-11T05:00:00Z',
  },
  NOT_APPLICABLE: {
    workflowState: 'NOT_APPLICABLE',
    completedOn: d('2023-01-11'),
    naReason: 'No boilers on site.',
    submittedAt: '2023-01-10T05:00:00Z',
    approvedAt: '2023-01-11T05:00:00Z',
  },
};

/** Adds one instance to an assignment of the fixture. */
export async function addInstance(
  db: Database,
  f: Fixture,
  input: {
    assignment?: 'plain' | 'evidence' | 'unitB';
    periodStart: string;
    dueDate: string;
    state?: WorkflowState;
  },
): Promise<ComplianceInstance> {
  const which = input.assignment ?? 'plain';
  const assignmentId =
    which === 'plain'
      ? f.plainAssignment
      : which === 'evidence'
        ? f.evidenceAssignment
        : f.unitBAssignment;
  const unitId = which === 'unitB' ? f.unitB : f.unitA;
  const ownerId = which === 'unitB' ? f.people.otherOwner : f.people.owner;
  return db.withTenant(systemContext(f.firmId, 'fixture-instance'), (tx) =>
    instances.create(tx, {
      clientId: f.clientId,
      unitId,
      assignmentId,
      periodStart: d(input.periodStart),
      periodEnd: d(input.periodStart),
      dueDate: d(input.dueDate),
      workflowState: 'OPEN',
      pendingKind: null,
      completedOn: null,
      naReason: null,
      ownerId,
      approverId: f.people.approver,
      submittedAt: null,
      approvedAt: null,
      dueDateOverridden: false,
      ...STATE[input.state ?? 'OPEN'],
    }),
  );
}
