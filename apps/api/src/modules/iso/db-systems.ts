import type {
  ClauseAssessment,
  ClauseAssessmentView,
  ClauseNaAction,
  IsoClause,
  ManagementSystem,
  RequestContext,
} from '@canopy/contracts';
import {
  clauseAssessments,
  contextItems,
  isoCatalogue,
  managementSystems,
  units,
  type ClauseAssessmentRow,
  type TenantTx,
} from '@canopy/db';
import { isoMayCheck, isoTransition } from '@canopy/engine';
import {
  authorize,
  canSee,
  checklistRowReach,
  holdsRole,
  isManager,
  isoResource,
  listScope,
  may,
  systemReach,
  unitResource,
} from './access.js';
import { definedOf, same, type Core } from './db-context.js';
import { checkVersion, forbidden, invalid, invalidTransition, notFound, stepTo } from './errors.js';
import type { IsoCall, IsoHandlers } from './types.js';

/**
 * Catalogue reads, management systems with their climate decision, context items and the clause checklist with its
 * N/A machine (docs/iso/model.md §2, §3.1-3.3, §4.6; plan §3.2-3.3). The mock's picks (docs/contracts/iso-mock.md
 * "Systems and checklist") hold here.
 */

type Ids =
  | 'listIsoStandards'
  | 'listIsoClauses'
  | 'listIsoReviewDefs'
  | 'listIsoSystems'
  | 'createIsoSystem'
  | 'getIsoSystem'
  | 'updateIsoSystem'
  | 'setIsoClimateDecision'
  | 'listIsoContextItems'
  | 'createIsoContextItem'
  | 'updateIsoContextItem'
  | 'archiveIsoContextItem'
  | 'listIsoChecklist'
  | 'updateIsoChecklistRow'
  | 'requestIsoClauseNa'
  | 'approveIsoClauseNa'
  | 'rejectIsoClauseNa'
  | 'withdrawIsoClauseNa';

const KIND_ORDER = ['INTERNAL_ISSUE', 'EXTERNAL_ISSUE', 'INTERESTED_PARTY'];

const NA_FIELDS = [
  'status',
  'naState',
  'statusBeforeNa',
  'justification',
  'naRequestedById',
  'naDecidedById',
  'naDecidedAt',
] as const;

/** Clause numbers in document order: "4.10" after "4.9", "8" before "8.1". */
function compareNumbers(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** Standard ids from the account's catalogue, one edition per standard (400 VALIDATION otherwise). */
async function checkStandards(tx: TenantTx, standardIds: readonly string[]): Promise<void> {
  const standards = await isoCatalogue.standards(tx);
  const codes = standardIds.map((id) => {
    const standard = standards.find((s) => s.id === id);
    if (standard === undefined) {
      invalid('standardIds', "Not a standard in the account's ISO catalogue");
    }
    return standard.code;
  });
  if (new Set(codes).size !== codes.length) invalid('standardIds', 'One edition per standard');
}

/** Each unit is a live unit of the client. */
async function checkClientUnits(
  tx: TenantTx,
  clientId: string,
  unitIds: readonly string[],
): Promise<void> {
  for (const id of unitIds) {
    const unit = await units.get(tx, id);
    if (unit === null || unit.clientId !== clientId || unit.archivedAt !== null) {
      invalid('unitIds', 'Not a unit of this client');
    }
  }
}

export function systemsHandlers(core: Core): IsoHandlers<Ids> {
  /** Adds the NOT_STARTED rows of these standards to the system (model §3.3), each audited as a CREATE. */
  async function addChecklistRows(
    tx: TenantTx,
    ctx: RequestContext,
    system: ManagementSystem,
    standardIds: readonly string[],
  ): Promise<void> {
    if (standardIds.length === 0) return;
    for (const row of await clauseAssessments.addForStandards(tx, system, standardIds)) {
      await core.audit(tx, ctx, system.clientId, {
        action: 'CREATE',
        entityType: 'clause_assessment',
        entityId: row.id,
        after: { managementSystemId: system.id, clauseId: row.clauseId, status: row.status },
      });
    }
  }

  /** The N/A steps the actor may take on a row now: model §4.6 states, plan §3.2 roles, never the requester's decision. */
  function naActions(
    ctx: RequestContext,
    system: ManagementSystem,
    row: ClauseAssessment,
    exclusionAllowed: boolean,
  ): ClauseNaAction[] {
    const reach = checklistRowReach(system, row);
    const own = isoResource(ctx, 'clause_assessment', reach, { ownerId: row.ownerId });
    const actions: ClauseNaAction[] = [];
    const requestable = row.naState === 'NONE' || row.naState === 'REJECTED';
    if (requestable && exclusionAllowed && may(ctx, 'isoChecklist.requestNa', own)) {
      actions.push('REQUEST_NA');
    }
    if (
      row.naState === 'REQUESTED' &&
      row.naRequestedById !== ctx.personId &&
      may(ctx, 'isoChecklist.decideNa', unitResource('clause_assessment', reach))
    ) {
      actions.push('APPROVE_NA', 'REJECT_NA');
    }
    if (row.naState === 'APPROVED' && may(ctx, 'isoChecklist.requestNa', own)) {
      actions.push('WITHDRAW_NA');
    }
    return actions;
  }

  function rowView(
    ctx: RequestContext,
    system: ManagementSystem,
    row: ClauseAssessment,
    clause: Pick<IsoClause, 'standardId' | 'number' | 'title' | 'exclusionAllowed'>,
  ): ClauseAssessmentView {
    return {
      ...row,
      standardId: clause.standardId,
      clauseNumber: clause.number,
      clauseTitle: clause.title,
      exclusionAllowed: clause.exclusionAllowed,
      allowedActions: naActions(ctx, system, row, clause.exclusionAllowed),
    };
  }

  /**
   * Loads the row a checklist route names (404 when the actor cannot see it) and runs the role check: `own` scopes to
   * the row's owner; an N/A decision has no `own` grant, so being the owner widens nothing (plan §3.3).
   */
  async function checklistRow(
    tx: TenantTx,
    call: Pick<IsoCall<Ids>, 'ctx' | 'params'>,
    action: 'isoChecklist.write' | 'isoChecklist.requestNa' | 'isoChecklist.decideNa',
  ) {
    const { ctx, params } = call;
    const system = await core.liveSystem(tx, params.clientId!, params.id!);
    const row = await clauseAssessments.get(tx, params.rowId!);
    if (row === null || row.managementSystemId !== system.id || row.archivedAt !== null) {
      notFound();
    }
    const reach = checklistRowReach(system, row);
    if (!canSee(ctx, reach)) notFound();
    authorize(
      ctx,
      action,
      action === 'isoChecklist.decideNa'
        ? unitResource('clause_assessment', reach)
        : isoResource(ctx, 'clause_assessment', reach, { ownerId: row.ownerId }),
    );
    const clause = (await isoCatalogue.clause(tx, row.clauseId))!;
    return { system, row, reach, clause };
  }

  /**
   * One clause N/A arrow (model §4.6) through the engine: version, then the from-state (409), the maker-checker rule
   * (403), the guards (400 or 422), then the change, audited as a TRANSITION naming the action.
   */
  async function naStep(
    call: Pick<IsoCall<Ids>, 'ctx' | 'params' | 'key'> & {
      body: { version: number; reason?: string; comment?: string };
    },
    action: ClauseNaAction,
    access: 'isoChecklist.requestNa' | 'isoChecklist.decideNa',
    change: (row: ClauseAssessment, now: string) => Partial<ClauseAssessment>,
  ) {
    const { ctx, body } = call;
    return core.keyed(ctx, call.key, async (tx) => {
      const { system, row, reach, clause } = await checklistRow(tx, call, access);
      checkVersion(row, body.version);
      const result = isoTransition('CLAUSE_NA', row.naState, action, {
        exclusionAllowed: clause.exclusionAllowed,
        reason: body.reason ?? null,
      });
      if (!result.ok && result.error === 'INVALID_TRANSITION') {
        invalidTransition('clause_assessment', row.naState, action);
      }
      if (
        !isoMayCheck(
          'CLAUSE_NA',
          action,
          ctx.personId,
          await core.steps(tx, 'clause_assessment', row.id),
        )
      ) {
        forbidden(access, 'The requester does not decide their own N/A request');
      }
      stepTo(result, 'clause_assessment', row.naState, action);
      const patch = change(row, core.now());
      const updated = await clauseAssessments.update(tx, row.id, row.version, patch);
      const before = Object.fromEntries(NA_FIELDS.map((f) => [f, row[f]]));
      const after = Object.fromEntries(NA_FIELDS.map((f) => [f, updated[f]]));
      const changed = NA_FIELDS.filter((f) => !same(before[f], after[f]));
      const delegated =
        access === 'isoChecklist.decideNa'
          ? !holdsRole(ctx, row.clientId, ['APPROVER'], reach.unitIds)
          : row.ownerId !== ctx.personId;
      await core.audit(tx, ctx, row.clientId, {
        action: 'TRANSITION',
        entityType: 'clause_assessment',
        entityId: row.id,
        before: Object.fromEntries(changed.map((f) => [f, before[f]])),
        after: { action, ...Object.fromEntries(changed.map((f) => [f, after[f]])) },
        reason: body.reason ?? body.comment ?? null,
        delegated,
      });
      return rowView(ctx, system, updated, clause);
    });
  }

  return {
    // Catalogue: the account's copy, read by every member (model §2).
    async listIsoStandards({ ctx, params }) {
      authorize(ctx, 'isoSystem.read', { type: 'management_system', clientId: params.clientId! });
      return core.run(ctx, async (tx) => ({ items: await isoCatalogue.standards(tx) }));
    },

    async listIsoClauses({ ctx, params, query }) {
      authorize(ctx, 'isoSystem.read', { type: 'management_system', clientId: params.clientId! });
      return core.run(ctx, async (tx) => ({
        items: await isoCatalogue.clauses(tx, {
          ...(query.standardId === undefined ? {} : { standardIds: query.standardId }),
          ...(query.assessable === undefined ? {} : { assessable: query.assessable }),
        }),
      }));
    },

    async listIsoReviewDefs({ ctx, params, query }) {
      authorize(ctx, 'isoSystem.read', { type: 'management_system', clientId: params.clientId! });
      return core.run(ctx, async (tx) => {
        const standards = (await isoCatalogue.standards(tx)).map((s) => s.id);
        const defs = await isoCatalogue.reviewDefs(
          tx,
          query.standardId === undefined ? {} : { standardIds: query.standardId },
        );
        // By standard in catalogue order (code, edition), then clause number and item, as the mock lists them.
        const order = <T extends { standardId: string; clauseNumber: string; item: string | null }>(
          rows: T[],
        ) =>
          rows.sort(
            (a, b) =>
              standards.indexOf(a.standardId) - standards.indexOf(b.standardId) ||
              compareNumbers(a.clauseNumber, b.clauseNumber) ||
              (a.item ?? '').localeCompare(b.item ?? ''),
          );
        return { inputs: order(defs.inputs), outputs: order(defs.outputs) };
      });
    },

    // Systems: by name; AP and OW see the systems over their units.
    async listIsoSystems({ ctx, params, query }) {
      const clientId = params.clientId!;
      authorize(ctx, 'isoSystem.read', { type: 'management_system', clientId });
      return core.run(ctx, (tx) =>
        managementSystems.list(tx, clientId, {
          limit: query.limit,
          ...definedOf({
            cursor: query.cursor,
            count: query.count,
            status: query.status,
            q: query.q,
          }),
          ...definedOf({ scope: listScope(ctx, clientId) }),
        }),
      );
    },

    async createIsoSystem({ ctx, params, body }) {
      const clientId = params.clientId!;
      authorize(
        ctx,
        'isoSystem.write',
        isoResource(ctx, 'management_system', { clientId, unitIds: body.unitIds, people: [] }),
      );
      return core.run(ctx, async (tx) => {
        await checkStandards(tx, body.standardIds);
        await checkClientUnits(tx, clientId, body.unitIds);
        const system = await managementSystems.create(tx, {
          clientId,
          name: body.name,
          standardIds: body.standardIds,
          scopeStatement: body.scopeStatement,
          unitIds: body.unitIds,
          status: body.status,
          reviewIntervalMonths: body.reviewIntervalMonths,
          climateChangeRelevant: null,
          climateChangeRationale: null,
          climateDecidedOn: null,
        });
        await core.audit(tx, ctx, clientId, {
          action: 'CREATE',
          entityType: 'management_system',
          entityId: system.id,
          after: {
            name: system.name,
            standardIds: system.standardIds,
            scopeStatement: system.scopeStatement,
            unitIds: system.unitIds,
            status: system.status,
            reviewIntervalMonths: system.reviewIntervalMonths,
          },
        });
        await addChecklistRows(tx, ctx, system, system.standardIds);
        return system;
      });
    },

    async getIsoSystem({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const system = await core.loadSystem(tx, ctx, params.clientId!, params.id!);
        authorize(
          ctx,
          'isoSystem.read',
          isoResource(ctx, 'management_system', systemReach(system)),
        );
        return system;
      });
    },

    async updateIsoSystem({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const system = await core.loadSystem(tx, ctx, params.clientId!, params.id!);
        authorize(
          ctx,
          'isoSystem.write',
          isoResource(ctx, 'management_system', systemReach(system)),
        );
        const { version, ...patch } = body;
        checkVersion(system, version);
        let added: string[] = [];
        if (patch.standardIds !== undefined) {
          // The database refuses a dropped standard too (management_system_guard); this answers first.
          if (system.standardIds.some((id) => !patch.standardIds!.includes(id))) {
            invalid('standardIds', 'A standard cannot be dropped from a management system');
          }
          await checkStandards(tx, patch.standardIds);
          added = patch.standardIds.filter((id) => !system.standardIds.includes(id));
          // Keep the system's order and add the new standards after it.
          patch.standardIds = [...system.standardIds, ...added];
        }
        if (patch.unitIds !== undefined) await checkClientUnits(tx, system.clientId, patch.unitIds);
        // The system's status has no machine (model §4), so a status change is a field edit like the others.
        const updated = await core.edit(tx, ctx, system, patch, 'management_system', (changes) =>
          managementSystems.update(tx, system.id, version, changes),
        );
        await addChecklistRows(tx, ctx, updated, added);
        return updated;
      });
    },

    async setIsoClimateDecision({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const system = await core.loadSystem(tx, ctx, params.clientId!, params.id!);
        authorize(
          ctx,
          'isoSystem.write',
          isoResource(ctx, 'management_system', systemReach(system)),
        );
        const { version, ...decision } = body;
        checkVersion(system, version);
        if (decision.climateDecidedOn > (await core.today(tx, system.clientId))) {
          invalid('climateDecidedOn', 'The climate decision cannot be dated after today');
        }
        // The body always carries a decision, so a decided system never returns to undecided (model §3.1).
        return core.edit(tx, ctx, system, decision, 'management_system', (changes) =>
          managementSystems.update(tx, system.id, version, changes),
        );
      });
    },

    // Context items (4.1, 4.2): by kind, then when added.
    async listIsoContextItems({ ctx, params, query }) {
      return core.run(ctx, async (tx) => {
        const system = await core.loadSystem(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoSystem.read', isoResource(ctx, 'context_item', systemReach(system)));
        const items = await contextItems.list(tx, system.id, {
          ...definedOf({
            kind: query.kind,
            climateRelated: query.climateRelated,
            includeArchived: query.includeArchived,
          }),
        });
        items.sort(
          (a, b) =>
            KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
            a.createdAt.localeCompare(b.createdAt) ||
            (a.id < b.id ? -1 : 1),
        );
        return { items };
      });
    },

    async createIsoContextItem({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const system = await core.loadSystem(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoSystem.write', isoResource(ctx, 'context_item', systemReach(system)));
        const item = await contextItems.create(tx, {
          clientId: system.clientId,
          managementSystemId: system.id,
          ...body,
        });
        await core.audit(tx, ctx, item.clientId, {
          action: 'CREATE',
          entityType: 'context_item',
          entityId: item.id,
          after: { managementSystemId: system.id, ...body },
        });
        return item;
      });
    },

    async updateIsoContextItem({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const system = await core.loadSystem(tx, ctx, params.clientId!, params.id!);
        const item = await contextItems.get(tx, params.itemId!);
        if (item === null || item.managementSystemId !== system.id || item.archivedAt !== null) {
          notFound();
        }
        authorize(ctx, 'isoSystem.write', isoResource(ctx, 'context_item', systemReach(system)));
        const { version, ...patch } = body;
        checkVersion(item, version);
        if (item.kind !== 'INTERESTED_PARTY' && patch.needs != null) {
          invalid('needs', 'Only an interested party has needs');
        }
        return core.edit(tx, ctx, item, patch, 'context_item', (changes) =>
          contextItems.update(tx, item.id, version, changes),
        );
      });
    },

    async archiveIsoContextItem({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const system = await core.loadSystem(tx, ctx, params.clientId!, params.id!);
        const item = await contextItems.get(tx, params.itemId!);
        if (item === null || item.managementSystemId !== system.id || item.archivedAt !== null) {
          notFound();
        }
        authorize(ctx, 'isoSystem.write', isoResource(ctx, 'context_item', systemReach(system)));
        checkVersion(item, body.version);
        const archived = await contextItems.archive(tx, item.id, body.version);
        await core.audit(tx, ctx, item.clientId, {
          action: 'ARCHIVE',
          entityType: 'context_item',
          entityId: item.id,
          before: { archivedAt: null },
          after: { archivedAt: archived.archivedAt },
          reason: body.reason,
        });
        return archived;
      });
    },

    // Checklist: by standard and clause number. A row takes its system's units, and its owner always sees it.
    async listIsoChecklist({ ctx, params, query }) {
      const clientId = params.clientId!;
      authorize(ctx, 'isoChecklist.read', { type: 'clause_assessment', clientId });
      return core.run(ctx, async (tx) => {
        const system = await core.liveSystem(tx, clientId, params.id!);
        const ownerId = query.ownerId === 'me' ? ctx.personId : query.ownerId;
        const rows: ClauseAssessmentRow[] = await clauseAssessments.list(tx, system.id, {
          ...definedOf({
            standardIds: query.standardId,
            status: query.status,
            naState: query.naState,
            ownerId,
            scope: listScope(ctx, clientId),
          }),
        });
        // Out of the actor's units and naming them nowhere: the system is not theirs to see.
        if (rows.length === 0 && !canSee(ctx, systemReach(system))) notFound();
        const items = rows.map(
          ({ standardId, clauseNumber, clauseTitle, exclusionAllowed, ...row }) =>
            rowView(ctx, system, row, {
              standardId,
              number: clauseNumber,
              title: clauseTitle,
              exclusionAllowed,
            }),
        );
        return { items };
      });
    },

    async updateIsoChecklistRow(call) {
      const { ctx, body } = call;
      return core.run(ctx, async (tx) => {
        const { system, row, reach, clause } = await checklistRow(tx, call, 'isoChecklist.write');
        const { version, reason, ...patch } = body;
        const reassigns = patch.ownerId !== undefined && patch.ownerId !== row.ownerId;
        if (reassigns && !isManager(ctx, reach)) {
          forbidden(
            'isoChecklist.write',
            'Only a client admin, consultant or account admin reassigns a row',
          );
        }
        checkVersion(row, version);
        if (patch.status !== undefined) {
          if (row.naState === 'REQUESTED' || row.naState === 'APPROVED') {
            invalid('status', `The status is not written while N/A is ${row.naState}`);
          }
          if (
            patch.status === 'IMPLEMENTED' &&
            clause.number === '4.1' &&
            system.climateChangeRelevant === null
          ) {
            invalid(
              'status',
              'Clause 4.1 cannot be IMPLEMENTED before the climate decision is recorded',
            );
          }
        }
        if (reassigns && patch.ownerId !== null) {
          await core.checkPerson(tx, row.clientId, patch.ownerId!, 'ownerId');
        }
        const updated = await core.edit(
          tx,
          ctx,
          row,
          patch,
          'clause_assessment',
          (changes) => clauseAssessments.update(tx, row.id, version, changes),
          { split: { ownerId: 'REASSIGN' }, reason: reason ?? null },
        );
        return rowView(ctx, system, updated, clause);
      });
    },

    requestIsoClauseNa: (call) =>
      naStep(call, 'REQUEST_NA', 'isoChecklist.requestNa', (row) => ({
        statusBeforeNa: row.status as ClauseAssessment['statusBeforeNa'],
        status: 'NOT_APPLICABLE',
        naState: 'REQUESTED',
        justification: call.body.reason,
        naRequestedById: call.ctx.personId,
        naDecidedById: null,
        naDecidedAt: null,
      })),

    approveIsoClauseNa: (call) =>
      naStep(call, 'APPROVE_NA', 'isoChecklist.decideNa', (_row, now) => ({
        naState: 'APPROVED',
        naDecidedById: call.ctx.personId,
        naDecidedAt: now,
      })),

    rejectIsoClauseNa: (call) =>
      naStep(call, 'REJECT_NA', 'isoChecklist.decideNa', (row, now) => ({
        naState: 'REJECTED',
        status: row.statusBeforeNa ?? 'NOT_STARTED',
        statusBeforeNa: null,
        naDecidedById: call.ctx.personId,
        naDecidedAt: now,
      })),

    withdrawIsoClauseNa: (call) =>
      naStep(call, 'WITHDRAW_NA', 'isoChecklist.requestNa', () => ({
        naState: 'NONE',
        status: 'NOT_STARTED',
        statusBeforeNa: null,
        justification: null,
        naRequestedById: null,
        naDecidedById: null,
        naDecidedAt: null,
      })),
  };
}
