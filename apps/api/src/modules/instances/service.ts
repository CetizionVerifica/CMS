import {
  Comment,
  InstanceDetail,
  InstanceRow,
  type Action,
  type ComplianceInstance,
  type InstanceAction,
  type LocalDate,
  type RegisterQuery,
  type RequestContext,
  type Resource,
} from '@canopy/contracts';
import {
  assignments,
  auditEvents,
  clients,
  comments,
  DbError,
  evidence,
  firms,
  instances,
  memberships,
  obligations,
  tenantFromRequest,
  type Database,
  type RegisterFilter,
  type RegisterRow,
  type TenantTx,
} from '@canopy/db';
import { fyRangeOf } from '@canopy/engine';
import { ApiError, can } from '../../auth/index.js';
import { allowedActions, INSTANCE_ACTION_POLICY, instanceResource } from './allowed-actions.js';
import { mergedPage, type RegisterSource } from './paging.js';
import { clientsWithRole, mayChooseAsOf, unitScope } from './scope.js';
import { clientToday, rowStatus } from './status.js';
import { ACTIVE_STATES, planTransition, type TransitionCommand } from './workflow.js';

/**
 * Instance reads and writes for the M7 routes (docs/contracts/endpoints.md §4). Every call runs in one
 * tenant transaction; every state change writes its comment and AuditEvent in that transaction
 * (root CLAUDE.md rule 2). Status always comes from the engine via `rowStatus`.
 */

/** Who is acting: the request context and the route's `authorize` (M5), which throws FORBIDDEN. */
export interface Actor {
  readonly ctx: RequestContext;
  authorize(action: Action, resource: Resource): void;
}

export interface InstanceServiceOptions {
  readonly db: Database;
  /** Defaults to the system clock. */
  readonly clock?: () => Date;
}

interface ClientCalendar {
  timeZone: string;
  fyStartMonth: number;
  dueSoonDays: number;
}

export interface BulkResult {
  id: string;
  ok: boolean;
  error?: { code: ApiError['code']; message: string };
  item?: InstanceRow;
}

/** Repository errors carry contract codes; their messages name tables, so callers get the default text. */
function toApiError(error: unknown): never {
  if (error instanceof DbError) throw new ApiError(error.code);
  throw error;
}

function nowInstant(clock: () => Date): string {
  return clock().toISOString();
}

export function createInstanceService(options: InstanceServiceOptions) {
  const { db } = options;
  const clock = options.clock ?? (() => new Date());

  function inTenant<T>(ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return db.withTenant(tenantFromRequest(ctx), fn).catch(toApiError);
  }

  async function calendar(tx: TenantTx, clientId: string): Promise<ClientCalendar> {
    const client = await clients.require(tx, clientId);
    const firm = await firms.current(tx);
    return {
      timeZone: client.settings.timeZone,
      fyStartMonth: client.settings.fyStartMonth,
      dueSoonDays: firm.settings.dueSoonDays,
    };
  }

  /** `asOf` for reads: today in the client's zone, or the requested date for roles allowed to choose it. */
  function readAsOf(
    ctx: RequestContext,
    clientId: string,
    cal: ClientCalendar,
    requested: LocalDate | undefined,
  ): LocalDate {
    if (requested === undefined) return clientToday(nowInstant(clock), cal.timeZone);
    if (!mayChooseAsOf(ctx, clientId)) throw new ApiError('FORBIDDEN', { action: 'instance.read' });
    return requested;
  }

  function withStatus(row: RegisterRow, asOf: LocalDate, cal: ClientCalendar): InstanceRow {
    return InstanceRow.parse({ ...row, ...rowStatus(row, asOf, cal) });
  }

  /** Loads an instance the actor's tenant can see; NOT_FOUND otherwise (also outside the actor's clients). */
  async function loadInstance(tx: TenantTx, ctx: RequestContext, id: string) {
    const instance = await instances.get(tx, id);
    if (
      instance === null ||
      instance.archivedAt !== null ||
      !ctx.clientIds.includes(instance.clientId)
    ) {
      throw new ApiError('NOT_FOUND');
    }
    return instance;
  }

  async function registerRow(tx: TenantTx, instance: ComplianceInstance): Promise<RegisterRow> {
    const page = await instances.register(
      tx,
      instance.clientId,
      { instanceIds: [instance.id] },
      { limit: 1 },
    );
    const row = page.items[0];
    if (row === undefined) throw new ApiError('NOT_FOUND');
    return row;
  }

  async function detail(
    tx: TenantTx,
    ctx: RequestContext,
    instance: ComplianceInstance,
    asOf: LocalDate,
    cal: ClientCalendar,
  ): Promise<InstanceDetail> {
    const row = await registerRow(tx, instance);
    const assignment = await assignments.require(tx, instance.assignmentId);
    const obligation = await obligations.require(tx, assignment.obligationId);
    return InstanceDetail.parse({
      ...row,
      ...rowStatus(row, asOf, cal),
      description: obligation.description,
      applicabilityText: obligation.applicabilityText,
      naReason: instance.naReason,
      forms: obligation.forms,
      logSheets: obligation.logSheets,
      evidenceRequired: obligation.evidenceRequired,
      allowedActions: allowedActions(instance, ctx, can),
    });
  }

  /** Register filters the repository applies, one per category when several are asked for. */
  function registerSources(
    ctx: RequestContext,
    clientId: string,
    query: RegisterQuery,
    cal: ClientCalendar,
  ): RegisterSource[] {
    const me = (ref: string | undefined) => (ref === 'me' ? ctx.personId : ref);
    const scope = unitScope(ctx, clientId);
    const asked = query.unitId;
    const unitIds =
      scope === null ? asked : asked === undefined ? scope : asked.filter((u) => scope.includes(u));
    const due = query.fy === undefined ? undefined : fyRangeOf(query.fy, cal.fyStartMonth);
    const base: RegisterFilter = {
      ...(unitIds === undefined ? {} : { unitIds }),
      ...(query.departmentId?.length === 1 ? { departmentId: query.departmentId[0] } : {}),
      ...(query.actId?.length === 1 ? { actId: query.actId[0] } : {}),
      ...(query.ownerId === undefined ? {} : { ownerId: me(query.ownerId) }),
      ...(query.approverId === undefined ? {} : { approverId: me(query.approverId) }),
      ...(query.criticality === undefined ? {} : { criticality: query.criticality }),
      ...(query.workflowState === undefined ? {} : { workflowState: query.workflowState }),
      ...(query.timelineType === undefined ? {} : { timelineType: query.timelineType }),
      ...(query.domain === undefined ? {} : { domain: query.domain }),
      ...(due === undefined ? {} : { dueFrom: due.from, dueTo: due.to }),
      ...(query.dueFrom === undefined ? {} : { dueFrom: query.dueFrom }),
      ...(query.dueTo === undefined ? {} : { dueTo: query.dueTo }),
      ...(query.completedFrom === undefined ? {} : { completedFrom: query.completedFrom }),
      ...(query.completedTo === undefined ? {} : { completedTo: query.completedTo }),
      ...(query.hasEvidence === undefined ? {} : { hasEvidence: query.hasEvidence }),
      ...(query.q === undefined ? {} : { q: query.q }),
    };
    const categories = query.categoryId ?? [undefined];
    return [...new Set(categories)].map((categoryId) => ({
      clientId,
      filter: categoryId === undefined ? base : { ...base, categoryId },
    }));
  }

  /** Register filters the repository cannot apply: derived status and several departments or Acts. */
  function keepRow(query: RegisterQuery) {
    return (row: InstanceRow): boolean =>
      (query.status === undefined || query.status.includes(row.status)) &&
      (query.departmentId === undefined ||
        query.departmentId.length === 1 ||
        query.departmentId.includes(row.departmentId)) &&
      (query.actId === undefined || query.actId.length === 1 || query.actId.includes(row.actId));
  }

  function checkSort(query: RegisterQuery): void {
    const sort = query.sort;
    if (sort === undefined) return;
    if (sort.length === 1 && sort[0]!.field === 'dueDate' && sort[0]!.direction === 'asc') return;
    throw new ApiError('VALIDATION', {
      issues: [{ path: ['sort'], message: 'Only sort=dueDate is available in this version.' }],
    });
  }

  async function readSource(
    tx: TenantTx,
    source: RegisterSource,
    page: { limit: number; cursor: string | undefined },
  ) {
    return instances.register(tx, source.clientId, source.filter, {
      limit: page.limit,
      cursor: page.cursor ?? null,
    });
  }

  async function transitionIn(
    tx: TenantTx,
    actor: Actor,
    id: string,
    expectedVersion: number,
    command: TransitionCommand,
  ): Promise<{ instance: ComplianceInstance; asOf: LocalDate; cal: ClientCalendar }> {
    const { ctx } = actor;
    const instance = await loadInstance(tx, ctx, id);
    actor.authorize(INSTANCE_ACTION_POLICY[command.action], instanceResource(instance));
    const cal = await calendar(tx, instance.clientId);
    const now = nowInstant(clock);
    const asOf = clientToday(now, cal.timeZone);
    const assignment = await assignments.require(tx, instance.assignmentId);
    const obligation = await obligations.require(tx, assignment.obligationId);
    const files = await evidence.forInstance(tx, instance.id);
    const plan = planTransition({
      instance,
      expectedVersion,
      command,
      actorId: ctx.personId,
      asOf,
      now,
      evidenceRequired: obligation.evidenceRequired,
      evidence: files.map((f) => f.scanStatus),
    });
    const updated = await instances.update(tx, instance.id, expectedVersion, plan.fields);
    await comments.create(tx, {
      instanceId: instance.id,
      clientId: instance.clientId,
      authorId: ctx.personId,
      kind: plan.comment.kind,
      body: plan.comment.body,
    });
    await auditEvents.append(tx, {
      clientId: instance.clientId,
      requestId: ctx.requestId,
      actorId: ctx.personId,
      actorKind: 'PERSON',
      action: plan.audit.action,
      entityType: 'instance',
      entityId: instance.id,
      before: plan.audit.before,
      after: plan.audit.after,
      reason: plan.audit.reason,
    });
    return { instance: updated, asOf, cal };
  }

  /** A new owner or approver must hold that role in the instance's client, covering its unit. */
  async function checkAssignee(
    tx: TenantTx,
    personId: string,
    roles: readonly string[],
    instance: ComplianceInstance,
    field: 'ownerId' | 'approverId',
  ): Promise<void> {
    const held = await memberships.forPerson(tx, personId);
    const fits = held.some(
      (m) =>
        roles.includes(m.role) &&
        m.clientId === instance.clientId &&
        (m.unitIds === null || m.unitIds.includes(instance.unitId)),
    );
    if (!fits) {
      throw new ApiError('VALIDATION', {
        issues: [
          {
            path: [field],
            message: `Not a ${field === 'ownerId' ? 'owner' : 'approver'} of this unit.`,
          },
        ],
      });
    }
  }

  return {
    /** GET /clients/{clientId}/instances: the register. APPROVER and OWNER see only their units. */
    async list(actor: Actor, clientId: string, query: RegisterQuery) {
      actor.authorize('instance.read', { type: 'instance', clientId });
      checkSort(query);
      return inTenant(actor.ctx, async (tx) => {
        const cal = await calendar(tx, clientId);
        const asOf = readAsOf(actor.ctx, clientId, cal, query.asOf);
        const keep = keepRow(query);
        return mergedPage(
          registerSources(actor.ctx, clientId, query, cal),
          (s, p) => readSource(tx, s, p),
          {
            limit: query.limit,
            cursor: query.cursor,
            keep: (row) => {
              const item = withStatus(row, asOf, cal);
              return keep(item) ? item : null;
            },
          },
        );
      });
    },

    /** GET /instances/{id}: one instance with the actions this person may take now. */
    async get(actor: Actor, id: string, query: { asOf?: LocalDate | undefined }) {
      return inTenant(actor.ctx, async (tx) => {
        const instance = await loadInstance(tx, actor.ctx, id);
        actor.authorize('instance.read', instanceResource(instance));
        const cal = await calendar(tx, instance.clientId);
        const asOf = readAsOf(actor.ctx, instance.clientId, cal, query.asOf);
        return detail(tx, actor.ctx, instance, asOf, cal);
      });
    },

    /** submit, request-na, approve, send-back, reopen. */
    async transition(
      actor: Actor,
      id: string,
      expectedVersion: number,
      command: TransitionCommand,
    ): Promise<InstanceDetail> {
      return inTenant(actor.ctx, async (tx) => {
        const { instance, asOf, cal } = await transitionIn(tx, actor, id, expectedVersion, command);
        return detail(tx, actor.ctx, instance, asOf, cal);
      });
    },

    /** POST /clients/{clientId}/instances/bulk-approve: each item in its own transaction. */
    async bulkApprove(
      actor: Actor,
      clientId: string,
      body: { items: { id: string; version: number }[]; comment?: string | undefined },
    ): Promise<{ results: BulkResult[] }> {
      // Someone who approves nothing in this client is refused outright; each item is checked again below.
      if (!clientsWithRole(actor.ctx, ['CLIENT_ADMIN', 'APPROVER']).includes(clientId)) {
        throw new ApiError('FORBIDDEN', { action: 'instance.approve' });
      }
      const results: BulkResult[] = [];
      for (const item of body.items) {
        try {
          const row = await inTenant(actor.ctx, async (tx) => {
            const visible = await instances.get(tx, item.id);
            if (visible === null || visible.clientId !== clientId) throw new ApiError('NOT_FOUND');
            const { instance, asOf, cal } = await transitionIn(tx, actor, item.id, item.version, {
              action: 'APPROVE',
              comment: body.comment,
            });
            return withStatus(await registerRow(tx, instance), asOf, cal);
          });
          results.push({ id: item.id, ok: true, item: row });
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          results.push({
            id: item.id,
            ok: false,
            error: { code: error.code, message: error.message },
          });
        }
      }
      return { results };
    },

    /** PATCH /instances/{id}: reassign owner or approver, or move the due date. */
    async update(
      actor: Actor,
      id: string,
      body: {
        version: number;
        ownerId?: string | undefined;
        approverId?: string | undefined;
        dueDate?: LocalDate | undefined;
        reason: string;
      },
    ): Promise<InstanceDetail> {
      const { ctx } = actor;
      return inTenant(ctx, async (tx) => {
        const instance = await loadInstance(tx, ctx, id);
        const resource = instanceResource(instance);
        const reassign = body.ownerId !== undefined || body.approverId !== undefined;
        if (reassign) actor.authorize(INSTANCE_ACTION_POLICY.REASSIGN, resource);
        if (body.dueDate !== undefined)
          actor.authorize(INSTANCE_ACTION_POLICY.CHANGE_DUE_DATE, resource);
        if (body.version !== instance.version) {
          throw new ApiError('STALE_VERSION', { currentVersion: instance.version });
        }
        if (!ACTIVE_STATES.includes(instance.workflowState)) {
          const action: InstanceAction = reassign ? 'REASSIGN' : 'CHANGE_DUE_DATE';
          throw new ApiError('INVALID_TRANSITION', { from: instance.workflowState, action });
        }
        const reason = body.reason.trim();
        if (reason === '') throw new ApiError('REASON_REQUIRED');
        if (body.ownerId !== undefined && body.ownerId !== instance.ownerId) {
          await checkAssignee(tx, body.ownerId, ['OWNER'], instance, 'ownerId');
        }
        if (body.approverId !== undefined && body.approverId !== instance.approverId) {
          await checkAssignee(
            tx,
            body.approverId,
            ['APPROVER', 'CLIENT_ADMIN'],
            instance,
            'approverId',
          );
        }

        const people: Record<string, unknown> = {};
        const peopleBefore: Record<string, unknown> = {};
        for (const field of ['ownerId', 'approverId'] as const) {
          const next = body[field];
          if (next !== undefined && next !== instance[field]) {
            peopleBefore[field] = instance[field];
            people[field] = next;
          }
        }
        const moveDue = body.dueDate !== undefined && body.dueDate !== instance.dueDate;
        const patch = {
          ...people,
          ...(moveDue ? { dueDate: body.dueDate, dueDateOverridden: true } : {}),
        };
        const updated =
          Object.keys(patch).length === 0
            ? instance
            : await instances.update(tx, instance.id, instance.version, patch);

        const audit = (
          action: 'REASSIGN' | 'DUE_DATE_CHANGE',
          before: Record<string, unknown>,
          after: Record<string, unknown>,
        ) =>
          auditEvents.append(tx, {
            clientId: instance.clientId,
            requestId: ctx.requestId,
            actorId: ctx.personId,
            actorKind: 'PERSON',
            action,
            entityType: 'instance',
            entityId: instance.id,
            before,
            after,
            reason,
          });
        if (Object.keys(people).length > 0) await audit('REASSIGN', peopleBefore, people);
        if (moveDue) {
          await audit(
            'DUE_DATE_CHANGE',
            { dueDate: instance.dueDate, dueDateOverridden: instance.dueDateOverridden },
            { dueDate: body.dueDate, dueDateOverridden: true },
          );
        }

        const cal = await calendar(tx, instance.clientId);
        return detail(tx, ctx, updated, clientToday(nowInstant(clock), cal.timeZone), cal);
      });
    },

    /** GET /me/approvals (SUBMITTED, CLIENT_ADMIN: all in the client) and /me/tasks (OPEN, SENT_BACK). */
    async queue(
      actor: Actor,
      kind: 'approvals' | 'tasks',
      query: { limit: number; cursor?: string | undefined; asOf?: LocalDate | undefined },
    ) {
      const { ctx } = actor;
      const roles =
        kind === 'approvals'
          ? (['CLIENT_ADMIN', 'APPROVER'] as const)
          : (['APPROVER', 'OWNER'] as const);
      const clientIds = clientsWithRole(ctx, roles);
      if (clientIds.length === 0) throw new ApiError('FORBIDDEN', { action: 'instance.read' });
      // Only FIRM_ADMIN, CONSULTANT and VIEWER choose asOf, and none of them has a queue.
      if (query.asOf !== undefined) throw new ApiError('FORBIDDEN', { action: 'instance.read' });
      return inTenant(ctx, async (tx) => {
        const calendars = new Map<string, { cal: ClientCalendar; asOf: LocalDate }>();
        const sources: RegisterSource[] = [];
        for (const clientId of clientIds) {
          const cal = await calendar(tx, clientId);
          calendars.set(clientId, { cal, asOf: clientToday(nowInstant(clock), cal.timeZone) });
          const scope = unitScope(ctx, clientId);
          const units = scope === null ? {} : { unitIds: scope };
          const admin = clientsWithRole(ctx, ['CLIENT_ADMIN']).includes(clientId);
          sources.push({
            clientId,
            filter:
              kind === 'approvals'
                ? {
                    workflowState: ['SUBMITTED'],
                    ...(admin ? {} : { approverId: ctx.personId, ...units }),
                  }
                : { workflowState: ['OPEN', 'SENT_BACK'], ownerId: ctx.personId, ...units },
          });
        }
        return mergedPage(sources, (s, p) => readSource(tx, s, p), {
          limit: query.limit,
          cursor: query.cursor,
          keep: (row) => {
            const { cal, asOf } = calendars.get(row.clientId)!;
            return withStatus(row, asOf, cal);
          },
        });
      });
    },

    /** GET /instances/{id}/comments, oldest first. */
    async listComments(
      actor: Actor,
      id: string,
      query: { limit: number; cursor?: string | undefined },
    ) {
      return inTenant(actor.ctx, async (tx) => {
        const instance = await loadInstance(tx, actor.ctx, id);
        actor.authorize('comment.read', instanceResource(instance));
        const all = await comments.forInstance(tx, instance.id);
        let start = 0;
        if (query.cursor !== undefined) {
          const after = all.findIndex(
            (c) => Buffer.from(c.id, 'utf8').toString('base64url') === query.cursor,
          );
          if (after === -1) {
            throw new ApiError('VALIDATION', {
              issues: [{ path: ['cursor'], message: 'Invalid cursor' }],
            });
          }
          start = after + 1;
        }
        const items = all.slice(start, start + query.limit).map((c) => Comment.parse(c));
        const last = items.at(-1);
        const nextCursor =
          last !== undefined && start + query.limit < all.length
            ? Buffer.from(last.id, 'utf8').toString('base64url')
            : null;
        return { items, nextCursor };
      });
    },

    /** POST /instances/{id}/comments: a NOTE. Comments do not change compliance state, so no audit event. */
    async addComment(actor: Actor, id: string, body: { body: string }): Promise<Comment> {
      return inTenant(actor.ctx, async (tx) => {
        const instance = await loadInstance(tx, actor.ctx, id);
        actor.authorize('comment.write', instanceResource(instance));
        return comments.create(tx, {
          instanceId: instance.id,
          clientId: instance.clientId,
          authorId: actor.ctx.personId,
          kind: 'NOTE',
          body: body.body,
        });
      });
    },
  };
}

export type InstanceService = ReturnType<typeof createInstanceService>;
