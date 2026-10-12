import { DEFAULT_CLIENT_SETTINGS } from '@canopy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '../src/database.js';
import * as r from '../src/repositories/index.js';
import { systemContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/** The scheduled jobs' read models (M9 ports), against Postgres, with explicit dates. */

let t: TestDatabase;
let firmA: string;
let firmB: string;

interface World {
  clientId: string;
  otherClientId: string;
  unitId: string;
  ownerId: string;
  approverId: string;
  consultantId: string;
  obligationId: string;
  applicableId: string;
  notApplicableId: string;
  archivedAssignmentId: string;
}
let w: World;

const inA = <T>(fn: (tx: TenantTx) => Promise<T>) =>
  t.db.withTenant(systemContext(firmA, 'jobs-test'), fn);

function instance(assignmentId: string, month: string, state: string, extra: object = {}) {
  return {
    clientId: w.clientId,
    unitId: w.unitId,
    assignmentId,
    periodStart: `2026-${month}-01`,
    periodEnd: `2026-${month}-28`,
    dueDate: `2026-${month}-07`,
    workflowState: state,
    pendingKind: state === 'SUBMITTED' ? 'COMPLETION' : null,
    completedOn: state === 'APPROVED' || state === 'SUBMITTED' ? `2026-${month}-05` : null,
    naReason: null,
    ownerId: w.ownerId,
    approverId: w.approverId,
    submittedAt: null,
    approvedAt: null,
    dueDateOverridden: false,
    ...extra,
  } as unknown as Parameters<typeof r.instances.create>[1];
}

beforeAll(async () => {
  t = await createTestDatabase();
  firmA = await t.admin.createFirm({ name: 'Demo Advisory' });
  firmB = await t.admin.createFirm({ name: 'Second Ledger Consulting' });
  w = await inA(async (tx) => {
    const client = await r.clients.create(tx, {
      name: 'Kestrel Metals Group',
      settings: DEFAULT_CLIENT_SETTINGS,
    });
    const other = await r.clients.create(tx, {
      name: 'Osprey Textiles Group',
      settings: DEFAULT_CLIENT_SETTINGS,
    });
    const archived = await r.clients.create(tx, {
      name: 'Closed Group',
      settings: DEFAULT_CLIENT_SETTINGS,
    });
    await r.clients.archive(tx, archived.id, archived.version);
    const company = await r.companies.create(tx, {
      clientId: client.id,
      name: 'Kestrel Aluminium',
    });
    const location = await r.locations.create(tx, {
      country: 'India',
      countryCode: 'IN',
      state: 'West Bengal',
      stateCode: 'WB',
      city: 'Belur',
    });
    const unit = await r.units.create(tx, {
      clientId: client.id,
      companyId: company.id,
      name: 'Belur Plant',
      locationId: location.id,
    });
    const department = await r.departments.create(tx, {
      clientId: client.id,
      name: 'Finance',
      aliases: [],
    });
    const owner = await r.people.create(tx, {
      displayName: 'Owner 01',
      nameNormalized: 'owner 01',
      email: 'owner01@example.com',
      status: 'ACTIVE',
    });
    const approver = await r.people.create(tx, {
      displayName: 'Approver 01',
      nameNormalized: 'approver 01',
      email: null,
      status: 'UNCLAIMED',
    });
    const consultant = await r.people.create(tx, {
      displayName: 'Consultant 01',
      nameNormalized: 'consultant 01',
      email: 'consultant01@example.com',
      status: 'ACTIVE',
    });
    const membership = (
      personId: string,
      role: 'OWNER' | 'APPROVER',
      expiresAt: string | null = null,
    ) =>
      r.memberships.create(tx, {
        personId,
        role,
        clientId: client.id,
        consultantClientIds: null,
        unitIds: [unit.id],
        expiresAt,
      });
    await membership(owner.id, 'OWNER');
    await membership(approver.id, 'APPROVER');
    await r.memberships.create(tx, {
      personId: consultant.id,
      role: 'CONSULTANT',
      clientId: null,
      consultantClientIds: [client.id, other.id],
      unitIds: null,
      expiresAt: null,
    });
    const act = await r.acts.create(tx, {
      name: 'Income Tax Act, 1961',
      shortName: null,
      jurisdiction: 'CENTRAL',
      stateCode: null,
      aliases: [],
    });
    const category = await r.categories.create(tx, { name: 'Payments', aliases: [] });
    const obligation = await r.obligations.create(tx, {
      externalRef: 'TAX-CL-033-6067-60218',
      domain: 'TAX',
      jurisdiction: 'CENTRAL',
      stateCode: null,
      actId: act.id,
      categoryId: category.id,
      title: 'Deposit TDS',
      description: 'Deposit tax deducted at source by the 7th.',
      applicabilityText: null,
      criticality: 'HIGH',
      timelineType: 'TIME_BASED',
      recurrenceRule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
      ruleStatus: 'CONFIRMED',
      evidenceRequired: false,
      forms: [],
      logSheets: [],
      libraryVersion: 1,
    });
    const payroll = await r.departments.create(tx, {
      clientId: client.id,
      name: 'Payroll',
      aliases: [],
    });
    const assignment = (
      applicability: 'APPLICABLE' | 'NOT_APPLICABLE',
      departmentId = department.id,
    ) =>
      r.assignments.create(tx, {
        clientId: client.id,
        unitId: unit.id,
        obligationId: obligation.id,
        departmentId,
        defaultOwnerId: owner.id,
        defaultApproverId: approver.id,
        applicability,
        naReason: applicability === 'NOT_APPLICABLE' ? 'No employees' : null,
        activeFrom: '2026-04-01' as never,
        activeTo: null,
      });
    const gone = await assignment('APPLICABLE');
    await r.assignments.archive(tx, gone.id, gone.version);
    const applicable = await assignment('APPLICABLE');
    const notApplicable = await assignment('NOT_APPLICABLE', payroll.id);
    return {
      clientId: client.id,
      otherClientId: other.id,
      unitId: unit.id,
      ownerId: owner.id,
      approverId: approver.id,
      consultantId: consultant.id,
      obligationId: obligation.id,
      applicableId: applicable.id,
      notApplicableId: notApplicable.id,
      archivedAssignmentId: gone.id,
    };
  });
  await inA(async (tx) => {
    await r.instances.create(tx, instance(w.applicableId, '05', 'OPEN'));
    await r.instances.create(tx, instance(w.applicableId, '06', 'SUBMITTED'));
    await r.instances.create(tx, instance(w.applicableId, '07', 'APPROVED'));
    await r.instances.create(tx, instance(w.applicableId, '08', 'SENT_BACK'));
    await r.instances.create(tx, instance(w.notApplicableId, '05', 'OPEN'));
    const old = await r.instances.create(tx, instance(w.applicableId, '09', 'OPEN'));
    await r.instances.archive(tx, old.id, old.version);
  });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

const MAY_TO_AUG = { from: '2026-05-01', to: '2026-08-31' };

describe('firms', () => {
  it('lists every firm id, and only ids, through the app role', async () => {
    expect((await t.db.listFirmIds()).sort()).toEqual([firmA, firmB].sort());
  });
});

describe('generation', () => {
  it('lists non-archived clients with settings', async () => {
    const clients = await inA((tx) => r.jobs.listClients(tx));
    expect(clients.map((c) => c.name).sort()).toEqual([
      'Kestrel Metals Group',
      'Osprey Textiles Group',
    ]);
    expect(clients[0]!.settings).toEqual(DEFAULT_CLIENT_SETTINGS);
  });

  it('lists non-archived assignments with the obligation rule', async () => {
    const targets = await inA((tx) => r.jobs.listGenerationTargets(tx, w.clientId));
    expect(targets.map((x) => x.assignmentId).sort()).toEqual(
      [w.applicableId, w.notApplicableId].sort(),
    );
    expect(targets.find((x) => x.assignmentId === w.applicableId)).toEqual({
      assignmentId: w.applicableId,
      assignmentVersion: 1,
      clientId: w.clientId,
      applicability: 'APPLICABLE',
      activeFrom: '2026-04-01',
      activeTo: null,
      ownerId: w.ownerId,
      approverId: w.approverId,
      obligationId: w.obligationId,
      recurrenceRule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
      ruleStatus: 'CONFIRMED',
    });
    expect(await inA((tx) => r.jobs.listGenerationTargets(tx, w.otherClientId))).toEqual([]);
  });

  it('lists instance keys by assignment and due-date range, archived ones included', async () => {
    const keys = await inA((tx) =>
      r.jobs.listInstanceKeys(tx, [w.applicableId], { from: '2026-06-01', to: '2026-09-30' }),
    );
    expect(keys).toEqual([
      { assignmentId: w.applicableId, periodStart: '2026-06-01', dueDate: '2026-06-07' },
      { assignmentId: w.applicableId, periodStart: '2026-07-01', dueDate: '2026-07-07' },
      { assignmentId: w.applicableId, periodStart: '2026-08-01', dueDate: '2026-08-07' },
      { assignmentId: w.applicableId, periodStart: '2026-09-01', dueDate: '2026-09-07' },
    ]);
    expect(await inA((tx) => r.jobs.listInstanceKeys(tx, [], MAY_TO_AUG))).toEqual([]);
  });

  it('inserts generated instances idempotently, returning new ids in input order', async () => {
    const row = (month: string) => ({
      assignmentId: w.applicableId,
      clientId: w.clientId,
      periodStart: `2026-${month}-01`,
      periodEnd: `2026-${month}-30`,
      dueDate: `2026-${month}-07`,
      ownerId: w.ownerId,
      approverId: w.approverId,
    });
    const first = await inA((tx) => r.jobs.insertInstances(tx, [row('10'), row('05'), row('11')]));
    expect(first[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(first[1]).toBeNull(); // May already exists
    expect(first[2]).toMatch(/^[0-9a-f-]{36}$/);
    const again = await inA((tx) => r.jobs.insertInstances(tx, [row('10'), row('11')]));
    expect(again).toEqual([null, null]);
    const created = await inA((tx) => r.instances.require(tx, first[0]!));
    expect(created).toMatchObject({
      unitId: w.unitId,
      workflowState: 'OPEN',
      dueDate: '2026-10-07',
    });
    expect(await inA((tx) => r.jobs.insertInstances(tx, []))).toEqual([]);
  });
});

describe('reminders and scores', () => {
  it('lists open, sent-back and submitted instances of applicable assignments in the range', async () => {
    const candidates = await inA((tx) => r.jobs.listReminderCandidates(tx, w.clientId, MAY_TO_AUG));
    expect(candidates.map((c) => [c.dueDate, c.workflowState])).toEqual([
      ['2026-05-07', 'OPEN'],
      ['2026-06-07', 'SUBMITTED'],
      ['2026-08-07', 'SENT_BACK'],
    ]);
    expect(candidates[1]).toMatchObject({
      clientId: w.clientId,
      ownerId: w.ownerId,
      approverId: w.approverId,
      pendingKind: 'COMPLETION',
      completedOn: '2026-06-05',
      title: 'Deposit TDS',
      actName: 'Income Tax Act, 1961',
      unitName: 'Belur Plant',
      departmentName: 'Finance',
      criticality: 'HIGH',
    });
  });

  it('lists score items for non-archived instances in the range', async () => {
    const items = await inA((tx) => r.jobs.listScoreItems(tx, w.clientId, MAY_TO_AUG));
    // Four applicable months plus the not-applicable assignment's May instance.
    expect(items).toHaveLength(5);
    expect(items.find((i) => i.workflowState === 'APPROVED')).toMatchObject({
      criticality: 'HIGH',
      dueDate: '2026-07-07',
      completedOn: '2026-07-05',
      pendingKind: null,
    });
  });

  it('reports which recipients can receive mail about a client', async () => {
    const people = await inA((tx) =>
      r.jobs.recipients(tx, [w.ownerId, w.approverId, w.consultantId], w.clientId),
    );
    const byId = new Map(people.map((p) => [p.personId, p]));
    expect(byId.get(w.ownerId)).toEqual({
      personId: w.ownerId,
      displayName: 'Owner 01',
      email: 'owner01@example.com',
      canReceive: true,
    });
    // UNCLAIMED, and a consultant has no membership of the client itself.
    expect(byId.get(w.approverId)!.canReceive).toBe(false);
    expect(byId.get(w.consultantId)!.canReceive).toBe(false);
    // No membership of that client at all.
    expect(
      (await inA((tx) => r.jobs.recipients(tx, [w.ownerId], w.otherClientId)))[0]!.canReceive,
    ).toBe(false);
    expect(await inA((tx) => r.jobs.recipients(tx, [], w.clientId))).toEqual([]);
  });

  it('stops counting an expired membership', async () => {
    const expired = await inA(async (tx) => {
      const p = await r.people.create(tx, {
        displayName: 'Former Owner',
        nameNormalized: 'former owner',
        email: 'former@example.com',
        status: 'ACTIVE',
      });
      await r.memberships.create(tx, {
        personId: p.id,
        role: 'VIEWER',
        clientId: w.clientId,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: '2020-01-01T00:00:00.000Z',
      });
      return p.id;
    });
    expect((await inA((tx) => r.jobs.recipients(tx, [expired], w.clientId)))[0]!.canReceive).toBe(
      false,
    );
  });

  it('lists consultants with their clients', async () => {
    expect(await inA((tx) => r.jobs.listConsultants(tx))).toEqual([
      {
        personId: w.consultantId,
        displayName: 'Consultant 01',
        email: 'consultant01@example.com',
        canReceive: true,
        clientIds: [w.clientId, w.otherClientId],
      },
    ]);
  });

  it('sees nothing of another firm', async () => {
    await t.db.withTenant(systemContext(firmB, 'jobs-test'), async (tx) => {
      expect(await r.jobs.listClients(tx)).toEqual([]);
      expect(await r.jobs.listGenerationTargets(tx, w.clientId)).toEqual([]);
      expect(await r.jobs.listReminderCandidates(tx, w.clientId, MAY_TO_AUG)).toEqual([]);
      expect(await r.jobs.listScoreItems(tx, w.clientId, MAY_TO_AUG)).toEqual([]);
      expect(await r.jobs.recipients(tx, [w.ownerId], w.clientId)).toEqual([]);
      expect(await r.jobs.listConsultants(tx)).toEqual([]);
    });
  });
});
