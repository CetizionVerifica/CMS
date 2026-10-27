import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_FIRM_SETTINGS,
  LocalDate,
  type IsoAction,
  type IsoReviewInputDef,
  type ManagementReview,
  type ManagementSystem,
  type ReviewFigureData,
  type Nonconformity,
  type ReviewInputKey,
  type ReviewInputSource,
  type RiskItem,
} from '@canopy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '../src/database.js';
import { DbError } from '../src/errors.js';
import type { NewEntity } from '../src/repositories/crud.js';
import * as r from '../src/repositories/index.js';
import { systemContext, type TenantContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/**
 * Review figure reads (ISO-2h): `reviewFigures.gather` per source against the contracts mock's rules,
 * `reviewInputs.storeFigures`, `isoVisibleIds` and `syncForReview`. Each test builds its own management system, so the
 * records one test adds never reach another's figures.
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
  clause9001: string;
  clause14001: string;
  /** Input definitions by standard and key. */
  inputs: Record<'ISO_9001' | 'ISO_14001', Partial<Record<ReviewInputKey, IsoReviewInputDef>>>;
  outputs: Record<string, string>;
  statuteAssignment: (unitId: string) => Promise<string>;
  standardAssignment: (unitId: string, externalRef: string | null) => Promise<string>;
}
let w: World;

const ctx = (): TenantContext => ({
  firmId,
  personId: w.adminId,
  clientIds: 'ALL',
  requestId: 'figures-test',
});
const asAdmin = <T>(fn: (tx: TenantTx) => Promise<T>) => t.db.withTenant(ctx(), fn);

const day = (value: string) => LocalDate.parse(value);

/** `localDateIn` as the engine has it: an instant's calendar day in `timeZone`. */
const dayIn =
  (timeZone: string) =>
  (instant: string): LocalDate =>
    LocalDate.parse(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(instant)),
    );
const ist = dayIn('Asia/Kolkata');

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof DbError) return e.code;
    throw e;
  }
  return 'resolved';
}

/** Sets a row's creation (and archive) time as the owner: the app never writes them. */
async function stamp(table: string, id: string, createdAt: string, archivedAt?: string) {
  await t.ownerQuery(
    `UPDATE ${table} SET created_at = $2, archived_at = coalesce($3::timestamptz, archived_at) WHERE id = $1`,
    [id, createdAt, archivedAt ?? null],
  );
}

/** An audited event at `at`, as M16 writes them (model §8). */
async function event(
  entityType: string,
  entityId: string,
  action: 'UPDATE' | 'TRANSITION',
  at: string,
  after: Record<string, unknown>,
  before: Record<string, unknown> | null = null,
) {
  await t.ownerQuery(
    `INSERT INTO audit_event (firm_id, client_id, at, request_id, actor_kind, action, entity_type, entity_id, before, after)
      VALUES ($1, $2, $3, 'figures-test', 'SYSTEM', $4, $5, $6, $7, $8)`,
    [
      firmId,
      w.kestrel,
      at,
      action,
      entityType,
      entityId,
      before && JSON.stringify(before),
      JSON.stringify(after),
    ],
  );
}

/** A Kestrel system created on 1 April 2026 (IST), on `unitIds` (none: every unit of the client). */
async function newSystem(
  unitIds: string[] = [],
  overrides: Partial<NewEntity<ManagementSystem>> = {},
): Promise<ManagementSystem> {
  const made = await asAdmin((tx) =>
    r.managementSystems.create(tx, {
      clientId: w.kestrel,
      name: `System ${Math.random().toString(36).slice(2, 8)}`,
      standardIds: [w.iso9001, w.iso14001],
      scopeStatement: null,
      unitIds,
      status: 'IMPLEMENTING',
      reviewIntervalMonths: 12,
      climateChangeRelevant: null,
      climateChangeRationale: null,
      climateDecidedOn: null,
      ...overrides,
    }),
  );
  await stamp('management_system', made.id, '2026-03-31T20:00:00.000Z');
  return asAdmin((tx) => r.managementSystems.require(tx, made.id));
}

async function newReview(
  system: ManagementSystem,
  overrides: Partial<NewEntity<ManagementReview>> = {},
): Promise<ManagementReview> {
  return asAdmin((tx) =>
    r.managementReviews.create(tx, {
      clientId: w.kestrel,
      managementSystemId: system.id,
      standards: ['ISO_9001', 'ISO_14001'],
      plannedOn: day('2027-03-15'),
      heldOn: null,
      chairId: w.approverId,
      attendeeIds: [],
      minutes: null,
      state: 'PLANNED',
      cancelReason: null,
      ...overrides,
    }),
  );
}

const held = (system: ManagementSystem, heldOn: string, standards: ManagementReview['standards']) =>
  newReview(system, { state: 'HELD', heldOn: day(heldOn), plannedOn: day(heldOn), standards });

function gather(
  review: ManagementReview,
  standard: 'ISO_9001' | 'ISO_14001',
  key: ReviewInputKey,
  asOf: string,
  localDay = ist,
) {
  return asAdmin((tx) =>
    r.reviewFigures.gather(tx, review, w.inputs[standard][key]!, day(asOf), localDay),
  );
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
    dueOn: day('2026-12-01'),
    doneOn: null,
    state: 'OPEN',
    effectivenessNote: null,
    cancelReason: null,
    controlHierarchy: null,
    outputKey: null,
    ...overrides,
  };
}

function newRisk(
  system: ManagementSystem,
  overrides: Partial<NewEntity<RiskItem>> = {},
): NewEntity<RiskItem> {
  return {
    clientId: w.kestrel,
    managementSystemId: system.id,
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

const aspect: Partial<NewEntity<RiskItem>> = {
  impact: 'Air',
  condition: 'NORMAL',
  controlType: 'CONTROL',
  lifeCycleStages: ['PRODUCTION'],
};
const hazard: Partial<NewEntity<RiskItem>> = {
  impact: 'Burns',
  condition: 'NORMAL',
  routine: true,
  personsExposed: ['WORKER'],
};

function newNc(
  system: ManagementSystem,
  overrides: Partial<Omit<NewEntity<Nonconformity>, 'number'>> = {},
): Omit<NewEntity<Nonconformity>, 'number'> {
  return {
    clientId: w.kestrel,
    managementSystemId: system.id,
    source: 'PROCESS',
    sourceInstanceId: null,
    raisedFromRiskItemId: null,
    severity: 'MINOR',
    standards: ['ISO_9001'],
    clauseIds: [],
    unitId: null,
    description: 'Calibration record missing',
    reportedById: w.approverId,
    reportedOn: day('2026-08-02'),
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
    dueOn: day('2026-09-15'),
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

beforeAll(async () => {
  t = await createTestDatabase();
  firmId = await t.admin.createFirm({ name: 'Demo Advisory' });
  w = await t.db.withTenant(systemContext(firmId, 'figures-test'), async (tx) => {
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
    const category = await r.categories.create(tx, { name: 'Safety', aliases: [] });
    const obligationOf = async (kind: 'STATUTE' | 'STANDARD', externalRef: string | null) => {
      const act = await r.acts.create(tx, {
        name: kind === 'STATUTE' ? 'Factories Act, 1948' : `ISO 14001 ${externalRef ?? 'other'}`,
        shortName: null,
        jurisdiction: 'CENTRAL',
        stateCode: null,
        aliases: [],
        kind,
      });
      return r.obligations.create(tx, {
        externalRef,
        domain: 'EHS',
        jurisdiction: 'CENTRAL',
        stateCode: null,
        actId: act.id,
        categoryId: category.id,
        title: kind === 'STATUTE' ? 'Report an accident' : 'Evaluate compliance',
        description: 'Do it.',
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
    };
    const statute = await obligationOf('STATUTE', null);
    const evaluation = await obligationOf('STANDARD', 'ISO-COMPLIANCE-EVALUATION');
    const otherStandard = await obligationOf('STANDARD', 'ISO-OTHER');
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
      return { clientId: client.id, unitIds: ids, departmentId: department.id };
    };
    const kestrel = await clientWithUnits('Kestrel Metals Group', ['Riverbend', 'Stonebridge']);
    const osprey = await clientWithUnits('Osprey Textiles Group', ['Highmoor']);
    const made = new Map<string, Promise<string>>();
    const assignmentOn =
      (obligationId: string) =>
      (unitId: string): Promise<string> => {
        const key = `${obligationId}:${unitId}`;
        if (!made.has(key)) made.set(key, assign(obligationId, unitId));
        return made.get(key)!;
      };
    const assign = async (obligationId: string, unitId: string): Promise<string> =>
      (
        await t.db.withTenant(systemContext(firmId, 'figures-test'), (tx2) =>
          r.assignments.create(tx2, {
            clientId: unitId === osprey.unitIds[0] ? osprey.clientId : kestrel.clientId,
            unitId,
            obligationId,
            departmentId: unitId === osprey.unitIds[0] ? osprey.departmentId : kestrel.departmentId,
            defaultOwnerId: owner.id,
            defaultApproverId: approver.id,
            applicability: 'APPLICABLE',
            naReason: null,
            activeFrom: day('2026-04-01'),
            activeTo: null,
          }),
        )
      ).id;

    const standard = (code: 'ISO_9001' | 'ISO_14001', topic: string) =>
      r.isoCatalogue.createStandard(tx, { code, edition: '2015+A1:2024', title: code, topic });
    const iso9001 = await standard('ISO_9001', 'Quality management');
    const iso14001 = await standard('ISO_14001', 'Environmental management');
    const clause = (standardId: string, number: string) => ({
      standardId,
      number,
      title: `Clause ${number}`,
      summary: 'Our own summary.',
      parentId: null,
      hlsKey: number,
      assessable: true,
      exclusionAllowed: false,
    });
    const [clause9001, clause14001] = await r.isoCatalogue.createClauses(tx, [
      clause(iso9001.id, '8.4'),
      clause(iso14001.id, '8.1'),
    ]);
    const input = (standardId: string, key: ReviewInputKey, source: ReviewInputSource) => ({
      standardId,
      key,
      clauseNumber: '9.3.2',
      item: 'a',
      title: `Input ${key}`,
      source,
    });
    const defs = await r.isoCatalogue.createReviewInputDefs(tx, [
      input(iso9001.id, 'PREVIOUS_ACTIONS', 'PREVIOUS_ACTIONS'),
      input(iso9001.id, 'CONTEXT_CHANGES', 'CONTEXT'),
      input(iso9001.id, 'RISK_ACTIONS', 'RISKS'),
      input(iso9001.id, 'CUSTOMER_SATISFACTION', 'MANUAL'),
      input(iso9001.id, 'OBJECTIVES', 'OBJECTIVES'),
      input(iso9001.id, 'NONCONFORMITIES', 'NONCONFORMITIES'),
      input(iso9001.id, 'AUDIT_RESULTS', 'AUDIT_RESULTS'),
      input(iso14001.id, 'PREVIOUS_ACTIONS', 'PREVIOUS_ACTIONS'),
      input(iso14001.id, 'SIGNIFICANT_ASPECTS', 'RISKS'),
      input(iso14001.id, 'RISKS_AND_OPPORTUNITIES', 'RISKS'),
      input(iso14001.id, 'NONCONFORMITIES', 'NONCONFORMITIES'),
      input(iso14001.id, 'INCIDENTS', 'INCIDENTS'),
      input(iso14001.id, 'COMPLIANCE_EVALUATION', 'COMPLIANCE_EVALUATION'),
      input(iso14001.id, 'AUDIT_RESULTS', 'AUDIT_RESULTS'),
    ]);
    const inputs: World['inputs'] = { ISO_9001: {}, ISO_14001: {} };
    for (const d of defs) inputs[d.standardId === iso9001.id ? 'ISO_9001' : 'ISO_14001'][d.key] = d;
    const outputDefs = await r.isoCatalogue.createReviewOutputDefs(tx, [
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
    const outputs: Record<string, string> = {};
    for (const d of outputDefs) {
      outputs[`${d.standardId === iso9001.id ? 'ISO_9001' : 'ISO_14001'}:${d.key}`] = d.id;
    }
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
      clause9001: clause9001!.id,
      clause14001: clause14001!.id,
      inputs,
      outputs,
      statuteAssignment: assignmentOn(statute.id),
      standardAssignment: (unitId, externalRef) =>
        assignmentOn(externalRef === null ? otherStandard.id : evaluation.id)(unitId),
    };
  });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

/** A compliance instance on `assignmentId`'s unit, as the register's generator writes one. */
async function newInstance(
  clientId: string,
  unitId: string,
  assignmentId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const made = await asAdmin((tx) =>
    r.instances.create(tx, {
      clientId,
      unitId,
      assignmentId,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      dueDate: '2026-10-15',
      workflowState: 'OPEN',
      pendingKind: null,
      completedOn: null,
      naReason: null,
      ownerId: w.ownerId,
      approverId: w.approverId,
      submittedAt: null,
      approvedAt: null,
      dueDateOverridden: false,
      ...overrides,
    } as unknown as Parameters<typeof r.instances.create>[1]),
  );
  return made.id;
}

describe('reviewFigures.gather', () => {
  it('since: the system creation day for a first review, then per standard the last earlier held review', async () => {
    const system = await newSystem();
    const review = await newReview(system);
    // A first review: since is the system's creation day in the client's time zone (1 April, not 31 March UTC).
    expect(await gather(review, 'ISO_9001', 'PREVIOUS_ACTIONS', '2027-03-15')).toMatchObject({
      source: 'PREVIOUS_ACTIONS',
      since: '2026-04-01',
      data: { actions: [] },
    });
    await held(system, '2026-09-30', ['ISO_9001']);
    // PREVIOUS_ACTIONS is asked by both standards: 14001 has not been reviewed, so since stays at creation.
    expect((await gather(review, 'ISO_9001', 'PREVIOUS_ACTIONS', '2027-03-15')).since).toBe(
      '2026-04-01',
    );
    // A 9001-only input starts at the 9001 review.
    expect((await gather(review, 'ISO_9001', 'OBJECTIVES', '2027-03-15')).since).toBe('2026-09-30');
    // A cancelled or planned review, one held after as-of, an archived one, one of another system and the review itself
    // do not move it; a later held 14001 review moves only what 14001 asks.
    await newReview(system, { state: 'CANCELLED', cancelReason: 'Moved', standards: ['ISO_9001'] });
    await held(system, '2027-04-01', ['ISO_9001']);
    const archived = await held(system, '2026-12-01', ['ISO_9001']);
    await asAdmin((tx) => r.managementReviews.archive(tx, archived.id, archived.version));
    await held(await newSystem(), '2026-12-15', ['ISO_9001', 'ISO_14001']);
    expect((await gather(review, 'ISO_9001', 'OBJECTIVES', '2027-03-15')).since).toBe('2026-09-30');
    await held(system, '2026-11-30', ['ISO_14001']);
    expect((await gather(review, 'ISO_9001', 'PREVIOUS_ACTIONS', '2027-03-15')).since).toBe(
      '2026-09-30',
    );
    expect((await gather(review, 'ISO_14001', 'INCIDENTS', '2027-03-15')).since).toBe('2026-11-30');
    // Never after as-of: a review held on as-of counts, so since is as-of.
    expect((await gather(review, 'ISO_9001', 'OBJECTIVES', '2026-09-30')).since).toBe('2026-09-30');
    // A same-day review held before the system existed: since is clamped to as-of.
    expect((await gather(review, 'ISO_9001', 'OBJECTIVES', '2026-03-20')).since).toBe('2026-03-20');
    // MANUAL reads nothing.
    expect(await gather(review, 'ISO_9001', 'CUSTOMER_SATISFACTION', '2027-03-15')).toEqual({
      source: 'MANUAL',
      since: '2026-09-30',
      data: {},
    });
  });

  it('PREVIOUS_ACTIONS: the earlier reviews’ actions, archived ones too, settled by their latest COMPLETE or CANCEL', async () => {
    const system = await newSystem();
    const earlier = await held(system, '2026-09-30', ['ISO_9001']);
    const review = await newReview(system);
    const { done, open, cancelled, onReview } = await asAdmin(async (tx) => ({
      done: await r.isoActions.create(
        tx,
        newAction(
          { type: 'MANAGEMENT_REVIEW', id: earlier.id },
          { state: 'DONE', doneOn: day('2026-10-02') },
        ),
      ),
      open: await r.isoActions.create(tx, newAction({ type: 'MANAGEMENT_REVIEW', id: earlier.id })),
      cancelled: await r.isoActions.create(
        tx,
        newAction(
          { type: 'MANAGEMENT_REVIEW', id: earlier.id },
          { state: 'CANCELLED', cancelReason: 'Not needed' },
        ),
      ),
      // An action of the review being gathered is not a previous action.
      onReview: await r.isoActions.create(
        tx,
        newAction({ type: 'MANAGEMENT_REVIEW', id: review.id }),
      ),
    }));
    await stamp('iso_action', done.id, '2026-10-01T04:00:00.000Z');
    await stamp('iso_action', open.id, '2026-10-01T04:00:00.000Z');
    await stamp('iso_action', cancelled.id, '2026-10-01T04:00:00.000Z', '2026-10-20T04:00:00.000Z');
    // COMPLETE, REOPEN, COMPLETE: the later COMPLETE's day (IST) counts.
    await event('iso_action', done.id, 'TRANSITION', '2026-10-03T05:00:00.000Z', {
      action: 'COMPLETE',
    });
    await event('iso_action', done.id, 'TRANSITION', '2026-10-05T05:00:00.000Z', {
      action: 'REOPEN',
    });
    await event('iso_action', done.id, 'TRANSITION', '2026-11-06T19:00:00.000Z', {
      action: 'COMPLETE',
    });
    await event('iso_action', cancelled.id, 'TRANSITION', '2026-10-08T05:00:00.000Z', {
      action: 'CANCEL',
    });
    // An UPDATE is not a settle.
    await event('iso_action', cancelled.id, 'UPDATE', '2026-10-09T05:00:00.000Z', { text: 'x' });
    const { data } = await gather(review, 'ISO_9001', 'PREVIOUS_ACTIONS', '2027-03-15');
    const { actions } = data as ReviewFigureData['PREVIOUS_ACTIONS'];
    expect(actions.map((a) => a.id)).toEqual([done.id, open.id, cancelled.id]);
    expect(actions.map((a) => a.id)).not.toContain(onReview.id);
    expect(actions[0]).toEqual({
      id: done.id,
      subject: { type: 'MANAGEMENT_REVIEW', id: earlier.id },
      state: 'DONE',
      dueOn: '2026-12-01',
      doneOn: '2026-10-02',
      createdOn: '2026-10-01',
      archivedOn: null,
      // 19:00 UTC on 6 November is 00:30 on 7 November in Kolkata.
      settledOn: '2026-11-07',
    });
    expect(actions[1]).toMatchObject({ state: 'OPEN', settledOn: null });
    expect(actions[2]).toMatchObject({
      state: 'CANCELLED',
      settledOn: '2026-10-08',
      archivedOn: '2026-10-20',
    });
    // The same instants placed by another day function (UTC): the caller's localDay decides the day.
    const utc = await gather(review, 'ISO_9001', 'PREVIOUS_ACTIONS', '2027-03-15', dayIn('UTC'));
    expect((utc.data as ReviewFigureData['PREVIOUS_ACTIONS']).actions[0]!.settledOn).toBe(
      '2026-11-06',
    );
  });

  it('PREVIOUS_ACTIONS: a DONE action seeded without its step in the trail is placed by its creation day', async () => {
    const system = await newSystem();
    const earlier = await held(system, '2026-09-30', ['ISO_9001']);
    const review = await newReview(system);
    const seeded = await asAdmin((tx) =>
      r.isoActions.create(
        tx,
        newAction(
          { type: 'MANAGEMENT_REVIEW', id: earlier.id },
          { state: 'DONE', doneOn: day('2026-10-02') },
        ),
      ),
    );
    await stamp('iso_action', seeded.id, '2026-10-10T04:00:00.000Z');
    const { data } = await gather(review, 'ISO_9001', 'PREVIOUS_ACTIONS', '2027-03-15');
    expect((data as ReviewFigureData['PREVIOUS_ACTIONS']).actions).toEqual([
      expect.objectContaining({ id: seeded.id, settledOn: '2026-10-10' }),
    ]);
  });

  it('CONTEXT: the system’s items, archived ones too, their UPDATE days, and every climate decision by its event day', async () => {
    const system = await newSystem([w.riverbend]);
    const other = await newSystem();
    const review = await newReview(system);
    const item = (managementSystemId: string, kind: 'INTERNAL_ISSUE' | 'INTERESTED_PARTY') =>
      asAdmin((tx) =>
        r.contextItems.create(tx, {
          clientId: w.kestrel,
          managementSystemId,
          kind,
          text: 'Alloy prices',
          needs: kind === 'INTERESTED_PARTY' ? 'On-time delivery' : null,
          climateRelated: false,
          reviewedOn: null,
        }),
      );
    const issue = await item(system.id, 'INTERNAL_ISSUE');
    const party = await item(system.id, 'INTERESTED_PARTY');
    const elsewhere = await item(other.id, 'INTERNAL_ISSUE');
    await stamp('context_item', issue.id, '2026-05-01T04:00:00.000Z');
    await stamp('context_item', party.id, '2026-06-01T04:00:00.000Z', '2026-08-01T04:00:00.000Z');
    await event('context_item', issue.id, 'UPDATE', '2026-07-01T04:00:00.000Z', {
      text: 'Alloy and power prices',
    });
    await event('context_item', issue.id, 'CREATE' as 'UPDATE', '2026-05-01T04:00:00.000Z', {
      text: 'x',
    });
    await event('context_item', elsewhere.id, 'UPDATE', '2026-07-02T04:00:00.000Z', { text: 'x' });
    // Two decisions through the climate route: the first from undecided, the second a new rationale only, taken after
    // as-of with climateDecidedOn before it.
    await asAdmin(async (tx) => {
      const current = await r.managementSystems.require(tx, system.id);
      await r.managementSystems.update(tx, system.id, current.version, {
        climateChangeRelevant: true,
        climateChangeRationale: 'Flooding at Riverbend',
        climateDecidedOn: day('2026-06-10'),
      });
    });
    await event(
      'management_system',
      system.id,
      'UPDATE',
      '2026-06-10T04:00:00.000Z',
      {
        climateChangeRelevant: true,
        climateChangeRationale: 'Flooding at Riverbend',
        climateDecidedOn: '2026-06-10',
      },
      { climateChangeRelevant: null, climateChangeRationale: null, climateDecidedOn: null },
    );
    await event(
      'management_system',
      system.id,
      'UPDATE',
      '2027-04-02T04:00:00.000Z',
      { climateChangeRationale: 'Flooding and heat', climateDecidedOn: '2027-03-01' },
      { climateChangeRationale: 'Flooding at Riverbend', climateDecidedOn: '2026-06-10' },
    );
    // A rename is not a decision.
    await event('management_system', system.id, 'UPDATE', '2026-07-10T04:00:00.000Z', {
      name: 'Riverbend EMS',
    });
    const { data } = await gather(review, 'ISO_9001', 'CONTEXT_CHANGES', '2027-03-15');
    expect(data).toEqual({
      contextItems: [
        { id: issue.id, kind: 'INTERNAL_ISSUE', createdOn: '2026-05-01', archivedOn: null },
        {
          id: party.id,
          kind: 'INTERESTED_PARTY',
          createdOn: '2026-06-01',
          archivedOn: '2026-08-01',
        },
      ],
      contextChanges: [{ entityId: issue.id, on: '2026-07-01' }],
      system: { id: system.id, climateChangeRelevant: true, climateDecidedOn: '2026-06-10' },
      climateDecisions: [
        { entityId: system.id, on: '2026-06-10' },
        { entityId: system.id, on: '2027-04-02' },
      ],
    });
    // Records created after as-of are still gathered, with their days: the engine leaves them out of the window.
    const early = await gather(review, 'ISO_9001', 'CONTEXT_CHANGES', '2026-05-15');
    expect((early.data as ReviewFigureData['CONTEXT']).contextItems).toContainEqual({
      id: party.id,
      kind: 'INTERESTED_PARTY',
      createdOn: '2026-06-01',
      archivedOn: '2026-08-01',
    });
    expect(early.since).toBe('2026-04-01');
  });

  it('CONTEXT: a decision seeded with the system counts from the later of its date and the creation day', async () => {
    const seeded = await newSystem([], {
      climateChangeRelevant: false,
      climateChangeRationale: 'No exposure found',
      climateDecidedOn: day('2026-02-01'),
    });
    const review = await newReview(seeded);
    const first = await gather(review, 'ISO_9001', 'CONTEXT_CHANGES', '2027-03-15');
    expect((first.data as ReviewFigureData['CONTEXT']).climateDecisions).toEqual([
      { entityId: seeded.id, on: '2026-04-01' },
    ]);
    // A later decision gives back the seeded date in its before; the seeded one keeps its own day.
    await event(
      'management_system',
      seeded.id,
      'UPDATE',
      '2026-09-01T04:00:00.000Z',
      { climateChangeRelevant: true, climateDecidedOn: '2026-08-30' },
      { climateChangeRelevant: false, climateDecidedOn: '2026-05-05' },
    );
    const second = await gather(review, 'ISO_9001', 'CONTEXT_CHANGES', '2027-03-15');
    expect((second.data as ReviewFigureData['CONTEXT']).climateDecisions).toEqual([
      { entityId: seeded.id, on: '2026-05-05' },
      { entityId: seeded.id, on: '2026-09-01' },
    ]);
  });

  it('RISKS: the kinds the key reads, re-ratings without the residual clear, and treatment actions', async () => {
    const system = await newSystem();
    const review = await newReview(system);
    const items = await asAdmin(async (tx) => ({
      risk: await r.riskItems.create(tx, newRisk(system, { unitId: w.stonebridge })),
      opportunity: await r.riskItems.create(
        tx,
        newRisk(system, { kind: 'OPPORTUNITY', significant: false }),
      ),
      aspect: await r.riskItems.create(tx, newRisk(system, { kind: 'ASPECT', ...aspect })),
      hazard: await r.riskItems.create(tx, newRisk(system, { kind: 'HAZARD', ...hazard })),
      elsewhere: await r.riskItems.create(tx, newRisk(await newSystem())),
    }));
    const archived = await asAdmin((tx) =>
      r.riskItems.archive(tx, items.opportunity.id, items.opportunity.version),
    );
    await stamp('risk_item', items.risk.id, '2026-05-01T04:00:00.000Z');
    const treatment = await asAdmin((tx) =>
      r.isoActions.create(tx, newAction({ type: 'RISK_ITEM', id: items.risk.id })),
    );
    await asAdmin((tx) =>
      r.isoActions.create(tx, newAction({ type: 'RISK_ITEM', id: items.aspect.id })),
    );
    await event('risk_item', items.risk.id, 'UPDATE', '2026-07-01T04:00:00.000Z', {
      likelihood: 2,
      rating: 8,
    });
    await event('risk_item', items.risk.id, 'UPDATE', '2026-07-02T04:00:00.000Z', {
      residualLikelihood: 1,
    });
    // The residual clear a treatment action writes names its action: not a re-rating.
    await event('risk_item', items.risk.id, 'UPDATE', '2026-07-03T04:00:00.000Z', {
      residualLikelihood: null,
      residualSeverity: null,
      sourceActionId: treatment.id,
    });
    await event('risk_item', items.risk.id, 'UPDATE', '2026-07-04T04:00:00.000Z', {
      description: 'x',
    });
    await event('risk_item', items.aspect.id, 'UPDATE', '2026-07-05T04:00:00.000Z', {
      severity: 5,
    });

    // 9001 RISK_ACTIONS: risks and opportunities, the archived one too, on any unit.
    const nine = (await gather(review, 'ISO_9001', 'RISK_ACTIONS', '2027-03-15'))
      .data as ReviewFigureData['RISKS'];
    expect(nine.kinds).toEqual(['RISK', 'OPPORTUNITY']);
    expect(nine.riskItems).toEqual([
      {
        id: items.risk.id,
        kind: 'RISK',
        significant: true,
        createdOn: '2026-05-01',
        archivedOn: null,
      },
      {
        id: items.opportunity.id,
        kind: 'OPPORTUNITY',
        significant: false,
        createdOn: ist(archived.createdAt),
        archivedOn: ist(archived.archivedAt!),
      },
    ]);
    expect(nine.ratingChanges).toEqual([
      { entityId: items.risk.id, on: '2026-07-01' },
      { entityId: items.risk.id, on: '2026-07-02' },
    ]);
    expect(nine.treatmentActions.map((a) => a.id)).toEqual([treatment.id]);

    // A 14001 review: SIGNIFICANT_ASPECTS reads aspects only; RISKS_AND_OPPORTUNITIES reads no aspect.
    const fourteen = await newReview(system, { standards: ['ISO_14001'] });
    const aspects = (await gather(fourteen, 'ISO_14001', 'SIGNIFICANT_ASPECTS', '2027-03-15'))
      .data as typeof nine;
    expect(aspects.kinds).toEqual(['ASPECT']);
    expect(aspects.riskItems.map((i) => i.id)).toEqual([items.aspect.id]);
    expect(aspects.ratingChanges).toEqual([{ entityId: items.aspect.id, on: '2026-07-05' }]);
    expect(aspects.treatmentActions).toHaveLength(1);
    const risks = (await gather(fourteen, 'ISO_14001', 'RISKS_AND_OPPORTUNITIES', '2027-03-15'))
      .data as typeof nine;
    expect(risks.kinds).toEqual(['RISK', 'OPPORTUNITY']);
    expect(risks.riskItems.map((i) => i.id)).toEqual([items.risk.id, items.opportunity.id]);
    expect(risks.riskItems.map((i) => i.id)).not.toContain(items.hazard.id);
  });

  it('OBJECTIVES: the input’s standards, readings, the CLOSE step day, and the client’s FY start', async () => {
    const system = await newSystem();
    const review = await newReview(system);
    const objective = (standards: ('ISO_9001' | 'ISO_14001')[], closed: boolean) =>
      asAdmin((tx) =>
        r.objectives.create(tx, {
          clientId: w.kestrel,
          managementSystemId: system.id,
          standards,
          text: 'Cut customer complaints',
          target: 10,
          unitOfMeasure: 'complaints a year',
          baseline: 24,
          direction: 'DECREASE',
          readingRule: { kind: 'MONTHLY', day: 5, offsetMonths: 1 },
          riskItemIds: [],
          ownerId: w.ownerId,
          dueOn: day('2027-03-31'),
          closedOn: closed ? day('2027-03-01') : null,
          outcome: closed ? 'ACHIEVED' : null,
        }),
      );
    const closed = await objective(['ISO_9001'], true);
    const open = await objective(['ISO_14001', 'ISO_9001'], false);
    await objective(['ISO_14001'], false);
    await stamp('objective', closed.id, '2026-04-10T04:00:00.000Z');
    const reading = await asAdmin((tx) =>
      r.objectiveReadings.create(tx, {
        clientId: w.kestrel,
        objectiveId: open.id,
        periodStart: day('2026-05-01'),
        periodEnd: day('2026-05-31'),
        value: 3,
        note: null,
        recordedById: w.ownerId,
      }),
    );
    await stamp('objective_reading', reading.id, '2026-06-03T04:00:00.000Z');
    // Closed after as-of, with closedOn before it: placed by the CLOSE step's day.
    await event('objective', closed.id, 'TRANSITION', '2027-03-20T04:00:00.000Z', {
      action: 'CLOSE',
    });
    const data = (await gather(review, 'ISO_9001', 'OBJECTIVES', '2027-03-15'))
      .data as ReviewFigureData['OBJECTIVES'];
    expect(data.calendar).toEqual({ fyStartMonth: 4 });
    expect(data.objectives.map((o) => o.id)).toEqual([closed.id, open.id]);
    expect(data.objectives[0]).toEqual({
      id: closed.id,
      target: 10,
      baseline: 24,
      direction: 'DECREASE',
      readingRule: { kind: 'MONTHLY', day: 5, offsetMonths: 1 },
      dueOn: '2027-03-31',
      closedOn: '2027-03-01',
      outcome: 'ACHIEVED',
      createdOn: '2026-04-10',
      archivedOn: null,
      closeStepOn: '2027-03-20',
      readings: [],
    });
    expect(data.objectives[1]).toMatchObject({
      closeStepOn: null,
      readings: [
        {
          id: reading.id,
          periodStart: '2026-05-01',
          periodEnd: '2026-05-31',
          value: 3,
          createdOn: '2026-06-03',
          archivedOn: null,
        },
      ],
    });
  });

  it('NONCONFORMITIES and INCIDENTS: the input’s standards, VERIFY_NOT_EFFECTIVE days, actions; incidents not cancelled', async () => {
    const system = await newSystem();
    const review = await newReview(system);
    // NONCONFORMITIES is asked by both standards: a 9001-only review reads 9001's NCs only.
    const nineOnly = await newReview(system, { standards: ['ISO_9001'] });
    const incident = {
      occurredAt: '2026-07-31T20:00:00.000Z',
      location: 'Casthouse bay 2',
      type: 'INJURY' as const,
      outcome: 'LOST_TIME' as const,
      personCategory: 'CONTRACT_WORKER' as const,
      lostDays: 3,
      reportable: true,
      statutoryInstanceId: null,
      investigatorIds: [],
      workerParticipation: true,
    };
    const ncs = await asAdmin(async (tx) => ({
      nine: await r.nonconformities.create(tx, newNc(system, { unitId: w.stonebridge })),
      both: await r.nonconformities.create(
        tx,
        newNc(system, {
          standards: ['ISO_14001', 'ISO_9001'],
          source: 'INCIDENT',
          incident,
          unitId: w.riverbend,
        }),
      ),
      fourteen: await r.nonconformities.create(
        tx,
        newNc(system, {
          standards: ['ISO_14001'],
          source: 'INCIDENT',
          incident,
          unitId: w.stonebridge,
        }),
      ),
      cancelled: await r.nonconformities.create(
        tx,
        newNc(system, {
          standards: ['ISO_14001'],
          source: 'INCIDENT',
          incident,
          unitId: w.riverbend,
          state: 'CANCELLED',
          cancelReason: 'Raised twice',
        }),
      ),
      elsewhere: await r.nonconformities.create(tx, newNc(await newSystem())),
    }));
    await stamp(
      'nonconformity',
      ncs.nine.id,
      '2026-08-03T04:00:00.000Z',
      '2026-09-01T04:00:00.000Z',
    );
    const action = await asAdmin((tx) =>
      r.isoActions.create(tx, newAction({ type: 'NONCONFORMITY', id: ncs.nine.id })),
    );
    await event('nonconformity', ncs.nine.id, 'TRANSITION', '2026-08-20T04:00:00.000Z', {
      action: 'VERIFY_NOT_EFFECTIVE',
    });
    await event('nonconformity', ncs.nine.id, 'TRANSITION', '2026-08-25T04:00:00.000Z', {
      action: 'VERIFY',
    });
    const nine = (await gather(nineOnly, 'ISO_9001', 'NONCONFORMITIES', '2027-03-15'))
      .data as ReviewFigureData['NONCONFORMITIES'];
    expect(nine.nonconformities.map((n) => n.id)).toEqual([ncs.nine.id, ncs.both.id]);
    expect(nine.nonconformities[0]).toEqual({
      id: ncs.nine.id,
      state: 'OPEN',
      severity: 'MINOR',
      source: 'PROCESS',
      reportedOn: '2026-08-02',
      closedOn: null,
      createdOn: '2026-08-03',
      archivedOn: '2026-09-01',
    });
    expect(nine.notEffectiveSteps).toEqual([{ entityId: ncs.nine.id, on: '2026-08-20' }]);
    expect(nine.correctiveActions.map((a) => a.id)).toEqual([action.id]);

    const incidents = (await gather(review, 'ISO_14001', 'INCIDENTS', '2027-03-15'))
      .data as ReviewFigureData['INCIDENTS'];
    expect(incidents.timeZone).toBe('Asia/Kolkata');
    expect(incidents.nonconformities.map((n) => n.id)).toEqual([ncs.both.id, ncs.fourteen.id]);
    expect(incidents.nonconformities[0]).toEqual({
      id: ncs.both.id,
      state: 'OPEN',
      reportedOn: '2026-08-02',
      incident: { ...incident, investigatorIds: [] },
      createdOn: ist(ncs.both.createdAt),
      archivedOn: null,
    });
  });

  it('AUDIT_RESULTS: audits and findings of the input’s standards, with their REPORT and visit step days', async () => {
    const system = await newSystem();
    // AUDIT_RESULTS is asked by both standards: one review per standard.
    const review = await newReview(system, { standards: ['ISO_9001'] });
    const review14001 = await newReview(system, { standards: ['ISO_14001'] });
    const programme = await asAdmin((tx) =>
      r.auditProgrammes.create(tx, {
        clientId: w.kestrel,
        managementSystemId: system.id,
        fy: '2026-27',
        notes: null,
      }),
    );
    const audit = (clauseIds: string[], reported: boolean) =>
      asAdmin((tx) =>
        r.internalAudits.create(tx, {
          clientId: w.kestrel,
          programmeId: programme.id,
          title: 'Production audit',
          plannedStart: day('2026-06-01'),
          plannedEnd: day('2026-06-02'),
          clauseIds,
          unitIds: [w.stonebridge],
          leadAuditorId: w.approverId,
          auditorIds: [],
          auditeeIds: [],
          reportedToIds: reported ? [w.adminId] : [],
          independenceNote: null,
          state: reported ? 'REPORTED' : 'PLANNED',
          summary: reported ? 'Two findings' : null,
          reportedOn: reported ? day('2026-06-05') : null,
          cancelReason: null,
        }),
      );
    const nineAudit = await audit([w.clause9001], true);
    const fourteenAudit = await audit([w.clause14001], false);
    const anyAudit = await audit([], false);
    const external = (standardIds: string[], state: 'HELD' | 'PLANNED') =>
      asAdmin((tx) =>
        r.externalAudits.create(tx, {
          clientId: w.kestrel,
          managementSystemId: system.id,
          standardIds,
          type: 'SURVEILLANCE_1',
          body: 'Osprey Certification',
          leadAuditorName: null,
          startOn: day('2026-07-01'),
          endOn: day('2026-07-02'),
          recommendation: null,
          responseDueOn: null,
          state,
          cancelReason: null,
        }),
      );
    const visited = await external([w.iso9001], 'HELD');
    const planned = await external([w.iso9001], 'PLANNED');
    const otherStandard = await external([w.iso14001], 'HELD');
    const finding = (
      audit: { internalAuditId?: string; externalAuditId?: string },
      clauseIds: string[],
    ) =>
      asAdmin((tx) =>
        r.auditFindings.create(tx, {
          clientId: w.kestrel,
          internalAuditId: null,
          externalAuditId: null,
          type: 'OFI',
          clauseIds,
          unitId: null,
          description: 'Finding',
          nonconformityId: null,
          ...audit,
        }),
      );
    const f1 = await finding({ internalAuditId: nineAudit.id }, [w.clause9001]);
    const f2 = await finding({ internalAuditId: nineAudit.id }, [w.clause14001]);
    const f3 = await finding({ externalAuditId: visited.id }, []);
    await finding({ externalAuditId: otherStandard.id }, []);
    // Reported in the trail after the entered date; the visit recorded, then its end date edited later.
    await event('internal_audit', nineAudit.id, 'TRANSITION', '2026-06-20T04:00:00.000Z', {
      action: 'REPORT',
    });
    await event('external_audit', visited.id, 'TRANSITION', '2026-07-03T04:00:00.000Z', {
      action: 'RECORD_HELD',
      endOn: '2026-07-02',
    });
    await event('external_audit', visited.id, 'UPDATE', '2026-08-15T04:00:00.000Z', {
      endOn: '2026-07-04',
    });
    await event('external_audit', visited.id, 'UPDATE', '2026-09-15T04:00:00.000Z', { body: 'x' });
    const data = (await gather(review, 'ISO_9001', 'AUDIT_RESULTS', '2027-03-15'))
      .data as ReviewFigureData['AUDIT_RESULTS'];
    expect(data.internalAudits.map((a) => a.id)).toEqual([nineAudit.id, anyAudit.id]);
    expect(data.internalAudits.map((a) => a.id)).not.toContain(fourteenAudit.id);
    expect(data.internalAudits[0]).toEqual({
      id: nineAudit.id,
      state: 'REPORTED',
      reportedOn: '2026-06-05',
      createdOn: ist(nineAudit.createdAt),
      archivedOn: null,
      reportStepOn: '2026-06-20',
    });
    expect(data.internalAudits[1]).toMatchObject({ reportStepOn: null });
    expect(data.externalAudits).toEqual([
      {
        id: visited.id,
        state: 'HELD',
        endOn: '2026-07-02',
        createdOn: ist(visited.createdAt),
        archivedOn: null,
        heldStepOn: '2026-08-15',
      },
      {
        id: planned.id,
        state: 'PLANNED',
        endOn: '2026-07-02',
        createdOn: ist(planned.createdAt),
        archivedOn: null,
        heldStepOn: null,
      },
    ]);
    expect(data.findings).toEqual([
      {
        id: f1.id,
        auditId: nineAudit.id,
        type: 'OFI',
        createdOn: ist(f1.createdAt),
        archivedOn: null,
      },
      {
        id: f3.id,
        auditId: visited.id,
        type: 'OFI',
        createdOn: ist(f3.createdAt),
        archivedOn: null,
      },
    ]);
    expect(data.findings.map((f) => f.id)).not.toContain(f2.id);
    // A 14001 input: the 14001 audit and finding, the other standard's external audit, none of 9001's.
    const fourteen = (await gather(review14001, 'ISO_14001', 'AUDIT_RESULTS', '2027-03-15'))
      .data as typeof data;
    expect(fourteen.internalAudits.map((a) => a.id)).toEqual([fourteenAudit.id, anyAudit.id]);
    expect(fourteen.externalAudits.map((a) => a.id)).toEqual([otherStandard.id]);
    expect(fourteen.findings).toHaveLength(1);
  });

  it('COMPLIANCE_EVALUATION: instances on the system’s units, archived ones too, split by act kind, with firm settings', async () => {
    const riverbendOnly = await newSystem([w.riverbend]);
    const everyUnit = await newSystem();
    const review = await newReview(riverbendOnly, { standards: ['ISO_14001'] });
    const evaluationAssignment = await w.standardAssignment(
      w.riverbend,
      'ISO-COMPLIANCE-EVALUATION',
    );
    const otherAssignment = await w.standardAssignment(w.riverbend, null);
    const statuteRiverbend = await w.statuteAssignment(w.riverbend);
    const statuteStonebridge = await w.statuteAssignment(w.stonebridge);
    const statuteOsprey = await w.statuteAssignment(w.ospreyUnit);
    const evaluation = await newInstance(w.kestrel, w.riverbend, evaluationAssignment, {
      workflowState: 'APPROVED',
      completedOn: '2026-10-10',
    });
    const otherStandard = await newInstance(w.kestrel, w.riverbend, otherAssignment);
    const statute = await newInstance(w.kestrel, w.riverbend, statuteRiverbend);
    const stonebridge = await newInstance(w.kestrel, w.stonebridge, statuteStonebridge);
    await newInstance(w.osprey, w.ospreyUnit, statuteOsprey);
    await stamp(
      'compliance_instance',
      statute,
      '2026-09-01T04:00:00.000Z',
      '2026-10-01T04:00:00.000Z',
    );
    const data = (await gather(review, 'ISO_14001', 'COMPLIANCE_EVALUATION', '2027-03-15'))
      .data as ReviewFigureData['COMPLIANCE_EVALUATION'];
    expect(data.evaluations).toEqual([
      expect.objectContaining({
        id: evaluation,
        dueDate: '2026-10-15',
        workflowState: 'APPROVED',
        completedOn: '2026-10-10',
        archivedOn: null,
      }),
    ]);
    // Another STANDARD obligation is neither an evaluation nor statutory.
    expect(data.statutoryItems).toEqual([
      {
        instanceId: statute,
        criticality: 'HIGH',
        dueDate: '2026-10-15',
        workflowState: 'OPEN',
        pendingKind: null,
        completedOn: null,
        createdOn: '2026-09-01',
        archivedOn: '2026-10-01',
      },
    ]);
    expect(JSON.stringify(data)).not.toContain(otherStandard);
    expect(data.settings).toEqual({
      ...DEFAULT_FIRM_SETTINGS,
      isoRisk: DEFAULT_FIRM_SETTINGS.isoRisk,
    });
    // A system with no units covers every live unit of the client, never another client's.
    const wide = (
      await gather(
        await newReview(everyUnit, { standards: ['ISO_14001'] }),
        'ISO_14001',
        'COMPLIANCE_EVALUATION',
        '2027-03-15',
      )
    ).data as typeof data;
    expect(wide.statutoryItems.map((i) => i.instanceId).sort()).toEqual(
      [statute, stonebridge].sort(),
    );
  });

  it('refuses a review of another client’s system, and bad input', async () => {
    const system = await newSystem();
    const review = await newReview(system);
    expect(
      await code(
        asAdmin((tx) =>
          r.reviewFigures.gather(
            tx,
            { ...review, clientId: w.osprey },
            w.inputs.ISO_9001.PREVIOUS_ACTIONS!,
            day('2027-03-15'),
            ist,
          ),
        ),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await code(
        asAdmin((tx) =>
          r.reviewFigures.gather(
            tx,
            review,
            w.inputs.ISO_9001.PREVIOUS_ACTIONS!,
            '2027-02-30' as LocalDate,
            ist,
          ),
        ),
      ),
    ).toBe('VALIDATION');
  });
});

describe('reviewInputs.storeFigures', () => {
  const figures = {
    source: 'PREVIOUS_ACTIONS' as const,
    since: day('2026-04-01'),
    asOf: day('2027-03-15'),
    figures: [{ key: 'actionsOpen', value: 0, ids: [] }],
  };

  it('stores once: the three columns at now(), the version and notes kept; a second store is refused', async () => {
    const system = await newSystem();
    const review = await newReview(system);
    const [input] = await asAdmin((tx) => r.reviewInputs.addForReview(tx, review, [w.iso9001]));
    const noted = await asAdmin((tx) =>
      r.reviewInputs.update(tx, input!.id, input!.version, { notes: 'Read at the review' }),
    );
    const stored = await asAdmin((tx) =>
      r.reviewInputs.storeFigures(tx, noted.id, figures, '1.9.0'),
    );
    expect(stored).toMatchObject({
      sourceFigures: figures,
      figuresEngineVersion: '1.9.0',
      version: noted.version,
      notes: 'Read at the review',
    });
    expect(stored.figuresStoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(
      await code(asAdmin((tx) => r.reviewInputs.storeFigures(tx, noted.id, figures, '1.9.0'))),
    ).toBe('DUPLICATE');
    expect(await asAdmin((tx) => r.reviewInputs.require(tx, noted.id))).toEqual(stored);
    // Notes stay editable with the version read before the store.
    const renoted = await asAdmin((tx) =>
      r.reviewInputs.update(tx, noted.id, noted.version, { notes: 'Read again' }),
    );
    expect(renoted.sourceFigures).toEqual(figures);
  });

  it('refuses figures the contract rejects, an empty engine version, an archived row and an unknown id', async () => {
    const system = await newSystem();
    const review = await newReview(system);
    const [input, other] = await asAdmin((tx) =>
      r.reviewInputs.addForReview(tx, review, [w.iso9001]),
    );
    const store = (id: string, f: unknown, version = '1.9.0') =>
      code(asAdmin((tx) => r.reviewInputs.storeFigures(tx, id, f as typeof figures, version)));
    expect(await store(input!.id, { ...figures, since: '2027-04-01' })).toBe('VALIDATION');
    expect(await store(input!.id, { ...figures, extra: true })).toBe('VALIDATION');
    expect(await store(input!.id, figures, '')).toBe('VALIDATION');
    expect(await store(input!.id, figures, 'x'.repeat(41))).toBe('VALIDATION');
    await t.ownerQuery(`UPDATE review_input SET archived_at = now() WHERE id = $1`, [other!.id]);
    expect(await store(other!.id, figures)).toBe('NOT_FOUND');
    expect(await store('0190f5d2-0000-7000-8000-000000000000', figures)).toBe('NOT_FOUND');
    expect(await asAdmin((tx) => r.reviewInputs.require(tx, input!.id))).toMatchObject({
      sourceFigures: null,
    });
  });
});

describe('isoVisibleIds', () => {
  it('keeps the client’s rows a scope may read, archived ones too, per table', async () => {
    const system = await newSystem();
    const riverbendSystem = await newSystem([w.riverbend]);
    const { atRiverbend, atStonebridge, owned, objective, reading } = await asAdmin(async (tx) => {
      const objectiveMade = await r.objectives.create(tx, {
        clientId: w.kestrel,
        managementSystemId: riverbendSystem.id,
        standards: ['ISO_9001'],
        text: 'Cut scrap',
        target: 2,
        unitOfMeasure: '%',
        baseline: 4,
        direction: 'DECREASE',
        readingRule: { kind: 'MONTHLY', day: 5, offsetMonths: 1 },
        riskItemIds: [],
        ownerId: w.otherId,
        dueOn: day('2027-03-31'),
        closedOn: null,
        outcome: null,
      });
      return {
        atRiverbend: await r.riskItems.create(
          tx,
          newRisk(system, { unitId: w.riverbend, ownerId: w.otherId }),
        ),
        atStonebridge: await r.riskItems.create(
          tx,
          newRisk(system, { unitId: w.stonebridge, ownerId: w.otherId }),
        ),
        owned: await r.riskItems.create(
          tx,
          newRisk(system, { unitId: w.stonebridge, ownerId: w.ownerId }),
        ),
        objective: objectiveMade,
        reading: await r.objectiveReadings.create(tx, {
          clientId: w.kestrel,
          objectiveId: objectiveMade.id,
          periodStart: day('2026-05-01'),
          periodEnd: day('2026-05-31'),
          value: 3,
          note: null,
          recordedById: w.ownerId,
        }),
      };
    });
    await asAdmin((tx) => r.riskItems.archive(tx, atRiverbend.id, atRiverbend.version));
    const stonebridgeInstance = await newInstance(
      w.kestrel,
      w.stonebridge,
      await w.statuteAssignment(w.stonebridge),
      { periodStart: '2026-08-01', periodEnd: '2026-08-31' },
    );
    const riverbendInstance = await newInstance(
      w.kestrel,
      w.riverbend,
      await w.statuteAssignment(w.riverbend),
      { periodStart: '2026-08-01', periodEnd: '2026-08-31' },
    );
    const ospreyRisk = await asAdmin(async (tx) => {
      const osprey = await r.managementSystems.create(tx, {
        clientId: w.osprey,
        name: 'Osprey system',
        standardIds: [w.iso9001],
        scopeStatement: null,
        unitIds: [],
        status: 'IMPLEMENTING',
        reviewIntervalMonths: 12,
        climateChangeRelevant: null,
        climateChangeRationale: null,
        climateDecidedOn: null,
      });
      return r.riskItems.create(tx, {
        ...newRisk(system),
        clientId: w.osprey,
        managementSystemId: osprey.id,
      });
    });
    const refs = [
      {
        table: 'risk_item' as const,
        ids: [atStonebridge.id, ospreyRisk.id, atRiverbend.id, owned.id],
      },
      { table: 'instance' as const, ids: [stonebridgeInstance, riverbendInstance] },
      { table: 'management_system' as const, ids: [riverbendSystem.id, system.id] },
      { table: 'objective_reading' as const, ids: [reading.id] },
      { table: 'objective' as const, ids: [objective.id] },
      { table: 'iso_action' as const, ids: [] },
    ];
    const visible = (scope?: { unitIds: string[]; personId: string | null }) =>
      asAdmin((tx) => r.isoVisibleIds(tx, w.kestrel, refs, scope));
    // No scope: every id of the client, archived ones included; another client's id is dropped.
    expect(await visible()).toEqual([
      { table: 'risk_item', ids: [atStonebridge.id, atRiverbend.id, owned.id] },
      { table: 'instance', ids: [stonebridgeInstance, riverbendInstance] },
      { table: 'management_system', ids: [riverbendSystem.id, system.id] },
      { table: 'objective_reading', ids: [reading.id] },
      { table: 'objective', ids: [objective.id] },
      { table: 'iso_action', ids: [] },
    ]);
    // A Stonebridge reader: Stonebridge items, the system with no units (covers every unit), not the Riverbend
    // system's objective or its reading, and only the Stonebridge instance.
    expect(await visible({ unitIds: [w.stonebridge], personId: null })).toEqual([
      { table: 'risk_item', ids: [atStonebridge.id, owned.id] },
      { table: 'instance', ids: [stonebridgeInstance] },
      { table: 'management_system', ids: [system.id] },
      { table: 'objective_reading', ids: [] },
      { table: 'objective', ids: [] },
      { table: 'iso_action', ids: [] },
    ]);
    // A Riverbend reader named as owner: the archived Riverbend item, the item they own at Stonebridge; the instance
    // they own at Stonebridge stays hidden (instances are unit-only).
    expect(await visible({ unitIds: [w.riverbend], personId: w.ownerId })).toEqual([
      { table: 'risk_item', ids: [atRiverbend.id, owned.id] },
      { table: 'instance', ids: [riverbendInstance] },
      { table: 'management_system', ids: [riverbendSystem.id, system.id] },
      { table: 'objective_reading', ids: [reading.id] },
      { table: 'objective', ids: [objective.id] },
      { table: 'iso_action', ids: [] },
    ]);
    // The objective's owner reads it and its reading from any unit.
    expect(
      (await visible({ unitIds: [w.stonebridge], personId: w.otherId })).find(
        (ref) => ref.table === 'objective_reading',
      ),
    ).toEqual({ table: 'objective_reading', ids: [reading.id] });
    // Another client's context sees none of them.
    const ospreyView = await t.db.withTenant(
      { firmId, personId: w.ownerId, clientIds: [w.osprey], requestId: 'figures-test' },
      (tx) => r.isoVisibleIds(tx, w.kestrel, refs),
    );
    expect(ospreyView.every((ref) => ref.ids.length === 0)).toBe(true);
  });

  it('refuses an unknown table and a bad id', async () => {
    expect(
      await code(
        asAdmin((tx) => r.isoVisibleIds(tx, w.kestrel, [{ table: 'person' as never, ids: [] }])),
      ),
    ).toBe('VALIDATION');
    expect(
      await code(
        asAdmin((tx) => r.isoVisibleIds(tx, w.kestrel, [{ table: 'risk_item', ids: ['x'] }])),
      ),
    ).toBe('VALIDATION');
  });
});

describe('syncForReview', () => {
  const keysOf = async (review: ManagementReview) =>
    asAdmin(async (tx) => {
      const inputs = await r.reviewInputs.forReview(tx, review.id);
      const outputs = await r.reviewOutputs.forReview(tx, review.id);
      return {
        inputs: inputs.map((i) => i.inputDefId),
        outputs: outputs.map((o) => o.outputDefId),
      };
    });

  it('drops and re-adds a standard: the old row archived with its notes, a new live row', async () => {
    const system = await newSystem();
    const review = await newReview(system);
    const rows = await asAdmin(async (tx) => ({
      inputs: await r.reviewInputs.addForReview(tx, review, [w.iso9001, w.iso14001]),
      outputs: await r.reviewOutputs.addForReview(tx, review, [w.iso9001, w.iso14001]),
    }));
    const aspects = rows.inputs.find(
      (i) => i.inputDefId === w.inputs.ISO_14001.SIGNIFICANT_ASPECTS!.id,
    )!;
    await asAdmin((tx) =>
      r.reviewInputs.update(tx, aspects.id, aspects.version, { notes: 'Dust from bay 2' }),
    );
    const dropped = await asAdmin(async (tx) => ({
      inputs: await r.reviewInputs.syncForReview(tx, review, [w.iso9001]),
      outputs: await r.reviewOutputs.syncForReview(tx, review, [w.iso9001]),
    }));
    expect(dropped).toEqual({
      inputs: {
        added: [],
        removed: [
          'SIGNIFICANT_ASPECTS',
          'RISKS_AND_OPPORTUNITIES',
          'INCIDENTS',
          'COMPLIANCE_EVALUATION',
        ],
      },
      outputs: { added: [], removed: ['SUITABILITY'] },
    });
    const archived = await asAdmin((tx) => r.reviewInputs.require(tx, aspects.id));
    expect(archived).toMatchObject({ notes: 'Dust from bay 2', version: aspects.version + 2 });
    expect(archived.archivedAt).not.toBeNull();
    const readded = await asAdmin(async (tx) => ({
      inputs: await r.reviewInputs.syncForReview(tx, review, [w.iso9001, w.iso14001]),
      outputs: await r.reviewOutputs.syncForReview(tx, review, [w.iso9001, w.iso14001]),
    }));
    expect(readded).toEqual({
      inputs: {
        added: [
          'SIGNIFICANT_ASPECTS',
          'RISKS_AND_OPPORTUNITIES',
          'INCIDENTS',
          'COMPLIANCE_EVALUATION',
        ],
        removed: [],
      },
      outputs: { added: ['SUITABILITY'], removed: [] },
    });
    const live = await asAdmin((tx) => r.reviewInputs.forReview(tx, review.id));
    const again = live.find((i) => i.inputDefId === w.inputs.ISO_14001.SIGNIFICANT_ASPECTS!.id)!;
    expect(again.id).not.toBe(aspects.id);
    expect(again.notes).toBeNull();
    expect(live).toHaveLength(rows.inputs.length);
    // Nothing to do: no change.
    expect(
      await asAdmin((tx) => r.reviewInputs.syncForReview(tx, review, [w.iso14001, w.iso9001])),
    ).toEqual({ added: [], removed: [] });
  });

  it('keeps one row for a key two standards share, repointed to the remaining standard’s definition', async () => {
    const system = await newSystem();
    const review = await newReview(system);
    await asAdmin(async (tx) => {
      await r.reviewInputs.addForReview(tx, review, [w.iso9001, w.iso14001]);
      await r.reviewOutputs.addForReview(tx, review, [w.iso9001, w.iso14001]);
    });
    const before = await keysOf(review);
    // PREVIOUS_ACTIONS and IMPROVEMENT take 9001's definitions while both standards are in.
    expect(before.inputs).toContain(w.inputs.ISO_9001.PREVIOUS_ACTIONS!.id);
    expect(before.outputs).toContain(w.outputs['ISO_9001:IMPROVEMENT']);
    const row = (await asAdmin((tx) => r.reviewInputs.forReview(tx, review.id))).find(
      (i) => i.inputDefId === w.inputs.ISO_9001.PREVIOUS_ACTIONS!.id,
    )!;
    const changes = await asAdmin(async (tx) => ({
      inputs: await r.reviewInputs.syncForReview(tx, review, [w.iso14001]),
      outputs: await r.reviewOutputs.syncForReview(tx, review, [w.iso14001]),
    }));
    expect(changes).toEqual({
      inputs: {
        added: [],
        // NONCONFORMITIES and AUDIT_RESULTS are 14001's too: repointed, not removed.
        removed: ['CONTEXT_CHANGES', 'RISK_ACTIONS', 'CUSTOMER_SATISFACTION', 'OBJECTIVES'],
      },
      outputs: { added: [], removed: [] },
    });
    const after = await keysOf(review);
    expect(
      after.inputs.filter((id) => id === w.inputs.ISO_14001.PREVIOUS_ACTIONS!.id),
    ).toHaveLength(1);
    expect(after.inputs).not.toContain(w.inputs.ISO_9001.PREVIOUS_ACTIONS!.id);
    expect([...after.outputs].sort()).toEqual(
      [w.outputs['ISO_14001:IMPROVEMENT'], w.outputs['ISO_14001:SUITABILITY']].sort(),
    );
    // The same row, repointed.
    const repointed = await asAdmin((tx) => r.reviewInputs.require(tx, row.id));
    expect(repointed).toMatchObject({
      inputDefId: w.inputs.ISO_14001.PREVIOUS_ACTIONS!.id,
      archivedAt: null,
      version: row.version + 1,
    });
  });

  it('refuses a review that is not PLANNED, an archived one and bad standards', async () => {
    const system = await newSystem();
    const heldReview = await held(system, '2026-09-30', ['ISO_9001']);
    expect(
      await code(asAdmin((tx) => r.reviewInputs.syncForReview(tx, heldReview, [w.iso9001]))),
    ).toBe('VALIDATION');
    expect(
      await code(asAdmin((tx) => r.reviewOutputs.syncForReview(tx, heldReview, [w.iso9001]))),
    ).toBe('VALIDATION');
    const planned = await newReview(system);
    const archived = await asAdmin((tx) =>
      r.managementReviews.archive(tx, planned.id, planned.version),
    );
    expect(
      await code(asAdmin((tx) => r.reviewInputs.syncForReview(tx, archived, [w.iso9001]))),
    ).toBe('NOT_FOUND');
    const other = await newReview(system);
    expect(await code(asAdmin((tx) => r.reviewInputs.syncForReview(tx, other, [])))).toBe(
      'VALIDATION',
    );
    expect(
      await code(
        asAdmin((tx) =>
          r.reviewInputs.syncForReview(tx, { ...other, clientId: w.osprey }, [w.iso9001]),
        ),
      ),
    ).toBe('NOT_FOUND');
  });
});
