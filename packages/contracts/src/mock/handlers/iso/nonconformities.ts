// Mock handlers for the ISO add-on: Nonconformities with incident fields, and ISO actions on every subject (model §3.10-3.12, §4.1).
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
import type { z } from 'zod';
import { ENDPOINTS } from '../../../api/endpoints.js';
import type { IsoActionView, NonconformityView } from '../../../api/iso.js';
import type { Role } from '../../../enums.js';
import { INCIDENT_SOURCES, Nonconformity } from '../../../schemas/iso.js';
import type { NonconformityStatus } from '../../../schemas/iso-results.js';
import {
  type Actor,
  authorize,
  diff,
  matches,
  MockError,
  notFound,
  paginate,
  type Scope,
} from '../../core.js';
import { actorOf, type EndpointId, type PartialHandlers } from '../../handler.js';
import {
  canSee,
  checkIsoPerson,
  checkIsoVersion,
  checkSystemClauses,
  checkSystemUnits,
  daysFrom,
  forbidden,
  invalid,
  invalidTransition,
  type IsoCtx,
  type IsoEntity,
  isoAudit,
  isoFresh,
  type IsoReach,
  isoScope,
  liveIso,
  reachOf,
  requireIso,
  requireSystem,
  standardOf,
  touchIso,
} from '../../iso/common.js';
import { isoTiming } from '../../iso/derive.js';
import type { FirmState, IsoAuditEvent, IsoRow } from '../../store.js';

type Ids =
  | 'listIsoNonconformities'
  | 'raiseIsoNonconformity'
  | 'getIsoNonconformity'
  | 'updateIsoNonconformity'
  | 'reassignIsoNonconformity'
  | 'addIsoNcRootCause'
  | 'planIsoNcActions'
  | 'submitIsoNcNoAction'
  | 'submitIsoNc'
  | 'verifyIsoNcEffective'
  | 'verifyIsoNcNotEffective'
  | 'cancelIsoNc'
  | 'reopenIsoNc'
  | 'listIsoActions'
  | 'createIsoAction'
  | 'getIsoAction'
  | 'updateIsoAction'
  | 'completeIsoAction'
  | 'cancelIsoAction'
  | 'reopenIsoAction';

type Nc = IsoRow<'nonconformities'>;
type Incident = NonNullable<Nc['incident']>;
type Action = IsoRow<'actions'>;
type Risk = IsoRow<'riskItems'>;
type Finding = IsoRow<'findings'>;
type Review = IsoRow<'managementReviews'>;
type NcOut = z.input<typeof NonconformityView>;
type ActionOut = z.input<typeof IsoActionView>;
type NcStep = NcOut['allowedActions'][number];
type ActionStep = ActionOut['allowedActions'][number];
type Issue = { path: string; message: string };

/** States after which a nonconformity is read-only (model §6): REOPEN a CLOSED one first; CANCELLED is final. */
const LOCKED_NC: readonly Nc['state'][] = ['CLOSED', 'CANCELLED'];
/** People who may own a nonconformity or an action: those `isoNc.work` and `isoAction.complete` let act (plan §3.2). */
const OWNER_ROLES: readonly Role[] = ['OWNER', 'CLIENT_ADMIN'];
/** People who may approve a nonconformity: those `isoNc.verify` lets act. */
const APPROVER_ROLES: readonly Role[] = ['APPROVER', 'CLIENT_ADMIN'];
/** States in which `isoNc.reassign` may still change the severity: no later than ROOT_CAUSE_FOUND. */
const SEVERITY_STATES: readonly Nc['state'][] = ['OPEN', 'ROOT_CAUSE_FOUND'];
/** What ADD_ROOT_CAUSE needs (model §4.1; the stored shape also needs the method). */
const ROOT_CAUSE_FIELDS = [
  'containment',
  'correction',
  'rootCauseMethod',
  'rootCause',
  'similarOccurrences',
] as const;
/** Maker steps, and the steps after which the makers no longer count (model §4 preamble). */
const MAKER_STEPS: readonly string[] = [
  'ADD_ROOT_CAUSE',
  'PLAN_ACTIONS',
  'SUBMIT',
  'SUBMIT_NO_ACTION',
];
const CHECKER_RESETS: readonly string[] = ['RAISE', 'REOPEN', 'VERIFY_NOT_EFFECTIVE'];
const INCIDENT_SOURCE_LIST: readonly string[] = INCIDENT_SOURCES;

// ---------- small helpers ----------

/** Whether the endpoints.md role check would let the actor call `id` for `scope`. */
function may(actor: Actor, id: EndpointId, scope: Scope): boolean {
  try {
    authorize(actor, ENDPOINTS[id], scope);
    return true;
  } catch (error) {
    if (error instanceof MockError) return false;
    throw error;
  }
}

/** 400 VALIDATION naming every field a guard found missing or wrong. */
function invalidAll(issues: readonly Issue[]): never {
  throw new MockError('VALIDATION', issues.map((i) => i.message).join('; '), {
    issues: issues.map((i) => ({ path: ['body', ...i.path.split('.')], message: i.message })),
  });
}

/** The fields of a body that are set; null stays (it clears a field). */
function defined<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** `?ownerId=me` is the signed-in person. */
const personRef = (actor: Actor, ref: string | undefined) => (ref === 'me' ? actor.person.id : ref);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The standard codes of a management system's standards. */
const systemCodes = (firm: FirmState, standardIds: readonly string[]) =>
  standardIds.map((id) => standardOf(firm, id)?.code).filter((c) => c !== undefined);

// ---------- nonconformities: reach and lookups ----------

/** People named on a nonconformity, who always see it (plan §3.3): owner, approver and investigators. */
const ncPeople = (nc: Nc) => [nc.ownerId, nc.approverId, ...(nc.incident?.investigatorIds ?? [])];

/** A nonconformity takes its own unit, else its management system's units (plan §3.3). */
const ncReach = (firm: FirmState, nc: Nc): IsoReach =>
  reachOf(firm, {
    clientId: nc.clientId,
    unitId: nc.unitId,
    systemId: nc.managementSystemId,
    people: ncPeople(nc),
  });

const requireNc = (actor: Actor, params: Record<string, string>) =>
  requireIso(actor.firm, 'nonconformities', params.clientId!, params.id!);

/** Live actions on a nonconformity (its corrective actions). */
const actionsOn = (firm: FirmState, nc: Nc) =>
  liveIso(firm, 'actions', nc.clientId).filter(
    (a) => a.subject.type === 'NONCONFORMITY' && a.subject.id === nc.id,
  );

/** The finding that raised the nonconformity; the link is kept only on the finding (model §3.9). */
const findingOf = (firm: FirmState, nc: Nc) =>
  firm.iso.findings.find((f) => f.nonconformityId === nc.id);

const isIncident = (nc: { source: string }) => INCIDENT_SOURCE_LIST.includes(nc.source);

// ---------- nonconformities: history (model §4 preamble, §4.1) ----------

/** The §4.1 step an audit event of a nonconformity records: RAISE is its CREATE, the others TRANSITIONs. */
function stepOf(event: IsoAuditEvent): string | undefined {
  if (event.action === 'CREATE') return 'RAISE';
  if (event.action !== 'TRANSITION') return undefined;
  const step = event.after?.action;
  return typeof step === 'string' ? step : undefined;
}

/** Where in the firm's ISO trail the nonconformity last took one of `steps`, or null. */
function lastStep(
  firm: FirmState,
  nc: Nc,
  steps: readonly string[],
): { index: number; at: string } | null {
  const events = firm.isoAuditEvents;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.entityType !== 'nonconformity' || event.entityId !== nc.id) continue;
    if (steps.includes(stepOf(event) ?? '')) return { index, at: event.at };
  }
  return null;
}

/**
 * Who took a maker step (ADD_ROOT_CAUSE, PLAN_ACTIONS, SUBMIT, SUBMIT_NO_ACTION) since the last RAISE, REOPEN or
 * VERIFY_NOT_EFFECTIVE: none of them verifies it (model §4 preamble).
 */
function makersOf(firm: FirmState, nc: Nc): string[] {
  const start = lastStep(firm, nc, CHECKER_RESETS)?.index ?? -1;
  return firm.isoAuditEvents
    .slice(start + 1)
    .filter(
      (e) =>
        e.entityType === 'nonconformity' &&
        e.entityId === nc.id &&
        MAKER_STEPS.includes(stepOf(e) ?? ''),
    )
    .map((e) => e.actorId)
    .filter((id): id is string => id !== null);
}

/**
 * Whether an action was created after a step: by the order of the trail when its CREATE event is there (mock clocks can
 * pin every instant), else by its `createdAt`.
 */
function createdSince(firm: FirmState, action: Action, step: { index: number; at: string }) {
  const index = firm.isoAuditEvents.findIndex(
    (e) => e.entityType === 'iso_action' && e.entityId === action.id && e.action === 'CREATE',
  );
  return index >= 0 ? index > step.index : action.createdAt > step.at;
}

/** Why SUBMIT_NO_ACTION is refused for this nonconformity (model §4.1), if it is. */
function noActionRefusals(firm: FirmState, nc: Nc): Issue[] {
  const issues: Issue[] = [];
  if (nc.severity === 'MAJOR') {
    issues.push({ path: 'severity', message: 'A MAJOR nonconformity needs corrective actions' });
  }
  if (nc.source === 'EXTERNAL_AUDIT') {
    issues.push({
      path: 'source',
      message: 'A nonconformity from an external audit needs corrective actions',
    });
  }
  const outcome = nc.incident?.outcome;
  if (outcome === 'LOST_TIME' || outcome === 'FATALITY') {
    issues.push({
      path: 'incident.outcome',
      message: `An incident with outcome ${outcome} needs corrective actions`,
    });
  }
  if (nc.effective === false || lastStep(firm, nc, ['VERIFY_NOT_EFFECTIVE']) !== null) {
    issues.push({
      path: 'effective',
      message: 'A nonconformity found not effective needs corrective actions',
    });
  }
  return issues;
}

// ---------- nonconformities: derived values ----------

/**
 * `nonconformityStatus` (model §5.2) as the mock reads it: CLOSED once CLOSED or CANCELLED. Otherwise the earliest of
 * `dueOn` (until the owner submits it) and the due dates of its OPEN actions decides ON_TIME, DUE_SOON or OVERDUE, and
 * the effectiveness check is overdue the day after `effectivenessDueOn`.
 */
function ncStatus(
  nc: Nc,
  actions: readonly Action[],
  today: string,
  dueSoonDays: number,
): z.input<typeof NonconformityStatus> {
  if (LOCKED_NC.includes(nc.state)) {
    return { timing: 'CLOSED', overdueDays: null, effectivenessOverdueDays: null };
  }
  const dates = actions.filter((a) => a.state === 'OPEN').map((a) => a.dueOn);
  if (nc.state !== 'AWAITING_VERIFICATION') dates.push(nc.dueOn);
  const earliest = dates.sort()[0] ?? null;
  const effectivenessLate =
    nc.effectivenessDueOn === null ? 0 : daysFrom(nc.effectivenessDueOn, today);
  return {
    ...isoTiming(earliest, false, today, dueSoonDays),
    effectivenessOverdueDays: effectivenessLate > 0 ? effectivenessLate : null,
  };
}

/**
 * The §4.1 steps the actor may take now: the state, the plan §3.2 roles, the fixed refusals of SUBMIT_NO_ACTION, the
 * maker-checker rule and the effectiveness date. Guards on fields still answer 400 when the step is tried.
 */
function ncSteps(actor: Actor, nc: Nc, reach: IsoReach, today: string): NcStep[] {
  const firm = actor.firm;
  const own = isoScope(actor, reach, { ownerId: nc.ownerId });
  const approves = isoScope(actor, reach, { approverId: nc.approverId });
  const steps: NcStep[] = [];
  if (nc.state === 'OPEN' && may(actor, 'addIsoNcRootCause', own)) steps.push('ADD_ROOT_CAUSE');
  if (nc.state === 'ROOT_CAUSE_FOUND') {
    if (may(actor, 'planIsoNcActions', own)) steps.push('PLAN_ACTIONS');
    if (may(actor, 'submitIsoNcNoAction', own) && noActionRefusals(firm, nc).length === 0) {
      steps.push('SUBMIT_NO_ACTION');
    }
  }
  if (nc.state === 'ACTIONS_PLANNED' && may(actor, 'submitIsoNc', own)) steps.push('SUBMIT');
  if (
    nc.state === 'AWAITING_VERIFICATION' &&
    may(actor, 'verifyIsoNcEffective', approves) &&
    !makersOf(firm, nc).includes(actor.person.id)
  ) {
    if (nc.effectivenessDueOn === null || today >= nc.effectivenessDueOn) {
      steps.push('VERIFY_EFFECTIVE');
    }
    steps.push('VERIFY_NOT_EFFECTIVE');
  }
  if (!LOCKED_NC.includes(nc.state) && may(actor, 'cancelIsoNc', approves)) steps.push('CANCEL');
  if (nc.state === 'CLOSED' && may(actor, 'reopenIsoNc', isoScope(actor, reach))) {
    steps.push('REOPEN');
  }
  return steps;
}

function ncView(ctx: IsoCtx, actor: Actor, nc: Nc): NcOut {
  const firm = actor.firm;
  const today = ctx.clock.today();
  return {
    ...nc,
    status: ncStatus(nc, actionsOn(firm, nc), today, firm.data.firm.settings.dueSoonDays),
    findingId: findingOf(firm, nc)?.id ?? null,
    allowedActions: ncSteps(actor, nc, ncReach(firm, nc), today),
  };
}

// ---------- nonconformities: checks ----------

/** A person named on a nonconformity works in its client and covers its unit, in one of `roles` (model §1.5). */
function checkPerson(
  actor: Actor,
  clientId: string,
  personId: string,
  path: string,
  unitId: string | null,
  roles?: readonly Role[],
): void {
  checkIsoPerson(actor, clientId, personId, path, { unitId, ...(roles ? { roles } : {}) });
}

/** A live register instance of the client (`sourceInstanceId`). */
function checkInstance(firm: FirmState, clientId: string, id: string, path: string) {
  const instance = firm.data.instances.find(
    (i) => i.id === id && i.clientId === clientId && i.archivedAt === null,
  );
  if (instance === undefined) invalid(path, 'Not a live instance of this client');
  return instance;
}

/**
 * `statutoryInstanceId`: a live instance of a STATUTE obligation on the nonconformity's unit (model §3.11). A missing
 * `Act.kind` reads as STATUTE.
 */
function checkStatutoryInstance(
  firm: FirmState,
  clientId: string,
  unitId: string | null,
  id: string,
  path: string,
): void {
  const instance = checkInstance(firm, clientId, id, path);
  if (instance.unitId !== unitId) invalid(path, "Not an instance on the nonconformity's unit");
  const assignment = firm.data.assignments.find((a) => a.id === instance.assignmentId);
  const obligation = firm.data.obligations.find((o) => o.id === assignment?.obligationId);
  const act = firm.data.acts.find((a) => a.id === obligation?.actId);
  if ((act?.kind ?? 'STATUTE') !== 'STATUTE') {
    invalid(path, 'The statutory notice is an instance of a statutory obligation');
  }
}

/** Ids of live rows of `table` in the client; only ids not already linked are checked. */
function checkLinks(
  firm: FirmState,
  table: 'riskItems' | 'documents',
  clientId: string,
  ids: readonly string[],
  already: readonly string[],
  path: string,
): void {
  const live = new Set(liveIso(firm, table, clientId).map((r) => r.id));
  if (ids.some((id) => !already.includes(id) && !live.has(id))) {
    invalid(
      path,
      table === 'riskItems'
        ? 'Not a live risk item of this client'
        : 'Not a live document of this client',
    );
  }
}

/** Standards are the system's; clauses are clauses of those standards (and of the system). */
function checkStandards(
  firm: FirmState,
  system: IsoRow<'managementSystems'>,
  standards: readonly string[],
  clauseIds: readonly string[],
): void {
  const codes = systemCodes(firm, system.standardIds);
  if (standards.some((s) => !codes.includes(s as (typeof codes)[number]))) {
    invalid('standards', 'Not a standard of the management system');
  }
  checkSystemClauses(firm, system, clauseIds, 'clauseIds');
  for (const id of clauseIds) {
    const clause = firm.isoCatalogue.clauses.find((c) => c.id === id)!;
    const code = standardOf(firm, clause.standardId)?.code;
    if (code === undefined || !standards.includes(code)) {
      invalid('clauseIds', "Not a clause of the nonconformity's standards");
    }
  }
}

/** The incident's investigators and statutory notice (model §3.11); `all` rechecks everyone after a unit change. */
function checkIncident(
  actor: Actor,
  clientId: string,
  unitId: string | null,
  incident: Incident,
  before: Incident | null,
  all: boolean,
): void {
  for (const id of incident.investigatorIds) {
    if (all || !(before?.investigatorIds ?? []).includes(id)) {
      checkPerson(actor, clientId, id, 'incident.investigatorIds', unitId);
    }
  }
  const instanceId = incident.statutoryInstanceId;
  if (instanceId !== null && (all || instanceId !== before?.statutoryInstanceId)) {
    checkStatutoryInstance(
      actor.firm,
      clientId,
      unitId,
      instanceId,
      'incident.statutoryInstanceId',
    );
  }
}

/**
 * Checks a nonconformity's fields as `next` would leave them against `nc` (model §1.5, §3.10, §3.11): units, standards
 * and clauses, people (all of them when the unit moves), linked instances, risk items and documents, the disposition
 * (no later than ADD_ROOT_CAUSE), the effectiveness date, and finally every rule of the stored shape.
 */
function checkNcChanges(actor: Actor, nc: Nc, next: Nc, today: string): void {
  const firm = actor.firm;
  const clientId = nc.clientId;
  const changed = (key: keyof Nc) => !same(nc[key], next[key]);
  const system = firm.iso.managementSystems.find((s) => s.id === nc.managementSystemId)!;
  const unitMoved = changed('unitId');
  if (unitMoved && next.unitId !== null) checkSystemUnits(firm, system, [next.unitId], 'unitId');
  if (changed('standards') || changed('clauseIds')) {
    checkStandards(firm, system, next.standards, next.clauseIds);
  }
  if (changed('severity') && findingOf(firm, nc) !== undefined) {
    invalid('severity', "The finding's type sets the severity: change the finding instead");
  }
  if (unitMoved || changed('ownerId')) {
    checkPerson(actor, clientId, next.ownerId, 'ownerId', next.unitId, OWNER_ROLES);
  }
  if (unitMoved || changed('approverId')) {
    checkPerson(actor, clientId, next.approverId, 'approverId', next.unitId, APPROVER_ROLES);
  }
  if (changed('disposition') || changed('dispositionAuthorisedById')) {
    if (nc.state !== 'OPEN') {
      invalid('disposition', 'A disposition is recorded no later than ADD_ROOT_CAUSE');
    }
  }
  if (
    next.dispositionAuthorisedById !== null &&
    (unitMoved || changed('dispositionAuthorisedById'))
  ) {
    checkPerson(
      actor,
      clientId,
      next.dispositionAuthorisedById,
      'dispositionAuthorisedById',
      next.unitId,
    );
  }
  if (changed('sourceInstanceId') && next.sourceInstanceId !== null) {
    checkInstance(firm, clientId, next.sourceInstanceId, 'sourceInstanceId');
  }
  checkLinks(
    firm,
    'riskItems',
    clientId,
    next.relatedRiskItemIds,
    nc.relatedRiskItemIds,
    'relatedRiskItemIds',
  );
  checkLinks(
    firm,
    'riskItems',
    clientId,
    next.updatedRiskItemIds,
    nc.updatedRiskItemIds,
    'updatedRiskItemIds',
  );
  checkLinks(
    firm,
    'documents',
    clientId,
    next.changedDocumentIds,
    nc.changedDocumentIds,
    'changedDocumentIds',
  );
  if (next.incident !== null) {
    checkIncident(actor, clientId, next.unitId, next.incident, nc.incident, unitMoved);
  }
  if (changed('effectivenessDueOn')) {
    if (nc.effectivenessDueOn === null) {
      invalid('effectivenessDueOn', 'PLAN_ACTIONS sets the effectiveness date');
    }
    if (next.effectivenessDueOn === null) {
      invalid('effectivenessDueOn', 'The effectiveness date can be moved, not cleared');
    }
    if (next.effectivenessDueOn < today) {
      invalid('effectivenessDueOn', 'The effectiveness check is due today or later');
    }
  }
  checkStored(next);
}

/** Every rule of the stored nonconformity (owner is not approver, dates, disposition, incident, fields per state). */
function checkStored(next: Nc): void {
  const parsed = Nonconformity.safeParse(next);
  if (!parsed.success) {
    invalidAll(
      parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    );
  }
}

// ---------- nonconformities: writes ----------

/**
 * One §4.1 arrow: applies `change`, bumps the row and audits a TRANSITION naming the step (model §8). `delegated` marks
 * a step a client admin took for the owner or approver (model §4 preamble).
 */
function moveNc(
  ctx: IsoCtx,
  actor: Actor,
  nc: Nc,
  step: NcStep,
  change: Partial<Nc>,
  options: { reason?: string | null; delegated?: boolean } = {},
): void {
  const changes = diff(nc, { ...nc, ...change });
  Object.assign(nc, change);
  touchIso(ctx, nc);
  isoAudit(ctx, actor, {
    action: 'TRANSITION',
    entityType: 'nonconformity',
    entityId: nc.id,
    clientId: nc.clientId,
    before: changes.before,
    after: { action: step, ...changes.after },
    reason: options.reason ?? null,
    ...(options.delegated === true ? { delegated: true } : {}),
  });
}

/** The arrow's from-state, after the version: 409 STALE_VERSION, then 409 INVALID_TRANSITION. */
function checkFrom(nc: Nc, version: number, step: NcStep, from: readonly Nc['state'][]): void {
  checkIsoVersion(nc, version);
  if (!from.includes(nc.state)) invalidTransition('nonconformity', nc.state, step);
}

/** Maker-checker (model §4 preamble): nobody verifies a nonconformity where they took a maker step since its reset. */
function checkChecker(actor: Actor, nc: Nc): void {
  if (makersOf(actor.firm, nc).includes(actor.person.id)) {
    forbidden('isoNc.verify', 'You took a step on this nonconformity, so someone else verifies it');
  }
}

/** A new effectiveness date after VERIFY_NOT_EFFECTIVE or REOPEN is after today (model §4.1). */
function backToChange(
  body: { backTo: 'OPEN' | 'ACTIONS_PLANNED'; effectivenessDueOn?: string },
  today: string,
): Partial<Nc> {
  if (body.backTo === 'OPEN') return { state: 'OPEN', effectivenessDueOn: null };
  if (body.effectivenessDueOn! <= today) {
    invalid('effectivenessDueOn', 'The new effectiveness check is due after today');
  }
  return { state: 'ACTIONS_PLANNED', effectivenessDueOn: body.effectivenessDueOn! };
}

/** Audit groups of a nonconformity edit: people are a reassignment, dates a due-date change (model §8). */
const EDIT_GROUPS: [IsoAuditEvent['action'], (key: string) => boolean][] = [
  ['REASSIGN', (k) => k === 'ownerId' || k === 'approverId'],
  ['DUE_DATE_CHANGE', (k) => k === 'dueOn' || k === 'effectivenessDueOn'],
  ['UPDATE', (k) => !['ownerId', 'approverId', 'dueOn', 'effectivenessDueOn'].includes(k)],
];

const NOT_RECORDED = '[not recorded]';

/**
 * Free text that can name people, the description and an incident's location, is noted as changed and never copied
 * into an audit event (non-negotiable 6), as `raised` leaves it out.
 */
function unrecorded(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (key === 'description') return NOT_RECORDED;
  if (key === 'incident') return { ...(value as Record<string, unknown>), location: NOT_RECORDED };
  return value;
}

/**
 * Checks and saves an edit of the nonconformity's fields, one audit event per EDIT_GROUPS group with `reason`
 * (`isoNc.reassign` always has one); an edit that changes nothing writes nothing.
 */
function saveNcEdit(ctx: IsoCtx, actor: Actor, nc: Nc, next: Nc, reason: string | null): NcOut {
  checkNcChanges(actor, nc, next, ctx.clock.today());
  const changes = diff(nc, next);
  const changed = Object.keys(changes.after);
  if (changed.length === 0) return ncView(ctx, actor, nc);
  Object.assign(nc, next);
  touchIso(ctx, nc);
  for (const [action, belongs] of EDIT_GROUPS) {
    const group = changed.filter(belongs);
    if (group.length === 0) continue;
    isoAudit(ctx, actor, {
      action,
      entityType: 'nonconformity',
      entityId: nc.id,
      clientId: nc.clientId,
      before: Object.fromEntries(group.map((k) => [k, unrecorded(k, changes.before[k])])),
      after: Object.fromEntries(group.map((k) => [k, unrecorded(k, changes.after[k])])),
      reason,
    });
  }
  return ncView(ctx, actor, nc);
}

/** The RAISE event's `after`: no description and no incident detail beyond its kind (model §3.11, §8). */
function raised(nc: Nc): Record<string, unknown> {
  return {
    action: 'RAISE',
    number: nc.number,
    source: nc.source,
    severity: nc.severity,
    standards: nc.standards,
    clauseIds: nc.clauseIds,
    unitId: nc.unitId,
    sourceInstanceId: nc.sourceInstanceId,
    raisedFromRiskItemId: nc.raisedFromRiskItemId,
    ownerId: nc.ownerId,
    approverId: nc.approverId,
    dueOn: nc.dueOn,
    state: nc.state,
    ...(nc.incident === null
      ? {}
      : {
          incident: {
            type: nc.incident.type,
            outcome: nc.incident.outcome,
            reportable: nc.incident.reportable,
          },
        }),
  };
}

// ---------- actions: subjects ----------

/** An action's subject as the action rules read it (model §3.12, plan §3.2-3.3). */
interface Subject {
  entity: IsoEntity;
  systemId: string;
  /** The subject's units and named people; its actions take the same units (plan §3.3). */
  reach: IsoReach;
  /** "own" for `isoAction.write` and `isoAction.cancel`: null when the subject names nobody in that role. */
  ownerId: string | null;
  approverId: string | null;
  /** The unit an action owner must cover, when the subject has one. */
  unitId: string | null;
  /** What closes the subject to new, changed and reopened actions (model §3.12, §6), or null while it is open. */
  lock: { entity: IsoEntity; state: string } | null;
  riskItem?: Risk;
  finding?: Finding;
  review?: Review;
}

/** A row of `table` in the client: live (else 404) for a new action, any for an existing one. */
function subjectRow<
  K extends 'nonconformities' | 'riskItems' | 'objectives' | 'findings' | 'managementReviews',
>(firm: FirmState, table: K, clientId: string, id: string, live: boolean): IsoRow<K> {
  if (live) return requireIso(firm, table, clientId, id);
  const row = (firm.iso[table] as IsoRow<K>[]).find(
    (r) => (r as { id: string }).id === id && (r as { clientId: string }).clientId === clientId,
  );
  if (row === undefined) throw notFound();
  return row;
}

const archivedLock = (entity: IsoEntity, row: { archivedAt: string | null }) =>
  row.archivedAt === null ? null : { entity, state: 'ARCHIVED' };

function subjectOf(
  firm: FirmState,
  clientId: string,
  ref: Action['subject'],
  live: boolean,
): Subject {
  switch (ref.type) {
    case 'NONCONFORMITY': {
      const nc = subjectRow(firm, 'nonconformities', clientId, ref.id, live);
      return {
        entity: 'nonconformity',
        systemId: nc.managementSystemId,
        reach: ncReach(firm, nc),
        ownerId: nc.ownerId,
        approverId: nc.approverId,
        unitId: nc.unitId,
        lock: LOCKED_NC.includes(nc.state)
          ? { entity: 'nonconformity', state: nc.state }
          : archivedLock('nonconformity', nc),
      };
    }
    case 'RISK_ITEM': {
      const item = subjectRow(firm, 'riskItems', clientId, ref.id, live);
      return {
        entity: 'risk_item',
        systemId: item.managementSystemId,
        reach: reachOf(firm, {
          clientId,
          unitId: item.unitId,
          systemId: item.managementSystemId,
          people: [item.ownerId],
        }),
        ownerId: item.ownerId,
        approverId: null,
        unitId: item.unitId,
        lock: archivedLock('risk_item', item),
        riskItem: item,
      };
    }
    case 'OBJECTIVE': {
      const objective = subjectRow(firm, 'objectives', clientId, ref.id, live);
      return {
        entity: 'objective',
        systemId: objective.managementSystemId,
        reach: reachOf(firm, {
          clientId,
          systemId: objective.managementSystemId,
          people: [objective.ownerId],
        }),
        ownerId: objective.ownerId,
        approverId: null,
        unitId: null,
        lock:
          objective.closedOn !== null
            ? { entity: 'objective', state: 'CLOSED' }
            : archivedLock('objective', objective),
      };
    }
    case 'AUDIT_FINDING':
      return findingSubject(firm, subjectRow(firm, 'findings', clientId, ref.id, live));
    case 'MANAGEMENT_REVIEW': {
      const review = subjectRow(firm, 'managementReviews', clientId, ref.id, live);
      const closed = review.state === 'CLOSED' || review.state === 'CANCELLED';
      return {
        entity: 'management_review',
        systemId: review.managementSystemId,
        reach: reachOf(firm, {
          clientId,
          systemId: review.managementSystemId,
          people: [review.chairId, ...review.attendeeIds],
        }),
        ownerId: review.chairId,
        approverId: null,
        unitId: null,
        lock: closed
          ? { entity: 'management_review', state: review.state }
          : archivedLock('management_review', review),
        review,
      };
    }
  }
}

/**
 * A finding takes its audit's units and people (plan §3.3). An internal audit's lead auditor is its owner; an external
 * audit's finding has none. It takes new actions until its audit is CLOSED or CANCELLED (a REPORTED audit's findings
 * still do, model §6).
 */
function findingSubject(firm: FirmState, finding: Finding): Subject {
  const base = {
    entity: 'audit_finding' as const,
    approverId: null,
    unitId: finding.unitId,
    finding,
  };
  const archived = archivedLock('audit_finding', finding);
  if (finding.internalAuditId !== null) {
    const audit = firm.iso.internalAudits.find((a) => a.id === finding.internalAuditId);
    const programme = firm.iso.auditProgrammes.find((p) => p.id === audit?.programmeId);
    if (audit === undefined || programme === undefined) throw notFound();
    const closed = audit.state === 'CLOSED' || audit.state === 'CANCELLED';
    return {
      ...base,
      systemId: programme.managementSystemId,
      reach: reachOf(firm, {
        clientId: audit.clientId,
        unitIds: audit.unitIds,
        systemId: programme.managementSystemId,
        people: [
          audit.leadAuditorId,
          ...audit.auditorIds,
          ...audit.auditeeIds,
          ...audit.reportedToIds,
        ],
      }),
      ownerId: audit.leadAuditorId,
      lock: closed ? { entity: 'internal_audit', state: audit.state } : archived,
    };
  }
  const audit = firm.iso.externalAudits.find((a) => a.id === finding.externalAuditId);
  if (audit === undefined) throw notFound();
  const closed = audit.state === 'CLOSED' || audit.state === 'CANCELLED';
  return {
    ...base,
    systemId: audit.managementSystemId,
    reach: reachOf(firm, { clientId: audit.clientId, systemId: audit.managementSystemId }),
    ownerId: null,
    lock: closed ? { entity: 'external_audit', state: audit.state } : archived,
  };
}

/** An action takes its subject's units; its owner always sees it (plan §3.3). */
const actionReach = (subject: Subject, action: Action): IsoReach => ({
  ...subject.reach,
  people: [...subject.reach.people, action.ownerId],
});

const requireAction = (actor: Actor, params: Record<string, string>) =>
  requireIso(actor.firm, 'actions', params.clientId!, params.id!);

/** 409 INVALID_TRANSITION while the subject is closed to changes of its actions. */
function checkOpenSubject(subject: Subject): void {
  if (subject.lock !== null) invalidTransition(subject.lock.entity, subject.lock.state, 'UPDATE');
}

/** `outputKey` names an output of one of the review's standards (catalogue.md §5). */
function checkOutputKey(firm: FirmState, review: Review, key: string): void {
  const standardIds = firm.isoCatalogue.standards
    .filter((s) => (review.standards as readonly string[]).includes(s.code))
    .map((s) => s.id);
  const known = firm.isoCatalogue.reviewOutputDefs.some(
    (d) => d.key === key && standardIds.includes(d.standardId),
  );
  if (!known) invalid('outputKey', "Not an output of the review's standards");
}

/** `controlHierarchy` and `outputKey` belong to risk items and management reviews (model §3.12). */
function checkSubjectFields(
  firm: FirmState,
  subject: Subject,
  fields: { controlHierarchy?: string | null; outputKey?: string | null },
): void {
  if (fields.controlHierarchy != null && subject.riskItem === undefined) {
    invalid('controlHierarchy', 'Only an action on a risk item has a control hierarchy');
  }
  if (fields.controlHierarchy === null && subject.riskItem?.kind === 'HAZARD') {
    invalid('controlHierarchy', 'A treatment action on a HAZARD names its level of control');
  }
  if (fields.outputKey != null) {
    if (subject.review === undefined) {
      invalid('outputKey', 'Only an action on a management review carries out an output');
    }
    checkOutputKey(firm, subject.review, fields.outputKey);
  }
}

/** The actions on an action the actor may take now: its state, its subject and plan §3.2. */
function actionSteps(actor: Actor, action: Action, subject: Subject): ActionStep[] {
  const reach = actionReach(subject, action);
  const steps: ActionStep[] = [];
  if (action.state === 'OPEN') {
    if (
      subject.lock === null &&
      may(actor, 'completeIsoAction', isoScope(actor, reach, { ownerId: action.ownerId }))
    ) {
      steps.push('COMPLETE');
    }
    if (may(actor, 'cancelIsoAction', isoScope(actor, reach, { approverId: subject.approverId }))) {
      steps.push('CANCEL');
    }
  } else if (subject.lock === null && may(actor, 'reopenIsoAction', isoScope(actor, reach))) {
    steps.push('REOPEN');
  }
  return steps;
}

function actionView(ctx: IsoCtx, actor: Actor, action: Action, subject?: Subject): ActionOut {
  const firm = actor.firm;
  const of = subject ?? subjectOf(firm, action.clientId, action.subject, false);
  return {
    ...action,
    status: isoTiming(
      action.dueOn,
      action.state !== 'OPEN',
      ctx.clock.today(),
      firm.data.firm.settings.dueSoonDays,
    ),
    allowedActions: actionSteps(actor, action, of),
  };
}

/** One action arrow, audited as a TRANSITION naming the step (model §3.12, §8). */
function moveAction(
  ctx: IsoCtx,
  actor: Actor,
  action: Action,
  step: ActionStep,
  change: Partial<Action>,
  options: { reason?: string | null; delegated?: boolean } = {},
): void {
  const changes = diff(action, { ...action, ...change });
  Object.assign(action, change);
  touchIso(ctx, action);
  isoAudit(ctx, actor, {
    action: 'TRANSITION',
    entityType: 'iso_action',
    entityId: action.id,
    clientId: action.clientId,
    before: changes.before,
    after: { action: step, ...changes.after },
    reason: options.reason ?? null,
    ...(options.delegated === true ? { delegated: true } : {}),
  });
}

/**
 * A completed treatment action puts its control in place (model §3.5): a control from it, the item's `reviewDueOn` set
 * to today so its owner re-rates it, and its residual scores cleared when no treatment action is left OPEN.
 */
function putControlInPlace(ctx: IsoCtx, actor: Actor, item: Risk, action: Action): void {
  const firm = actor.firm;
  const control: IsoRow<'riskControls'> = {
    ...isoFresh(ctx, actor, item.clientId),
    riskItemId: item.id,
    text: action.text,
    hierarchy: action.controlHierarchy,
    sourceActionId: action.id,
  };
  firm.iso.riskControls.push(control);
  isoAudit(ctx, actor, {
    action: 'CREATE',
    entityType: 'risk_control',
    entityId: control.id,
    clientId: control.clientId,
    after: { riskItemId: item.id, hierarchy: control.hierarchy, sourceActionId: action.id },
  });
  const openLeft = liveIso(firm, 'actions', item.clientId).some(
    (a) => a.subject.type === 'RISK_ITEM' && a.subject.id === item.id && a.state === 'OPEN',
  );
  const patch: Partial<Risk> = {
    reviewDueOn: ctx.clock.today(),
    ...(openLeft ? {} : { residualLikelihood: null, residualSeverity: null, residualRating: null }),
  };
  const changes = diff(item, { ...item, ...patch });
  const keys = Object.keys(changes.after);
  if (keys.length === 0) return;
  Object.assign(item, patch);
  touchIso(ctx, item);
  for (const [audit, group] of [
    ['DUE_DATE_CHANGE', keys.filter((k) => k === 'reviewDueOn')],
    ['UPDATE', keys.filter((k) => k !== 'reviewDueOn')],
  ] as const) {
    if (group.length === 0) continue;
    isoAudit(ctx, actor, {
      action: audit,
      entityType: 'risk_item',
      entityId: item.id,
      clientId: item.clientId,
      before: Object.fromEntries(group.map((k) => [k, changes.before[k]])),
      after: {
        ...Object.fromEntries(group.map((k) => [k, changes.after[k]])),
        sourceActionId: action.id,
      },
    });
  }
}

// ---------- handlers ----------

export const nonconformitiesHandlers: PartialHandlers<Ids> = {
  /**
   * Newest first (`reportedOn`, then number). AP and OW see their units' nonconformities and those naming them as
   * owner, approver or investigator (plan §3.3).
   */
  listIsoNonconformities(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const q = ctx.query;
    const today = ctx.clock.today();
    const dueSoonDays = firm.data.firm.settings.dueSoonDays;
    const ownerId = personRef(actor, q.ownerId);
    const approverId = personRef(actor, q.approverId);
    const inList = <T>(list: readonly T[] | undefined, value: T) =>
      list === undefined || list.includes(value);
    const rows = liveIso(firm, 'nonconformities', clientId)
      .filter(
        (n) =>
          inList(q.managementSystemId, n.managementSystemId) &&
          (q.unitId === undefined || (n.unitId !== null && q.unitId.includes(n.unitId))) &&
          inList(q.state, n.state) &&
          inList(q.source, n.source) &&
          inList(q.severity, n.severity) &&
          (q.standard === undefined || n.standards.some((s) => q.standard!.includes(s))) &&
          (ownerId === undefined || n.ownerId === ownerId) &&
          (approverId === undefined || n.approverId === approverId) &&
          (q.incident === undefined || isIncident(n) === q.incident) &&
          (q.overdue === undefined ||
            (ncStatus(n, actionsOn(firm, n), today, dueSoonDays).timing === 'OVERDUE') ===
              q.overdue) &&
          matches(q.q, String(n.number), n.description, n.rootCause) &&
          canSee(actor, ncReach(firm, n)),
      )
      .sort(
        (a, b) =>
          b.reportedOn.localeCompare(a.reportedOn) ||
          b.number - a.number ||
          a.id.localeCompare(b.id),
      );
    return paginate(
      rows.map((n) => ncView(ctx, actor, n)),
      q,
    );
  },

  /**
   * RAISE (model §4.1): any role but viewer, for a unit they can see. Sets the next number of the client, the reporter
   * (the actor) and `reportedOn` (today). INTERNAL_AUDIT and EXTERNAL_AUDIT come only from findings (the body refuses
   * them).
   */
  raiseIsoNonconformity(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const clientId = ctx.params.clientId!;
    const body = ctx.body;
    const system = requireSystem(firm, clientId, body.managementSystemId);
    ctx.authorize(
      isoScope(actor, reachOf(firm, { clientId, unitId: body.unitId, systemId: system.id })),
    );
    const today = ctx.clock.today();
    if (body.unitId !== null) checkSystemUnits(firm, system, [body.unitId], 'unitId');
    checkStandards(firm, system, body.standards, body.clauseIds);
    checkPerson(actor, clientId, body.ownerId, 'ownerId', body.unitId, OWNER_ROLES);
    checkPerson(actor, clientId, body.approverId, 'approverId', body.unitId, APPROVER_ROLES);
    if (body.dueOn < today) invalid('dueOn', 'The nonconformity is due today or later');
    if (body.sourceInstanceId !== null) {
      checkInstance(firm, clientId, body.sourceInstanceId, 'sourceInstanceId');
    }
    if (body.raisedFromRiskItemId !== null) {
      checkLinks(
        firm,
        'riskItems',
        clientId,
        [body.raisedFromRiskItemId],
        [],
        'raisedFromRiskItemId',
      );
    }
    if (body.incident !== null) {
      checkIncident(actor, clientId, body.unitId, body.incident, null, true);
    }
    const number =
      Math.max(
        0,
        ...firm.iso.nonconformities.filter((n) => n.clientId === clientId).map((n) => n.number),
      ) + 1;
    const nc: Nc = {
      ...isoFresh(ctx, actor, clientId),
      managementSystemId: system.id,
      number,
      source: body.source,
      sourceInstanceId: body.sourceInstanceId,
      raisedFromRiskItemId: body.raisedFromRiskItemId,
      severity: body.severity,
      standards: body.standards,
      clauseIds: body.clauseIds,
      unitId: body.unitId,
      description: body.description,
      reportedById: actor.person.id,
      reportedOn: today,
      containment: body.containment,
      correction: body.correction,
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
      ownerId: body.ownerId,
      approverId: body.approverId,
      dueOn: body.dueOn,
      effectivenessDueOn: null,
      effectivenessNote: null,
      effective: null,
      closedOn: null,
      cancelReason: null,
      state: 'OPEN',
      incident: body.incident,
    };
    checkStored(nc);
    firm.iso.nonconformities.push(nc);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'nonconformity',
      entityId: nc.id,
      clientId,
      after: raised(nc),
    });
    return ncView(ctx, actor, nc);
  },

  getIsoNonconformity(ctx) {
    const actor = actorOf(ctx);
    const nc = requireNc(actor, ctx.params);
    ctx.authorize(isoScope(actor, ncReach(actor.firm, nc)));
    return ncView(ctx, actor, nc);
  },

  /**
   * Investigation field edits until CLOSED or CANCELLED (`isoNc.work`: CA, or OW as its owner), audited as UPDATE with
   * the description and incident location left out (non-negotiable 6).
   */
  updateIsoNonconformity(ctx) {
    const actor = actorOf(ctx);
    const nc = requireNc(actor, ctx.params);
    ctx.authorize(isoScope(actor, ncReach(actor.firm, nc), { ownerId: nc.ownerId }));
    const { version, incident, ...fields } = ctx.body;
    checkIsoVersion(nc, version);
    if (LOCKED_NC.includes(nc.state)) invalidTransition('nonconformity', nc.state, 'UPDATE');
    const next: Nc = { ...nc, ...defined(fields) };
    if (incident !== undefined) {
      if (nc.incident === null)
        invalid('incident', 'Only an INCIDENT or NEAR_MISS has incident fields');
      next.incident = { ...nc.incident, ...defined(incident) };
    }
    return saveNcEdit(ctx, actor, nc, next, null);
  },

  /**
   * `isoNc.reassign` (FA, CO, CA) until CLOSED or CANCELLED, with a reason: owner and approver (REASSIGN), `dueOn` and
   * `effectivenessDueOn` (DUE_DATE_CHANGE), and severity (UPDATE) while OPEN or ROOT_CAUSE_FOUND, never on a
   * finding's nonconformity.
   */
  reassignIsoNonconformity(ctx) {
    const actor = actorOf(ctx);
    const nc = requireNc(actor, ctx.params);
    ctx.authorize(isoScope(actor, ncReach(actor.firm, nc)));
    const { version, reason, ...fields } = ctx.body;
    checkIsoVersion(nc, version);
    if (LOCKED_NC.includes(nc.state)) invalidTransition('nonconformity', nc.state, 'UPDATE');
    const next: Nc = { ...nc, ...defined(fields) };
    if (next.severity !== nc.severity && !SEVERITY_STATES.includes(nc.state)) {
      invalidTransition('nonconformity', nc.state, 'UPDATE');
    }
    return saveNcEdit(ctx, actor, nc, next, reason);
  },

  /**
   * ADD_ROOT_CAUSE (OPEN → ROOT_CAUSE_FOUND): containment, correction, root cause and method, similar occurrences, and
   * for an incident related risk items or a risk review; fields sent are saved with the step. The disposition is set
   * by now or never. A missing worker participation is allowed (model §3.11).
   */
  addIsoNcRootCause(ctx) {
    const actor = actorOf(ctx);
    const nc = requireNc(actor, ctx.params);
    ctx.authorize(isoScope(actor, ncReach(actor.firm, nc), { ownerId: nc.ownerId }));
    const { version, ...fields } = ctx.body;
    checkFrom(nc, version, 'ADD_ROOT_CAUSE', ['OPEN']);
    const set = defined(fields);
    const next: Nc = { ...nc, ...set };
    const issues: Issue[] = ROOT_CAUSE_FIELDS.filter((f) => next[f] === null).map((f) => ({
      path: f,
      message: `ADD_ROOT_CAUSE needs ${f}`,
    }));
    if (isIncident(next) && next.relatedRiskItemIds.length === 0 && next.riskReview === null) {
      issues.push({
        path: 'riskReview',
        message: 'An incident investigation reviews related risk items or records a risk review',
      });
    }
    if ((next.disposition === null) !== (next.dispositionAuthorisedById === null)) {
      issues.push({
        path: 'dispositionAuthorisedById',
        message: 'A disposition names who authorised it',
      });
    }
    if (issues.length > 0) invalidAll(issues);
    checkNcChanges(actor, nc, { ...next, state: 'ROOT_CAUSE_FOUND' }, ctx.clock.today());
    moveNc(
      ctx,
      actor,
      nc,
      'ADD_ROOT_CAUSE',
      { ...set, state: 'ROOT_CAUSE_FOUND' },
      { delegated: actor.person.id !== nc.ownerId },
    );
    return ncView(ctx, actor, nc);
  },

  /** PLAN_ACTIONS (ROOT_CAUSE_FOUND → ACTIONS_PLANNED): at least one OPEN action; sets the effectiveness date. */
  planIsoNcActions(ctx) {
    const actor = actorOf(ctx);
    const nc = requireNc(actor, ctx.params);
    ctx.authorize(isoScope(actor, ncReach(actor.firm, nc), { ownerId: nc.ownerId }));
    const { version, effectivenessDueOn } = ctx.body;
    checkFrom(nc, version, 'PLAN_ACTIONS', ['ROOT_CAUSE_FOUND']);
    if (!actionsOn(actor.firm, nc).some((a) => a.state === 'OPEN')) {
      invalid('actions', 'PLAN_ACTIONS needs at least one OPEN action on the nonconformity');
    }
    if (effectivenessDueOn < ctx.clock.today()) {
      invalid('effectivenessDueOn', 'The effectiveness check is due today or later');
    }
    moveNc(
      ctx,
      actor,
      nc,
      'PLAN_ACTIONS',
      { state: 'ACTIONS_PLANNED', effectivenessDueOn },
      { delegated: actor.person.id !== nc.ownerId },
    );
    return ncView(ctx, actor, nc);
  },

  /**
   * SUBMIT_NO_ACTION (ROOT_CAUSE_FOUND → AWAITING_VERIFICATION), refused (400) for MAJOR, EXTERNAL_AUDIT, a LOST_TIME or
   * FATALITY incident, and a nonconformity that has had a VERIFY_NOT_EFFECTIVE.
   */
  submitIsoNcNoAction(ctx) {
    const actor = actorOf(ctx);
    const nc = requireNc(actor, ctx.params);
    ctx.authorize(isoScope(actor, ncReach(actor.firm, nc), { ownerId: nc.ownerId }));
    const { version, noActionReason, riskReview, systemChange } = ctx.body;
    checkFrom(nc, version, 'SUBMIT_NO_ACTION', ['ROOT_CAUSE_FOUND']);
    const refusals = noActionRefusals(actor.firm, nc);
    if (refusals.length > 0) invalidAll(refusals);
    moveNc(
      ctx,
      actor,
      nc,
      'SUBMIT_NO_ACTION',
      { noActionReason, riskReview, systemChange, state: 'AWAITING_VERIFICATION' },
      { delegated: actor.person.id !== nc.ownerId },
    );
    return ncView(ctx, actor, nc);
  },

  /**
   * SUBMIT (ACTIONS_PLANNED → AWAITING_VERIFICATION): every action DONE or CANCELLED and one DONE, risk review and system
   * change recorded; after a VERIFY_NOT_EFFECTIVE or REOPEN, one action created since then is DONE.
   */
  submitIsoNc(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const nc = requireNc(actor, ctx.params);
    ctx.authorize(isoScope(actor, ncReach(firm, nc), { ownerId: nc.ownerId }));
    const { version, ...fields } = ctx.body;
    checkFrom(nc, version, 'SUBMIT', ['ACTIONS_PLANNED']);
    const set = defined(fields);
    const next: Nc = { ...nc, ...set };
    const actions = actionsOn(firm, nc);
    const issues: Issue[] = [];
    if (actions.some((a) => a.state === 'OPEN')) {
      issues.push({ path: 'actions', message: 'Every action is DONE or CANCELLED before SUBMIT' });
    }
    if (!actions.some((a) => a.state === 'DONE')) {
      issues.push({ path: 'actions', message: 'At least one action is DONE before SUBMIT' });
    }
    const reset = lastStep(firm, nc, ['VERIFY_NOT_EFFECTIVE', 'REOPEN']);
    if (
      reset !== null &&
      !actions.some((a) => a.state === 'DONE' && createdSince(firm, a, reset))
    ) {
      issues.push({
        path: 'actions',
        message:
          'An action added since the nonconformity was found not effective or reopened is DONE',
      });
    }
    for (const field of ['riskReview', 'systemChange'] as const) {
      if (next[field] === null) issues.push({ path: field, message: `SUBMIT needs ${field}` });
    }
    if (issues.length > 0) invalidAll(issues);
    moveNc(
      ctx,
      actor,
      nc,
      'SUBMIT',
      { ...set, state: 'AWAITING_VERIFICATION' },
      { delegated: actor.person.id !== nc.ownerId },
    );
    return ncView(ctx, actor, nc);
  },

  /** VERIFY_EFFECTIVE (AWAITING_VERIFICATION → CLOSED): the approver, not before `effectivenessDueOn`. */
  verifyIsoNcEffective(ctx) {
    const actor = actorOf(ctx);
    const nc = requireNc(actor, ctx.params);
    ctx.authorize(isoScope(actor, ncReach(actor.firm, nc), { approverId: nc.approverId }));
    const today = ctx.clock.today();
    checkFrom(nc, ctx.body.version, 'VERIFY_EFFECTIVE', ['AWAITING_VERIFICATION']);
    checkChecker(actor, nc);
    if (nc.effectivenessDueOn !== null && today < nc.effectivenessDueOn) {
      invalid('effectivenessDueOn', `Effectiveness is verified from ${nc.effectivenessDueOn}`);
    }
    moveNc(
      ctx,
      actor,
      nc,
      'VERIFY_EFFECTIVE',
      {
        effectivenessNote: ctx.body.effectivenessNote,
        effective: true,
        closedOn: today,
        state: 'CLOSED',
      },
      { delegated: actor.person.id !== nc.approverId },
    );
    return ncView(ctx, actor, nc);
  },

  /**
   * VERIFY_NOT_EFFECTIVE (AWAITING_VERIFICATION → OPEN or ACTIONS_PLANNED): back to OPEN clears the effectiveness date,
   * back to ACTIONS_PLANNED sets a new one after today.
   */
  verifyIsoNcNotEffective(ctx) {
    const actor = actorOf(ctx);
    const nc = requireNc(actor, ctx.params);
    ctx.authorize(isoScope(actor, ncReach(actor.firm, nc), { approverId: nc.approverId }));
    checkFrom(nc, ctx.body.version, 'VERIFY_NOT_EFFECTIVE', ['AWAITING_VERIFICATION']);
    checkChecker(actor, nc);
    const change = backToChange(ctx.body, ctx.clock.today());
    moveNc(
      ctx,
      actor,
      nc,
      'VERIFY_NOT_EFFECTIVE',
      { ...change, effective: false },
      { reason: ctx.body.reason, delegated: actor.person.id !== nc.approverId },
    );
    return ncView(ctx, actor, nc);
  },

  /** CANCEL (any state but CLOSED or CANCELLED): the approver or a client admin, with a reason. Final. */
  cancelIsoNc(ctx) {
    const actor = actorOf(ctx);
    const nc = requireNc(actor, ctx.params);
    ctx.authorize(isoScope(actor, ncReach(actor.firm, nc), { approverId: nc.approverId }));
    checkIsoVersion(nc, ctx.body.version);
    if (LOCKED_NC.includes(nc.state)) invalidTransition('nonconformity', nc.state, 'CANCEL');
    moveNc(
      ctx,
      actor,
      nc,
      'CANCEL',
      { cancelReason: ctx.body.reason, state: 'CANCELLED' },
      { reason: ctx.body.reason },
    );
    return ncView(ctx, actor, nc);
  },

  /**
   * REOPEN (CLOSED → OPEN or ACTIONS_PLANNED): a client admin, with a reason. Clears `closedOn` and the verdict; back to
   * ACTIONS_PLANNED sets a new effectiveness date after today, back to OPEN clears it.
   */
  reopenIsoNc(ctx) {
    const actor = actorOf(ctx);
    const nc = requireNc(actor, ctx.params);
    ctx.authorize(isoScope(actor, ncReach(actor.firm, nc)));
    checkFrom(nc, ctx.body.version, 'REOPEN', ['CLOSED']);
    const change = backToChange(ctx.body, ctx.clock.today());
    moveNc(
      ctx,
      actor,
      nc,
      'REOPEN',
      { ...change, closedOn: null, effective: null },
      { reason: ctx.body.reason },
    );
    return ncView(ctx, actor, nc);
  },

  /**
   * By due date, then in the order added. Each action takes its subject's units; AP and OW see their units' actions,
   * those whose subject names them, and their own (plan §3.3).
   */
  listIsoActions(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const q = ctx.query;
    const today = ctx.clock.today();
    const dueSoonDays = firm.data.firm.settings.dueSoonDays;
    const ownerId = personRef(actor, q.ownerId);
    const rows = liveIso(firm, 'actions', clientId)
      .flatMap((action) => {
        // An action whose subject cannot be found is left out rather than failing the list.
        try {
          return [{ action, subject: subjectOf(firm, clientId, action.subject, false) }];
        } catch (error) {
          if (error instanceof MockError) return [];
          throw error;
        }
      })
      .filter(
        ({ action: a, subject }) =>
          (q.managementSystemId === undefined || q.managementSystemId.includes(subject.systemId)) &&
          (q.subjectType === undefined || a.subject.type === q.subjectType) &&
          (q.subjectId === undefined || a.subject.id === q.subjectId) &&
          (ownerId === undefined || a.ownerId === ownerId) &&
          (q.state === undefined || q.state.includes(a.state)) &&
          (q.overdue === undefined ||
            (isoTiming(a.dueOn, a.state !== 'OPEN', today, dueSoonDays).timing === 'OVERDUE') ===
              q.overdue) &&
          (q.from === undefined || a.dueOn >= q.from) &&
          (q.to === undefined || a.dueOn <= q.to) &&
          matches(q.q, a.text, a.resources) &&
          canSee(actor, actionReach(subject, a)),
      )
      .sort(
        (x, y) =>
          x.action.dueOn.localeCompare(y.action.dueOn) ||
          x.action.createdAt.localeCompare(y.action.createdAt),
      );
    return paginate(
      rows.map(({ action, subject }) => actionView(ctx, actor, action, subject)),
      q,
    );
  },

  /**
   * A new OPEN action on an open subject (model §3.12, §6). OW only as the subject's owner (plan §3.2). A MAJOR_NC or
   * MINOR_NC finding takes none (its actions go on its nonconformity), nor a GOOD_PRACTICE finding; a HAZARD's
   * treatment action names its level of control. The action's owner can complete it: an owner or client admin of the
   * subject's unit.
   */
  createIsoAction(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const clientId = ctx.params.clientId!;
    const body = ctx.body;
    const subject = subjectOf(firm, clientId, body.subject, true);
    ctx.authorize(isoScope(actor, subject.reach, { ownerId: subject.ownerId }));
    checkOpenSubject(subject);
    const type = subject.finding?.type;
    if (type === 'MAJOR_NC' || type === 'MINOR_NC') {
      invalid(
        'subject',
        'A MAJOR_NC or MINOR_NC finding takes no actions: add them to its nonconformity',
      );
    }
    if (type === 'GOOD_PRACTICE') invalid('subject', 'A GOOD_PRACTICE finding takes no actions');
    checkSubjectFields(firm, subject, body);
    checkPerson(actor, clientId, body.ownerId, 'ownerId', subject.unitId, OWNER_ROLES);
    const action: Action = {
      ...isoFresh(ctx, actor, clientId),
      subject: body.subject,
      text: body.text,
      resources: body.resources,
      ownerId: body.ownerId,
      dueOn: body.dueOn,
      doneOn: null,
      state: 'OPEN',
      effectivenessNote: null,
      cancelReason: null,
      controlHierarchy: body.controlHierarchy,
      outputKey: body.outputKey,
    };
    firm.iso.actions.push(action);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'iso_action',
      entityId: action.id,
      clientId,
      after: {
        subject: action.subject,
        ownerId: action.ownerId,
        dueOn: action.dueOn,
        state: action.state,
        controlHierarchy: action.controlHierarchy,
        outputKey: action.outputKey,
      },
    });
    return actionView(ctx, actor, action, subject);
  },

  getIsoAction(ctx) {
    const actor = actorOf(ctx);
    const action = requireAction(actor, ctx.params);
    const subject = subjectOf(actor.firm, action.clientId, action.subject, false);
    ctx.authorize(isoScope(actor, actionReach(subject, action)));
    return actionView(ctx, actor, action, subject);
  },

  /**
   * Changes an OPEN action of an open subject. A new owner is a reassignment and a new `dueOn` a due-date change, each
   * with its reason (model §3.12, §8).
   */
  updateIsoAction(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const action = requireAction(actor, ctx.params);
    const subject = subjectOf(firm, action.clientId, action.subject, false);
    ctx.authorize(isoScope(actor, actionReach(subject, action), { ownerId: subject.ownerId }));
    const { version, reason, ...fields } = ctx.body;
    checkIsoVersion(action, version);
    if (action.state !== 'OPEN') invalidTransition('iso_action', action.state, 'UPDATE');
    checkOpenSubject(subject);
    checkSubjectFields(firm, subject, fields);
    if (fields.ownerId !== undefined && fields.ownerId !== action.ownerId) {
      checkPerson(actor, action.clientId, fields.ownerId, 'ownerId', subject.unitId, OWNER_ROLES);
    }
    const set = defined(fields);
    const changes = diff(action, { ...action, ...set });
    const changed = Object.keys(changes.after);
    if (changed.length === 0) return actionView(ctx, actor, action, subject);
    Object.assign(action, set);
    touchIso(ctx, action);
    for (const [audit, group] of [
      ['REASSIGN', changed.filter((k) => k === 'ownerId')],
      ['DUE_DATE_CHANGE', changed.filter((k) => k === 'dueOn')],
      ['UPDATE', changed.filter((k) => k !== 'ownerId' && k !== 'dueOn')],
    ] as const) {
      if (group.length === 0) continue;
      isoAudit(ctx, actor, {
        action: audit,
        entityType: 'iso_action',
        entityId: action.id,
        clientId: action.clientId,
        before: Object.fromEntries(group.map((k) => [k, changes.before[k]])),
        after: Object.fromEntries(group.map((k) => [k, changes.after[k]])),
        reason: audit === 'UPDATE' ? null : (reason ?? null),
      });
    }
    return actionView(ctx, actor, action, subject);
  },

  /**
   * COMPLETE (OPEN → DONE): the action's owner, or a client admin as delegate; `doneOn` not after today; the subject is
   * open. On a risk item it puts the control in place (model §3.5).
   */
  completeIsoAction(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const action = requireAction(actor, ctx.params);
    const subject = subjectOf(firm, action.clientId, action.subject, false);
    ctx.authorize(isoScope(actor, actionReach(subject, action), { ownerId: action.ownerId }));
    const { version, doneOn, effectivenessNote } = ctx.body;
    checkIsoVersion(action, version);
    if (action.state !== 'OPEN') invalidTransition('iso_action', action.state, 'COMPLETE');
    checkOpenSubject(subject);
    if (doneOn > ctx.clock.today()) invalid('doneOn', 'doneOn is not in the future');
    moveAction(
      ctx,
      actor,
      action,
      'COMPLETE',
      { state: 'DONE', doneOn, ...(effectivenessNote === undefined ? {} : { effectivenessNote }) },
      { delegated: actor.person.id !== action.ownerId },
    );
    if (subject.riskItem !== undefined) putControlInPlace(ctx, actor, subject.riskItem, action);
    return actionView(ctx, actor, action, subject);
  },

  /**
   * CANCEL (OPEN → CANCELLED): the subject's approver or a client admin, with a reason. Allowed on a closed subject too,
   * so an action left open there can be cleared away.
   */
  cancelIsoAction(ctx) {
    const actor = actorOf(ctx);
    const action = requireAction(actor, ctx.params);
    const subject = subjectOf(actor.firm, action.clientId, action.subject, false);
    ctx.authorize(
      isoScope(actor, actionReach(subject, action), { approverId: subject.approverId }),
    );
    checkIsoVersion(action, ctx.body.version);
    if (action.state !== 'OPEN') invalidTransition('iso_action', action.state, 'CANCEL');
    moveAction(
      ctx,
      actor,
      action,
      'CANCEL',
      { state: 'CANCELLED', cancelReason: ctx.body.reason },
      { reason: ctx.body.reason },
    );
    return actionView(ctx, actor, action, subject);
  },

  /** REOPEN (DONE or CANCELLED → OPEN): a client admin, with a reason, while the subject is open (model §3.12). */
  reopenIsoAction(ctx) {
    const actor = actorOf(ctx);
    const action = requireAction(actor, ctx.params);
    const subject = subjectOf(actor.firm, action.clientId, action.subject, false);
    ctx.authorize(isoScope(actor, actionReach(subject, action)));
    checkIsoVersion(action, ctx.body.version);
    if (action.state === 'OPEN') invalidTransition('iso_action', action.state, 'REOPEN');
    checkOpenSubject(subject);
    moveAction(
      ctx,
      actor,
      action,
      'REOPEN',
      { state: 'OPEN', doneOn: null, cancelReason: null },
      { reason: ctx.body.reason },
    );
    return actionView(ctx, actor, action, subject);
  },
};
