// Mock handlers for the ISO add-on: Risk items and controls, objectives and readings (model §3.5, §3.6).
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
import type { z } from 'zod';
import type { ObjectiveView, RiskItemView } from '../../../api/iso.js';
import { DEFAULT_ISO_RISK_RULE } from '../../../defaults.js';
import { RiskItem } from '../../../schemas/iso.js';
import { type Actor, diff, matches, notFound, paginate } from '../../core.js';
import { actorOf, type PartialHandlers } from '../../handler.js';
import {
  canSee,
  checkIsoPerson,
  checkIsoVersion,
  checkSystemUnits,
  invalid,
  invalidTransition,
  type IsoCtx,
  type IsoEntity,
  isoAudit,
  isoFresh,
  type IsoReach,
  isoScope,
  liveIso,
  patchIso,
  reachOf,
  requireIso,
  requireSystem,
  standardOf,
  systemUnitIds,
  touchIso,
} from '../../iso/common.js';
import {
  isoTiming,
  isSignificant,
  localDate,
  objectiveProgress,
  riskRating,
} from '../../iso/derive.js';
import type { FirmState, AuditRecord, IsoRow } from '../../store.js';

type Ids =
  | 'listIsoRisks'
  | 'createIsoRisk'
  | 'getIsoRisk'
  | 'updateIsoRisk'
  | 'archiveIsoRisk'
  | 'reviewIsoRisk'
  | 'setIsoRiskSignificance'
  | 'listIsoRiskControls'
  | 'createIsoRiskControl'
  | 'updateIsoRiskControl'
  | 'archiveIsoRiskControl'
  | 'listIsoObjectives'
  | 'createIsoObjective'
  | 'getIsoObjective'
  | 'updateIsoObjective'
  | 'closeIsoObjective'
  | 'listIsoReadings'
  | 'createIsoReading'
  | 'updateIsoReading';

type Risk = IsoRow<'riskItems'>;
type Control = IsoRow<'riskControls'>;
type Objective = IsoRow<'objectives'>;
type Reading = IsoRow<'readings'>;
type RiskOut = z.input<typeof RiskItemView>;
type ObjectiveOut = z.input<typeof ObjectiveView>;

// ---------- lookups and reach ----------

/** A risk item takes its own unit, else its management system's units; its owner always sees it (plan §3.3). */
const riskReach = (firm: FirmState, item: Risk): IsoReach =>
  reachOf(firm, {
    clientId: item.clientId,
    unitId: item.unitId,
    systemId: item.managementSystemId,
    people: [item.ownerId],
  });

/** An objective has no unit of its own: it takes its management system's units; its owner always sees it. */
const objectiveReach = (firm: FirmState, objective: Objective): IsoReach =>
  reachOf(firm, {
    clientId: objective.clientId,
    systemId: objective.managementSystemId,
    people: [objective.ownerId],
  });

const requireRisk = (actor: Actor, clientId: string | undefined, id: string | undefined) =>
  requireIso(actor.firm, 'riskItems', clientId!, id!);

const requireObjective = (actor: Actor, clientId: string | undefined, id: string | undefined) =>
  requireIso(actor.firm, 'objectives', clientId!, id!);

/** A live control of `item`, or 404 (another item's control included). */
function requireControl(firm: FirmState, item: Risk, id: string | undefined): Control {
  const control = requireIso(firm, 'riskControls', item.clientId, id!);
  if (control.riskItemId !== item.id) throw notFound();
  return control;
}

/** A live reading of `objective`, or 404 (another objective's reading included). */
function requireReading(firm: FirmState, objective: Objective, id: string | undefined): Reading {
  const reading = requireIso(firm, 'readings', objective.clientId, id!);
  if (reading.objectiveId !== objective.id) throw notFound();
  return reading;
}

const readingsOf = (firm: FirmState, objective: Objective) =>
  liveIso(firm, 'readings', objective.clientId).filter((r) => r.objectiveId === objective.id);

/** `?ownerId=me` is the signed-in person. */
const personRef = (actor: Actor, ref: string | undefined) => (ref === 'me' ? actor.person.id : ref);

/** The record's management system, archived or not. */
const systemOf = (firm: FirmState, record: { managementSystemId: string }) =>
  firm.iso.managementSystems.find((s) => s.id === record.managementSystemId)!;

const clientOf = (firm: FirmState, clientId: string) =>
  firm.data.clients.find((c) => c.id === clientId)!;

// ---------- derived values ----------

/** The firm's significance rule (`FirmSettings.isoRisk`, not editable in v1). */
const riskRule = (firm: FirmState) => firm.data.firm.settings.isoRisk ?? DEFAULT_ISO_RISK_RULE;

/**
 * The engine's stored results on a risk item (model §1.7): `rating` and `residualRating` from `riskRating`, and
 * `significant` from `isSignificant` on the rating with existing controls.
 */
function rated(
  firm: FirmState,
  item: Pick<
    Risk,
    | 'likelihood'
    | 'severity'
    | 'residualLikelihood'
    | 'residualSeverity'
    | 'obligationIds'
    | 'significantOverride'
  >,
): Pick<Risk, 'rating' | 'residualRating' | 'significant'> {
  const rating = riskRating(item.likelihood, item.severity);
  const residualRating =
    item.residualLikelihood == null || item.residualSeverity == null
      ? null
      : riskRating(item.residualLikelihood, item.residualSeverity);
  const significant = isSignificant(
    {
      rating,
      significantOverride: item.significantOverride,
      legalLinked: item.obligationIds.length > 0,
    },
    riskRule(firm),
  );
  return { rating, residualRating, significant };
}

// ---------- views ----------

/** The item with `reviewDue` (model §5.2); an archived item is no longer reviewed. */
function riskView(ctx: IsoCtx, actor: Actor, item: Risk): RiskOut {
  return {
    ...item,
    reviewStatus: isoTiming(
      item.reviewDueOn,
      item.archivedAt !== null,
      ctx.clock.today(),
      actor.firm.data.firm.settings.dueSoonDays,
    ),
  };
}

/** The objective with its progress; a closed one is measured as at the day it closed. */
function objectiveView(ctx: IsoCtx, actor: Actor, objective: Objective): ObjectiveOut {
  const today = ctx.clock.today();
  const asOf =
    objective.closedOn !== null && objective.closedOn < today ? objective.closedOn : today;
  const settings = clientOf(actor.firm, objective.clientId).settings;
  return {
    ...objective,
    progress: objectiveProgress(objective, readingsOf(actor.firm, objective), asOf, settings),
  };
}

// ---------- checks ----------

/**
 * Legal links are live statutory obligations of the account (model §3.5): not archived, and not an activity of a
 * STANDARD act from the ISO catalogue copy (an act without a kind is a STATUTE).
 */
function checkObligations(firm: FirmState, obligationIds: readonly string[]): void {
  for (const id of obligationIds) {
    const obligation = firm.data.obligations.find((o) => o.id === id && o.archivedAt === null);
    const act = firm.data.acts.find((a) => a.id === obligation?.actId);
    if (obligation === undefined || act?.kind === 'STANDARD') {
      invalid('obligationIds', 'Not a statutory obligation of this account');
    }
  }
}

/** The kind rules of model §3.5 on the item as it will be stored (the record schema's own checks). */
function checkRiskRecord(item: Risk): void {
  const parsed = RiskItem.safeParse(item);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    invalid(String(issue.path[0] ?? 'body'), issue.message);
  }
}

/** Each standard is one of the system's (model §3.6). */
function checkStandards(
  firm: FirmState,
  system: IsoRow<'managementSystems'>,
  standards: readonly string[],
): void {
  const codes = system.standardIds.map((id) => standardOf(firm, id)?.code);
  if (standards.some((code) => !codes.includes(code as (typeof codes)[number]))) {
    invalid('standards', "Not a standard of the objective's management system");
  }
}

/** The risk items an objective addresses are live items of its own management system. */
function checkRiskItems(
  firm: FirmState,
  system: IsoRow<'managementSystems'>,
  riskItemIds: readonly string[],
): void {
  const items = liveIso(firm, 'riskItems', system.clientId).filter(
    (r) => r.managementSystemId === system.id,
  );
  if (riskItemIds.some((id) => !items.some((r) => r.id === id))) {
    invalid('riskItemIds', 'Not a risk item of this management system');
  }
}

/** The create body's target rule on the merged objective: INCREASE not below the baseline, DECREASE not above it. */
function checkTarget(objective: Objective): void {
  const { baseline, target, direction } = objective;
  if (baseline === null) return;
  if (direction === 'INCREASE' && target < baseline) {
    invalid('target', 'An INCREASE objective has a target at or above its baseline');
  }
  if (direction === 'DECREASE' && target > baseline) {
    invalid('target', 'A DECREASE objective has a target at or below its baseline');
  }
}

/** A closed objective takes no field edits and no new or corrected readings (model §1.8). */
function requireOpen(objective: Objective): void {
  if (objective.closedOn !== null) invalidTransition('objective', 'CLOSED', 'UPDATE');
}

/** A HAZARD's controls name their place in the hierarchy of controls (model §3.5). */
function checkHierarchy(item: Risk, hierarchy: Control['hierarchy'] | undefined): void {
  if (item.kind === 'HAZARD' && hierarchy === null) {
    invalid('hierarchy', 'A control on a HAZARD names its place in the hierarchy of controls');
  }
}

// ---------- writes ----------

/** Base fields, left out of CREATE audit events. */
const BASE_FIELDS = new Set([
  'id',
  'firmId',
  'clientId',
  'createdAt',
  'updatedAt',
  'archivedAt',
  'version',
]);
const fieldsOf = (row: object) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !BASE_FIELDS.has(k)));

/**
 * Applies an edit and audits it per model §8: a change of owner is a REASSIGN and of a due date a DUE_DATE_CHANGE, each
 * with the body's reason, the rest one UPDATE. The caller has checked the version; nothing is written without a change.
 */
function applyEdit<T extends { id: string; clientId: string; version: number; updatedAt: string }>(
  ctx: IsoCtx,
  actor: Actor,
  row: T,
  patch: Partial<T>,
  entityType: IsoEntity,
  dueField: string,
  reason: string | null = null,
): void {
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
  const changes = diff(row, { ...row, ...defined });
  const changed = Object.keys(changes.after);
  if (changed.length === 0) return;
  Object.assign(row, defined);
  touchIso(ctx, row);
  const groups: [AuditRecord['action'], string[]][] = [
    ['REASSIGN', changed.filter((k) => k === 'ownerId')],
    ['DUE_DATE_CHANGE', changed.filter((k) => k === dueField)],
    ['UPDATE', changed.filter((k) => k !== 'ownerId' && k !== dueField)],
  ];
  for (const [action, keys] of groups) {
    if (keys.length === 0) continue;
    isoAudit(ctx, actor, {
      action,
      entityType,
      entityId: row.id,
      clientId: row.clientId,
      before: Object.fromEntries(keys.map((k) => [k, changes.before[k]])),
      after: Object.fromEntries(keys.map((k) => [k, changes.after[k]])),
      reason: action === 'UPDATE' ? null : reason,
    });
  }
}

/** Archives a row (no deletes, model §1.3) and audits it with its reason. */
function archive(
  ctx: IsoCtx,
  actor: Actor,
  row: {
    id: string;
    clientId: string;
    version: number;
    updatedAt: string;
    archivedAt: string | null;
  },
  entityType: IsoEntity,
  reason: string,
): void {
  row.archivedAt = ctx.clock.now();
  touchIso(ctx, row);
  isoAudit(ctx, actor, {
    action: 'ARCHIVE',
    entityType,
    entityId: row.id,
    clientId: row.clientId,
    before: { archivedAt: null },
    after: { archivedAt: row.archivedAt },
    reason,
  });
}

// ---------- handlers ----------

export const risksHandlers: PartialHandlers<Ids> = {
  /** Highest rating first, then in the order added. AP and OW see their units' items and the items they own. */
  listIsoRisks(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const q = ctx.query;
    const ownerId = personRef(actor, q.ownerId);
    const rows = actor.firm.iso.riskItems
      .filter(
        (r) =>
          r.clientId === clientId &&
          (q.includeArchived === true || r.archivedAt === null) &&
          (q.managementSystemId === undefined ||
            q.managementSystemId.includes(r.managementSystemId)) &&
          (q.unitId === undefined || (r.unitId !== null && q.unitId.includes(r.unitId))) &&
          (q.kind === undefined || q.kind.includes(r.kind)) &&
          (q.significant === undefined || r.significant === q.significant) &&
          (q.climateRelated === undefined || r.climateRelated === q.climateRelated) &&
          (ownerId === undefined || r.ownerId === ownerId) &&
          matches(q.q, r.activity, r.description, r.impact) &&
          canSee(actor, riskReach(actor.firm, r)),
      )
      .sort((a, b) => b.rating - a.rating || a.createdAt.localeCompare(b.createdAt));
    return paginate(
      rows.map((r) => riskView(ctx, actor, r)),
      q,
    );
  },

  createIsoRisk(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    const body = ctx.body;
    const system = requireSystem(actor.firm, clientId, body.managementSystemId);
    // The creator must see the item's unit (or, without one, the system); an owner adds items only as their owner.
    const unitOk = body.unitId === null || systemUnitIds(actor.firm, system).includes(body.unitId);
    ctx.authorize(
      isoScope(
        actor,
        reachOf(actor.firm, {
          clientId,
          unitId: unitOk ? body.unitId : null,
          systemId: system.id,
        }),
        { ownerId: body.ownerId },
      ),
    );
    if (body.unitId !== null) checkSystemUnits(actor.firm, system, [body.unitId], 'unitId');
    checkIsoPerson(actor, clientId, body.ownerId, 'ownerId', { unitId: body.unitId });
    checkObligations(actor.firm, body.obligationIds);
    const { managementSystemId, ...fields } = body;
    const item: Risk = {
      ...isoFresh(ctx, actor, clientId),
      managementSystemId,
      ...fields,
      significantOverride: null,
      significanceReason: null,
      lastReviewedOn: null,
      ...rated(actor.firm, { ...fields, significantOverride: null }),
    };
    actor.firm.iso.riskItems.push(item);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'risk_item',
      entityId: item.id,
      clientId,
      after: fieldsOf(item),
    });
    return riskView(ctx, actor, item);
  },

  getIsoRisk(ctx) {
    const actor = actorOf(ctx);
    const item = requireRisk(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, riskReach(actor.firm, item)));
    return riskView(ctx, actor, item);
  },

  /**
   * Field edits and re-rating; `kind` never changes and the item must still meet its kind's rules. Rating, residual
   * rating and significance are recomputed and stored (model §1.7).
   */
  updateIsoRisk(ctx) {
    const actor = actorOf(ctx);
    const item = requireRisk(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, riskReach(actor.firm, item), { ownerId: item.ownerId }));
    const { version, reason, ...fields } = ctx.body;
    checkIsoVersion(item, version);
    const defined = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    ) as Partial<Risk>;
    const merged: Risk = { ...item, ...defined };
    Object.assign(merged, rated(actor.firm, merged));
    if (merged.unitId !== null && merged.unitId !== item.unitId) {
      checkSystemUnits(actor.firm, systemOf(actor.firm, item), [merged.unitId], 'unitId');
    }
    if (merged.ownerId !== item.ownerId || merged.unitId !== item.unitId) {
      checkIsoPerson(actor, item.clientId, merged.ownerId, 'ownerId', { unitId: merged.unitId });
    }
    if (fields.obligationIds !== undefined) checkObligations(actor.firm, fields.obligationIds);
    checkRiskRecord(merged);
    const { rating, residualRating, significant } = merged;
    applyEdit(
      ctx,
      actor,
      item,
      { ...defined, rating, residualRating, significant },
      'risk_item',
      'reviewDueOn',
      reason ?? null,
    );
    return riskView(ctx, actor, item);
  },

  /** The item leaves the register, and its controls with it; its actions can no longer be reopened (model §3.12). */
  archiveIsoRisk(ctx) {
    const actor = actorOf(ctx);
    const item = requireRisk(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, riskReach(actor.firm, item), { ownerId: item.ownerId }));
    checkIsoVersion(item, ctx.body.version);
    archive(ctx, actor, item, 'risk_item', ctx.body.reason);
    return riskView(ctx, actor, item);
  },

  /** REVIEW: the item stands as rated; sets `lastReviewedOn` and the next review date, nothing else. */
  reviewIsoRisk(ctx) {
    const actor = actorOf(ctx);
    const item = requireRisk(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, riskReach(actor.firm, item), { ownerId: item.ownerId }));
    const body = ctx.body;
    checkIsoVersion(item, body.version);
    const today = ctx.clock.today();
    if (body.nextReviewDueOn <= today) {
      invalid('nextReviewDueOn', 'The next review date is after today');
    }
    const before = { lastReviewedOn: item.lastReviewedOn, reviewDueOn: item.reviewDueOn };
    item.lastReviewedOn = today;
    item.reviewDueOn = body.nextReviewDueOn;
    touchIso(ctx, item);
    isoAudit(ctx, actor, {
      action: 'TRANSITION',
      entityType: 'risk_item',
      entityId: item.id,
      clientId: item.clientId,
      before,
      after: {
        action: 'REVIEW',
        lastReviewedOn: today,
        reviewDueOn: item.reviewDueOn,
        ...(body.note === undefined ? {} : { note: body.note }),
      },
      delegated: actor.person.id !== item.ownerId,
    });
    return riskView(ctx, actor, item);
  },

  /** Sets (true or false) or clears (null) the override, with its reason; `significant` is recomputed. */
  setIsoRiskSignificance(ctx) {
    const actor = actorOf(ctx);
    const item = requireRisk(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, riskReach(actor.firm, item)));
    const { version, significantOverride, reason } = ctx.body;
    patchIso(
      ctx,
      actor,
      item,
      version,
      {
        significantOverride,
        significanceReason: significantOverride === null ? null : reason,
        significant: rated(actor.firm, { ...item, significantOverride }).significant,
      },
      'risk_item',
      { reason },
    );
    return riskView(ctx, actor, item);
  },

  /** Controls in place, in the order added. */
  listIsoRiskControls(ctx) {
    const actor = actorOf(ctx);
    const item = requireRisk(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, riskReach(actor.firm, item)));
    const items = liveIso(actor.firm, 'riskControls', item.clientId)
      .filter((c) => c.riskItemId === item.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { items };
  },

  /** A control put in place by hand (`sourceActionId` null); a completed treatment action adds its own. */
  createIsoRiskControl(ctx) {
    const actor = actorOf(ctx);
    const item = requireRisk(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, riskReach(actor.firm, item), { ownerId: item.ownerId }));
    checkHierarchy(item, ctx.body.hierarchy);
    const control: Control = {
      ...isoFresh(ctx, actor, item.clientId),
      riskItemId: item.id,
      text: ctx.body.text,
      hierarchy: ctx.body.hierarchy,
      sourceActionId: null,
    };
    actor.firm.iso.riskControls.push(control);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'risk_control',
      entityId: control.id,
      clientId: control.clientId,
      after: fieldsOf(control),
    });
    return control;
  },

  updateIsoRiskControl(ctx) {
    const actor = actorOf(ctx);
    const item = requireRisk(actor, ctx.params.clientId, ctx.params.id);
    const control = requireControl(actor.firm, item, ctx.params.controlId);
    ctx.authorize(isoScope(actor, riskReach(actor.firm, item), { ownerId: item.ownerId }));
    const { version, ...fields } = ctx.body;
    checkIsoVersion(control, version);
    checkHierarchy(item, fields.hierarchy);
    return patchIso(ctx, actor, control, version, fields, 'risk_control');
  },

  archiveIsoRiskControl(ctx) {
    const actor = actorOf(ctx);
    const item = requireRisk(actor, ctx.params.clientId, ctx.params.id);
    const control = requireControl(actor.firm, item, ctx.params.controlId);
    ctx.authorize(isoScope(actor, riskReach(actor.firm, item), { ownerId: item.ownerId }));
    checkIsoVersion(control, ctx.body.version);
    archive(ctx, actor, control, 'risk_control', ctx.body.reason);
    return control;
  },

  /** Earliest `dueOn` first, then in the order added. AP and OW see their system's objectives and the ones they own. */
  listIsoObjectives(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const q = ctx.query;
    const ownerId = personRef(actor, q.ownerId);
    const rows = liveIso(actor.firm, 'objectives', clientId)
      .filter(
        (o) =>
          (q.managementSystemId === undefined ||
            q.managementSystemId.includes(o.managementSystemId)) &&
          (q.standard === undefined || o.standards.some((s) => q.standard!.includes(s))) &&
          (ownerId === undefined || o.ownerId === ownerId) &&
          (q.open === undefined || (o.closedOn === null) === q.open) &&
          matches(q.q, o.text, o.unitOfMeasure) &&
          canSee(actor, objectiveReach(actor.firm, o)),
      )
      .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.createdAt.localeCompare(b.createdAt));
    return paginate(
      rows.map((o) => objectiveView(ctx, actor, o)),
      q,
    );
  },

  createIsoObjective(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    const body = ctx.body;
    const system = requireSystem(actor.firm, clientId, body.managementSystemId);
    // The creator must see the system; an owner adds objectives only as their owner.
    ctx.authorize(
      isoScope(actor, reachOf(actor.firm, { clientId, systemId: system.id }), {
        ownerId: body.ownerId,
      }),
    );
    checkStandards(actor.firm, system, body.standards);
    checkRiskItems(actor.firm, system, body.riskItemIds);
    checkIsoPerson(actor, clientId, body.ownerId, 'ownerId');
    const objective: Objective = {
      ...isoFresh(ctx, actor, clientId),
      ...body,
      closedOn: null,
      outcome: null,
    };
    actor.firm.iso.objectives.push(objective);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'objective',
      entityId: objective.id,
      clientId,
      after: fieldsOf(objective),
    });
    return objectiveView(ctx, actor, objective);
  },

  getIsoObjective(ctx) {
    const actor = actorOf(ctx);
    const objective = requireObjective(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, objectiveReach(actor.firm, objective)));
    return objectiveView(ctx, actor, objective);
  },

  /** Field edits on an open objective; a new owner or `dueOn` carries its reason on the REASSIGN or DUE_DATE_CHANGE. */
  updateIsoObjective(ctx) {
    const actor = actorOf(ctx);
    const objective = requireObjective(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(
      isoScope(actor, objectiveReach(actor.firm, objective), { ownerId: objective.ownerId }),
    );
    const { version, reason, ...fields } = ctx.body;
    checkIsoVersion(objective, version);
    requireOpen(objective);
    const system = systemOf(actor.firm, objective);
    if (fields.standards !== undefined) checkStandards(actor.firm, system, fields.standards);
    if (fields.riskItemIds !== undefined) checkRiskItems(actor.firm, system, fields.riskItemIds);
    if (fields.ownerId !== undefined) {
      checkIsoPerson(actor, objective.clientId, fields.ownerId, 'ownerId');
    }
    const defined = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    ) as Partial<Objective>;
    checkTarget({ ...objective, ...defined });
    applyEdit(ctx, actor, objective, defined, 'objective', 'dueOn', reason ?? null);
    return objectiveView(ctx, actor, objective);
  },

  /** Ends the objective with its outcome; from then on it takes no edits and no readings. */
  closeIsoObjective(ctx) {
    const actor = actorOf(ctx);
    const objective = requireObjective(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(
      isoScope(actor, objectiveReach(actor.firm, objective), { ownerId: objective.ownerId }),
    );
    const { version, closedOn, outcome } = ctx.body;
    checkIsoVersion(objective, version);
    if (objective.closedOn !== null) invalidTransition('objective', 'CLOSED', 'CLOSE');
    if (closedOn > ctx.clock.today()) invalid('closedOn', 'An objective cannot close after today');
    const timeZone = clientOf(actor.firm, objective.clientId).settings.timeZone;
    if (closedOn < localDate(objective.createdAt, timeZone)) {
      invalid('closedOn', 'An objective cannot close before it was set');
    }
    objective.closedOn = closedOn;
    objective.outcome = outcome;
    touchIso(ctx, objective);
    isoAudit(ctx, actor, {
      action: 'TRANSITION',
      entityType: 'objective',
      entityId: objective.id,
      clientId: objective.clientId,
      before: { closedOn: null, outcome: null },
      after: { action: 'CLOSE', closedOn, outcome },
      delegated: actor.person.id !== objective.ownerId,
    });
    return objectiveView(ctx, actor, objective);
  },

  /** By period: earliest `periodStart` first. */
  listIsoReadings(ctx) {
    const actor = actorOf(ctx);
    const objective = requireObjective(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, objectiveReach(actor.firm, objective)));
    const items = readingsOf(actor.firm, objective).sort(
      (a, b) =>
        a.periodStart.localeCompare(b.periodStart) ||
        a.periodEnd.localeCompare(b.periodEnd) ||
        a.createdAt.localeCompare(b.createdAt),
    );
    return { items };
  },

  /** A reading of a period that has started, overlapping no other reading of the objective. */
  createIsoReading(ctx) {
    const actor = actorOf(ctx);
    const objective = requireObjective(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(
      isoScope(actor, objectiveReach(actor.firm, objective), { ownerId: objective.ownerId }),
    );
    requireOpen(objective);
    const body = ctx.body;
    if (body.periodStart > ctx.clock.today()) {
      invalid('periodStart', 'A reading is for a period that has started');
    }
    const clash = readingsOf(actor.firm, objective).find(
      (r) => r.periodStart <= body.periodEnd && r.periodEnd >= body.periodStart,
    );
    if (clash !== undefined) {
      invalid(
        'periodStart',
        `Overlaps the reading for ${clash.periodStart} to ${clash.periodEnd}; correct that reading instead`,
      );
    }
    const reading: Reading = {
      ...isoFresh(ctx, actor, objective.clientId),
      objectiveId: objective.id,
      ...body,
      recordedById: actor.person.id,
    };
    actor.firm.iso.readings.push(reading);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'objective_reading',
      entityId: reading.id,
      clientId: reading.clientId,
      after: fieldsOf(reading),
    });
    return reading;
  },

  /** Corrects a reading's value or note; its period never changes. */
  updateIsoReading(ctx) {
    const actor = actorOf(ctx);
    const objective = requireObjective(actor, ctx.params.clientId, ctx.params.id);
    const reading = requireReading(actor.firm, objective, ctx.params.readingId);
    ctx.authorize(
      isoScope(actor, objectiveReach(actor.firm, objective), { ownerId: objective.ownerId }),
    );
    const { version, ...fields } = ctx.body;
    checkIsoVersion(reading, version);
    requireOpen(objective);
    return patchIso(ctx, actor, reading, version, fields, 'objective_reading');
  },
};
