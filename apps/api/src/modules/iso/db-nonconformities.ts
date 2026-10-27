import {
  NcSource,
  Nonconformity as NonconformityRecord,
  type IsoAction,
  type LocalDate,
  type ManagementSystem,
  type Nonconformity,
  type NonconformityView,
  type RequestContext,
  type Role,
} from '@canopy/contracts';
import {
  acts,
  assignments,
  auditFindings,
  controlledDocuments,
  instances,
  isoActions,
  isoCatalogue,
  managementSystems,
  nonconformities,
  obligations,
  riskItems,
  type NonconformityFilter,
  type TenantTx,
} from '@canopy/db';
import {
  ISO_NEW_STATE,
  ISO_TRANSITIONS,
  isoMayCheck,
  isoTransition,
  localDateIn,
  nonconformityStatus,
} from '@canopy/engine';
import { authorize, canSee, isoResource, listScope, may, type Reach } from './access.js';
import { definedOf, liveIn, same, type AuditAction, type Core, type Step } from './db-context.js';
import { checkVersion, forbidden, invalid, invalidTransition, notFound, stepTo } from './errors.js';
import { pageOf } from './paging.js';
import type { IsoCall, IsoHandlers } from './types.js';

/**
 * Nonconformities, incidents and near misses (docs/iso/model.md §3.10, §3.11, §4.1): RAISE, every arrow of the
 * NONCONFORMITY machine through the engine, the investigation PATCH (`isoNc.work`) and the reassign route
 * (`isoNc.reassign`). Dates are the client's: an NC is reported on the client-local day it is raised, and an
 * incident's `occurredAt` is placed on the client-local day too. The mock's picks (docs/contracts/iso-mock.md
 * "Nonconformities") hold here, except as ADR M16-0006 records. ISO-8c part 2 raises a finding's NC through
 * `raiseNonconformity`.
 */

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
  | 'reopenIsoNc';

type NcStep = NonconformityView['allowedActions'][number];
type Incident = NonNullable<Nonconformity['incident']>;

/** States after which a nonconformity is read-only (model §6): REOPEN a CLOSED one first; CANCELLED is final. */
const LOCKED: readonly string[] = ['CLOSED', 'CANCELLED'];
/** People who may own a nonconformity: those `isoNc.work` lets act (plan §3.2). */
export const NC_OWNER_ROLES: readonly Role[] = ['OWNER', 'CLIENT_ADMIN'];
/** People who may approve a nonconformity: those `isoNc.verify` lets act. */
export const NC_APPROVER_ROLES: readonly Role[] = ['APPROVER', 'CLIENT_ADMIN'];
/** States in which the reassign route may still change the severity and the incident outcome (model §3.10). */
const SEVERITY_STATES: readonly string[] = ['OPEN', 'ROOT_CAUSE_FOUND'];
const INCIDENT_SOURCES: readonly string[] = ['INCIDENT', 'NEAR_MISS'];

/** People named on a nonconformity, who always see it (plan §3.3): owner, approver and investigators. */
const ncPeople = (nc: Nonconformity) => [
  nc.ownerId,
  nc.approverId,
  ...(nc.incident?.investigatorIds ?? []),
];

/** A nonconformity takes its own unit, else its management system's units (plan §3.3). */
export const ncReach = (system: ManagementSystem, nc: Nonconformity): Reach => ({
  clientId: nc.clientId,
  unitIds: nc.unitId === null ? system.unitIds : [nc.unitId],
  people: ncPeople(nc),
});

/** Where a nonconformity with `unitId` would sit, naming nobody: what a raise or a unit move must cover. */
const unitReach = (system: ManagementSystem, unitId: string | null): Reach => ({
  clientId: system.clientId,
  unitIds:
    unitId !== null && (system.unitIds.length === 0 || system.unitIds.includes(unitId))
      ? [unitId]
      : system.unitIds,
  people: [],
});

const NOT_RECORDED = '[not recorded]';
const PLACEHOLDER_ID = '00000000-0000-7000-8000-000000000000';

/**
 * Free text that can name people, the description and an incident's location, is noted as changed and never copied
 * into an audit event (non-negotiable 6, model §3.11).
 */
export function unrecorded(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (key === 'description') return NOT_RECORDED;
  if (key === 'incident') return { ...(value as Record<string, unknown>), location: NOT_RECORDED };
  return value;
}

/**
 * The RAISE event's `after`: no description and no incident detail beyond its kind (model §3.11, §8). A finding's
 * nonconformity adds `auditFindingId`.
 */
function raised(nc: Nonconformity): Record<string, unknown> {
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

/** Every rule of the stored nonconformity (the record schema): owner is not approver, dates, incident, per state. */
function checkStored(next: Nonconformity): void {
  const parsed = NonconformityRecord.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    invalid(issue.path.map(String).join('.') || 'body', issue.message);
  }
}

/** The last of `actions` in the record's steps, or null. */
function lastOf(steps: readonly Step[], actions: readonly string[]): Step | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (actions.includes(steps[i]!.action)) return steps[i]!;
  }
  return null;
}

/** The facts SUBMIT_NO_ACTION reads besides its body (model §4.1). */
const noActionFacts = (nc: Nonconformity, steps: readonly Step[]) => ({
  severity: nc.severity,
  source: nc.source,
  incident: nc.incident,
  hadVerifyNotEffective: nc.effective === false || lastOf(steps, ['VERIFY_NOT_EFFECTIVE']) !== null,
});

/**
 * Whether an arrow is on offer once the body brings `fields`: the engine is asked with those fields given, so only
 * the record's own facts (state, severity, dates) decide.
 */
function offered(from: string, action: string, facts: Record<string, unknown>, fields: string[]) {
  const filled = Object.fromEntries(fields.map((f) => [f, 'given']));
  return isoTransition('NONCONFORMITY', from, action, { ...facts, ...filled }).ok;
}

export interface NcContext {
  nc: Nonconformity;
  system: ManagementSystem;
  reach: Reach;
}

/**
 * The field checks of a raise and an edit (model §1.5, §3.10, §3.11), in the request's transaction. A raise checks
 * against an empty record, so every field is new.
 */
function ncChecks(core: Core) {
  /** A live register instance of the client (`sourceInstanceId`). */
  async function checkInstance(tx: TenantTx, clientId: string, id: string, path: string) {
    const instance = await instances.get(tx, id);
    if (instance === null || instance.clientId !== clientId || instance.archivedAt !== null) {
      invalid(path, 'Not a live instance of this client');
    }
    return instance;
  }

  /**
   * `statutoryInstanceId`: a live instance of a statutory obligation on the nonconformity's unit (model §3.11). An act
   * with no kind is a STATUTE.
   */
  async function checkStatutoryInstance(
    tx: TenantTx,
    clientId: string,
    unitId: string | null,
    id: string,
  ): Promise<void> {
    const path = 'incident.statutoryInstanceId';
    const instance = await checkInstance(tx, clientId, id, path);
    if (instance.unitId !== unitId) invalid(path, "Not an instance on the nonconformity's unit");
    const assignment = await assignments.get(tx, instance.assignmentId);
    const obligation =
      assignment === null ? null : await obligations.get(tx, assignment.obligationId);
    const act = obligation === null ? null : await acts.get(tx, obligation.actId);
    if (act === null || act.kind === 'STANDARD') {
      invalid(path, 'The statutory notice is an instance of a statutory obligation');
    }
  }

  /** Ids of live risk items or documents of the client; only ids not already linked are checked. */
  async function checkLinks(
    tx: TenantTx,
    table: 'risk' | 'document',
    clientId: string,
    ids: readonly string[],
    already: readonly string[],
    path: string,
  ): Promise<void> {
    for (const id of ids.filter((i) => !already.includes(i))) {
      const row =
        table === 'risk' ? await riskItems.get(tx, id) : await controlledDocuments.get(tx, id);
      if (row === null || row.clientId !== clientId || row.archivedAt !== null) {
        invalid(
          path,
          table === 'risk'
            ? 'Not a live risk item of this client'
            : 'Not a live document of this client',
        );
      }
    }
  }

  /** Standards are the system's; clauses are live clauses of those standards (model §3.10, ISO-2e's #280 rule). */
  async function checkStandards(
    tx: TenantTx,
    system: ManagementSystem,
    standards: readonly string[],
    clauseIds: readonly string[],
  ): Promise<void> {
    const codeOf = new Map((await isoCatalogue.standards(tx)).map((s) => [s.id, s.code]));
    const codes = system.standardIds.map((id) => codeOf.get(id));
    if (standards.some((s) => !codes.includes(s as never))) {
      invalid('standards', 'Not a standard of the management system');
    }
    for (const id of clauseIds) {
      const clause = await isoCatalogue.clause(tx, id);
      if (
        clause === null ||
        clause.archivedAt !== null ||
        !system.standardIds.includes(clause.standardId) ||
        !standards.includes(codeOf.get(clause.standardId) as never)
      ) {
        invalid('clauseIds', "Not a clause of the nonconformity's standards");
      }
    }
  }

  /**
   * The incident's time, investigators and statutory notice (model §3.11); `all` rechecks everyone after a unit move.
   * A new or moved `occurredAt` is not after now, and its client-local day not after the NC's `reportedOn`.
   */
  async function checkIncident(
    tx: TenantTx,
    clientId: string,
    unitId: string | null,
    incident: Incident,
    before: Incident | null,
    all: boolean,
    reportedOn: LocalDate,
  ): Promise<void> {
    if (incident.occurredAt !== before?.occurredAt) {
      if (Date.parse(incident.occurredAt) > core.clock().getTime()) {
        invalid('incident.occurredAt', 'The incident cannot have occurred after now');
      }
      const { timeZone } = await core.calendar(tx, clientId);
      if (localDateIn(new Date(incident.occurredAt).toISOString(), timeZone) > reportedOn) {
        invalid('incident.occurredAt', 'The incident cannot have occurred after it was reported');
      }
    }
    for (const id of incident.investigatorIds) {
      if (all || !(before?.investigatorIds ?? []).includes(id)) {
        await core.checkPerson(tx, clientId, id, 'incident.investigatorIds', { unitId });
      }
    }
    const instanceId = incident.statutoryInstanceId;
    if (instanceId !== null && (all || instanceId !== before?.statutoryInstanceId)) {
      await checkStatutoryInstance(tx, clientId, unitId, instanceId);
    }
  }

  /**
   * Checks a nonconformity's fields as `next` would leave them against `nc` (model §1.5, §3.10, §3.11): unit,
   * standards and clauses, people (all of them when the unit moves), linked instances, risk items and documents, the
   * disposition (no later than ADD_ROOT_CAUSE), the effectiveness date, then the stored shape.
   */
  async function checkChanges(
    tx: TenantTx,
    system: ManagementSystem,
    nc: Nonconformity,
    next: Nonconformity,
    options: { step?: boolean } = {},
  ): Promise<void> {
    const clientId = nc.clientId;
    const changed = (key: keyof Nonconformity) => !same(nc[key], next[key]);
    const unitMoved = changed('unitId');
    if (unitMoved && next.unitId !== null) {
      await core.checkSystemUnits(tx, system, [next.unitId], 'unitId');
    }
    if (changed('standards') || changed('clauseIds')) {
      await checkStandards(tx, system, next.standards, next.clauseIds);
    }
    const person = (id: string, path: string, roles?: readonly Role[]) =>
      core.checkPerson(tx, clientId, id, path, {
        unitId: next.unitId,
        ...(roles ? { roles } : {}),
      });
    if (unitMoved || changed('ownerId')) await person(next.ownerId, 'ownerId', NC_OWNER_ROLES);
    if (unitMoved || changed('approverId')) {
      await person(next.approverId, 'approverId', NC_APPROVER_ROLES);
    }
    if ((changed('disposition') || changed('dispositionAuthorisedById')) && nc.state !== 'OPEN') {
      invalid('disposition', 'A disposition is recorded no later than ADD_ROOT_CAUSE');
    }
    if (
      next.dispositionAuthorisedById !== null &&
      (unitMoved || changed('dispositionAuthorisedById'))
    ) {
      await person(next.dispositionAuthorisedById, 'dispositionAuthorisedById');
    }
    if (changed('sourceInstanceId') && next.sourceInstanceId !== null) {
      await checkInstance(tx, clientId, next.sourceInstanceId, 'sourceInstanceId');
    }
    await checkLinks(
      tx,
      'risk',
      clientId,
      next.relatedRiskItemIds,
      nc.relatedRiskItemIds,
      'relatedRiskItemIds',
    );
    await checkLinks(
      tx,
      'risk',
      clientId,
      next.updatedRiskItemIds,
      nc.updatedRiskItemIds,
      'updatedRiskItemIds',
    );
    await checkLinks(
      tx,
      'document',
      clientId,
      next.changedDocumentIds,
      nc.changedDocumentIds,
      'changedDocumentIds',
    );
    if (next.incident !== null) {
      await checkIncident(
        tx,
        clientId,
        next.unitId,
        next.incident,
        nc.incident,
        unitMoved,
        next.reportedOn,
      );
    }
    // A step's own effectiveness date is the engine's guard (PLAN_ACTIONS, VERIFY_NOT_EFFECTIVE, REOPEN).
    if (changed('effectivenessDueOn') && options.step !== true) {
      if (nc.effectivenessDueOn === null) {
        invalid('effectivenessDueOn', 'PLAN_ACTIONS sets the effectiveness date');
      }
      if (next.effectivenessDueOn === null) {
        invalid('effectivenessDueOn', 'The effectiveness date can be moved, not cleared');
      }
      if (next.effectivenessDueOn < (await core.today(tx, clientId))) {
        invalid('effectivenessDueOn', 'The effectiveness check is due today or later');
      }
    }
    checkStored(next);
  }

  return { checkLinks, checkChanges };
}

export function nonconformitiesHandlers(core: Core): IsoHandlers<Ids> {
  const { checkLinks, checkChanges } = ncChecks(core);

  /** The client's live nonconformity `id` the actor may see, with its system and reach, or 404. */
  async function loadNc(
    tx: TenantTx,
    ctx: RequestContext,
    clientId: string,
    id: string,
  ): Promise<NcContext> {
    const nc = liveIn(await nonconformities.get(tx, id), clientId);
    const system = await managementSystems.require(tx, nc.managementSystemId);
    const reach = ncReach(system, nc);
    if (!canSee(ctx, reach)) notFound();
    return { nc, system, reach };
  }

  const actionsOn = (tx: TenantTx, nc: Nonconformity): Promise<IsoAction[]> =>
    isoActions.forSubject(tx, { type: 'NONCONFORMITY', id: nc.id });

  const history = (tx: TenantTx, nc: Nonconformity) => core.steps(tx, 'nonconformity', nc.id);

  /** The §4.1 steps the actor may take now: the state, plan §3.2, the record's own facts and maker-checker. */
  async function ncSteps(
    tx: TenantTx,
    ctx: RequestContext,
    nc: Nonconformity,
    reach: Reach,
    today: LocalDate,
  ): Promise<NcStep[]> {
    const own = isoResource(ctx, 'nonconformity', reach, { ownerId: nc.ownerId });
    const approves = isoResource(ctx, 'nonconformity', reach, { approverId: nc.approverId });
    const works = may(ctx, 'isoNc.work', own);
    const steps: NcStep[] = [];
    if (nc.state === 'OPEN' && works) steps.push('ADD_ROOT_CAUSE');
    if (nc.state === 'ROOT_CAUSE_FOUND' && works) {
      steps.push('PLAN_ACTIONS');
      const facts = noActionFacts(nc, await history(tx, nc));
      if (
        offered(nc.state, 'SUBMIT_NO_ACTION', facts, [
          'noActionReason',
          'riskReview',
          'systemChange',
        ])
      ) {
        steps.push('SUBMIT_NO_ACTION');
      }
    }
    if (nc.state === 'ACTIONS_PLANNED' && works) steps.push('SUBMIT');
    if (nc.state === 'AWAITING_VERIFICATION' && may(ctx, 'isoNc.verify', approves)) {
      if (isoMayCheck('NONCONFORMITY', 'VERIFY_EFFECTIVE', ctx.personId, await history(tx, nc))) {
        const facts = { effectivenessDueOn: nc.effectivenessDueOn, asOf: today };
        if (offered(nc.state, 'VERIFY_EFFECTIVE', facts, ['effectivenessNote'])) {
          steps.push('VERIFY_EFFECTIVE');
        }
        steps.push('VERIFY_NOT_EFFECTIVE');
      }
    }
    if (!LOCKED.includes(nc.state) && may(ctx, 'isoNc.cancel', approves)) steps.push('CANCEL');
    if (
      nc.state === 'CLOSED' &&
      may(ctx, 'isoNc.reopen', isoResource(ctx, 'nonconformity', reach))
    ) {
      steps.push('REOPEN');
    }
    return steps;
  }

  async function view(
    tx: TenantTx,
    ctx: RequestContext,
    nc: Nonconformity,
    reach: Reach,
    openActions?: readonly IsoAction[],
  ): Promise<NonconformityView> {
    const today = await core.today(tx, nc.clientId);
    const cal = await core.calendar(tx, nc.clientId);
    const actions = openActions ?? (await actionsOn(tx, nc));
    return {
      ...nc,
      status: nonconformityStatus(nc, actions, today, cal),
      findingId: (await auditFindings.forNonconformity(tx, nc.id))?.id ?? null,
      allowedActions: await ncSteps(tx, ctx, nc, reach, today),
    };
  }

  /** Audit groups of a nonconformity edit: people are a reassignment, dates a due-date change (model §8). */
  const groupOf = (key: string): AuditAction =>
    key === 'ownerId' || key === 'approverId'
      ? 'REASSIGN'
      : key === 'dueOn' || key === 'effectivenessDueOn'
        ? 'DUE_DATE_CHANGE'
        : 'UPDATE';

  /**
   * Checks and saves an edit, one audit event per group with `reason` (`isoNc.reassign` always has one), the free text
   * left out; an edit that changes nothing writes nothing.
   */
  async function saveEdit(
    tx: TenantTx,
    ctx: RequestContext,
    loaded: NcContext,
    next: Nonconformity,
    reason: string | null,
  ): Promise<NonconformityView> {
    const { nc, system } = loaded;
    await checkChanges(tx, system, nc, next);
    const keys = (Object.keys(next) as (keyof Nonconformity)[]).filter(
      (k) => !same(nc[k], next[k]),
    );
    if (keys.length === 0) return view(tx, ctx, nc, loaded.reach);
    const patch = Object.fromEntries(keys.map((k) => [k, next[k]])) as Partial<Nonconformity>;
    const updated = await nonconformities.update(tx, nc.id, nc.version, patch as never);
    for (const action of ['REASSIGN', 'DUE_DATE_CHANGE', 'UPDATE'] as const) {
      const group = keys.filter((k) => groupOf(k) === action);
      if (group.length === 0) continue;
      await core.audit(tx, ctx, nc.clientId, {
        action,
        entityType: 'nonconformity',
        entityId: nc.id,
        before: Object.fromEntries(group.map((k) => [k, unrecorded(k, nc[k])])),
        after: Object.fromEntries(group.map((k) => [k, unrecorded(k, updated[k])])),
        reason,
      });
    }
    return view(tx, ctx, updated, ncReach(system, updated));
  }

  /**
   * One §4.1 arrow through the engine: 409 STALE_VERSION, then the engine's answer on `facts` (409 for a state the
   * arrow does not leave, 400 or 422 for a failed guard), then `change` saved with the next state and audited as a
   * TRANSITION naming the step (model §8); `delegated` when someone other than the record's owner or approver took it.
   */
  async function move<
    K extends
      | 'addIsoNcRootCause'
      | 'planIsoNcActions'
      | 'submitIsoNcNoAction'
      | 'submitIsoNc'
      | 'verifyIsoNcEffective'
      | 'verifyIsoNcNotEffective'
      | 'cancelIsoNc'
      | 'reopenIsoNc',
  >(
    call: IsoCall<K>,
    name: NcStep,
    grant: {
      action: 'isoNc.work' | 'isoNc.verify' | 'isoNc.cancel' | 'isoNc.reopen';
      own?: 'owner' | 'approver';
    },
    plan: (
      tx: TenantTx,
      loaded: NcContext,
      today: LocalDate,
    ) => Promise<{ facts: Record<string, unknown>; change: Partial<Nonconformity> }>,
  ): Promise<NonconformityView> {
    const { ctx, params, body } = call;
    return core.keyed(ctx, call.key, async (tx) => {
      const loaded = await loadNc(tx, ctx, params.clientId!, params.id!);
      const { nc, system, reach } = loaded;
      const own =
        grant.own === 'owner'
          ? { ownerId: nc.ownerId }
          : grant.own === 'approver'
            ? { approverId: nc.approverId }
            : {};
      authorize(ctx, grant.action, isoResource(ctx, 'nonconformity', reach, own));
      checkVersion(nc, body.version);
      const today = await core.today(tx, nc.clientId);
      // A state no arrow of this name leaves: 409 before any guard or maker-checker answer.
      if (
        !ISO_TRANSITIONS.NONCONFORMITY.some((a) => a.action === name && a.from.includes(nc.state))
      ) {
        invalidTransition('nonconformity', nc.state, name);
      }
      if (
        grant.action === 'isoNc.verify' &&
        !isoMayCheck('NONCONFORMITY', name, ctx.personId, await history(tx, nc))
      ) {
        forbidden(
          'isoNc.verify',
          'You took a step on this nonconformity, so someone else verifies it',
        );
      }
      const { facts, change } = await plan(tx, loaded, today);
      const to = stepTo(
        isoTransition('NONCONFORMITY', nc.state, name, { asOf: today, ...facts }),
        'nonconformity',
        nc.state,
        name,
      );
      const next = { ...nc, ...change, state: to } as Nonconformity;
      await checkChanges(tx, system, nc, next, { step: true });
      const keys = (Object.keys(next) as (keyof Nonconformity)[]).filter(
        (k) => !same(nc[k], next[k]),
      );
      const patch = Object.fromEntries(keys.map((k) => [k, next[k]])) as Partial<Nonconformity>;
      const updated = await nonconformities.update(tx, nc.id, nc.version, patch as never);
      const named = grant.own === 'approver' ? nc.approverId : nc.ownerId;
      await core.audit(tx, ctx, nc.clientId, {
        action: 'TRANSITION',
        entityType: 'nonconformity',
        entityId: nc.id,
        before: Object.fromEntries(keys.map((k) => [k, unrecorded(k, nc[k])])),
        after: {
          action: name,
          ...Object.fromEntries(keys.map((k) => [k, unrecorded(k, updated[k])])),
        },
        reason: 'reason' in body ? (body.reason as string) : null,
        delegated:
          grant.action !== 'isoNc.cancel' &&
          grant.action !== 'isoNc.reopen' &&
          named !== ctx.personId,
      });
      return view(tx, ctx, updated, ncReach(system, updated));
    });
  }

  /** Back to OPEN clears the effectiveness date; back to ACTIONS_PLANNED takes a new one (model §4.1). */
  const backTo = (body: {
    backTo: 'OPEN' | 'ACTIONS_PLANNED';
    effectivenessDueOn?: LocalDate | undefined;
  }) => ({
    facts: {
      backTo: body.backTo,
      reason: 'given',
      effectivenessDueOn: body.effectivenessDueOn ?? null,
    },
    change: {
      effectivenessDueOn: body.backTo === 'OPEN' ? null : (body.effectivenessDueOn ?? null),
    } as Partial<Nonconformity>,
  });

  return {
    /**
     * Newest first (`reportedOn`, then number). AP and OW see their units' nonconformities and those naming them as
     * owner, approver or investigator (plan §3.3). `ids`, unit scope and the other filters apply in SQL; `q` (number,
     * description, root cause) and `overdue` (the engine's `nonconformityStatus`) here, then the order and the page.
     */
    async listIsoNonconformities({ ctx, params, query }) {
      const clientId = params.clientId!;
      authorize(ctx, 'isoNc.read', { type: 'nonconformity', clientId });
      const filter: NonconformityFilter = definedOf({
        ids: query.ids,
        managementSystemIds: query.managementSystemId,
        unitIds: query.unitId,
        state: query.state,
        source:
          query.incident === undefined
            ? query.source
            : (query.source ?? NcSource.options).filter(
                (s) => INCIDENT_SOURCES.includes(s) === query.incident,
              ),
        severity: query.severity,
        standards: query.standard,
        ownerId: query.ownerId === 'me' ? ctx.personId : query.ownerId,
        approverId: query.approverId === 'me' ? ctx.personId : query.approverId,
        scope: listScope(ctx, clientId),
      });
      return core.run(ctx, async (tx) => {
        const all: Nonconformity[] = [];
        let cursor: string | null = null;
        do {
          const page = await nonconformities.list(tx, clientId, {
            ...filter,
            limit: 200,
            ...(cursor === null ? {} : { cursor }),
          });
          all.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== null);
        // The open actions of the client's nonconformities, once, for their timing.
        const open = new Map<string, IsoAction[]>();
        let after: string | null = null;
        do {
          const page = await isoActions.list(tx, clientId, {
            subjectTypes: ['NONCONFORMITY'],
            state: ['OPEN'],
            limit: 200,
            ...(after === null ? {} : { cursor: after }),
          });
          for (const a of page.items)
            open.set(a.subject.id, [...(open.get(a.subject.id) ?? []), a]);
          after = page.nextCursor;
        } while (after !== null);
        const today = await core.today(tx, clientId);
        const cal = await core.calendar(tx, clientId);
        const needle = query.q?.toLowerCase();
        const rows = all
          .filter(
            (n) =>
              (needle === undefined ||
                [String(n.number), n.description, n.rootCause].some((v) =>
                  v?.toLowerCase().includes(needle),
                )) &&
              (query.overdue === undefined ||
                (nonconformityStatus(n, open.get(n.id) ?? [], today, cal).timing === 'OVERDUE') ===
                  query.overdue),
          )
          .sort(
            (a, b) =>
              b.reportedOn.localeCompare(a.reportedOn) ||
              b.number - a.number ||
              a.id.localeCompare(b.id),
          );
        const page = pageOf(rows, query);
        const systems = new Map<string, ManagementSystem>();
        const items: NonconformityView[] = [];
        for (const nc of page.items) {
          if (!systems.has(nc.managementSystemId)) {
            systems.set(
              nc.managementSystemId,
              await managementSystems.require(tx, nc.managementSystemId),
            );
          }
          const reach = ncReach(systems.get(nc.managementSystemId)!, nc);
          items.push(await view(tx, ctx, nc, reach, open.get(nc.id) ?? []));
        }
        return { ...page, items };
      });
    },

    /**
     * RAISE (model §4.1): any role but viewer, for a unit they can see, through the engine. The database numbers it;
     * the reporter is the actor and `reportedOn` the client's today. INTERNAL_AUDIT and EXTERNAL_AUDIT come only from
     * findings (the body refuses them, and so does the engine).
     */
    async raiseIsoNonconformity({ ctx, params, body, key }) {
      const clientId = params.clientId!;
      return core.keyed(ctx, key, async (tx) => {
        const system = await core.loadSystem(tx, ctx, clientId, body.managementSystemId);
        authorize(
          ctx,
          'isoNc.raise',
          isoResource(ctx, 'nonconformity', unitReach(system, body.unitId)),
        );
        if (body.raisedFromRiskItemId !== null) {
          await checkLinks(
            tx,
            'risk',
            clientId,
            [body.raisedFromRiskItemId],
            [],
            'raisedFromRiskItemId',
          );
        }
        const nc = await raiseNonconformity(core, tx, ctx, system, {
          source: body.source,
          sourceInstanceId: body.sourceInstanceId,
          raisedFromRiskItemId: body.raisedFromRiskItemId,
          severity: body.severity,
          standards: body.standards,
          clauseIds: body.clauseIds,
          unitId: body.unitId,
          description: body.description,
          containment: body.containment,
          correction: body.correction,
          ownerId: body.ownerId,
          approverId: body.approverId,
          dueOn: body.dueOn,
          incident: body.incident,
        });
        return view(tx, ctx, nc, ncReach(system, nc), []);
      });
    },

    async getIsoNonconformity({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const { nc, reach } = await loadNc(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoNc.read', isoResource(ctx, 'nonconformity', reach));
        return view(tx, ctx, nc, reach);
      });
    },

    /**
     * Investigation field edits until CLOSED or CANCELLED (`isoNc.work`: CA, or OW as its owner), audited as UPDATE
     * with the description and incident location left out (non-negotiable 6). Moving the unit needs the same grant on
     * the new unit. The incident outcome is the reassign route's; `lostDays` changes here while it stays LOST_TIME.
     */
    async updateIsoNonconformity({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const loaded = await loadNc(tx, ctx, params.clientId!, params.id!);
        const { nc, system, reach } = loaded;
        authorize(
          ctx,
          'isoNc.work',
          isoResource(ctx, 'nonconformity', reach, { ownerId: nc.ownerId }),
        );
        const { version, incident, ...fields } = body;
        checkVersion(nc, version);
        if (LOCKED.includes(nc.state)) invalidTransition('nonconformity', nc.state, 'UPDATE');
        const next = { ...nc, ...definedOf(fields) } as Nonconformity;
        if (next.unitId !== nc.unitId) {
          authorize(
            ctx,
            'isoNc.work',
            isoResource(ctx, 'nonconformity', unitReach(system, next.unitId), {
              ownerId: nc.ownerId,
            }),
          );
        }
        if (incident !== undefined) {
          if (nc.incident === null)
            invalid('incident', 'Only an INCIDENT or NEAR_MISS has incident fields');
          next.incident = { ...nc.incident, ...definedOf(incident) } as Incident;
        }
        return saveEdit(tx, ctx, loaded, next, null);
      });
    },

    /**
     * `isoNc.reassign` (FA, CO, CA) until CLOSED or CANCELLED, with a reason: owner and approver (REASSIGN), `dueOn`
     * and `effectivenessDueOn` (DUE_DATE_CHANGE), and severity and the incident outcome (UPDATE) while OPEN or
     * ROOT_CAUSE_FOUND (model §3.10). A finding's nonconformity refuses severity, one with no incident an outcome
     * (400). `lostDays` moves with the outcome only.
     */
    async reassignIsoNonconformity({ ctx, params, body, key }) {
      return core.keyed(ctx, key, async (tx) => {
        const loaded = await loadNc(tx, ctx, params.clientId!, params.id!);
        const { nc, reach } = loaded;
        authorize(ctx, 'isoNc.reassign', isoResource(ctx, 'nonconformity', reach));
        const { version, reason, incident, ...fields } = body;
        checkVersion(nc, version);
        if (LOCKED.includes(nc.state)) invalidTransition('nonconformity', nc.state, 'UPDATE');
        const next = { ...nc, ...definedOf(fields) } as Nonconformity;
        if (incident !== undefined) {
          if (nc.incident === null)
            invalid('incident', 'Only an INCIDENT or NEAR_MISS has incident fields');
          const lostDays = incident.lostDays ?? null;
          if (incident.outcome === nc.incident.outcome && lostDays !== nc.incident.lostDays) {
            invalid(
              'incident.lostDays',
              'lostDays changes on the PATCH while the outcome stays LOST_TIME',
            );
          }
          next.incident = { ...nc.incident, outcome: incident.outcome, lostDays };
        }
        const severityMoved = next.severity !== nc.severity;
        if (severityMoved && (await auditFindings.forNonconformity(tx, nc.id)) !== null) {
          invalid('severity', "The finding's type sets the severity: change the finding instead");
        }
        const outcomeMoved = next.incident?.outcome !== nc.incident?.outcome;
        if ((severityMoved || outcomeMoved) && !SEVERITY_STATES.includes(nc.state)) {
          invalidTransition('nonconformity', nc.state, 'UPDATE');
        }
        return saveEdit(tx, ctx, loaded, next, reason);
      });
    },

    /**
     * ADD_ROOT_CAUSE (OPEN → ROOT_CAUSE_FOUND): containment, correction, root cause and method, similar occurrences,
     * and for an incident related risk items or a risk review; fields sent are saved with the step, the disposition
     * by now or never.
     */
    addIsoNcRootCause: (call) =>
      move(call, 'ADD_ROOT_CAUSE', { action: 'isoNc.work', own: 'owner' }, async (_tx, { nc }) => {
        // The body's fields but its version.
        const change = definedOf({ ...call.body, version: undefined }) as Partial<Nonconformity>;
        const next = { ...nc, ...change };
        return {
          change,
          facts: {
            containment: next.containment,
            correction: next.correction,
            rootCauseMethod: next.rootCauseMethod,
            rootCause: next.rootCause,
            similarOccurrences: next.similarOccurrences,
            disposition: next.disposition,
            dispositionAuthorisedById: next.dispositionAuthorisedById,
            source: next.source,
            relatedRiskItemCount: next.relatedRiskItemIds.length,
            riskReview: next.riskReview,
          },
        };
      }),

    /** PLAN_ACTIONS (ROOT_CAUSE_FOUND → ACTIONS_PLANNED): at least one OPEN action; sets the effectiveness date. */
    planIsoNcActions: (call) =>
      move(call, 'PLAN_ACTIONS', { action: 'isoNc.work', own: 'owner' }, async (tx, { nc }) => ({
        change: { effectivenessDueOn: call.body.effectivenessDueOn },
        facts: {
          openActionCount: (await actionsOn(tx, nc)).filter((a) => a.state === 'OPEN').length,
          effectivenessDueOn: call.body.effectivenessDueOn,
        },
      })),

    /**
     * SUBMIT_NO_ACTION (ROOT_CAUSE_FOUND → AWAITING_VERIFICATION), refused (400) for MAJOR, EXTERNAL_AUDIT, a LOST_TIME
     * or FATALITY incident, and a nonconformity that has had a VERIFY_NOT_EFFECTIVE.
     */
    submitIsoNcNoAction: (call) =>
      move(call, 'SUBMIT_NO_ACTION', { action: 'isoNc.work', own: 'owner' }, async (tx, { nc }) => {
        const { noActionReason, riskReview, systemChange } = call.body;
        return {
          change: { noActionReason, riskReview, systemChange },
          facts: {
            ...noActionFacts(nc, await history(tx, nc)),
            noActionReason,
            riskReview,
            systemChange,
          },
        };
      }),

    /**
     * SUBMIT (ACTIONS_PLANNED → AWAITING_VERIFICATION): every action DONE or CANCELLED and one DONE, risk review and
     * system change recorded; after a VERIFY_NOT_EFFECTIVE or REOPEN, one action created since then is DONE.
     */
    submitIsoNc: (call) =>
      move(call, 'SUBMIT', { action: 'isoNc.work', own: 'owner' }, async (tx, { nc }) => {
        // The body's fields but its version.
        const change = definedOf({ ...call.body, version: undefined }) as Partial<Nonconformity>;
        const next = { ...nc, ...change };
        const actions = await actionsOn(tx, nc);
        const reset = lastOf(await history(tx, nc), ['VERIFY_NOT_EFFECTIVE', 'REOPEN']);
        return {
          change,
          facts: {
            openActionCount: actions.filter((a) => a.state === 'OPEN').length,
            doneActionCount: actions.filter((a) => a.state === 'DONE').length,
            doneSinceResetCount:
              reset === null
                ? null
                : actions.filter((a) => a.state === 'DONE' && a.createdAt > reset.at).length,
            riskReview: next.riskReview,
            systemChange: next.systemChange,
          },
        };
      }),

    /**
     * VERIFY_EFFECTIVE (AWAITING_VERIFICATION → CLOSED): the approver (a CA as delegate), never a maker, not before
     * `effectivenessDueOn`; after SUBMIT_NO_ACTION, only while the no-action rule still holds (iso-mock.md).
     */
    verifyIsoNcEffective: (call) =>
      move(
        call,
        'VERIFY_EFFECTIVE',
        { action: 'isoNc.verify', own: 'approver' },
        async (tx, { nc }, today) => {
          const steps = await history(tx, nc);
          const submit = lastOf(steps, ['SUBMIT', 'SUBMIT_NO_ACTION']);
          const withoutAction =
            nc.noActionReason !== null && (submit === null || submit.action === 'SUBMIT_NO_ACTION');
          if (withoutAction) {
            const check = isoTransition('NONCONFORMITY', 'ROOT_CAUSE_FOUND', 'SUBMIT_NO_ACTION', {
              ...noActionFacts(nc, steps),
              noActionReason: nc.noActionReason,
              riskReview: nc.riskReview,
              systemChange: nc.systemChange,
            });
            if (!check.ok && check.error === 'GUARD') {
              invalid(
                check.fields[0]!,
                'It was submitted with no action and now needs corrective actions: VERIFY_NOT_EFFECTIVE sends it back',
              );
            }
          }
          return {
            change: {
              effectivenessNote: call.body.effectivenessNote,
              effective: true,
              closedOn: today,
            },
            facts: {
              effectivenessNote: call.body.effectivenessNote,
              effectivenessDueOn: nc.effectivenessDueOn,
            },
          };
        },
      ),

    /**
     * VERIFY_NOT_EFFECTIVE (AWAITING_VERIFICATION → OPEN or ACTIONS_PLANNED), with a reason: back to OPEN clears the
     * effectiveness date, back to ACTIONS_PLANNED sets a new one after today.
     */
    verifyIsoNcNotEffective: (call) =>
      move(call, 'VERIFY_NOT_EFFECTIVE', { action: 'isoNc.verify', own: 'approver' }, async () => {
        const { facts, change } = backTo(call.body);
        return { facts, change: { ...change, effective: false } };
      }),

    /** CANCEL (any state but CLOSED or CANCELLED): the approver or a client admin, with a reason. Final. */
    cancelIsoNc: (call) =>
      move(call, 'CANCEL', { action: 'isoNc.cancel', own: 'approver' }, async () => ({
        change: { cancelReason: call.body.reason },
        facts: { reason: call.body.reason },
      })),

    /**
     * REOPEN (CLOSED → OPEN or ACTIONS_PLANNED): a client admin, with a reason. Clears `closedOn` and the verdict;
     * back to ACTIONS_PLANNED sets a new effectiveness date after today, back to OPEN clears it.
     */
    reopenIsoNc: (call) =>
      move(call, 'REOPEN', { action: 'isoNc.reopen' }, async () => {
        const { facts, change } = backTo(call.body);
        return { facts, change: { ...change, closedOn: null, effective: null } };
      }),
  };
}

/** What a raise brings: the body's fields, by hand or from a finding (ISO-8c part 2). */
export type NcRaise = Pick<
  Nonconformity,
  | 'source'
  | 'sourceInstanceId'
  | 'raisedFromRiskItemId'
  | 'severity'
  | 'standards'
  | 'clauseIds'
  | 'unitId'
  | 'description'
  | 'containment'
  | 'correction'
  | 'ownerId'
  | 'approverId'
  | 'dueOn'
  | 'incident'
>;

/**
 * RAISE through the engine, in the caller's transaction (model §4.1): the unit, standards and people checked, the
 * client-local `reportedOn`, the database's number (its trigger takes `max + 1` after its lock, at READ COMMITTED),
 * and the CREATE event with `after.action` RAISE and no free text. A finding's raise passes `auditFindingId`.
 */
export async function raiseNonconformity(
  core: Core,
  tx: TenantTx,
  ctx: RequestContext,
  system: ManagementSystem,
  fields: NcRaise,
  options: { auditFindingId?: string } = {},
): Promise<Nonconformity> {
  const clientId = system.clientId;
  const reportedOn = await core.today(tx, clientId);
  const fromFinding = options.auditFindingId !== undefined;
  const result = isoTransition('NONCONFORMITY', ISO_NEW_STATE, 'RAISE', {
    ...fields,
    reportedOn,
    fromFinding,
    asOf: reportedOn,
  });
  stepTo(result, 'nonconformity', ISO_NEW_STATE, 'RAISE');
  const stored: Omit<
    Nonconformity,
    'id' | 'firmId' | 'version' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'number'
  > = {
    clientId,
    managementSystemId: system.id,
    ...fields,
    reportedById: ctx.personId,
    reportedOn,
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
    effectivenessDueOn: null,
    effectivenessNote: null,
    effective: null,
    closedOn: null,
    cancelReason: null,
    state: 'OPEN',
  };
  const blank = {
    ...stored,
    unitId: null,
    standards: [],
    clauseIds: [],
    ownerId: null,
    approverId: null,
    sourceInstanceId: null,
    incident: null,
  } as unknown as Nonconformity;
  // The stored shape needs a row's own fields; the database sets the real ones.
  const draft = {
    ...stored,
    id: PLACEHOLDER_ID,
    firmId: ctx.firmId,
    number: 1,
    version: 1,
    createdAt: core.now(),
    updatedAt: core.now(),
    archivedAt: null,
  } as Nonconformity;
  await ncChecks(core).checkChanges(tx, system, blank, draft);
  const nc = await nonconformities.create(tx, stored as never);
  await core.audit(tx, ctx, clientId, {
    action: 'CREATE',
    entityType: 'nonconformity',
    entityId: nc.id,
    after: {
      ...raised(nc),
      ...(options.auditFindingId === undefined ? {} : { auditFindingId: options.auditFindingId }),
    },
  });
  return nc;
}
