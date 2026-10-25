// Shared pieces of the mock's ISO handlers: lookups, unit scope (docs/iso/plan.md §3.3), people checks (model §1.5),
// errors, writes and ISO audit events (model §8). Area handlers live in ../handlers/iso/.
import type { z } from 'zod';
import type { IsoEntityType, Role } from '../../enums.js';
import {
  type Actor,
  checkVersion,
  type Clock,
  diff,
  MockError,
  notFound,
  type Scope,
  visibleClientIds,
} from '../core.js';
import type { FirmState, IsoAuditEvent, IsoRow, IsoTables } from '../store.js';

export type IsoEntity = z.input<typeof IsoEntityType>;
export type IsoTable = keyof IsoTables;

/** What every ISO handler needs from its request context. */
export interface IsoCtx {
  store: { newId(): string; token(prefix: string): string };
  clock: Clock;
  requestId: string;
}

// ---------- lookups ----------

/** A live (not archived) row of an ISO table in this client, or 404. */
export function requireIso<K extends IsoTable>(
  firm: FirmState,
  table: K,
  clientId: string,
  id: string,
): IsoRow<K> {
  const row = (firm.iso[table] as IsoRow<K>[]).find(
    (r) =>
      (r as { id: string }).id === id &&
      (r as { clientId: string }).clientId === clientId &&
      (r as { archivedAt: string | null }).archivedAt === null,
  );
  if (row === undefined) throw notFound();
  return row;
}

/** Live rows of an ISO table in this client. */
export function liveIso<K extends IsoTable>(
  firm: FirmState,
  table: K,
  clientId: string,
): IsoRow<K>[] {
  return (firm.iso[table] as IsoRow<K>[]).filter(
    (r) =>
      (r as { clientId: string }).clientId === clientId &&
      (r as { archivedAt: string | null }).archivedAt === null,
  );
}

/** Live units of a client. */
export function clientUnitIds(firm: FirmState, clientId: string): string[] {
  return firm.data.units
    .filter((u) => u.clientId === clientId && u.archivedAt === null)
    .map((u) => u.id);
}

/** A management system's units: its list, or every live unit of the client when the list is empty (plan §3.3). */
export function systemUnitIds(firm: FirmState, system: IsoRow<'managementSystems'>): string[] {
  return system.unitIds.length > 0 ? [...system.unitIds] : clientUnitIds(firm, system.clientId);
}

/** The client's live management system `id`, or 404. */
export function requireSystem(
  firm: FirmState,
  clientId: string,
  id: string,
): IsoRow<'managementSystems'> {
  return requireIso(firm, 'managementSystems', clientId, id);
}

/** Catalogue clause by id in the firm's copy. */
export function clauseOf(firm: FirmState, clauseId: string) {
  return firm.isoCatalogue.clauses.find((c) => c.id === clauseId);
}

/** Catalogue standard by id in the firm's copy. */
export function standardOf(firm: FirmState, standardId: string) {
  return firm.isoCatalogue.standards.find((s) => s.id === standardId);
}

// ---------- unit scope (plan §3.3) ----------

/**
 * Where an ISO record sits, for unit scope: its client, the units it covers, and the people it names (owner,
 * approver, lead auditor, auditor, auditee, reported-to, chair, attendee, investigator), who always see it.
 */
export interface IsoReach {
  clientId: string;
  /** The record's effective units, never empty unless the client has no units. */
  unitIds: string[];
  people: string[];
}

/**
 * A record's reach. Its own `unitId` wins; else its non-empty `unitIds`; else its management system's units (every
 * client unit when that list is empty, plan §3.3); else, with no system, every unit of the client.
 */
export function reachOf(
  firm: FirmState,
  record: {
    clientId: string;
    unitId?: string | null;
    unitIds?: readonly string[] | null;
    systemId?: string | null;
    people?: readonly (string | null | undefined)[];
  },
): IsoReach {
  let unitIds: string[];
  if (record.unitId != null) unitIds = [record.unitId];
  else if (record.unitIds != null && record.unitIds.length > 0) unitIds = [...record.unitIds];
  else {
    const system =
      record.systemId == null
        ? undefined
        : firm.iso.managementSystems.find((s) => s.id === record.systemId);
    unitIds =
      system === undefined ? clientUnitIds(firm, record.clientId) : systemUnitIds(firm, system);
  }
  const people = (record.people ?? []).filter((p): p is string => typeof p === 'string');
  return { clientId: record.clientId, unitIds, people };
}

/**
 * Whether the actor may see a record with this reach: the client is visible to them and either a membership there is
 * client-wide (FA, CO, or no unit list), one of its units overlaps the record's, or the record names them.
 */
export function canSee(actor: Actor, reach: IsoReach): boolean {
  if (!visibleClientIds(actor).includes(reach.clientId)) return false;
  if (reach.people.includes(actor.person.id)) return true;
  return actor.memberships.some((m) => {
    if (m.role === 'FIRM_ADMIN') return true;
    if (m.role === 'CONSULTANT') return m.consultantClientIds!.includes(reach.clientId);
    if (m.clientId !== reach.clientId) return false;
    return m.unitIds === null || m.unitIds.some((u) => reach.unitIds.includes(u));
  });
}

/** The role-check scope for a record: its units, unless the record names the actor (the named-person exception). */
export function isoScope(
  actor: Actor,
  reach: IsoReach,
  own: { ownerId?: string | null; approverId?: string | null } = {},
): Scope {
  const named = reach.people.includes(actor.person.id);
  return {
    clientId: reach.clientId,
    ...(named || reach.unitIds.length === 0 ? {} : { unitIds: reach.unitIds }),
    ...(own.ownerId == null ? {} : { ownerId: own.ownerId }),
    ...(own.approverId == null ? {} : { approverId: own.approverId }),
  };
}

/**
 * The scope for an action whose "own" names people other than an owner or approver (lead or auditor, chair; plan
 * §3.2): both are the actor when they are one of `people`, unset otherwise.
 */
export function selfScope(
  actor: Actor,
  reach: IsoReach,
  people: readonly (string | null)[],
): Scope {
  const me = people.includes(actor.person.id) ? actor.person.id : null;
  return isoScope(actor, reach, { ownerId: me, approverId: me });
}

/** Whether the actor holds one of `roles` in the client, client-wide or in one of `unitIds`. */
export function holdsRole(
  actor: Actor,
  clientId: string,
  roles: readonly Role[],
  unitIds?: readonly string[],
): boolean {
  return actor.memberships.some((m) => {
    if (!roles.includes(m.role)) return false;
    if (m.role === 'FIRM_ADMIN') return true;
    if (m.role === 'CONSULTANT') return m.consultantClientIds!.includes(clientId);
    if (m.clientId !== clientId) return false;
    return (
      m.unitIds === null || unitIds === undefined || m.unitIds.some((u) => unitIds.includes(u))
    );
  });
}

/** FA, CO or CA in the client: the roles that may take a step as delegate (model §4 preamble). */
export const isIsoManager = (actor: Actor, clientId: string) =>
  holdsRole(actor, clientId, ['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN']);

export const isClientAdmin = (actor: Actor, clientId: string) =>
  holdsRole(actor, clientId, ['CLIENT_ADMIN']);

// ---------- checks ----------

export function invalid(path: string, message: string): never {
  throw new MockError('VALIDATION', message, { issues: [{ path: ['body', path], message }] });
}

export function forbidden(action: string, message: string): never {
  throw new MockError('FORBIDDEN', message, { action });
}

/** 409 INVALID_TRANSITION: `action` is not allowed from `from` (a field edit or a new child row is `UPDATE`). */
export function invalidTransition(entity: IsoEntity, from: string, action: string): never {
  throw new MockError('INVALID_TRANSITION', `${action} is not allowed from ${from}`, {
    entity,
    from,
    action,
  });
}

export function reasonRequired(): never {
  throw new MockError('REASON_REQUIRED', 'A reason is required');
}

/** 409 STALE_VERSION unless `version` is current. */
export const checkIsoVersion = (row: { version: number }, version: number) =>
  checkVersion(row, version);

/**
 * A person named on an ISO record must hold a live role in its client covering its unit (model §1.5): FIRM_ADMIN,
 * CONSULTANT of the client, or a client membership with no unit list or one that has `unitId`. VIEWER never counts.
 */
export function checkIsoPerson(
  actor: Actor,
  clientId: string,
  personId: string,
  path: string,
  options: { unitId?: string | null; roles?: readonly Role[] } = {},
): void {
  const roles = options.roles ?? ['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN', 'APPROVER', 'OWNER'];
  const held = actor.firm.data.memberships.filter(
    (m) => m.personId === personId && m.archivedAt === null && m.expiresAt === null,
  );
  const fits = held.some((m) => {
    if (!roles.includes(m.role)) return false;
    if (m.role === 'FIRM_ADMIN') return true;
    if (m.role === 'CONSULTANT') return m.consultantClientIds!.includes(clientId);
    if (m.clientId !== clientId) return false;
    return options.unitId == null || m.unitIds === null || m.unitIds.includes(options.unitId);
  });
  const person = actor.firm.data.people.find((p) => p.id === personId && p.archivedAt === null);
  if (!fits || person === undefined || person.status === 'DISABLED') {
    invalid(path, 'Not a person who works in this client and unit');
  }
}

/** Each unit is a live unit of the client. */
export function checkClientUnits(
  firm: FirmState,
  clientId: string,
  unitIds: readonly string[],
  path: string,
): void {
  const units = clientUnitIds(firm, clientId);
  if (unitIds.some((u) => !units.includes(u))) invalid(path, 'Not a unit of this client');
}

/** Units of a record of a system must be units of that system (or of the client when the system has none listed). */
export function checkSystemUnits(
  firm: FirmState,
  system: IsoRow<'managementSystems'>,
  unitIds: readonly string[],
  path: string,
): void {
  const units = systemUnitIds(firm, system);
  if (unitIds.some((u) => !units.includes(u)))
    invalid(path, 'Not a unit of this management system');
}

/** Each clause id is a clause of the firm's catalogue copy in one of the system's standards. */
export function checkSystemClauses(
  firm: FirmState,
  system: IsoRow<'managementSystems'>,
  clauseIds: readonly string[],
  path: string,
): void {
  for (const id of clauseIds) {
    const clause = clauseOf(firm, id);
    if (clause === undefined || !system.standardIds.includes(clause.standardId)) {
      invalid(path, "Not a clause of the system's standards");
    }
  }
}

// ---------- writes ----------

/** Base fields of a new ISO client record. */
export function isoFresh(ctx: IsoCtx, actor: Actor, clientId: string) {
  const now = ctx.clock.now();
  return {
    id: ctx.store.newId(),
    firmId: actor.firm.data.firm.id,
    clientId,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    version: 1,
  };
}

/** Appends an ISO audit event (model §8). `delegated` marks a step a manager took for the person named (model §4). */
export function isoAudit(
  ctx: IsoCtx,
  actor: Actor,
  event: {
    action: IsoAuditEvent['action'];
    entityType: IsoEntity;
    entityId: string;
    clientId: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    reason?: string | null;
    delegated?: boolean;
  },
): void {
  actor.firm.isoAuditEvents.push({
    id: ctx.store.newId(),
    firmId: actor.firm.data.firm.id,
    clientId: event.clientId,
    at: ctx.clock.now(),
    requestId: ctx.requestId,
    actorId: actor.person.id,
    actorKind: 'PERSON',
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    before: event.before ?? null,
    after:
      event.delegated === true
        ? { ...(event.after ?? {}), delegated: true }
        : (event.after ?? null),
    reason: event.reason ?? null,
  });
}

/**
 * Files confirmed through the mock pass (or, for "eicar" files, fail) their scan when next read or relied on (M9's job),
 * as `finishScans` does for evidence.
 */
export function finishIsoScans(firm: FirmState): void {
  for (const file of firm.iso.files) {
    if (!firm.scanning.has(file.id)) continue;
    file.scanStatus = /eicar/i.test(file.fileName) ? 'INFECTED' : 'CLEAN';
    firm.scanning.delete(file.id);
  }
}

/** Bumps version and updatedAt. */
export function touchIso(ctx: IsoCtx, row: { version: number; updatedAt: string }): void {
  row.version += 1;
  row.updatedAt = ctx.clock.now();
}

/**
 * Applies the defined fields of `patch` to `row` (checking `version` first), bumps it and audits the fields that
 * changed as `action` (UPDATE by default). Returns the row. Nothing is written when nothing changed.
 */
export function patchIso<
  T extends { id: string; clientId: string; version: number; updatedAt: string },
>(
  ctx: IsoCtx,
  actor: Actor,
  row: T,
  version: number,
  patch: Partial<T>,
  entityType: IsoEntity,
  options: { action?: IsoAuditEvent['action']; reason?: string | null; delegated?: boolean } = {},
): T {
  checkIsoVersion(row, version);
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
  const before = { ...row } as Record<string, unknown>;
  const after = { ...row, ...defined } as Record<string, unknown>;
  const changes = diff(before, after);
  if (Object.keys(changes.after).length === 0) return row;
  Object.assign(row, defined);
  touchIso(ctx, row);
  isoAudit(ctx, actor, {
    action: options.action ?? 'UPDATE',
    entityType,
    entityId: row.id,
    clientId: row.clientId,
    before: changes.before,
    after: changes.after,
    reason: options.reason ?? null,
    ...(options.delegated === undefined ? {} : { delegated: options.delegated }),
  });
  return row;
}

/** Days from `from` to `to` (calendar dates). */
export function daysFrom(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** `date` plus `days` (calendar dates). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
