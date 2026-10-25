import {
  DEFAULT_CLIENT_SETTINGS,
  LocalDate,
  type Incident,
  type InternalAudit,
  type IsoAction,
  type ManagementReview,
  type Nonconformity,
  type Objective,
  type RiskItem,
} from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '../src/database.js';
import { DbError } from '../src/errors.js';
import * as r from '../src/repositories/index.js';
import type { NewEntity } from '../src/repositories/crud.js';
import { systemContext, type TenantContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/**
 * The ISO add-on's tables, part 2 (migration 0041, ISO-2e): the record checks (the `num_nonnulls` rules of findings
 * and actions among them), composite keys inside one client, the per-client NC numbers, join-table lists, unit scope
 * on every list, and the repositories. Table-by-table isolation and the purge list are in isolation.db.test.ts and
 * purge.db.test.ts; part 1 is iso.db.test.ts.
 */

let t: TestDatabase;
let firmId: string;

interface World {
  kestrel: string;
  osprey: string;
  riverbend: string;
  stonebridge: string;
  ospreyUnit: string;
  ownerId: string;
  approverId: string;
  otherId: string;
  adminId: string;
  iso9001: string;
  iso14001: string;
  clause41: string;
  /** Kestrel systems: one on Riverbend, one on Stonebridge. Osprey: one with no units. */
  riverbendSystem: string;
  stonebridgeSystem: string;
  ospreySystem: string;
  documentId: string;
  externalAuditId: string;
  kestrelInstance: string;
  ospreyInstance: string;
}
let w: World;

const firmAdmin = (): TenantContext => ({
  firmId,
  personId: w.adminId,
  clientIds: 'ALL',
  requestId: 'iso2-test',
});
const ospreyUser = (): TenantContext => ({
  firmId,
  personId: w.ownerId,
  clientIds: [w.osprey],
  requestId: 'iso2-test',
});
const asAdmin = <T>(fn: (tx: TenantTx) => Promise<T>) => t.db.withTenant(firmAdmin(), fn);

function sqlState(error: unknown): string | undefined {
  let e: unknown = error;
  while (e && typeof e === 'object') {
    if ('code' in e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    e = 'cause' in e ? e.cause : undefined;
  }
  return undefined;
}
/** The DbError code, or the SQLSTATE of a raw statement; 'resolved' when it did not fail. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof DbError) return e.code;
    return sqlState(e) ?? String(e);
  }
  return 'resolved';
}

const day = (value: string) => LocalDate.parse(value);
const SHA = 'c'.repeat(64);

function newRisk(overrides: Partial<NewEntity<RiskItem>> = {}): NewEntity<RiskItem> {
  return {
    clientId: w.kestrel,
    managementSystemId: w.riverbendSystem,
    kind: 'RISK',
    unitId: null,
    activity: 'Casting',
    description: 'A late alloy delivery stops the line',
    impact: null,
    lifeCycleStages: [],
    controlType: null,
    routine: null,
    personsExposed: [],
    condition: null,
    assessedWith: null,
    likelihood: 3,
    severity: 4,
    residualLikelihood: null,
    residualSeverity: null,
    rating: 12,
    residualRating: null,
    significant: true,
    significantOverride: null,
    significanceReason: null,
    obligationIds: [],
    climateRelated: false,
    ownerId: w.ownerId,
    reviewDueOn: null,
    lastReviewedOn: null,
    ...overrides,
  };
}

function newObjective(overrides: Partial<NewEntity<Objective>> = {}): NewEntity<Objective> {
  return {
    clientId: w.kestrel,
    managementSystemId: w.riverbendSystem,
    standards: ['ISO_9001'],
    text: 'Cut customer complaints',
    target: 10,
    unitOfMeasure: 'complaints a year',
    baseline: 24.5,
    direction: 'DECREASE',
    readingRule: { kind: 'MONTHLY', day: 5, offsetMonths: 1 },
    riskItemIds: [],
    ownerId: w.ownerId,
    dueOn: day('2027-03-31'),
    closedOn: null,
    outcome: null,
    ...overrides,
  };
}

function newAudit(
  programmeId: string,
  overrides: Partial<NewEntity<InternalAudit>> = {},
): NewEntity<InternalAudit> {
  return {
    clientId: w.kestrel,
    programmeId,
    title: 'Production audit',
    plannedStart: day('2026-12-01'),
    plannedEnd: day('2026-12-02'),
    clauseIds: [w.clause41],
    unitIds: [],
    leadAuditorId: w.approverId,
    auditorIds: [],
    auditeeIds: [],
    reportedToIds: [],
    independenceNote: null,
    state: 'PLANNED',
    summary: null,
    reportedOn: null,
    cancelReason: null,
    ...overrides,
  };
}

function newNc(
  overrides: Partial<Omit<NewEntity<Nonconformity>, 'number'>> = {},
): Omit<NewEntity<Nonconformity>, 'number'> {
  return {
    clientId: w.kestrel,
    managementSystemId: w.riverbendSystem,
    source: 'PROCESS',
    sourceInstanceId: null,
    raisedFromRiskItemId: null,
    severity: 'MINOR',
    standards: ['ISO_9001'],
    clauseIds: [],
    unitId: null,
    description: 'Calibration record missing',
    reportedById: w.approverId,
    reportedOn: day('2026-12-02'),
    containment: null,
    correction: null,
    disposition: null,
    dispositionAuthorisedById: null,
    rootCauseMethod: null,
    rootCause: null,
    similarOccurrences: null,
    relatedRiskItemIds: [],
    updatedRiskItemIds: [],
    riskReview: null,
    systemChange: null,
    changedDocumentIds: [],
    noActionReason: null,
    ownerId: w.ownerId,
    approverId: w.approverId,
    dueOn: day('2027-01-15'),
    effectivenessDueOn: null,
    effectivenessNote: null,
    effective: null,
    closedOn: null,
    cancelReason: null,
    state: 'OPEN',
    incident: null,
    ...overrides,
  };
}

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    occurredAt: '2026-11-20T09:30:00.000Z',
    location: 'Casthouse bay 2',
    type: 'INJURY',
    outcome: 'LOST_TIME',
    personCategory: 'CONTRACT_WORKER',
    lostDays: 3,
    reportable: true,
    statutoryInstanceId: null,
    investigatorIds: [],
    workerParticipation: true,
    ...overrides,
  };
}

function newAction(
  subject: IsoAction['subject'],
  overrides: Partial<NewEntity<IsoAction>> = {},
): NewEntity<IsoAction> {
  return {
    clientId: w.kestrel,
    subject,
    text: 'Qualify a second alloy supplier',
    resources: null,
    ownerId: w.ownerId,
    dueOn: day('2027-02-01'),
    doneOn: null,
    state: 'OPEN',
    effectivenessNote: null,
    cancelReason: null,
    controlHierarchy: null,
    outputKey: null,
    ...overrides,
  };
}

function newReview(
  overrides: Partial<NewEntity<ManagementReview>> = {},
): NewEntity<ManagementReview> {
  return {
    clientId: w.kestrel,
    managementSystemId: w.riverbendSystem,
    standards: ['ISO_9001', 'ISO_14001'],
    plannedOn: day('2027-03-15'),
    heldOn: null,
    chairId: w.approverId,
    attendeeIds: [],
    minutes: null,
    state: 'PLANNED',
    cancelReason: null,
    ...overrides,
  };
}

const scoped = (unitIds: string[], personId: string | null = null) => ({ unitIds, personId });

beforeAll(async () => {
  t = await createTestDatabase();
  firmId = await t.admin.createFirm({ name: 'Demo Advisory' });
  w = await t.db.withTenant(systemContext(firmId, 'iso2-test'), async (tx) => {
    const location = await r.locations.create(tx, {
      country: 'India',
      countryCode: 'IN',
      state: 'West Bengal',
      stateCode: 'WB',
      city: 'Riverbend',
    });
    const person = (name: string) =>
      r.people.create(tx, {
        displayName: name,
        nameNormalized: name.toLowerCase(),
        email: null,
        status: 'UNCLAIMED',
      });
    const [owner, approver, other, admin] = [
      await person('Owner One'),
      await person('Approver One'),
      await person('Other One'),
      await person('Admin One'),
    ];
    const act = await r.acts.create(tx, {
      name: 'Factories Act, 1948',
      shortName: null,
      jurisdiction: 'CENTRAL',
      stateCode: null,
      aliases: [],
    });
    const category = await r.categories.create(tx, { name: 'Safety', aliases: [] });
    const obligation = await r.obligations.create(tx, {
      externalRef: null,
      domain: 'EHS',
      jurisdiction: 'CENTRAL',
      stateCode: null,
      actId: act.id,
      categoryId: category.id,
      title: 'Report an accident',
      description: 'Send the accident notice.',
      applicabilityText: null,
      criticality: 'HIGH',
      timelineType: 'TIME_BASED',
      recurrenceRule: { kind: 'ONE_TIME', dueDate: day('2026-12-31') },
      ruleStatus: 'CONFIRMED',
      evidenceRequired: false,
      forms: [],
      logSheets: [],
      libraryVersion: 1,
    });
    const clientWithUnits = async (name: string, units: string[]) => {
      const client = await r.clients.create(tx, { name, settings: DEFAULT_CLIENT_SETTINGS });
      const company = await r.companies.create(tx, { clientId: client.id, name: `${name} Ltd` });
      const ids: string[] = [];
      for (const unit of units) {
        ids.push(
          (
            await r.units.create(tx, {
              clientId: client.id,
              companyId: company.id,
              name: unit,
              locationId: location.id,
            })
          ).id,
        );
      }
      const department = await r.departments.create(tx, {
        clientId: client.id,
        name: 'Safety',
        aliases: [],
      });
      const assignment = await r.assignments.create(tx, {
        clientId: client.id,
        unitId: ids[0]!,
        obligationId: obligation.id,
        departmentId: department.id,
        defaultOwnerId: owner.id,
        defaultApproverId: approver.id,
        applicability: 'APPLICABLE',
        naReason: null,
        activeFrom: day('2026-04-01'),
        activeTo: null,
      });
      const instance = await r.instances.create(tx, {
        clientId: client.id,
        unitId: ids[0]!,
        assignmentId: assignment.id,
        periodStart: '2026-11-20',
        periodEnd: '2026-11-20',
        dueDate: '2026-11-27',
        workflowState: 'OPEN',
        pendingKind: null,
        completedOn: null,
        naReason: null,
        ownerId: owner.id,
        approverId: approver.id,
        submittedAt: null,
        approvedAt: null,
        dueDateOverridden: false,
      } as unknown as Parameters<typeof r.instances.create>[1]);
      return { clientId: client.id, unitIds: ids, instanceId: instance.id };
    };
    const kestrel = await clientWithUnits('Kestrel Metals Group', ['Riverbend', 'Stonebridge']);
    const osprey = await clientWithUnits('Osprey Textiles Group', ['Highmoor']);

    const standard = (code: 'ISO_9001' | 'ISO_14001', topic: string) =>
      r.isoCatalogue.createStandard(tx, { code, edition: '2015+A1:2024', title: code, topic });
    const iso9001 = await standard('ISO_9001', 'Quality management');
    const iso14001 = await standard('ISO_14001', 'Environmental management');
    const [clause41] = await r.isoCatalogue.createClauses(tx, [
      {
        standardId: iso9001.id,
        number: '4.1',
        title: 'Clause 4.1',
        summary: 'Our own summary.',
        parentId: null,
        hlsKey: '4.1',
        assessable: true,
        exclusionAllowed: false,
      },
    ]);
    const input = (standardId: string, key: 'PREVIOUS_ACTIONS' | 'CUSTOMER_SATISFACTION') => ({
      standardId,
      key,
      clauseNumber: '9.3.2',
      item: 'a',
      title: `Input ${key}`,
      source: 'MANUAL' as const,
    });
    await r.isoCatalogue.createReviewInputDefs(tx, [
      input(iso9001.id, 'PREVIOUS_ACTIONS'),
      input(iso9001.id, 'CUSTOMER_SATISFACTION'),
      input(iso14001.id, 'PREVIOUS_ACTIONS'),
    ]);
    await r.isoCatalogue.createReviewOutputDefs(tx, [
      {
        standardId: iso9001.id,
        key: 'IMPROVEMENT',
        clauseNumber: '9.3.3',
        item: 'a',
        title: 'Improvement',
      },
      {
        standardId: iso14001.id,
        key: 'IMPROVEMENT',
        clauseNumber: '9.3',
        item: null,
        title: 'Improvement',
      },
      {
        standardId: iso14001.id,
        key: 'SUITABILITY',
        clauseNumber: '9.3',
        item: null,
        title: 'Suitability',
      },
    ]);

    const system = async (clientId: string, name: string, unitIds: string[]) =>
      (
        await r.managementSystems.create(tx, {
          clientId,
          name,
          standardIds: [iso9001.id, iso14001.id],
          scopeStatement: null,
          unitIds,
          status: 'IMPLEMENTING',
          reviewIntervalMonths: 12,
          climateChangeRelevant: null,
          climateChangeRationale: null,
          climateDecidedOn: null,
        })
      ).id;
    const riverbendSystem = await system(kestrel.clientId, 'Riverbend system', [
      kestrel.unitIds[0]!,
    ]);
    const stonebridgeSystem = await system(kestrel.clientId, 'Stonebridge system', [
      kestrel.unitIds[1]!,
    ]);
    const ospreySystem = await system(osprey.clientId, 'Osprey system', []);
    const document = await r.controlledDocuments.create(tx, {
      clientId: kestrel.clientId,
      managementSystemId: riverbendSystem,
      code: 'QP-07',
      title: 'Calibration procedure',
      type: 'PROCEDURE',
      clauseIds: [],
      status: 'ACTIVE',
      currentRevisionId: null,
      ownerId: owner.id,
      approverId: approver.id,
      reviewDueOn: null,
      lastReviewedOn: null,
      retention: null,
      issuer: null,
      externalRef: null,
    });
    const externalAudit = await r.externalAudits.create(tx, {
      clientId: kestrel.clientId,
      managementSystemId: stonebridgeSystem,
      standardIds: [iso9001.id],
      type: 'SURVEILLANCE_1',
      body: 'Osprey Certification',
      leadAuditorName: null,
      startOn: day('2026-11-02'),
      endOn: day('2026-11-03'),
      recommendation: null,
      responseDueOn: null,
      state: 'HELD',
      cancelReason: null,
    });
    return {
      kestrel: kestrel.clientId,
      osprey: osprey.clientId,
      riverbend: kestrel.unitIds[0]!,
      stonebridge: kestrel.unitIds[1]!,
      ospreyUnit: osprey.unitIds[0]!,
      ownerId: owner.id,
      approverId: approver.id,
      otherId: other.id,
      adminId: admin.id,
      iso9001: iso9001.id,
      iso14001: iso14001.id,
      clause41: clause41!.id,
      riverbendSystem,
      stonebridgeSystem,
      ospreySystem,
      documentId: document.id,
      externalAuditId: externalAudit.id,
      kestrelInstance: kestrel.instanceId,
      ospreyInstance: osprey.instanceId,
    };
  });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

const ids = (page: { items: { id: string }[] }) => page.items.map((i) => i.id);

describe('risk items and controls', () => {
  it('keep the kind rules of the contracts in the database', async () => {
    const insert = (kind: string, extra: string) =>
      asAdmin((tx) =>
        tx.execute(
          sql.raw(`INSERT INTO risk_item (client_id, management_system_id, kind, activity, description, likelihood,
            severity, rating, significant, owner_id ${extra ? ', ' + extra.split('|')[0] : ''})
          VALUES ('${w.kestrel}', '${w.riverbendSystem}', '${kind}', 'Casting', 'Dust', 2, 2, 4, false, '${w.ownerId}'
            ${extra ? ', ' + extra.split('|')[1] : ''})`),
        ),
      );
    expect(await failure(insert('RISK', ''))).toBe('resolved');
    // An ASPECT needs an impact, stages, a control type and a condition.
    expect(await failure(insert('ASPECT', "impact, condition|'Air', 'NORMAL'"))).toBe('23514');
    expect(
      await failure(
        insert(
          'ASPECT',
          "impact, condition, control_type, life_cycle_stages|'Air', 'NORMAL', 'CONTROL', '{PRODUCTION,PRODUCTION}'",
        ),
      ),
    ).toBe('23514');
    expect(
      await failure(
        insert(
          'ASPECT',
          "impact, condition, control_type, life_cycle_stages|'Air', 'NORMAL', 'CONTROL', '{PRODUCTION}'",
        ),
      ),
    ).toBe('resolved');
    // A HAZARD needs routine and exposed groups; a RISK has none.
    expect(
      await failure(insert('HAZARD', "impact, condition, routine|'Burns', 'NORMAL', true")),
    ).toBe('23514');
    expect(
      await failure(
        insert(
          'HAZARD',
          "impact, condition, routine, persons_exposed|'Burns', 'NORMAL', true, '{WORKER}'",
        ),
      ),
    ).toBe('resolved');
    expect(await failure(insert('RISK', 'routine|true'))).toBe('23514');
    // Scales, the residual pair and an override with its reason.
    expect(await failure(insert('RISK', 'residual_likelihood|2'))).toBe('23514');
    expect(await failure(insert('RISK', 'significant_override|true'))).toBe('23514');
    expect(await failure(insert('RISK', `obligation_ids|'{${w.ownerId},${w.ownerId}}'`))).toBe(
      '23514',
    );
    await expect(
      asAdmin((tx) => r.riskItems.create(tx, newRisk({ likelihood: 6 }))),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuse a unit or system of another client', async () => {
    expect(
      await failure(asAdmin((tx) => r.riskItems.create(tx, newRisk({ unitId: w.ospreyUnit })))),
    ).toBe('NOT_FOUND');
    expect(
      await failure(
        asAdmin((tx) => r.riskItems.create(tx, newRisk({ managementSystemId: w.ospreySystem }))),
      ),
    ).toBe('NOT_FOUND');
  });

  it('list by unit scope: their unit, else the system units, or their owner', async () => {
    const { onRiverbend, onStonebridge, systemOnly, otherSystem, owned } = await asAdmin(
      async (tx) => ({
        onRiverbend: (await r.riskItems.create(tx, newRisk({ unitId: w.riverbend }))).id,
        // Its own unit wins over its system's.
        onStonebridge: (await r.riskItems.create(tx, newRisk({ unitId: w.stonebridge }))).id,
        systemOnly: (await r.riskItems.create(tx, newRisk({ kind: 'OPPORTUNITY' }))).id,
        otherSystem: (
          await r.riskItems.create(tx, newRisk({ managementSystemId: w.stonebridgeSystem }))
        ).id,
        owned: (
          await r.riskItems.create(
            tx,
            newRisk({ managementSystemId: w.stonebridgeSystem, ownerId: w.otherId }),
          )
        ).id,
      }),
    );
    const page = await asAdmin((tx) =>
      r.riskItems.list(tx, w.kestrel, { scope: scoped([w.riverbend], w.otherId), limit: 200 }),
    );
    expect(ids(page)).toEqual(expect.arrayContaining([onRiverbend, systemOnly, owned]));
    expect(ids(page)).not.toContain(onStonebridge);
    expect(ids(page)).not.toContain(otherSystem);
    const filtered = await asAdmin((tx) =>
      r.riskItems.list(tx, w.kestrel, { kind: ['OPPORTUNITY'], count: true }),
    );
    expect(ids(filtered)).toEqual([systemOnly]);
    expect(filtered.total).toBe(1);
    expect(
      ids(await asAdmin((tx) => r.riskItems.list(tx, w.kestrel, { unitIds: [w.stonebridge] }))),
    ).toEqual([onStonebridge]);
    expect((await asAdmin((tx) => r.riskItems.list(tx, w.kestrel, { kind: [] }))).items).toEqual(
      [],
    );
  });

  it('update, archive and keep controls in place with their source action', async () => {
    await asAdmin(async (tx) => {
      const item = await r.riskItems.create(tx, newRisk({ unitId: w.riverbend }));
      const updated = await r.riskItems.update(tx, item.id, item.version, {
        reviewDueOn: day('2027-01-31'),
      });
      expect(updated).toMatchObject({ version: 2, reviewDueOn: '2027-01-31' });
      expect(
        ids(await r.riskItems.list(tx, w.kestrel, { reviewDueTo: day('2027-01-31') })),
      ).toContain(item.id);
      const action = await r.isoActions.create(
        tx,
        newAction({ type: 'RISK_ITEM', id: item.id }, { controlHierarchy: 'ENGINEERING' }),
      );
      const control = await r.riskControls.create(tx, {
        clientId: w.kestrel,
        riskItemId: item.id,
        text: 'Two weeks of alloy stock',
        hierarchy: 'ENGINEERING',
        sourceActionId: action.id,
      });
      expect(await r.riskControls.forRiskItem(tx, item.id)).toEqual([control]);
      const edited = await r.riskControls.update(tx, control.id, control.version, {
        text: 'Three weeks of alloy stock',
      });
      expect(edited.text).toBe('Three weeks of alloy stock');
      await r.riskControls.archive(tx, edited.id, edited.version);
      expect(await r.riskControls.forRiskItem(tx, item.id)).toEqual([]);
      const archived = await r.riskItems.archive(tx, updated.id, updated.version);
      expect(archived.archivedAt).not.toBeNull();
      expect(ids(await r.riskItems.list(tx, w.kestrel, { limit: 200 }))).not.toContain(item.id);
    });
  });
});

describe('objectives and readings', () => {
  it('keep risk items as join rows, archived when removed', async () => {
    await asAdmin(async (tx) => {
      const a = await r.riskItems.create(tx, newRisk());
      const b = await r.riskItems.create(tx, newRisk());
      const objective = await r.objectives.create(tx, newObjective({ riskItemIds: [a.id, b.id] }));
      expect(objective.riskItemIds).toEqual([a.id, b.id].sort());
      const updated = await r.objectives.update(tx, objective.id, objective.version, {
        riskItemIds: [b.id],
      });
      expect(updated).toMatchObject({ version: 2, riskItemIds: [b.id] });
      const { rows } = await tx.execute(
        sql`SELECT risk_item_id, archived_at IS NOT NULL AS archived FROM objective_risk_item
          WHERE objective_id = ${objective.id} ORDER BY risk_item_id`,
      );
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.risk_item_id === a.id)?.archived).toBe(true);
      // A risk item of another client is refused by the composite key.
      const elsewhere = await failure(
        tx.execute(sql`INSERT INTO objective_risk_item (client_id, objective_id, risk_item_id)
          VALUES (${w.osprey}, ${objective.id}, ${a.id})`),
      );
      expect(elsewhere).toBe('23503');
    });
  });

  it('refuse repeated standards, an outcome without a close, and a bad reading rule', async () => {
    expect(
      await failure(
        asAdmin((tx) =>
          tx.execute(sql`INSERT INTO objective (client_id, management_system_id, standards, text, target,
              unit_of_measure, direction, reading_rule, owner_id, due_on)
            VALUES (${w.kestrel}, ${w.riverbendSystem}, '{ISO_9001,ISO_9001}', 'x', 1, 'kg', 'INCREASE',
              '{"kind":"MONTHLY","day":5,"offsetMonths":1}', ${w.ownerId}, '2027-03-31')`),
        ),
      ),
    ).toBe('23514');
    expect(
      await failure(
        asAdmin((tx) => r.objectives.create(tx, newObjective({ outcome: 'ACHIEVED' }))),
      ),
    ).toBe('VALIDATION');
    expect(
      await failure(
        asAdmin((tx) =>
          r.objectives.create(
            tx,
            newObjective({ readingRule: [] as unknown as Objective['readingRule'] }),
          ),
        ),
      ),
    ).toBe('VALIDATION');
  });

  it('list by standard, open or closed, and unit scope', async () => {
    const { quality, closed, stonebridge, owned } = await asAdmin(async (tx) => ({
      quality: (await r.objectives.create(tx, newObjective({ dueOn: day('2027-01-31') }))).id,
      closed: (
        await r.objectives.create(
          tx,
          newObjective({
            standards: ['ISO_14001'],
            closedOn: day('2026-10-31'),
            outcome: 'ACHIEVED',
          }),
        )
      ).id,
      stonebridge: (
        await r.objectives.create(tx, newObjective({ managementSystemId: w.stonebridgeSystem }))
      ).id,
      owned: (
        await r.objectives.create(
          tx,
          newObjective({ managementSystemId: w.stonebridgeSystem, ownerId: w.otherId }),
        )
      ).id,
    }));
    await asAdmin(async (tx) => {
      const env = ids(await r.objectives.list(tx, w.kestrel, { standard: 'ISO_14001' }));
      expect(env).toEqual([closed]);
      const open = ids(await r.objectives.list(tx, w.kestrel, { open: true, limit: 200 }));
      expect(open).toContain(quality);
      expect(open).not.toContain(closed);
      expect(ids(await r.objectives.list(tx, w.kestrel, { open: false }))).toEqual([closed]);
      const scopedIds = ids(
        await r.objectives.list(tx, w.kestrel, {
          scope: scoped([w.riverbend], w.otherId),
          limit: 200,
        }),
      );
      expect(scopedIds).toEqual(expect.arrayContaining([quality, closed, owned]));
      expect(scopedIds).not.toContain(stonebridge);
      // By due date: the January objective before the March ones.
      const page = await r.objectives.list(tx, w.kestrel, { limit: 1 });
      expect(page.items[0]!.dueOn <= '2027-01-31').toBe(true);
      const next = await r.objectives.list(tx, w.kestrel, { limit: 200, cursor: page.nextCursor });
      expect(ids(next)).not.toContain(page.items[0]!.id);
    });
  });

  it('record readings by period, after their start', async () => {
    await asAdmin(async (tx) => {
      const objective = await r.objectives.create(tx, newObjective());
      const reading = (start: string, end: string, value: number) =>
        r.objectiveReadings.create(tx, {
          clientId: w.kestrel,
          objectiveId: objective.id,
          periodStart: day(start),
          periodEnd: day(end),
          value,
          note: null,
          recordedById: w.ownerId,
        });
      const november = await reading('2026-11-01', '2026-11-30', 3);
      const october = await reading('2026-10-01', '2026-10-31', 4.5);
      expect(await r.objectiveReadings.forObjective(tx, objective.id)).toEqual([october, november]);
      const fixed = await r.objectiveReadings.update(tx, november.id, november.version, {
        value: 2,
      });
      expect(fixed.value).toBe(2);
      await r.objectiveReadings.archive(tx, fixed.id, fixed.version);
      expect(await r.objectiveReadings.forObjective(tx, objective.id)).toEqual([october]);
    });
    expect(
      await failure(
        asAdmin(async (tx) => {
          const objective = await r.objectives.create(tx, newObjective());
          await tx.execute(sql`INSERT INTO objective_reading (client_id, objective_id, period_start, period_end,
              value, recorded_by_id)
            VALUES (${w.kestrel}, ${objective.id}, '2026-11-30', '2026-11-01', 1, ${w.ownerId})`);
        }),
      ),
    ).toBe('23514');
  });
});

describe('audit programmes and internal audits', () => {
  it('hold one programme per system and FY, with a valid FY label', async () => {
    await asAdmin(async (tx) => {
      const programme = await r.auditProgrammes.create(tx, {
        clientId: w.kestrel,
        managementSystemId: w.stonebridgeSystem,
        fy: '2025-26',
        notes: null,
      });
      expect(await r.auditProgrammes.list(tx, w.stonebridgeSystem)).toEqual([programme]);
      expect(
        await r.auditProgrammes.list(tx, w.stonebridgeSystem, { scope: scoped([w.riverbend]) }),
      ).toEqual([]);
      const noted = await r.auditProgrammes.update(tx, programme.id, programme.version, {
        notes: 'Two audits a year',
      });
      expect(noted.notes).toBe('Two audits a year');
      const archived = await r.auditProgrammes.archive(tx, noted.id, noted.version);
      expect(await r.auditProgrammes.list(tx, w.stonebridgeSystem)).toEqual([]);
      expect(
        await r.auditProgrammes.list(tx, w.stonebridgeSystem, { includeArchived: true }),
      ).toEqual([archived]);
    });
    const programme = (fy: string) =>
      asAdmin((tx) =>
        tx.execute(sql`INSERT INTO audit_programme (client_id, management_system_id, fy)
          VALUES (${w.kestrel}, ${w.riverbendSystem}, ${fy})`),
      );
    expect(await failure(programme('2026-27'))).toBe('resolved');
    expect(await failure(programme('2026-27'))).toBe('23505');
    expect(await failure(programme('2026-28'))).toBe('23514');
    expect(await failure(programme('26-27'))).toBe('23514');
  });

  it('keep units and people as join rows, and check a report against its lists', async () => {
    await asAdmin(async (tx) => {
      const programme = await r.auditProgrammes.create(tx, {
        clientId: w.kestrel,
        managementSystemId: w.riverbendSystem,
        fy: '2027-28',
        notes: null,
      });
      const audit = await r.internalAudits.create(
        tx,
        newAudit(programme.id, {
          unitIds: [w.riverbend],
          auditorIds: [w.otherId],
          auditeeIds: [w.ownerId, w.otherId],
          independenceNote: 'Audits another line of the same plant',
        }),
      );
      expect(audit).toMatchObject({
        unitIds: [w.riverbend],
        auditorIds: [w.otherId],
        auditeeIds: [w.ownerId, w.otherId].sort(),
        reportedToIds: [],
      });
      expect(await r.internalAudits.require(tx, audit.id)).toEqual(audit);
    });
    // REPORTED with nobody reported to: the contract, read with its lists, refuses it, and the write rolls back.
    const reported = {
      state: 'REPORTED' as const,
      reportedOn: day('2026-12-03'),
      summary: 'Two findings',
    };
    const { auditId, version } = await asAdmin(async (tx) => {
      const programme = (await r.auditProgrammes.list(tx, w.riverbendSystem)).find(
        (p) => p.fy === '2027-28',
      )!;
      const audit = await r.internalAudits.create(tx, newAudit(programme.id));
      return { auditId: audit.id, version: audit.version };
    });
    expect(
      await failure(asAdmin((tx) => r.internalAudits.update(tx, auditId, version, reported))),
    ).toBe('VALIDATION');
    expect((await asAdmin((tx) => r.internalAudits.require(tx, auditId))).state).toBe('PLANNED');
    const done = await asAdmin((tx) =>
      r.internalAudits.update(tx, auditId, version, { ...reported, reportedToIds: [w.adminId] }),
    );
    expect(done).toMatchObject({ state: 'REPORTED', reportedToIds: [w.adminId], version: 2 });
    // The lead may not be listed again as an auditor (the contract, with the lists).
    expect(
      await failure(
        asAdmin((tx) =>
          r.internalAudits.update(tx, auditId, done.version, { auditorIds: [w.approverId] }),
        ),
      ),
    ).toBe('VALIDATION');
    const archived = await asAdmin((tx) => r.internalAudits.archive(tx, auditId, done.version));
    expect(archived.reportedToIds).toEqual([w.adminId]);
  });

  it('refuse a report without a summary, and a cancel without a reason, in the database', async () => {
    const insert = (state: string, extra: string) =>
      asAdmin(async (tx) => {
        const [programme] = await r.auditProgrammes.list(tx, w.riverbendSystem);
        await tx.execute(
          sql.raw(`INSERT INTO internal_audit (client_id, programme_id, title, planned_start, planned_end,
              lead_auditor_id, state ${extra ? ', ' + extra.split('|')[0] : ''})
            VALUES ('${w.kestrel}', '${programme!.id}', 'Audit', '2026-12-01', '2026-12-01', '${w.approverId}',
              '${state}' ${extra ? ', ' + extra.split('|')[1] : ''})`),
        );
      });
    expect(await failure(insert('REPORTED', "reported_on|'2026-12-02'"))).toBe('23514');
    expect(await failure(insert('PLANNED', "reported_on|'2026-12-02'"))).toBe('23514');
    expect(await failure(insert('CANCELLED', ''))).toBe('23514');
    expect(await failure(insert('CANCELLED', "cancel_reason|'Plant shut'"))).toBe('resolved');
  });

  it('list by unit scope: own units, else the programme system units, or a person named', async () => {
    const made = await asAdmin(async (tx) => {
      const programme = await r.auditProgrammes.create(tx, {
        clientId: w.kestrel,
        managementSystemId: w.stonebridgeSystem,
        fy: '2028-29',
        notes: null,
      });
      const audit = (o: Partial<NewEntity<InternalAudit>>) =>
        r.internalAudits.create(tx, newAudit(programme.id, o)).then((a) => a.id);
      return {
        programmeId: programme.id,
        ownRiverbend: await audit({
          unitIds: [w.riverbend],
          plannedStart: day('2027-01-05'),
          plannedEnd: day('2027-01-05'),
        }),
        systemOnly: await audit({}),
        auditee: await audit({ auditeeIds: [w.otherId] }),
      };
    });
    await asAdmin(async (tx) => {
      const page = await r.internalAudits.list(tx, w.kestrel, {
        programmeIds: [made.programmeId],
        scope: scoped([w.riverbend], w.otherId),
      });
      expect(ids(page).sort()).toEqual([made.ownRiverbend, made.auditee].sort());
      expect(
        ids(
          await r.internalAudits.list(tx, w.kestrel, {
            programmeIds: [made.programmeId],
            scope: scoped([w.stonebridge]),
          }),
        ).sort(),
      ).toEqual([made.systemOnly, made.auditee].sort());
      expect(
        ids(
          await r.internalAudits.list(tx, w.kestrel, {
            programmeIds: [made.programmeId],
            personId: w.otherId,
          }),
        ),
      ).toEqual([made.auditee]);
      expect(
        ids(
          await r.internalAudits.list(tx, w.kestrel, {
            managementSystemIds: [w.stonebridgeSystem],
            from: day('2027-01-01'),
            state: ['PLANNED'],
          }),
        ),
      ).toEqual([made.ownRiverbend]);
      expect(
        (await r.internalAudits.list(tx, w.kestrel, { managementSystemIds: [] })).items,
      ).toEqual([]);
    });
  });
});

describe('findings and checklists', () => {
  async function audit(tx: TenantTx) {
    const [programme] = await r.auditProgrammes.list(tx, w.riverbendSystem);
    return r.internalAudits.create(tx, newAudit(programme!.id));
  }

  it('belong to exactly one audit, and link an NC exactly for NC types (num_nonnulls)', async () => {
    const { internalAuditId, ncId } = await asAdmin(async (tx) => ({
      internalAuditId: (await audit(tx)).id,
      ncId: (await r.nonconformities.create(tx, newNc({ source: 'INTERNAL_AUDIT' }))).id,
    }));
    const insert = (
      internal: string | null,
      external: string | null,
      type: string,
      nc: string | null,
    ) =>
      asAdmin((tx) =>
        tx.execute(sql`INSERT INTO audit_finding (client_id, internal_audit_id, external_audit_id, type,
            description, nonconformity_id)
          VALUES (${w.kestrel}, ${internal}, ${external}, ${type}, 'Finding', ${nc})`),
      );
    expect(await failure(insert(null, null, 'OFI', null))).toBe('23514');
    expect(await failure(insert(internalAuditId, w.externalAuditId, 'OFI', null))).toBe('23514');
    expect(await failure(insert(internalAuditId, null, 'MAJOR_NC', null))).toBe('23514');
    expect(await failure(insert(internalAuditId, null, 'OBSERVATION', ncId))).toBe('23514');
    expect(await failure(insert(internalAuditId, null, 'MINOR_NC', ncId))).toBe('resolved');
    // An NC is raised by one finding at most.
    expect(await failure(insert(null, w.externalAuditId, 'MINOR_NC', ncId))).toBe('23505');
    expect(await failure(insert(null, w.externalAuditId, 'GOOD_PRACTICE', null))).toBe('resolved');
  });

  it('read by audit, by NC and by unit scope', async () => {
    await asAdmin(async (tx) => {
      const internal = await audit(tx);
      const nc = await r.nonconformities.create(tx, newNc({ source: 'EXTERNAL_AUDIT' }));
      const finding = (o: Record<string, unknown>) =>
        r.auditFindings.create(tx, {
          clientId: w.kestrel,
          internalAuditId: null,
          externalAuditId: null,
          type: 'OFI',
          clauseIds: [w.clause41],
          unitId: null,
          description: 'Finding',
          nonconformityId: null,
          ...o,
        });
      const onInternal = await finding({ internalAuditId: internal.id });
      const onExternal = await finding({
        externalAuditId: w.externalAuditId,
        type: 'MINOR_NC',
        nonconformityId: nc.id,
      });
      expect(await r.auditFindings.forAudit(tx, { internalAuditId: internal.id })).toEqual([
        onInternal,
      ]);
      expect(await r.auditFindings.forNonconformity(tx, nc.id)).toEqual(onExternal);
      expect(await r.auditFindings.forNonconformity(tx, internal.id)).toBeNull();
      // The internal audit is on the Riverbend system, the external one on Stonebridge.
      const riverbend = ids(
        await r.auditFindings.list(tx, w.kestrel, { scope: scoped([w.riverbend]), limit: 200 }),
      );
      expect(riverbend).toContain(onInternal.id);
      expect(riverbend).not.toContain(onExternal.id);
      expect(
        ids(
          await r.auditFindings.list(tx, w.kestrel, {
            externalAuditIds: [w.externalAuditId],
            type: ['MINOR_NC'],
            scope: scoped([w.stonebridge]),
          }),
        ),
      ).toContain(onExternal.id);
      const edited = await r.auditFindings.update(tx, onInternal.id, onInternal.version, {
        type: 'OBSERVATION',
      });
      expect(edited.type).toBe('OBSERVATION');
      await r.auditFindings.archive(tx, edited.id, edited.version);
      expect(await r.auditFindings.forAudit(tx, { internalAuditId: internal.id })).toEqual([]);
    });
  });

  it('checklist rows: a FINDING links its finding, a NOT_AUDITED row has a reason', async () => {
    await asAdmin(async (tx) => {
      const internal = await audit(tx);
      const row = (o: Record<string, unknown> = {}) => ({
        clientId: w.kestrel,
        internalAuditId: internal.id,
        clauseId: w.clause41,
        unitId: w.riverbend,
        question: 'Are measuring devices calibrated?',
        auditorNote: null,
        result: null,
        findingId: null,
        notAuditedReason: null,
        ...o,
      });
      const [first, second] = await r.auditChecklistItems.createMany(tx, [row(), row()]);
      expect(await r.auditChecklistItems.forAudit(tx, internal.id)).toEqual(
        [first, second].sort((a, b) => a!.id.localeCompare(b!.id)),
      );
      const finding = await r.auditFindings.create(tx, {
        clientId: w.kestrel,
        internalAuditId: internal.id,
        externalAuditId: null,
        type: 'OFI',
        clauseIds: [],
        unitId: null,
        description: 'Labels faded',
        nonconformityId: null,
      });
      const answered = await r.auditChecklistItems.update(tx, first!.id, first!.version, {
        result: 'FINDING',
        findingId: finding.id,
      });
      expect(answered.findingId).toBe(finding.id);
      await r.auditChecklistItems.archive(tx, second!.id, second!.version);
      expect(await r.auditChecklistItems.forAudit(tx, internal.id)).toEqual([answered]);
      expect(await r.auditChecklistItems.create(tx, row({ result: 'CONFORMS' }))).toMatchObject({
        result: 'CONFORMS',
      });
    });
    const insert = (result: string, extra: string) =>
      asAdmin(async (tx) => {
        const internal = await audit(tx);
        await tx.execute(
          sql.raw(`INSERT INTO audit_checklist_item (client_id, internal_audit_id, clause_id, question, result
              ${extra ? ', ' + extra.split('|')[0] : ''})
            VALUES ('${w.kestrel}', '${internal.id}', '${w.clause41}', 'Q', '${result}'
              ${extra ? ', ' + extra.split('|')[1] : ''})`),
        );
      });
    expect(await failure(insert('FINDING', ''))).toBe('23514');
    expect(await failure(insert('NOT_AUDITED', ''))).toBe('23514');
    expect(await failure(insert('CONFORMS', "not_audited_reason|'Shut'"))).toBe('23514');
    expect(await failure(insert('NOT_AUDITED', "not_audited_reason|'Shut'"))).toBe('resolved');
  });
});

describe('nonconformities', () => {
  it('number per client from 1, whatever the writer passes, and keep the number on update', async () => {
    const { first, second, osprey } = await asAdmin(async (tx) => {
      const before = (await r.nonconformities.list(tx, w.kestrel, { count: true })).total ?? 0;
      const first = await r.nonconformities.create(tx, newNc());
      const second = await r.nonconformities.create(tx, {
        ...newNc(),
        number: 999,
      } as unknown as Parameters<typeof r.nonconformities.create>[1]);
      const osprey = await r.nonconformities.create(
        tx,
        newNc({ clientId: w.osprey, managementSystemId: w.ospreySystem }),
      );
      return { first: { ...first, before }, second, osprey };
    });
    expect(first.number).toBe(first.before + 1);
    expect(second.number).toBe(first.number + 1);
    expect(osprey.number).toBe(1);
    const updated = await asAdmin((tx) =>
      tx.execute(
        sql`UPDATE nonconformity SET number = 500 WHERE id = ${second.id} RETURNING number`,
      ),
    );
    expect(updated.rows[0]!.number).toBe(second.number);
    expect(
      (await asAdmin((tx) => r.nonconformities.byNumber(tx, w.kestrel, second.number)))?.id,
    ).toBe(second.id);
    expect(await asAdmin((tx) => r.nonconformities.byNumber(tx, w.osprey, 999))).toBeNull();
  });

  it('give two concurrent raises in one client different numbers', async () => {
    const raise = () => asAdmin((tx) => r.nonconformities.create(tx, newNc()));
    const [a, b, c] = await Promise.all([raise(), raise(), raise()]);
    expect(new Set([a.number, b.number, c.number]).size).toBe(3);
  });

  it('store incident fields and investigators, and clear them with the incident', async () => {
    await asAdmin(async (tx) => {
      const nc = await r.nonconformities.create(
        tx,
        newNc({
          source: 'INCIDENT',
          severity: 'MAJOR',
          standards: ['ISO_14001'],
          unitId: w.riverbend,
          relatedRiskItemIds: [(await r.riskItems.create(tx, newRisk())).id],
          changedDocumentIds: [w.documentId],
          incident: incident({
            investigatorIds: [w.otherId, w.ownerId],
            statutoryInstanceId: w.kestrelInstance,
          }),
          sourceInstanceId: w.kestrelInstance,
        }),
      );
      expect(nc.incident).toEqual(
        incident({
          investigatorIds: [w.otherId, w.ownerId].sort(),
          statutoryInstanceId: w.kestrelInstance,
        }),
      );
      expect(nc.changedDocumentIds).toEqual([w.documentId]);
      expect(nc.relatedRiskItemIds).toHaveLength(1);
      expect(await r.nonconformities.require(tx, nc.id)).toEqual(nc);
      const updated = await r.nonconformities.update(tx, nc.id, nc.version, {
        updatedRiskItemIds: nc.relatedRiskItemIds,
        relatedRiskItemIds: [],
        incident: { ...nc.incident!, investigatorIds: [w.otherId] },
      });
      expect(updated).toMatchObject({
        relatedRiskItemIds: [],
        updatedRiskItemIds: nc.relatedRiskItemIds,
        incident: { investigatorIds: [w.otherId], location: 'Casthouse bay 2' },
      });
      // A process NC has no incident: clearing it archives the investigators too.
      const process = await r.nonconformities.update(tx, nc.id, updated.version, {
        source: 'PROCESS',
        incident: null,
      });
      expect(process.incident).toBeNull();
      const { rows } = await tx.execute(
        sql`SELECT count(*)::int AS live FROM nonconformity_person WHERE nonconformity_id = ${nc.id} AND archived_at IS NULL`,
      );
      expect(rows[0]!.live).toBe(0);
    });
  });

  it('keep the contract rules in the database', async () => {
    const insert = (extra: string) =>
      asAdmin((tx) =>
        tx.execute(
          sql.raw(`INSERT INTO nonconformity (client_id, management_system_id, source, severity, standards,
              description, reported_by_id, reported_on, owner_id, approver_id, due_on, ${extra.split('|')[0]})
            VALUES ('${w.kestrel}', '${w.riverbendSystem}', ${extra.split('|')[1]})`),
        ),
      );
    const base = (owner = w.ownerId) =>
      `'MINOR', '{ISO_9001}', 'NC', '${w.approverId}', '2026-12-02', '${owner}', '${w.approverId}'`;
    const incidentCols =
      'incident_occurred_at, incident_location, incident_type, incident_outcome, incident_reportable, incident_worker_participation';
    // Maker-checker, due date, disposition with its authoriser.
    expect(
      await failure(insert(`state|'PROCESS', ${base(w.approverId)}, '2027-01-01', 'OPEN'`)),
    ).toBe('23514');
    expect(await failure(insert(`state|'PROCESS', ${base()}, '2026-12-01', 'OPEN'`))).toBe('23514');
    expect(
      await failure(insert(`disposition|'PROCESS', ${base()}, '2027-01-01', 'CONCESSION'`)),
    ).toBe('23514');
    // Root cause from ROOT_CAUSE_FOUND on; risk review and system change once submitted; closed and effective.
    expect(
      await failure(insert(`state|'PROCESS', ${base()}, '2027-01-01', 'ROOT_CAUSE_FOUND'`)),
    ).toBe('23514');
    expect(
      await failure(
        insert(
          `state, containment, correction, root_cause_method, root_cause, similar_occurrences|'PROCESS', ${base()}, '2027-01-01', 'AWAITING_VERIFICATION', 'a', 'b', 'FIVE_WHYS', 'c', 'd'`,
        ),
      ),
    ).toBe('23514');
    expect(
      await failure(
        insert(
          `state, containment, correction, root_cause_method, root_cause, similar_occurrences, risk_review, system_change, closed_on|'PROCESS', ${base()}, '2027-01-01', 'CLOSED', 'a', 'b', 'FIVE_WHYS', 'c', 'd', 'none', 'none', '2027-01-02'`,
        ),
      ),
    ).toBe('23514');
    expect(await failure(insert(`state|'PROCESS', ${base()}, '2027-01-01', 'CANCELLED'`))).toBe(
      '23514',
    );
    // Incident fields exactly for INCIDENT and NEAR_MISS, with a unit; near misses have no outcome; lost days.
    expect(await failure(insert(`state|'INCIDENT', ${base()}, '2027-01-01', 'OPEN'`))).toBe(
      '23514',
    );
    const near = (type: string, outcome: string, unit: string | null, more = '') =>
      insert(
        `unit_id, ${incidentCols}${more ? ', ' + more.split('#')[0] : ''}|'NEAR_MISS', ${base()}, '2027-01-01', ${unit ? `'${unit}'` : 'null'}, now(), 'Yard', '${type}', '${outcome}', false, true${more ? ', ' + more.split('#')[1] : ''}`,
      );
    expect(await failure(near('NEAR_MISS', 'NONE', null))).toBe('23514');
    expect(await failure(near('NEAR_MISS', 'FIRST_AID', w.riverbend))).toBe('23514');
    expect(await failure(near('FIRE', 'NONE', w.riverbend))).toBe('23514');
    expect(await failure(near('NEAR_MISS', 'NONE', w.riverbend))).toBe('resolved');
    expect(await failure(near('NEAR_MISS', 'NONE', w.riverbend, `incident_lost_days#2`))).toBe(
      '23514',
    );
    expect(
      await failure(
        insert(
          `incident_location, statutory_instance_id|'PROCESS', ${base()}, '2027-01-01', 'Yard', '${w.kestrelInstance}'`,
        ),
      ),
    ).toBe('23514');
  });

  it('refuse an instance, unit, system or risk item of another client', async () => {
    const create = (o: Partial<Omit<NewEntity<Nonconformity>, 'number'>>) =>
      failure(asAdmin((tx) => r.nonconformities.create(tx, newNc(o))));
    expect(await create({ sourceInstanceId: w.ospreyInstance })).toBe('NOT_FOUND');
    expect(await create({ unitId: w.ospreyUnit })).toBe('NOT_FOUND');
    expect(await create({ managementSystemId: w.ospreySystem })).toBe('NOT_FOUND');
    const ospreyRisk = await asAdmin((tx) =>
      r.riskItems.create(tx, newRisk({ clientId: w.osprey, managementSystemId: w.ospreySystem })),
    );
    expect(await create({ raisedFromRiskItemId: ospreyRisk.id })).toBe('NOT_FOUND');
    expect(await create({ relatedRiskItemIds: [ospreyRisk.id] })).toBe('NOT_FOUND');
    expect(await create({ sourceInstanceId: w.kestrelInstance })).toBe('resolved');
    expect(await create({ approverId: w.ownerId })).toBe('VALIDATION');
  });

  it('list by state, source and unit scope, investigators included', async () => {
    const made = await asAdmin(async (tx) => ({
      riverbend: (await r.nonconformities.create(tx, newNc({ unitId: w.riverbend }))).id,
      stonebridge: (
        await r.nonconformities.create(
          tx,
          newNc({ managementSystemId: w.stonebridgeSystem, description: 'Spill kit empty' }),
        )
      ).id,
      investigated: (
        await r.nonconformities.create(
          tx,
          newNc({
            managementSystemId: w.stonebridgeSystem,
            source: 'NEAR_MISS',
            unitId: w.stonebridge,
            incident: incident({
              type: 'NEAR_MISS',
              outcome: 'NONE',
              lostDays: null,
              investigatorIds: [w.otherId],
            }),
          }),
        )
      ).id,
    }));
    await asAdmin(async (tx) => {
      const page = ids(
        await r.nonconformities.list(tx, w.kestrel, {
          scope: scoped([w.riverbend], w.otherId),
          limit: 200,
        }),
      );
      expect(page).toEqual(expect.arrayContaining([made.riverbend, made.investigated]));
      expect(page).not.toContain(made.stonebridge);
      expect(
        ids(
          await r.nonconformities.list(tx, w.kestrel, {
            source: ['NEAR_MISS'],
            managementSystemIds: [w.stonebridgeSystem],
          }),
        ),
      ).toEqual([made.investigated]);
      expect(ids(await r.nonconformities.list(tx, w.kestrel, { q: 'spill KIT' }))).toEqual([
        made.stonebridge,
      ]);
      const all = await r.nonconformities.list(tx, w.kestrel, {
        state: ['OPEN'],
        severity: ['MINOR'],
        ownerId: w.ownerId,
        approverId: w.approverId,
        from: day('2026-12-01'),
        to: day('2026-12-31'),
        limit: 2,
      });
      expect(all.items[0]!.number).toBeLessThan(all.items[1]!.number);
      expect(
        ids(await r.nonconformities.list(tx, w.kestrel, { unitIds: [w.stonebridge] })),
      ).toEqual([made.investigated]);
      const archived = await r.nonconformities.archive(
        tx,
        made.stonebridge,
        (await r.nonconformities.require(tx, made.stonebridge)).version,
      );
      expect(archived.archivedAt).not.toBeNull();
    });
    // RLS: a user of the other client sees none of them.
    expect(
      await t.db.withTenant(ospreyUser(), (tx) => r.nonconformities.get(tx, made.riverbend)),
    ).toBeNull();
  });
});

describe('actions', () => {
  it('have exactly one subject (num_nonnulls), a hierarchy only on a risk item, an output only on a review', async () => {
    const { ncId, riskId, reviewId } = await asAdmin(async (tx) => ({
      ncId: (await r.nonconformities.create(tx, newNc())).id,
      riskId: (await r.riskItems.create(tx, newRisk())).id,
      reviewId: (await r.managementReviews.create(tx, newReview())).id,
    }));
    const insert = (cols: string, values: string) =>
      asAdmin((tx) =>
        tx.execute(
          sql.raw(`INSERT INTO iso_action (client_id, text, owner_id, due_on${cols ? ', ' + cols : ''})
            VALUES ('${w.kestrel}', 'Act', '${w.ownerId}', '2027-01-31'${values ? ', ' + values : ''})`),
        ),
      );
    expect(await failure(insert('', ''))).toBe('23514');
    expect(await failure(insert('nonconformity_id, risk_item_id', `'${ncId}', '${riskId}'`))).toBe(
      '23514',
    );
    expect(await failure(insert('nonconformity_id, control_hierarchy', `'${ncId}', 'PPE'`))).toBe(
      '23514',
    );
    expect(await failure(insert('risk_item_id, control_hierarchy', `'${riskId}', 'PPE'`))).toBe(
      'resolved',
    );
    expect(await failure(insert('nonconformity_id, output_key', `'${ncId}', 'IMPROVEMENT'`))).toBe(
      '23514',
    );
    expect(
      await failure(insert('management_review_id, output_key', `'${reviewId}', 'IMPROVEMENT'`)),
    ).toBe('resolved');
    expect(await failure(insert('nonconformity_id, state', `'${ncId}', 'DONE'`))).toBe('23514');
    expect(await failure(insert('nonconformity_id, state', `'${ncId}', 'CANCELLED'`))).toBe(
      '23514',
    );
    expect(
      await failure(
        asAdmin((tx) => r.isoActions.create(tx, newAction({ type: 'NONCONFORMITY', id: riskId }))),
      ),
    ).toBe('NOT_FOUND');
  });

  it('read by subject, and list by unit scope through the subject, or their owner', async () => {
    const made = await asAdmin(async (tx) => {
      const riverbendNc = await r.nonconformities.create(tx, newNc({ unitId: w.riverbend }));
      const stonebridgeRisk = await r.riskItems.create(
        tx,
        newRisk({ managementSystemId: w.stonebridgeSystem }),
      );
      const objective = await r.objectives.create(tx, newObjective());
      const review = await r.managementReviews.create(
        tx,
        newReview({ managementSystemId: w.stonebridgeSystem, attendeeIds: [w.otherId] }),
      );
      const [programme] = await r.auditProgrammes.list(tx, w.riverbendSystem);
      const internal = await r.internalAudits.create(tx, newAudit(programme!.id));
      const finding = await r.auditFindings.create(tx, {
        clientId: w.kestrel,
        internalAuditId: internal.id,
        externalAuditId: null,
        type: 'OFI',
        clauseIds: [],
        unitId: null,
        description: 'Labels faded',
        nonconformityId: null,
      });
      const action = (subject: IsoAction['subject'], o: Partial<NewEntity<IsoAction>> = {}) =>
        r.isoActions.create(tx, newAction(subject, o));
      return {
        onNc: await action(
          { type: 'NONCONFORMITY', id: riverbendNc.id },
          { dueOn: day('2027-01-10') },
        ),
        onNcLater: await action({ type: 'NONCONFORMITY', id: riverbendNc.id }),
        onRisk: await action({ type: 'RISK_ITEM', id: stonebridgeRisk.id }),
        onRiskOwned: await action(
          { type: 'RISK_ITEM', id: stonebridgeRisk.id },
          { ownerId: w.adminId },
        ),
        onObjective: await action({ type: 'OBJECTIVE', id: objective.id }),
        onFinding: await action({ type: 'AUDIT_FINDING', id: finding.id }),
        onReview: await action(
          { type: 'MANAGEMENT_REVIEW', id: review.id },
          { outputKey: 'IMPROVEMENT' },
        ),
        ncId: riverbendNc.id,
      };
    });
    await asAdmin(async (tx) => {
      expect(await r.isoActions.forSubject(tx, { type: 'NONCONFORMITY', id: made.ncId })).toEqual([
        made.onNc,
        made.onNcLater,
      ]);
      expect(made.onReview.subject).toEqual({
        type: 'MANAGEMENT_REVIEW',
        id: made.onReview.subject.id,
      });
      // Riverbend, plus the review that names the person as attendee, plus actions the person owns.
      const page = ids(
        await r.isoActions.list(tx, w.kestrel, {
          scope: scoped([w.riverbend], w.otherId),
          limit: 200,
        }),
      );
      expect(page).toEqual(
        expect.arrayContaining([
          made.onNc.id,
          made.onNcLater.id,
          made.onObjective.id,
          made.onFinding.id,
          made.onReview.id,
        ]),
      );
      expect(page).not.toContain(made.onRisk.id);
      const asAdminScope = ids(
        await r.isoActions.list(tx, w.kestrel, { scope: scoped([], w.adminId), limit: 200 }),
      );
      expect(asAdminScope).toContain(made.onRiskOwned.id);
      expect(asAdminScope).not.toContain(made.onRisk.id);
      expect(
        ids(
          await r.isoActions.list(tx, w.kestrel, {
            subjectTypes: ['RISK_ITEM'],
            ownerId: w.adminId,
            state: ['OPEN'],
            dueTo: day('2027-12-31'),
          }),
        ),
      ).toEqual([made.onRiskOwned.id]);
      expect((await r.isoActions.list(tx, w.kestrel, { subjectTypes: [] })).items).toEqual([]);
      const done = await r.isoActions.update(tx, made.onNc.id, made.onNc.version, {
        state: 'DONE',
        doneOn: day('2026-12-20'),
      });
      expect(done).toMatchObject({ state: 'DONE', subject: made.onNc.subject });
      await r.isoActions.archive(tx, done.id, done.version);
      expect(await r.isoActions.forSubject(tx, made.onNc.subject)).toEqual([made.onNcLater]);
      expect(
        await r.isoActions.forSubject(tx, made.onNc.subject, { includeArchived: true }),
      ).toHaveLength(2);
    });
  });
});

describe('management reviews', () => {
  it('keep attendees as join rows and add one input and output row per key', async () => {
    await asAdmin(async (tx) => {
      const review = await r.managementReviews.create(
        tx,
        newReview({ attendeeIds: [w.ownerId, w.otherId] }),
      );
      expect(review.attendeeIds).toEqual([w.ownerId, w.otherId].sort());
      // 9001 has PREVIOUS_ACTIONS and CUSTOMER_SATISFACTION, 14001 PREVIOUS_ACTIONS again: two inputs.
      const inputs = await r.reviewInputs.addForReview(tx, review, [w.iso9001, w.iso14001]);
      expect(inputs).toHaveLength(2);
      expect(await r.reviewInputs.addForReview(tx, review, [w.iso14001])).toEqual([]);
      expect(await r.reviewInputs.forReview(tx, review.id)).toEqual(inputs);
      const noted = await r.reviewInputs.update(tx, inputs[0]!.id, inputs[0]!.version, {
        notes: 'Two actions still open',
      });
      expect(noted.notes).toBe('Two actions still open');
      // Outputs: IMPROVEMENT from both standards once, SUITABILITY from 14001.
      const first = await r.reviewOutputs.addForReview(tx, review, [w.iso9001]);
      expect(first).toHaveLength(1);
      const more = await r.reviewOutputs.addForReview(tx, review, [w.iso9001, w.iso14001]);
      expect(more).toHaveLength(1);
      expect(await r.reviewOutputs.forReview(tx, review.id)).toEqual([...first, ...more]);
      const decided = await r.reviewOutputs.update(tx, more[0]!.id, more[0]!.version, {
        decision: 'The system remains suitable',
      });
      expect(decided.decision).toBe('The system remains suitable');
      const replanned = await r.managementReviews.update(tx, review.id, review.version, {
        attendeeIds: [w.otherId],
        plannedOn: day('2027-03-22'),
      });
      expect(replanned).toMatchObject({ attendeeIds: [w.otherId], plannedOn: '2027-03-22' });
      const archived = await r.managementReviews.archive(tx, replanned.id, replanned.version);
      expect(archived.archivedAt).not.toBeNull();
    });
  });

  it('refuse repeated standards, a held date before HELD, and a def of another firm-level key twice', async () => {
    const insert = (state: string, extra: string) =>
      asAdmin((tx) =>
        tx.execute(
          sql.raw(`INSERT INTO management_review (client_id, management_system_id, standards, planned_on, chair_id,
              state ${extra ? ', ' + extra.split('|')[0] : ''})
            VALUES ('${w.kestrel}', '${w.riverbendSystem}', '{ISO_9001}', '2027-03-15', '${w.approverId}', '${state}'
              ${extra ? ', ' + extra.split('|')[1] : ''})`),
        ),
      );
    expect(await failure(insert('PLANNED', "held_on|'2027-03-15'"))).toBe('23514');
    expect(await failure(insert('HELD', ''))).toBe('23514');
    expect(await failure(insert('CANCELLED', ''))).toBe('23514');
    expect(await failure(insert('HELD', "held_on|'2027-03-15'"))).toBe('resolved');
    expect(
      await failure(
        asAdmin((tx) =>
          r.managementReviews.create(
            tx,
            newReview({ standards: ['ISO_9001', 'ISO_9001'] as never }),
          ),
        ),
      ),
    ).toBe('VALIDATION');
    expect(
      await failure(
        asAdmin(async (tx) => {
          const review = await r.managementReviews.create(tx, newReview());
          const [input] = await r.reviewInputs.addForReview(tx, review, [w.iso9001]);
          await tx.execute(sql`INSERT INTO review_input (client_id, management_review_id, input_def_id)
            VALUES (${w.kestrel}, ${review.id}, ${input!.inputDefId})`);
        }),
      ),
    ).toBe('23505');
  });

  it('list by planned date and unit scope: the system units, or the chair or an attendee', async () => {
    const made = await asAdmin(async (tx) => ({
      riverbend: (await r.managementReviews.create(tx, newReview({ plannedOn: day('2027-06-01') })))
        .id,
      stonebridge: (
        await r.managementReviews.create(
          tx,
          newReview({ managementSystemId: w.stonebridgeSystem, plannedOn: day('2027-06-02') }),
        )
      ).id,
      chaired: (
        await r.managementReviews.create(
          tx,
          newReview({
            managementSystemId: w.stonebridgeSystem,
            chairId: w.otherId,
            plannedOn: day('2027-06-03'),
          }),
        )
      ).id,
    }));
    await asAdmin(async (tx) => {
      const june = { from: day('2027-06-01'), to: day('2027-06-30') };
      expect(ids(await r.managementReviews.list(tx, w.kestrel, june))).toEqual([
        made.riverbend,
        made.stonebridge,
        made.chaired,
      ]);
      expect(
        ids(
          await r.managementReviews.list(tx, w.kestrel, {
            ...june,
            state: ['PLANNED'],
            managementSystemIds: [w.riverbendSystem, w.stonebridgeSystem],
            scope: scoped([w.riverbend], w.otherId),
          }),
        ),
      ).toEqual([made.riverbend, made.chaired]);
    });
  });
});

describe('files on part 2 subjects', () => {
  it('attach to an NC and an action, and read back with their subject', async () => {
    await asAdmin(async (tx) => {
      const nc = await r.nonconformities.create(tx, newNc());
      const action = await r.isoActions.create(tx, newAction({ type: 'NONCONFORMITY', id: nc.id }));
      const file = (type: 'nonconformity' | 'iso_action', id: string) =>
        r.isoFiles.create(tx, {
          clientId: w.kestrel,
          subject: { type, id },
          fileName: 'photo.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 100,
          sha256: SHA,
          storageKey: `evidence/${firmId}/${w.kestrel}/iso/${type}/${id}/${type}`,
          uploadedById: w.ownerId,
        });
      const onNc = await file('nonconformity', nc.id);
      const onAction = await file('iso_action', action.id);
      expect(r.isoFileSubject(onNc)).toEqual({ type: 'nonconformity', id: nc.id });
      expect(onNc.nonconformityId).toBe(nc.id);
      expect(await r.isoFiles.forSubject(tx, { type: 'iso_action', id: action.id })).toEqual([
        r.isoFileView(onAction),
      ]);
      // An id of another subject type is refused by the subject's composite key.
      expect(await failure(file('iso_action', nc.id))).toBe('NOT_FOUND');
    });
  });

  it('attach to each part 2 subject, and to no two subjects at once', async () => {
    await asAdmin(async (tx) => {
      const risk = await r.riskItems.create(tx, newRisk());
      const objective = await r.objectives.create(tx, newObjective());
      const reading = await r.objectiveReadings.create(tx, {
        clientId: w.kestrel,
        objectiveId: objective.id,
        periodStart: day('2026-12-01'),
        periodEnd: day('2026-12-31'),
        value: 1,
        note: null,
        recordedById: w.ownerId,
      });
      const [programme] = await r.auditProgrammes.list(tx, w.riverbendSystem);
      const audit = await r.internalAudits.create(tx, newAudit(programme!.id));
      const finding = await r.auditFindings.create(tx, {
        clientId: w.kestrel,
        internalAuditId: audit.id,
        externalAuditId: null,
        type: 'OBSERVATION',
        clauseIds: [],
        unitId: null,
        description: 'Labels faded',
        nonconformityId: null,
      });
      const nc = await r.nonconformities.create(tx, newNc());
      const action = await r.isoActions.create(tx, newAction({ type: 'RISK_ITEM', id: risk.id }));
      const review = await r.managementReviews.create(tx, newReview());
      const subjects = [
        { type: 'risk_item', id: risk.id },
        { type: 'objective_reading', id: reading.id },
        { type: 'internal_audit', id: audit.id },
        { type: 'audit_finding', id: finding.id },
        { type: 'nonconformity', id: nc.id },
        { type: 'iso_action', id: action.id },
        { type: 'management_review', id: review.id },
      ] as const;
      for (const subject of subjects) {
        const file = await r.isoFiles.create(tx, {
          clientId: w.kestrel,
          subject,
          fileName: 'record.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
          sha256: SHA,
          storageKey: `evidence/${firmId}/${w.kestrel}/iso/${subject.type}/${subject.id}/each`,
          uploadedById: w.ownerId,
        });
        expect(r.isoFileSubject(file)).toEqual(subject);
        expect(await r.isoFiles.forSubject(tx, subject)).toEqual([r.isoFileView(file)]);
      }
    });
    const two = await asAdmin(async (tx) => {
      const nc = await r.nonconformities.create(tx, newNc());
      const review = await r.managementReviews.create(tx, newReview());
      return failure(
        tx.execute(sql`INSERT INTO iso_file (client_id, nonconformity_id, management_review_id, file_name, mime_type,
            size_bytes, sha256, storage_key, uploaded_by_id)
          VALUES (${w.kestrel}, ${nc.id}, ${review.id}, 'x.pdf', 'application/pdf', 1, ${SHA},
            ${`evidence/${firmId}/${w.kestrel}/iso/nonconformity/${nc.id}/two`}, ${w.ownerId})`),
      );
    });
    expect(two).toBe('23514');
  });
});
