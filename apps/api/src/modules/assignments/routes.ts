import {
  ENDPOINTS,
  type Assignment,
  AssignmentCreateBody,
  type Id,
  type RequestContext,
} from '@canopy/contracts';
import type { z } from 'zod';
import { compareDates } from '@canopy/engine';
import type { FastifyInstance } from 'fastify';
import { unitScope } from '../entities/http/access.js';
import { fromDuplicate, HttpError, invalid } from '../entities/http/errors.js';
import { readableKinds, refuseWhenOff } from '../entities/http/iso-switch.js';
import { pageOf } from '../entities/http/page.js';
import { mount, type M6Deps } from '../entities/http/route.js';
import { emit } from '../entities/events.js';
import { DuplicateError, type Tx } from '../entities/store.js';
import { auditedInsert, auditedUpdate, getLive, instantOf } from '../entities/write.js';
import { auditReassigned } from '../people/merge.js';

/** Assignments: an obligation applied to a unit (docs/contracts/endpoints.md §3). */

type NewAssignment = z.output<typeof AssignmentCreateBody>;

export function assignmentRoutes(app: FastifyInstance, deps: M6Deps): void {
  const { store } = deps;
  const clock = () => (deps.now ?? (() => new Date()))();

  async function liveIn(tx: Tx, kind: 'unitId' | 'departmentId', clientId: Id, id: Id) {
    const row = kind === 'unitId' ? await tx.units.get(id) : await tx.departments.get(id);
    if (!row || row.archivedAt !== null || row.clientId !== clientId) {
      throw invalid(`Unknown ${kind.slice(0, -2)} for this client.`, ['body', kind]);
    }
  }

  async function livePerson(tx: Tx, field: 'defaultOwnerId' | 'defaultApproverId', id: Id) {
    const person = await tx.people.get(id);
    if (!person || person.archivedAt !== null) throw invalid('Unknown person.', ['body', field]);
  }

  async function create(
    tx: Tx,
    ctx: RequestContext,
    clientId: Id,
    item: NewAssignment,
  ): Promise<Assignment> {
    await getLive(tx.clients, clientId);
    await liveIn(tx, 'unitId', clientId, item.unitId);
    await liveIn(tx, 'departmentId', clientId, item.departmentId);
    const obligation = await tx.obligations.get(item.obligationId);
    if (!obligation || obligation.archivedAt !== null) {
      throw invalid('Unknown obligation.', ['body', 'obligationId']);
    }
    await refuseWhenOff(ctx, await tx.actKindOf.obligation(obligation.id));
    await livePerson(tx, 'defaultOwnerId', item.defaultOwnerId);
    await livePerson(tx, 'defaultApproverId', item.defaultApproverId);
    const assignment = await auditedInsert(
      tx,
      tx.assignments,
      'assignment',
      { clientId, ...item, applicability: 'APPLICABLE', naReason: null },
      () => clientId,
    );
    await emit(
      tx,
      {
        type: 'assignment.created',
        data: {
          assignmentId: assignment.id,
          obligationId: assignment.obligationId,
          unitId: assignment.unitId,
          departmentId: assignment.departmentId,
          defaultOwnerId: assignment.defaultOwnerId,
          defaultApproverId: assignment.defaultApproverId,
          applicability: assignment.applicability,
        },
      },
      { type: 'assignment', id: assignment.id, version: assignment.version },
      clientId,
    );
    return assignment;
  }

  const me = (ctx: RequestContext, id: string | undefined) => (id === 'me' ? ctx.personId : id);

  mount(app, deps, ENDPOINTS.listAssignments, async (call) => {
    const clientId = call.params.clientId as Id;
    const { ctx, query } = call;
    call.authorize({ type: 'assignment', clientId });
    const scope = unitScope(ctx, clientId);
    const units =
      scope === null ? query.unitId : (query.unitId ?? scope).filter((u) => scope.includes(u));
    const ownerId = me(ctx, query.ownerId);
    const approverId = me(ctx, query.approverId);
    return store.transaction(ctx, async (tx) => {
      await getLive(tx.clients, clientId);
      return pageOf(tx.assignments, query, {
        orderBy: 'id',
        where: {
          clientId,
          ...(units ? { unitId: units } : {}),
          ...(query.departmentId ? { departmentId: query.departmentId } : {}),
          ...(query.obligationId ? { obligationId: query.obligationId } : {}),
          ...(query.applicability ? { applicability: query.applicability } : {}),
          ...(ownerId ? { defaultOwnerId: ownerId } : {}),
          ...(approverId ? { defaultApproverId: approverId } : {}),
        },
        ...(await readableKinds(ctx)),
      });
    });
  });

  mount(app, deps, ENDPOINTS.createAssignment, async (call) => {
    const clientId = call.params.clientId as Id;
    call.authorize({ type: 'assignment', clientId, unitId: call.body.unitId });
    return store.transaction(call.ctx, (tx) =>
      create(tx, call.ctx, clientId, call.body as NewAssignment),
    );
  });

  mount(app, deps, ENDPOINTS.bulkCreateAssignments, async (call) => {
    const clientId = call.params.clientId as Id;
    call.authorize({ type: 'assignment', clientId });
    await store.transaction(call.ctx, (tx) => getLive(tx.clients, clientId));
    const results = [];
    // One transaction per item, so one bad row does not undo the others (per-item results, api-conventions.md §5).
    for (const [index, item] of (call.body.items as NewAssignment[]).entries()) {
      try {
        call.authorize({ type: 'assignment', clientId, unitId: item.unitId });
        const created = await store.transaction(call.ctx, (tx) =>
          create(tx, call.ctx, clientId, item),
        );
        results.push({ index, ok: true, item: created });
      } catch (thrown) {
        const error = thrown instanceof DuplicateError ? fromDuplicate(thrown) : thrown;
        if (!(error instanceof HttpError)) throw thrown;
        results.push({ index, ok: false, error: { code: error.code, message: error.message } });
      }
    }
    return { results };
  });

  mount(app, deps, ENDPOINTS.updateAssignment, async (call) => {
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.assignments, call.params.id as Id);
      call.authorize({ type: 'assignment', clientId: row.clientId, unitId: row.unitId });
      await refuseWhenOff(call.ctx, await tx.actKindOf.assignment(row.id));
      if (body.departmentId !== undefined) {
        await liveIn(tx, 'departmentId', row.clientId, body.departmentId);
      }
      if (body.defaultOwnerId !== undefined)
        await livePerson(tx, 'defaultOwnerId', body.defaultOwnerId);
      if (body.defaultApproverId !== undefined) {
        await livePerson(tx, 'defaultApproverId', body.defaultApproverId);
      }
      if (body.activeTo != null && compareDates(body.activeTo, row.activeFrom) < 0) {
        throw invalid('activeTo is before activeFrom', ['body', 'activeTo']);
      }
      const assignment = await auditedUpdate({
        tx,
        repo: tx.assignments,
        entityType: 'assignment',
        row,
        version: body.version,
        patch: {
          departmentId: body.departmentId,
          defaultOwnerId: body.defaultOwnerId,
          defaultApproverId: body.defaultApproverId,
          activeTo: body.activeTo,
        },
        clientId: row.clientId,
      });
      const changed = (
        [
          ['department', 'departmentId'],
          ['defaultOwner', 'defaultOwnerId'],
          ['defaultApprover', 'defaultApproverId'],
          ['activeTo', 'activeTo'],
        ] as const
      )
        .filter(([, field]) => row[field] !== assignment[field])
        .map(([name]) => name);
      const ownerChanged = row.defaultOwnerId !== assignment.defaultOwnerId;
      const approverChanged = row.defaultApproverId !== assignment.defaultApproverId;
      const applyToOpen = body.applyToOpen === true && (ownerChanged || approverChanged);
      if (applyToOpen) {
        const instances = await tx.instances.reassignOpen(assignment.id, {
          ...(ownerChanged ? { ownerId: assignment.defaultOwnerId } : {}),
          ...(approverChanged ? { approverId: assignment.defaultApproverId } : {}),
        });
        await auditReassigned(tx, instances, null);
      }
      if (changed.length > 0) {
        await emit(
          tx,
          {
            type: 'assignment.changed',
            data: { assignmentId: assignment.id, changed, appliedToOpen: applyToOpen },
          },
          { type: 'assignment', id: assignment.id, version: assignment.version },
          assignment.clientId,
        );
      }
      return assignment;
    });
  });

  mount(app, deps, ENDPOINTS.setAssignmentApplicability, async (call) => {
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.assignments, call.params.id as Id);
      call.authorize({ type: 'assignment', clientId: row.clientId, unitId: row.unitId });
      await refuseWhenOff(call.ctx, await tx.actKindOf.assignment(row.id));
      // NOT_APPLICABLE stops future generation; open instances still need per-instance NA approval (endpoints.md §3).
      const assignment = await auditedUpdate({
        tx,
        repo: tx.assignments,
        entityType: 'assignment',
        row,
        version: body.version,
        patch: {
          applicability: body.applicability,
          naReason: body.applicability === 'NOT_APPLICABLE' ? body.reason : null,
        },
        clientId: row.clientId,
        action: 'APPLICABILITY_CHANGE',
        reason: body.reason,
      });
      if (row.applicability !== assignment.applicability) {
        await emit(
          tx,
          {
            type: 'assignment.applicability_changed',
            data: {
              assignmentId: assignment.id,
              from: row.applicability,
              to: assignment.applicability,
            },
          },
          { type: 'assignment', id: assignment.id, version: assignment.version },
          assignment.clientId,
        );
      }
      return assignment;
    });
  });

  mount(app, deps, ENDPOINTS.archiveAssignment, async (call) => {
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.assignments, call.params.id as Id);
      call.authorize({ type: 'assignment', clientId: row.clientId, unitId: row.unitId });
      await refuseWhenOff(call.ctx, await tx.actKindOf.assignment(row.id));
      const assignment = await auditedUpdate({
        tx,
        repo: tx.assignments,
        entityType: 'assignment',
        row,
        version: body.version,
        patch: { archivedAt: instantOf(clock()) },
        clientId: row.clientId,
        action: 'ARCHIVE',
        reason: body.reason,
      });
      await emit(
        tx,
        { type: 'assignment.archived', data: { assignmentId: assignment.id } },
        { type: 'assignment', id: assignment.id, version: assignment.version },
        assignment.clientId,
      );
      return assignment;
    });
  });
}
