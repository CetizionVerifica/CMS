// Mock handlers for ISO management reviews with inputs and outputs (docs/iso/model.md §3.13, §4.5, §5.4) and ISO files
// (model §6): role matrix and unit scope (plan §3.2-3.3), every arrow and guard, locks, versions, audit events.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ISO_FILE_SUBJECT_COLUMNS,
  REVIEW_FIGURE_KEYS,
  ReviewInputFigures,
  ReviewInputKey,
  ReviewOutputKey,
  reviewRiskKinds,
} from '../src/schemas/iso.js';
import type { IsoStandardCode } from '../src/enums.js';
import { ReviewInputView } from '../src/api/iso.js';
import { fixtureId } from '../src/fixtures/index.js';
import type { IsoRow } from '../src/mock/store.js';
import {
  type App,
  base,
  BENGALURU,
  CHENNAI,
  call,
  clause,
  fails,
  FIRM_B,
  firmB,
  HARBOUR,
  isoApp,
  isoEvents,
  NORTHWIND,
  NOW,
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

const ISHAAN = fixtureId('firm-b:person:ishaan'); // OWNER, Northwind Bengaluru only
const FARHAN = fixtureId('firm-b:person:farhan'); // OWNER, Northwind Pune only

interface ReviewView {
  id: string;
  version: number;
  managementSystemId: string;
  standards: string[];
  plannedOn: string;
  heldOn: string | null;
  chairId: string;
  attendeeIds: string[];
  minutes: string | null;
  state: string;
  cancelReason: string | null;
  allowedActions: string[];
}
interface Figure {
  key: string;
  value: number;
  ids: string[];
}
interface InputView {
  id: string;
  version: number;
  inputDefId: string;
  notes: string | null;
  key: string;
  title: string;
  source: string;
  clauseRefs: { standard: string; clauseNumber: string; item: string | null }[];
  sourceFigures: { source: string; since: string; asOf: string; figures: Figure[] } | null;
  figuresStoredAt: string | null;
  figuresWithheld: boolean;
}
interface OutputView {
  id: string;
  version: number;
  outputDefId: string;
  decision: string | null;
  key: string;
  clauseRefs: { standard: string; clauseNumber: string; item: string | null }[];
}
interface FileView {
  id: string;
  fileName: string;
  scanStatus: string;
  archivedAt: string | null;
  removeReason: string | null;
  subject: { type: string; id: string };
}
type Ref = { type: keyof typeof ISO_FILE_SUBJECT_COLUMNS; id: string };
type ErrorBody = { error: { code: string; details?: Record<string, unknown> } };

const ALL = ['ISO_9001', 'ISO_14001', 'ISO_45001'] as const;
const SHA = 'a'.repeat(64);
const sorted = (values: readonly string[]) => [...values].sort();

let app: App;
const firm = () => firmB(app);

beforeAll(async () => {
  app = await isoApp();
});
afterAll(async () => {
  await app.close();
});

// ---------- calls ----------

function plan(
  systemId: string,
  body: Record<string, unknown> = {},
  as = PERSON.kabir,
  clientId = NORTHWIND,
) {
  return ok<ReviewView>(app, 'planIsoManagementReview', {
    as,
    params: { clientId },
    body: {
      managementSystemId: systemId,
      standards: [...ALL],
      plannedOn: '2024-12-01',
      chairId: PERSON.sameer,
      attendeeIds: [PERSON.divya],
      ...body,
    },
  });
}

const getReview = (id: string, as = PERSON.kabir) =>
  ok<ReviewView>(app, 'getIsoManagementReview', { as, params: { id } });

const update = (review: { id: string; version: number }, body: object, as = PERSON.kabir) =>
  ok<ReviewView>(app, 'updateIsoManagementReview', {
    as,
    params: { id: review.id },
    body: { version: review.version, ...body },
  });

const replan = (review: { id: string; version: number }, body: object, as = PERSON.kabir) =>
  ok<ReviewView>(app, 'replanIsoManagementReview', {
    as,
    params: { id: review.id },
    body: { version: review.version, ...body },
  });

async function inputs(id: string, as = PERSON.kabir, clientId = NORTHWIND) {
  return (
    await ok<{ items: InputView[] }>(app, 'listIsoReviewInputs', { as, params: { id, clientId } })
  ).items;
}

async function outputs(id: string, as = PERSON.kabir) {
  return (await ok<{ items: OutputView[] }>(app, 'listIsoReviewOutputs', { as, params: { id } }))
    .items;
}

async function noteAll(reviewId: string) {
  for (const input of await inputs(reviewId)) {
    await ok(app, 'updateIsoReviewInput', {
      params: { id: reviewId, inputId: input.id },
      body: { version: input.version, notes: `Discussed ${input.key}` },
    });
  }
}

async function decideAll(reviewId: string) {
  for (const output of await outputs(reviewId)) {
    await ok(app, 'updateIsoReviewOutput', {
      params: { id: reviewId, outputId: output.id },
      body: { version: output.version, decision: `Decided ${output.key}` },
    });
  }
}

async function hold(reviewId: string, as = PERSON.kabir, body: object = {}) {
  const review = await getReview(reviewId);
  return ok<ReviewView>(app, 'recordIsoManagementReviewHeld', {
    as,
    params: { id: reviewId },
    body: { version: review.version, heldOn: TODAY, ...body },
  });
}

const stored = (id: string) => firm().iso.managementReviews.find((r) => r.id === id)!;

const lastEvent = (id: string) => isoEvents(app, id).at(-1)!;

const byKey = <T extends { key: string }>(rows: T[], key: string) =>
  rows.find((r) => r.key === key)!;

const figureOf = (input: InputView, key: string) =>
  input.sourceFigures!.figures.find((f) => f.key === key)!;

type IsoEvent = ReturnType<typeof firm>['data']['auditEvents'][number];

/** An audit event in Firm B's trail as the routes write one, for a row seeded with no trail. */
function seedEvent(
  event: Pick<IsoEvent, 'at' | 'action' | 'entityType' | 'entityId' | 'before' | 'after'> &
    Partial<Pick<IsoEvent, 'reason'>>,
) {
  firm().data.auditEvents.push({
    id: seedId(),
    firmId: FIRM_B,
    clientId: NORTHWIND,
    requestId: 'seeded',
    actorId: PERSON.kabir,
    actorKind: 'PERSON',
    reason: null,
    ...event,
  });
}

// ---------- seeds ----------

function seedReview(
  systemId: string,
  fields: Partial<IsoRow<'managementReviews'>> = {},
  clientId = NORTHWIND,
) {
  return seed(app, 'managementReviews', {
    ...base(clientId),
    managementSystemId: systemId,
    standards: [...ALL],
    plannedOn: '2024-06-30',
    heldOn: '2024-06-30',
    chairId: PERSON.kabir,
    attendeeIds: [PERSON.divya],
    minutes: null,
    state: 'CLOSED',
    cancelReason: null,
    ...fields,
  });
}

function seedAction(
  subject: IsoRow<'actions'>['subject'],
  fields: Partial<IsoRow<'actions'>> = {},
  clientId = NORTHWIND,
) {
  return seed(app, 'actions', {
    ...base(clientId),
    subject,
    text: 'Fix the cause',
    resources: null,
    ownerId: PERSON.sameer,
    dueOn: '2024-12-31',
    doneOn: null,
    state: 'OPEN',
    effectivenessNote: null,
    cancelReason: null,
    controlHierarchy: null,
    outputKey: null,
    ...fields,
  });
}

function seedNc(systemId: string, fields: Partial<IsoRow<'nonconformities'>> = {}) {
  return seed(app, 'nonconformities', {
    ...base(),
    managementSystemId: systemId,
    number: 800 + firm().iso.nonconformities.length,
    source: 'PROCESS',
    sourceInstanceId: null,
    raisedFromRiskItemId: null,
    severity: 'MINOR',
    standards: ['ISO_9001'],
    clauseIds: [],
    unitId: PUNE,
    description: 'Label printed wrong',
    reportedById: PERSON.sameer,
    reportedOn: '2024-10-01',
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
    ownerId: PERSON.rohan,
    approverId: PERSON.nisha,
    dueOn: '2024-12-31',
    effectivenessDueOn: null,
    effectivenessNote: null,
    effective: null,
    closedOn: null,
    cancelReason: null,
    state: 'OPEN',
    incident: null,
    ...fields,
  });
}

/** The fields a CLOSED nonconformity has. */
const closedNc = (closedOn: string) => ({
  state: 'CLOSED' as const,
  containment: 'Held stock',
  correction: 'Reprinted',
  rootCauseMethod: 'FIVE_WHYS' as const,
  rootCause: 'Template',
  similarOccurrences: 'None',
  riskReview: 'None needed',
  systemChange: 'None needed',
  effective: true,
  effectivenessNote: 'Held for a month',
  closedOn,
});

function seedRisk(systemId: string, fields: Partial<IsoRow<'riskItems'>> = {}) {
  return seed(app, 'riskItems', {
    ...base(),
    managementSystemId: systemId,
    kind: 'RISK',
    unitId: null,
    activity: 'Dispatch',
    description: 'Late deliveries',
    impact: null,
    lifeCycleStages: [],
    controlType: null,
    routine: null,
    personsExposed: [],
    condition: null,
    assessedWith: null,
    likelihood: 4,
    severity: 4,
    residualLikelihood: null,
    residualSeverity: null,
    rating: 16,
    residualRating: null,
    significant: true,
    significantOverride: null,
    significanceReason: null,
    obligationIds: [],
    climateRelated: false,
    ownerId: PERSON.sameer,
    reviewDueOn: null,
    lastReviewedOn: null,
    ...fields,
  });
}

function seedObjective(systemId: string, fields: Partial<IsoRow<'objectives'>> = {}) {
  return seed(app, 'objectives', {
    ...base(),
    managementSystemId: systemId,
    standards: ['ISO_9001'],
    text: 'Cut rework',
    target: 100,
    unitOfMeasure: 'units',
    baseline: null,
    direction: 'INCREASE',
    readingRule: { kind: 'ONGOING_REVIEW', every: 'MONTH' },
    riskItemIds: [],
    ownerId: PERSON.rohan,
    dueOn: '2025-03-31',
    closedOn: null,
    outcome: null,
    ...fields,
  });
}

function seedReading(objectiveId: string, value: number) {
  return seed(app, 'readings', {
    ...base(),
    objectiveId,
    periodStart: '2024-10-01',
    periodEnd: '2024-10-31',
    value,
    note: null,
    recordedById: PERSON.rohan,
  });
}

function seedDocument(systemId: string, fields: Partial<IsoRow<'documents'>> = {}) {
  return seed(app, 'documents', {
    ...base(),
    managementSystemId: systemId,
    code: `QP-${firm().iso.documents.length + 100}`,
    title: 'Calibration procedure',
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
    ...fields,
  });
}

function seedRevision(documentId: string, state: IsoRow<'revisions'>['state'] = 'DRAFT') {
  const approved = state === 'APPROVED' || state === 'SUPERSEDED';
  return seed(app, 'revisions', {
    ...base(),
    documentId,
    revision: 'A',
    changeNote: null,
    state,
    preparedById: PERSON.sameer,
    approvedById: approved ? PERSON.divya : null,
    approvedAt: approved ? NOW : null,
    sendBackReason: null,
  });
}

function seedProgramme(systemId: string, clientId = NORTHWIND) {
  return seed(app, 'auditProgrammes', {
    ...base(clientId),
    managementSystemId: systemId,
    fy: '2024-25',
    notes: null,
  });
}

function seedAudit(programmeId: string, fields: Partial<IsoRow<'internalAudits'>> = {}) {
  return seed(app, 'internalAudits', {
    ...base(),
    programmeId,
    title: 'Stores audit',
    plannedStart: '2024-12-01',
    plannedEnd: '2024-12-02',
    clauseIds: [],
    unitIds: [],
    leadAuditorId: PERSON.nisha,
    auditorIds: [],
    auditeeIds: [],
    reportedToIds: [],
    independenceNote: null,
    state: 'PLANNED',
    summary: null,
    reportedOn: null,
    cancelReason: null,
    ...fields,
  });
}

/** The fields a REPORTED internal audit has. */
const reported = (reportedOn: string) => ({
  state: 'REPORTED' as const,
  summary: 'Two findings',
  reportedOn,
  reportedToIds: [PERSON.kabir],
});

function seedFinding(fields: Partial<IsoRow<'findings'>>) {
  return seed(app, 'findings', {
    ...base(),
    internalAuditId: null,
    externalAuditId: null,
    type: 'OBSERVATION',
    clauseIds: [],
    unitId: null,
    description: 'Labels faded',
    nonconformityId: null,
    ...fields,
  });
}

function seedExternal(systemId: string, fields: Partial<IsoRow<'externalAudits'>> = {}) {
  return seed(app, 'externalAudits', {
    ...base(),
    managementSystemId: systemId,
    standardIds: [standardId(app, 'ISO_9001')],
    type: 'SURVEILLANCE_1',
    body: 'Fictional Certification Body',
    leadAuditorName: null,
    startOn: '2024-10-08',
    endOn: '2024-10-10',
    recommendation: null,
    responseDueOn: null,
    state: 'PLANNED',
    cancelReason: null,
    ...fields,
  });
}

function seedCertification(systemId: string, unitIds: string[]) {
  return seed(app, 'certifications', {
    ...base(),
    managementSystemId: systemId,
    standardId: standardId(app, 'ISO_9001'),
    body: 'Fictional Certification Body',
    certificateNumber: null,
    issuedOn: null,
    expiresOn: null,
    scopeText: null,
    unitIds,
  });
}

function seedContext(systemId: string, fields: Partial<IsoRow<'contextItems'>> = {}) {
  return seed(app, 'contextItems', {
    ...base(),
    managementSystemId: systemId,
    kind: 'INTERNAL_ISSUE',
    text: 'New packing line',
    needs: null,
    climateRelated: false,
    reviewedOn: null,
    ...fields,
  });
}

/** A stored file straight into the store (CLEAN unless said), on `subject`. */
function seedFile(subject: Ref, fields: Partial<IsoRow<'files'>> = {}, clientId = NORTHWIND) {
  const columns = Object.fromEntries(
    Object.entries(ISO_FILE_SUBJECT_COLUMNS).map(([type, column]) => [
      column,
      type === subject.type ? subject.id : null,
    ]),
  ) as Record<(typeof ISO_FILE_SUBJECT_COLUMNS)[Ref['type']], string | null>;
  return seed(app, 'files', {
    id: seedId(),
    firmId: FIRM_B,
    clientId,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    fileName: 'record.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1000,
    sha256: SHA,
    scanStatus: 'CLEAN',
    uploadedById: PERSON.kabir,
    uploadedAt: NOW,
    removeReason: null,
    ...columns,
    storageKey: `evidence/${FIRM_B}/${clientId}/iso/${subject.type}/${subject.id}/seeded`,
    ...fields,
  });
}

// ---------- files calls ----------

function ticket(subject: Ref, as: string, clientId = NORTHWIND, fileName = 'record.pdf') {
  return ok<{ uploadId: string; url: string; headers: Record<string, string>; expiresAt: string }>(
    app,
    'isoFileUploadUrl',
    {
      as,
      params: { clientId },
      body: { subject, fileName, mimeType: 'application/pdf', sizeBytes: 1000 },
    },
  );
}

async function upload(subject: Ref, as: string, clientId = NORTHWIND, fileName = 'record.pdf') {
  const { uploadId } = await ticket(subject, as, clientId, fileName);
  return ok<FileView>(app, 'confirmIsoFile', {
    as,
    params: { clientId },
    body: { subject, uploadId, fileName, sha256: SHA },
  });
}

async function listFiles(subject: Ref, as: string, clientId = NORTHWIND, includeRemoved = false) {
  const query: Record<string, string> = { subjectType: subject.type, subjectId: subject.id };
  if (includeRemoved) query.includeRemoved = 'true';
  return (await ok<{ items: FileView[] }>(app, 'listIsoFiles', { as, params: { clientId }, query }))
    .items;
}

const download = (id: string, as: string, clientId = NORTHWIND) =>
  ok<{ url: string; expiresAt: string }>(app, 'isoFileDownloadUrl', {
    as,
    params: { id, clientId },
  });

const remove = (id: string, as: string, reason = 'Wrong file') =>
  ok<FileView>(app, 'removeIsoFile', { as, params: { id }, body: { reason } });

// =====================================================================================================================

describe('planning a management review', () => {
  it('creates one input per input key and one output per output key of its standards', async () => {
    const system = seedSystem(app);
    const review = await plan(system.id);
    expect(review).toMatchObject({
      state: 'PLANNED',
      heldOn: null,
      minutes: null,
      cancelReason: null,
      standards: [...ALL],
      chairId: PERSON.sameer,
      attendeeIds: [PERSON.divya],
      allowedActions: ['CANCEL', 'RECORD_HELD'],
    });
    const ins = await inputs(review.id);
    expect(ins.map((i) => i.key)).toEqual(ReviewInputKey.options);
    const outs = await outputs(review.id);
    expect(outs.map((o) => o.key)).toEqual(ReviewOutputKey.options);
    // A key shared by several standards appears once, with every clause it answers.
    expect(byKey(ins, 'INTERESTED_PARTIES').clauseRefs).toEqual([
      { standard: 'ISO_14001', clauseNumber: '9.3', item: 'b2' },
      { standard: 'ISO_45001', clauseNumber: '9.3', item: 'b1' },
      { standard: 'ISO_45001', clauseNumber: '9.3', item: 'b2' },
    ]);
    const previous = byKey(ins, 'PREVIOUS_ACTIONS');
    expect(previous).toMatchObject({
      title: 'Status of actions from earlier reviews',
      source: 'PREVIOUS_ACTIONS',
      notes: null,
    });
    const def = firm().isoCatalogue.reviewInputDefs.find((d) => d.id === previous.inputDefId)!;
    expect(def.standardId).toBe(standardId(app, 'ISO_9001'));
    expect(byKey(outs, 'SUITABILITY').clauseRefs).toEqual([
      { standard: 'ISO_14001', clauseNumber: '9.3', item: null },
      { standard: 'ISO_45001', clauseNumber: '9.3', item: null },
    ]);
    const events = isoEvents(app, review.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'CREATE',
      entityType: 'management_review',
      actorId: PERSON.kabir,
      after: {
        managementSystemId: system.id,
        standards: [...ALL],
        state: 'PLANNED',
        inputKeys: ReviewInputKey.options,
        outputKeys: ReviewOutputKey.options,
      },
    });
    expect(events[0]!.after).not.toHaveProperty('delegated');
  });

  it("takes only the keys of the review's standards, in code order", async () => {
    const system = seedSystem(app);
    const review = await plan(system.id, { standards: ['ISO_9001'], attendeeIds: [] });
    expect((await inputs(review.id)).map((i) => i.key)).toEqual([
      'PREVIOUS_ACTIONS',
      'CONTEXT_CHANGES',
      'RISK_ACTIONS',
      'CUSTOMER_SATISFACTION',
      'OBJECTIVES',
      'PROCESS_PERFORMANCE',
      'NONCONFORMITIES',
      'MONITORING_RESULTS',
      'AUDIT_RESULTS',
      'EXTERNAL_PROVIDERS',
      'RESOURCES',
      'IMPROVEMENT_OPPORTUNITIES',
    ]);
    expect((await outputs(review.id)).map((o) => o.key)).toEqual([
      'IMPROVEMENT',
      'SYSTEM_CHANGES',
      'RESOURCE_NEEDS',
    ]);
    const mixed = await plan(system.id, { standards: ['ISO_45001', 'ISO_9001'] });
    expect(mixed.standards).toEqual(['ISO_9001', 'ISO_45001']);
  });

  it('is a client admin step that an account admin or consultant takes as delegate', async () => {
    const system = seedSystem(app);
    for (const as of [PERSON.meera, PERSON.arjun]) {
      const review = await plan(system.id, {}, as);
      expect(lastEvent(review.id).after).toMatchObject({ delegated: true });
    }
  });

  it('refuses approvers, owners, viewers and consultants of other clients', async () => {
    const system = seedSystem(app);
    const body = {
      managementSystemId: system.id,
      standards: ['ISO_9001'],
      plannedOn: '2024-12-01',
      chairId: PERSON.sameer,
    };
    for (const as of [PERSON.divya, PERSON.nisha, PERSON.sameer, PERSON.rohan, PERSON.vikram]) {
      await fails(app, 'planIsoManagementReview', { as, body }, 'FORBIDDEN', 403);
    }
    await fails(app, 'planIsoManagementReview', { as: PERSON.leela, body }, 'NOT_FOUND', 404);
  });

  it('checks the system, its standards and the people named', async () => {
    const system = seedSystem(app, { standards: ['ISO_9001'] });
    const harbour = seedSystem(app, { clientId: HARBOUR });
    const body = {
      managementSystemId: system.id,
      standards: ['ISO_9001'],
      plannedOn: '2024-12-01',
      chairId: PERSON.sameer,
    };
    await fails(
      app,
      'planIsoManagementReview',
      { body: { ...body, standards: ['ISO_9001', 'ISO_14001'] } },
      'VALIDATION',
      400,
    );
    for (const chairId of [PERSON.priya, PERSON.vikram, PERSON.gita]) {
      await fails(
        app,
        'planIsoManagementReview',
        { body: { ...body, chairId } },
        'VALIDATION',
        400,
      );
    }
    await fails(
      app,
      'planIsoManagementReview',
      { body: { ...body, attendeeIds: [PERSON.joseph] } },
      'VALIDATION',
      400,
    );
    for (const managementSystemId of [seedId(), harbour.id]) {
      await fails(
        app,
        'planIsoManagementReview',
        { body: { ...body, managementSystemId } },
        'NOT_FOUND',
        404,
      );
    }
  });
});

describe('reading management reviews', () => {
  let all: ReviewView;
  let blrByAdmin: ReviewView;
  let blrNamingNisha: ReviewView;
  let systems: string;

  beforeAll(async () => {
    const wide = seedSystem(app);
    const blr = seedSystem(app, { unitIds: [BENGALURU] });
    systems = `${wide.id},${blr.id}`;
    all = await plan(wide.id, { plannedOn: '2025-01-10' });
    blrByAdmin = await plan(blr.id, {
      plannedOn: '2024-12-05',
      chairId: PERSON.kabir,
      attendeeIds: [],
    });
    blrNamingNisha = await plan(blr.id, {
      plannedOn: '2025-02-01',
      attendeeIds: [PERSON.nisha],
    });
    blrNamingNisha = await update(blrNamingNisha, { minutes: 'Budget for dust extraction' });
  });

  const list = async (query: Record<string, string>, as = PERSON.kabir) =>
    (
      await ok<{ items: ReviewView[]; total?: number; nextCursor: string | null }>(
        app,
        'listIsoManagementReviews',
        { as, query: { managementSystemId: systems, ...query } },
      )
    ).items.map((r) => r.id);

  it('lists by planned date and filters by system, state, dates and text', async () => {
    expect(await list({})).toEqual([blrByAdmin.id, all.id, blrNamingNisha.id]);
    expect(await list({ state: 'PLANNED,HELD' })).toHaveLength(3);
    expect(await list({ state: 'CLOSED' })).toEqual([]);
    expect(await list({ from: '2025-01-01', to: '2025-01-31' })).toEqual([all.id]);
    expect(await list({ q: 'DUST' })).toEqual([blrNamingNisha.id]);
    const page = await ok<{ items: ReviewView[]; total: number; nextCursor: string | null }>(
      app,
      'listIsoManagementReviews',
      { query: { managementSystemId: systems, limit: '1', count: 'true' } },
    );
    expect(page).toMatchObject({ total: 3, items: [{ id: blrByAdmin.id }] });
    expect(page.nextCursor).not.toBeNull();
  });

  it('shows approvers and owners the reviews of their units and those that name them', async () => {
    expect(await list({}, PERSON.nisha)).toEqual([all.id, blrNamingNisha.id]);
    expect(await list({}, PERSON.rohan)).toEqual([all.id]);
    expect(await list({}, ISHAAN)).toEqual([blrByAdmin.id, all.id, blrNamingNisha.id]);
    expect(await list({}, PERSON.vikram)).toHaveLength(3);
  });

  it('reads one review with the actions the reader may take', async () => {
    expect((await getReview(all.id, PERSON.sameer)).allowedActions).toEqual(['RECORD_HELD']);
    expect((await getReview(all.id, PERSON.divya)).allowedActions).toEqual([]);
    expect((await getReview(all.id, PERSON.vikram)).allowedActions).toEqual([]);
    expect((await getReview(all.id, PERSON.arjun)).allowedActions).toEqual([
      'CANCEL',
      'RECORD_HELD',
    ]);
    expect((await getReview(blrNamingNisha.id, PERSON.nisha)).allowedActions).toEqual([]);
    await fails(
      app,
      'getIsoManagementReview',
      { as: PERSON.rohan, params: { id: blrByAdmin.id } },
      'NOT_FOUND',
      404,
    );
    await fails(app, 'getIsoManagementReview', { params: { id: seedId() } }, 'NOT_FOUND', 404);
    await fails(
      app,
      'getIsoManagementReview',
      { as: PERSON.leela, params: { id: all.id, clientId: HARBOUR } },
      'NOT_FOUND',
      404,
    );
  });

  it('keeps the inputs and outputs of an out-of-scope review from approvers and owners', async () => {
    for (const id of ['listIsoReviewInputs', 'listIsoReviewOutputs'] as const) {
      await fails(app, id, { as: PERSON.rohan, params: { id: blrByAdmin.id } }, 'NOT_FOUND', 404);
      await ok(app, id, { as: PERSON.nisha, params: { id: blrNamingNisha.id } });
      await ok(app, id, { as: PERSON.vikram, params: { id: blrByAdmin.id } });
    }
  });
});

describe('editing a management review', () => {
  it('lets the chair change attendees and minutes, audited as an UPDATE', async () => {
    const review = await plan(seedSystem(app).id);
    const edited = await update(
      review,
      { attendeeIds: [PERSON.divya, PERSON.rohan], minutes: 'Agenda sent' },
      PERSON.sameer,
    );
    expect(edited).toMatchObject({
      version: review.version + 1,
      attendeeIds: [PERSON.divya, PERSON.rohan],
      minutes: 'Agenda sent',
    });
    expect(lastEvent(review.id)).toMatchObject({
      action: 'UPDATE',
      actorId: PERSON.sameer,
      before: { attendeeIds: [PERSON.divya], minutes: null },
      after: { attendeeIds: [PERSON.divya, PERSON.rohan], minutes: 'Agenda sent' },
      reason: null,
    });
    // Nothing changed: no new version, no event.
    const count = isoEvents(app, review.id).length;
    const same = await update(edited, { minutes: 'Agenda sent' }, PERSON.sameer);
    expect(same.version).toBe(edited.version);
    expect(isoEvents(app, review.id)).toHaveLength(count);
  });

  it('lets an approver who chairs it, and every manager, change attendees and minutes', async () => {
    // Nisha approves for Pune only; chairing a review of a Bengaluru system still lets her write it.
    const review = await plan(seedSystem(app, { unitIds: [BENGALURU] }).id, {
      chairId: PERSON.nisha,
      attendeeIds: [],
    });
    let current = await update(
      review,
      { attendeeIds: [PERSON.nisha, ISHAAN], minutes: 'Agenda sent' },
      PERSON.nisha,
    );
    expect(current).toMatchObject({
      version: review.version + 1,
      attendeeIds: [PERSON.nisha, ISHAAN],
      minutes: 'Agenda sent',
    });
    expect(lastEvent(review.id)).toMatchObject({
      action: 'UPDATE',
      actorId: PERSON.nisha,
      after: { attendeeIds: [PERSON.nisha, ISHAAN], minutes: 'Agenda sent' },
      reason: null,
    });
    for (const as of [PERSON.meera, PERSON.arjun, PERSON.kabir]) {
      const result = await call(app, 'updateIsoManagementReview', {
        as,
        params: { id: review.id },
        body: { version: current.version, minutes: `Minutes by ${as}` },
      });
      expect(result.status, JSON.stringify(result.json)).toBe(200);
      current = result.json as ReviewView;
      expect(lastEvent(review.id)).toMatchObject({ action: 'UPDATE', actorId: as });
    }
  });

  it('takes no standards, date or chair, and refuses approvers and owners who do not chair it', async () => {
    const review = await plan(seedSystem(app).id);
    // Standards, date and chair change through replanIsoManagementReview: the body takes none of them, from anyone.
    for (const as of [PERSON.kabir, PERSON.sameer]) {
      for (const [field, body] of [
        ['plannedOn', { plannedOn: '2024-12-20', reason: 'Clash' }],
        ['chairId', { chairId: PERSON.divya, reason: 'Handover' }],
        ['standards', { standards: ['ISO_9001'], minutes: 'Agenda sent' }],
      ] as const) {
        const refused = await fails(
          app,
          'updateIsoManagementReview',
          { as, params: { id: review.id }, body: { version: review.version, ...body } },
          'VALIDATION',
          400,
        );
        expect(JSON.stringify(refused.error.details)).toContain(field);
      }
    }
    expect(stored(review.id)).toMatchObject({
      version: review.version,
      standards: [...ALL],
      plannedOn: '2024-12-01',
      chairId: PERSON.sameer,
      minutes: null,
    });
    expect(isoEvents(app, review.id)).toHaveLength(1);
    // An attendee is not the chair; approvers and owners of its units who do not chair it, and viewers, may not write.
    for (const as of [PERSON.divya, PERSON.nisha, PERSON.rohan, PERSON.vikram]) {
      const refused = await fails(
        app,
        'updateIsoManagementReview',
        { as, params: { id: review.id }, body: { version: review.version, minutes: 'x' } },
        'FORBIDDEN',
        403,
      );
      expect(refused.error.details).toEqual({ action: 'isoReview.write' });
    }
    // An owner outside the review's units does not see it.
    const blr = await plan(seedSystem(app, { unitIds: [BENGALURU] }).id, { attendeeIds: [] });
    await fails(
      app,
      'updateIsoManagementReview',
      { as: PERSON.rohan, params: { id: blr.id }, body: { version: 1, minutes: 'x' } },
      'NOT_FOUND',
      404,
    );
  });

  it('refuses people outside the client and a stale version', async () => {
    const review = await plan(seedSystem(app).id);
    await fails(
      app,
      'updateIsoManagementReview',
      { params: { id: review.id }, body: { version: review.version, attendeeIds: [PERSON.priya] } },
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'updateIsoManagementReview',
      { params: { id: review.id }, body: { version: review.version + 1, minutes: 'x' } },
      'STALE_VERSION',
      409,
    );
  });

  it('takes attendees and minutes once held, and nothing once closed or cancelled', async () => {
    const review = await plan(seedSystem(app).id);
    await noteAll(review.id);
    const held = await hold(review.id);
    await fails(
      app,
      'updateIsoManagementReview',
      { params: { id: review.id }, body: { version: held.version, attendeeIds: [] } },
      'VALIDATION',
      400,
    );
    const edited = await update(held, { minutes: 'Signed minutes' }, PERSON.sameer);
    expect(edited.minutes).toBe('Signed minutes');
    stored(review.id).state = 'CLOSED';
    const closed = await fails(
      app,
      'updateIsoManagementReview',
      { params: { id: review.id }, body: { version: edited.version, minutes: 'Late edit' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(closed.error.details).toEqual({
      entity: 'management_review',
      from: 'CLOSED',
      action: 'UPDATE',
    });
    const cancelled = await plan(seedSystem(app).id);
    await ok(app, 'cancelIsoManagementReview', {
      params: { id: cancelled.id },
      body: { version: cancelled.version, reason: 'Merged' },
    });
    await fails(
      app,
      'updateIsoManagementReview',
      { params: { id: cancelled.id }, body: { version: 2, minutes: 'x' } },
      'INVALID_TRANSITION',
      409,
    );
  });
});

describe('replanning a management review', () => {
  it('lets an account admin, consultant or client admin replan it', async () => {
    const system = seedSystem(app);
    for (const as of [PERSON.meera, PERSON.arjun, PERSON.kabir]) {
      const review = await plan(system.id);
      const result = await call(app, 'replanIsoManagementReview', {
        as,
        params: { id: review.id },
        body: {
          version: review.version,
          plannedOn: '2024-12-20',
          chairId: PERSON.divya,
          reason: 'Plant shutdown',
        },
      });
      expect(result.status, JSON.stringify(result.json)).toBe(200);
      expect(result.json).toMatchObject({
        version: review.version + 1,
        plannedOn: '2024-12-20',
        chairId: PERSON.divya,
        state: 'PLANNED',
      });
      expect(
        isoEvents(app, review.id)
          .slice(-2)
          .map((e) => [e.action, e.actorId]),
      ).toEqual([
        ['DUE_DATE_CHANGE', as],
        ['REASSIGN', as],
      ]);
    }
  });

  it('refuses the chair as approver or owner, other approvers and owners, and viewers', async () => {
    const system = seedSystem(app);
    const byOwner = await plan(system.id); // chaired by Sameer, an owner; Divya attends
    const byApprover = await plan(system.id, { chairId: PERSON.divya, attendeeIds: [] });
    const moved = (review: ReviewView) => ({
      version: review.version,
      plannedOn: '2024-12-20',
      reason: 'Clash',
    });
    for (const [review, as] of [
      [byOwner, PERSON.sameer],
      [byApprover, PERSON.divya],
      [byOwner, PERSON.divya],
      [byOwner, PERSON.nisha],
      [byOwner, PERSON.rohan],
      [byOwner, PERSON.vikram],
    ] as const) {
      const refused = await fails(
        app,
        'replanIsoManagementReview',
        { as, params: { id: review.id }, body: moved(review) },
        'FORBIDDEN',
        403,
      );
      expect(refused.error.details).toEqual({ action: 'isoReview.plan' });
    }
    // Standards alone are a manager's step too.
    await fails(
      app,
      'replanIsoManagementReview',
      {
        as: PERSON.sameer,
        params: { id: byOwner.id },
        body: { version: byOwner.version, standards: ['ISO_9001'] },
      },
      'FORBIDDEN',
      403,
    );
    await fails(
      app,
      'replanIsoManagementReview',
      { as: PERSON.leela, params: { id: byOwner.id }, body: moved(byOwner) },
      'NOT_FOUND',
      404,
    );
    const blr = await plan(seedSystem(app, { unitIds: [BENGALURU] }).id, { attendeeIds: [] });
    await fails(
      app,
      'replanIsoManagementReview',
      { as: PERSON.rohan, params: { id: blr.id }, body: moved(blr) },
      'NOT_FOUND',
      404,
    );
    for (const review of [byOwner, byApprover]) {
      expect(stored(review.id)).toMatchObject({
        version: review.version,
        plannedOn: '2024-12-01',
        standards: [...ALL],
      });
      expect(isoEvents(app, review.id)).toHaveLength(1);
    }
  });

  it('needs a reason for a new date or chair, and none for new standards', async () => {
    const review = await plan(seedSystem(app).id);
    for (const change of [
      { plannedOn: '2024-12-20' },
      { chairId: PERSON.divya },
      { plannedOn: '2024-12-20', standards: ['ISO_9001'] },
      { chairId: PERSON.divya, reason: '   ' },
    ]) {
      await fails(
        app,
        'replanIsoManagementReview',
        { params: { id: review.id }, body: { version: review.version, ...change } },
        'REASON_REQUIRED',
        422,
      );
    }
    expect(isoEvents(app, review.id)).toHaveLength(1);
    const current = await replan(review, { standards: ['ISO_9001', 'ISO_14001'] });
    expect(current).toMatchObject({
      version: review.version + 1,
      standards: ['ISO_9001', 'ISO_14001'],
    });
    expect(lastEvent(review.id)).toMatchObject({
      action: 'UPDATE',
      before: { standards: [...ALL] },
      after: { standards: ['ISO_9001', 'ISO_14001'] },
      reason: null,
    });
    // A reason given with standards alone is not recorded: the change is an UPDATE.
    const narrowed = await replan(current, { standards: ['ISO_9001'], reason: 'Narrowed' });
    expect(narrowed.standards).toEqual(['ISO_9001']);
    expect(lastEvent(review.id)).toMatchObject({ action: 'UPDATE', reason: null });
    expect(isoEvents(app, review.id)).toHaveLength(3);
  });

  it('audits a new date as a due-date change and a new chair as a reassignment, each with its reason', async () => {
    const review = await plan(seedSystem(app).id);
    const moved = await replan(review, {
      plannedOn: '2024-12-20',
      chairId: PERSON.divya,
      standards: ['ISO_9001', 'ISO_14001'],
      reason: 'Plant shutdown',
    });
    expect(moved).toMatchObject({
      version: review.version + 1,
      plannedOn: '2024-12-20',
      chairId: PERSON.divya,
      standards: ['ISO_9001', 'ISO_14001'],
    });
    const events = isoEvents(app, review.id).slice(1);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      action: 'DUE_DATE_CHANGE',
      entityType: 'management_review',
      actorId: PERSON.kabir,
      before: { plannedOn: '2024-12-01' },
      after: { plannedOn: '2024-12-20' },
      reason: 'Plant shutdown',
    });
    expect(events[1]).toMatchObject({
      action: 'REASSIGN',
      before: { chairId: PERSON.sameer },
      after: { chairId: PERSON.divya },
      reason: 'Plant shutdown',
    });
    expect(events[2]).toMatchObject({
      action: 'UPDATE',
      before: { standards: [...ALL] },
      after: { standards: ['ISO_9001', 'ISO_14001'] },
      reason: null,
    });
    expect(Object.keys(events[0]!.before!)).toEqual(['plannedOn']);
    expect(Object.keys(events[1]!.before!)).toEqual(['chairId']);
    // A date alone writes one event; the same date again writes none and keeps the version.
    const later = await replan(moved, { plannedOn: '2024-12-27', reason: 'Auditor away' });
    expect(isoEvents(app, review.id).slice(4)).toMatchObject([
      { action: 'DUE_DATE_CHANGE', after: { plannedOn: '2024-12-27' }, reason: 'Auditor away' },
    ]);
    const same = await replan(later, { plannedOn: '2024-12-27', reason: 'Auditor away' });
    expect(same.version).toBe(later.version);
    expect(isoEvents(app, review.id)).toHaveLength(5);
    // The new chair (an approver) now writes it; the old one no longer does.
    expect((await getReview(review.id, PERSON.divya)).allowedActions).toEqual(['RECORD_HELD']);
    await update(later, { minutes: 'Agenda sent' }, PERSON.divya);
    await fails(
      app,
      'updateIsoManagementReview',
      {
        as: PERSON.sameer,
        params: { id: review.id },
        body: { version: later.version + 1, minutes: 'x' },
      },
      'FORBIDDEN',
      403,
    );
  });

  it('adds and archives input and output rows when its standards change', async () => {
    const review = await plan(seedSystem(app).id);
    const before = await inputs(review.id);
    const previousRow = byKey(before, 'PREVIOUS_ACTIONS');
    let current = await replan(review, { standards: ['ISO_9001', 'ISO_14001'] });
    expect(lastEvent(review.id)).toMatchObject({
      action: 'UPDATE',
      before: { standards: [...ALL] },
      after: {
        standards: ['ISO_9001', 'ISO_14001'],
        inputKeysRemoved: ['INCIDENTS', 'WORKER_CONSULTATION'],
        outputKeysRemoved: ['WORKER_COMMUNICATION'],
      },
      reason: null,
    });
    expect((await inputs(review.id)).map((i) => i.key)).not.toContain('INCIDENTS');
    const archived = firm().iso.reviewInputs.filter(
      (i) => i.managementReviewId === review.id && i.archivedAt !== null,
    );
    expect(archived).toHaveLength(2);
    // Dropping 9001 keeps the shared rows and points them at the 14001 definition.
    current = await replan(current, { standards: ['ISO_14001'] });
    const after = await inputs(review.id);
    const kept = byKey(after, 'PREVIOUS_ACTIONS');
    expect(kept.id).toBe(previousRow.id);
    expect(kept.inputDefId).not.toBe(previousRow.inputDefId);
    expect(kept.clauseRefs).toEqual([{ standard: 'ISO_14001', clauseNumber: '9.3', item: 'a' }]);
    expect(after.map((i) => i.key)).not.toContain('RISK_ACTIONS');
    // The same set in another order is no change.
    const count = isoEvents(app, review.id).length;
    current = await replan(current, { standards: ['ISO_14001'] });
    expect(isoEvents(app, review.id)).toHaveLength(count);
    // Adding a standard back makes new live rows; the archived ones stay archived with their notes (packages
    // ISO-2g: the database keeps one live row per definition).
    const incidentsRow = archived.find(
      (i) =>
        firm().isoCatalogue.reviewInputDefs.find((d) => d.id === i.inputDefId)!.key === 'INCIDENTS',
    )!;
    incidentsRow.notes = 'Two near misses';
    current = await replan(current, { standards: ['ISO_45001', 'ISO_14001'] });
    expect(lastEvent(review.id).after).toMatchObject({
      standards: ['ISO_14001', 'ISO_45001'],
      inputKeysAdded: ['INCIDENTS', 'WORKER_CONSULTATION'],
      outputKeysAdded: ['WORKER_COMMUNICATION'],
    });
    const incidents = byKey(await inputs(review.id), 'INCIDENTS');
    expect(archived.map((i) => i.id)).not.toContain(incidents.id);
    expect(incidents.notes).toBeNull();
    expect(incidentsRow).toMatchObject({ notes: 'Two near misses' });
    expect(incidentsRow.archivedAt).not.toBeNull();
    const live = firm().iso.reviewInputs.filter(
      (i) => i.managementReviewId === review.id && i.archivedAt === null,
    );
    expect(new Set(live.map((i) => i.inputDefId)).size).toBe(live.length);
    // A refused replan changes neither the standards nor the rows.
    const rows = (await inputs(review.id)).length;
    await fails(
      app,
      'replanIsoManagementReview',
      {
        params: { id: review.id },
        body: {
          version: current.version,
          standards: ['ISO_9001'],
          chairId: PERSON.joseph,
          reason: 'Handover',
        },
      },
      'VALIDATION',
      400,
    );
    expect(stored(review.id).standards).toEqual(['ISO_14001', 'ISO_45001']);
    expect(await inputs(review.id)).toHaveLength(rows);
  });

  it('refuses standards outside the system, people outside the client and a stale version', async () => {
    const review = await plan(seedSystem(app, { standards: ['ISO_9001'] }).id, {
      standards: ['ISO_9001'],
    });
    for (const body of [
      { standards: ['ISO_14001'] },
      { chairId: PERSON.vikram, reason: 'Handover' },
      { chairId: PERSON.priya, reason: 'Handover' },
      { chairId: PERSON.gita, reason: 'Handover' },
    ]) {
      await fails(
        app,
        'replanIsoManagementReview',
        { params: { id: review.id }, body: { version: review.version, ...body } },
        'VALIDATION',
        400,
      );
    }
    await fails(
      app,
      'replanIsoManagementReview',
      {
        params: { id: review.id },
        body: { version: review.version + 1, plannedOn: '2024-12-20', reason: 'Clash' },
      },
      'STALE_VERSION',
      409,
    );
    expect(isoEvents(app, review.id)).toHaveLength(1);
  });

  it('replans only while planned', async () => {
    const review = await plan(seedSystem(app).id);
    await noteAll(review.id);
    const held = await hold(review.id);
    for (const body of [
      { plannedOn: '2025-01-05', reason: 'Late' },
      { chairId: PERSON.divya, reason: 'Handover' },
      { standards: ['ISO_9001'] },
    ]) {
      const locked = await fails(
        app,
        'replanIsoManagementReview',
        { params: { id: review.id }, body: { version: held.version, ...body } },
        'INVALID_TRANSITION',
        409,
      );
      expect(locked.error.details).toEqual({
        entity: 'management_review',
        from: 'HELD',
        action: 'UPDATE',
      });
    }
    stored(review.id).state = 'CLOSED';
    const closed = await fails(
      app,
      'replanIsoManagementReview',
      {
        params: { id: review.id },
        body: { version: held.version, plannedOn: '2025-01-05', reason: 'Late' },
      },
      'INVALID_TRANSITION',
      409,
    );
    expect(closed.error.details).toMatchObject({ from: 'CLOSED' });
    const cancelled = await plan(seedSystem(app).id);
    await ok(app, 'cancelIsoManagementReview', {
      params: { id: cancelled.id },
      body: { version: cancelled.version, reason: 'Merged' },
    });
    const gone = await fails(
      app,
      'replanIsoManagementReview',
      { params: { id: cancelled.id }, body: { version: 2, standards: ['ISO_9001'] } },
      'INVALID_TRANSITION',
      409,
    );
    expect(gone.error.details).toMatchObject({ from: 'CANCELLED' });
    expect(stored(review.id)).toMatchObject({ plannedOn: '2024-12-01', chairId: PERSON.sameer });
  });

  it('answers a repeat with the same Idempotency-Key from the first answer, per review', async () => {
    const review = await plan(seedSystem(app).id);
    const other = await plan(seedSystem(app).id);
    const key = seedId();
    const request = (id: string) => ({
      params: { id },
      body: { version: 1, plannedOn: '2024-12-20', reason: 'Auditor away' },
      headers: { 'idempotency-key': key },
    });
    const first = await call(app, 'replanIsoManagementReview', request(review.id));
    const again = await call(app, 'replanIsoManagementReview', request(review.id));
    expect(first.status).toBe(200);
    expect(again).toMatchObject({ status: 200, json: first.json });
    expect(stored(review.id).version).toBe(2);
    expect(isoEvents(app, review.id).map((e) => e.action)).toEqual(['CREATE', 'DUE_DATE_CHANGE']);
    // The same key and body on another review is a new request, not a repeat.
    const elsewhere = await call(app, 'replanIsoManagementReview', request(other.id));
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.json).toMatchObject({ id: other.id, plannedOn: '2024-12-20', version: 2 });
    for (const id of [review.id, other.id]) stored(id).archivedAt = NOW;
  });
});

describe('cancelling, holding and closing a management review', () => {
  it('cancels a planned review with a reason; the chair cannot', async () => {
    const review = await plan(seedSystem(app).id);
    await fails(
      app,
      'cancelIsoManagementReview',
      { as: PERSON.sameer, params: { id: review.id }, body: { version: 1, reason: 'x' } },
      'FORBIDDEN',
      403,
    );
    await fails(
      app,
      'cancelIsoManagementReview',
      { params: { id: review.id }, body: { version: 1 } },
      'REASON_REQUIRED',
      422,
    );
    await fails(
      app,
      'cancelIsoManagementReview',
      { params: { id: review.id }, body: { version: 9, reason: 'x' } },
      'STALE_VERSION',
      409,
    );
    const cancelled = await ok<ReviewView>(app, 'cancelIsoManagementReview', {
      as: PERSON.kabir,
      params: { id: review.id },
      body: { version: 1, reason: 'Merged with the next one' },
    });
    expect(cancelled).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'Merged with the next one',
      allowedActions: [],
    });
    const event = lastEvent(review.id);
    expect(event).toMatchObject({
      action: 'TRANSITION',
      before: { state: 'PLANNED', cancelReason: null },
      after: { action: 'CANCEL', state: 'CANCELLED' },
      reason: 'Merged with the next one',
    });
    expect(event.after).not.toHaveProperty('delegated');
    const again = await fails(
      app,
      'cancelIsoManagementReview',
      { params: { id: review.id }, body: { version: cancelled.version, reason: 'x' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(again.error.details).toEqual({
      entity: 'management_review',
      from: 'CANCELLED',
      action: 'CANCEL',
    });
    const byConsultant = await plan(seedSystem(app).id);
    await ok(app, 'cancelIsoManagementReview', {
      as: PERSON.arjun,
      params: { id: byConsultant.id },
      body: { version: 1, reason: 'Moved' },
    });
    expect(lastEvent(byConsultant.id).after).toMatchObject({ delegated: true });
  });

  it('records a review held once every input has notes, on a day not after today', async () => {
    const review = await plan(seedSystem(app).id, { standards: ['ISO_45001'] });
    const body = { version: 1, heldOn: TODAY };
    const missing = await fails(
      app,
      'recordIsoManagementReviewHeld',
      { as: PERSON.sameer, params: { id: review.id }, body },
      'VALIDATION',
      400,
    );
    expect(JSON.stringify(missing.error.details)).toContain('PREVIOUS_ACTIONS');
    await noteAll(review.id);
    await fails(
      app,
      'recordIsoManagementReviewHeld',
      { as: PERSON.sameer, params: { id: review.id }, body: { ...body, heldOn: '2024-11-16' } },
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'recordIsoManagementReviewHeld',
      { as: PERSON.sameer, params: { id: review.id }, body: { ...body, attendeeIds: [] } },
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'recordIsoManagementReviewHeld',
      {
        as: PERSON.sameer,
        params: { id: review.id },
        body: { ...body, attendeeIds: [PERSON.joseph] },
      },
      'VALIDATION',
      400,
    );
    for (const as of [PERSON.divya, PERSON.rohan, PERSON.vikram]) {
      await fails(
        app,
        'recordIsoManagementReviewHeld',
        { as, params: { id: review.id }, body },
        'FORBIDDEN',
        403,
      );
    }
    await fails(
      app,
      'recordIsoManagementReviewHeld',
      { as: PERSON.sameer, params: { id: review.id }, body: { ...body, version: 9 } },
      'STALE_VERSION',
      409,
    );
    const held = await ok<ReviewView>(app, 'recordIsoManagementReviewHeld', {
      as: PERSON.sameer,
      params: { id: review.id },
      body: {
        version: 1,
        heldOn: '2024-11-14',
        attendeeIds: [PERSON.divya, PERSON.kabir],
        minutes: 'Reviewed all inputs',
      },
    });
    expect(held).toMatchObject({
      state: 'HELD',
      heldOn: '2024-11-14',
      attendeeIds: [PERSON.divya, PERSON.kabir],
      minutes: 'Reviewed all inputs',
      allowedActions: ['CLOSE'],
    });
    const event = lastEvent(review.id);
    expect(event).toMatchObject({
      action: 'TRANSITION',
      actorId: PERSON.sameer,
      before: { state: 'PLANNED', heldOn: null, attendeeIds: [PERSON.divya] },
      after: { action: 'RECORD_HELD', state: 'HELD', heldOn: '2024-11-14' },
    });
    expect(event.after).not.toHaveProperty('delegated');
    await fails(
      app,
      'recordIsoManagementReviewHeld',
      { params: { id: review.id }, body: { version: held.version, heldOn: TODAY } },
      'INVALID_TRANSITION',
      409,
    );
  });

  it('marks a held or closed review recorded by an account admin or consultant as delegated', async () => {
    const byAdmin = await plan(seedSystem(app).id, { standards: ['ISO_45001'] });
    await noteAll(byAdmin.id);
    await hold(byAdmin.id, PERSON.kabir);
    expect(lastEvent(byAdmin.id).after).not.toHaveProperty('delegated');
    const byFirm = await plan(seedSystem(app).id, { standards: ['ISO_45001'] });
    await noteAll(byFirm.id);
    await hold(byFirm.id, PERSON.meera);
    expect(lastEvent(byFirm.id).after).toMatchObject({ delegated: true });
    await decideAll(byFirm.id);
    await ok(app, 'closeIsoManagementReview', {
      as: PERSON.arjun,
      params: { id: byFirm.id },
      body: { version: stored(byFirm.id).version },
    });
    expect(lastEvent(byFirm.id).after).toMatchObject({ action: 'CLOSE', delegated: true });
  });

  it('closes a held review once every output has a decision and every review action is finished', async () => {
    const review = await plan(seedSystem(app).id, { standards: ['ISO_9001'] });
    await fails(
      app,
      'closeIsoManagementReview',
      { params: { id: review.id }, body: { version: 1 } },
      'INVALID_TRANSITION',
      409,
    );
    await noteAll(review.id);
    const held = await hold(review.id);
    const body = { version: held.version };
    const undecided = await fails(
      app,
      'closeIsoManagementReview',
      { as: PERSON.sameer, params: { id: review.id }, body },
      'VALIDATION',
      400,
    );
    expect(JSON.stringify(undecided.error.details)).toContain('RESOURCE_NEEDS');
    await decideAll(review.id);
    const subject = { type: 'MANAGEMENT_REVIEW' as const, id: review.id };
    const open = seedAction(subject, { outputKey: 'IMPROVEMENT' });
    seedAction(subject, { state: 'DONE', doneOn: '2024-11-10' });
    seedAction(subject, { state: 'CANCELLED', cancelReason: 'Not needed' });
    await fails(
      app,
      'closeIsoManagementReview',
      { as: PERSON.sameer, params: { id: review.id }, body },
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'closeIsoManagementReview',
      { as: PERSON.divya, params: { id: review.id }, body },
      'FORBIDDEN',
      403,
    );
    open.state = 'DONE';
    open.doneOn = TODAY;
    await fails(
      app,
      'closeIsoManagementReview',
      { as: PERSON.sameer, params: { id: review.id }, body: { version: 99 } },
      'STALE_VERSION',
      409,
    );
    const closed = await ok<ReviewView>(app, 'closeIsoManagementReview', {
      as: PERSON.sameer,
      params: { id: review.id },
      body,
    });
    expect(closed).toMatchObject({ state: 'CLOSED', heldOn: TODAY, allowedActions: [] });
    expect(lastEvent(review.id)).toMatchObject({
      action: 'TRANSITION',
      before: { state: 'HELD' },
      after: { action: 'CLOSE', state: 'CLOSED' },
    });
    await fails(
      app,
      'closeIsoManagementReview',
      { params: { id: review.id }, body: { version: closed.version } },
      'INVALID_TRANSITION',
      409,
    );
  });
});

describe('review inputs and outputs', () => {
  it('takes notes on an input from the chair or a manager, audited on the review', async () => {
    const review = await plan(seedSystem(app).id);
    const input = byKey(await inputs(review.id), 'CUSTOMER_SATISFACTION');
    expect(input.sourceFigures).toBeNull();
    const params = { id: review.id, inputId: input.id };
    for (const as of [PERSON.divya, PERSON.vikram]) {
      await fails(
        app,
        'updateIsoReviewInput',
        { as, params, body: { version: input.version, notes: 'x' } },
        'FORBIDDEN',
        403,
      );
    }
    const noted = await ok<InputView>(app, 'updateIsoReviewInput', {
      as: PERSON.sameer,
      params,
      body: { version: input.version, notes: 'Survey score 4.2 of 5' },
    });
    expect(noted).toMatchObject({
      version: input.version + 1,
      notes: 'Survey score 4.2 of 5',
      key: 'CUSTOMER_SATISFACTION',
    });
    expect(lastEvent(review.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'management_review',
      before: { input: 'CUSTOMER_SATISFACTION', notes: null },
      after: { input: 'CUSTOMER_SATISFACTION', notes: 'Survey score 4.2 of 5' },
    });
    const count = isoEvents(app, review.id).length;
    const same = await ok<InputView>(app, 'updateIsoReviewInput', {
      params,
      body: { version: noted.version, notes: 'Survey score 4.2 of 5' },
    });
    expect(same.version).toBe(noted.version);
    expect(isoEvents(app, review.id)).toHaveLength(count);
    await fails(
      app,
      'updateIsoReviewInput',
      { params, body: { version: input.version, notes: 'y' } },
      'STALE_VERSION',
      409,
    );
    const other = await plan(seedSystem(app).id);
    await fails(
      app,
      'updateIsoReviewInput',
      { params: { id: other.id, inputId: input.id }, body: { version: 2, notes: 'y' } },
      'NOT_FOUND',
      404,
    );
  });

  it('keeps notes on every input of a held review and refuses notes once closed or cancelled', async () => {
    const review = await plan(seedSystem(app).id, { standards: ['ISO_45001'] });
    await noteAll(review.id);
    await hold(review.id);
    const input = byKey(await inputs(review.id), 'INCIDENTS');
    const params = { id: review.id, inputId: input.id };
    await fails(
      app,
      'updateIsoReviewInput',
      { params, body: { version: input.version, notes: null } },
      'VALIDATION',
      400,
    );
    const edited = await ok<InputView>(app, 'updateIsoReviewInput', {
      params,
      body: { version: input.version, notes: 'One lost-time injury' },
    });
    stored(review.id).state = 'CLOSED';
    const refused = await fails(
      app,
      'updateIsoReviewInput',
      { params, body: { version: edited.version, notes: 'Later' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(refused.error.details).toEqual({
      entity: 'management_review',
      from: 'CLOSED',
      action: 'UPDATE',
    });
  });

  it('takes a decision on an output from the chair or a manager, audited on the review', async () => {
    const review = await plan(seedSystem(app).id, { chairId: PERSON.divya, attendeeIds: [] });
    const output = byKey(await outputs(review.id), 'RESOURCE_NEEDS');
    expect(output.clauseRefs).toEqual([
      { standard: 'ISO_9001', clauseNumber: '9.3.3', item: 'c' },
      { standard: 'ISO_14001', clauseNumber: '9.3', item: null },
      { standard: 'ISO_45001', clauseNumber: '9.3', item: null },
    ]);
    const params = { id: review.id, outputId: output.id };
    await fails(
      app,
      'updateIsoReviewOutput',
      { as: PERSON.sameer, params, body: { version: output.version, decision: 'x' } },
      'FORBIDDEN',
      403,
    );
    const decided = await ok<OutputView>(app, 'updateIsoReviewOutput', {
      as: PERSON.divya,
      params,
      body: { version: output.version, decision: 'Hire a second safety officer' },
    });
    expect(decided).toMatchObject({ decision: 'Hire a second safety officer', version: 2 });
    expect(lastEvent(review.id)).toMatchObject({
      action: 'UPDATE',
      before: { output: 'RESOURCE_NEEDS', decision: null },
      after: { output: 'RESOURCE_NEEDS', decision: 'Hire a second safety officer' },
    });
    const count = isoEvents(app, review.id).length;
    await ok(app, 'updateIsoReviewOutput', {
      params,
      body: { version: 2, decision: 'Hire a second safety officer' },
    });
    expect(isoEvents(app, review.id)).toHaveLength(count);
    await fails(
      app,
      'updateIsoReviewOutput',
      { params, body: { version: 1, decision: 'y' } },
      'STALE_VERSION',
      409,
    );
    const other = await plan(seedSystem(app).id);
    await fails(
      app,
      'updateIsoReviewOutput',
      { params: { id: other.id, outputId: output.id }, body: { version: 2, decision: 'y' } },
      'NOT_FOUND',
      404,
    );
    await ok(app, 'cancelIsoManagementReview', {
      params: { id: review.id },
      body: { version: stored(review.id).version, reason: 'Merged' },
    });
    await fails(
      app,
      'updateIsoReviewOutput',
      { params, body: { version: 2, decision: null } },
      'INVALID_TRANSITION',
      409,
    );
  });
});

describe('review input figures', () => {
  // A system set up on 2024-04-01 (IST; 2024-03-31 UTC), an integrated review held on 2024-06-30, a 9001-only one on
  // 2024-09-30, and records before and after them.
  let system: IsoRow<'managementSystems'>;
  let current: ReviewView;
  let earlier: IsoRow<'managementReviews'>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    system = seedSystem(app, { climateChangeRelevant: true });
    system.createdAt = '2024-03-31T20:00:00Z';
    const at = (day: string) => `${day}T06:30:00Z`;
    earlier = seedReview(system.id, { createdAt: at('2024-06-01') });
    seedReview(system.id, {
      standards: ['ISO_9001'],
      plannedOn: '2024-09-30',
      heldOn: '2024-09-30',
      state: 'HELD',
    });
    const reviewAction = { type: 'MANAGEMENT_REVIEW' as const, id: earlier.id };
    ids.actionOpen = seedAction(reviewAction, { dueOn: '2024-09-30' }).id;
    ids.actionDone = seedAction(reviewAction, { state: 'DONE', doneOn: '2024-07-15' }).id;
    ids.actionCancelled = seedAction(reviewAction, {
      state: 'CANCELLED',
      cancelReason: 'Overtaken',
    }).id;

    ids.issueAdded = seedContext(system.id).id;
    ids.partyChanged = seedContext(system.id, {
      kind: 'INTERESTED_PARTY',
      needs: 'Timely permits',
      createdAt: at('2024-05-01'),
      updatedAt: at('2024-08-01'),
    }).id;
    seedEvent({
      at: at('2024-08-01'),
      action: 'UPDATE',
      entityType: 'context_item',
      entityId: ids.partyChanged,
      before: { needs: 'Permits' },
      after: { needs: 'Timely permits' },
    });
    seedContext(system.id, { createdAt: at('2024-05-01'), updatedAt: at('2024-05-01') });
    ids.contextRemoved = seedContext(system.id, {
      createdAt: at('2024-05-01'),
      archivedAt: at('2024-07-01'),
    }).id;

    ids.riskNew = seedRisk(system.id).id;
    ids.hazard = seedRisk(system.id, {
      kind: 'HAZARD',
      unitId: BENGALURU,
      impact: 'Burns',
      routine: true,
      personsExposed: ['WORKER'],
      condition: 'NORMAL',
      likelihood: 2,
      severity: 3,
      rating: 6,
      significant: false,
      createdAt: at('2024-05-01'),
    }).id;
    firm().data.auditEvents.push({
      id: seedId(),
      firmId: FIRM_B,
      clientId: NORTHWIND,
      at: at('2024-08-01'),
      requestId: 'seeded',
      actorId: PERSON.sameer,
      actorKind: 'PERSON',
      action: 'UPDATE',
      entityType: 'risk_item',
      entityId: ids.hazard,
      before: { likelihood: 1, rating: 3 },
      after: { likelihood: 2, rating: 6 },
      reason: null,
    });
    const riskSubject = { type: 'RISK_ITEM' as const, id: ids.riskNew };
    ids.treatmentDone = seedAction(riskSubject, { state: 'DONE', doneOn: '2024-10-01' }).id;
    ids.treatmentOpen = seedAction(riskSubject).id;

    const onTrack = seedObjective(system.id, { standards: ['ISO_14001'] });
    ids.onTrack = onTrack.id;
    ids.reading1 = seedReading(onTrack.id, 120).id;
    const offTrack = seedObjective(system.id, {
      standards: ['ISO_9001', 'ISO_14001'],
      baseline: 0,
      createdAt: at('2024-04-01'),
    });
    ids.offTrack = offTrack.id;
    ids.reading2 = seedReading(offTrack.id, 10).id;
    ids.noReading = seedObjective(system.id, {
      direction: 'DECREASE',
      baseline: 50,
      target: 10,
    }).id;
    ids.achieved = seedObjective(system.id, {
      standards: ['ISO_45001'],
      closedOn: '2024-10-01',
      outcome: 'ACHIEVED',
    }).id;

    ids.nc1 = seedNc(system.id, { reportedOn: '2024-08-01' }).id;
    ids.nc2 = seedNc(system.id, {
      source: 'INTERNAL_AUDIT',
      severity: 'MAJOR',
      standards: ['ISO_14001'],
      createdAt: at('2024-05-01'),
      reportedOn: '2024-05-01',
      ...closedNc('2024-09-01'),
    }).id;
    ids.incident = seedNc(system.id, {
      source: 'INCIDENT',
      standards: ['ISO_45001'],
      unitId: BENGALURU,
      ownerId: ISHAAN,
      approverId: PERSON.divya,
      reportedOn: '2024-08-10',
      incident: {
        occurredAt: '2024-08-10T04:00:00Z',
        location: 'Loading dock',
        type: 'INJURY',
        outcome: 'LOST_TIME',
        personCategory: 'EMPLOYEE',
        lostDays: 3,
        reportable: true,
        statutoryInstanceId: null,
        investigatorIds: [],
        workerParticipation: true,
      },
    }).id;
    for (const day of ['2024-06-01', '2024-09-01']) {
      firm().data.auditEvents.push({
        id: seedId(),
        firmId: FIRM_B,
        clientId: NORTHWIND,
        at: at(day),
        requestId: 'seeded',
        actorId: PERSON.nisha,
        actorKind: 'PERSON',
        action: 'TRANSITION',
        entityType: 'nonconformity',
        entityId: ids.nc1,
        before: { state: 'AWAITING_VERIFICATION' },
        after: { action: 'VERIFY_NOT_EFFECTIVE', state: 'OPEN' },
        reason: 'Recurred',
      });
    }
    const ncSubject = { type: 'NONCONFORMITY' as const, id: ids.nc1 };
    ids.correctiveOverdue = seedAction(ncSubject, { dueOn: '2024-10-01' }).id;
    seedAction(ncSubject, { dueOn: '2024-12-31' });

    const programme = seedProgramme(system.id);
    ids.auditReported = seedAudit(programme.id, reported('2024-09-15')).id;
    ids.findingMinor = seedFinding({
      internalAuditId: ids.auditReported,
      type: 'MINOR_NC',
      nonconformityId: ids.nc1,
    }).id;
    ids.findingObservation = seedFinding({ internalAuditId: ids.auditReported }).id;
    // Reported before the 2024-06-30 review: a row with no trail takes its updatedAt as the REPORT step's time.
    const old = seedAudit(programme.id, {
      ...reported('2024-05-01'),
      createdAt: at('2024-04-20'),
      updatedAt: at('2024-05-01'),
    });
    seedFinding({
      internalAuditId: old.id,
      type: 'OFI',
      createdAt: at('2024-04-30'),
      updatedAt: at('2024-04-30'),
    });
    ids.external = seedExternal(system.id, { state: 'HELD' }).id;
    ids.findingOfi = seedFinding({ externalAuditId: ids.external, type: 'OFI' }).id;
    seedExternal(system.id);

    current = await plan(system.id);
  });

  const figures = async (key: string, as = PERSON.kabir, reviewId = current.id) =>
    byKey(await inputs(reviewId, as), key);

  const expectFigure = (input: InputView, key: string, expected: string[]) =>
    expect(sorted(figureOf(input, key).ids), key).toEqual(sorted(expected));

  it('counts from the last held review covering each standard of the input, up to today', async () => {
    const all = await inputs(current.id);
    expect(byKey(all, 'NONCONFORMITIES').sourceFigures).toMatchObject({
      source: 'NONCONFORMITIES',
      since: '2024-06-30',
      asOf: TODAY,
    });
    expect(byKey(all, 'RISK_ACTIONS').sourceFigures!.since).toBe('2024-09-30');
    expect(byKey(all, 'SIGNIFICANT_ASPECTS').sourceFigures!.since).toBe('2024-06-30');
    for (const input of all) {
      expect(input.sourceFigures === null, input.key).toBe(input.source === 'MANUAL');
      expect(input.figuresStoredAt, input.key).toBeNull();
    }
    // Recorded held on a day before the 2024-06-30 review, a review counts from the system's creation day in the
    // client's time zone: only reviews held on or before its own heldOn come before it.
    const backdated = await plan(system.id, { plannedOn: '2024-05-15' });
    await noteAll(backdated.id);
    await hold(backdated.id, PERSON.kabir, { heldOn: '2024-05-15' });
    const own = byKey(await inputs(backdated.id), 'NONCONFORMITIES');
    expect(own.sourceFigures).toMatchObject({ since: '2024-04-01', asOf: '2024-05-15' });
    stored(backdated.id).archivedAt = NOW;
  });

  it('gives the actions of earlier reviews by state', async () => {
    const input = await figures('PREVIOUS_ACTIONS');
    expectFigure(input, 'actionsOpen', [ids.actionOpen!]);
    expectFigure(input, 'actionsOverdue', [ids.actionOpen!]);
    expectFigure(input, 'actionsDone', [ids.actionDone!]);
    expectFigure(input, 'actionsCancelled', [ids.actionCancelled!]);
  });

  it('gives context changes and the climate decision', async () => {
    const input = await figures('CONTEXT_CHANGES');
    expectFigure(input, 'issuesAdded', [ids.issueAdded!]);
    expectFigure(input, 'issuesChanged', []);
    expectFigure(input, 'interestedPartiesAdded', []);
    expectFigure(input, 'interestedPartiesChanged', [ids.partyChanged!]);
    expectFigure(input, 'contextItemsRemoved', [ids.contextRemoved!]);
    for (const key of ['climateDecided', 'climateRelevant', 'climateDecidedInPeriod']) {
      expectFigure(input, key, [system.id]);
    }
    expect(byKey(await inputs(current.id), 'INTERESTED_PARTIES').sourceFigures!.source).toBe(
      'CONTEXT',
    );
  });

  it('gives risk items added and re-rated, significant items by kind and treatment actions', async () => {
    const input = await figures('RISKS_AND_OPPORTUNITIES');
    expectFigure(input, 'itemsAdded', [ids.riskNew!]);
    expectFigure(input, 'itemsRerated', [ids.hazard!]);
    expectFigure(input, 'significantRisk', [ids.riskNew!]);
    expectFigure(input, 'significantHazard', []);
    expectFigure(input, 'treatmentActionsDone', [ids.treatmentDone!]);
    expectFigure(input, 'treatmentActionsOpen', [ids.treatmentOpen!]);
    // Since the 9001 review of 2024-09-30, the re-rating of 2024-08-01 is older.
    expectFigure(await figures('RISK_ACTIONS'), 'itemsRerated', []);
    // An approver of Pune does not get the Bengaluru hazard's id, but the value counts the whole system.
    const pune = await figures('RISKS_AND_OPPORTUNITIES', PERSON.nisha);
    expect(figureOf(pune, 'itemsRerated')).toEqual({ key: 'itemsRerated', value: 1, ids: [] });
  });

  it("gives each objective's progress once under every standard it lists", async () => {
    const input = await figures('OBJECTIVES');
    expectFigure(input, 'objectivesOpen', [ids.onTrack!, ids.offTrack!, ids.noReading!]);
    expectFigure(input, 'onTrack', [ids.onTrack!]);
    expectFigure(input, 'offTrack', [ids.offTrack!]);
    expectFigure(input, 'withoutReading', [ids.noReading!]);
    expectFigure(input, 'achieved', [ids.achieved!]);
    expectFigure(input, 'notAchieved', []);
    expectFigure(input, 'readingsRecorded', [ids.reading1!, ids.reading2!]);
    const ohs = await plan(system.id, { standards: ['ISO_45001'] });
    const only45001 = await figures('OBJECTIVES', PERSON.kabir, ohs.id);
    expectFigure(only45001, 'objectivesOpen', []);
    expectFigure(only45001, 'achieved', [ids.achieved!]);
    expectFigure(await figures('AUDIT_RESULTS', PERSON.kabir, ohs.id), 'externalAuditsHeld', []);
  });

  it('gives nonconformities raised and closed by source and severity, and what is overdue', async () => {
    const input = await figures('NONCONFORMITIES');
    expectFigure(input, 'raised', [ids.nc1!, ids.incident!]);
    expectFigure(input, 'closed', [ids.nc2!]);
    expectFigure(input, 'raisedMinor', [ids.nc1!, ids.incident!]);
    expectFigure(input, 'raisedMajor', []);
    expectFigure(input, 'raisedProcess', [ids.nc1!]);
    expectFigure(input, 'raisedIncident', [ids.incident!]);
    expectFigure(input, 'closedMajor', [ids.nc2!]);
    expectFigure(input, 'closedInternalAudit', [ids.nc2!]);
    expectFigure(input, 'open', [ids.nc1!, ids.incident!]);
    expect(figureOf(input, 'verifiedNotEffective')).toEqual({
      key: 'verifiedNotEffective',
      value: 1,
      ids: [ids.nc1],
    });
    expectFigure(input, 'correctiveActionsOverdue', [ids.correctiveOverdue!]);
    // Unit scope cuts the ids, not the values: an approver of Pune gets 2 raised, with only the Pune id.
    const pune = await figures('NONCONFORMITIES', PERSON.nisha);
    expect(figureOf(pune, 'raised')).toEqual({ key: 'raised', value: 2, ids: [ids.nc1] });
    expect(figureOf(pune, 'raisedIncident')).toEqual({ key: 'raisedIncident', value: 1, ids: [] });
  });

  it('gives incidents by type and outcome, with the lost days', async () => {
    const input = await figures('INCIDENTS');
    expect(input.clauseRefs).toEqual([{ standard: 'ISO_45001', clauseNumber: '9.3', item: 'd1' }]);
    expectFigure(input, 'incidents', [ids.incident!]);
    expectFigure(input, 'typeInjury', [ids.incident!]);
    expectFigure(input, 'typeNearMiss', []);
    expectFigure(input, 'outcomeLostTime', [ids.incident!]);
    expect(figureOf(input, 'lostDays')).toEqual({ key: 'lostDays', value: 3, ids: [ids.incident] });
  });

  it('gives audits reported and held in the period, with their findings by type', async () => {
    const input = await figures('AUDIT_RESULTS');
    expectFigure(input, 'internalAuditsReported', [ids.auditReported!]);
    expectFigure(input, 'externalAuditsHeld', [ids.external!]);
    expectFigure(input, 'findingsMinorNc', [ids.findingMinor!]);
    expectFigure(input, 'findingsObservation', [ids.findingObservation!]);
    expectFigure(input, 'findingsOfi', [ids.findingOfi!]);
    expectFigure(input, 'findingsMajorNc', []);
  });

  it('gives the evaluation of compliance and the statutory score for the period', async () => {
    // On a Harbour system, where the evaluation activity is assigned to its store.
    const harbour = seedSystem(app, { clientId: HARBOUR, standards: ['ISO_14001'] });
    harbour.createdAt = '2024-06-30T06:30:00Z';
    const data = firm().data;
    const obligation = data.obligations.find((o) => o.externalRef === 'ISO-COMPLIANCE-EVALUATION')!;
    const assignment = {
      ...data.assignments[0]!,
      id: seedId(),
      clientId: HARBOUR,
      unitId: CHENNAI,
      obligationId: obligation.id,
      departmentId: data.departments.find((d) => d.clientId === HARBOUR)!.id,
      defaultOwnerId: PERSON.joseph,
      defaultApproverId: PERSON.priya,
    };
    data.assignments.push(assignment);
    const instance = (dueDate: string, done: boolean) => {
      const row = {
        ...data.instances[0]!,
        id: seedId(),
        clientId: HARBOUR,
        unitId: CHENNAI,
        assignmentId: assignment.id,
        periodStart: '2024-04-01',
        periodEnd: '2024-09-30',
        dueDate,
        workflowState: done ? ('APPROVED' as const) : ('OPEN' as const),
        pendingKind: null,
        completedOn: done ? '2024-09-28' : null,
        ownerId: PERSON.joseph,
        approverId: PERSON.priya,
        submittedAt: done ? NOW : null,
        approvedAt: done ? NOW : null,
      };
      data.instances.push(row);
      return row.id;
    };
    const done = instance('2024-09-30', true);
    const latest = instance('2024-10-15', false);
    instance('2025-03-31', false);
    const review = await plan(
      harbour.id,
      { standards: ['ISO_14001'], chairId: PERSON.priya, attendeeIds: [] },
      PERSON.leela,
      HARBOUR,
    );
    const input = byKey(await inputs(review.id, PERSON.leela, HARBOUR), 'COMPLIANCE_EVALUATION');
    expect(input.sourceFigures).toMatchObject({ since: '2024-06-30', asOf: TODAY });
    expectFigure(input, 'evaluationsDue', [done, latest]);
    expectFigure(input, 'evaluationsDone', [done]);
    expectFigure(input, 'latestEvaluation', [latest]);
    const statutory = data.instances.filter((i) => {
      const a = data.assignments.find((x) => x.id === i.assignmentId)!;
      const act = data.acts.find(
        (x) => x.id === data.obligations.find((o) => o.id === a.obligationId)!.actId,
      )!;
      return (
        i.clientId === HARBOUR &&
        i.archivedAt === null &&
        act.kind !== 'STANDARD' &&
        i.dueDate >= '2024-06-30' &&
        i.dueDate <= TODAY
      );
    });
    expectFigure(
      input,
      'statutoryInstancesDue',
      statutory.map((i) => i.id),
    );
    const score = input.sourceFigures!.figures.find((f) => f.key === 'statutoryScore');
    if (statutory.length === 0) expect(score).toBeUndefined();
    else expect(score).toMatchObject({ ids: [] });
    // With nothing due in the period there is no score.
    harbour.createdAt = NOW;
    const none = byKey(await inputs(review.id, PERSON.leela, HARBOUR), 'COMPLIANCE_EVALUATION');
    expect(none.sourceFigures!.since).toBe(TODAY);
    expect(none.sourceFigures!.figures.map((f) => f.key)).not.toContain('statutoryScore');
  });

  /** A system set up on 2024-04-01, for a review recorded held in a test. */
  const freshSystem = () => {
    const fresh = seedSystem(app);
    fresh.createdAt = '2024-04-01T06:30:00Z';
    return fresh;
  };
  const early = { createdAt: '2024-09-01T06:30:00Z', updatedAt: '2024-09-01T06:30:00Z' };

  it("stores the fixture's held review figures once, counted up to its heldOn", async () => {
    // Firm B's integrated review, held on 2024-10-28 and recorded on 2024-10-30, before any record of this suite.
    const held = fixtureId('firm-b:iso:review:2024');
    const all = await inputs(held);
    for (const input of all) {
      if (input.source === 'MANUAL') {
        expect(input, input.key).toMatchObject({ sourceFigures: null, figuresStoredAt: null });
        continue;
      }
      expect(input.sourceFigures, input.key).toMatchObject({
        since: '2024-04-10',
        asOf: '2024-10-28',
      });
      expect(input.figuresStoredAt, input.key).toBe('2024-10-30T05:30:00Z');
      expect(input, input.key).not.toHaveProperty('figuresEngineVersion');
    }
    const row = firm().iso.reviewInputs.find((r) => r.id === byKey(all, 'NONCONFORMITIES').id)!;
    expect(row.figuresEngineVersion).toBe('mock-1');
    // A nonconformity recorded today and backdated into the window does not move them.
    const ims = fixtureId('firm-b:iso:system:ims');
    const late = seedNc(ims, { reportedOn: '2024-10-01' });
    expect(await inputs(held)).toEqual(all);
    late.archivedAt = NOW;
  });

  it('stores the figures at RECORD_HELD and shows that copy whatever changes after', async () => {
    const fresh = freshSystem();
    const nc = seedNc(fresh.id, { ...early, reportedOn: '2024-09-01' });
    const review = await plan(fresh.id);
    await noteAll(review.id);
    const live = byKey(await inputs(review.id), 'NONCONFORMITIES');
    expect(live).toMatchObject({ figuresStoredAt: null, sourceFigures: { asOf: TODAY } });
    await hold(review.id);
    const held = await inputs(review.id);
    const ncs = byKey(held, 'NONCONFORMITIES');
    expect(ncs).toMatchObject({
      figuresStoredAt: NOW,
      sourceFigures: { since: '2024-04-01', asOf: TODAY },
    });
    expect(figureOf(ncs, 'open').ids).toEqual([nc.id]);
    // Storing leaves the row's version alone, so notes still save with the version read before.
    expect(ncs.version).toBe(live.version);
    // The event carries each stored input's values and the engine version, and no ids (model §8).
    const event = lastEvent(review.id);
    expect(event.after).toMatchObject({ action: 'RECORD_HELD', engineVersion: 'mock-1' });
    const values = (input: InputView) =>
      Object.fromEntries(input.sourceFigures!.figures.map((f) => [f.key, f.value]));
    const storedEvent = (event.after as { figures: { key: string }[] }).figures;
    expect(storedEvent.map((f) => f.key)).toEqual(
      held.filter((i) => i.source !== 'MANUAL').map((i) => i.key),
    );
    expect(storedEvent.find((f) => f.key === 'NONCONFORMITIES')).toEqual({
      key: 'NONCONFORMITIES',
      source: 'NONCONFORMITIES',
      since: '2024-04-01',
      asOf: TODAY,
      values: values(ncs),
    });
    expect(JSON.stringify(event.after)).not.toContain(nc.id);

    // Later: the NC closed, another raised and backdated, a re-rating, notes edited, the review closed.
    Object.assign(nc, closedNc(TODAY));
    const later = seedNc(fresh.id, { reportedOn: '2024-10-01' });
    const risk = seedRisk(fresh.id, early);
    seedEvent({
      at: NOW,
      action: 'UPDATE',
      entityType: 'risk_item',
      entityId: risk.id,
      before: { likelihood: 2 },
      after: { likelihood: 3 },
    });
    await ok(app, 'updateIsoReviewInput', {
      params: { id: review.id, inputId: ncs.id },
      body: { version: ncs.version, notes: 'Revised' },
    });
    await decideAll(review.id);
    await ok(app, 'closeIsoManagementReview', {
      params: { id: review.id },
      body: { version: (await getReview(review.id)).version },
    });
    const after = await inputs(review.id);
    for (const input of after) {
      const was = byKey(held, input.key);
      expect(input.sourceFigures, input.key).toEqual(was.sourceFigures);
      expect(input.figuresStoredAt, input.key).toEqual(was.figuresStoredAt);
    }
    expect(byKey(after, 'NONCONFORMITIES').notes).toBe('Revised');
    for (const row of [nc, later, risk]) row.archivedAt = NOW;
  });

  it('counts a backdated heldOn up to that day, with the date rules of model §5.4', async () => {
    const fresh = freshSystem();
    const closedLater = seedNc(fresh.id, { ...early, ...closedNc('2024-11-05') });
    const closedBefore = seedNc(fresh.id, { ...early, ...closedNc('2024-10-20') });
    const recordedLater = seedNc(fresh.id, { reportedOn: '2024-10-01' });
    const reportedLater = seedNc(fresh.id, { ...early, reportedOn: '2024-11-01' });
    const archivedLater = seedNc(fresh.id, { ...early, archivedAt: '2024-11-05T06:30:00Z' });
    const archivedThatDay = seedNc(fresh.id, { ...early, archivedAt: '2024-10-28T12:00:00Z' });
    const cancelledLater = seedNc(fresh.id, {
      ...early,
      state: 'CANCELLED',
      cancelReason: 'Raised twice',
      updatedAt: NOW,
    });
    const onNc = { type: 'NONCONFORMITY' as const, id: closedLater.id };
    const due = { ...early, dueOn: '2024-10-20' };
    const doneLater = seedAction(onNc, { ...due, state: 'DONE', doneOn: '2024-11-05' });
    const doneBefore = seedAction(onNc, { ...due, state: 'DONE', doneOn: '2024-10-22' });
    const objectiveClosedLater = seedObjective(fresh.id, {
      ...early,
      closedOn: '2024-11-05',
      outcome: 'ACHIEVED',
    });
    const review = await plan(fresh.id, { plannedOn: '2024-10-28' });
    await noteAll(review.id);
    await hold(review.id, PERSON.kabir, { heldOn: '2024-10-28' });

    const ncs = byKey(await inputs(review.id), 'NONCONFORMITIES');
    expect(ncs.sourceFigures).toMatchObject({ since: '2024-04-01', asOf: '2024-10-28' });
    expect(sorted(figureOf(ncs, 'open').ids)).toEqual(sorted([closedLater.id, archivedLater.id]));
    expect(sorted(figureOf(ncs, 'raised').ids)).toEqual(
      sorted([closedLater.id, closedBefore.id, archivedLater.id, cancelledLater.id]),
    );
    expect(figureOf(ncs, 'closed').ids).toEqual([closedBefore.id]);
    expect(figureOf(ncs, 'correctiveActionsOverdue').ids).toEqual([doneLater.id]);
    for (const out of [recordedLater, reportedLater, archivedThatDay]) {
      expect(figureOf(ncs, 'raised').ids).not.toContain(out.id);
    }
    const objectives = byKey(await inputs(review.id), 'OBJECTIVES');
    expect(figureOf(objectives, 'objectivesOpen').ids).toEqual([objectiveClosedLater.id]);
    expect(figureOf(objectives, 'achieved').ids).toEqual([]);
    for (const row of [closedLater, closedBefore, recordedLater, reportedLater, cancelledLater]) {
      row.archivedAt = NOW;
    }
    for (const row of [doneLater, doneBefore, objectiveClosedLater]) row.archivedAt = NOW;
  });

  it('takes since from the reviews already held on or before its heldOn, and leaves their figures', async () => {
    const fresh = freshSystem();
    const first = await plan(fresh.id, { plannedOn: '2024-11-10' });
    const second = await plan(fresh.id, { plannedOn: '2024-11-10' });
    const third = await plan(fresh.id, { plannedOn: '2024-11-05' });
    const action = seedAction({ type: 'MANAGEMENT_REVIEW', id: first.id }, early);
    for (const review of [first, second, third]) await noteAll(review.id);
    await hold(first.id, PERSON.kabir, { heldOn: '2024-11-10' });
    const firstFigures = (await inputs(first.id)).map((i) => i.sourceFigures);
    await hold(second.id, PERSON.kabir, { heldOn: '2024-11-10' });
    await hold(third.id, PERSON.kabir, { heldOn: '2024-11-05' });
    const of = async (id: string, key: string) => byKey(await inputs(id), key);
    expect((await of(first.id, 'NONCONFORMITIES')).sourceFigures!.since).toBe('2024-04-01');
    // Held the same day and recorded after: the first comes before it, with its actions.
    expect((await of(second.id, 'NONCONFORMITIES')).sourceFigures!.since).toBe('2024-11-10');
    expectFigure(await of(second.id, 'PREVIOUS_ACTIONS'), 'actionsOpen', [action.id]);
    expectFigure(await of(first.id, 'PREVIOUS_ACTIONS'), 'actionsOpen', []);
    // Held before both, though recorded last: neither comes before it.
    expect((await of(third.id, 'NONCONFORMITIES')).sourceFigures!.since).toBe('2024-04-01');
    expectFigure(await of(third.id, 'PREVIOUS_ACTIONS'), 'actionsOpen', []);
    expect((await inputs(first.id)).map((i) => i.sourceFigures)).toEqual(firstFigures);
    action.archivedAt = NOW;
  });

  it('counts the whole system in a held review too, and gives each reader the ids they may read', async () => {
    const review = await plan(system.id);
    await noteAll(review.id);
    await hold(review.id);
    const all = await figures('NONCONFORMITIES', PERSON.kabir, review.id);
    const pune = await figures('NONCONFORMITIES', PERSON.nisha, review.id);
    expect(figureOf(all, 'raised').ids).toContain(ids.incident);
    expect(figureOf(pune, 'raised').value).toBe(figureOf(all, 'raised').value);
    expect(figureOf(pune, 'raised').ids).not.toContain(ids.incident);
    expect(figureOf(pune, 'raised').ids).toContain(ids.nc1);
    expect(figureOf(pune, 'raisedIncident')).toEqual({
      key: 'raisedIncident',
      value: 1,
      ids: [],
    });
    // The stored row keeps every id; only the answer is cut.
    const row = firm().iso.reviewInputs.find((r) => r.id === pune.id)!;
    expect(row.sourceFigures!.figures.find((f) => f.key === 'raised')!.ids).toContain(ids.incident);
    stored(review.id).archivedAt = NOW;
  });

  it('gives no figures for a CANCELLED review, nor for a held one whose rows stored none', async () => {
    const review = await plan(system.id);
    await ok(app, 'cancelIsoManagementReview', {
      params: { id: review.id },
      body: { version: review.version, reason: 'Merged with the next one' },
    });
    for (const input of await inputs(review.id)) {
      expect(input, input.key).toMatchObject({ sourceFigures: null, figuresStoredAt: null });
    }
    // The seeded 2024-06-30 review has a row that stored nothing.
    seed(app, 'reviewInputs', {
      ...base(),
      managementReviewId: earlier.id,
      inputDefId: firm().isoCatalogue.reviewInputDefs.find((d) => d.key === 'NONCONFORMITIES')!.id,
      notes: 'Discussed',
    });
    expect(byKey(await inputs(earlier.id), 'NONCONFORMITIES')).toMatchObject({
      sourceFigures: null,
      figuresStoredAt: null,
    });
    stored(review.id).archivedAt = NOW;
  });

  it("counts window events by the client's local day across midnight, and no residual clearing as a re-rating", async () => {
    const fresh = freshSystem();
    const sameDay = seedContext(fresh.id, early);
    const nextDay = seedContext(fresh.id, early);
    // An earlier review held after the items were made, so they count as changed, not added.
    const before = seedReview(fresh.id, { plannedOn: '2024-09-15', heldOn: '2024-09-15' });
    const update = (entityId: string, at: string) =>
      seedEvent({
        at,
        action: 'UPDATE',
        entityType: 'context_item',
        entityId,
        before: { text: 'Old packing line' },
        after: { text: 'New packing line' },
      });
    // 18:00 UTC is 23:30 on 2024-10-28 in Kolkata; 18:45 UTC is 00:15 on 2024-10-29, after heldOn.
    update(sameDay.id, '2024-10-28T18:00:00Z');
    update(nextDay.id, '2024-10-28T18:45:00Z');
    const rerated = seedRisk(fresh.id, early);
    const cleared = seedRisk(fresh.id, early);
    const moved = seedRisk(fresh.id, early);
    const on = '2024-10-01T06:30:00Z';
    seedEvent({
      at: on,
      action: 'UPDATE',
      entityType: 'risk_item',
      entityId: rerated.id,
      before: { likelihood: 2, rating: 6 },
      after: { likelihood: 3, rating: 9 },
    });
    // A treatment action put the last control in place, which clears the residual rating (model §3.5).
    seedEvent({
      at: on,
      action: 'UPDATE',
      entityType: 'risk_item',
      entityId: cleared.id,
      before: { residualLikelihood: 2, residualSeverity: 2, residualRating: 4 },
      after: {
        residualLikelihood: null,
        residualSeverity: null,
        residualRating: null,
        sourceActionId: seedId(),
      },
    });
    seedEvent({
      at: on,
      action: 'DUE_DATE_CHANGE',
      entityType: 'risk_item',
      entityId: moved.id,
      before: { reviewDueOn: '2024-12-01' },
      after: { reviewDueOn: '2025-01-01' },
      reason: 'Auditor away',
    });
    const review = await plan(fresh.id, { plannedOn: '2024-10-28' });
    await noteAll(review.id);
    await hold(review.id, PERSON.kabir, { heldOn: '2024-10-28' });
    const context = byKey(await inputs(review.id), 'CONTEXT_CHANGES');
    expect(figureOf(context, 'issuesChanged').ids).toEqual([sameDay.id]);
    const risks = byKey(await inputs(review.id), 'RISKS_AND_OPPORTUNITIES');
    expect(figureOf(risks, 'itemsRerated').ids).toEqual([rerated.id]);
    for (const row of [sameDay, nextDay, rerated, cleared, moved, before]) row.archivedAt = NOW;
  });

  it('reads a review not held as of today in the client time zone, with every record made by now', async () => {
    // Now is 06:30 UTC on 2024-11-15, still 2024-11-14 in Los Angeles: as-of is the client's day, not the mock's.
    const client = firm().data.clients.find((c) => c.id === NORTHWIND)!;
    const settings = client.settings;
    client.settings = { ...settings, timeZone: 'America/Los_Angeles' };
    try {
      const ims = fixtureId('firm-b:iso:system:ims');
      const justNow = seedObjective(ims, { createdAt: NOW, updatedAt: NOW });
      const review = await plan(ims);
      const objectives = byKey(await inputs(review.id), 'OBJECTIVES');
      expect(TODAY).toBe('2024-11-15');
      expect(objectives.sourceFigures!.asOf).toBe('2024-11-14');
      expect(figureOf(objectives, 'objectivesOpen').ids).toContain(justNow.id);
      // RECORD_HELD takes the same day as today, so stored figures never count a day not yet begun for the client.
      await noteAll(review.id);
      await fails(
        app,
        'recordIsoManagementReviewHeld',
        { params: { id: review.id }, body: { version: 1, heldOn: TODAY } },
        'VALIDATION',
        400,
      );
      await hold(review.id, PERSON.kabir, { heldOn: '2024-11-14' });
      const held = byKey(await inputs(review.id), 'OBJECTIVES');
      expect(held.sourceFigures!.asOf).toBe('2024-11-14');
      justNow.archivedAt = NOW;
      stored(review.id).archivedAt = NOW;
    } finally {
      client.settings = settings;
    }
  });

  it("stores a backdated review's statutory figures from the instances live on its heldOn", async () => {
    const fresh = freshSystem();
    const data = firm().data;
    const statute = data.instances.find((i) => {
      if (i.clientId !== NORTHWIND || i.archivedAt !== null) return false;
      const assignment = data.assignments.find((a) => a.id === i.assignmentId)!;
      const obligation = data.obligations.find((o) => o.id === assignment.obligationId)!;
      return data.acts.find((a) => a.id === obligation.actId)!.kind !== 'STANDARD';
    })!;
    const copy = (fields: Partial<typeof statute>) => {
      const row = { ...statute, id: seedId(), dueDate: '2024-10-10', ...early, ...fields };
      data.instances.push(row);
      return row;
    };
    // Archived after heldOn, before the review is recorded held: live on heldOn, so it counts, and keeps its id.
    const archivedLater = copy({ archivedAt: '2024-11-02T06:30:00Z' });
    // Made after heldOn with an earlier due date, as a backfill would: not there on heldOn.
    const madeLater = copy({
      createdAt: '2024-11-01T06:30:00Z',
      updatedAt: '2024-11-01T06:30:00Z',
    });
    // Archived by heldOn: gone on heldOn.
    const archivedBefore = copy({ archivedAt: '2024-10-20T06:30:00Z' });
    const review = await plan(fresh.id, { plannedOn: '2024-10-28' });
    await noteAll(review.id);
    await hold(review.id, PERSON.kabir, { heldOn: '2024-10-28' });
    const input = byKey(await inputs(review.id), 'COMPLIANCE_EVALUATION');
    const due = figureOf(input, 'statutoryInstancesDue');
    expect(due.ids).toContain(archivedLater.id);
    expect(due.ids).not.toContain(madeLater.id);
    expect(due.ids).not.toContain(archivedBefore.id);
    expect(due.value).toBe(due.ids.length);
    madeLater.archivedAt = NOW;
    stored(review.id).archivedAt = NOW;
  });

  it('stores no figures for a review held before its system was set up in the app', async () => {
    // The Northwind system was set up on 2024-04-10: the app held none of its records on 2024-03-15 (ISO-1a3).
    const ims = fixtureId('firm-b:iso:system:ims');
    const review = await plan(ims, { plannedOn: '2024-03-15' });
    await noteAll(review.id);
    await hold(review.id, PERSON.kabir, { heldOn: '2024-03-15' });
    for (const input of await inputs(review.id)) {
      expect(input, input.key).toMatchObject({
        sourceFigures: null,
        figuresStoredAt: null,
        figuresWithheld: false,
      });
    }
    const rows = firm().iso.reviewInputs.filter((r) => r.managementReviewId === review.id);
    for (const row of rows) expect(row.figuresEngineVersion ?? null).toBeNull();
    expect(lastEvent(review.id).after).toMatchObject({ action: 'RECORD_HELD', figures: [] });
    // Held on the day the system was set up, a review stores the figures of that one day.
    const sameDay = await plan(ims, { plannedOn: '2024-04-10' });
    await noteAll(sameDay.id);
    await hold(sameDay.id, PERSON.kabir, { heldOn: '2024-04-10' });
    expect(byKey(await inputs(sameDay.id), 'NONCONFORMITIES').sourceFigures).toMatchObject({
      since: '2024-04-10',
      asOf: '2024-04-10',
    });
    for (const id of [review.id, sameDay.id]) stored(id).archivedAt = NOW;
    // The contract refuses a window that runs backwards.
    const backwards = { source: 'CONTEXT', since: '2024-04-10', asOf: '2024-03-15', figures: [] };
    expect(ReviewInputFigures.safeParse(backwards).success).toBe(false);
  });

  it('leaves a cancelled incident out of the review figures, as the overview does', async () => {
    const incident = seedNc(system.id, {
      source: 'INCIDENT',
      standards: ['ISO_45001'],
      reportedOn: '2024-09-05',
      incident: {
        occurredAt: '2024-09-05T04:00:00Z',
        location: 'Cold store',
        type: 'FIRE',
        outcome: 'NONE',
        personCategory: 'EMPLOYEE',
        lostDays: null,
        reportable: false,
        statutoryInstanceId: null,
        investigatorIds: [],
        workerParticipation: true,
      },
    });
    const overview = async () =>
      (
        await ok<{ systems: { incidents: { total: { count: number; ids: string[] } } }[] }>(
          app,
          'getIsoOverview',
          { as: PERSON.kabir, query: { managementSystemId: system.id } },
        )
      ).systems[0]!.incidents.total;
    expect(sorted((await overview()).ids)).toEqual(sorted([ids.incident!, incident.id]));
    expectFigure(await figures('INCIDENTS'), 'incidents', [ids.incident!, incident.id]);
    expectFigure(await figures('INCIDENTS'), 'typeFire', [incident.id]);

    await ok(app, 'cancelIsoNc', {
      as: PERSON.kabir,
      params: { id: incident.id },
      body: { version: 1, reason: 'Logged twice' },
    });
    expect(await overview()).toEqual({ count: 1, ids: [ids.incident] });
    const input = await figures('INCIDENTS');
    expectFigure(input, 'incidents', [ids.incident!]);
    expectFigure(input, 'typeFire', []);
    expect(figureOf(input, 'outcomeNone')).toEqual({ key: 'outcomeNone', value: 0, ids: [] });
  });

  it("gives a one-standard review only that standard's audits, an internal audit's by its clauses", async () => {
    const programme = seedProgramme(system.id);
    const environment = seedAudit(programme.id, {
      ...reported('2024-10-01'),
      clauseIds: [clause('ISO_14001', '8.1')],
    });
    const quality = seedAudit(programme.id, {
      ...reported('2024-10-01'),
      clauseIds: [clause('ISO_9001', '8.1')],
    });
    const environmentFinding = seedFinding({
      internalAuditId: environment.id,
      type: 'GOOD_PRACTICE',
    });
    const qualityFinding = seedFinding({ internalAuditId: quality.id, type: 'GOOD_PRACTICE' });
    const review = await plan(system.id, { standards: ['ISO_14001'] });
    const input = await figures('AUDIT_RESULTS', PERSON.kabir, review.id);
    // An audit that lists no clauses covers its system's standards, as for the nonconformities its findings raise.
    expectFigure(input, 'internalAuditsReported', [ids.auditReported!, environment.id]);
    expectFigure(input, 'findingsGoodPractice', [environmentFinding.id]);
    expectFigure(input, 'externalAuditsHeld', []);
    expectFigure(input, 'findingsOfi', []);
    // The integrated review counts both.
    const all = await figures('AUDIT_RESULTS');
    expectFigure(all, 'internalAuditsReported', [ids.auditReported!, environment.id, quality.id]);
    expectFigure(all, 'findingsGoodPractice', [environmentFinding.id, qualityFinding.id]);
    for (const row of [programme, environment, quality, environmentFinding, qualityFinding]) {
      row.archivedAt = NOW;
    }
  });

  it('counts a reading recorded in the window whose period has not ended by as-of', async () => {
    const objective = seedObjective(system.id, { standards: ['ISO_14001'] });
    const running = seed(app, 'readings', {
      ...base(),
      objectiveId: objective.id,
      periodStart: '2024-11-01',
      periodEnd: '2024-11-30',
      value: 40,
      note: null,
      recordedById: PERSON.rohan,
    });
    const input = await figures('OBJECTIVES');
    expectFigure(input, 'readingsRecorded', [ids.reading1!, ids.reading2!, running.id]);
    // On track reads only the periods ended by as-of: the objective has none yet.
    expectFigure(input, 'withoutReading', [ids.noReading!, objective.id]);
    for (const row of [objective, running]) row.archivedAt = NOW;
  });

  /** An incident of `occurredAt`, as the incident fields of a nonconformity. */
  const incidentOf = (occurredAt: string) => ({
    occurredAt,
    location: 'Loading dock',
    type: 'INJURY' as const,
    outcome: 'FIRST_AID' as const,
    personCategory: 'EMPLOYEE' as const,
    lostDays: null,
    reportable: false,
    statutoryInstanceId: null,
    investigatorIds: [],
    workerParticipation: true,
  });

  it('places a record by the step that set its backdated date, so the next review counts it (ISO-1a3)', async () => {
    // Model §5.4: a date the user enters places its record by the later of that date and its step's day. Each record
    // below is settled or entered after the 2024-10-01 review was recorded, dated before that review: the next counts it.
    const fresh = freshSystem();
    const dated = (created: string, updated = created) => ({
      createdAt: `${created}T06:30:00Z`,
      updatedAt: `${updated}T06:30:00Z`,
    });
    const first = seedReview(fresh.id, { ...dated('2024-06-30'), state: 'HELD' });
    const onFirst = { type: 'MANAGEMENT_REVIEW' as const, id: first.id };
    const doneBefore = seedAction(onFirst, {
      ...dated('2024-07-01', '2024-09-15'),
      state: 'DONE',
      doneOn: '2024-09-15',
    });
    const cancelledBefore = seedAction(onFirst, {
      ...dated('2024-07-01', '2024-09-10'),
      state: 'CANCELLED',
      cancelReason: 'Overtaken',
    });
    const doneLater = seedAction(onFirst, { ...dated('2024-07-01'), dueOn: '2024-09-30' });
    const visited = seedExternal(fresh.id, {
      ...dated('2024-09-01', '2024-09-10'),
      state: 'HELD',
      startOn: '2024-09-08',
      endOn: '2024-09-10',
    });
    const heldLater = seedExternal(fresh.id, {
      ...dated('2024-09-01'),
      startOn: '2024-09-18',
      endOn: '2024-09-20',
    });
    seedFile({ type: 'external_audit', id: heldLater.id });
    // Placed by its RECORD_HELD step's own day, not by the row's last change (its response, recorded today).
    const responded = seedExternal(fresh.id, {
      ...dated('2024-09-01'),
      updatedAt: NOW,
      state: 'RESPONDED',
      startOn: '2024-09-11',
      endOn: '2024-09-12',
    });
    seedEvent({
      at: '2024-09-12T06:30:00Z',
      action: 'TRANSITION',
      entityType: 'external_audit',
      entityId: responded.id,
      before: { state: 'PLANNED' },
      after: { action: 'RECORD_HELD', state: 'HELD', startOn: '2024-09-11', endOn: '2024-09-12' },
    });
    const achieved = seedObjective(fresh.id, dated('2024-07-01'));
    const notAchieved = seedObjective(fresh.id, dated('2024-07-01'));
    const programme = seedProgramme(fresh.id);
    const reportedLater = seedAudit(programme.id, {
      ...dated('2024-09-01'),
      plannedStart: '2024-09-16',
      plannedEnd: '2024-09-17',
      state: 'IN_PROGRESS',
    });

    const second = await plan(fresh.id, { plannedOn: '2024-10-01' });
    await noteAll(second.id);
    await hold(second.id, PERSON.kabir, { heldOn: '2024-10-01' });
    const recorded = await inputs(second.id);
    const actionsThen = byKey(recorded, 'PREVIOUS_ACTIONS');
    expectFigure(actionsThen, 'actionsDone', [doneBefore.id]);
    expectFigure(actionsThen, 'actionsCancelled', [cancelledBefore.id]);
    expectFigure(actionsThen, 'actionsOverdue', [doneLater.id]);
    expectFigure(byKey(recorded, 'AUDIT_RESULTS'), 'externalAuditsHeld', [
      visited.id,
      responded.id,
    ]);
    expectFigure(byKey(recorded, 'AUDIT_RESULTS'), 'internalAuditsReported', []);
    expectFigure(byKey(recorded, 'OBJECTIVES'), 'objectivesOpen', [achieved.id, notAchieved.id]);
    expectFigure(byKey(recorded, 'CONTEXT_CHANGES'), 'climateDecided', []);
    expectFigure(byKey(recorded, 'INCIDENTS'), 'incidents', []);

    // Today, 2024-11-15: each step below dates its record before 2024-10-01.
    await ok(app, 'completeIsoAction', {
      as: PERSON.kabir,
      params: { id: doneLater.id },
      body: { version: 1, doneOn: '2024-09-20' },
    });
    await ok(app, 'recordIsoExternalAuditHeld', {
      as: PERSON.kabir,
      params: { id: heldLater.id },
      body: { version: 1, startOn: '2024-09-18', endOn: '2024-09-20' },
    });
    await ok(app, 'reportIsoInternalAudit', {
      as: PERSON.kabir,
      params: { id: reportedLater.id },
      body: {
        version: 1,
        summary: 'No findings',
        reportedOn: '2024-09-20',
        reportedToIds: [PERSON.kabir],
      },
    });
    for (const [objective, outcome] of [
      [achieved, 'ACHIEVED'],
      [notAchieved, 'NOT_ACHIEVED'],
    ] as const) {
      await ok(app, 'closeIsoObjective', {
        as: PERSON.kabir,
        params: { id: objective.id },
        body: { version: 1, closedOn: '2024-09-28', outcome },
      });
    }
    await ok(app, 'setIsoClimateDecision', {
      as: PERSON.kabir,
      params: { id: fresh.id },
      body: {
        version: fresh.version,
        climateChangeRelevant: true,
        climateChangeRationale: 'Floods close the road to the site',
        climateDecidedOn: '2024-09-25',
      },
    });
    // Entered today: a finding of an audit the 2024-10-01 review counted, and an incident of 2024-09-25.
    const lateFinding = seedFinding({ externalAuditId: visited.id, type: 'MINOR_NC' });
    const incident = seedNc(fresh.id, {
      source: 'INCIDENT',
      standards: ['ISO_45001'],
      reportedOn: '2024-09-25',
      incident: incidentOf('2024-09-25T04:00:00Z'),
    });

    const next = await plan(fresh.id);
    const all = await inputs(next.id);
    expect(byKey(all, 'NONCONFORMITIES').sourceFigures).toMatchObject({
      since: '2024-10-01',
      asOf: TODAY,
    });
    const actions = byKey(all, 'PREVIOUS_ACTIONS');
    expectFigure(actions, 'actionsDone', [doneLater.id]);
    // Settled before since: counted by the review before, not again.
    expectFigure(actions, 'actionsCancelled', []);
    expectFigure(actions, 'actionsOpen', []);
    expectFigure(actions, 'actionsOverdue', []);
    const audits = byKey(all, 'AUDIT_RESULTS');
    expectFigure(audits, 'externalAuditsHeld', [heldLater.id]);
    expectFigure(audits, 'internalAuditsReported', [reportedLater.id]);
    expectFigure(audits, 'findingsMinorNc', [lateFinding.id]);
    const objectives = byKey(all, 'OBJECTIVES');
    expectFigure(objectives, 'objectivesOpen', []);
    expectFigure(objectives, 'achieved', [achieved.id]);
    expectFigure(objectives, 'notAchieved', [notAchieved.id]);
    const context = byKey(all, 'CONTEXT_CHANGES');
    expectFigure(context, 'climateDecided', [fresh.id]);
    expectFigure(context, 'climateDecidedInPeriod', [fresh.id]);
    expectFigure(byKey(all, 'INCIDENTS'), 'incidents', [incident.id]);
    // Raised by its counting day, the later of its creation day and its backdated reportedOn.
    expectFigure(byKey(all, 'NONCONFORMITIES'), 'raisedIncident', [incident.id]);
    // The figures the 2024-10-01 review stored stay as they were.
    expect(await inputs(second.id)).toEqual(recorded);
  });

  it('places an action completed, reopened and completed again by its later COMPLETE step (ISO-1a3)', async () => {
    const fresh = freshSystem();
    const first = seedReview(fresh.id, {
      createdAt: '2024-06-30T06:30:00Z',
      updatedAt: '2024-06-30T06:30:00Z',
      state: 'HELD',
    });
    const action = seedAction(
      { type: 'MANAGEMENT_REVIEW', id: first.id },
      { createdAt: '2024-07-01T06:30:00Z', updatedAt: '2024-09-20T06:30:00Z', dueOn: '2024-09-30' },
    );
    const step = (day: string, before: Record<string, unknown>, after: Record<string, unknown>) =>
      seedEvent({
        at: `${day}T06:30:00Z`,
        action: 'TRANSITION',
        entityType: 'iso_action',
        entityId: action.id,
        before,
        after,
      });
    step(
      '2024-09-15',
      { state: 'OPEN' },
      { action: 'COMPLETE', state: 'DONE', doneOn: '2024-09-15' },
    );
    step(
      '2024-09-20',
      { state: 'DONE', doneOn: '2024-09-15' },
      { action: 'REOPEN', state: 'OPEN', doneOn: null },
    );
    // Completed again today, dated 2024-09-28: its settled day is today's step, not the first COMPLETE.
    await ok(app, 'completeIsoAction', {
      as: PERSON.kabir,
      params: { id: action.id },
      body: { version: action.version, doneOn: '2024-09-28' },
    });
    const held = await plan(fresh.id, { plannedOn: '2024-10-01' });
    await noteAll(held.id);
    await hold(held.id, PERSON.kabir, { heldOn: '2024-10-01' });
    const then = byKey(await inputs(held.id), 'PREVIOUS_ACTIONS');
    expectFigure(then, 'actionsDone', []);
    expectFigure(then, 'actionsOpen', [action.id]);
    expectFigure(then, 'actionsOverdue', [action.id]);
    const next = byKey(await inputs((await plan(fresh.id)).id), 'PREVIOUS_ACTIONS');
    expectFigure(next, 'actionsDone', [action.id]);
    expectFigure(next, 'actionsOpen', []);
  });

  it('counts a system decided on climate from its first decision, though the decision changed after as-of (ISO-1a3)', async () => {
    const fresh = freshSystem();
    const decided = {
      climateChangeRelevant: true,
      climateChangeRationale: 'Floods close the road to the site',
      climateDecidedOn: '2024-08-01',
    };
    Object.assign(fresh, decided, { updatedAt: '2024-08-01T06:30:00Z' });
    seedEvent({
      at: '2024-08-01T06:30:00Z',
      action: 'UPDATE',
      entityType: 'management_system',
      entityId: fresh.id,
      before: { climateChangeRelevant: null, climateChangeRationale: null, climateDecidedOn: null },
      after: decided,
    });
    // Decided again today: no longer relevant.
    await ok(app, 'setIsoClimateDecision', {
      as: PERSON.kabir,
      params: { id: fresh.id },
      body: {
        version: fresh.version,
        climateChangeRelevant: false,
        climateChangeRationale: 'The new road stays open in floods',
        climateDecidedOn: TODAY,
      },
    });
    // A review held on 2024-10-01, recorded after today's decision: decided from 2024-08-01, in its period, and
    // relevant as the decision is now.
    const held = await plan(fresh.id, { plannedOn: '2024-10-01' });
    await noteAll(held.id);
    await hold(held.id, PERSON.kabir, { heldOn: '2024-10-01' });
    const then = byKey(await inputs(held.id), 'CONTEXT_CHANGES');
    expectFigure(then, 'climateDecided', [fresh.id]);
    expectFigure(then, 'climateDecidedInPeriod', [fresh.id]);
    expectFigure(then, 'climateRelevant', []);
    // The next review counts today's decision in its period.
    const next = byKey(await inputs((await plan(fresh.id)).id), 'CONTEXT_CHANGES');
    expect(next.sourceFigures!.since).toBe('2024-10-01');
    expectFigure(next, 'climateDecided', [fresh.id]);
    expectFigure(next, 'climateDecidedInPeriod', [fresh.id]);
  });

  it('counts no climate decision in a period with none', async () => {
    const fresh = freshSystem();
    Object.assign(fresh, {
      climateChangeRelevant: true,
      climateChangeRationale: 'Floods close the road to the site',
      climateDecidedOn: '2024-08-01',
      updatedAt: '2024-08-01T06:30:00Z',
    });
    seedReview(fresh.id, {
      plannedOn: '2024-09-30',
      heldOn: '2024-09-30',
      createdAt: '2024-09-30T06:30:00Z',
      updatedAt: '2024-09-30T06:30:00Z',
      state: 'HELD',
    });
    // No trail: its updatedAt stands in for its one decision, 2024-08-01, before the 2024-09-30 review.
    const context = byKey(await inputs((await plan(fresh.id)).id), 'CONTEXT_CHANGES');
    expect(context.sourceFigures!.since).toBe('2024-09-30');
    expectFigure(context, 'climateDecided', [fresh.id]);
    expectFigure(context, 'climateRelevant', [fresh.id]);
    expectFigure(context, 'climateDecidedInPeriod', []);
  });

  it('counts the overdue corrective actions only of nonconformities open on as-of', async () => {
    const fresh = freshSystem();
    const closed = seedNc(fresh.id, { ...early, ...closedNc('2024-10-20') });
    const open = seedNc(fresh.id, early);
    const due = { ...early, dueOn: '2024-10-05' };
    const onClosed = seedAction({ type: 'NONCONFORMITY', id: closed.id }, due);
    const onOpen = seedAction({ type: 'NONCONFORMITY', id: open.id }, due);
    const review = await plan(fresh.id);
    const ncs = byKey(await inputs(review.id), 'NONCONFORMITIES');
    expectFigure(ncs, 'open', [open.id]);
    expectFigure(ncs, 'correctiveActionsOverdue', [onOpen.id]);
    // Held before the nonconformity closed, a review counts both.
    const before = await plan(fresh.id, { plannedOn: '2024-10-15' });
    await noteAll(before.id);
    await hold(before.id, PERSON.kabir, { heldOn: '2024-10-15' });
    const then = byKey(await inputs(before.id), 'NONCONFORMITIES');
    expectFigure(then, 'open', [closed.id, open.id]);
    expectFigure(then, 'correctiveActionsOverdue', [onClosed.id, onOpen.id]);
  });

  it('counts in a RISKS input only the kinds its key reads, and audit findings by their clauses’ standards', async () => {
    const fresh = freshSystem();
    const risk = seedRisk(fresh.id, early);
    const opportunity = seedRisk(fresh.id, { ...early, kind: 'OPPORTUNITY' });
    const aspect = seedRisk(fresh.id, {
      ...early,
      kind: 'ASPECT',
      impact: 'Air pollution',
      lifeCycleStages: ['PRODUCTION'],
      controlType: 'CONTROL',
      condition: 'NORMAL',
    });
    const hazard = seedRisk(fresh.id, {
      ...early,
      kind: 'HAZARD',
      impact: 'Burns',
      routine: true,
      personsExposed: ['WORKER'],
      condition: 'NORMAL',
    });
    const programme = seedProgramme(fresh.id);
    const audit = seedAudit(programme.id, { ...early, ...reported('2024-10-01') });
    const finding = (clauseIds: string[]) =>
      seedFinding({ ...early, internalAuditId: audit.id, type: 'OFI', clauseIds });
    const quality = finding([clause('ISO_9001', '8.1')]);
    const environment = finding([clause('ISO_14001', '8.1')]);
    const both = finding([clause('ISO_9001', '8.1'), clause('ISO_14001', '8.1')]);
    const none = finding([]);
    const of = async (standards: string[], key: string) =>
      byKey(await inputs((await plan(fresh.id, { standards })).id), key);
    // Items added, and the significant<Kind> keys emitted: one for each kind the key reads, none for another kind.
    const added = async (
      standards: string[],
      key: string,
      expected: string[],
      significant: Record<string, string[]>,
    ) => {
      const input = await of(standards, key);
      expectFigure(input, 'itemsAdded', expected);
      const keys = input.sourceFigures!.figures.map((f) => f.key);
      expect(sorted(keys.filter((k) => k.startsWith('significant'))), key).toEqual(
        sorted(Object.keys(significant)),
      );
      for (const [k, expectedIds] of Object.entries(significant))
        expectFigure(input, k, expectedIds);
      return input;
    };
    const riskAndOpportunity = {
      significantRisk: [risk.id],
      significantOpportunity: [opportunity.id],
    };

    // A 9001-only review: RISK_ACTIONS reads risks and opportunities, and its audits no 14001-only finding.
    await added(['ISO_9001'], 'RISK_ACTIONS', [risk.id, opportunity.id], riskAndOpportunity);
    expectFigure(await of(['ISO_9001'], 'AUDIT_RESULTS'), 'findingsOfi', [
      quality.id,
      both.id,
      none.id,
    ]);
    // A 14001 review: SIGNIFICANT_ASPECTS reads aspects only and RISKS_AND_OPPORTUNITIES no aspect, so neither counts
    // an item the other does, nor has a key for the other's kinds.
    await added(['ISO_14001'], 'SIGNIFICANT_ASPECTS', [aspect.id], {
      significantAspect: [aspect.id],
    });
    await added(
      ['ISO_14001'],
      'RISKS_AND_OPPORTUNITIES',
      [risk.id, opportunity.id],
      riskAndOpportunity,
    );
    expectFigure(await of(['ISO_14001'], 'AUDIT_RESULTS'), 'findingsOfi', [
      environment.id,
      both.id,
      none.id,
    ]);
    // With 45001 among the input's standards, RISKS_AND_OPPORTUNITIES reads hazards too; RISK_ACTIONS never does.
    const withHazards = { ...riskAndOpportunity, significantHazard: [hazard.id] };
    for (const standards of [[...ALL], ['ISO_45001']]) {
      await added(
        standards,
        'RISKS_AND_OPPORTUNITIES',
        [risk.id, opportunity.id, hazard.id],
        withHazards,
      );
    }
    await added([...ALL], 'RISK_ACTIONS', [risk.id, opportunity.id], riskAndOpportunity);
  });

  it('withholds the incident figures and notes from a reader not at the review who may not read every incident counted', async () => {
    // Model §3.13 item 4: it reads the incidents the row counts, not the system's units.
    const fresh = freshSystem();
    const incident = {
      ...early,
      source: 'INCIDENT' as const,
      standards: ['ISO_45001' as const],
      reportedOn: '2024-09-01',
      incident: incidentOf('2024-09-01T04:00:00Z'),
    };
    const atBengaluru = seedNc(fresh.id, {
      ...incident,
      unitId: BENGALURU,
      ownerId: ISHAAN,
      approverId: PERSON.divya,
    });
    const review = await plan(fresh.id, { chairId: PERSON.nisha, attendeeIds: [FARHAN] });
    await noteAll(review.id);
    const incidentsFor = async (as: string) => byKey(await inputs(review.id, as), 'INCIDENTS');
    const withheld = {
      sourceFigures: null,
      figuresStoredAt: null,
      figuresWithheld: true,
      notes: null,
    };
    const shown = { figuresWithheld: false, notes: 'Discussed INCIDENTS' };
    // An owner of Pune, not on the review: withheld, figures and notes. Only the INCIDENTS row: the nonconformities
    // still show, with the ids they may read.
    expect(await incidentsFor(PERSON.rohan)).toMatchObject(withheld);
    const ncs = byKey(await inputs(review.id, PERSON.rohan), 'NONCONFORMITIES');
    expect(ncs).toMatchObject({ figuresWithheld: false, notes: 'Discussed NONCONFORMITIES' });
    expect(figureOf(ncs, 'raisedIncident')).toEqual({ key: 'raisedIncident', value: 1, ids: [] });
    // The owner of Bengaluru, not on the review either, may read every incident counted.
    expect(await incidentsFor(ISHAAN)).toMatchObject(shown);
    expectFigure(await incidentsFor(ISHAAN), 'incidents', [atBengaluru.id]);
    // The chair and an attendee from Pune see them, the Bengaluru id cut; a client admin sees them whole.
    for (const as of [PERSON.nisha, FARHAN]) {
      const input = await incidentsFor(as);
      expect(input, as).toMatchObject(shown);
      expect(figureOf(input, 'incidents'), as).toEqual({ key: 'incidents', value: 1, ids: [] });
    }
    expectFigure(await incidentsFor(PERSON.kabir), 'incidents', [atBengaluru.id]);
    // Narrowed to Pune after the incident was counted, the system still has it counted: still withheld.
    fresh.unitIds = [PUNE];
    expect(await incidentsFor(PERSON.rohan)).toMatchObject(withheld);
    // Held, the stored copy is withheld the same way.
    await hold(review.id);
    expect(await incidentsFor(PERSON.rohan)).toMatchObject(withheld);
    expect(await incidentsFor(PERSON.nisha)).toMatchObject({ ...shown, figuresStoredAt: NOW });
    // The contract allows a withheld row only on INCIDENTS, and then without figures or notes.
    expect(ReviewInputView.safeParse(await incidentsFor(PERSON.rohan)).success).toBe(true);
    const whole = await incidentsFor(PERSON.kabir);
    expect(ReviewInputView.safeParse({ ...whole, figuresWithheld: true }).success).toBe(false);
    const notesKept = { ...whole, ...withheld, notes: whole.notes };
    expect(ReviewInputView.safeParse(notesKept).success).toBe(false);
    expect(ReviewInputView.safeParse({ ...ncs, ...withheld }).success).toBe(false);
    // Every incident counted at Pune, an owner of Pune sees them.
    const pune = freshSystem();
    const atPune = seedNc(pune.id, incident);
    const own = await plan(pune.id, { chairId: PERSON.kabir, attendeeIds: [] });
    const seen = byKey(await inputs(own.id, PERSON.rohan), 'INCIDENTS');
    expect(seen.figuresWithheld).toBe(false);
    expectFigure(seen, 'incidents', [atPune.id]);
  });

  it('emits only the keys REVIEW_FIGURE_KEYS lists, each counting its ids where it says so', async () => {
    const significant = {
      RISK: 'significantRisk',
      OPPORTUNITY: 'significantOpportunity',
      ASPECT: 'significantAspect',
      HAZARD: 'significantHazard',
    } as const;
    const environmental = await plan(system.id, { standards: ['ISO_14001'] });
    for (const review of [current, environmental]) {
      for (const input of await inputs(review.id)) {
        if (input.sourceFigures === null) continue;
        const keys: Record<string, { countsIds: boolean }> =
          REVIEW_FIGURE_KEYS[input.sourceFigures.source as keyof typeof REVIEW_FIGURE_KEYS];
        const emitted = input.sourceFigures.figures.map((f) => f.key);
        const kinds = new Set<string>(
          reviewRiskKinds(
            ReviewInputKey.parse(input.key),
            review.standards as IsoStandardCode[],
          ).map((kind) => significant[kind]),
        );
        const ofKind = (k: string) => !(Object.values(significant) as string[]).includes(k);
        // Every key it lists, the score aside when nothing is due, and a significant<Kind> key only for a kind read.
        expect(sorted(emitted), input.key).toEqual(
          sorted(
            Object.keys(keys).filter(
              (k) => (k !== 'statutoryScore' || emitted.includes(k)) && (ofKind(k) || kinds.has(k)),
            ),
          ),
        );
        for (const fig of input.sourceFigures.figures) {
          if (keys[fig.key]!.countsIds) expect(fig.value, fig.key).toBe(fig.ids.length);
        }
      }
    }
    stored(environmental.id).archivedAt = NOW;
  });
});

describe('review figure keys and risk kinds', () => {
  it('names the table of every figure key, and which values are not a count of ids', () => {
    const notCounts: string[] = [];
    const noTable: string[] = [];
    for (const keys of Object.values(REVIEW_FIGURE_KEYS)) {
      for (const [key, info] of Object.entries(keys)) {
        if (!info.countsIds) notCounts.push(key);
        if (info.entityType === null) noTable.push(key);
      }
    }
    expect(sorted(notCounts)).toEqual(['lostDays', 'statutoryScore', 'verifiedNotEffective']);
    expect(noTable).toEqual(['statutoryScore']);
    expect(Object.keys(REVIEW_FIGURE_KEYS)).not.toContain('MANUAL');
    expect(REVIEW_FIGURE_KEYS.NONCONFORMITIES.correctiveActionsOverdue.entityType).toBe(
      'iso_action',
    );
    expect(REVIEW_FIGURE_KEYS.COMPLIANCE_EVALUATION.statutoryInstancesDue.entityType).toBe(
      'instance',
    );
  });

  it('reads aspects for SIGNIFICANT_ASPECTS, risks and opportunities for the others, and hazards for RISKS_AND_OPPORTUNITIES with 45001', () => {
    expect(reviewRiskKinds('SIGNIFICANT_ASPECTS', [...ALL])).toEqual(['ASPECT']);
    expect(reviewRiskKinds('RISKS_AND_OPPORTUNITIES', ['ISO_14001'])).toEqual([
      'RISK',
      'OPPORTUNITY',
    ]);
    expect(reviewRiskKinds('RISKS_AND_OPPORTUNITIES', ['ISO_14001', 'ISO_45001'])).toEqual([
      'RISK',
      'OPPORTUNITY',
      'HAZARD',
    ]);
    // RISK_ACTIONS (9001 6.1.2) reads risks and opportunities only, whatever the input's standards.
    expect(reviewRiskKinds('RISK_ACTIONS', ['ISO_9001'])).toEqual(['RISK', 'OPPORTUNITY']);
    expect(reviewRiskKinds('RISK_ACTIONS', [...ALL])).toEqual(['RISK', 'OPPORTUNITY']);
    expect(reviewRiskKinds('NONCONFORMITIES', [...ALL])).toEqual([]);
  });
});

describe('ISO files', () => {
  let system: IsoRow<'managementSystems'>;
  let review: ReviewView;
  const s: Record<string, Ref> = {};
  const rows: Record<string, { id: string }> = {};

  beforeAll(async () => {
    system = seedSystem(app);
    review = await plan(system.id, { attendeeIds: [PERSON.nisha] });
    const row = firm().iso.clauseAssessments.find((r) => r.managementSystemId === system.id)!;
    row.ownerId = PERSON.rohan;
    s.clause = { type: 'clause_assessment', id: row.id };
    const doc = seedDocument(system.id);
    s.revision = { type: 'document_revision', id: seedRevision(doc.id).id };
    s.risk = {
      type: 'risk_item',
      id: seedRisk(system.id, { unitId: BENGALURU, ownerId: ISHAAN }).id,
    };
    const objective = seedObjective(system.id);
    s.reading = { type: 'objective_reading', id: seedReading(objective.id, 50).id };
    const programme = seedProgramme(system.id);
    const audit = seedAudit(programme.id, {
      unitIds: [BENGALURU],
      auditorIds: [PERSON.rohan],
      auditeeIds: [PERSON.sameer],
    });
    s.audit = { type: 'internal_audit', id: audit.id };
    s.internalFinding = {
      type: 'audit_finding',
      id: seedFinding({ internalAuditId: audit.id }).id,
    };
    const external = seedExternal(system.id);
    s.external = { type: 'external_audit', id: external.id };
    s.externalFinding = {
      type: 'audit_finding',
      id: seedFinding({ externalAuditId: external.id }).id,
    };
    s.certification = { type: 'certification', id: seedCertification(system.id, [PUNE]).id };
    const nc = seedNc(system.id);
    rows.nc = nc;
    s.nc = { type: 'nonconformity', id: nc.id };
    s.ncAction = {
      type: 'iso_action',
      id: seedAction({ type: 'NONCONFORMITY', id: nc.id }).id,
    };
    s.reviewAction = {
      type: 'iso_action',
      id: seedAction({ type: 'MANAGEMENT_REVIEW', id: review.id }, { ownerId: ISHAAN }).id,
    };
    s.objectiveAction = {
      type: 'iso_action',
      id: seedAction({ type: 'OBJECTIVE', id: objective.id }).id,
    };
    s.findingAction = {
      type: 'iso_action',
      id: seedAction({ type: 'AUDIT_FINDING', id: s.internalFinding.id }).id,
    };
    s.externalFindingAction = {
      type: 'iso_action',
      id: seedAction({ type: 'AUDIT_FINDING', id: s.externalFinding.id }).id,
    };
    s.review = { type: 'management_review', id: review.id };
    const chairedByApprover = await plan(system.id, { chairId: PERSON.divya, attendeeIds: [] });
    s.reviewByApprover = { type: 'management_review', id: chairedByApprover.id };
  });

  it('uploads, confirms, scans and downloads a file, auditing the add and the download', async () => {
    const before = isoEvents(app, review.id).length;
    const t = await ticket(s.review!, PERSON.sameer);
    expect(t.url).toMatch(/^https:\/\/files\.mock\.invalid\/uploads\//);
    expect(t.headers).toEqual({ 'content-type': 'application/pdf' });
    expect(t.expiresAt).toBe('2024-11-15T06:35:00Z');
    expect(isoEvents(app, review.id)).toHaveLength(before);
    const file = await ok<FileView>(app, 'confirmIsoFile', {
      as: PERSON.sameer,
      body: { subject: s.review, uploadId: t.uploadId, fileName: 'minutes-draft.pdf', sha256: SHA },
    });
    expect(file).toMatchObject({
      scanStatus: 'PENDING',
      fileName: 'minutes-draft.pdf',
      subject: s.review,
      archivedAt: null,
      removeReason: null,
    });
    expect(file).not.toHaveProperty('storageKey');
    const row = firm().iso.files.find((f) => f.id === file.id)!;
    expect(row.managementReviewId).toBe(review.id);
    expect(row.nonconformityId).toBeNull();
    expect(row.storageKey).toBe(
      `evidence/${FIRM_B}/${NORTHWIND}/iso/management_review/${review.id}/${t.uploadId}`,
    );
    const added = lastEvent(review.id);
    expect(added).toMatchObject({
      action: 'EVIDENCE_ADD',
      entityType: 'management_review',
      actorId: PERSON.sameer,
      after: { fileId: file.id },
    });
    expect(JSON.stringify(added)).not.toContain('minutes-draft');
    // The next read finishes the scan; reading writes no event.
    const count = isoEvents(app, review.id).length;
    const listed = await listFiles(s.review!, PERSON.vikram);
    expect(listed.find((f) => f.id === file.id)).toMatchObject({ scanStatus: 'CLEAN' });
    expect(isoEvents(app, review.id)).toHaveLength(count);
    const signed = await download(file.id, PERSON.vikram);
    expect(signed.url).toBe(`https://files.mock.invalid/iso/${file.id}`);
    expect(signed.expiresAt).toBe('2024-11-15T06:35:00Z');
    expect(lastEvent(review.id)).toMatchObject({
      action: 'EVIDENCE_DOWNLOAD',
      entityType: 'management_review',
      actorId: PERSON.vikram,
      after: { fileId: file.id },
    });
    // A ticket is used once.
    await fails(
      app,
      'confirmIsoFile',
      {
        as: PERSON.sameer,
        body: { subject: s.review, uploadId: t.uploadId, fileName: 'again.pdf', sha256: SHA },
      },
      'VALIDATION',
      400,
    );
  });

  it('downloads only clean files', async () => {
    const infected = await upload(s.review!, PERSON.kabir, NORTHWIND, 'eicar-test.pdf');
    await listFiles(s.review!, PERSON.kabir);
    const refused = await fails(
      app,
      'isoFileDownloadUrl',
      { params: { id: infected.id } },
      'EVIDENCE_NOT_READY',
      422,
    );
    expect(refused.error.details).toEqual({ scanStatus: 'INFECTED' });
    const pending = seedFile(s.review!, { scanStatus: 'PENDING' });
    const stillPending = await fails(
      app,
      'isoFileDownloadUrl',
      { params: { id: pending.id } },
      'EVIDENCE_NOT_READY',
      422,
    );
    expect(stillPending.error.details).toEqual({ scanStatus: 'PENDING' });
  });

  it("confirms only the actor's own ticket for the same subject", async () => {
    const body = (uploadId: string, subject: Ref = s.review!) => ({
      subject,
      uploadId,
      fileName: 'record.pdf',
      sha256: SHA,
    });
    await fails(app, 'confirmIsoFile', { body: body(seedId()) }, 'VALIDATION', 400);
    const kabirs = await ticket(s.review!, PERSON.kabir);
    await fails(
      app,
      'confirmIsoFile',
      { as: PERSON.meera, body: body(kabirs.uploadId) },
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'confirmIsoFile',
      { as: PERSON.kabir, body: body(kabirs.uploadId, s.nc) },
      'VALIDATION',
      400,
    );
    await ok(app, 'confirmIsoFile', { as: PERSON.kabir, body: body(kabirs.uploadId) });
  });

  it('removes a file with a reason, keeping it for the record', async () => {
    const file = await upload(s.review!, PERSON.sameer);
    await fails(
      app,
      'removeIsoFile',
      { as: PERSON.nisha, params: { id: file.id }, body: { reason: 'x' } },
      'FORBIDDEN',
      403,
    );
    await fails(
      app,
      'removeIsoFile',
      { params: { id: file.id }, body: {} },
      'REASON_REQUIRED',
      422,
    );
    const removed = await remove(file.id, PERSON.sameer, 'Uploaded the wrong minutes');
    expect(removed).toMatchObject({
      removeReason: 'Uploaded the wrong minutes',
      archivedAt: NOW,
      subject: s.review,
    });
    expect(lastEvent(review.id)).toMatchObject({
      action: 'EVIDENCE_REMOVE',
      entityType: 'management_review',
      after: { fileId: file.id },
      reason: 'Uploaded the wrong minutes',
    });
    expect((await listFiles(s.review!, PERSON.kabir)).map((f) => f.id)).not.toContain(file.id);
    expect(
      (await listFiles(s.review!, PERSON.kabir, NORTHWIND, true)).find((f) => f.id === file.id),
    ).toMatchObject({ removeReason: 'Uploaded the wrong minutes' });
    await fails(app, 'isoFileDownloadUrl', { params: { id: file.id } }, 'NOT_FOUND', 404);
    await fails(
      app,
      'removeIsoFile',
      { params: { id: file.id }, body: { reason: 'again' } },
      'NOT_FOUND',
      404,
    );
  });

  // Who may write each subject (plan §3.2): allowed people upload; others are refused upload, confirm and remove.
  const writeCases: {
    name: string;
    ref: () => Ref;
    allowed: string[];
    refused: [string, number][];
  }[] = [
    {
      name: 'a checklist row: managers and the row owner',
      ref: () => s.clause!,
      allowed: [PERSON.meera, PERSON.arjun, PERSON.kabir, PERSON.rohan],
      refused: [
        [PERSON.sameer, 403],
        [PERSON.divya, 403],
        [PERSON.vikram, 403],
      ],
    },
    {
      name: 'a revision: managers and the document owner, not its approver',
      ref: () => s.revision!,
      allowed: [PERSON.kabir, PERSON.sameer],
      refused: [
        [PERSON.divya, 403],
        [PERSON.rohan, 403],
      ],
    },
    {
      name: 'a risk item: managers and its owner; other units do not see it',
      ref: () => s.risk!,
      allowed: [PERSON.kabir, ISHAAN],
      refused: [
        [PERSON.sameer, 403],
        [PERSON.rohan, 404],
      ],
    },
    {
      name: "an objective's reading: managers and the objective owner",
      ref: () => s.reading!,
      allowed: [PERSON.arjun, PERSON.rohan],
      refused: [[PERSON.sameer, 403]],
    },
    {
      name: 'an internal audit: managers, its lead and auditors, not its auditees',
      ref: () => s.audit!,
      allowed: [PERSON.nisha, PERSON.rohan, PERSON.kabir],
      refused: [
        [PERSON.sameer, 403],
        [PERSON.divya, 403],
        [ISHAAN, 403],
      ],
    },
    {
      name: "an internal audit's finding: as its audit",
      ref: () => s.internalFinding!,
      allowed: [PERSON.nisha, PERSON.meera],
      refused: [[PERSON.sameer, 403]],
    },
    {
      name: 'an external audit: managers only',
      ref: () => s.external!,
      allowed: [PERSON.meera, PERSON.kabir],
      refused: [
        [PERSON.sameer, 403],
        [PERSON.divya, 403],
      ],
    },
    {
      name: "an external audit's finding: managers only",
      ref: () => s.externalFinding!,
      allowed: [PERSON.arjun],
      refused: [[PERSON.divya, 403]],
    },
    {
      name: 'a certificate: managers only; other units do not see it',
      ref: () => s.certification!,
      allowed: [PERSON.kabir],
      refused: [
        [PERSON.rohan, 403],
        [ISHAAN, 404],
      ],
    },
    {
      name: 'a nonconformity: its owner and client admins (isoNc.work), not account admins or consultants',
      ref: () => s.nc!,
      allowed: [PERSON.kabir, PERSON.rohan],
      refused: [
        [PERSON.meera, 403],
        [PERSON.arjun, 403],
        [PERSON.nisha, 403],
        [PERSON.sameer, 403],
        [ISHAAN, 404],
      ],
    },
    {
      name: "an action: managers, its owner and its subject's owner",
      ref: () => s.ncAction!,
      allowed: [PERSON.meera, PERSON.sameer, PERSON.rohan],
      refused: [
        [PERSON.divya, 403],
        [PERSON.nisha, 403],
      ],
    },
    {
      name: "an objective's action: managers, its owner and the objective owner",
      ref: () => s.objectiveAction!,
      allowed: [PERSON.kabir, PERSON.rohan, PERSON.sameer],
      refused: [[PERSON.divya, 403]],
    },
    {
      name: "an internal finding's action: managers and its owner; an approver leading the audit may not",
      ref: () => s.findingAction!,
      allowed: [PERSON.kabir, PERSON.sameer],
      refused: [
        [PERSON.nisha, 403],
        [PERSON.rohan, 403],
        [PERSON.divya, 403],
      ],
    },
    {
      name: "an external finding's action: managers and its owner",
      ref: () => s.externalFindingAction!,
      allowed: [PERSON.arjun, PERSON.sameer],
      refused: [[PERSON.divya, 403]],
    },
    {
      name: "a review action: its owner, named, whatever the review's units",
      ref: () => s.reviewAction!,
      allowed: [ISHAAN, PERSON.sameer],
      refused: [[PERSON.rohan, 403]],
    },
    {
      name: 'a review: managers and its chair (an owner), not an attendee',
      ref: () => s.review!,
      allowed: [PERSON.sameer, PERSON.arjun],
      refused: [
        [PERSON.nisha, 403],
        [PERSON.rohan, 403],
        [PERSON.vikram, 403],
      ],
    },
    {
      name: 'a review chaired by an approver: the chair',
      ref: () => s.reviewByApprover!,
      allowed: [PERSON.divya],
      refused: [[PERSON.nisha, 403]],
    },
  ];

  for (const c of writeCases) {
    it(`lets whoever may write ${c.name} add and remove files`, async () => {
      const subject = c.ref();
      let last: FileView | undefined;
      for (const as of c.allowed) {
        last = await upload(subject, as);
        expect(last.subject).toEqual(subject);
        expect(lastEvent(subject.id)).toMatchObject({
          action: 'EVIDENCE_ADD',
          entityType: subject.type,
          actorId: as,
        });
      }
      const spare = await ticket(subject, c.allowed[0]!);
      for (const [as, status] of c.refused) {
        const code = status === 403 ? 'FORBIDDEN' : 'NOT_FOUND';
        const body = { subject, fileName: 'r.pdf', mimeType: 'application/pdf', sizeBytes: 9 };
        await fails(app, 'isoFileUploadUrl', { as, body }, code, status);
        await fails(
          app,
          'confirmIsoFile',
          {
            as,
            body: { subject, uploadId: spare.uploadId, fileName: 'r.pdf', sha256: SHA },
          },
          code,
          status,
        );
        await fails(
          app,
          'removeIsoFile',
          { as, params: { id: last!.id }, body: { reason: 'x' } },
          code,
          status,
        );
      }
      await remove(last!.id, c.allowed[0]!);
    });
  }

  it("names the subject's own action when a manager role may not write it", async () => {
    const refused = await fails(
      app,
      'isoFileUploadUrl',
      {
        as: PERSON.meera,
        body: { subject: s.nc, fileName: 'r.pdf', mimeType: 'application/pdf', sizeBytes: 9 },
      },
      'FORBIDDEN',
      403,
    );
    expect(refused.error.details).toEqual({ action: 'isoNc.work' });
  });

  it('refuses files on a locked subject for every role, while reads go on', async () => {
    const locked = async (subject: Ref, entity: string, from: string) => {
      const file = seedFile(subject);
      for (const as of [PERSON.kabir, PERSON.meera]) {
        const result = await call(app, 'isoFileUploadUrl', {
          as,
          body: { subject, fileName: 'r.pdf', mimeType: 'application/pdf', sizeBytes: 9 },
        });
        if (result.status === 403) continue; // FA on a nonconformity: refused before the lock.
        expect(result.status, `${subject.type} ${JSON.stringify(result.json)}`).toBe(409);
        expect((result.json as ErrorBody).error.details).toEqual({
          entity,
          from,
          action: 'UPDATE',
        });
      }
      await fails(
        app,
        'removeIsoFile',
        { as: PERSON.kabir, params: { id: file.id }, body: { reason: 'x' } },
        'INVALID_TRANSITION',
        409,
      );
      expect((await listFiles(subject, PERSON.kabir)).map((f) => f.id)).toContain(file.id);
      await download(file.id, PERSON.kabir);
    };

    const doc = seedDocument(system.id);
    for (const state of ['IN_REVIEW', 'APPROVED', 'SUPERSEDED'] as const) {
      const revision = seedRevision(doc.id, state);
      await locked({ type: 'document_revision', id: revision.id }, 'document_revision', state);
    }
    const obsolete = seedDocument(system.id, { status: 'OBSOLETE' });
    await locked(
      { type: 'document_revision', id: seedRevision(obsolete.id).id },
      'controlled_document',
      'OBSOLETE',
    );
    const closedObjective = seedObjective(system.id, {
      closedOn: '2024-11-01',
      outcome: 'NOT_ACHIEVED',
    });
    await locked(
      { type: 'objective_reading', id: seedReading(closedObjective.id, 1).id },
      'objective',
      'CLOSED',
    );
    const programme = seedProgramme(system.id);
    for (const state of ['REPORTED', 'CLOSED'] as const) {
      const audit = seedAudit(programme.id, { ...reported('2024-11-01'), state });
      await locked({ type: 'internal_audit', id: audit.id }, 'internal_audit', state);
      const finding = seedFinding({ internalAuditId: audit.id });
      await locked({ type: 'audit_finding', id: finding.id }, 'internal_audit', state);
    }
    const cancelledAudit = seedAudit(programme.id, {
      state: 'CANCELLED',
      cancelReason: 'Moved',
    });
    await locked({ type: 'internal_audit', id: cancelledAudit.id }, 'internal_audit', 'CANCELLED');
    const inProgress = seedAudit(programme.id, { state: 'IN_PROGRESS' });
    await upload({ type: 'internal_audit', id: inProgress.id }, PERSON.kabir);
    const closedExternal = seedExternal(system.id, {
      state: 'CLOSED',
      recommendation: 'RECOMMENDED',
    });
    await locked({ type: 'external_audit', id: closedExternal.id }, 'external_audit', 'CLOSED');
    await locked(
      { type: 'audit_finding', id: seedFinding({ externalAuditId: closedExternal.id }).id },
      'external_audit',
      'CLOSED',
    );
    const cancelledExternal = seedExternal(system.id, {
      state: 'CANCELLED',
      cancelReason: 'Body changed',
    });
    await locked(
      { type: 'external_audit', id: cancelledExternal.id },
      'external_audit',
      'CANCELLED',
    );
    const heldExternal = seedExternal(system.id, { state: 'HELD' });
    await upload({ type: 'external_audit', id: heldExternal.id }, PERSON.kabir);
    const closed = seedNc(system.id, closedNc('2024-11-10'));
    await locked({ type: 'nonconformity', id: closed.id }, 'nonconformity', 'CLOSED');
    const openOnClosed = seedAction({ type: 'NONCONFORMITY', id: closed.id });
    await locked({ type: 'iso_action', id: openOnClosed.id }, 'nonconformity', 'CLOSED');
    const cancelledNc = seedNc(system.id, { state: 'CANCELLED', cancelReason: 'Duplicate' });
    await locked({ type: 'nonconformity', id: cancelledNc.id }, 'nonconformity', 'CANCELLED');
    const risk = seedRisk(system.id);
    const done = seedAction({ type: 'RISK_ITEM', id: risk.id }, { state: 'DONE', doneOn: TODAY });
    await locked({ type: 'iso_action', id: done.id }, 'iso_action', 'DONE');
    const cancelledAction = seedAction(
      { type: 'RISK_ITEM', id: risk.id },
      { state: 'CANCELLED', cancelReason: 'Not needed' },
    );
    await locked({ type: 'iso_action', id: cancelledAction.id }, 'iso_action', 'CANCELLED');
    const closedReview = seedReview(system.id);
    await locked({ type: 'management_review', id: closedReview.id }, 'management_review', 'CLOSED');
    const cancelledReview = seedReview(system.id, {
      state: 'CANCELLED',
      heldOn: null,
      cancelReason: 'Merged',
    });
    await locked(
      { type: 'management_review', id: cancelledReview.id },
      'management_review',
      'CANCELLED',
    );
  });

  it("keeps a subject's files to those who may read it", async () => {
    const harbourSystem = seedSystem(app, { clientId: HARBOUR });
    const harbourReview = await plan(
      harbourSystem.id,
      { chairId: PERSON.joseph, attendeeIds: [] },
      PERSON.leela,
      HARBOUR,
    );
    const harbourRef: Ref = { type: 'management_review', id: harbourReview.id };
    const harbourFile = await upload(harbourRef, PERSON.joseph, HARBOUR);
    await upload(harbourRef, PERSON.leela, HARBOUR);
    await fails(
      app,
      'isoFileUploadUrl',
      {
        as: PERSON.priya,
        params: { clientId: HARBOUR },
        body: { subject: harbourRef, fileName: 'r.pdf', mimeType: 'application/pdf', sizeBytes: 9 },
      },
      'FORBIDDEN',
      403,
    );
    expect(await listFiles(harbourRef, PERSON.priya, HARBOUR)).toHaveLength(2);
    await download(harbourFile.id, PERSON.priya, HARBOUR);
    // Another client's record or file through this client's path, or an unknown record: 404.
    for (const as of [PERSON.meera, PERSON.kabir]) {
      await fails(
        app,
        'listIsoFiles',
        { as, query: { subjectType: 'management_review', subjectId: harbourReview.id } },
        'NOT_FOUND',
        404,
      );
    }
    await fails(
      app,
      'isoFileDownloadUrl',
      { as: PERSON.meera, params: { id: harbourFile.id } },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'listIsoFiles',
      { query: { subjectType: 'risk_item', subjectId: seedId() } },
      'NOT_FOUND',
      404,
    );
    // Unit scope: a Bengaluru risk item's files are not shown to Pune people unless it names them.
    const file = await upload(s.risk!, PERSON.kabir);
    for (const as of [PERSON.rohan, PERSON.nisha]) {
      await fails(
        app,
        'listIsoFiles',
        { as, query: { subjectType: 'risk_item', subjectId: s.risk!.id } },
        'NOT_FOUND',
        404,
      );
      await fails(app, 'isoFileDownloadUrl', { as, params: { id: file.id } }, 'NOT_FOUND', 404);
    }
    expect((await listFiles(s.risk!, PERSON.sameer)).map((f) => f.id)).toContain(file.id);
    expect((await listFiles(s.risk!, ISHAAN)).map((f) => f.id)).toContain(file.id);
  });

  it("lets every member read the current revision's file of an active document", async () => {
    const blr = seedSystem(app, { unitIds: [BENGALURU] });
    const doc = seedDocument(blr.id, { ownerId: ISHAAN, approverId: PERSON.kabir });
    const current = seedRevision(doc.id, 'APPROVED');
    const draft = seedRevision(doc.id);
    doc.currentRevisionId = current.id;
    const currentRef: Ref = { type: 'document_revision', id: current.id };
    const file = seedFile(currentRef);
    seedFile({ type: 'document_revision', id: draft.id });
    expect((await listFiles(currentRef, PERSON.rohan)).map((f) => f.id)).toEqual([file.id]);
    await download(file.id, PERSON.nisha);
    await fails(
      app,
      'listIsoFiles',
      { as: PERSON.rohan, query: { subjectType: 'document_revision', subjectId: draft.id } },
      'NOT_FOUND',
      404,
    );
    doc.status = 'OBSOLETE';
    await fails(
      app,
      'isoFileDownloadUrl',
      { as: PERSON.nisha, params: { id: file.id } },
      'NOT_FOUND',
      404,
    );
  });

  it("lets only the people named and managers download an incident's files", async () => {
    const incident = seedNc(system.id, {
      source: 'NEAR_MISS',
      ownerId: PERSON.sameer,
      approverId: PERSON.divya,
      incident: {
        occurredAt: '2024-11-12T05:00:00Z',
        location: 'Boiler house',
        type: 'NEAR_MISS',
        outcome: 'NONE',
        personCategory: null,
        lostDays: null,
        reportable: false,
        statutoryInstanceId: null,
        investigatorIds: [FARHAN],
        workerParticipation: true,
      },
    });
    const ncFile = seedFile({ type: 'nonconformity', id: incident.id });
    const action = seedAction(
      { type: 'NONCONFORMITY', id: incident.id },
      { ownerId: PERSON.rohan },
    );
    const actionRef: Ref = { type: 'iso_action', id: action.id };
    const actionFile = seedFile(actionRef);
    for (const as of [PERSON.vikram, PERSON.rohan, PERSON.nisha]) {
      expect(
        (await listFiles({ type: 'nonconformity', id: incident.id }, as)).map((f) => f.id),
      ).toEqual([ncFile.id]);
      for (const id of [ncFile.id, actionFile.id]) {
        const refused = await fails(
          app,
          'isoFileDownloadUrl',
          { as, params: { id } },
          'FORBIDDEN',
          403,
        );
        expect(refused.error.details).toEqual({ action: 'isoFile.read' });
      }
    }
    // The action's owner may still add files to it.
    await upload(actionRef, PERSON.rohan);
    for (const as of [
      PERSON.sameer,
      PERSON.divya,
      FARHAN,
      PERSON.kabir,
      PERSON.arjun,
      PERSON.meera,
    ]) {
      await download(ncFile.id, as);
      await download(actionFile.id, as);
    }
    // Other nonconformities' files: whoever reads them.
    const plain = seedFile(s.nc!);
    await download(plain.id, PERSON.vikram);
  });

  it('answers 403 FEATURE_NOT_ENABLED with the add-on off', async () => {
    await setFeatures(app, []);
    try {
      await fails(
        app,
        'listIsoFiles',
        { query: { subjectType: 'management_review', subjectId: review.id } },
        'FEATURE_NOT_ENABLED',
        403,
      );
      await fails(app, 'listIsoManagementReviews', {}, 'FEATURE_NOT_ENABLED', 403);
    } finally {
      await setFeatures(app, ['isoManagement']);
    }
    await ok(app, 'listIsoManagementReviews', {});
  });
});
