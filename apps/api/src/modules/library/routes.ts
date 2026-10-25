import {
  ENDPOINTS,
  type Act,
  type Id,
  type Jurisdiction,
  type Obligation,
  type RequestContext,
} from '@canopy/contracts';
import { daysBetween, generateInstances } from '@canopy/engine';
import type { FastifyInstance } from 'fastify';
import { canSeeClient, isFirmStaff } from '../entities/http/access.js';
import { invalid, notFound } from '../entities/http/errors.js';
import { pageOf } from '../entities/http/page.js';
import { mount, type M6Deps } from '../entities/http/route.js';
import { emit } from '../entities/events.js';
import { mergeInto } from '../entities/merge.js';
import type { Tx } from '../entities/store.js';
import { auditedInsert, auditedUpdate, changes, getLive, instantOf } from '../entities/write.js';
import { checkRule } from './rules.js';

/** Library: Acts, categories, obligations, rule preview and push (docs/contracts/endpoints.md §3). */

/** Longest range the rule preview generates, so one request cannot ask for centuries of periods. */
export const MAX_PREVIEW_DAYS = 3 * 366;

function checkJurisdiction(value: { jurisdiction: Jurisdiction; stateCode: string | null }) {
  if (value.jurisdiction === 'STATE' && value.stateCode === null) {
    throw invalid('A STATE jurisdiction needs a stateCode', ['body', 'stateCode']);
  }
  if (value.jurisdiction === 'CENTRAL' && value.stateCode !== null) {
    throw invalid('A CENTRAL jurisdiction has no stateCode', ['body', 'stateCode']);
  }
}

const kindOf = (act: Pick<Act, 'kind'>) => act.kind ?? 'STATUTE';

/**
 * A STANDARD act's values are fixed (docs/iso/catalogue.md §2) and the ISO catalogue copy finds it by name, so staff
 * never edit or merge one (ISO-9b). The database still lets them, so this is the only guard.
 */
function refuseStandard(act: Pick<Act, 'kind'>, path: string[]) {
  if (kindOf(act) === 'STANDARD') {
    throw invalid('The Act of an ISO standard is fixed and cannot be changed or merged.', path);
  }
}

export function libraryRoutes(app: FastifyInstance, deps: M6Deps): void {
  const { store } = deps;
  const clock = () => (deps.now ?? (() => new Date()))();

  /**
   * Client roles see only the library rows used by an assignment in their clients (endpoints.md §3); null means
   * every row (firm staff).
   */
  async function visibleObligationIds(tx: Tx, ctx: RequestContext): Promise<Id[] | null> {
    return isFirmStaff(ctx) ? null : tx.assignedObligationIds();
  }

  async function visibleActIds(tx: Tx, ctx: RequestContext): Promise<Id[] | null> {
    const ids = await visibleObligationIds(tx, ctx);
    if (ids === null) return null;
    const obligations = ids.length === 0 ? [] : await tx.obligations.findAll({ id: ids });
    return [...new Set(obligations.map((o) => o.actId))];
  }

  async function liveRef(tx: Tx, kind: 'actId' | 'categoryId', id: Id) {
    const row = kind === 'actId' ? await tx.acts.get(id) : await tx.categories.get(id);
    if (!row || row.archivedAt !== null)
      throw invalid(`Unknown ${kind.slice(0, -2)}.`, ['body', kind]);
  }

  const search = (q: string | undefined, fields: readonly string[]) =>
    q ? { search: { text: q, fields } } : {};

  // ---------- Acts ----------

  mount(app, deps, ENDPOINTS.listActs, async (call) => {
    call.authorize({ type: 'act', clientId: null });
    return store.transaction(call.ctx, async (tx) => {
      const ids = await visibleActIds(tx, call.ctx);
      return pageOf(tx.acts, call.query, {
        orderBy: 'name',
        where: ids === null ? {} : { id: ids },
        ...search(call.query.q, ['name', 'shortName']),
      });
    });
  });

  mount(app, deps, ENDPOINTS.createAct, async (call) => {
    call.authorize({ type: 'act', clientId: null });
    return store.transaction(call.ctx, (tx) =>
      auditedInsert(
        tx,
        tx.acts,
        'act',
        call.body as Parameters<Tx['acts']['insert']>[0],
        () => null,
      ),
    );
  });

  mount(app, deps, ENDPOINTS.updateAct, async (call) => {
    call.authorize({ type: 'act', clientId: null });
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.acts, call.params.id as Id);
      refuseStandard(row, ['params', 'id']);
      checkJurisdiction({
        jurisdiction: body.jurisdiction ?? row.jurisdiction,
        stateCode: body.stateCode === undefined ? row.stateCode : body.stateCode,
      });
      return auditedUpdate({
        tx,
        repo: tx.acts,
        entityType: 'act',
        row,
        version: body.version,
        patch: {
          name: body.name,
          shortName: body.shortName,
          jurisdiction: body.jurisdiction,
          stateCode: body.stateCode,
          aliases: body.aliases,
        },
        clientId: null,
      });
    });
  });

  mount(app, deps, ENDPOINTS.mergeActs, async (call) => {
    call.authorize({ type: 'act', clientId: null });
    return store.transaction(call.ctx, async (tx) => {
      const target = await getLive(tx.acts, call.params.id as Id);
      refuseStandard(target, ['params', 'id']);
      // A STANDARD source would also cross kinds: a law and an ISO standard never merge.
      for (const id of call.body.sourceIds) {
        const source = await tx.acts.get(id as Id);
        if (source) refuseStandard(source, ['body', 'sourceIds']);
      }
      return mergeInto({
        tx,
        repo: tx.acts,
        entityType: 'act',
        target,
        version: call.body.version,
        sourceIds: call.body.sourceIds,
        clientId: null,
        now: clock(),
        moveReferences: async (sourceId, targetId) => {
          for (const o of await tx.obligations.findAll({ actId: sourceId })) {
            await auditedUpdate({
              tx,
              repo: tx.obligations,
              entityType: 'obligation',
              row: o,
              version: o.version,
              patch: { actId: targetId },
              clientId: null,
              action: 'MERGE_ALIAS',
            });
          }
        },
      });
    });
  });

  // ---------- categories ----------

  mount(app, deps, ENDPOINTS.listCategories, async (call) => {
    call.authorize({ type: 'category', clientId: null });
    return store.transaction(call.ctx, async (tx) => {
      const ids = await visibleObligationIds(tx, call.ctx);
      const categoryIds =
        ids === null
          ? null
          : [
              ...new Set(
                (ids.length === 0 ? [] : await tx.obligations.findAll({ id: ids })).map(
                  (o) => o.categoryId,
                ),
              ),
            ];
      return pageOf(tx.categories, call.query, {
        orderBy: 'name',
        where: categoryIds === null ? {} : { id: categoryIds },
        ...search(call.query.q, ['name']),
      });
    });
  });

  mount(app, deps, ENDPOINTS.createCategory, async (call) => {
    call.authorize({ type: 'category', clientId: null });
    return store.transaction(call.ctx, (tx) =>
      auditedInsert(
        tx,
        tx.categories,
        'category',
        call.body as Parameters<Tx['categories']['insert']>[0],
        () => null,
      ),
    );
  });

  mount(app, deps, ENDPOINTS.updateCategory, async (call) => {
    call.authorize({ type: 'category', clientId: null });
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.categories, call.params.id as Id);
      return auditedUpdate({
        tx,
        repo: tx.categories,
        entityType: 'category',
        row,
        version: body.version,
        patch: { name: body.name, aliases: body.aliases },
        clientId: null,
      });
    });
  });

  mount(app, deps, ENDPOINTS.mergeCategories, async (call) => {
    call.authorize({ type: 'category', clientId: null });
    return store.transaction(call.ctx, async (tx) => {
      const target = await getLive(tx.categories, call.params.id as Id);
      return mergeInto({
        tx,
        repo: tx.categories,
        entityType: 'category',
        target,
        version: call.body.version,
        sourceIds: call.body.sourceIds,
        clientId: null,
        now: clock(),
        moveReferences: async (sourceId, targetId) => {
          for (const o of await tx.obligations.findAll({ categoryId: sourceId })) {
            await auditedUpdate({
              tx,
              repo: tx.obligations,
              entityType: 'obligation',
              row: o,
              version: o.version,
              patch: { categoryId: targetId },
              clientId: null,
              action: 'MERGE_ALIAS',
            });
          }
        },
      });
    });
  });

  // ---------- obligations ----------

  mount(app, deps, ENDPOINTS.listObligations, async (call) => {
    call.authorize({ type: 'obligation', clientId: null });
    const { query } = call;
    return store.transaction(call.ctx, async (tx) => {
      const ids = await visibleObligationIds(tx, call.ctx);
      return pageOf(tx.obligations, query, {
        orderBy: 'title',
        where: {
          ...(ids === null ? {} : { id: ids }),
          ...(query.actId ? { actId: query.actId } : {}),
          ...(query.categoryId ? { categoryId: query.categoryId } : {}),
          ...(query.domain ? { domain: query.domain } : {}),
          ...(query.criticality ? { criticality: query.criticality } : {}),
          ...(query.jurisdiction ? { jurisdiction: query.jurisdiction } : {}),
          ...(query.stateCode ? { stateCode: query.stateCode } : {}),
          ...(query.ruleStatus ? { ruleStatus: query.ruleStatus } : {}),
        },
        ...search(query.q, ['title', 'externalRef']),
      });
    });
  });

  mount(app, deps, ENDPOINTS.createObligation, async (call) => {
    call.authorize({ type: 'obligation', clientId: null });
    const { body, ctx } = call;
    checkRule(body.recurrenceRule, ctx.asOf);
    return store.transaction(ctx, async (tx) => {
      await liveRef(tx, 'actId', body.actId);
      await liveRef(tx, 'categoryId', body.categoryId);
      const obligation = await auditedInsert(
        tx,
        tx.obligations,
        'obligation',
        { ...body, libraryVersion: 1 },
        () => null,
      );
      await emit(
        tx,
        {
          type: 'obligation.created',
          data: { obligationId: obligation.id, libraryVersion: 1, changed: Object.keys(body) },
        },
        { type: 'obligation', id: obligation.id, version: obligation.version },
        null,
      );
      return obligation;
    });
  });

  mount(app, deps, ENDPOINTS.getObligation, async (call) => {
    call.authorize({ type: 'obligation', clientId: null });
    return store.transaction(call.ctx, async (tx) => {
      const obligation = await getLive(tx.obligations, call.params.id as Id);
      const ids = await visibleObligationIds(tx, call.ctx);
      if (ids !== null && !ids.includes(obligation.id)) throw notFound();
      return obligation;
    });
  });

  mount(app, deps, ENDPOINTS.updateObligation, async (call) => {
    call.authorize({ type: 'obligation', clientId: null });
    const { body, ctx } = call;
    const { version, ...fields } = body;
    if (fields.recurrenceRule !== undefined) checkRule(fields.recurrenceRule, ctx.asOf);
    return store.transaction(ctx, async (tx) => {
      const row = await getLive(tx.obligations, call.params.id as Id);
      checkJurisdiction({
        jurisdiction: fields.jurisdiction ?? row.jurisdiction,
        stateCode: fields.stateCode === undefined ? row.stateCode : fields.stateCode,
      });
      if (fields.actId !== undefined) {
        await liveRef(tx, 'actId', fields.actId);
        const [from, to] = [await tx.acts.get(row.actId), await tx.acts.get(fields.actId)];
        if (from && to && kindOf(from) !== kindOf(to)) {
          throw invalid('An obligation cannot move between a law and an ISO standard.', [
            'body',
            'actId',
          ]);
        }
      }
      if (fields.categoryId !== undefined) await liveRef(tx, 'categoryId', fields.categoryId);
      const changed = Object.keys(changes(row, fields).after);
      // Every accepted change is a new library version; instances change only through push.
      const patch =
        changed.length === 0 ? fields : { ...fields, libraryVersion: row.libraryVersion + 1 };
      const obligation = await auditedUpdate({
        tx,
        repo: tx.obligations,
        entityType: 'obligation',
        row,
        version,
        patch,
        clientId: null,
      });
      if (obligation !== row) {
        await emit(
          tx,
          {
            type: 'obligation.updated',
            data: {
              obligationId: obligation.id,
              libraryVersion: obligation.libraryVersion,
              changed,
            },
          },
          { type: 'obligation', id: obligation.id, version: obligation.version },
          null,
        );
      }
      return obligation;
    });
  });

  mount(app, deps, ENDPOINTS.archiveObligation, async (call) => {
    call.authorize({ type: 'obligation', clientId: null });
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.obligations, call.params.id as Id);
      const assignments = await tx.assignments.findAll({ obligationId: row.id });
      if (assignments.length > 0) {
        throw invalid('Archive the assignments of this obligation first.', ['params', 'id']);
      }
      return auditedUpdate({
        tx,
        repo: tx.obligations,
        entityType: 'obligation',
        row,
        version: call.body.version,
        patch: { archivedAt: instantOf(clock()) },
        clientId: null,
        action: 'ARCHIVE',
        reason: call.body.reason,
      });
    });
  });

  mount(app, deps, ENDPOINTS.previewRule, async (call) => {
    call.authorize({ type: 'obligation', clientId: null });
    const { rule, from, to, fyStartMonth } = call.body;
    if (daysBetween(from, to) > MAX_PREVIEW_DAYS) {
      throw invalid(`Preview at most ${MAX_PREVIEW_DAYS} days at a time.`, ['body', 'to']);
    }
    return {
      items: generateInstances(rule, { from, to }, { fyStartMonth, holidayPolicy: 'NONE' }),
    };
  });

  mount(app, deps, ENDPOINTS.pushObligation, async (call) => {
    call.authorize({ type: 'obligation', clientId: null });
    const { ctx } = call;
    const clientIds = [...new Set(call.body.clientIds)];
    for (const clientId of clientIds) {
      if (!canSeeClient(ctx, clientId)) throw notFound();
    }
    return store.transaction(ctx, async (tx) => {
      const obligation: Obligation = await getLive(tx.obligations, call.params.id as Id);
      for (const clientId of clientIds) await getLive(tx.clients, clientId);
      const assignments = await tx.assignments.findAll({
        obligationId: obligation.id,
        clientId: clientIds,
      });
      await tx.audit({
        clientId: null,
        action: 'UPDATE',
        entityType: 'obligation',
        entityId: obligation.id,
        before: null,
        after: { pushedLibraryVersion: obligation.libraryVersion, clientIds },
      });
      // M9 regenerates the future instances of these assignments when it handles the event (events.md §3).
      await emit(
        tx,
        {
          type: 'obligation.pushed',
          data: {
            obligationId: obligation.id,
            libraryVersion: obligation.libraryVersion,
            clientIds,
          },
        },
        { type: 'obligation', id: obligation.id, version: obligation.version },
        null,
      );
      return {
        libraryVersion: obligation.libraryVersion,
        assignmentsUpdated: assignments.length,
        instancesUpdated: 0,
      };
    });
  });
}
