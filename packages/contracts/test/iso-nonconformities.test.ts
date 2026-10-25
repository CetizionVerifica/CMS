// The mock's ISO nonconformities and actions (docs/iso/model.md §3.10-3.12, §4.1): RAISE and every arrow with its
// guards, the incident rules (§3.11), maker-checker (§4 preamble), the locks (§6), actions on every subject with
// COMPLETE, CANCEL and REOPEN, the treatment-action control rule (§3.5), unit scope (plan §3.3), the role matrix (plan
// §3.2) and the audit trail (model §8).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../src/api/endpoints.js';
import type { IsoActionView, NonconformityView } from '../src/api/iso.js';
import { addDays } from '../src/mock/iso/common.js';
import type { IsoRow } from '../src/mock/store.js';
import {
  type App,
  base,
  BENGALURU,
  call,
  clause,
  fails,
  firmB,
  HARBOUR,
  type Id,
  isoApp,
  isoEvents,
  NORTHWIND,
  ok,
  PERSON,
  PUNE,
  seed,
  seedId,
  seedSystem,
  setFeatures,
  standardId,
  TODAY,
} from './iso-harness.js';

type Nc = NonconformityView;
type Action = IsoActionView;
type System = IsoRow<'managementSystems'>;
type NcRow = IsoRow<'nonconformities'>;
type Ref = { id: string; clientId: string };
type Page<T> = { items: T[]; nextCursor: string | null; total?: number };

let app: App;
/** Northwind, every unit, all three standards; Bengaluru only; ISO 9001 only; Harbour. */
let sys: System;
let blrSys: System;
let qualitySys: System;
let harbourSys: System;
/** A live statutory instance at Pune, a Harbour instance, and an ISO activity instance at Pune. */
let puneInstance: string;
let harbourInstance: string;
let standardInstance: string;

beforeAll(async () => {
  app = await isoApp();
  sys = seedSystem(app);
  blrSys = seedSystem(app, { unitIds: [BENGALURU] });
  qualitySys = seedSystem(app, { standards: ['ISO_9001'] });
  harbourSys = seedSystem(app, { clientId: HARBOUR });
  const data = firmB(app).data;
  const pune = data.instances.find(
    (i) => i.clientId === NORTHWIND && i.unitId === PUNE && i.archivedAt === null,
  )!;
  puneInstance = pune.id;
  harbourInstance = data.instances.find((i) => i.clientId === HARBOUR && i.archivedAt === null)!.id;
  const kindOf = (actId: string) => data.acts.find((a) => a.id === actId)?.kind ?? 'STATUTE';
  const activity = data.obligations.find((o) => kindOf(o.actId) === 'STANDARD')!;
  const assignment = data.assignments.find((a) => a.id === pune.assignmentId)!;
  const isoAssignment = { ...assignment, id: seedId(), obligationId: activity.id };
  data.assignments.push(isoAssignment);
  standardInstance = seedId();
  data.instances.push({ ...pune, id: standardInstance, assignmentId: isoAssignment.id });
});
afterAll(async () => {
  await app.close();
});

// ---------- helpers ----------

const NC = {
  source: 'PROCESS',
  severity: 'MINOR',
  standards: ['ISO_9001'],
  unitId: PUNE,
  description: 'Cartons labelled with the wrong batch code',
  ownerId: PERSON.sameer,
  approverId: PERSON.divya,
  dueOn: addDays(TODAY, 30),
};
const INCIDENT = {
  occurredAt: '2024-11-14T09:30:00Z',
  location: 'Dock 2',
  type: 'INJURY',
  outcome: 'FIRST_AID',
  reportable: false,
};
const ROOT_CAUSE = {
  containment: 'Held the batch at the dock',
  correction: 'Relabelled every carton',
  rootCauseMethod: 'FIVE_WHYS',
  rootCause: 'The label template was not locked',
  similarOccurrences: 'None on the other lines',
} as const;
const SUBMIT = { riskReview: 'None needed', systemChange: 'Template locked in the printer' };

const params = (r: Ref) => ({ clientId: r.clientId, id: r.id });
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const lastEvent = (id: string) => isoEvents(app, id).at(-1)!;
const ncRow = (id: string) => firmB(app).iso.nonconformities.find((n) => n.id === id)!;
const actionRow = (id: string) => firmB(app).iso.actions.find((a) => a.id === id)!;

function raise(
  body: Record<string, unknown> = {},
  as: string = PERSON.meera,
  system: System = sys,
): Promise<Nc> {
  return ok<Nc>(app, 'raiseIsoNonconformity', {
    as,
    params: { clientId: system.clientId },
    body: { managementSystemId: system.id, ...NC, ...body },
  });
}

const raiseCall = (body: Record<string, unknown>, as: string = PERSON.meera, system = sys) => ({
  as,
  params: { clientId: system.clientId },
  body: { managementSystemId: system.id, ...NC, ...body },
});

const getNc = (nc: Ref, as: string = PERSON.meera) =>
  ok<Nc>(app, 'getIsoNonconformity', { as, params: params(nc) });

/** A request on a nonconformity at its current version. */
const onNc = (nc: Ref, body: Record<string, unknown> = {}, as: string = PERSON.sameer) => ({
  as,
  params: params(nc),
  body: { version: ncRow(nc.id).version, ...body },
});

const ncStep = (id: Id, nc: Ref, body: Record<string, unknown> = {}, as: string = PERSON.sameer) =>
  ok<Nc>(app, id, onNc(nc, body, as));

const listNcs = (query: Record<string, string>, as: string = PERSON.meera) =>
  ok<Page<Nc>>(app, 'listIsoNonconformities', { as, query });

type SubjectType = Action['subject']['type'];
const subjectOf = (type: SubjectType, id: string) => ({ type, id });
const ncSubject = (nc: { id: string }) => subjectOf('NONCONFORMITY', nc.id);

function addAction(
  subject: { type: SubjectType; id: string },
  body: Record<string, unknown> = {},
  as: string = PERSON.meera,
  clientId: string = NORTHWIND,
): Promise<Action> {
  return ok<Action>(app, 'createIsoAction', {
    as,
    params: { clientId },
    body: {
      subject,
      text: 'Lock the label template',
      ownerId: PERSON.sameer,
      dueOn: addDays(TODAY, 14),
      ...body,
    },
  });
}

const addCall = (
  subject: { type: SubjectType; id: string },
  body: Record<string, unknown> = {},
  as: string = PERSON.meera,
  clientId: string = NORTHWIND,
) => ({
  as,
  params: { clientId },
  body: {
    subject,
    text: 'Do the work',
    ownerId: PERSON.sameer,
    dueOn: addDays(TODAY, 14),
    ...body,
  },
});

/** A request on an action at its current version. */
const onAction = (action: Ref, body: Record<string, unknown> = {}, as: string = PERSON.sameer) => ({
  as,
  params: params(action),
  body: { version: actionRow(action.id).version, ...body },
});

const actStep = (
  id: Id,
  action: Ref,
  body: Record<string, unknown> = {},
  as: string = PERSON.sameer,
) => ok<Action>(app, id, onAction(action, body, as));

const getAction = (action: Ref, as: string = PERSON.meera) =>
  ok<Action>(app, 'getIsoAction', { as, params: params(action) });

const listActions = (query: Record<string, string>, as: string = PERSON.meera) =>
  ok<Page<Action>>(app, 'listIsoActions', { as, query });

/** Raised (by meera) and taken to ACTIONS_PLANNED by its owner, with one OPEN action. */
async function planned(body: Record<string, unknown> = {}, effectivenessDueOn = TODAY) {
  const nc = await raise(body);
  await ncStep('addIsoNcRootCause', nc, ROOT_CAUSE);
  const action = await addAction(ncSubject(nc));
  await ncStep('planIsoNcActions', nc, { effectivenessDueOn });
  return { nc, action };
}

/** Taken on to AWAITING_VERIFICATION with its action DONE. */
async function submitted(body: Record<string, unknown> = {}, effectivenessDueOn = TODAY) {
  const { nc, action } = await planned(body, effectivenessDueOn);
  await actStep('completeIsoAction', action, { doneOn: TODAY });
  await ncStep('submitIsoNc', nc, SUBMIT);
  return { nc, action };
}

/** Taken on to CLOSED by its approver. */
async function closed(body: Record<string, unknown> = {}) {
  const { nc, action } = await submitted(body);
  await ncStep('verifyIsoNcEffective', nc, { effectivenessNote: 'No repeat' }, PERSON.divya);
  return { nc, action };
}

let seededNumber = 9000;
/** A nonconformity written straight into the store (sources and dates RAISE refuses). */
function seedNc(overrides: Partial<NcRow> = {}): NcRow {
  return seed(app, 'nonconformities', {
    ...base(),
    managementSystemId: sys.id,
    number: (seededNumber += 1),
    source: 'PROCESS',
    sourceInstanceId: null,
    raisedFromRiskItemId: null,
    severity: 'MINOR',
    standards: ['ISO_9001'],
    clauseIds: [],
    unitId: PUNE,
    description: 'Seeded nonconformity',
    reportedById: PERSON.kabir,
    reportedOn: addDays(TODAY, -40),
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
    ownerId: PERSON.sameer,
    approverId: PERSON.divya,
    dueOn: addDays(TODAY, 20),
    effectivenessDueOn: null,
    effectivenessNote: null,
    effective: null,
    closedOn: null,
    cancelReason: null,
    state: 'OPEN',
    incident: null,
    ...overrides,
  });
}

function seedRisk(overrides: Partial<IsoRow<'riskItems'>> = {}): IsoRow<'riskItems'> {
  return seed(app, 'riskItems', {
    ...base(),
    managementSystemId: sys.id,
    kind: 'RISK',
    unitId: PUNE,
    activity: 'Carton supply',
    description: 'One supplier makes every carton',
    impact: null,
    lifeCycleStages: [],
    controlType: null,
    routine: null,
    personsExposed: [],
    condition: null,
    assessedWith: null,
    likelihood: 3,
    severity: 4,
    residualLikelihood: 2,
    residualSeverity: 2,
    rating: 12,
    residualRating: 4,
    significant: true,
    significantOverride: null,
    significanceReason: null,
    obligationIds: [],
    climateRelated: false,
    ownerId: PERSON.sameer,
    reviewDueOn: addDays(TODAY, 90),
    lastReviewedOn: null,
    ...overrides,
  });
}

const HAZARD: Partial<IsoRow<'riskItems'>> = {
  kind: 'HAZARD',
  activity: 'Forklift loading',
  description: 'A forklift strikes a person in the dock',
  impact: 'Crush injury',
  routine: true,
  personsExposed: ['WORKER'],
  condition: 'NORMAL',
};

function seedObjective(overrides: Partial<IsoRow<'objectives'>> = {}): IsoRow<'objectives'> {
  return seed(app, 'objectives', {
    ...base(),
    managementSystemId: sys.id,
    standards: ['ISO_9001'],
    text: 'Fewer customer complaints',
    target: 5,
    unitOfMeasure: 'complaints a month',
    baseline: 12,
    direction: 'DECREASE',
    readingRule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    riskItemIds: [],
    ownerId: PERSON.sameer,
    dueOn: addDays(TODAY, 200),
    closedOn: null,
    outcome: null,
    ...overrides,
  });
}

function seedInternalAudit(
  overrides: Partial<IsoRow<'internalAudits'>> = {},
  system: System = sys,
): IsoRow<'internalAudits'> {
  const programme = seed(app, 'auditProgrammes', {
    ...base(system.clientId),
    managementSystemId: system.id,
    fy: '2024-25',
    notes: null,
  });
  return seed(app, 'internalAudits', {
    ...base(system.clientId),
    programmeId: programme.id,
    title: 'Dispatch audit',
    plannedStart: addDays(TODAY, -5),
    plannedEnd: addDays(TODAY, -4),
    clauseIds: [],
    unitIds: [],
    leadAuditorId: PERSON.sameer,
    auditorIds: [],
    auditeeIds: [],
    reportedToIds: [],
    independenceNote: null,
    state: 'IN_PROGRESS',
    summary: null,
    reportedOn: null,
    cancelReason: null,
    ...overrides,
  });
}

const REPORTED: Partial<IsoRow<'internalAudits'>> = {
  state: 'REPORTED',
  summary: 'Two observations',
  reportedOn: TODAY,
  reportedToIds: [PERSON.kabir],
};

function seedExternalAudit(
  overrides: Partial<IsoRow<'externalAudits'>> = {},
): IsoRow<'externalAudits'> {
  return seed(app, 'externalAudits', {
    ...base(),
    managementSystemId: sys.id,
    standardIds: [standardId(app, 'ISO_9001')],
    type: 'SURVEILLANCE_1',
    body: 'Fictional Certification Ltd',
    leadAuditorName: null,
    startOn: addDays(TODAY, -3),
    endOn: addDays(TODAY, -2),
    recommendation: null,
    responseDueOn: null,
    state: 'HELD',
    cancelReason: null,
    ...overrides,
  });
}

function seedFinding(
  audit: { internal?: string; external?: string },
  overrides: Partial<IsoRow<'findings'>> = {},
): IsoRow<'findings'> {
  return seed(app, 'findings', {
    ...base(),
    internalAuditId: audit.internal ?? null,
    externalAuditId: audit.external ?? null,
    type: 'OBSERVATION',
    clauseIds: [],
    unitId: null,
    description: 'Dispatch notes are not signed',
    nonconformityId: null,
    ...overrides,
  });
}

function seedReview(overrides: Partial<IsoRow<'managementReviews'>> = {}) {
  return seed(app, 'managementReviews', {
    ...base(),
    managementSystemId: sys.id,
    standards: ['ISO_9001'],
    plannedOn: addDays(TODAY, 10),
    heldOn: null,
    chairId: PERSON.sameer,
    attendeeIds: [],
    minutes: null,
    state: 'PLANNED',
    cancelReason: null,
    ...overrides,
  });
}

// ---------- RAISE ----------

describe('raiseIsoNonconformity', () => {
  it('raises an OPEN nonconformity with the next number, the reporter and today, audited as RAISE', async () => {
    const first = await raise();
    const second = await raise({ clauseIds: [clause('ISO_9001', '8.7')] }, PERSON.kabir);
    expect(second.number).toBe(first.number + 1);
    expect(second).toMatchObject({
      state: 'OPEN',
      reportedById: PERSON.kabir,
      reportedOn: TODAY,
      unitId: PUNE,
      effective: null,
      findingId: null,
      status: { timing: 'ON_TIME', overdueDays: null, effectivenessOverdueDays: null },
    });
    // The client admin may take the owner's steps as delegate, and cancel; meera (FA) neither.
    expect(second.allowedActions).toEqual(['ADD_ROOT_CAUSE', 'CANCEL']);
    expect(first.allowedActions).toEqual([]);
    const event = lastEvent(second.id);
    expect(event).toMatchObject({
      action: 'CREATE',
      entityType: 'nonconformity',
      actorId: PERSON.kabir,
      after: { action: 'RAISE', number: second.number, state: 'OPEN', ownerId: PERSON.sameer },
    });
    expect(event.after).not.toHaveProperty('description');
  });

  it('lets every role but viewer raise one for a unit they can see', async () => {
    for (const as of [PERSON.arjun, PERSON.nisha, PERSON.rohan, PERSON.divya, PERSON.sameer]) {
      const nc = await raise({}, as);
      expect(nc.reportedById).toBe(as);
    }
    await fails(app, 'raiseIsoNonconformity', raiseCall({}, PERSON.vikram), 'FORBIDDEN', 403);
    // Pune-only people cannot raise for Bengaluru, nor on a Bengaluru-only system.
    await fails(
      app,
      'raiseIsoNonconformity',
      raiseCall({ unitId: BENGALURU }, PERSON.nisha),
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'raiseIsoNonconformity',
      raiseCall({ unitId: null }, PERSON.rohan, blrSys),
      'NOT_FOUND',
      404,
    );
    // Another client's consultant, and another client's system.
    await fails(app, 'raiseIsoNonconformity', raiseCall({}, PERSON.leela), 'NOT_FOUND', 404);
    await fails(
      app,
      'raiseIsoNonconformity',
      { ...raiseCall({}), body: { ...raiseCall({}).body, managementSystemId: harbourSys.id } },
      'NOT_FOUND',
      404,
    );
  });

  it('refuses audit sources, which come only from findings', async () => {
    await fails(
      app,
      'raiseIsoNonconformity',
      raiseCall({ source: 'INTERNAL_AUDIT' }),
      'VALIDATION',
      400,
    );
  });

  it('checks the unit, standards, clauses, people, dates and linked records', async () => {
    const bad: [Record<string, unknown>, System?][] = [
      [{ unitId: PUNE }, blrSys], // not a unit of the system
      [{ standards: ['ISO_14001'] }, qualitySys], // not a standard of the system
      [{ clauseIds: [clause('ISO_14001', '10.2')] }], // a clause of another standard
      [{ ownerId: PERSON.nisha }], // an approver cannot own it
      [{ approverId: PERSON.rohan }], // an owner cannot approve it
      [{ unitId: BENGALURU, ownerId: PERSON.rohan }], // the owner does not cover the unit
      [{ ownerId: PERSON.gita }], // disabled
      [{ ownerId: PERSON.vikram }], // a viewer
      [{ approverId: PERSON.sameer }], // owner and approver are one person
      [{ dueOn: addDays(TODAY, -1) }],
      [{ sourceInstanceId: harbourInstance }],
      [{ raisedFromRiskItemId: seedId() }],
      [{ source: 'INCIDENT', incident: { ...INCIDENT }, unitId: null }],
      [{ source: 'INCIDENT' }], // no incident fields
      [{ incident: { ...INCIDENT } }], // incident fields on another source
    ];
    for (const [body, system] of bad) {
      await fails(
        app,
        'raiseIsoNonconformity',
        raiseCall(body, PERSON.meera, system),
        'VALIDATION',
        400,
      );
    }
    const risk = seedRisk();
    const nc = await raise({ sourceInstanceId: puneInstance, raisedFromRiskItemId: risk.id });
    expect(nc).toMatchObject({ sourceInstanceId: puneInstance, raisedFromRiskItemId: risk.id });
  });

  it('applies the incident rules: near miss, lost days, investigators and the statutory notice', async () => {
    const bad: Record<string, unknown>[] = [
      { source: 'NEAR_MISS', incident: { ...INCIDENT } }, // type is not NEAR_MISS
      { source: 'NEAR_MISS', incident: { ...INCIDENT, type: 'NEAR_MISS' } }, // outcome is not NONE
      { source: 'INCIDENT', incident: { ...INCIDENT, type: 'NEAR_MISS', outcome: 'NONE' } },
      { source: 'INCIDENT', incident: { ...INCIDENT, outcome: 'LOST_TIME' } }, // no lost days
      { source: 'INCIDENT', incident: { ...INCIDENT, lostDays: 2 } }, // lost days without LOST_TIME
      {
        source: 'INCIDENT',
        unitId: BENGALURU,
        incident: { ...INCIDENT, investigatorIds: [PERSON.rohan] },
      },
      {
        source: 'INCIDENT',
        unitId: BENGALURU,
        incident: { ...INCIDENT, statutoryInstanceId: puneInstance },
      },
      { source: 'INCIDENT', incident: { ...INCIDENT, statutoryInstanceId: standardInstance } },
      { source: 'INCIDENT', incident: { ...INCIDENT, statutoryInstanceId: harbourInstance } },
    ];
    for (const body of bad) {
      await fails(app, 'raiseIsoNonconformity', raiseCall(body), 'VALIDATION', 400);
    }
    const lostTime = await raise({
      source: 'INCIDENT',
      standards: ['ISO_45001'],
      incident: {
        ...INCIDENT,
        outcome: 'LOST_TIME',
        lostDays: 3,
        reportable: true,
        statutoryInstanceId: puneInstance,
        investigatorIds: [PERSON.rohan],
      },
    });
    expect(lostTime.incident).toMatchObject({
      outcome: 'LOST_TIME',
      lostDays: 3,
      personCategory: null,
      workerParticipation: false,
      investigatorIds: [PERSON.rohan],
    });
    expect(lastEvent(lostTime.id).after).toMatchObject({
      incident: { type: 'INJURY', outcome: 'LOST_TIME', reportable: true },
    });
    const nearMiss = await raise({
      source: 'NEAR_MISS',
      incident: { ...INCIDENT, type: 'NEAR_MISS', outcome: 'NONE' },
    });
    expect(nearMiss.incident?.type).toBe('NEAR_MISS');
  });
});

// ---------- reads ----------

describe('listIsoNonconformities and getIsoNonconformity', () => {
  let listSys: System;
  let pune: Nc;
  let blr: Nc;
  let unitless: Nc;
  let overdue: NcRow;
  let rohanNamed: Nc;

  beforeAll(async () => {
    listSys = seedSystem(app, { name: 'List system' });
    pune = await raise({ clauseIds: [clause('ISO_9001', '8.7')] }, PERSON.meera, listSys);
    blr = await raise(
      {
        source: 'INCIDENT',
        severity: 'MAJOR',
        standards: ['ISO_45001'],
        unitId: BENGALURU,
        description: 'A pallet fell from a rack',
        incident: { ...INCIDENT, type: 'DANGEROUS_OCCURRENCE', outcome: 'NONE' },
      },
      PERSON.meera,
      listSys,
    );
    unitless = await raise(
      { source: 'COMPLAINT', unitId: null, ownerId: PERSON.kabir, approverId: PERSON.nisha },
      PERSON.meera,
      listSys,
    );
    overdue = seedNc({ managementSystemId: listSys.id, number: 1, dueOn: addDays(TODAY, -10) });
    rohanNamed = await raise({ unitId: null, ownerId: PERSON.rohan }, PERSON.meera, blrSys);
  });

  const listed = async (query: Record<string, string>, as: string = PERSON.meera) =>
    ids((await listNcs({ managementSystemId: listSys.id, ...query }, as)).items);

  it('lists newest first and pages', async () => {
    expect(await listed({})).toEqual([unitless.id, blr.id, pune.id, overdue.id]);
    const page = await listNcs({ managementSystemId: listSys.id, limit: '2', count: 'true' });
    expect(page.total).toBe(4);
    expect(page.nextCursor).not.toBeNull();
    const next = await listNcs({
      managementSystemId: listSys.id,
      limit: '2',
      cursor: page.nextCursor!,
    });
    expect(ids(next.items)).toEqual([pune.id, overdue.id]);
  });

  it('applies every filter', async () => {
    expect(await listed({ unitId: BENGALURU })).toEqual([blr.id]);
    expect(await listed({ state: 'OPEN', source: 'INCIDENT' })).toEqual([blr.id]);
    expect(await listed({ severity: 'MAJOR' })).toEqual([blr.id]);
    expect(await listed({ standard: 'ISO_45001' })).toEqual([blr.id]);
    expect(await listed({ incident: 'true' })).toEqual([blr.id]);
    expect(await listed({ incident: 'false' })).toEqual([unitless.id, pune.id, overdue.id]);
    expect(await listed({ ownerId: 'me' }, PERSON.kabir)).toEqual([unitless.id]);
    expect(await listed({ approverId: PERSON.nisha })).toEqual([unitless.id]);
    expect(await listed({ overdue: 'true' })).toEqual([overdue.id]);
    expect(await listed({ overdue: 'false' })).toEqual([unitless.id, blr.id, pune.id]);
    expect(await listed({ q: 'pallet' })).toEqual([blr.id]);
    expect(await listed({ q: String(pune.number) })).toContain(pune.id);
    expect(await listed({ state: 'CLOSED' })).toEqual([]);
  });

  it('shows the timing of an overdue nonconformity', async () => {
    const view = await getNc(overdue);
    expect(view.status).toEqual({
      timing: 'OVERDUE',
      overdueDays: 10,
      effectivenessOverdueDays: null,
    });
  });

  it('keeps AP and OW to their units, except where the record names them (plan §3.3)', async () => {
    expect(await listed({}, PERSON.nisha)).toEqual([unitless.id, pune.id, overdue.id]);
    expect(await listed({}, PERSON.vikram)).toEqual([unitless.id, blr.id, pune.id, overdue.id]);
    await fails(
      app,
      'getIsoNonconformity',
      { as: PERSON.nisha, params: params(blr) },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'getIsoNonconformity',
      { as: PERSON.rohan, params: params(blr) },
      'NOT_FOUND',
      404,
    );
    // A Bengaluru-only system's nonconformity: hidden from Pune people unless it names them.
    const blrListed = async (as: string) =>
      ids((await listNcs({ managementSystemId: blrSys.id }, as)).items);
    expect(await blrListed(PERSON.rohan)).toContain(rohanNamed.id);
    expect(await blrListed(PERSON.nisha)).not.toContain(rohanNamed.id);
    expect((await getNc(rohanNamed, PERSON.rohan)).allowedActions).toEqual(['ADD_ROOT_CAUSE']);
    await fails(
      app,
      'getIsoNonconformity',
      { as: PERSON.nisha, params: params(rohanNamed) },
      'NOT_FOUND',
      404,
    );
  });

  it('reads one for every reader role, and 404 across clients', async () => {
    for (const as of [
      PERSON.meera,
      PERSON.arjun,
      PERSON.kabir,
      PERSON.divya,
      PERSON.sameer,
      PERSON.vikram,
    ]) {
      expect((await getNc(blr, as)).id).toBe(blr.id);
    }
    await fails(
      app,
      'getIsoNonconformity',
      { params: { clientId: HARBOUR, id: blr.id } },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'getIsoNonconformity',
      { params: { clientId: NORTHWIND, id: seedId() } },
      'NOT_FOUND',
      404,
    );
    await fails(app, 'listIsoNonconformities', { as: PERSON.leela }, 'NOT_FOUND', 404);
  });

  it('names the finding that raised it', async () => {
    const audit = seedExternalAudit();
    const nc = seedNc({ source: 'EXTERNAL_AUDIT' });
    const finding = seedFinding(
      { external: audit.id },
      { type: 'MINOR_NC', nonconformityId: nc.id },
    );
    expect((await getNc(nc)).findingId).toBe(finding.id);
  });
});

// ---------- field edits ----------

describe('updateIsoNonconformity', () => {
  it('lets the owner edit investigation fields, audited as UPDATE', async () => {
    const nc = await raise();
    const out = await ncStep('updateIsoNonconformity', nc, {
      description: 'Cartons on line 2 labelled with the wrong batch code',
      containment: 'Held the batch',
      clauseIds: [clause('ISO_9001', '8.7')],
    });
    expect(out.version).toBe(nc.version + 1);
    expect(lastEvent(nc.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'nonconformity',
      reason: null,
      after: { containment: 'Held the batch' },
    });
    // Same values again: nothing written.
    const again = await ncStep('updateIsoNonconformity', nc, { containment: 'Held the batch' });
    expect(again.version).toBe(out.version);
  });

  it('refuses work fields to anyone but the owner and a client admin', async () => {
    const nc = await raise();
    await ncStep('updateIsoNonconformity', nc, { correction: 'Relabelled' }, PERSON.kabir);
    for (const [as, code, status] of [
      [PERSON.meera, 'FORBIDDEN', 403],
      [PERSON.arjun, 'FORBIDDEN', 403],
      [PERSON.rohan, 'FORBIDDEN', 403],
      [PERSON.divya, 'FORBIDDEN', 403],
      [PERSON.vikram, 'FORBIDDEN', 403],
    ] as const) {
      await fails(app, 'updateIsoNonconformity', onNc(nc, { correction: 'x' }, as), code, status);
    }
  });

  it('treats owner, approver and dates as a reassignment or due-date change with a reason', async () => {
    const { nc } = await planned();
    const out = await ncStep(
      'updateIsoNonconformity',
      nc,
      {
        ownerId: PERSON.rohan,
        dueOn: addDays(TODAY, 40),
        reason: 'Line 2 moved to the night shift',
      },
      PERSON.kabir,
    );
    expect(out).toMatchObject({ ownerId: PERSON.rohan, dueOn: addDays(TODAY, 40) });
    const events = isoEvents(app, nc.id).slice(-2);
    expect(events.map((e) => e.action)).toEqual(['REASSIGN', 'DUE_DATE_CHANGE']);
    expect(events[0]).toMatchObject({
      before: { ownerId: PERSON.sameer },
      after: { ownerId: PERSON.rohan },
      reason: 'Line 2 moved to the night shift',
    });
    await ncStep(
      'updateIsoNonconformity',
      nc,
      { effectivenessDueOn: addDays(TODAY, 5), reason: 'Wait for the next run' },
      PERSON.kabir,
    );
    expect(lastEvent(nc.id)).toMatchObject({
      action: 'DUE_DATE_CHANGE',
      after: { effectivenessDueOn: addDays(TODAY, 5) },
    });
    // A consultant or firm admin may move dates and reassign (isoNc.reassign), but not work on it.
    await ncStep(
      'updateIsoNonconformity',
      nc,
      { dueOn: addDays(TODAY, 45), reason: 'Audit week' },
      PERSON.arjun,
    );
    expect(lastEvent(nc.id)).toMatchObject({
      action: 'DUE_DATE_CHANGE',
      actorId: PERSON.arjun,
      after: { dueOn: addDays(TODAY, 45) },
    });
    await fails(
      app,
      'updateIsoNonconformity',
      onNc(nc, { dueOn: addDays(TODAY, 46), correction: 'x', reason: 'Both' }, PERSON.meera),
      'FORBIDDEN',
      403,
    );
    // The owner may not reassign; a reason is needed.
    await fails(
      app,
      'updateIsoNonconformity',
      onNc(nc, { dueOn: addDays(TODAY, 50), reason: 'Later' }, PERSON.rohan),
      'FORBIDDEN',
      403,
    );
    const noReason = await call(
      app,
      'updateIsoNonconformity',
      onNc(nc, { dueOn: addDays(TODAY, 50) }, PERSON.kabir),
    );
    expect(noReason.status).toBe(422);
    // The effectiveness date moves but is not cleared or put in the past.
    for (const effectivenessDueOn of [null, addDays(TODAY, -1)]) {
      await fails(
        app,
        'updateIsoNonconformity',
        onNc(nc, { effectivenessDueOn, reason: 'x' }, PERSON.kabir),
        'VALIDATION',
        400,
      );
    }
  });

  it('lets FA and CO reassign as far as the endpoint table allows them', async () => {
    const nc = await raise();
    const request = onNc(nc, { approverId: PERSON.nisha, reason: 'Pune approver' }, PERSON.meera);
    if (ENDPOINTS.updateIsoNonconformity.roles.FIRM_ADMIN === undefined) {
      await fails(app, 'updateIsoNonconformity', request, 'FORBIDDEN', 403);
    } else {
      expect((await ok<Nc>(app, 'updateIsoNonconformity', request)).approverId).toBe(PERSON.nisha);
    }
  });

  it('checks the edited fields', async () => {
    const nc = await raise({ ownerId: PERSON.rohan });
    const doc = seed(app, 'documents', {
      ...base(),
      managementSystemId: sys.id,
      code: `QP-${seedId().slice(-4)}`,
      title: 'Labelling procedure',
      type: 'PROCEDURE',
      clauseIds: [],
      status: 'ACTIVE',
      currentRevisionId: null,
      ownerId: PERSON.sameer,
      approverId: PERSON.divya,
      reviewDueOn: null,
      lastReviewedOn: null,
      retention: null,
      issuer: null,
      externalRef: null,
    });
    const bad: Record<string, unknown>[] = [
      { unitId: BENGALURU }, // the owner (Pune only) does not cover Bengaluru
      { ownerId: PERSON.divya, reason: 'x' }, // not an owner role
      { approverId: PERSON.rohan, reason: 'x' }, // owner and approver are one person
      { dueOn: addDays(TODAY, -1), reason: 'x' }, // before reportedOn
      { disposition: 'SEGREGATION' }, // no authoriser
      { standards: ['ISO_27001'] }, // not a standard at all
      { standards: ['ISO_14001'], clauseIds: [clause('ISO_9001', '8.7')] }, // clause of a dropped standard
      { clauseIds: [clause('ISO_45001', '10.2')] }, // not one of its standards
      { sourceInstanceId: harbourInstance },
      { relatedRiskItemIds: [seedId()] },
      { changedDocumentIds: [seedId()] },
      { incident: { location: 'Dock 3' } }, // not an incident
      { effectivenessDueOn: addDays(TODAY, 5), reason: 'x' }, // PLAN_ACTIONS sets it
    ];
    for (const body of bad) {
      await fails(app, 'updateIsoNonconformity', onNc(nc, body, PERSON.kabir), 'VALIDATION', 400);
    }
    const out = await ncStep(
      'updateIsoNonconformity',
      nc,
      {
        standards: ['ISO_9001', 'ISO_14001'],
        disposition: 'SEGREGATION',
        dispositionAuthorisedById: PERSON.kabir,
        sourceInstanceId: puneInstance,
        changedDocumentIds: [doc.id],
        severity: 'MAJOR',
      },
      PERSON.kabir,
    );
    expect(out).toMatchObject({ disposition: 'SEGREGATION', severity: 'MAJOR' });
    // After ADD_ROOT_CAUSE the disposition is fixed, and the root cause cannot be cleared.
    await ncStep('addIsoNcRootCause', nc, ROOT_CAUSE, PERSON.rohan);
    await fails(
      app,
      'updateIsoNonconformity',
      onNc(nc, { disposition: 'CONCESSION' }, PERSON.rohan),
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'updateIsoNonconformity',
      onNc(nc, { rootCause: null }, PERSON.rohan),
      'VALIDATION',
      400,
    );
  });

  it('checks incident edits and rechecks people when the unit moves', async () => {
    const nc = await raise({
      source: 'INCIDENT',
      standards: ['ISO_45001'],
      ownerId: PERSON.sameer,
      incident: { ...INCIDENT, investigatorIds: [PERSON.sameer] },
    });
    const out = await ncStep('updateIsoNonconformity', nc, {
      incident: { outcome: 'LOST_TIME', lostDays: 4, statutoryInstanceId: puneInstance },
    });
    expect(out.incident).toMatchObject({ outcome: 'LOST_TIME', lostDays: 4, type: 'INJURY' });
    for (const incident of [
      { outcome: 'MEDICAL_TREATMENT' }, // lost days left over
      { investigatorIds: [PERSON.sameer, PERSON.vikram] },
      { statutoryInstanceId: standardInstance },
    ]) {
      await fails(app, 'updateIsoNonconformity', onNc(nc, { incident }), 'VALIDATION', 400);
    }
    // Moving to Bengaluru: the Pune statutory instance no longer fits; an incident keeps a unit.
    await fails(app, 'updateIsoNonconformity', onNc(nc, { unitId: BENGALURU }), 'VALIDATION', 400);
    await fails(app, 'updateIsoNonconformity', onNc(nc, { unitId: null }), 'VALIDATION', 400);
    await ncStep('updateIsoNonconformity', nc, {
      incident: { statutoryInstanceId: null, investigatorIds: [PERSON.rohan] },
    });
    await fails(app, 'updateIsoNonconformity', onNc(nc, { unitId: BENGALURU }), 'VALIDATION', 400);
  });

  it('refuses a severity change on a finding nonconformity, a stale version, and a closed or cancelled one', async () => {
    const audit = seedExternalAudit();
    const fromFinding = seedNc({ source: 'EXTERNAL_AUDIT' });
    seedFinding({ external: audit.id }, { type: 'MINOR_NC', nonconformityId: fromFinding.id });
    await fails(
      app,
      'updateIsoNonconformity',
      onNc(fromFinding, { severity: 'MAJOR' }),
      'VALIDATION',
      400,
    );
    const nc = await raise();
    await fails(
      app,
      'updateIsoNonconformity',
      { as: PERSON.sameer, params: params(nc), body: { version: nc.version + 5, correction: 'x' } },
      'STALE_VERSION',
      409,
    );
    const { nc: done } = await closed();
    const refused = await fails(
      app,
      'updateIsoNonconformity',
      onNc(done, { correction: 'x' }),
      'INVALID_TRANSITION',
      409,
    );
    expect(refused.error.details).toEqual({
      entity: 'nonconformity',
      from: 'CLOSED',
      action: 'UPDATE',
    });
    await ncStep('cancelIsoNc', nc, { reason: 'Raised twice' }, PERSON.divya);
    await fails(
      app,
      'updateIsoNonconformity',
      onNc(nc, { correction: 'x' }),
      'INVALID_TRANSITION',
      409,
    );
  });
});

// ---------- the §4.1 machine ----------

describe('ADD_ROOT_CAUSE', () => {
  it('moves OPEN to ROOT_CAUSE_FOUND for the owner, saving the fields sent', async () => {
    const nc = await raise();
    const out = await ncStep('addIsoNcRootCause', nc, ROOT_CAUSE);
    expect(out).toMatchObject({ state: 'ROOT_CAUSE_FOUND', ...ROOT_CAUSE });
    expect(out.allowedActions).toEqual(['PLAN_ACTIONS', 'SUBMIT_NO_ACTION']);
    const event = lastEvent(nc.id);
    expect(event).toMatchObject({
      action: 'TRANSITION',
      after: { action: 'ADD_ROOT_CAUSE', state: 'ROOT_CAUSE_FOUND' },
      before: { state: 'OPEN' },
    });
    expect(event.after).not.toHaveProperty('delegated');
  });

  it('lets a client admin take it as delegate, and refuses the others', async () => {
    const nc = await raise();
    for (const as of [PERSON.meera, PERSON.arjun, PERSON.divya, PERSON.rohan, PERSON.vikram]) {
      await fails(app, 'addIsoNcRootCause', onNc(nc, ROOT_CAUSE, as), 'FORBIDDEN', 403);
    }
    await ncStep('addIsoNcRootCause', nc, ROOT_CAUSE, PERSON.kabir);
    expect(lastEvent(nc.id).after).toMatchObject({ delegated: true });
    await fails(app, 'addIsoNcRootCause', onNc(nc, ROOT_CAUSE), 'INVALID_TRANSITION', 409);
  });

  it('names every missing field, and needs a risk review for an incident', async () => {
    const nc = await raise({ containment: 'Held', correction: 'Fixed' });
    const missing = await fails(app, 'addIsoNcRootCause', onNc(nc), 'VALIDATION', 400);
    const paths = (missing.error.details!.issues as { path: string[] }[]).map((i) => i.path[1]);
    expect(paths).toEqual(['rootCauseMethod', 'rootCause', 'similarOccurrences']);
    await fails(
      app,
      'addIsoNcRootCause',
      onNc(nc, { ...ROOT_CAUSE, disposition: 'CORRECTION' }),
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'addIsoNcRootCause',
      { as: PERSON.sameer, params: params(nc), body: { version: 99, ...ROOT_CAUSE } },
      'STALE_VERSION',
      409,
    );
    const incident = await raise({ source: 'INCIDENT', incident: { ...INCIDENT } });
    await fails(app, 'addIsoNcRootCause', onNc(incident, ROOT_CAUSE), 'VALIDATION', 400);
    const risk = seedRisk({ ...HAZARD, kind: 'HAZARD' });
    // Without worker participation it still goes through (the API only warns).
    const out = await ncStep('addIsoNcRootCause', incident, {
      ...ROOT_CAUSE,
      relatedRiskItemIds: [risk.id],
      disposition: 'CORRECTION',
      dispositionAuthorisedById: PERSON.kabir,
    });
    expect(out).toMatchObject({ state: 'ROOT_CAUSE_FOUND', relatedRiskItemIds: [risk.id] });
    const reviewed = await raise({
      source: 'NEAR_MISS',
      incident: { ...INCIDENT, type: 'NEAR_MISS', outcome: 'NONE' },
    });
    await ncStep('addIsoNcRootCause', reviewed, {
      ...ROOT_CAUSE,
      riskReview: 'Rack guards are adequate',
    });
  });
});

describe('PLAN_ACTIONS', () => {
  it('needs an OPEN action and sets the effectiveness date', async () => {
    const nc = await raise();
    await ncStep('addIsoNcRootCause', nc, ROOT_CAUSE);
    await fails(
      app,
      'planIsoNcActions',
      onNc(nc, { effectivenessDueOn: TODAY }),
      'VALIDATION',
      400,
    );
    const cancelled = await addAction(ncSubject(nc));
    await actStep('cancelIsoAction', cancelled, { reason: 'Duplicate' }, PERSON.divya);
    await fails(
      app,
      'planIsoNcActions',
      onNc(nc, { effectivenessDueOn: TODAY }),
      'VALIDATION',
      400,
    );
    await addAction(ncSubject(nc));
    await fails(
      app,
      'planIsoNcActions',
      onNc(nc, { effectivenessDueOn: addDays(TODAY, -1) }),
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'planIsoNcActions',
      onNc(nc, { effectivenessDueOn: TODAY }, PERSON.meera),
      'FORBIDDEN',
      403,
    );
    const out = await ncStep(
      'planIsoNcActions',
      nc,
      { effectivenessDueOn: addDays(TODAY, 30) },
      PERSON.kabir,
    );
    expect(out).toMatchObject({ state: 'ACTIONS_PLANNED', effectivenessDueOn: addDays(TODAY, 30) });
    expect(out.allowedActions).toEqual(['SUBMIT', 'CANCEL']);
    expect(lastEvent(nc.id).after).toMatchObject({ action: 'PLAN_ACTIONS', delegated: true });
    await fails(
      app,
      'planIsoNcActions',
      onNc(nc, { effectivenessDueOn: TODAY }),
      'INVALID_TRANSITION',
      409,
    );
  });
});

describe('SUBMIT_NO_ACTION', () => {
  const NO_ACTION = { noActionReason: 'A one-off slip', ...SUBMIT };

  it('sends a minor case to verification', async () => {
    const nc = await raise();
    await fails(app, 'submitIsoNcNoAction', onNc(nc, NO_ACTION), 'INVALID_TRANSITION', 409);
    await ncStep('addIsoNcRootCause', nc, ROOT_CAUSE);
    const out = await ncStep('submitIsoNcNoAction', nc, NO_ACTION);
    expect(out).toMatchObject({ state: 'AWAITING_VERIFICATION', noActionReason: 'A one-off slip' });
    expect(lastEvent(nc.id).after).toMatchObject({ action: 'SUBMIT_NO_ACTION' });
  });

  it('is refused for MAJOR, EXTERNAL_AUDIT, LOST_TIME and FATALITY', async () => {
    const major = await raise({ severity: 'MAJOR' });
    await ncStep('addIsoNcRootCause', major, ROOT_CAUSE);
    expect((await getNc(major, PERSON.sameer)).allowedActions).toEqual(['PLAN_ACTIONS']);
    const refused = await fails(
      app,
      'submitIsoNcNoAction',
      onNc(major, NO_ACTION),
      'VALIDATION',
      400,
    );
    expect(refused.error.details!.issues).toEqual([
      { path: ['body', 'severity'], message: 'A MAJOR nonconformity needs corrective actions' },
    ]);
    const external = seedNc({ source: 'EXTERNAL_AUDIT', state: 'ROOT_CAUSE_FOUND', ...ROOT_CAUSE });
    await fails(app, 'submitIsoNcNoAction', onNc(external, NO_ACTION), 'VALIDATION', 400);
    for (const incident of [
      { ...INCIDENT, outcome: 'LOST_TIME', lostDays: 2 },
      { ...INCIDENT, outcome: 'FATALITY' },
    ]) {
      const nc = await raise({ source: 'INCIDENT', incident, unitId: PUNE });
      await ncStep('addIsoNcRootCause', nc, { ...ROOT_CAUSE, riskReview: 'Reviewed' });
      const out = await fails(app, 'submitIsoNcNoAction', onNc(nc, NO_ACTION), 'VALIDATION', 400);
      expect(out.error.details!.issues).toEqual([
        {
          path: ['body', 'incident', 'outcome'],
          message: expect.stringContaining(incident.outcome),
        },
      ]);
    }
  });

  it('is refused once the nonconformity was found not effective', async () => {
    const nc = await raise();
    await ncStep('addIsoNcRootCause', nc, ROOT_CAUSE);
    await ncStep('submitIsoNcNoAction', nc, NO_ACTION);
    await ncStep(
      'verifyIsoNcNotEffective',
      nc,
      { reason: 'It happened again', backTo: 'OPEN' },
      PERSON.divya,
    );
    await ncStep('addIsoNcRootCause', nc, ROOT_CAUSE);
    await fails(app, 'submitIsoNcNoAction', onNc(nc, NO_ACTION), 'VALIDATION', 400);
  });
});

describe('SUBMIT', () => {
  it('needs every action DONE or CANCELLED, one DONE, and the risk review and system change', async () => {
    const { nc, action } = await planned();
    await fails(app, 'submitIsoNc', onNc(nc, SUBMIT), 'VALIDATION', 400); // the action is OPEN
    await actStep('cancelIsoAction', action, { reason: 'Not needed' }, PERSON.divya);
    await fails(app, 'submitIsoNc', onNc(nc, SUBMIT), 'VALIDATION', 400); // every action cancelled
    const done = await addAction(ncSubject(nc));
    await actStep('completeIsoAction', done, { doneOn: TODAY });
    await fails(app, 'submitIsoNc', onNc(nc), 'VALIDATION', 400); // no risk review or system change
    await fails(app, 'submitIsoNc', onNc(nc, SUBMIT, PERSON.rohan), 'FORBIDDEN', 403);
    const out = await ncStep('submitIsoNc', nc, SUBMIT);
    expect(out).toMatchObject({ state: 'AWAITING_VERIFICATION', ...SUBMIT });
    expect(out.allowedActions).toEqual([]);
    expect((await getNc(nc, PERSON.divya)).allowedActions).toEqual([
      'VERIFY_EFFECTIVE',
      'VERIFY_NOT_EFFECTIVE',
      'CANCEL',
    ]);
    await fails(app, 'submitIsoNc', onNc(nc, SUBMIT), 'INVALID_TRANSITION', 409);
  });
});

describe('VERIFY_EFFECTIVE and VERIFY_NOT_EFFECTIVE', () => {
  it('closes it for the approver, not before the effectiveness date', async () => {
    const { nc } = await submitted({}, addDays(TODAY, 3));
    expect((await getNc(nc, PERSON.divya)).allowedActions).toEqual([
      'VERIFY_NOT_EFFECTIVE',
      'CANCEL',
    ]);
    await fails(
      app,
      'verifyIsoNcEffective',
      onNc(nc, { effectivenessNote: 'Fine' }, PERSON.divya),
      'VALIDATION',
      400,
    );
    await ncStep(
      'updateIsoNonconformity',
      nc,
      { effectivenessDueOn: TODAY, reason: 'Checked early on the audit' },
      PERSON.kabir,
    );
    for (const as of [PERSON.meera, PERSON.arjun, PERSON.nisha, PERSON.sameer, PERSON.vikram]) {
      await fails(
        app,
        'verifyIsoNcEffective',
        onNc(nc, { effectivenessNote: 'Fine' }, as),
        'FORBIDDEN',
        403,
      );
    }
    const out = await ncStep(
      'verifyIsoNcEffective',
      nc,
      { effectivenessNote: 'No repeat' },
      PERSON.divya,
    );
    expect(out).toMatchObject({
      state: 'CLOSED',
      effective: true,
      closedOn: TODAY,
      effectivenessNote: 'No repeat',
      status: { timing: 'CLOSED' },
    });
    expect(lastEvent(nc.id).after).not.toHaveProperty('delegated');
    expect(out.allowedActions).toEqual([]);
    expect((await getNc(nc, PERSON.kabir)).allowedActions).toEqual(['REOPEN']);
    await fails(
      app,
      'verifyIsoNcEffective',
      onNc(nc, { effectivenessNote: 'Again' }, PERSON.divya),
      'INVALID_TRANSITION',
      409,
    );
  });

  it('lets a client admin verify as delegate unless they took a maker step (plan §7 item 6)', async () => {
    // kabir takes ADD_ROOT_CAUSE as delegate: he cannot verify; divya can.
    const nc = await raise();
    await ncStep('addIsoNcRootCause', nc, ROOT_CAUSE, PERSON.kabir);
    const action = await addAction(ncSubject(nc));
    await ncStep('planIsoNcActions', nc, { effectivenessDueOn: TODAY });
    await actStep('completeIsoAction', action, { doneOn: TODAY });
    await ncStep('submitIsoNc', nc, SUBMIT);
    expect((await getNc(nc, PERSON.kabir)).allowedActions).toEqual(['CANCEL']);
    await fails(
      app,
      'verifyIsoNcEffective',
      onNc(nc, { effectivenessNote: 'Fine' }, PERSON.kabir),
      'FORBIDDEN',
      403,
    );
    await fails(
      app,
      'verifyIsoNcNotEffective',
      onNc(nc, { reason: 'Not fixed', backTo: 'OPEN' }, PERSON.kabir),
      'FORBIDDEN',
      403,
    );
    // kabir takes SUBMIT: he cannot verify either.
    const { nc: other, action: done } = await planned();
    await actStep('completeIsoAction', done, { doneOn: TODAY });
    await ncStep('submitIsoNc', other, SUBMIT, PERSON.kabir);
    await fails(
      app,
      'verifyIsoNcEffective',
      onNc(other, { effectivenessNote: 'Fine' }, PERSON.kabir),
      'FORBIDDEN',
      403,
    );
    // After VERIFY_NOT_EFFECTIVE his earlier steps no longer count.
    await ncStep(
      'verifyIsoNcNotEffective',
      nc,
      { reason: 'Not fixed', backTo: 'OPEN' },
      PERSON.divya,
    );
    await ncStep('addIsoNcRootCause', nc, ROOT_CAUSE);
    const fresh = await addAction(ncSubject(nc));
    await ncStep('planIsoNcActions', nc, { effectivenessDueOn: TODAY });
    await actStep('completeIsoAction', fresh, { doneOn: TODAY });
    await ncStep('submitIsoNc', nc);
    expect((await getNc(nc, PERSON.kabir)).allowedActions).toContain('VERIFY_EFFECTIVE');
    const out = await ncStep(
      'verifyIsoNcEffective',
      nc,
      { effectivenessNote: 'Fine now' },
      PERSON.kabir,
    );
    expect(out.state).toBe('CLOSED');
  });

  it('a client admin who took no maker step verifies as delegate', async () => {
    const { nc } = await submitted();
    const out = await ncStep(
      'verifyIsoNcEffective',
      nc,
      { effectivenessNote: 'Fine' },
      PERSON.kabir,
    );
    expect(out.state).toBe('CLOSED');
    expect(lastEvent(nc.id).after).toMatchObject({ action: 'VERIFY_EFFECTIVE', delegated: true });
  });

  it('sends it back to OPEN, clearing the effectiveness date', async () => {
    const { nc } = await submitted({}, addDays(TODAY, 2));
    await fails(
      app,
      'verifyIsoNcNotEffective',
      onNc(nc, { backTo: 'OPEN' }, PERSON.divya),
      'REASON_REQUIRED',
      422,
    );
    const out = await ncStep(
      'verifyIsoNcNotEffective',
      nc,
      { reason: 'The root cause was wrong', backTo: 'OPEN' },
      PERSON.divya,
    );
    expect(out).toMatchObject({ state: 'OPEN', effective: false, effectivenessDueOn: null });
    expect(lastEvent(nc.id)).toMatchObject({
      action: 'TRANSITION',
      reason: 'The root cause was wrong',
      after: { action: 'VERIFY_NOT_EFFECTIVE', state: 'OPEN' },
    });
    await fails(
      app,
      'verifyIsoNcNotEffective',
      onNc(nc, { reason: 'x', backTo: 'OPEN' }, PERSON.divya),
      'INVALID_TRANSITION',
      409,
    );
  });

  it('back to ACTIONS_PLANNED: a new date after today, a new action DONE before SUBMIT, no VERIFY_EFFECTIVE before the date', async () => {
    const { nc } = await submitted();
    for (const body of [
      { reason: 'Repeat', backTo: 'ACTIONS_PLANNED' },
      { reason: 'Repeat', backTo: 'ACTIONS_PLANNED', effectivenessDueOn: TODAY },
      { reason: 'Repeat', backTo: 'OPEN', effectivenessDueOn: addDays(TODAY, 3) },
    ]) {
      await fails(app, 'verifyIsoNcNotEffective', onNc(nc, body, PERSON.divya), 'VALIDATION', 400);
    }
    const out = await ncStep(
      'verifyIsoNcNotEffective',
      nc,
      {
        reason: 'A repeat on line 3',
        backTo: 'ACTIONS_PLANNED',
        effectivenessDueOn: addDays(TODAY, 10),
      },
      PERSON.divya,
    );
    expect(out).toMatchObject({
      state: 'ACTIONS_PLANNED',
      effective: false,
      effectivenessDueOn: addDays(TODAY, 10),
    });
    // The old action is DONE, but none created since then.
    await fails(app, 'submitIsoNc', onNc(nc), 'VALIDATION', 400);
    const fresh = await addAction(ncSubject(nc), { text: 'Guard the label printer' });
    await fails(app, 'submitIsoNc', onNc(nc), 'VALIDATION', 400);
    await actStep('completeIsoAction', fresh, { doneOn: TODAY });
    await ncStep('submitIsoNc', nc);
    await fails(
      app,
      'verifyIsoNcEffective',
      onNc(nc, { effectivenessNote: 'Fine' }, PERSON.divya),
      'VALIDATION',
      400,
    );
  });
});

describe('CANCEL and REOPEN', () => {
  it('cancels for the approver or a client admin, with a reason, and then locks it', async () => {
    const nc = await raise();
    for (const as of [PERSON.meera, PERSON.arjun, PERSON.sameer, PERSON.vikram]) {
      await fails(app, 'cancelIsoNc', onNc(nc, { reason: 'x' }, as), 'FORBIDDEN', 403);
    }
    const nisha = await raise({ approverId: PERSON.nisha });
    await fails(app, 'cancelIsoNc', onNc(nc, { reason: 'x' }, PERSON.nisha), 'FORBIDDEN', 403);
    await ncStep('cancelIsoNc', nisha, { reason: 'Raised twice' }, PERSON.nisha);
    await fails(app, 'cancelIsoNc', onNc(nc, {}, PERSON.divya), 'REASON_REQUIRED', 422);
    const out = await ncStep('cancelIsoNc', nc, { reason: 'Not a nonconformity' }, PERSON.kabir);
    expect(out).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'Not a nonconformity',
      status: { timing: 'CLOSED' },
      allowedActions: [],
    });
    expect(lastEvent(nc.id)).toMatchObject({
      action: 'TRANSITION',
      reason: 'Not a nonconformity',
      after: { action: 'CANCEL', state: 'CANCELLED' },
    });
    expect(lastEvent(nc.id).after).not.toHaveProperty('delegated');
    await fails(
      app,
      'cancelIsoNc',
      onNc(nc, { reason: 'x' }, PERSON.kabir),
      'INVALID_TRANSITION',
      409,
    );
    await fails(app, 'createIsoAction', addCall(ncSubject(nc)), 'INVALID_TRANSITION', 409);
    const { nc: done } = await closed();
    await fails(
      app,
      'cancelIsoNc',
      onNc(done, { reason: 'x' }, PERSON.kabir),
      'INVALID_TRANSITION',
      409,
    );
  });

  it('reopens a CLOSED nonconformity for a client admin only', async () => {
    const { nc } = await closed();
    for (const as of [PERSON.meera, PERSON.arjun, PERSON.divya, PERSON.sameer]) {
      await fails(
        app,
        'reopenIsoNc',
        onNc(nc, { reason: 'x', backTo: 'OPEN' }, as),
        'FORBIDDEN',
        403,
      );
    }
    const out = await ncStep(
      'reopenIsoNc',
      nc,
      { reason: 'A customer complaint', backTo: 'OPEN' },
      PERSON.kabir,
    );
    expect(out).toMatchObject({
      state: 'OPEN',
      closedOn: null,
      effective: null,
      effectivenessDueOn: null,
    });
    expect(lastEvent(nc.id)).toMatchObject({
      reason: 'A customer complaint',
      after: { action: 'REOPEN' },
    });
    await fails(
      app,
      'reopenIsoNc',
      onNc(nc, { reason: 'x', backTo: 'OPEN' }, PERSON.kabir),
      'INVALID_TRANSITION',
      409,
    );
  });

  it('reopens to ACTIONS_PLANNED: a new date, and a new action DONE before SUBMIT', async () => {
    const { nc } = await closed();
    await fails(
      app,
      'reopenIsoNc',
      onNc(nc, { reason: 'x', backTo: 'ACTIONS_PLANNED', effectivenessDueOn: TODAY }, PERSON.kabir),
      'VALIDATION',
      400,
    );
    const out = await ncStep(
      'reopenIsoNc',
      nc,
      { reason: 'Found again', backTo: 'ACTIONS_PLANNED', effectivenessDueOn: addDays(TODAY, 7) },
      PERSON.kabir,
    );
    expect(out).toMatchObject({ state: 'ACTIONS_PLANNED', effectivenessDueOn: addDays(TODAY, 7) });
    await fails(app, 'submitIsoNc', onNc(nc), 'VALIDATION', 400);
    const fresh = await addAction(ncSubject(nc));
    await actStep('completeIsoAction', fresh, { doneOn: TODAY });
    expect((await ncStep('submitIsoNc', nc)).state).toBe('AWAITING_VERIFICATION');
  });
});

describe('nonconformity status', () => {
  it('follows the earliest open action, ignores dueOn once submitted, and flags a late effectiveness check', async () => {
    const nc = await raise({ dueOn: addDays(TODAY, 30) });
    await addAction(ncSubject(nc), { dueOn: addDays(TODAY, 3) });
    expect((await getNc(nc)).status).toEqual({
      timing: 'DUE_SOON',
      overdueDays: null,
      effectivenessOverdueDays: null,
    });
    const waiting = seedNc({
      state: 'AWAITING_VERIFICATION',
      ...ROOT_CAUSE,
      ...SUBMIT,
      dueOn: addDays(TODAY, -5),
      effectivenessDueOn: addDays(TODAY, -2),
    });
    expect((await getNc(waiting)).status).toEqual({
      timing: 'ON_TIME',
      overdueDays: null,
      effectivenessOverdueDays: 2,
    });
  });
});

// ---------- actions ----------

describe('createIsoAction', () => {
  it('adds an OPEN action to a nonconformity for managers and its owner, audited as CREATE', async () => {
    const nc = await raise();
    for (const as of [PERSON.meera, PERSON.arjun, PERSON.kabir, PERSON.sameer]) {
      const action = await addAction(ncSubject(nc), {}, as);
      expect(action).toMatchObject({
        state: 'OPEN',
        subject: ncSubject(nc),
        doneOn: null,
        status: { timing: 'ON_TIME', overdueDays: null },
      });
    }
    const action = await addAction(ncSubject(nc), { resources: 'Two hours of the printer vendor' });
    expect(lastEvent(action.id)).toMatchObject({
      action: 'CREATE',
      entityType: 'iso_action',
      after: { subject: ncSubject(nc), ownerId: PERSON.sameer, state: 'OPEN' },
    });
    for (const as of [PERSON.divya, PERSON.rohan, PERSON.vikram]) {
      await fails(app, 'createIsoAction', addCall(ncSubject(nc), {}, as), 'FORBIDDEN', 403);
    }
    await fails(app, 'createIsoAction', addCall(ncSubject(nc), {}, PERSON.leela), 'NOT_FOUND', 404);
  });

  it('checks the subject and the owner', async () => {
    const nc = await raise({ unitId: BENGALURU });
    await fails(
      app,
      'createIsoAction',
      addCall(subjectOf('NONCONFORMITY', seedId())),
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'createIsoAction',
      addCall(ncSubject(nc), {}, PERSON.meera, HARBOUR),
      'NOT_FOUND',
      404,
    );
    for (const ownerId of [PERSON.rohan, PERSON.divya, PERSON.vikram]) {
      await fails(app, 'createIsoAction', addCall(ncSubject(nc), { ownerId }), 'VALIDATION', 400);
    }
    await fails(
      app,
      'createIsoAction',
      addCall(ncSubject(nc), { controlHierarchy: 'PPE' }),
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'createIsoAction',
      addCall(ncSubject(nc), { outputKey: 'IMPROVEMENT' }),
      'VALIDATION',
      400,
    );
  });

  it('takes treatment actions on a live risk item, with the level of control on a HAZARD', async () => {
    const risk = seedRisk({ ownerId: PERSON.rohan });
    const hazard = seedRisk({ ...HAZARD });
    const archived = seedRisk({ archivedAt: `${TODAY}T01:00:00Z` });
    const action = await addAction(
      subjectOf('RISK_ITEM', risk.id),
      { ownerId: PERSON.rohan },
      PERSON.rohan,
    );
    expect(action.controlHierarchy).toBeNull();
    await fails(
      app,
      'createIsoAction',
      addCall(subjectOf('RISK_ITEM', hazard.id)),
      'VALIDATION',
      400,
    );
    const guarded = await addAction(subjectOf('RISK_ITEM', hazard.id), {
      controlHierarchy: 'ENGINEERING',
    });
    expect(guarded.controlHierarchy).toBe('ENGINEERING');
    await fails(
      app,
      'createIsoAction',
      addCall(subjectOf('RISK_ITEM', archived.id)),
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'createIsoAction',
      addCall(subjectOf('RISK_ITEM', risk.id), {}, PERSON.sameer),
      'FORBIDDEN',
      403,
    );
  });

  it('takes objective plans until the objective is closed', async () => {
    const objective = seedObjective();
    await addAction(subjectOf('OBJECTIVE', objective.id), {}, PERSON.sameer);
    const done = seedObjective({ closedOn: TODAY, outcome: 'ACHIEVED' });
    const refused = await fails(
      app,
      'createIsoAction',
      addCall(subjectOf('OBJECTIVE', done.id)),
      'INVALID_TRANSITION',
      409,
    );
    expect(refused.error.details).toEqual({
      entity: 'objective',
      from: 'CLOSED',
      action: 'UPDATE',
    });
  });

  it('takes improvement actions on observations and OFIs until the audit is CLOSED, never on NC or good-practice findings', async () => {
    const audit = seedInternalAudit({ ...REPORTED });
    const observation = seedFinding({ internal: audit.id });
    // The lead auditor owns the finding; a REPORTED audit's findings still take actions (model §6).
    await addAction(subjectOf('AUDIT_FINDING', observation.id), {}, PERSON.sameer);
    const good = seedFinding({ internal: audit.id }, { type: 'GOOD_PRACTICE' });
    await fails(
      app,
      'createIsoAction',
      addCall(subjectOf('AUDIT_FINDING', good.id)),
      'VALIDATION',
      400,
    );
    const nc = seedNc({ source: 'INTERNAL_AUDIT' });
    const major = seedFinding({ internal: audit.id }, { type: 'MAJOR_NC', nonconformityId: nc.id });
    await fails(
      app,
      'createIsoAction',
      addCall(subjectOf('AUDIT_FINDING', major.id)),
      'VALIDATION',
      400,
    );
    const shut = seedInternalAudit({ ...REPORTED, state: 'CLOSED' });
    const late = seedFinding({ internal: shut.id });
    const refused = await fails(
      app,
      'createIsoAction',
      addCall(subjectOf('AUDIT_FINDING', late.id)),
      'INVALID_TRANSITION',
      409,
    );
    expect(refused.error.details).toEqual({
      entity: 'internal_audit',
      from: 'CLOSED',
      action: 'UPDATE',
    });
    // An external audit's finding has no owner: managers only.
    const visit = seedExternalAudit();
    const ofi = seedFinding({ external: visit.id }, { type: 'OFI' });
    await addAction(subjectOf('AUDIT_FINDING', ofi.id), {}, PERSON.arjun);
    await fails(
      app,
      'createIsoAction',
      addCall(subjectOf('AUDIT_FINDING', ofi.id), {}, PERSON.sameer),
      'FORBIDDEN',
      403,
    );
    const over = seedExternalAudit({ state: 'CANCELLED', cancelReason: 'Moved' });
    const gone = seedFinding({ external: over.id }, { type: 'OFI' });
    await fails(
      app,
      'createIsoAction',
      addCall(subjectOf('AUDIT_FINDING', gone.id)),
      'INVALID_TRANSITION',
      409,
    );
  });

  it('takes review actions with an output of the review until it is CLOSED or CANCELLED', async () => {
    const review = seedReview();
    const action = await addAction(
      subjectOf('MANAGEMENT_REVIEW', review.id),
      { outputKey: 'IMPROVEMENT' },
      PERSON.sameer,
    );
    expect(action.outputKey).toBe('IMPROVEMENT');
    // SUITABILITY is an ISO 14001 and 45001 output, not one of this ISO 9001 review's.
    await fails(
      app,
      'createIsoAction',
      addCall(subjectOf('MANAGEMENT_REVIEW', review.id), { outputKey: 'SUITABILITY' }),
      'VALIDATION',
      400,
    );
    for (const state of [
      { state: 'CLOSED', heldOn: TODAY },
      { state: 'CANCELLED', cancelReason: 'Merged' },
    ] as const) {
      const shut = seedReview(state);
      await fails(
        app,
        'createIsoAction',
        addCall(subjectOf('MANAGEMENT_REVIEW', shut.id)),
        'INVALID_TRANSITION',
        409,
      );
    }
  });
});

describe('getIsoAction and listIsoActions', () => {
  let listSys: System;
  let pune: Nc;
  let blr: Nc;
  let first: Action;
  let second: Action;
  let blrAction: Action;
  let rohanAction: Action;

  beforeAll(async () => {
    listSys = seedSystem(app, { name: 'Action list system' });
    pune = await raise({}, PERSON.meera, listSys);
    blr = await raise({ unitId: BENGALURU }, PERSON.meera, listSys);
    second = await addAction(ncSubject(pune), {
      dueOn: addDays(TODAY, 20),
      text: 'Train the packers',
    });
    first = await addAction(ncSubject(pune), { dueOn: addDays(TODAY, 2), ownerId: PERSON.kabir });
    blrAction = await addAction(ncSubject(blr), { dueOn: addDays(TODAY, 5) });
    const unitless = await raise({ unitId: null, ownerId: PERSON.kabir }, PERSON.meera, blrSys);
    rohanAction = await addAction(ncSubject(unitless), { ownerId: PERSON.rohan });
    actionRow(second.id).dueOn = addDays(TODAY, -4);
    // An action whose subject cannot be found is left out of lists.
    seed(app, 'actions', {
      ...base(),
      subject: { type: 'OBJECTIVE', id: seedId() },
      text: 'Orphan',
      resources: null,
      ownerId: PERSON.sameer,
      dueOn: TODAY,
      doneOn: null,
      state: 'OPEN',
      effectivenessNote: null,
      cancelReason: null,
      controlHierarchy: null,
      outputKey: null,
    });
  });

  const listed = async (query: Record<string, string>, as: string = PERSON.meera) =>
    ids((await listActions({ managementSystemId: listSys.id, ...query }, as)).items);

  it('lists by due date and applies every filter', async () => {
    expect(await listed({})).toEqual([second.id, first.id, blrAction.id]);
    expect(await listed({ subjectType: 'NONCONFORMITY', subjectId: blr.id })).toEqual([
      blrAction.id,
    ]);
    expect(await listed({ subjectType: 'RISK_ITEM' })).toEqual([]);
    expect(await listed({ ownerId: 'me' }, PERSON.kabir)).toEqual([first.id]);
    expect(await listed({ state: 'OPEN' })).toEqual([second.id, first.id, blrAction.id]);
    expect(await listed({ state: 'DONE' })).toEqual([]);
    expect(await listed({ overdue: 'true' })).toEqual([second.id]);
    expect(await listed({ overdue: 'false' })).toEqual([first.id, blrAction.id]);
    expect(await listed({ from: addDays(TODAY, 1), to: addDays(TODAY, 4) })).toEqual([first.id]);
    expect(await listed({ q: 'packers' })).toEqual([second.id]);
    expect((await listActions({ q: 'Orphan' })).items).toEqual([]);
  });

  it('shows each action its timing', async () => {
    expect((await getAction(second)).status).toEqual({ timing: 'OVERDUE', overdueDays: 4 });
    expect((await getAction(first)).status).toEqual({ timing: 'DUE_SOON', overdueDays: null });
  });

  it("gives an action its subject's units, and shows it to its owner (plan §3.3)", async () => {
    expect(await listed({}, PERSON.nisha)).toEqual([second.id, first.id]);
    expect(await listed({}, PERSON.vikram)).toEqual([second.id, first.id, blrAction.id]);
    await fails(
      app,
      'getIsoAction',
      { as: PERSON.rohan, params: params(blrAction) },
      'NOT_FOUND',
      404,
    );
    expect((await getAction(rohanAction, PERSON.rohan)).allowedActions).toEqual(['COMPLETE']);
    const rohanList = await listActions({ managementSystemId: blrSys.id }, PERSON.rohan);
    expect(ids(rohanList.items)).toContain(rohanAction.id);
    await fails(
      app,
      'getIsoAction',
      { as: PERSON.nisha, params: params(rohanAction) },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'getIsoAction',
      { params: { clientId: HARBOUR, id: first.id } },
      'NOT_FOUND',
      404,
    );
    for (const as of [PERSON.arjun, PERSON.kabir, PERSON.divya, PERSON.sameer, PERSON.vikram]) {
      expect((await getAction(first, as)).id).toBe(first.id);
    }
  });

  it('offers COMPLETE to the owner, CANCEL to the approver, and both to a client admin', async () => {
    expect((await getAction(first, PERSON.kabir)).allowedActions).toEqual(['COMPLETE', 'CANCEL']);
    expect((await getAction(first, PERSON.divya)).allowedActions).toEqual(['CANCEL']);
    expect((await getAction(second, PERSON.sameer)).allowedActions).toEqual(['COMPLETE']);
    expect((await getAction(second, PERSON.meera)).allowedActions).toEqual([]);
  });
});

describe('updateIsoAction', () => {
  it("lets managers and the subject's owner change an OPEN action, with reasons for owner and date", async () => {
    const nc = await raise();
    const action = await addAction(ncSubject(nc));
    const out = await actStep('updateIsoAction', action, {
      text: 'Lock the template and train the packers',
      effectivenessNote: 'Check two weeks of labels',
    });
    expect(out.text).toBe('Lock the template and train the packers');
    expect(lastEvent(action.id)).toMatchObject({ action: 'UPDATE', reason: null });
    await actStep(
      'updateIsoAction',
      action,
      { ownerId: PERSON.kabir, dueOn: addDays(TODAY, 21), reason: 'Sameer is on leave' },
      PERSON.arjun,
    );
    expect(
      isoEvents(app, action.id)
        .slice(-2)
        .map((e) => [e.action, e.reason]),
    ).toEqual([
      ['REASSIGN', 'Sameer is on leave'],
      ['DUE_DATE_CHANGE', 'Sameer is on leave'],
    ]);
    const before = actionRow(action.id).version;
    await actStep('updateIsoAction', action, { text: 'Lock the template and train the packers' });
    expect(actionRow(action.id).version).toBe(before);
    const noReason = await call(
      app,
      'updateIsoAction',
      onAction(action, { dueOn: addDays(TODAY, 30) }),
    );
    expect(noReason.status).toBe(422);
    for (const as of [PERSON.divya, PERSON.rohan, PERSON.vikram]) {
      await fails(app, 'updateIsoAction', onAction(action, { text: 'x' }, as), 'FORBIDDEN', 403);
    }
    await fails(
      app,
      'updateIsoAction',
      { as: PERSON.sameer, params: params(action), body: { version: 1, text: 'x' } },
      'STALE_VERSION',
      409,
    );
  });

  it('checks the owner and the subject fields', async () => {
    const nc = await raise();
    const action = await addAction(ncSubject(nc));
    for (const body of [
      { ownerId: PERSON.divya, reason: 'x' },
      { controlHierarchy: 'PPE' },
      { outputKey: 'IMPROVEMENT' },
    ]) {
      await fails(app, 'updateIsoAction', onAction(action, body), 'VALIDATION', 400);
    }
    const hazard = seedRisk({ ...HAZARD });
    const treatment = await addAction(subjectOf('RISK_ITEM', hazard.id), {
      controlHierarchy: 'PPE',
    });
    await fails(
      app,
      'updateIsoAction',
      onAction(treatment, { controlHierarchy: null }),
      'VALIDATION',
      400,
    );
    const moved = await actStep('updateIsoAction', treatment, { controlHierarchy: 'ENGINEERING' });
    expect(moved.controlHierarchy).toBe('ENGINEERING');
    const review = seedReview();
    const reviewAction = await addAction(subjectOf('MANAGEMENT_REVIEW', review.id));
    await fails(
      app,
      'updateIsoAction',
      onAction(reviewAction, { outputKey: 'SUITABILITY' }),
      'VALIDATION',
      400,
    );
    expect(
      (await actStep('updateIsoAction', reviewAction, { outputKey: 'RESOURCE_NEEDS' })).outputKey,
    ).toBe('RESOURCE_NEEDS');
  });

  it('refuses a DONE or CANCELLED action, and any action of a locked subject', async () => {
    const { nc, action } = await closed();
    const done = await fails(
      app,
      'updateIsoAction',
      onAction(action, { text: 'x' }),
      'INVALID_TRANSITION',
      409,
    );
    expect(done.error.details).toEqual({ entity: 'iso_action', from: 'DONE', action: 'UPDATE' });
    const open = seed(app, 'actions', {
      ...base(),
      subject: ncSubject(nc),
      text: 'Left open',
      resources: null,
      ownerId: PERSON.sameer,
      dueOn: TODAY,
      doneOn: null,
      state: 'OPEN',
      effectivenessNote: null,
      cancelReason: null,
      controlHierarchy: null,
      outputKey: null,
    });
    const locked = await fails(
      app,
      'updateIsoAction',
      onAction(open, { text: 'x' }),
      'INVALID_TRANSITION',
      409,
    );
    expect(locked.error.details).toEqual({
      entity: 'nonconformity',
      from: 'CLOSED',
      action: 'UPDATE',
    });
    // An OPEN action of a closed subject offers only CANCEL, and can be cleared away.
    expect((await getAction(open, PERSON.kabir)).allowedActions).toEqual(['CANCEL']);
    await fails(
      app,
      'completeIsoAction',
      onAction(open, { doneOn: TODAY }),
      'INVALID_TRANSITION',
      409,
    );
    expect(
      (await actStep('cancelIsoAction', open, { reason: 'Closed without it' }, PERSON.divya)).state,
    ).toBe('CANCELLED');
  });
});

describe('completeIsoAction', () => {
  it("is the action owner's step; a client admin completes as delegate", async () => {
    const nc = await raise();
    const action = await addAction(ncSubject(nc));
    for (const as of [PERSON.meera, PERSON.arjun, PERSON.divya, PERSON.rohan, PERSON.vikram]) {
      await fails(
        app,
        'completeIsoAction',
        onAction(action, { doneOn: TODAY }, as),
        'FORBIDDEN',
        403,
      );
    }
    await fails(
      app,
      'completeIsoAction',
      onAction(action, { doneOn: addDays(TODAY, 1) }),
      'VALIDATION',
      400,
    );
    const out = await actStep('completeIsoAction', action, {
      doneOn: addDays(TODAY, -1),
      effectivenessNote: 'Labels checked',
    });
    expect(out).toMatchObject({
      state: 'DONE',
      doneOn: addDays(TODAY, -1),
      effectivenessNote: 'Labels checked',
      status: { timing: 'CLOSED', overdueDays: null },
      allowedActions: [],
    });
    expect(lastEvent(action.id)).toMatchObject({
      action: 'TRANSITION',
      after: { action: 'COMPLETE', state: 'DONE' },
    });
    expect(lastEvent(action.id).after).not.toHaveProperty('delegated');
    await fails(
      app,
      'completeIsoAction',
      onAction(action, { doneOn: TODAY }),
      'INVALID_TRANSITION',
      409,
    );
    const other = await addAction(ncSubject(nc));
    await actStep('completeIsoAction', other, { doneOn: TODAY }, PERSON.kabir);
    expect(lastEvent(other.id).after).toMatchObject({ delegated: true });
  });

  it('puts a treatment action in place as a control and asks for a re-rating (model §3.5)', async () => {
    const hazard = seedRisk({ ...HAZARD });
    const guard = await addAction(subjectOf('RISK_ITEM', hazard.id), {
      text: 'Fit a pedestrian barrier',
      controlHierarchy: 'ENGINEERING',
    });
    const signs = await addAction(subjectOf('RISK_ITEM', hazard.id), {
      text: 'Mark the walkway',
      controlHierarchy: 'ADMINISTRATIVE',
    });
    await actStep('completeIsoAction', guard, { doneOn: TODAY });
    const controls = () => firmB(app).iso.riskControls.filter((c) => c.riskItemId === hazard.id);
    expect(controls()).toMatchObject([
      { text: 'Fit a pedestrian barrier', hierarchy: 'ENGINEERING', sourceActionId: guard.id },
    ]);
    // One treatment action is still OPEN: the residual scores stay for the owner to re-rate.
    expect(hazard).toMatchObject({ reviewDueOn: TODAY, residualLikelihood: 2, residualRating: 4 });
    expect(lastEvent(hazard.id)).toMatchObject({
      action: 'DUE_DATE_CHANGE',
      entityType: 'risk_item',
      after: { reviewDueOn: TODAY, sourceActionId: guard.id },
    });
    expect(lastEvent(controls()[0]!.id)).toMatchObject({
      action: 'CREATE',
      entityType: 'risk_control',
    });
    await actStep('completeIsoAction', signs, { doneOn: TODAY });
    expect(controls()).toHaveLength(2);
    expect(hazard).toMatchObject({
      residualLikelihood: null,
      residualSeverity: null,
      residualRating: null,
    });
    expect(lastEvent(hazard.id)).toMatchObject({
      action: 'UPDATE',
      after: { residualLikelihood: null, residualRating: null },
    });
  });

  it('refuses a treatment action of an archived risk item', async () => {
    const risk = seedRisk();
    const action = await addAction(subjectOf('RISK_ITEM', risk.id));
    risk.archivedAt = `${TODAY}T02:00:00Z`;
    const refused = await fails(
      app,
      'completeIsoAction',
      onAction(action, { doneOn: TODAY }),
      'INVALID_TRANSITION',
      409,
    );
    expect(refused.error.details).toEqual({
      entity: 'risk_item',
      from: 'ARCHIVED',
      action: 'UPDATE',
    });
  });
});

describe('cancelIsoAction', () => {
  it("is the subject approver's step or a client admin's, with a reason", async () => {
    const nc = await raise();
    const action = await addAction(ncSubject(nc));
    for (const as of [PERSON.meera, PERSON.arjun, PERSON.sameer, PERSON.nisha, PERSON.vikram]) {
      await fails(app, 'cancelIsoAction', onAction(action, { reason: 'x' }, as), 'FORBIDDEN', 403);
    }
    await fails(app, 'cancelIsoAction', onAction(action, {}, PERSON.divya), 'REASON_REQUIRED', 422);
    const out = await actStep(
      'cancelIsoAction',
      action,
      { reason: 'Covered by another action' },
      PERSON.divya,
    );
    expect(out).toMatchObject({ state: 'CANCELLED', cancelReason: 'Covered by another action' });
    expect(lastEvent(action.id)).toMatchObject({
      reason: 'Covered by another action',
      after: { action: 'CANCEL', state: 'CANCELLED' },
    });
    await fails(
      app,
      'cancelIsoAction',
      onAction(action, { reason: 'x' }, PERSON.kabir),
      'INVALID_TRANSITION',
      409,
    );
  });

  it('leaves subjects without an approver to a client admin', async () => {
    const objective = seedObjective();
    const action = await addAction(subjectOf('OBJECTIVE', objective.id));
    expect((await getAction(action, PERSON.divya)).allowedActions).toEqual([]);
    await fails(
      app,
      'cancelIsoAction',
      onAction(action, { reason: 'x' }, PERSON.divya),
      'FORBIDDEN',
      403,
    );
    await actStep('cancelIsoAction', action, { reason: 'Objective rewritten' }, PERSON.kabir);
  });
});

describe('reopenIsoAction', () => {
  it('reopens a DONE or CANCELLED action for a client admin while the subject is open', async () => {
    const nc = await raise();
    const done = await addAction(ncSubject(nc));
    await actStep('completeIsoAction', done, { doneOn: TODAY });
    expect((await getAction(done, PERSON.kabir)).allowedActions).toEqual(['REOPEN']);
    for (const as of [PERSON.meera, PERSON.arjun, PERSON.divya, PERSON.sameer]) {
      await fails(app, 'reopenIsoAction', onAction(done, { reason: 'x' }, as), 'FORBIDDEN', 403);
    }
    const out = await actStep(
      'reopenIsoAction',
      done,
      { reason: 'Labels wrong again' },
      PERSON.kabir,
    );
    expect(out).toMatchObject({ state: 'OPEN', doneOn: null });
    expect(lastEvent(done.id)).toMatchObject({
      reason: 'Labels wrong again',
      after: { action: 'REOPEN' },
    });
    await fails(
      app,
      'reopenIsoAction',
      onAction(done, { reason: 'x' }, PERSON.kabir),
      'INVALID_TRANSITION',
      409,
    );
    const cancelled = await addAction(ncSubject(nc));
    await actStep('cancelIsoAction', cancelled, { reason: 'Not needed' }, PERSON.kabir);
    expect(
      (await actStep('reopenIsoAction', cancelled, { reason: 'Needed after all' }, PERSON.kabir))
        .cancelReason,
    ).toBeNull();
  });

  it('refuses while the subject is closed', async () => {
    const { action } = await closed();
    expect((await getAction(action, PERSON.kabir)).allowedActions).toEqual([]);
    await fails(
      app,
      'reopenIsoAction',
      onAction(action, { reason: 'x' }, PERSON.kabir),
      'INVALID_TRANSITION',
      409,
    );
  });
});

describe('the add-on switch', () => {
  it('answers 403 FEATURE_NOT_ENABLED with the add-on off', async () => {
    const nc = await raise();
    await setFeatures(app, []);
    try {
      await fails(app, 'getIsoNonconformity', { params: params(nc) }, 'FEATURE_NOT_ENABLED', 403);
      await fails(app, 'listIsoActions', {}, 'FEATURE_NOT_ENABLED', 403);
    } finally {
      await setFeatures(app, ['isoManagement']);
    }
    expect((await getNc(nc)).id).toBe(nc.id);
  });
});
