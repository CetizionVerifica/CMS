import {
  type AuditFinding,
  type IsoAction,
  type IsoActionSubject,
  type IsoActionView,
  type IsoEntityType,
  type LocalDate,
  type ManagementReview,
  type Nonconformity,
  type RequestContext,
  type RiskItem,
  type Role,
} from '@canopy/contracts';
import {
  auditFindings,
  auditProgrammes,
  externalAudits,
  internalAudits,
  isoActions,
  isoCatalogue,
  managementReviews,
  managementSystems,
  nonconformities,
  objectives,
  riskControls,
  riskItems,
  type IsoActionFilter,
  type TenantTx,
} from '@canopy/db';
import { ISO_TRANSITIONS, actionStatus, isoTransition } from '@canopy/engine';
import {
  authorize,
  canSee,
  holdsRole,
  isoResource,
  listScope,
  MANAGERS,
  may,
  objectiveReach,
  reviewReach,
  riskReach,
  systemReach,
  type Reach,
} from './access.js';
import { definedOf, liveIn, type Calendar, type Core } from './db-context.js';
import { checkVersion, forbidden, invalid, invalidTransition, notFound, stepTo } from './errors.js';
import { pageOf } from './paging.js';
import type { IsoCall, IsoHandlers } from './types.js';

/**
 * Actions on every ISO subject (docs/iso/model.md §3.12): corrective actions on a nonconformity, treatment actions on
 * a risk item, an objective's plan, improvement actions on a finding and review actions. COMPLETE, CANCEL and REOPEN go
 * through the engine's ISO_ACTION machine; completing a treatment action puts its control in place and asks for a
 * re-rating (model §3.5). The mock's picks (docs/contracts/iso-mock.md, the last two sentences of "Nonconformities")
 * hold here.
 */

type Ids =
  | 'listIsoActions'
  | 'createIsoAction'
  | 'getIsoAction'
  | 'updateIsoAction'
  | 'completeIsoAction'
  | 'cancelIsoAction'
  | 'reopenIsoAction';

type Step = 'COMPLETE' | 'CANCEL' | 'REOPEN';

/** People who may own an action: those `isoAction.complete` lets act (plan §3.2). */
const OWNER_ROLES: readonly Role[] = ['OWNER', 'CLIENT_ADMIN'];
const NC_LOCKED: readonly string[] = ['CLOSED', 'CANCELLED'];
const AUDIT_LOCKED: readonly string[] = ['CLOSED', 'CANCELLED'];

/** An action's subject as the action and file rules read it (model §3.12, §6; plan §3.2-3.3). */
export interface ActionSubject {
  entity: IsoEntityType;
  systemId: string;
  /** The subject's units and named people; its actions take the same units (plan §3.3). */
  reach: Reach;
  /** "own" for `isoAction.write` and `isoAction.cancel`: null when the subject names nobody in that role. */
  ownerId: string | null;
  approverId: string | null;
  /** The unit an action owner must cover, when the subject has one. */
  unitId: string | null;
  /** What closes the subject to new, changed and reopened actions (model §3.12), or null while it is open. */
  lock: { entity: IsoEntityType; state: string } | null;
  riskItem?: RiskItem;
  finding?: AuditFinding;
  review?: ManagementReview;
  /** The nonconformity: its incident's files, and its actions' files, are downloaded by few (model §6). */
  nc?: Nonconformity;
}

/** An action takes its subject's units; its owner always sees it (plan §3.3). */
export const actionReach = (subject: ActionSubject, action: Pick<IsoAction, 'ownerId'>): Reach => ({
  ...subject.reach,
  people: [...subject.reach.people, action.ownerId],
});

const archivedLock = (entity: IsoEntityType, row: { archivedAt: string | null }) =>
  row.archivedAt === null ? null : { entity, state: 'ARCHIVED' };

/** A row of the client: live (else 404) for a new action, archived ones too for an existing one's subject. */
function rowIn<T extends { clientId: string; archivedAt: string | null }>(
  row: T | null,
  clientId: string,
  live: boolean,
): T {
  if (row === null || row.clientId !== clientId || (live && row.archivedAt !== null)) notFound();
  return row;
}

/**
 * The subject an action names, in this client: live (else 404) for a new action, any for an existing one's. A finding
 * takes its audit's units and people; an internal audit's lead auditor is its owner, an external audit's finding has
 * none. It takes new actions until its audit is CLOSED or CANCELLED (a REPORTED audit's findings still do, model §6).
 */
export async function actionSubject(
  tx: TenantTx,
  clientId: string,
  ref: IsoActionSubject,
  live: boolean,
): Promise<ActionSubject> {
  switch (ref.type) {
    case 'NONCONFORMITY': {
      const nc = rowIn(await nonconformities.get(tx, ref.id), clientId, live);
      const system = await managementSystems.require(tx, nc.managementSystemId);
      return {
        entity: 'nonconformity',
        systemId: system.id,
        reach: {
          clientId,
          unitIds: nc.unitId === null ? system.unitIds : [nc.unitId],
          people: [nc.ownerId, nc.approverId, ...(nc.incident?.investigatorIds ?? [])],
        },
        ownerId: nc.ownerId,
        approverId: nc.approverId,
        unitId: nc.unitId,
        lock: NC_LOCKED.includes(nc.state)
          ? { entity: 'nonconformity', state: nc.state }
          : archivedLock('nonconformity', nc),
        nc,
      };
    }
    case 'RISK_ITEM': {
      const item = rowIn(await riskItems.get(tx, ref.id), clientId, live);
      const system = await managementSystems.require(tx, item.managementSystemId);
      return {
        entity: 'risk_item',
        systemId: system.id,
        reach: riskReach(system, item),
        ownerId: item.ownerId,
        approverId: null,
        unitId: item.unitId,
        lock: archivedLock('risk_item', item),
        riskItem: item,
      };
    }
    case 'OBJECTIVE': {
      const objective = rowIn(await objectives.get(tx, ref.id), clientId, live);
      const system = await managementSystems.require(tx, objective.managementSystemId);
      return {
        entity: 'objective',
        systemId: system.id,
        reach: objectiveReach(system, objective),
        ownerId: objective.ownerId,
        approverId: null,
        unitId: null,
        lock:
          objective.closedOn !== null
            ? { entity: 'objective', state: 'CLOSED' }
            : archivedLock('objective', objective),
      };
    }
    case 'AUDIT_FINDING': {
      const finding = rowIn(await auditFindings.get(tx, ref.id), clientId, live);
      const archived = archivedLock('audit_finding', finding);
      if (finding.internalAuditId !== null) {
        const audit = await internalAudits.require(tx, finding.internalAuditId);
        const programme = await auditProgrammes.require(tx, audit.programmeId);
        const system = await managementSystems.require(tx, programme.managementSystemId);
        return {
          entity: 'audit_finding',
          systemId: system.id,
          reach: {
            clientId,
            unitIds: audit.unitIds.length > 0 ? audit.unitIds : system.unitIds,
            people: [
              audit.leadAuditorId,
              ...audit.auditorIds,
              ...audit.auditeeIds,
              ...audit.reportedToIds,
            ],
          },
          ownerId: audit.leadAuditorId,
          approverId: null,
          unitId: finding.unitId,
          lock: AUDIT_LOCKED.includes(audit.state)
            ? { entity: 'internal_audit', state: audit.state }
            : archived,
          finding,
        };
      }
      const audit = await externalAudits.require(tx, finding.externalAuditId!);
      const system = await managementSystems.require(tx, audit.managementSystemId);
      return {
        entity: 'audit_finding',
        systemId: system.id,
        reach: systemReach(system),
        ownerId: null,
        approverId: null,
        unitId: finding.unitId,
        lock: AUDIT_LOCKED.includes(audit.state)
          ? { entity: 'external_audit', state: audit.state }
          : archived,
        finding,
      };
    }
    case 'MANAGEMENT_REVIEW': {
      const review = rowIn(await managementReviews.get(tx, ref.id), clientId, live);
      const system = await managementSystems.require(tx, review.managementSystemId);
      return {
        entity: 'management_review',
        systemId: system.id,
        reach: reviewReach(system, review),
        ownerId: review.chairId,
        approverId: null,
        unitId: null,
        lock:
          review.state === 'CLOSED' || review.state === 'CANCELLED'
            ? { entity: 'management_review', state: review.state }
            : archivedLock('management_review', review),
        review,
      };
    }
  }
}

/**
 * The incident rule (model §6): files on a nonconformity whose `incident` is set, and on its actions, are downloaded
 * only by its owner, approver and investigators and by client admins, consultants and account admins.
 */
export function checkIncidentDownload(ctx: RequestContext, nc: Nonconformity | undefined): void {
  if (nc?.incident == null) return;
  const people = [nc.ownerId, nc.approverId, ...nc.incident.investigatorIds];
  if (!people.includes(ctx.personId) && !holdsRole(ctx, nc.clientId, MANAGERS)) {
    forbidden(
      'isoFile.read',
      "Only the nonconformity's owner, approver and investigators, client admins, consultants and account admins download an incident's files",
    );
  }
}

/** 409 INVALID_TRANSITION naming the subject while it is closed to changes of its actions. */
function checkOpenSubject(subject: ActionSubject): void {
  if (subject.lock !== null) invalidTransition(subject.lock.entity, subject.lock.state, 'UPDATE');
}

/** The actions on an action the actor may take now: its state, its subject and plan §3.2. */
function actionSteps(ctx: RequestContext, action: IsoAction, subject: ActionSubject): Step[] {
  const reach = actionReach(subject, action);
  const steps: Step[] = [];
  if (action.state === 'OPEN') {
    if (
      subject.lock === null &&
      may(
        ctx,
        'isoAction.complete',
        isoResource(ctx, 'iso_action', reach, { ownerId: action.ownerId }),
      )
    ) {
      steps.push('COMPLETE');
    }
    if (
      may(
        ctx,
        'isoAction.cancel',
        isoResource(ctx, 'iso_action', reach, { approverId: subject.approverId }),
      )
    ) {
      steps.push('CANCEL');
    }
  } else if (
    subject.lock === null &&
    may(ctx, 'isoAction.reopen', isoResource(ctx, 'iso_action', reach))
  ) {
    steps.push('REOPEN');
  }
  return steps;
}

export function actionsHandlers(core: Core): IsoHandlers<Ids> {
  function actionView(
    ctx: RequestContext,
    action: IsoAction,
    subject: ActionSubject,
    today: LocalDate,
    cal: Calendar,
  ): IsoActionView {
    return {
      ...action,
      status: actionStatus(action, today, cal),
      allowedActions: actionSteps(ctx, action, subject),
    };
  }

  async function view(
    tx: TenantTx,
    ctx: RequestContext,
    action: IsoAction,
    subject: ActionSubject,
  ): Promise<IsoActionView> {
    return actionView(
      ctx,
      action,
      subject,
      await core.today(tx, action.clientId),
      await core.calendar(tx, action.clientId),
    );
  }

  /** The client's live action `id` the actor may see, with its subject, or 404. */
  async function loadAction(tx: TenantTx, ctx: RequestContext, clientId: string, id: string) {
    const action = liveIn(await isoActions.get(tx, id), clientId);
    const subject = await actionSubject(tx, clientId, action.subject, false);
    const reach = actionReach(subject, action);
    if (!canSee(ctx, reach)) notFound();
    return { action, subject, reach };
  }

  /** `outputKey` names an output of one of the review's standards (catalogue.md §5). */
  async function checkOutputKey(
    tx: TenantTx,
    review: ManagementReview,
    key: string,
  ): Promise<void> {
    const standardIds = (await isoCatalogue.standards(tx))
      .filter((s) => (review.standards as readonly string[]).includes(s.code))
      .map((s) => s.id);
    const { outputs } = await isoCatalogue.reviewDefs(tx, { standardIds });
    if (!outputs.some((d) => d.key === key)) {
      invalid('outputKey', "Not an output of the review's standards");
    }
  }

  /** `controlHierarchy` belongs to risk items (required on a HAZARD) and `outputKey` to management reviews. */
  async function checkSubjectFields(
    tx: TenantTx,
    subject: ActionSubject,
    fields: { controlHierarchy?: string | null; outputKey?: string | null },
  ): Promise<void> {
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
      await checkOutputKey(tx, subject.review, fields.outputKey);
    }
  }

  /**
   * A completed treatment action puts its control in place (model §3.5): a control from it, the item's `reviewDueOn`
   * set to today so its owner re-rates it (a DUE_DATE_CHANGE), and its residual rating cleared when no treatment
   * action is left OPEN (one UPDATE). Both events carry the action's `sourceActionId`, so the review figures do not
   * count them as a re-rating (model §8).
   */
  async function putControlInPlace(
    tx: TenantTx,
    ctx: RequestContext,
    item: RiskItem,
    action: IsoAction,
  ): Promise<void> {
    // The cross-row rule ISO-2e leaves to M16 (#280): a control's source action is an action on its own item.
    if (action.subject.type !== 'RISK_ITEM' || action.subject.id !== item.id) {
      invalid('sourceActionId', 'The source action is not an action on this risk item');
    }
    const fields = {
      riskItemId: item.id,
      text: action.text,
      hierarchy: action.controlHierarchy,
      sourceActionId: action.id,
    };
    const control = await riskControls.create(tx, { clientId: item.clientId, ...fields });
    await core.audit(tx, ctx, item.clientId, {
      action: 'CREATE',
      entityType: 'risk_control',
      entityId: control.id,
      after: { riskItemId: item.id, hierarchy: control.hierarchy, sourceActionId: action.id },
    });
    const current = await riskItems.require(tx, item.id);
    const openLeft = (await isoActions.forSubject(tx, { type: 'RISK_ITEM', id: item.id })).some(
      (a) => a.state === 'OPEN',
    );
    const today = await core.today(tx, item.clientId);
    const due = current.reviewDueOn === today ? {} : { reviewDueOn: today };
    const residual =
      openLeft || current.residualLikelihood === null
        ? {}
        : { residualLikelihood: null, residualSeverity: null, residualRating: null };
    const patch = { ...due, ...residual };
    if (Object.keys(patch).length === 0) return;
    await riskItems.update(tx, current.id, current.version, patch);
    const pick = (keys: readonly string[], from: Record<string, unknown>) =>
      Object.fromEntries(keys.map((k) => [k, from[k]]));
    for (const [audit, keys] of [
      ['DUE_DATE_CHANGE', Object.keys(due)],
      ['UPDATE', Object.keys(residual)],
    ] as const) {
      if (keys.length === 0) continue;
      await core.audit(tx, ctx, item.clientId, {
        action: audit,
        entityType: 'risk_item',
        entityId: item.id,
        before: pick(keys, current),
        after: { ...pick(keys, patch), sourceActionId: action.id },
      });
    }
  }

  /**
   * One arrow of the ISO_ACTION machine through the engine, audited as a TRANSITION naming the step: 409 naming the
   * action's state when no arrow leaves it, then 409 naming the subject while it is closed (iso-mock.md).
   */
  async function step<K extends 'completeIsoAction' | 'cancelIsoAction' | 'reopenIsoAction'>(
    call: IsoCall<K>,
    name: Step,
    own: (
      action: IsoAction,
      subject: ActionSubject,
    ) => { ownerId?: string | null; approverId?: string | null },
    change: (action: IsoAction) => Partial<IsoAction>,
    facts: (tx: TenantTx, action: IsoAction) => Promise<Record<string, unknown>>,
    options: { delegated?: (action: IsoAction) => boolean } = {},
  ): Promise<IsoActionView> {
    const { ctx, params, body } = call;
    const permission = {
      COMPLETE: 'isoAction.complete',
      CANCEL: 'isoAction.cancel',
      REOPEN: 'isoAction.reopen',
    } as const;
    return core.keyed(ctx, call.key, async (tx) => {
      const { action, subject, reach } = await loadAction(tx, ctx, params.clientId!, params.id!);
      authorize(ctx, permission[name], isoResource(ctx, 'iso_action', reach, own(action, subject)));
      checkVersion(action, body.version);
      const leaves = ISO_TRANSITIONS.ISO_ACTION.some(
        (a) => a.action === name && a.from.includes(action.state),
      );
      if (!leaves) invalidTransition('iso_action', action.state, name);
      // CANCEL is allowed on a closed subject too, so an action left open there can be cleared away.
      if (name !== 'CANCEL') checkOpenSubject(subject);
      const to = stepTo(
        isoTransition('ISO_ACTION', action.state, name, {
          subjectOpen: subject.lock === null,
          asOf: await core.today(tx, action.clientId),
          ...(await facts(tx, action)),
        }),
        'iso_action',
        action.state,
        name,
      );
      const patch = { ...change(action), state: to } as Partial<IsoAction>;
      const keys = (Object.keys(patch) as (keyof IsoAction)[]).filter(
        (k) => JSON.stringify(action[k]) !== JSON.stringify(patch[k]),
      );
      const updated = await isoActions.update(tx, action.id, action.version, patch);
      await core.audit(tx, ctx, action.clientId, {
        action: 'TRANSITION',
        entityType: 'iso_action',
        entityId: action.id,
        before: Object.fromEntries(keys.map((k) => [k, action[k]])),
        after: { action: name, ...Object.fromEntries(keys.map((k) => [k, updated[k]])) },
        reason: 'reason' in body ? body.reason : null,
        delegated: options.delegated?.(action) ?? false,
      });
      if (name === 'COMPLETE' && subject.riskItem !== undefined) {
        await putControlInPlace(tx, ctx, subject.riskItem, updated);
      }
      return view(tx, ctx, updated, subject);
    });
  }

  return {
    /**
     * By due date, then in the order added. Each action takes its subject's units; AP and OW see their units' actions,
     * those whose subject names them, and their own (plan §3.3). Text and `overdue` are read here, the rest in SQL.
     */
    async listIsoActions({ ctx, params, query }) {
      const clientId = params.clientId!;
      authorize(ctx, 'isoAction.read', { type: 'iso_action', clientId });
      const filter: IsoActionFilter = definedOf({
        managementSystemIds: query.managementSystemId,
        subjectTypes: query.subjectType === undefined ? undefined : [query.subjectType],
        subjectId: query.subjectId,
        ownerId: query.ownerId === 'me' ? ctx.personId : query.ownerId,
        state: query.state,
        dueFrom: query.from,
        dueTo: query.to,
        scope: listScope(ctx, clientId),
      });
      return core.run(ctx, async (tx) => {
        const today = await core.today(tx, clientId);
        const cal = await core.calendar(tx, clientId);
        const all: IsoAction[] = [];
        let cursor: string | null = null;
        do {
          const page = await isoActions.list(tx, clientId, {
            ...filter,
            limit: 200,
            ...(cursor === null ? {} : { cursor }),
          });
          all.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== null);
        const needle = query.q?.toLowerCase();
        const rows = all.filter(
          (a) =>
            (needle === undefined ||
              [a.text, a.resources].some((v) => v?.toLowerCase().includes(needle))) &&
            (query.overdue === undefined ||
              (actionStatus(a, today, cal).timing === 'OVERDUE') === query.overdue),
        );
        const page = pageOf(rows, query);
        const items: IsoActionView[] = [];
        for (const action of page.items) {
          const subject = await actionSubject(tx, clientId, action.subject, false);
          items.push(actionView(ctx, action, subject, today, cal));
        }
        return { ...page, items };
      });
    },

    /**
     * A new OPEN action on an open subject (model §3.12, §6); OW only as the subject's owner. A MAJOR_NC or MINOR_NC
     * finding takes none (its actions go on its nonconformity), nor a GOOD_PRACTICE finding. The action's owner can
     * complete it: an owner or client admin of the subject's unit.
     */
    async createIsoAction({ ctx, params, body }) {
      const clientId = params.clientId!;
      return core.run(ctx, async (tx) => {
        const subject = await actionSubject(tx, clientId, body.subject, true);
        if (!canSee(ctx, subject.reach)) notFound();
        authorize(
          ctx,
          'isoAction.write',
          isoResource(ctx, 'iso_action', subject.reach, { ownerId: subject.ownerId }),
        );
        checkOpenSubject(subject);
        const type = subject.finding?.type;
        if (type === 'MAJOR_NC' || type === 'MINOR_NC') {
          invalid(
            'subject',
            'A MAJOR_NC or MINOR_NC finding takes no actions: add them to its nonconformity',
          );
        }
        if (type === 'GOOD_PRACTICE')
          invalid('subject', 'A GOOD_PRACTICE finding takes no actions');
        await checkSubjectFields(tx, subject, body);
        await core.checkPerson(tx, clientId, body.ownerId, 'ownerId', {
          unitId: subject.unitId,
          roles: OWNER_ROLES,
        });
        const fields = {
          subject: body.subject,
          text: body.text,
          resources: body.resources,
          ownerId: body.ownerId,
          dueOn: body.dueOn,
          doneOn: null,
          state: 'OPEN' as const,
          effectivenessNote: null,
          cancelReason: null,
          controlHierarchy: body.controlHierarchy,
          outputKey: body.outputKey,
        };
        const action = await isoActions.create(tx, { clientId, ...fields });
        await core.audit(tx, ctx, clientId, {
          action: 'CREATE',
          entityType: 'iso_action',
          entityId: action.id,
          after: {
            subject: fields.subject,
            ownerId: fields.ownerId,
            dueOn: fields.dueOn,
            state: fields.state,
            controlHierarchy: fields.controlHierarchy,
            outputKey: fields.outputKey,
          },
        });
        return view(tx, ctx, action, subject);
      });
    },

    async getIsoAction({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const { action, subject, reach } = await loadAction(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoAction.read', isoResource(ctx, 'iso_action', reach));
        return view(tx, ctx, action, subject);
      });
    },

    /**
     * Changes an OPEN action of an open subject; OW only as the subject's owner. A new owner is a REASSIGN and a new
     * `dueOn` a DUE_DATE_CHANGE, each with its reason (model §3.12, §8).
     */
    async updateIsoAction({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { action, subject, reach } = await loadAction(tx, ctx, params.clientId!, params.id!);
        authorize(
          ctx,
          'isoAction.write',
          isoResource(ctx, 'iso_action', reach, { ownerId: subject.ownerId }),
        );
        const { version, reason, ...fields } = body;
        checkVersion(action, version);
        if (action.state !== 'OPEN') invalidTransition('iso_action', action.state, 'UPDATE');
        checkOpenSubject(subject);
        await checkSubjectFields(tx, subject, fields);
        if (fields.ownerId !== undefined && fields.ownerId !== action.ownerId) {
          await core.checkPerson(tx, action.clientId, fields.ownerId, 'ownerId', {
            unitId: subject.unitId,
            roles: OWNER_ROLES,
          });
        }
        const updated = await core.edit(
          tx,
          ctx,
          action,
          fields,
          'iso_action',
          (changes) => isoActions.update(tx, action.id, version, changes),
          { split: { ownerId: 'REASSIGN', dueOn: 'DUE_DATE_CHANGE' }, reason: reason ?? null },
        );
        return view(tx, ctx, updated, subject);
      });
    },

    /**
     * COMPLETE (OPEN → DONE): the action's owner, or a client admin as delegate; `doneOn` not after today; the
     * subject is open. On a risk item it puts the control in place (model §3.5).
     */
    completeIsoAction: (call) =>
      step(
        call,
        'COMPLETE',
        (action) => ({ ownerId: action.ownerId }),
        () => ({
          doneOn: call.body.doneOn,
          ...(call.body.effectivenessNote === undefined
            ? {}
            : { effectivenessNote: call.body.effectivenessNote }),
        }),
        async () => ({ doneOn: call.body.doneOn }),
        { delegated: (action) => action.ownerId !== call.ctx.personId },
      ),

    /**
     * CANCEL (OPEN → CANCELLED): the subject's approver or a client admin, with a reason. Allowed on a closed subject
     * too, so an action left open there can be cleared away.
     */
    cancelIsoAction: (call) =>
      step(
        call,
        'CANCEL',
        (_action, subject) => ({ approverId: subject.approverId }),
        () => ({ cancelReason: call.body.reason }),
        async () => ({ reason: call.body.reason }),
      ),

    /** REOPEN (DONE or CANCELLED → OPEN): a client admin, with a reason, while the subject is open (model §3.12). */
    reopenIsoAction: (call) =>
      step(
        call,
        'REOPEN',
        () => ({}),
        () => ({ doneOn: null, cancelReason: null }),
        async () => ({ reason: call.body.reason }),
      ),
  };
}
