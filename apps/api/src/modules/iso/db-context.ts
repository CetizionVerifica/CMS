import {
  DEFAULT_ISO_RISK_RULE,
  type AuditEvent,
  type IsoEntityType,
  type IsoRiskRule,
  type LocalDate,
  type ManagementSystem,
  type RequestContext,
  type Role,
} from '@canopy/contracts';
import {
  auditEvents,
  clients,
  DbError,
  firms,
  idempotencyKeys,
  managementSystems,
  memberships,
  tenantFromRequest,
  units,
  type TenantTx,
} from '@canopy/db';
import { localDateIn } from '@canopy/engine';
import { ApiError } from '../../auth/index.js';
import { canSee, systemReach } from './access.js';
import { invalid, notFound } from './errors.js';
import { recordFor, replay, type KeyedRequest } from './idempotency.js';
import type { IsoRouteOptions } from './types.js';

/**
 * What every M16 area shares: the tenant transaction, `Idempotency-Key`, the client's calendar, ISO audit events
 * (model §8), the people check (model §1.5) and loading a record the actor may see. Every write runs in one tenant
 * transaction with its `AuditEvent`s (root CLAUDE.md rule 2). ISO records emit no outbox events (events.md).
 */

export interface Calendar {
  timeZone: string;
  dueSoonDays: number;
  /** The client's financial year start, for objective reading periods. */
  fyStartMonth: number;
  /** The firm's significance rule (`FirmSettings.isoRisk`, not editable in v1). */
  riskRule: IsoRiskRule;
}

export type AuditAction = AuditEvent['action'];

/** The audit actions a machine step is written as: TRANSITION, and CREATE for a step that adds a row (DRAFT_REVISION). */
const STEP_ACTIONS: readonly AuditAction[] = ['CREATE', 'TRANSITION'];

export interface IsoAuditEvent {
  action: AuditAction;
  entityType: IsoEntityType;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  /** A manager took the step for the person the record names (model §4 preamble). */
  delegated?: boolean;
}

/** One step of a record's machine, from its audit trail (model §8): `after.action` and who took it. */
export interface Step {
  action: string;
  actorId: string | null;
  /** When it was taken (the event's `at`). */
  at: string;
}

/** Roles that may be named on an ISO record (model §1.5): VIEWER never counts. */
const NAMED_ROLES: readonly Role[] = [
  'FIRM_ADMIN',
  'CONSULTANT',
  'CLIENT_ADMIN',
  'APPROVER',
  'OWNER',
];

/** JSON equality, for field values (dates, ids, lists, null). */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The defined fields of a body. */
export function definedOf<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** Repository errors carry contract codes; their messages name tables, so callers get the default text. */
function toApiError(error: unknown): never {
  if (error instanceof DbError) throw new ApiError(error.code);
  throw error;
}

export function createCore(options: IsoRouteOptions) {
  const { db } = options;
  const clock = options.clock ?? (() => new Date());

  function run<T>(ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return db.withTenant(tenantFromRequest(ctx), fn).catch(toApiError);
  }

  const core = {
    clock,
    now: (): string => clock().toISOString(),
    run,

    /**
     * A write that honours `Idempotency-Key`: a repeat gets the stored first response, and a first run stores its
     * response in the same transaction as the change. A request that loses a race to a concurrent one with the same key
     * gets the winner's response.
     */
    async keyed<T>(
      ctx: RequestContext,
      request: KeyedRequest | undefined,
      fn: (tx: TenantTx) => Promise<T>,
    ): Promise<T> {
      if (request === undefined) return run(ctx, fn);
      const find = (tx: TenantTx) => idempotencyKeys.find(tx, ctx.personId, request.key, clock());
      try {
        return await run(ctx, async (tx) => {
          const first = await find(tx);
          if (first !== null) return replay<T>(first, request);
          const response = await fn(tx);
          await idempotencyKeys.record(tx, recordFor(ctx.personId, request, response, clock()));
          return response;
        });
      } catch (error) {
        const first = await run(ctx, find);
        if (first === null) throw error;
        return replay<T>(first, request);
      }
    },

    /** The client's time zone and financial year, and the firm's due-soon window and significance rule. */
    async calendar(tx: TenantTx, clientId: string): Promise<Calendar> {
      const client = await clients.require(tx, clientId);
      const firm = await firms.current(tx);
      return {
        timeZone: client.settings.timeZone,
        dueSoonDays: firm.settings.dueSoonDays,
        fyStartMonth: client.settings.fyStartMonth,
        riskRule: firm.settings.isoRisk ?? DEFAULT_ISO_RISK_RULE,
      };
    },

    /** Today in the client's time zone. */
    async today(tx: TenantTx, clientId: string): Promise<LocalDate> {
      const { timeZone } = await core.calendar(tx, clientId);
      return localDateIn(core.now(), timeZone);
    },

    /** Appends an ISO audit event in the request's transaction. */
    async audit(
      tx: TenantTx,
      ctx: RequestContext,
      clientId: string,
      event: IsoAuditEvent,
    ): Promise<void> {
      const after =
        event.delegated === true ? { ...(event.after ?? {}), delegated: true } : event.after;
      await auditEvents.append(tx, {
        clientId,
        requestId: ctx.requestId,
        actorId: ctx.personId,
        actorKind: 'PERSON',
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        before: event.before ?? null,
        after: after ?? null,
        reason: event.reason ?? null,
      });
    },

    /**
     * A record's machine steps, oldest first, for the maker-checker rule (model §4 preamble): every step event, however
     * many other events (file downloads among them) the record has.
     */
    async steps(tx: TenantTx, entityType: IsoEntityType, entityId: string): Promise<Step[]> {
      const events: AuditEvent[] = [];
      let after: string | null = null;
      do {
        const page = await auditEvents.query(tx, {
          entityType,
          entityId,
          action: [...STEP_ACTIONS],
          limit: 200,
          after,
        });
        events.push(...page.items);
        after = page.nextCursor;
      } while (after !== null);
      return events
        .reverse()
        .flatMap((e) =>
          typeof e.after?.action === 'string'
            ? [{ action: e.after.action, actorId: e.actorId, at: e.at }]
            : [],
        );
    },

    /**
     * A person named on an ISO record holds a live role in its client (model §1.5): FIRM_ADMIN, CONSULTANT of the
     * client, or a client membership (with no unit list, or one that has `unitId` when the record has one), and is
     * neither archived nor DISABLED. VIEWER never counts. M3's lookup answers it for memberships the actor cannot read
     * (a client admin naming a consultant, ISO-2i). 400 VALIDATION on `path` otherwise.
     */
    async checkPerson(
      tx: TenantTx,
      clientId: string,
      personId: string,
      path: string,
      options: { unitId?: string | null; roles?: readonly Role[] } = {},
    ): Promise<void> {
      const held = await memberships.holdsRole(tx, {
        personId,
        roles: [...(options.roles ?? NAMED_ROLES)],
        clientId,
        ...(options.unitId == null ? {} : { unitId: options.unitId }),
      });
      if (!held) invalid(path, 'Not a person who works in this client and unit');
    },

    /** Each id is a live unit of the system (or, with none listed there, of the client); 400 on `path` otherwise. */
    async checkSystemUnits(
      tx: TenantTx,
      system: ManagementSystem,
      unitIds: readonly string[],
      path: string,
    ): Promise<void> {
      for (const id of unitIds) {
        const unit = await units.get(tx, id);
        const ofSystem = system.unitIds.length === 0 || system.unitIds.includes(id);
        if (
          unit === null ||
          unit.clientId !== system.clientId ||
          unit.archivedAt !== null ||
          !ofSystem
        ) {
          invalid(path, 'Not a unit of this management system');
        }
      }
    },

    /**
     * Applies the fields of `patch` that change `row` through `write` (one version bump), then audits them: the fields
     * `split` names under their own action (REASSIGN, DUE_DATE_CHANGE) with the reason, the rest as one UPDATE. Nothing
     * is written when nothing changes, as the repository would still bump the version.
     */
    async edit<T extends { id: string; clientId: string }>(
      tx: TenantTx,
      ctx: RequestContext,
      row: T,
      patch: Partial<T>,
      entityType: IsoEntityType,
      write: (changes: Partial<T>) => Promise<T>,
      options: {
        split?: Readonly<Record<string, AuditAction>>;
        reason?: string | null;
        /** The UPDATE carries the reason too (a significance override, model §3.5). */
        reasonOnUpdate?: boolean;
      } = {},
    ): Promise<T> {
      const changed = Object.keys(definedOf(patch)).filter(
        (k) => !same(row[k as keyof T], patch[k as keyof T]),
      ) as (keyof T & string)[];
      if (changed.length === 0) return row;
      const updated = await write(
        Object.fromEntries(changed.map((k) => [k, patch[k]])) as Partial<T>,
      );
      const byAction = new Map<AuditAction, string[]>([['UPDATE', []]]);
      for (const key of changed) {
        const action = options.split?.[key] ?? 'UPDATE';
        byAction.set(action, [...(byAction.get(action) ?? []), key]);
      }
      for (const [action, keys] of byAction) {
        if (keys.length === 0) continue;
        await core.audit(tx, ctx, row.clientId, {
          action,
          entityType,
          entityId: row.id,
          before: Object.fromEntries(keys.map((k) => [k, row[k as keyof T]])),
          after: Object.fromEntries(keys.map((k) => [k, patch[k as keyof T]])),
          reason:
            action === 'UPDATE' && options.reasonOnUpdate !== true
              ? null
              : (options.reason ?? null),
        });
      }
      return updated;
    },

    /** The client's live management system `id` the actor may see, or 404. */
    async loadSystem(
      tx: TenantTx,
      ctx: RequestContext,
      clientId: string,
      id: string,
    ): Promise<ManagementSystem> {
      const system = await core.liveSystem(tx, clientId, id);
      if (!canSee(ctx, systemReach(system))) notFound();
      return system;
    },

    /** The client's live management system `id`, seen or not (a record's parent), or 404. */
    async liveSystem(tx: TenantTx, clientId: string, id: string): Promise<ManagementSystem> {
      const system = await managementSystems.get(tx, id);
      if (system === null || system.clientId !== clientId || system.archivedAt !== null) {
        notFound();
      }
      return system;
    },
  };
  return core;
}

export type Core = ReturnType<typeof createCore>;

/** A live record of the client, or 404. */
export function liveIn<T extends { clientId: string; archivedAt: string | null }>(
  row: T | null,
  clientId: string,
): T {
  if (row === null || row.clientId !== clientId || row.archivedAt !== null) notFound();
  return row;
}
