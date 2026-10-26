// Mock handlers for the ISO add-on: Management reviews with inputs and outputs (model §3.13, §4.5), and ISO files (model §6).
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
// File bytes are not stored: the PUT URL points nowhere, and a confirmed file passes its "scan" on the next read of its
// subject's files or of a download URL (a file name containing "eicar" fails it instead), as evidence does (work.ts).
import type { z } from 'zod';
import { SIGNED_URL_TTL_SECONDS } from '../../../api/common.js';
import { DEFAULT_ISO_RISK_RULE } from '../../../defaults.js';
import type {
  ManagementReviewView,
  ReviewClauseRef,
  ReviewInputView,
  ReviewOutputView,
} from '../../../api/iso.js';
import { type EntityType, IsoStandardCode, type Role } from '../../../enums.js';
import type {
  ReviewFigureAction,
  ReviewFigureData,
  ReviewFigureDays,
  ReviewFigureEventDay,
  TypedReviewInputFigures,
} from '../../../engine-api.js';
import type { LocalDate } from '../../../primitives.js';
import {
  FindingType,
  IncidentOutcome,
  IncidentType,
  ISO_FILE_SUBJECT_COLUMNS,
  IsoFileSubjectType,
  type IsoFileView,
  NcSeverity,
  NcSource,
  REVIEW_FIGURE_KEYS,
  type ReviewFigure,
  type ReviewFigureKeyInfo,
  type ReviewInputFigures,
  ReviewInputKey,
  type ReviewInputSource,
  ReviewOutputKey,
  reviewRiskKinds,
} from '../../../schemas/iso.js';
import {
  type Actor,
  type Clock,
  fileUrl,
  Lookup,
  matches,
  membershipsFor,
  MockError,
  notFound,
  paginate,
  type Scope,
  MOCK_ENGINE_VERSION,
} from '../../core.js';
import { score } from '../../derive.js';
import { actorOf, type PartialHandlers } from '../../handler.js';
import {
  canSee,
  checkIsoPerson,
  checkIsoVersion,
  clauseOf,
  finishIsoScans,
  forbidden,
  holdsRole,
  invalid,
  invalidTransition,
  isClientAdmin,
  type IsoCtx,
  isoAudit,
  type IsoEntity,
  isoFresh,
  type IsoReach,
  isoScope,
  type IsoTable,
  liveIso,
  reachOf,
  requireIso,
  requireSystem,
  selfScope,
  standardOf,
  systemUnitIds,
  touchIso,
} from '../../iso/common.js';
import { localDate, objectiveOnTrackFrom } from '../../iso/derive.js';
import type { FirmState, AuditRecord, IsoRow } from '../../store.js';

type Ids =
  | 'listIsoManagementReviews'
  | 'planIsoManagementReview'
  | 'getIsoManagementReview'
  | 'updateIsoManagementReview'
  | 'replanIsoManagementReview'
  | 'cancelIsoManagementReview'
  | 'recordIsoManagementReviewHeld'
  | 'closeIsoManagementReview'
  | 'listIsoReviewInputs'
  | 'updateIsoReviewInput'
  | 'listIsoReviewOutputs'
  | 'updateIsoReviewOutput'
  | 'isoFileUploadUrl'
  | 'confirmIsoFile'
  | 'listIsoFiles'
  | 'isoFileDownloadUrl'
  | 'removeIsoFile';

type System = IsoRow<'managementSystems'>;
type Review = IsoRow<'managementReviews'>;
type Input = IsoRow<'reviewInputs'>;
type Output = IsoRow<'reviewOutputs'>;
type Nc = IsoRow<'nonconformities'>;
type Action = IsoRow<'actions'>;
type Audit = IsoRow<'internalAudits'>;
type Finding = IsoRow<'findings'>;
type Objective = IsoRow<'objectives'>;
type FileRow = IsoRow<'files'>;
type Code = IsoStandardCode;
type InputDef = FirmState['isoCatalogue']['reviewInputDefs'][number];
type OutputDef = FirmState['isoCatalogue']['reviewOutputDefs'][number];
type ReviewOut = z.input<typeof ManagementReviewView>;
type InputOut = z.input<typeof ReviewInputView>;
type OutputOut = z.input<typeof ReviewOutputView>;
type ClauseRef = z.input<typeof ReviewClauseRef>;
type Figures = z.input<typeof ReviewInputFigures>;
type Figure = z.input<typeof ReviewFigure>;
type FileOut = z.input<typeof IsoFileView>;
type SubjectRef = { type: IsoFileSubjectType; id: string };
type SubjectColumn = (typeof ISO_FILE_SUBJECT_COLUMNS)[IsoFileSubjectType];

const MANAGERS: readonly Role[] = ['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN'];
/** Review states after which it takes no more edits, input notes, output decisions or files (model §1.8, §6). */
const FINAL: readonly Review['state'][] = ['CLOSED', 'CANCELLED'];
/** Reviews that were held: their `heldOn` counts (model §5.2, §5.4). */
const HELD: readonly Review['state'][] = ['HELD', 'CLOSED'];
/**
 * Audit groups of a review edit (model §8): moving its date is a due-date change and a new chair a reassignment, each
 * with the reason, and its standards (with the input and output rows that follow them), attendees and minutes an UPDATE.
 */
const EDIT_GROUPS: [AuditRecord['action'], (keyof Review)[]][] = [
  ['DUE_DATE_CHANGE', ['plannedOn']],
  ['REASSIGN', ['chairId']],
  ['UPDATE', ['standards', 'attendeeIds', 'minutes']],
];
/** The catalogue copy's activity for 14001 and 45001 9.1.2 (docs/iso/catalogue.md §3). */
const COMPLIANCE_EVALUATION_REF = 'ISO-COMPLIANCE-EVALUATION';

// ---------- lookups ----------

/** A record's parent, archived or not: no row is ever deleted, so it always exists. */
function parentOf<K extends IsoTable>(firm: FirmState, table: K, id: string): IsoRow<K> {
  return (firm.iso[table] as IsoRow<K>[]).find((r) => (r as { id: string }).id === id)!;
}

const systemOf = (firm: FirmState, review: Review): System =>
  parentOf(firm, 'managementSystems', review.managementSystemId);

const requireReview = (actor: Actor, clientId: string | undefined, id: string | undefined) =>
  requireIso(actor.firm, 'managementReviews', clientId!, id!);

const inputDef = (firm: FirmState, id: string): InputDef =>
  firm.isoCatalogue.reviewInputDefs.find((d) => d.id === id)!;

const outputDef = (firm: FirmState, id: string): OutputDef =>
  firm.isoCatalogue.reviewOutputDefs.find((d) => d.id === id)!;

/** The client's time zone, for the day an instant falls on. */
const timeZoneOf = (firm: FirmState, clientId: string) =>
  firm.data.clients.find((c) => c.id === clientId)!.settings.timeZone;

/** `standards` in code order (9001, 14001, 45001), so an unchanged set never reads as a change. */
const inCodeOrder = (standards: readonly Code[]): Code[] =>
  IsoStandardCode.options.filter((code) => standards.includes(code));

/** By creation; rows created in the same instant keep the order they were stored in (the sort is stable). */
const byCreation = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt.localeCompare(b.createdAt);

// ---------- unit scope (plan §3.3) ----------

/** The roles that hold a unit list must cover the record's units, unless it names the actor. */
const unitsFor = (actor: Actor, reach: IsoReach) =>
  reach.people.includes(actor.person.id) ? undefined : reach.unitIds;

/** A record without units of its own takes its management system's units. */
const systemReach = (
  firm: FirmState,
  record: { clientId: string; managementSystemId: string },
  people: readonly (string | null)[] = [],
): IsoReach =>
  reachOf(firm, { clientId: record.clientId, systemId: record.managementSystemId, people });

/** A review names its chair and attendees, who always see it. */
const reviewReach = (firm: FirmState, review: Review): IsoReach =>
  systemReach(firm, review, [review.chairId, ...review.attendeeIds]);

const ncReach = (firm: FirmState, nc: Nc): IsoReach =>
  reachOf(firm, {
    clientId: nc.clientId,
    unitId: nc.unitId,
    systemId: nc.managementSystemId,
    people: [nc.ownerId, nc.approverId, ...(nc.incident?.investigatorIds ?? [])],
  });

const riskReach = (firm: FirmState, item: IsoRow<'riskItems'>): IsoReach =>
  reachOf(firm, {
    clientId: item.clientId,
    unitId: item.unitId,
    systemId: item.managementSystemId,
    people: [item.ownerId],
  });

const objectiveReach = (firm: FirmState, objective: Objective): IsoReach =>
  systemReach(firm, objective, [objective.ownerId]);

/** An internal audit's system, through its programme. */
const auditSystemId = (firm: FirmState, audit: Audit) =>
  parentOf(firm, 'auditProgrammes', audit.programmeId).managementSystemId;

/** An internal audit's units (its list, else its system's) and everyone it names. */
const auditReach = (firm: FirmState, audit: Audit): IsoReach =>
  reachOf(firm, {
    clientId: audit.clientId,
    unitIds: audit.unitIds,
    systemId: auditSystemId(firm, audit),
    people: [audit.leadAuditorId, ...audit.auditorIds, ...audit.auditeeIds, ...audit.reportedToIds],
  });

/** A finding takes its audit's reach (a child record takes its parent's units). */
const findingReach = (firm: FirmState, finding: Finding): IsoReach =>
  finding.internalAuditId !== null
    ? auditReach(firm, parentOf(firm, 'internalAudits', finding.internalAuditId))
    : systemReach(firm, parentOf(firm, 'externalAudits', finding.externalAuditId!));

/**
 * What an action hangs off: the subject's reach, the subject's owner ("own" for `isoAction.write`, plan §3.2: an internal
 * audit's finding takes the lead auditor, a review its chair, an external audit's finding nobody), and its nonconformity.
 */
function actionParent(
  firm: FirmState,
  action: Action,
): { reach: IsoReach; ownerId: string | null; nc: Nc | null } {
  const id = action.subject.id;
  switch (action.subject.type) {
    case 'NONCONFORMITY': {
      const nc = parentOf(firm, 'nonconformities', id);
      return { reach: ncReach(firm, nc), ownerId: nc.ownerId, nc };
    }
    case 'RISK_ITEM': {
      const item = parentOf(firm, 'riskItems', id);
      return { reach: riskReach(firm, item), ownerId: item.ownerId, nc: null };
    }
    case 'OBJECTIVE': {
      const objective = parentOf(firm, 'objectives', id);
      return { reach: objectiveReach(firm, objective), ownerId: objective.ownerId, nc: null };
    }
    case 'AUDIT_FINDING': {
      const finding = parentOf(firm, 'findings', id);
      const lead =
        finding.internalAuditId === null
          ? null
          : parentOf(firm, 'internalAudits', finding.internalAuditId).leadAuditorId;
      return { reach: findingReach(firm, finding), ownerId: lead, nc: null };
    }
    case 'MANAGEMENT_REVIEW': {
      const review = parentOf(firm, 'managementReviews', id);
      return { reach: reviewReach(firm, review), ownerId: review.chairId, nc: null };
    }
  }
}

/** An action takes its subject's units, and its owner always sees it. */
function actionReach(firm: FirmState, action: Action): IsoReach {
  const reach = actionParent(firm, action).reach;
  return { ...reach, people: [...reach.people, action.ownerId] };
}

// ---------- who may act (plan §3.2) ----------

/** FA, CO or CA within the review's reach: `isoReview.plan`, and `isoReview.write` as delegate. */
const plansReview = (actor: Actor, review: Review, reach: IsoReach) =>
  holdsRole(actor, review.clientId, MANAGERS, unitsFor(actor, reach));

/** `isoReview.write`: a manager, or an approver or owner who chairs the review (an attendee is not the chair). */
const writesReview = (actor: Actor, review: Review, reach: IsoReach) =>
  plansReview(actor, review, reach) ||
  (review.chairId === actor.person.id && holdsRole(actor, review.clientId, ['APPROVER', 'OWNER']));

/** A step the chair or a client admin normally takes, taken by someone else as delegate (model §4 preamble). */
const delegatedChairStep = (actor: Actor, review: Review) =>
  actor.person.id !== review.chairId && !isClientAdmin(actor, review.clientId);

// ---------- definitions and rows ----------

/** The catalogue standard id of each code the system covers. */
function systemStandards(firm: FirmState, system: System): Map<Code, string> {
  const ids = new Map<Code, string>();
  for (const id of system.standardIds) {
    const standard = standardOf(firm, id);
    if (standard !== undefined) ids.set(standard.code, id);
  }
  return ids;
}

/** The definitions of `standards` (of the system), by standard and then catalogue order, each with its code. */
function defsOf<D extends { standardId: string }>(
  firm: FirmState,
  system: System,
  standards: readonly Code[],
  defs: readonly D[],
): (D & { standard: Code })[] {
  const ids = systemStandards(firm, system);
  return inCodeOrder(standards).flatMap((standard) =>
    defs.filter((d) => d.standardId === ids.get(standard)).map((d) => ({ ...d, standard })),
  );
}

/** One row per key, in key order: the key's first definition among the review's standards. */
function wantedKeys(
  defs: readonly { id: string; key: string }[],
  order: readonly string[],
): Map<string, string> {
  const wanted = new Map<string, string>();
  for (const key of order) {
    const first = defs.find((d) => d.key === key);
    if (first !== undefined) wanted.set(key, first.id);
  }
  return wanted;
}

/** Where `key` sits in each standard of the review: every definition of it (the view's `clauseRefs`). */
function clauseRefs(
  firm: FirmState,
  defs: readonly { key: string; standard: Code; clauseNumber: string; item: string | null }[],
  def: { key: string; standardId: string; clauseNumber: string; item: string | null },
): ClauseRef[] {
  const refs = defs.filter((d) => d.key === def.key);
  const of = (d: { clauseNumber: string; item: string | null }, standard: Code): ClauseRef => ({
    standard,
    clauseNumber: d.clauseNumber,
    item: d.item,
  });
  // A row always has a definition among the review's standards; fall back to its own for a hand-seeded one.
  return refs.length > 0
    ? refs.map((d) => of(d, d.standard))
    : [of(def, standardOf(firm, def.standardId)!.code)];
}

const keyRank = (order: readonly string[], key: string) => order.indexOf(key);

/** The review's live input rows, in key order. */
function inputsOf(firm: FirmState, review: Review): Input[] {
  const rank = (row: Input) => keyRank(ReviewInputKey.options, inputDef(firm, row.inputDefId).key);
  return liveIso(firm, 'reviewInputs', review.clientId)
    .filter((row) => row.managementReviewId === review.id)
    .sort((a, b) => rank(a) - rank(b));
}

/** The review's live output rows, in key order. */
function outputsOf(firm: FirmState, review: Review): Output[] {
  const rank = (row: Output) =>
    keyRank(ReviewOutputKey.options, outputDef(firm, row.outputDefId).key);
  return liveIso(firm, 'reviewOutputs', review.clientId)
    .filter((row) => row.managementReviewId === review.id)
    .sort((a, b) => rank(a) - rank(b));
}

/**
 * Brings one kind of row in line with `wanted` (key → definition id): a key no longer wanted has its row archived
 * (its notes or decision stay on it), a kept row points at the key's wanted definition, and a new key gets a row.
 */
function syncKeys<R extends { archivedAt: string | null; version: number; updatedAt: string }>(
  ctx: IsoCtx,
  rows: R[],
  wanted: Map<string, string>,
  row: { key: (r: R) => string; defId: (r: R) => string; repoint: (r: R, defId: string) => void },
  add: (defId: string) => void,
): { added: string[]; removed: string[] } {
  const removed: string[] = [];
  for (const r of rows) {
    const key = row.key(r);
    const defId = wanted.get(key);
    if (defId === undefined) {
      r.archivedAt = ctx.clock.now();
      touchIso(ctx, r);
      removed.push(key);
    } else if (row.defId(r) !== defId) {
      row.repoint(r, defId);
      touchIso(ctx, r);
    }
  }
  const have = new Set(rows.map(row.key));
  const added: string[] = [];
  for (const [key, defId] of wanted) {
    if (have.has(key)) continue;
    add(defId);
    added.push(key);
  }
  return { added, removed };
}

/**
 * Makes the review's rows one input per input key and one output per output key of its standards (model §3.13: a key
 * shared by several standards appears once). Returns the keys added and removed, for the review's audit event: rows
 * without an entity type of their own are audited on the review (model §8).
 */
function syncRows(
  ctx: IsoCtx,
  actor: Actor,
  review: Review,
  system: System,
): Record<string, string[]> {
  const firm = actor.firm;
  const catalogue = firm.isoCatalogue;
  const inputs = syncKeys(
    ctx,
    inputsOf(firm, review),
    wantedKeys(
      defsOf(firm, system, review.standards, catalogue.reviewInputDefs),
      ReviewInputKey.options,
    ),
    {
      key: (r) => inputDef(firm, r.inputDefId).key,
      defId: (r) => r.inputDefId,
      repoint: (r, defId) => {
        r.inputDefId = defId;
      },
    },
    (defId) => {
      firm.iso.reviewInputs.push({
        ...isoFresh(ctx, actor, review.clientId),
        managementReviewId: review.id,
        inputDefId: defId,
        notes: null,
      });
    },
  );
  const outputs = syncKeys(
    ctx,
    outputsOf(firm, review),
    wantedKeys(
      defsOf(firm, system, review.standards, catalogue.reviewOutputDefs),
      ReviewOutputKey.options,
    ),
    {
      key: (r) => outputDef(firm, r.outputDefId).key,
      defId: (r) => r.outputDefId,
      repoint: (r, defId) => {
        r.outputDefId = defId;
      },
    },
    (defId) => {
      firm.iso.reviewOutputs.push({
        ...isoFresh(ctx, actor, review.clientId),
        managementReviewId: review.id,
        outputDefId: defId,
        decision: null,
      });
    },
  );
  const changes = {
    inputKeysAdded: inputs.added,
    inputKeysRemoved: inputs.removed,
    outputKeysAdded: outputs.added,
    outputKeysRemoved: outputs.removed,
  };
  return Object.fromEntries(Object.entries(changes).filter(([, keys]) => keys.length > 0));
}

// ---------- review input figures (model §3.13, §5.4) ----------

// A held review's figures are a record (model §1.7): RECORD_HELD stores each input's figures once, counted up to its
// `heldOn`, and a HELD or CLOSED review always shows that copy. A PLANNED review's are computed on each read, as of the
// client's today. Either way they count the whole system, with no unit scope (plan §3.3 exception); each reader gets
// the ids they may read, and the values as they are, except the INCIDENTS row withheld from a reader who sees only part
// of the system and takes no part in the review (model §3.13 item 4).
//
// The mock splits the work as M3 and M4 do: `gather` builds the contract's `ReviewFigureData` for one input from the
// store and its audit trail, as ISO-2h's `reviewFigures.gather` will, and `figuresFrom` computes the figures from that
// data and the window alone, as the engine's `reviewInputFigures` will once typed (`TypedReviewInputFigures`, ISO-3b).

type FigureSource = Exclude<ReviewInputSource, 'MANUAL'>;

/** A contract type as the mock's rows hold it: branded strings (days) as plain strings. */
type Unbranded<T> = T extends z.$brand
  ? string
  : T extends readonly (infer U)[]
    ? Unbranded<U>[]
    : T extends object
      ? { [K in keyof T]: Unbranded<T[K]> }
      : T;
type Data<S extends FigureSource> = Unbranded<ReviewFigureData[S]>;
type FigureAction = Unbranded<ReviewFigureAction>;
type FigureDays = Unbranded<ReviewFigureDays>;
type EventDay = Unbranded<ReviewFigureEventDay>;

/** What gathering one input's records reads: the review, its system, the input's key and standards, as-of. */
interface GatherScope {
  firm: FirmState;
  review: Review;
  system: System;
  key: InputDef['key'];
  /** The review's standards that ask for this input. */
  codes: readonly Code[];
  asOf: string;
  timeZone: string;
  /** The held reviews before this one that cover one of `codes` (`earlierReviews`). */
  earlier: readonly Review[];
}

const figure = (key: string, ids: readonly string[]): Figure => ({
  key,
  value: ids.length,
  ids: [...ids],
});

/** `prefix` and an enum value as one camelCase key: ('raised', 'INTERNAL_AUDIT') is 'raisedInternalAudit'. */
const figureKey = (prefix: string, value: string) =>
  prefix +
  value
    .toLowerCase()
    .replace(/(^|_)([a-z0-9])/g, (_match, _sep: string, c: string) => c.toUpperCase());

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

// ----- gather: the records of one input, as ISO-2h's `reviewFigures.gather` reads them -----

/** An instant's day in the client's time zone (the caller's `localDateIn`). */
const dayOf = (g: GatherScope, instant: string) => localDate(instant, g.timeZone);

/** A row's creation and archive days. */
const daysOf = (g: GatherScope, row: { createdAt: string; archivedAt: string | null }) => ({
  createdOn: dayOf(g, row.createdAt),
  archivedOn: row.archivedAt === null ? null : dayOf(g, row.archivedAt),
});

/** A table's rows of the review's client, archived ones included. */
const rowsOf = <K extends IsoTable>(g: GatherScope, table: K): IsoRow<K>[] =>
  (g.firm.iso[table] as IsoRow<K>[]).filter(
    (r) => (r as { clientId: string }).clientId === g.review.clientId,
  );

/** The audited events of the given records that pass `test`. */
const eventsOf = (
  g: GatherScope,
  entityType: IsoEntity,
  entityIds: ReadonlySet<string>,
  test: (e: AuditRecord) => boolean,
) =>
  g.firm.data.auditEvents.filter(
    (e) => e.entityType === entityType && entityIds.has(e.entityId) && test(e),
  );

/** Event days for model §5.4's window counts: one per event, each on its client-local day. */
const eventDays = (g: GatherScope, events: readonly AuditRecord[]): EventDay[] =>
  events.map((e) => ({ entityId: e.entityId, on: dayOf(g, e.at) }));

/** A TRANSITION naming one of `steps` in its `after.action`. */
const stepIs =
  (...steps: string[]) =>
  (e: AuditRecord) =>
    e.action === 'TRANSITION' && steps.includes(e.after?.action as string);

/**
 * The day of a record's latest step that passes `test` (model §5.4: the latest when it was taken more than once). A
 * row seeded or loaded without its trail has no such event, so its `updatedAt` stands in for the step.
 */
function stepDay(
  g: GatherScope,
  entityType: IsoEntity,
  row: { id: string; updatedAt: string },
  test: (e: AuditRecord) => boolean,
): string {
  const latest = eventsOf(g, entityType, new Set([row.id]), test).reduce<string | null>(
    (at, e) => (at === null || e.at > at ? e.at : at),
    null,
  );
  return dayOf(g, latest ?? row.updatedAt);
}

/** An action with its settled day: its latest COMPLETE or CANCEL step, none while OPEN. */
const actionData = (g: GatherScope, a: Action): FigureAction => ({
  id: a.id,
  subject: a.subject,
  state: a.state,
  dueOn: a.dueOn,
  doneOn: a.doneOn,
  ...daysOf(g, a),
  settledOn: a.state === 'OPEN' ? null : stepDay(g, 'iso_action', a, stepIs('COMPLETE', 'CANCEL')),
});

/** The actions on records of one subject type among `subjectIds`. */
const actionsOn = (g: GatherScope, type: Action['subject']['type'], subjectIds: Set<string>) =>
  rowsOf(g, 'actions')
    .filter((a) => a.subject.type === type && subjectIds.has(a.subject.id))
    .map((a) => actionData(g, a));

/** Rating fields: an audited UPDATE that names one of them in its `after` is a re-rating. */
const RATING_FIELDS = ['likelihood', 'severity', 'residualLikelihood', 'residualSeverity'];

/**
 * A re-rating (model §5.4): a risk item's UPDATE whose `after` names a rating field. The clearing of the residual
 * rating when a treatment action puts the last control in place names its action (`sourceActionId`) and is not one.
 */
const isRerating = (e: AuditRecord) =>
  e.action === 'UPDATE' &&
  e.after !== null &&
  !('sourceActionId' in e.after) &&
  RATING_FIELDS.some((field) => field in e.after!);

/** A climate decision: a management system UPDATE naming a climate field, which only the climate route writes. */
const CLIMATE_FIELDS = ['climateChangeRelevant', 'climateChangeRationale', 'climateDecidedOn'];
const setsClimate = (e: AuditRecord) =>
  e.action === 'UPDATE' && e.after !== null && CLIMATE_FIELDS.some((field) => field in e.after!);

/** The system's nonconformities of the input's standards. */
const ncsOf = (g: GatherScope) =>
  rowsOf(g, 'nonconformities').filter(
    (n) =>
      n.managementSystemId === g.system.id && n.standards.some((code) => g.codes.includes(code)),
  );

/** Internal audit states once reported, and external audit states once the visit took place. */
const REPORTED: readonly string[] = ['REPORTED', 'CLOSED'];
const VISITED: readonly string[] = ['HELD', 'RESPONDED', 'CLOSED'];

const GATHER: { [S in FigureSource]: (g: GatherScope) => Data<S> } = {
  PREVIOUS_ACTIONS: (g) => ({
    actions: actionsOn(g, 'MANAGEMENT_REVIEW', new Set(ids(g.earlier))),
  }),

  CONTEXT: (g) => {
    const items = rowsOf(g, 'contextItems').filter((c) => c.managementSystemId === g.system.id);
    const { system } = g;
    const updates = eventsOf(g, 'context_item', new Set(ids(items)), (e) => e.action === 'UPDATE');
    const decisions = eventsOf(g, 'management_system', new Set([system.id]), setsClimate);
    return {
      contextItems: items.map((c) => ({ id: c.id, kind: c.kind, ...daysOf(g, c) })),
      contextChanges: eventDays(g, updates),
      system: {
        id: system.id,
        climateChangeRelevant: system.climateChangeRelevant,
        climateDecidedOn: system.climateDecidedOn,
      },
      // A system seeded or loaded decided but without its trail takes its `updatedAt` as its one decision.
      climateDecisions:
        decisions.length > 0 || system.climateChangeRelevant === null
          ? eventDays(g, decisions)
          : [{ entityId: system.id, on: dayOf(g, system.updatedAt) }],
    };
  },

  RISKS: (g) => {
    const kinds = reviewRiskKinds(g.key, g.codes);
    const items = rowsOf(g, 'riskItems').filter(
      (i) => i.managementSystemId === g.system.id && kinds.includes(i.kind),
    );
    const itemIds = new Set(ids(items));
    return {
      kinds,
      riskItems: items.map((i) => ({
        id: i.id,
        kind: i.kind,
        significant: i.significant,
        ...daysOf(g, i),
      })),
      ratingChanges: eventDays(g, eventsOf(g, 'risk_item', itemIds, isRerating)),
      treatmentActions: actionsOn(g, 'RISK_ITEM', itemIds),
    };
  },

  OBJECTIVES: (g) => {
    const readings = rowsOf(g, 'readings');
    const client = g.firm.data.clients.find((c) => c.id === g.review.clientId)!;
    return {
      objectives: rowsOf(g, 'objectives')
        .filter(
          (o) =>
            o.managementSystemId === g.system.id &&
            o.standards.some((code) => g.codes.includes(code)),
        )
        .map((o) => ({
          id: o.id,
          target: o.target,
          baseline: o.baseline,
          direction: o.direction,
          readingRule: o.readingRule,
          dueOn: o.dueOn,
          closedOn: o.closedOn,
          outcome: o.outcome,
          ...daysOf(g, o),
          closeStepOn: o.closedOn === null ? null : stepDay(g, 'objective', o, stepIs('CLOSE')),
          readings: readings
            .filter((r) => r.objectiveId === o.id)
            .map((r) => ({
              id: r.id,
              periodStart: r.periodStart,
              periodEnd: r.periodEnd,
              value: r.value,
              ...daysOf(g, r),
            })),
        })),
      calendar: { fyStartMonth: client.settings.fyStartMonth },
    };
  },

  NONCONFORMITIES: (g) => {
    const ncs = ncsOf(g);
    const ncIds = new Set(ids(ncs));
    return {
      nonconformities: ncs.map((n) => ({
        id: n.id,
        state: n.state,
        severity: n.severity,
        source: n.source,
        reportedOn: n.reportedOn,
        closedOn: n.closedOn,
        ...daysOf(g, n),
      })),
      notEffectiveSteps: eventDays(
        g,
        eventsOf(g, 'nonconformity', ncIds, stepIs('VERIFY_NOT_EFFECTIVE')),
      ),
      correctiveActions: actionsOn(g, 'NONCONFORMITY', ncIds),
    };
  },

  INCIDENTS: (g) => ({
    nonconformities: ncsOf(g)
      .filter((n) => n.incident !== null && n.state !== 'CANCELLED')
      .map((n) => ({
        id: n.id,
        state: n.state,
        reportedOn: n.reportedOn,
        incident: n.incident,
        ...daysOf(g, n),
      })),
    timeZone: g.timeZone,
  }),

  AUDIT_RESULTS: (g) => {
    const standards = systemStandards(g.firm, g.system);
    const covered = g.codes
      .map((code) => standards.get(code))
      .filter((id): id is string => id !== undefined);
    // A record's standards are its clauses'; one that lists no clauses follows its system (an internal audit) or its
    // audit (a finding), as for the nonconformities a finding raises.
    const ofCovered = (clauseIds: readonly string[]) =>
      clauseIds.length === 0 ||
      clauseIds.some((id) => covered.includes(clauseOf(g.firm, id)?.standardId ?? ''));
    const internal = rowsOf(g, 'internalAudits').filter(
      (a) => auditSystemId(g.firm, a) === g.system.id && ofCovered(a.clauseIds),
    );
    const external = rowsOf(g, 'externalAudits').filter(
      (e) =>
        e.managementSystemId === g.system.id && e.standardIds.some((id) => covered.includes(id)),
    );
    const auditIds = new Set([...ids(internal), ...ids(external)]);
    // RECORD_HELD sets `endOn`, and so does a later edit of the visit's dates.
    const setsEnd = (e: AuditRecord) =>
      stepIs('RECORD_HELD')(e) || (e.action === 'UPDATE' && e.after !== null && 'endOn' in e.after);
    return {
      internalAudits: internal.map((a) => ({
        id: a.id,
        state: a.state,
        reportedOn: a.reportedOn,
        ...daysOf(g, a),
        reportStepOn:
          a.reportedOn === null ? null : stepDay(g, 'internal_audit', a, stepIs('REPORT')),
      })),
      externalAudits: external.map((e) => ({
        id: e.id,
        state: e.state,
        endOn: e.endOn,
        ...daysOf(g, e),
        heldStepOn: VISITED.includes(e.state) ? stepDay(g, 'external_audit', e, setsEnd) : null,
      })),
      findings: rowsOf(g, 'findings')
        .filter(
          (x) => auditIds.has(x.internalAuditId ?? x.externalAuditId!) && ofCovered(x.clauseIds),
        )
        .map((x) => ({
          id: x.id,
          auditId: x.internalAuditId ?? x.externalAuditId!,
          type: x.type,
          ...daysOf(g, x),
        })),
    };
  },

  COMPLIANCE_EVALUATION: (g) => {
    const look = new Lookup(g.firm);
    const units = new Set(systemUnitIds(g.firm, g.system));
    const instances = g.firm.data.instances.filter(
      (i) => i.clientId === g.review.clientId && units.has(i.unitId),
    );
    const isStandard = (i: (typeof instances)[number]) =>
      look.acts.get(look.obligationOf(i).actId)?.kind === 'STANDARD';
    return {
      evaluations: instances
        .filter(
          (i) => isStandard(i) && look.obligationOf(i).externalRef === COMPLIANCE_EVALUATION_REF,
        )
        .map((i) => ({
          id: i.id,
          dueDate: i.dueDate,
          workflowState: i.workflowState,
          completedOn: i.completedOn,
          ...daysOf(g, i),
        })),
      statutoryItems: instances
        .filter((i) => !isStandard(i))
        .map((i) => ({
          instanceId: i.id,
          criticality: look.obligationOf(i).criticality,
          dueDate: i.dueDate,
          workflowState: i.workflowState,
          pendingKind: i.pendingKind,
          completedOn: i.completedOn,
          ...daysOf(g, i),
        })),
      settings: {
        ...g.firm.data.firm.settings,
        isoRisk: g.firm.data.firm.settings.isoRisk ?? DEFAULT_ISO_RISK_RULE,
      },
    };
  },
};

// ----- compute: the figures from the data and the window alone, as the engine's `reviewInputFigures` -----

/** The window: `since` to `asOf`, both days included. */
interface Window {
  since: string;
  asOf: string;
}

/** Between `since` and `asOf`, both days included. */
const within = (w: Window, day: string | null) => day !== null && day >= w.since && day <= w.asOf;

/** On or before as-of. */
const byAsOf = (w: Window, day: string | null) => day !== null && day <= w.asOf;

/** The later of two days; a missing one never wins. */
const later = (a: string | null, b: string | null) => (a === null || (b !== null && b > a) ? b : a);

/** Live on as-of: created by then, and not archived by then (one archived on a later day still counts). */
const liveOn = (w: Window, row: FigureDays) =>
  row.createdOn <= w.asOf && (row.archivedOn === null || row.archivedOn > w.asOf);

/** An action's settled day: the later of `doneOn` and its step when DONE, its step when CANCELLED, none while OPEN. */
const settledDay = (a: FigureAction) =>
  a.state === 'OPEN' ? null : later(a.state === 'DONE' ? a.doneOn : null, a.settledOn);

/** An action's state on as-of: OPEN until its settled day. */
const actionStateAt = (w: Window, a: FigureAction): FigureAction['state'] =>
  byAsOf(w, settledDay(a)) ? a.state : 'OPEN';

/** Open on as-of with its due date before as-of. */
const overdueAt = (w: Window, a: FigureAction) =>
  actionStateAt(w, a) === 'OPEN' && a.dueOn < w.asOf;

/** The actions settled in the window in `state`. */
const settledIn = (w: Window, actions: readonly FigureAction[], state: FigureAction['state']) =>
  actions.filter((a) => a.state === state && within(w, settledDay(a)));

/** An NC's counting day: the later of its creation day and `reportedOn`, which may be backdated. */
const countingDay = (n: { createdOn: string; reportedOn: string }) =>
  later(n.createdOn, n.reportedOn)!;

/** Not archived by as-of. */
const notArchivedBy = (w: Window, row: FigureDays) =>
  row.archivedOn === null || row.archivedOn > w.asOf;

const COMPUTE: { [S in FigureSource]: (d: Data<S>, w: Window) => Figure[] } = {
  /** Open on as-of and overdue then, whichever review raised them; done and cancelled by their settled day. */
  PREVIOUS_ACTIONS: (d, w) => {
    const actions = d.actions.filter((a) => liveOn(w, a));
    return [
      figure('actionsOpen', ids(actions.filter((a) => actionStateAt(w, a) === 'OPEN'))),
      figure('actionsOverdue', ids(actions.filter((a) => overdueAt(w, a)))),
      figure('actionsDone', ids(settledIn(w, actions, 'DONE'))),
      figure('actionsCancelled', ids(settledIn(w, actions, 'CANCELLED'))),
    ];
  },

  /**
   * Issues and interested parties added, changed (an audited UPDATE in the window) or removed in the window, and the
   * climate decision: decided from the first decision by as-of (a decision never returns to undecided), relevant as it
   * is now, and decided in the period when any decision falls in the window.
   */
  CONTEXT: (d, w) => {
    const live = d.contextItems.filter((c) => liveOn(w, c));
    const added = live.filter((c) => within(w, c.createdOn));
    const updated = new Set(d.contextChanges.filter((c) => within(w, c.on)).map((c) => c.entityId));
    const changed = live.filter((c) => !added.includes(c) && updated.has(c.id));
    const party = (c: { kind: string }) => c.kind === 'INTERESTED_PARTY';
    const { system } = d;
    const days = d.climateDecisions.map((c) => c.on);
    const decided = days.some((day) => byAsOf(w, day)) ? [system.id] : [];
    return [
      figure('issuesAdded', ids(added.filter((c) => !party(c)))),
      figure('issuesChanged', ids(changed.filter((c) => !party(c)))),
      figure('interestedPartiesAdded', ids(added.filter(party))),
      figure('interestedPartiesChanged', ids(changed.filter(party))),
      figure(
        'contextItemsRemoved',
        ids(d.contextItems.filter((c) => c.createdOn <= w.asOf && within(w, c.archivedOn))),
      ),
      figure('climateDecided', decided),
      figure('climateRelevant', system.climateChangeRelevant === true ? decided : []),
      figure('climateDecidedInPeriod', days.some((day) => within(w, day)) ? [system.id] : []),
    ];
  },

  /**
   * Items added or re-rated in the window, items significant (as stored now) for each kind the input's key reads (no
   * key for another kind), and the treatment actions of the items live on as-of, done in the window by their settled
   * day and open on as-of.
   */
  RISKS: (d, w) => {
    const items = d.riskItems.filter((i) => liveOn(w, i));
    const added = items.filter((i) => within(w, i.createdOn));
    const rerated = new Set(d.ratingChanges.filter((c) => within(w, c.on)).map((c) => c.entityId));
    const itemIds = new Set(ids(items));
    const treatments = d.treatmentActions.filter((a) => liveOn(w, a) && itemIds.has(a.subject.id));
    const significant = items.filter((i) => i.significant);
    return [
      figure('itemsAdded', ids(added)),
      figure('itemsRerated', ids(items.filter((i) => !added.includes(i) && rerated.has(i.id)))),
      ...d.kinds.map((kind) =>
        figure(figureKey('significant', kind), ids(significant.filter((i) => i.kind === kind))),
      ),
      figure('treatmentActionsDone', ids(settledIn(w, treatments, 'DONE'))),
      figure('treatmentActionsOpen', ids(treatments.filter((a) => actionStateAt(w, a) === 'OPEN'))),
    ];
  },

  /**
   * `objectiveProgress` of each objective of the input's standards (one listing several counts once here): those open
   * on as-of, on track, off track or without a reading (on track reads the readings created by as-of for periods ended
   * by then), those closed in the window by outcome, and the readings created in the window, whatever their period. A
   * closed objective is placed by the later of `closedOn` and its CLOSE step, and is open on as-of until then.
   */
  OBJECTIVES: (d, w) => {
    const objectives = d.objectives.filter((o) => liveOn(w, o));
    const closedDay = (o: (typeof objectives)[number]) =>
      o.closedOn === null ? null : later(o.closedOn, o.closeStepOn);
    const readingsOf = (o: (typeof objectives)[number]) => o.readings.filter((r) => liveOn(w, r));
    const open = objectives.filter((o) => !byAsOf(w, closedDay(o)));
    const track = new Map(
      open.map((o) => [o.id, objectiveOnTrackFrom(o.createdOn, o, readingsOf(o), w.asOf)]),
    );
    const closed = objectives.filter((o) => within(w, closedDay(o)));
    const recorded = objectives.flatMap(readingsOf).filter((r) => within(w, r.createdOn));
    return [
      figure('objectivesOpen', ids(open)),
      figure('onTrack', ids(open.filter((o) => track.get(o.id) === true))),
      figure('offTrack', ids(open.filter((o) => track.get(o.id) === false))),
      figure('withoutReading', ids(open.filter((o) => track.get(o.id) === null))),
      figure('achieved', ids(closed.filter((o) => o.outcome === 'ACHIEVED'))),
      figure('notAchieved', ids(closed.filter((o) => o.outcome === 'NOT_ACHIEVED'))),
      figure('readingsRecorded', ids(recorded)),
    ];
  },

  /**
   * Raised (by its counting day) and closed in the window, by source and severity; VERIFY_NOT_EFFECTIVE steps in the
   * window (the number of steps, with the nonconformities behind them); those open on as-of (not cancelled, as it is
   * now, and not closed by then) and the corrective actions of those open NCs that are overdue on as-of.
   */
  NONCONFORMITIES: (d, w) => {
    const ncs = d.nonconformities.filter((n) => countingDay(n) <= w.asOf && notArchivedBy(w, n));
    const raised = ncs.filter((n) => within(w, countingDay(n)));
    const closed = ncs.filter((n) => within(w, n.closedOn));
    const ncIds = new Set(ids(ncs));
    const notEffective = d.notEffectiveSteps.filter(
      (s) => ncIds.has(s.entityId) && within(w, s.on),
    );
    const open = ncs.filter((n) => n.state !== 'CANCELLED' && !byAsOf(w, n.closedOn));
    const openIds = new Set(ids(open));
    const overdue = d.correctiveActions.filter(
      (a) => liveOn(w, a) && openIds.has(a.subject.id) && overdueAt(w, a),
    );
    const by = (prefix: string, rows: typeof ncs) => [
      ...NcSeverity.options.map((s) =>
        figure(figureKey(prefix, s), ids(rows.filter((n) => n.severity === s))),
      ),
      ...NcSource.options.map((s) =>
        figure(figureKey(prefix, s), ids(rows.filter((n) => n.source === s))),
      ),
    ];
    return [
      figure('raised', ids(raised)),
      figure('closed', ids(closed)),
      ...by('raised', raised),
      ...by('closed', closed),
      {
        key: 'verifiedNotEffective',
        value: notEffective.length,
        ids: [...new Set(notEffective.map((s) => s.entityId))],
      },
      figure('open', ids(open)),
      figure('correctiveActionsOverdue', ids(overdue)),
    ];
  },

  /**
   * Incidents placed in the window by their NC's counting day (their `occurredAt` day is never later), cancelled ones
   * left out, in total, by type and by outcome (as `incidentCounts` groups them), with the lost days.
   */
  INCIDENTS: (d, w) => {
    const incidents = d.nonconformities.filter(
      (n) =>
        n.incident !== null &&
        n.state !== 'CANCELLED' &&
        notArchivedBy(w, n) &&
        within(w, countingDay(n)),
    );
    const lostTime = incidents.filter((n) => n.incident!.lostDays !== null);
    return [
      figure('incidents', ids(incidents)),
      ...IncidentType.options.map((t) =>
        figure(figureKey('type', t), ids(incidents.filter((n) => n.incident!.type === t))),
      ),
      ...IncidentOutcome.options.map((o) =>
        figure(figureKey('outcome', o), ids(incidents.filter((n) => n.incident!.outcome === o))),
      ),
      {
        key: 'lostDays',
        value: lostTime.reduce((sum, n) => sum + n.incident!.lostDays!, 0),
        ids: ids(lostTime),
      },
    ];
  },

  /**
   * Internal audits reported, placed by the later of `reportedOn` and their REPORT step, and external audits held,
   * placed by the later of `endOn` and the step that set it, in the window; and the findings of those audits by type,
   * each placed by the later of its audit's day and its own creation day, whether or not its audit counts in the window.
   */
  AUDIT_RESULTS: (d, w) => {
    const day = new Map<string, string>();
    const internal = d.internalAudits.filter((a) => liveOn(w, a) && REPORTED.includes(a.state));
    for (const a of internal) day.set(a.id, later(a.reportedOn, a.reportStepOn)!);
    const external = d.externalAudits.filter((e) => liveOn(w, e) && VISITED.includes(e.state));
    for (const e of external) day.set(e.id, later(e.endOn, e.heldStepOn)!);
    const findings = d.findings.filter(
      (x) =>
        liveOn(w, x) && day.has(x.auditId) && within(w, later(day.get(x.auditId)!, x.createdOn)),
    );
    return [
      figure('internalAuditsReported', ids(internal.filter((a) => within(w, day.get(a.id)!)))),
      figure('externalAuditsHeld', ids(external.filter((e) => within(w, day.get(e.id)!)))),
      ...FindingType.options.map((t) =>
        figure(figureKey('findings', t), ids(findings.filter((x) => x.type === t))),
      ),
    ];
  },

  /**
   * The evaluation activity's instances on the system's units (due and done in the window, and the latest due by
   * as-of), and the STATUTE-only score of the instances due in the window (a score has no ids), read as they are now,
   * as the core score's as-of is.
   */
  COMPLIANCE_EVALUATION: (d, w) => {
    const evaluations = d.evaluations.filter((i) => liveOn(w, i));
    const latest = evaluations
      .filter((i) => i.dueDate <= w.asOf)
      .sort((a, b) => b.dueDate.localeCompare(a.dueDate))[0];
    const statutory = d.statutoryItems.filter((i) => liveOn(w, i) && within(w, i.dueDate));
    const result = score(
      statutory.map((i) => ({ ...i, id: i.instanceId })),
      w.asOf,
      d.settings,
    ).score;
    return [
      figure('evaluationsDue', ids(evaluations.filter((i) => within(w, i.dueDate)))),
      figure(
        'evaluationsDone',
        ids(evaluations.filter((i) => i.workflowState === 'APPROVED' && within(w, i.completedOn))),
      ),
      figure('latestEvaluation', latest === undefined ? [] : [latest.id]),
      figure(
        'statutoryInstancesDue',
        statutory.map((i) => i.instanceId),
      ),
      ...(result === null ? [] : [{ key: 'statutoryScore', value: result, ids: [] }]),
    ];
  },
};

/** `reviewInputFigures` (model §5.4) from one source's data and the window alone, typed as ISO-3b's engine is. */
const figuresFrom: TypedReviewInputFigures = (source, data, since, asOf) => ({
  source,
  since,
  asOf,
  figures:
    source === 'MANUAL'
      ? []
      : (COMPUTE[source as FigureSource] as (d: unknown, w: Window) => Figure[])(data, {
          since,
          asOf,
        }),
});

// ----- the window and the caller -----

/**
 * Held reviews of the system before this one that covered one of `codes`: HELD or CLOSED, with `heldOn` on or before
 * as-of. At RECORD_HELD the review is still PLANNED, so only reviews already held count, a same-day one included;
 * `notYet` names held reviews to treat as not yet recorded (the fixture's, stored in the order they were recorded).
 */
function earlierReviews(
  firm: FirmState,
  review: Review,
  codes: readonly Code[],
  asOf: string,
  notYet: ReadonlySet<string> = new Set(),
): Review[] {
  return liveIso(firm, 'managementReviews', review.clientId).filter(
    (r) =>
      r.id !== review.id &&
      !notYet.has(r.id) &&
      r.managementSystemId === review.managementSystemId &&
      HELD.includes(r.state) &&
      r.heldOn! <= asOf &&
      r.standards.some((code) => codes.includes(code)),
  );
}

/** The system's creation day in the client's time zone: no review held before it has figures (model §3.13 item 1). */
const createdOnOf = (firm: FirmState, review: Review, system: System) =>
  localDate(system.createdAt, timeZoneOf(firm, review.clientId));

/**
 * `since` for an input (model §5.4): per standard of the input, the later of the system's creation day in the client's
 * time zone and the `heldOn` of the last earlier held review covering it; the earliest of those, so the figures leave
 * out nothing a standard has not been reviewed on yet, and never after as-of.
 */
function sinceFor(g: GatherScope): string {
  const createdOn = localDate(g.system.createdAt, g.timeZone);
  const last = g.codes.map((code) =>
    g.earlier
      .filter((r) => r.standards.includes(code))
      .reduce((latest, r) => (r.heldOn! > latest ? r.heldOn! : latest), createdOn),
  );
  const since = [...last].sort()[0]!;
  return since < g.asOf ? since : g.asOf;
}

/** The review's standards that ask for an input: those whose definitions carry its key. */
function inputCodes(firm: FirmState, review: Review, system: System, def: InputDef): Code[] {
  const defs = defsOf(firm, system, review.standards, firm.isoCatalogue.reviewInputDefs);
  return inCodeOrder(clauseRefs(firm, defs, def).map((r) => r.standard));
}

/**
 * `reviewInputFigures` (model §5.4) for one non-MANUAL input, over the review's whole system, between `since` and
 * `asOf`: today in the client's time zone for a PLANNED review, or the `heldOn` that RECORD_HELD stores them for.
 */
function computeFigures(
  firm: FirmState,
  review: Review,
  system: System,
  def: InputDef,
  asOf: string,
  notYet?: ReadonlySet<string>,
): Figures {
  const source = def.source as FigureSource;
  const codes = inputCodes(firm, review, system, def);
  const g: GatherScope = {
    firm,
    review,
    system,
    key: def.key,
    codes,
    asOf,
    timeZone: timeZoneOf(firm, review.clientId),
    earlier: earlierReviews(firm, review, codes, asOf, notYet),
  };
  const data = (GATHER[source] as (g: GatherScope) => Data<FigureSource>)(g);
  return figuresFrom(source, data as never, sinceFor(g) as LocalDate, asOf as LocalDate);
}

/**
 * Stores each live non-MANUAL input's figures as of `heldOn` (model §3.13): at RECORD_HELD, after its guards and while
 * the review is still PLANNED, at `at`. A review held before its system's creation day stores none, since the app held
 * none of its records then. A row that already has figures keeps them. The row's version does not move: notes stay
 * editable with the version read before. Returns the stored figures by input key, for the event.
 */
function storeFigures(
  firm: FirmState,
  review: Review,
  heldOn: string,
  at: string,
  notYet?: ReadonlySet<string>,
): { key: string; figures: Figures }[] {
  const system = systemOf(firm, review);
  if (heldOn < createdOnOf(firm, review, system)) return [];
  const stored: { key: string; figures: Figures }[] = [];
  for (const row of inputsOf(firm, review)) {
    const def = inputDef(firm, row.inputDefId);
    if (def.source === 'MANUAL' || (row.sourceFigures ?? null) !== null) continue;
    const figures = computeFigures(firm, review, system, def, heldOn, notYet);
    row.sourceFigures = figures;
    row.figuresStoredAt = at;
    row.figuresEngineVersion = MOCK_ENGINE_VERSION;
    stored.push({ key: def.key, figures });
  }
  return stored;
}

/**
 * The fixtures' held reviews have no stored figures: the mock stores them when it loads, as RECORD_HELD would have
 * on their `heldOn`, at the time each was recorded held (its `updatedAt`). They are stored in that order, ties by id,
 * and each counts as earlier only the reviews recorded before it, so two held on one day get the same figures on
 * every load whatever their order in the file.
 */
export function storeFixtureFigures(firm: FirmState): void {
  const held = firm.iso.managementReviews
    .filter((r) => HELD.includes(r.state) && r.archivedAt === null)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || (a.id < b.id ? -1 : 1));
  const notYet = new Set(ids(held));
  for (const review of held) {
    notYet.delete(review.id);
    storeFigures(firm, review, review.heldOn!, review.updatedAt, notYet);
  }
}

/** Whether one reader may read the record `id` of `entityType` (null for a score, which names none). */
type Readable = (entityType: EntityType | null, id: string) => boolean;

/** Who may read each record a figure names (plan §3.3), for one reader: `isoVisibleIds` for one table at a time. */
function readableIds(actor: Actor, clientId: string): Readable {
  const firm = actor.firm;
  const tables: Partial<Record<EntityType, Map<string, () => IsoReach>>> = {};
  const add = <K extends IsoTable>(
    entityType: IsoEntity,
    table: K,
    of: (row: IsoRow<K>) => IsoReach,
  ) => {
    const reach = new Map<string, () => IsoReach>();
    for (const row of firm.iso[table] as IsoRow<K>[]) {
      const r = row as { id: string; clientId: string };
      if (r.clientId === clientId) reach.set(r.id, () => of(row));
    }
    tables[entityType] = reach;
  };
  add('management_system', 'managementSystems', (s) =>
    reachOf(firm, { clientId: s.clientId, systemId: s.id }),
  );
  add('context_item', 'contextItems', (c) => systemReach(firm, c));
  add('risk_item', 'riskItems', (i) => riskReach(firm, i));
  add('objective', 'objectives', (o) => objectiveReach(firm, o));
  add('objective_reading', 'readings', (r) =>
    objectiveReach(firm, parentOf(firm, 'objectives', r.objectiveId)),
  );
  add('internal_audit', 'internalAudits', (a) => auditReach(firm, a));
  add('external_audit', 'externalAudits', (e) => systemReach(firm, e));
  add('audit_finding', 'findings', (x) => findingReach(firm, x));
  add('nonconformity', 'nonconformities', (n) => ncReach(firm, n));
  add('iso_action', 'actions', (a) => actionReach(firm, a));
  // Instances by unit, as `visibleInstances` reads them, but archived ones too: a stored figure keeps the id of an
  // instance archived since, as it does for an ISO record.
  const memberships = membershipsFor(actor, clientId);
  const allUnits = memberships.some((m) => m.unitIds === null);
  const units = new Set(memberships.flatMap((m) => m.unitIds ?? []));
  const instances = new Set(
    ids(
      firm.data.instances.filter(
        (i) => i.clientId === clientId && (allUnits || units.has(i.unitId)),
      ),
    ),
  );
  // An id is readable only as a row of the client in its figure's table, so a wrong table reads as nothing.
  return (entityType, id) => {
    if (entityType === 'instance') return instances.has(id);
    const of = entityType === null ? undefined : tables[entityType]?.get(id);
    return of !== undefined && canSee(actor, of());
  };
}

/**
 * The figures as one reader gets them: every value as counted, each figure's ids cut to those they may read in the
 * table `REVIEW_FIGURE_KEYS` names for it (none for a key it does not list). `cut` says whether any id was dropped.
 */
function forReader(figures: Figures, readable: Readable): { figures: Figures; cut: boolean } {
  const keys: Record<string, ReviewFigureKeyInfo> =
    figures.source === 'MANUAL' ? {} : REVIEW_FIGURE_KEYS[figures.source];
  let cut = false;
  const shown = figures.figures.map((fig) => {
    const entityType = keys[fig.key]?.entityType ?? null;
    const ids = fig.ids.filter((id) => readable(entityType, id));
    cut ||= ids.length < fig.ids.length;
    return { ...fig, ids };
  });
  return { figures: { ...figures, figures: shown }, cut };
}

/**
 * An input's figures and notes by its review's state (model §3.13): computed as of the client's today while PLANNED,
 * the stored copy once HELD or CLOSED (null for a row without one), none for a CANCELLED review or a MANUAL input.
 * Incidents are the limit (item 4): an INCIDENTS row whose ids the reader may not all read is withheld, figures and
 * notes, unless the reader chairs or attends the review. It reads the incidents the row counts, not the system's units,
 * which can be narrowed after an incident was counted.
 */
function figuresOf(
  actor: Actor,
  review: Review,
  row: Input,
  def: InputDef,
  ctx: { now: string; readable: Readable },
): Pick<InputOut, 'sourceFigures' | 'figuresStoredAt' | 'figuresWithheld' | 'notes'> {
  const none = {
    sourceFigures: null,
    figuresStoredAt: null,
    figuresWithheld: false,
    notes: row.notes,
  };
  if (def.source === 'MANUAL' || review.state === 'CANCELLED') return none;
  let shown: { sourceFigures: Figures; figuresStoredAt: string | null };
  if (review.state === 'PLANNED') {
    const today = localDate(ctx.now, timeZoneOf(actor.firm, review.clientId));
    shown = {
      sourceFigures: computeFigures(actor.firm, review, systemOf(actor.firm, review), def, today),
      figuresStoredAt: null,
    };
  } else {
    const stored = row.sourceFigures ?? null;
    if (stored === null) return none;
    shown = { sourceFigures: stored, figuresStoredAt: row.figuresStoredAt ?? null };
  }
  const { figures, cut } = forReader(shown.sourceFigures, ctx.readable);
  const takesPart =
    review.chairId === actor.person.id || review.attendeeIds.includes(actor.person.id);
  if (def.source === 'INCIDENTS' && cut && !takesPart) {
    return { ...none, figuresWithheld: true, notes: null };
  }
  return { ...none, sourceFigures: figures, figuresStoredAt: shown.figuresStoredAt };
}

// ---------- views ----------

function reviewView(actor: Actor, review: Review): ReviewOut {
  const reach = reviewReach(actor.firm, review);
  const writes = writesReview(actor, review, reach);
  const allowedActions: ReviewOut['allowedActions'] = [];
  if (review.state === 'PLANNED') {
    if (plansReview(actor, review, reach)) allowedActions.push('CANCEL');
    if (writes) allowedActions.push('RECORD_HELD');
  }
  if (review.state === 'HELD' && writes) allowedActions.push('CLOSE');
  return { ...review, allowedActions };
}

function inputView(
  actor: Actor,
  review: Review,
  system: System,
  input: Input,
  ctx: { now: string; readable: Readable },
): InputOut {
  const firm = actor.firm;
  const def = inputDef(firm, input.inputDefId);
  const defs = defsOf(firm, system, review.standards, firm.isoCatalogue.reviewInputDefs);
  // The engine version stays on the row: the pack and the archive print it (model §9).
  const row: Input = { ...input };
  delete row.figuresEngineVersion;
  return {
    ...row,
    key: def.key,
    title: def.title,
    source: def.source,
    clauseRefs: clauseRefs(firm, defs, def),
    ...figuresOf(actor, review, input, def, ctx),
  };
}

function outputView(firm: FirmState, review: Review, system: System, output: Output): OutputOut {
  const def = outputDef(firm, output.outputDefId);
  const defs = defsOf(firm, system, review.standards, firm.isoCatalogue.reviewOutputDefs);
  return { ...output, key: def.key, title: def.title, clauseRefs: clauseRefs(firm, defs, def) };
}

// ---------- checks and writes ----------

/** A review's standards are standards of its management system. */
function checkStandards(firm: FirmState, system: System, standards: readonly Code[]): void {
  const covered = systemStandards(firm, system);
  if (standards.some((code) => !covered.has(code))) {
    invalid('standards', 'Not a standard of this management system');
  }
}

/** The chair and attendees work in the client (model §1.5); a review has no unit of its own. */
function checkReviewPeople(
  actor: Actor,
  clientId: string,
  people: { chairId?: string; attendeeIds?: readonly string[] },
): void {
  if (people.chairId !== undefined) checkIsoPerson(actor, clientId, people.chairId, 'chairId');
  for (const id of people.attendeeIds ?? []) checkIsoPerson(actor, clientId, id, 'attendeeIds');
}

/** Applies an arrow of the review machine (model §4.5) and audits it as a TRANSITION naming the action. */
function moveReview(
  ctx: IsoCtx,
  actor: Actor,
  review: Review,
  action: 'CANCEL' | 'RECORD_HELD' | 'CLOSE',
  change: Partial<Review>,
  options: { reason?: string; delegated: boolean; after?: Record<string, unknown> },
): void {
  const keys = Object.keys(change) as (keyof Review)[];
  const before = Object.fromEntries(keys.map((k) => [k, review[k]]));
  Object.assign(review, change);
  touchIso(ctx, review);
  isoAudit(ctx, actor, {
    action: 'TRANSITION',
    entityType: 'management_review',
    entityId: review.id,
    clientId: review.clientId,
    before,
    after: { action, ...change, ...options.after },
    reason: options.reason ?? null,
    ...(options.delegated ? { delegated: true } : {}),
  });
}

/**
 * Checks and saves a review edit, one audit event per EDIT_GROUPS group: the date and chair with `reason`, the rest
 * (with the input and output rows that follow new standards) as UPDATE. An edit that changes nothing writes nothing.
 */
function saveReviewEdit(
  ctx: IsoCtx,
  actor: Actor,
  review: Review,
  fields: Partial<Pick<Review, 'standards' | 'plannedOn' | 'chairId' | 'attendeeIds' | 'minutes'>>,
  reason: string | null,
): ReviewOut {
  checkReviewPeople(actor, review.clientId, fields);
  if (review.state === 'HELD' && fields.attendeeIds?.length === 0) {
    invalid('attendeeIds', 'A held review keeps the people who attended it');
  }
  const defined = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as Partial<Review>;
  const changed = (Object.keys(defined) as (keyof Review)[]).filter(
    (k) => JSON.stringify(review[k]) !== JSON.stringify(defined[k]),
  );
  if (changed.length === 0) return reviewView(actor, review);
  const before = Object.fromEntries(changed.map((k) => [k, review[k]]));
  Object.assign(review, defined);
  touchIso(ctx, review);
  const rows = changed.includes('standards')
    ? syncRows(ctx, actor, review, systemOf(actor.firm, review))
    : {};
  for (const [action, keys] of EDIT_GROUPS) {
    const inGroup = changed.filter((k) => keys.includes(k));
    if (inGroup.length === 0) continue;
    isoAudit(ctx, actor, {
      action,
      entityType: 'management_review',
      entityId: review.id,
      clientId: review.clientId,
      before: Object.fromEntries(inGroup.map((k) => [k, before[k]])),
      after: {
        ...Object.fromEntries(inGroup.map((k) => [k, review[k]])),
        ...(action === 'UPDATE' ? rows : {}),
      },
      reason: action === 'UPDATE' ? null : reason,
    });
  }
  return reviewView(actor, review);
}

/** Notes, decisions and edits are taken until the review is CLOSED or CANCELLED (model §1.8). */
function requireNotFinal(review: Review): void {
  if (FINAL.includes(review.state)) invalidTransition('management_review', review.state, 'UPDATE');
}

/** A row of `review` from `table`, or 404 (another review's row included). */
function requireRow<K extends 'reviewInputs' | 'reviewOutputs'>(
  firm: FirmState,
  table: K,
  review: Review,
  id: string | undefined,
): IsoRow<K> {
  const row = requireIso(firm, table, review.clientId, id!);
  if ((row as { managementReviewId: string }).managementReviewId !== review.id) throw notFound();
  return row;
}

// ---------- files (model §6) ----------

/** A file's subject as the file rules read it (model §6, plan §3.2-3.3). */
interface Subject extends SubjectRef {
  clientId: string;
  /** The subject's units (a child record takes its parent's) and the people it names. */
  reach: IsoReach;
  /** Readable by every member of the client: the current revision of an active document (model §4.2, §6). */
  clientWide: boolean;
  /**
   * The subject's own write action (plan §3.2): the manager roles it grants, and the people its "own" names for the
   * owner role and for the approver role.
   */
  write: {
    action: string;
    managers: readonly Role[];
    owners: readonly (string | null)[];
    approvers: readonly (string | null)[];
  };
  /** Why files can no longer be added or removed (model §6): the locked record and its state; null while open. */
  lock: { entity: IsoEntity; from: string } | null;
  /** For an incident and its actions: who besides FA, CO and CA may download (model §6); null for anyone who reads. */
  downloaders: readonly string[] | null;
}

const writer = (
  action: string,
  owners: readonly (string | null)[] = [],
  approvers: readonly (string | null)[] = [],
  managers: readonly Role[] = MANAGERS,
): Subject['write'] => ({ action, managers, owners, approvers });

const lockedIn = (states: readonly string[], entity: IsoEntity, state: string): Subject['lock'] =>
  states.includes(state) ? { entity, from: state } : null;

const NC_LOCKED = ['CLOSED', 'CANCELLED'];
const INTERNAL_AUDIT_LOCKED = ['REPORTED', 'CLOSED', 'CANCELLED'];
const EXTERNAL_AUDIT_LOCKED = ['CLOSED', 'CANCELLED'];

/** The people who may download an incident's files besides FA, CO and CA (model §6). */
const incidentDownloaders = (nc: Nc | null) =>
  nc?.incident == null ? null : [nc.ownerId, nc.approverId, ...nc.incident.investigatorIds];

/** An internal audit's lead and auditors: "own" for `isoAudit.conduct` (plan §3.2). */
const auditTeam = (audit: Audit) => [audit.leadAuditorId, ...audit.auditorIds];

/** The subject of a file or file request, live in this client, or 404. */
function resolveSubject(firm: FirmState, clientId: string, ref: SubjectRef): Subject {
  const base = { ...ref, clientId, clientWide: false, lock: null, downloaders: null };
  switch (ref.type) {
    case 'clause_assessment': {
      const row = requireIso(firm, 'clauseAssessments', clientId, ref.id);
      return {
        ...base,
        reach: systemReach(firm, row, [row.ownerId]),
        write: writer('isoChecklist.write', [row.ownerId]),
      };
    }
    case 'document_revision': {
      const revision = requireIso(firm, 'revisions', clientId, ref.id);
      const doc = requireIso(firm, 'documents', clientId, revision.documentId);
      return {
        ...base,
        reach: systemReach(firm, doc, [doc.ownerId, doc.approverId]),
        clientWide: doc.status === 'ACTIVE' && doc.currentRevisionId === revision.id,
        write: writer('isoDocument.write', [doc.ownerId]),
        lock:
          revision.state !== 'DRAFT'
            ? { entity: 'document_revision', from: revision.state }
            : lockedIn(['OBSOLETE'], 'controlled_document', doc.status),
      };
    }
    case 'risk_item': {
      const item = requireIso(firm, 'riskItems', clientId, ref.id);
      return {
        ...base,
        reach: riskReach(firm, item),
        write: writer('isoRisk.write', [item.ownerId]),
      };
    }
    case 'objective_reading': {
      const reading = requireIso(firm, 'readings', clientId, ref.id);
      const objective = requireIso(firm, 'objectives', clientId, reading.objectiveId);
      return {
        ...base,
        reach: objectiveReach(firm, objective),
        write: writer('isoObjective.write', [objective.ownerId]),
        lock: objective.closedOn === null ? null : { entity: 'objective', from: 'CLOSED' },
      };
    }
    case 'internal_audit': {
      const audit = requireIso(firm, 'internalAudits', clientId, ref.id);
      return {
        ...base,
        reach: auditReach(firm, audit),
        write: writer('isoAudit.conduct', auditTeam(audit), auditTeam(audit)),
        lock: lockedIn(INTERNAL_AUDIT_LOCKED, 'internal_audit', audit.state),
      };
    }
    case 'audit_finding': {
      const finding = requireIso(firm, 'findings', clientId, ref.id);
      if (finding.internalAuditId !== null) {
        const audit = parentOf(firm, 'internalAudits', finding.internalAuditId);
        return {
          ...base,
          reach: auditReach(firm, audit),
          write: writer('isoAudit.conduct', auditTeam(audit), auditTeam(audit)),
          lock: lockedIn(INTERNAL_AUDIT_LOCKED, 'internal_audit', audit.state),
        };
      }
      const external = parentOf(firm, 'externalAudits', finding.externalAuditId!);
      return {
        ...base,
        reach: systemReach(firm, external),
        write: writer('isoCertification.write'),
        lock: lockedIn(EXTERNAL_AUDIT_LOCKED, 'external_audit', external.state),
      };
    }
    case 'external_audit': {
      const external = requireIso(firm, 'externalAudits', clientId, ref.id);
      return {
        ...base,
        reach: systemReach(firm, external),
        write: writer('isoCertification.write'),
        lock: lockedIn(EXTERNAL_AUDIT_LOCKED, 'external_audit', external.state),
      };
    }
    case 'certification': {
      const cert = requireIso(firm, 'certifications', clientId, ref.id);
      return {
        ...base,
        reach: reachOf(firm, {
          clientId,
          unitIds: cert.unitIds,
          systemId: cert.managementSystemId,
        }),
        write: writer('isoCertification.write'),
      };
    }
    case 'nonconformity': {
      const nc = requireIso(firm, 'nonconformities', clientId, ref.id);
      return {
        ...base,
        reach: ncReach(firm, nc),
        write: writer('isoNc.work', [nc.ownerId], [], ['CLIENT_ADMIN']),
        lock: lockedIn(NC_LOCKED, 'nonconformity', nc.state),
        downloaders: incidentDownloaders(nc),
      };
    }
    case 'iso_action': {
      const action = requireIso(firm, 'actions', clientId, ref.id);
      const parent = actionParent(firm, action);
      return {
        ...base,
        reach: actionReach(firm, action),
        write: writer('isoAction.write', [parent.ownerId, action.ownerId]),
        lock:
          action.state !== 'OPEN'
            ? { entity: 'iso_action', from: action.state }
            : parent.nc === null
              ? null
              : lockedIn(NC_LOCKED, 'nonconformity', parent.nc.state),
        downloaders: incidentDownloaders(parent.nc),
      };
    }
    case 'management_review': {
      const review = requireIso(firm, 'managementReviews', clientId, ref.id);
      return {
        ...base,
        reach: reviewReach(firm, review),
        write: writer('isoReview.write', [review.chairId], [review.chairId]),
        lock: lockedIn(FINAL, 'management_review', review.state),
      };
    }
  }
}

/** The subject column that is set on a stored file (exactly one is, model §1.4). */
function subjectOfFile(file: FileRow): SubjectRef {
  const type = IsoFileSubjectType.options.find((t) => file[ISO_FILE_SUBJECT_COLUMNS[t]] !== null)!;
  return { type, id: file[ISO_FILE_SUBJECT_COLUMNS[type]]! };
}

function fileView(file: FileRow): FileOut {
  return {
    id: file.id,
    firmId: file.firmId,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    archivedAt: file.archivedAt,
    clientId: file.clientId,
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    scanStatus: file.scanStatus,
    uploadedById: file.uploadedById,
    uploadedAt: file.uploadedAt,
    removeReason: file.removeReason,
    subject: subjectOfFile(file),
  };
}

/** Who reads the subject reads its file list (unit scope, plan §3.3); the current revision of a document, everyone. */
const readScope = (actor: Actor, subject: Subject): Scope =>
  subject.clientWide ? { clientId: subject.clientId } : isoScope(actor, subject.reach);

/**
 * `isoFile.write` is "whoever may write the subject" (plan §3.2): the role check runs with the actor as the record's
 * owner or approver where the subject's own write action names them as "own"; then a manager role the subject's action
 * does not grant (FA and CO on a nonconformity) is refused, and a locked subject answers 409 (model §6).
 */
function authorizeWrite(
  ctx: { authorize(scope: Scope): void },
  actor: Actor,
  subject: Subject,
): void {
  const me = actor.person.id;
  const asOwner =
    subject.write.owners.includes(me) && holdsRole(actor, subject.clientId, ['OWNER']);
  const asApprover =
    subject.write.approvers.includes(me) && holdsRole(actor, subject.clientId, ['APPROVER']);
  ctx.authorize(
    isoScope(actor, subject.reach, {
      ownerId: asOwner ? me : null,
      approverId: asApprover ? me : null,
    }),
  );
  const manager = holdsRole(
    actor,
    subject.clientId,
    subject.write.managers,
    unitsFor(actor, subject.reach),
  );
  if (!manager && !asOwner && !asApprover) {
    forbidden(subject.write.action, `Not allowed: ${subject.write.action}`);
  }
  if (subject.lock !== null) invalidTransition(subject.lock.entity, subject.lock.from, 'UPDATE');
}

/** When a presigned URL issued now expires. */
const expiresAt = (clock: Clock) =>
  new Date(Date.parse(clock.now()) + SIGNED_URL_TTL_SECONDS * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

// ---------- handlers ----------

export const reviewsHandlers: PartialHandlers<Ids> = {
  /** By planned date, then creation. AP and OW see reviews of systems over their units and those naming them. */
  listIsoManagementReviews(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const firm = actor.firm;
    const q = ctx.query;
    const rows = liveIso(firm, 'managementReviews', clientId)
      .filter(
        (r) =>
          (q.managementSystemId === undefined ||
            q.managementSystemId.includes(r.managementSystemId)) &&
          (q.state === undefined || q.state.includes(r.state)) &&
          (q.from === undefined || r.plannedOn >= q.from) &&
          (q.to === undefined || r.plannedOn <= q.to) &&
          matches(q.q, r.minutes, r.cancelReason, systemOf(firm, r).name) &&
          canSee(actor, reviewReach(firm, r)),
      )
      .sort((a, b) => a.plannedOn.localeCompare(b.plannedOn) || byCreation(a, b));
    return paginate(
      rows.map((r) => reviewView(actor, r)),
      q,
    );
  },

  /**
   * PLAN (client admin; an account admin or consultant as delegate): a review of some of its system's standards, with
   * one input row per input key and one output row per output key of those standards.
   */
  planIsoManagementReview(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    const firm = actor.firm;
    const body = ctx.body;
    const system = requireSystem(firm, clientId, body.managementSystemId);
    ctx.authorize(isoScope(actor, reachOf(firm, { clientId, systemId: system.id })));
    checkStandards(firm, system, body.standards);
    checkReviewPeople(actor, clientId, body);
    const review: Review = {
      ...isoFresh(ctx, actor, clientId),
      managementSystemId: system.id,
      standards: inCodeOrder(body.standards),
      plannedOn: body.plannedOn,
      heldOn: null,
      chairId: body.chairId,
      attendeeIds: body.attendeeIds,
      minutes: null,
      state: 'PLANNED',
      cancelReason: null,
    };
    firm.iso.managementReviews.push(review);
    const rows = syncRows(ctx, actor, review, system);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'management_review',
      entityId: review.id,
      clientId,
      after: {
        managementSystemId: system.id,
        standards: review.standards,
        plannedOn: review.plannedOn,
        chairId: review.chairId,
        attendeeIds: review.attendeeIds,
        state: review.state,
        inputKeys: rows.inputKeysAdded,
        outputKeys: rows.outputKeysAdded,
      },
      ...(isClientAdmin(actor, clientId) ? {} : { delegated: true }),
    });
    return reviewView(actor, review);
  },

  getIsoManagementReview(ctx) {
    const actor = actorOf(ctx);
    const review = requireReview(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, reviewReach(actor.firm, review)));
    return reviewView(actor, review);
  },

  /** Until CLOSED or CANCELLED: attendees and minutes (`isoReview.write`: a manager or the chair), audited as UPDATE. */
  updateIsoManagementReview(ctx) {
    const actor = actorOf(ctx);
    const review = requireReview(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(selfScope(actor, reviewReach(actor.firm, review), [review.chairId]));
    const { version, ...fields } = ctx.body;
    checkIsoVersion(review, version);
    requireNotFinal(review);
    return saveReviewEdit(ctx, actor, review, fields, null);
  },

  /**
   * `isoReview.plan` (FA, CO, CA) while PLANNED: standards, date and chair. Changing the standards adds and archives
   * input and output rows to match; a new date is a due-date change and a new chair a reassignment, with the reason.
   */
  replanIsoManagementReview(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const review = requireReview(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, reviewReach(firm, review)));
    const { version, reason, ...body } = ctx.body;
    checkIsoVersion(review, version);
    if (review.state !== 'PLANNED') invalidTransition('management_review', review.state, 'UPDATE');
    const fields = {
      ...body,
      ...(body.standards === undefined ? {} : { standards: inCodeOrder(body.standards) }),
    };
    if (fields.standards !== undefined) {
      checkStandards(firm, systemOf(firm, review), fields.standards);
    }
    return saveReviewEdit(ctx, actor, review, fields, reason ?? null);
  },

  /** CANCEL (client admin; an account admin or consultant as delegate): PLANNED → CANCELLED, with a reason. */
  cancelIsoManagementReview(ctx) {
    const actor = actorOf(ctx);
    const review = requireReview(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, reviewReach(actor.firm, review)));
    checkIsoVersion(review, ctx.body.version);
    if (review.state !== 'PLANNED') {
      invalidTransition('management_review', review.state, 'CANCEL');
    }
    moveReview(
      ctx,
      actor,
      review,
      'CANCEL',
      { state: 'CANCELLED', cancelReason: ctx.body.reason },
      { reason: ctx.body.reason, delegated: !isClientAdmin(actor, review.clientId) },
    );
    return reviewView(actor, review);
  },

  /**
   * RECORD_HELD (chair or client admin; an account admin or consultant as delegate): PLANNED → HELD, on a day not after
   * today, with at least one attendee and notes on every input row.
   */
  recordIsoManagementReviewHeld(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const review = requireReview(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(selfScope(actor, reviewReach(firm, review), [review.chairId]));
    const body = ctx.body;
    checkIsoVersion(review, body.version);
    if (review.state !== 'PLANNED') {
      invalidTransition('management_review', review.state, 'RECORD_HELD');
    }
    // The client's today, as for a PLANNED review's figures: the stored ones never count a day not yet begun there.
    const today = localDate(ctx.clock.now(), timeZoneOf(firm, review.clientId));
    if (body.heldOn > today) invalid('heldOn', 'The review date is after today');
    checkReviewPeople(actor, review.clientId, { attendeeIds: body.attendeeIds });
    const attendeeIds = body.attendeeIds ?? review.attendeeIds;
    if (attendeeIds.length === 0) invalid('attendeeIds', 'Name the people who attended');
    const missing = inputsOf(firm, review)
      .filter((row) => row.notes === null)
      .map((row) => inputDef(firm, row.inputDefId).key);
    if (missing.length > 0) {
      invalid('inputs', `Add notes to every input first; missing: ${missing.join(', ')}`);
    }
    // Model §3.13: the figures are stored once, here, counted up to heldOn over the whole system.
    const stored = storeFigures(firm, review, body.heldOn, ctx.clock.now());
    moveReview(
      ctx,
      actor,
      review,
      'RECORD_HELD',
      {
        state: 'HELD',
        heldOn: body.heldOn,
        ...(body.attendeeIds === undefined ? {} : { attendeeIds }),
        ...(body.minutes === undefined ? {} : { minutes: body.minutes }),
      },
      {
        delegated: delegatedChairStep(actor, review),
        // Model §8: the values of each stored input and the engine version, without ids (they stay on the rows).
        after: {
          figures: stored.map(({ key, figures }) => ({
            key,
            source: figures.source,
            since: figures.since,
            asOf: figures.asOf,
            values: Object.fromEntries(figures.figures.map((fig) => [fig.key, fig.value])),
          })),
          engineVersion: MOCK_ENGINE_VERSION,
        },
      },
    );
    return reviewView(actor, review);
  },

  /**
   * CLOSE (chair or client admin; an account admin or consultant as delegate): HELD → CLOSED once every output row has
   * a decision and every review action is DONE or CANCELLED.
   */
  closeIsoManagementReview(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const review = requireReview(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(selfScope(actor, reviewReach(firm, review), [review.chairId]));
    checkIsoVersion(review, ctx.body.version);
    if (review.state !== 'HELD') invalidTransition('management_review', review.state, 'CLOSE');
    const missing = outputsOf(firm, review)
      .filter((row) => row.decision === null)
      .map((row) => outputDef(firm, row.outputDefId).key);
    if (missing.length > 0) {
      invalid('outputs', `Record a decision on every output first; missing: ${missing.join(', ')}`);
    }
    const open = liveIso(firm, 'actions', review.clientId).filter(
      (a) =>
        a.subject.type === 'MANAGEMENT_REVIEW' && a.subject.id === review.id && a.state === 'OPEN',
    );
    if (open.length > 0) {
      invalid(
        'actions',
        `Every review action is DONE or CANCELLED first; ${open.length} still OPEN`,
      );
    }
    moveReview(
      ctx,
      actor,
      review,
      'CLOSE',
      { state: 'CLOSED' },
      { delegated: delegatedChairStep(actor, review) },
    );
    return reviewView(actor, review);
  },

  /** In key order, each with its clause references and its source's figures. Whoever reads the review reads them. */
  listIsoReviewInputs(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const review = requireReview(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, reviewReach(firm, review)));
    const system = systemOf(firm, review);
    const view = { now: ctx.clock.now(), readable: readableIds(actor, review.clientId) };
    return {
      items: inputsOf(firm, review).map((row) => inputView(actor, review, system, row, view)),
    };
  },

  /** Notes on one input until the review is CLOSED or CANCELLED; a held review keeps notes on every input. */
  updateIsoReviewInput(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const review = requireReview(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(selfScope(actor, reviewReach(firm, review), [review.chairId]));
    const row = requireRow(firm, 'reviewInputs', review, ctx.params.inputId);
    const { version, notes } = ctx.body;
    checkIsoVersion(row, version);
    requireNotFinal(review);
    if (review.state === 'HELD' && notes === null) {
      invalid('notes', 'A held review keeps notes on every input');
    }
    if (row.notes !== notes) {
      const key = inputDef(firm, row.inputDefId).key;
      const before = row.notes;
      row.notes = notes;
      touchIso(ctx, row);
      isoAudit(ctx, actor, {
        action: 'UPDATE',
        entityType: 'management_review',
        entityId: review.id,
        clientId: review.clientId,
        before: { input: key, notes: before },
        after: { input: key, notes },
      });
    }
    return inputView(actor, review, systemOf(firm, review), row, {
      now: ctx.clock.now(),
      readable: readableIds(actor, review.clientId),
    });
  },

  /** In key order, each with its clause references. Whoever reads the review reads them. */
  listIsoReviewOutputs(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const review = requireReview(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, reviewReach(firm, review)));
    const system = systemOf(firm, review);
    return { items: outputsOf(firm, review).map((row) => outputView(firm, review, system, row)) };
  },

  /** The decision on one output, until the review is CLOSED or CANCELLED. */
  updateIsoReviewOutput(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const review = requireReview(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(selfScope(actor, reviewReach(firm, review), [review.chairId]));
    const row = requireRow(firm, 'reviewOutputs', review, ctx.params.outputId);
    const { version, decision } = ctx.body;
    checkIsoVersion(row, version);
    requireNotFinal(review);
    if (row.decision !== decision) {
      const key = outputDef(firm, row.outputDefId).key;
      const before = row.decision;
      row.decision = decision;
      touchIso(ctx, row);
      isoAudit(ctx, actor, {
        action: 'UPDATE',
        entityType: 'management_review',
        entityId: review.id,
        clientId: review.clientId,
        before: { output: key, decision: before },
        after: { output: key, decision },
      });
    }
    return outputView(firm, review, systemOf(firm, review), row);
  },

  /** A 5-minute presigned PUT for one file on an open subject the actor may write. Writes no audit event. */
  isoFileUploadUrl(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    const body = ctx.body;
    const subject = resolveSubject(actor.firm, clientId, body.subject);
    authorizeWrite(ctx, actor, subject);
    const uploadId = ctx.store.newId();
    actor.firm.pendingIsoUploads.set(uploadId, {
      clientId,
      subject: { type: subject.type, id: subject.id },
      fileName: body.fileName,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      createdById: actor.person.id,
    });
    return {
      uploadId,
      url: fileUrl(`uploads/${uploadId}`),
      headers: { 'content-type': body.mimeType },
      expiresAt: expiresAt(ctx.clock),
    };
  },

  /**
   * Confirms the actor's own upload ticket for the same subject: the file is PENDING until scanned. Audited as
   * EVIDENCE_ADD on the subject, naming the file id only.
   */
  confirmIsoFile(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const clientId = ctx.params.clientId!;
    const body = ctx.body;
    const subject = resolveSubject(firm, clientId, body.subject);
    authorizeWrite(ctx, actor, subject);
    const upload = firm.pendingIsoUploads.get(body.uploadId);
    if (
      upload === undefined ||
      upload.clientId !== clientId ||
      upload.subject.type !== subject.type ||
      upload.subject.id !== subject.id ||
      upload.createdById !== actor.person.id
    ) {
      invalid('uploadId', 'Unknown upload');
    }
    firm.pendingIsoUploads.delete(body.uploadId);
    const now = ctx.clock.now();
    const firmId = firm.data.firm.id;
    const columns = Object.fromEntries(
      IsoFileSubjectType.options.map((t) => [
        ISO_FILE_SUBJECT_COLUMNS[t],
        t === subject.type ? subject.id : null,
      ]),
    ) as Record<SubjectColumn, string | null>;
    const file: FileRow = {
      id: ctx.store.newId(),
      firmId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      clientId,
      fileName: body.fileName,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      sha256: body.sha256,
      scanStatus: 'PENDING',
      uploadedById: actor.person.id,
      uploadedAt: now,
      removeReason: null,
      ...columns,
      storageKey: `evidence/${firmId}/${clientId}/iso/${subject.type}/${subject.id}/${body.uploadId}`,
    };
    firm.iso.files.push(file);
    firm.scanning.add(file.id);
    isoAudit(ctx, actor, {
      action: 'EVIDENCE_ADD',
      entityType: subject.type,
      entityId: subject.id,
      clientId,
      after: { fileId: file.id },
    });
    return fileView(file);
  },

  /** One subject's files in upload order; removed ones only with `includeRemoved`. Writes no audit event. */
  listIsoFiles(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const clientId = ctx.params.clientId!;
    const q = ctx.query;
    const subject = resolveSubject(firm, clientId, { type: q.subjectType, id: q.subjectId });
    ctx.authorize(readScope(actor, subject));
    finishIsoScans(firm);
    const column = ISO_FILE_SUBJECT_COLUMNS[subject.type];
    const items = firm.iso.files
      .filter(
        (f) =>
          f.clientId === clientId &&
          f[column] === subject.id &&
          (q.includeRemoved === true || f.archivedAt === null),
      )
      .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt) || a.id.localeCompare(b.id))
      .map(fileView);
    return { items };
  },

  /**
   * A 5-minute signed GET for a CLEAN file (422 EVIDENCE_NOT_READY otherwise), audited as EVIDENCE_DOWNLOAD on the
   * subject. An incident's files, and its actions' files, only for the people model §6 names (403 for other readers).
   */
  isoFileDownloadUrl(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const clientId = ctx.params.clientId!;
    const file = requireIso(firm, 'files', clientId, ctx.params.id!);
    const subject = resolveSubject(firm, clientId, subjectOfFile(file));
    ctx.authorize(readScope(actor, subject));
    if (
      subject.downloaders !== null &&
      !subject.downloaders.includes(actor.person.id) &&
      !holdsRole(actor, clientId, MANAGERS)
    ) {
      forbidden(
        'isoFile.read',
        "Only the nonconformity's owner, approver and investigators, client admins, consultants and account admins download an incident's files",
      );
    }
    finishIsoScans(firm);
    if (file.scanStatus !== 'CLEAN') {
      throw new MockError('EVIDENCE_NOT_READY', 'This file has not passed the virus scan', {
        scanStatus: file.scanStatus,
      });
    }
    isoAudit(ctx, actor, {
      action: 'EVIDENCE_DOWNLOAD',
      entityType: subject.type,
      entityId: subject.id,
      clientId,
      after: { fileId: file.id },
    });
    return { url: fileUrl(`iso/${file.id}`), expiresAt: expiresAt(ctx.clock) };
  },

  /** Archives a file of an open subject with a reason (never deletes); audited as EVIDENCE_REMOVE on the subject. */
  removeIsoFile(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const clientId = ctx.params.clientId!;
    const file = requireIso(firm, 'files', clientId, ctx.params.id!);
    const subject = resolveSubject(firm, clientId, subjectOfFile(file));
    authorizeWrite(ctx, actor, subject);
    const now = ctx.clock.now();
    file.archivedAt = now;
    file.updatedAt = now;
    file.removeReason = ctx.body.reason;
    isoAudit(ctx, actor, {
      action: 'EVIDENCE_REMOVE',
      entityType: subject.type,
      entityId: subject.id,
      clientId,
      after: { fileId: file.id },
      reason: ctx.body.reason,
    });
    return fileView(file);
  },
};
