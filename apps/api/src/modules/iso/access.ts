import type {
  Action,
  Certification,
  ClauseAssessment,
  ControlledDocument,
  IsoEntityType,
  ManagementSystem,
  RequestContext,
  Resource,
  Role,
} from '@canopy/contracts';
import type { UnitScope } from '@canopy/db';
import { can } from '../../auth/index.js';
import { forbidden } from './errors.js';

/**
 * Who sees and may change an ISO record (docs/iso/plan.md §3.2-3.3). Pure: reads only the request context and the
 * record's reach. One `Resource` builder for every M16 route, so `allowedActions` and the routes ask `can()` the same
 * question (model §10).
 */

type Membership = RequestContext['memberships'][number];

/**
 * Where an ISO record sits: its client, its effective units (its own, else its management system's; empty means every
 * unit of the client, as for a system with no units) and the people it names, who always see it.
 */
export interface Reach {
  clientId: string;
  unitIds: readonly string[];
  people: readonly (string | null | undefined)[];
}

/** A system's reach: its units (none listed means every unit). A system names nobody. */
export const systemReach = (system: ManagementSystem): Reach => ({
  clientId: system.clientId,
  unitIds: system.unitIds,
  people: [],
});

/** A checklist row takes its system's units, and its owner always sees it (the named-person exception). */
export const checklistRowReach = (
  system: ManagementSystem,
  row: Pick<ClauseAssessment, 'ownerId'>,
): Reach => ({ ...systemReach(system), people: [row.ownerId] });

/** A document takes its management system's units; its owner and approver always see it. */
export const documentReach = (system: ManagementSystem, doc: ControlledDocument): Reach => ({
  ...systemReach(system),
  people: [doc.ownerId, doc.approverId],
});

/** A certificate covers its units, or its management system's when its list is empty. Nobody is named. */
export const certificateReach = (system: ManagementSystem, certificate: Certification): Reach => ({
  clientId: certificate.clientId,
  unitIds: certificate.unitIds.length > 0 ? certificate.unitIds : system.unitIds,
  people: [],
});

/** Roles that see every unit of a client they can see. */
const WHOLE_CLIENT: ReadonlySet<Role> = new Set([
  'FIRM_ADMIN',
  'CONSULTANT',
  'CLIENT_ADMIN',
  'VIEWER',
]);

/** FA, CO and CA: the roles that set records up and take a step as delegate (model §4 preamble). */
export const MANAGERS: readonly Role[] = ['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN'];

function coversClient(m: Membership, clientId: string): boolean {
  if (m.role === 'FIRM_ADMIN') return true;
  if (m.role === 'CONSULTANT') return (m.consultantClientIds ?? []).includes(clientId);
  return m.clientId === clientId;
}

const live = (ctx: RequestContext, clientId: string) =>
  ctx.memberships.filter((m) => m.archivedAt === null && coversClient(m, clientId));

/**
 * The units of `clientId` a person reads ISO records of, or null for the whole client. APPROVER and OWNER are limited
 * to their `unitIds` (null = all units); any whole-client role lifts the limit.
 */
export function unitScopeOf(ctx: RequestContext, clientId: string): string[] | null {
  const here = live(ctx, clientId);
  if (here.some((m) => WHOLE_CLIENT.has(m.role) || m.unitIds === null)) return null;
  return [...new Set(here.flatMap((m) => m.unitIds ?? []))].sort();
}

/** The scope M3's list reads take (plan §3.3 in SQL), or undefined for a reader of the whole client. */
export function listScope(ctx: RequestContext, clientId: string): UnitScope | undefined {
  const unitIds = unitScopeOf(ctx, clientId);
  return unitIds === null ? undefined : { unitIds, personId: ctx.personId };
}

const named = (ctx: RequestContext, reach: Reach) => reach.people.includes(ctx.personId);

/**
 * Whether the person sees a record: its client is theirs and they read the whole client, the record names them, it
 * covers every unit, or one of its units is theirs.
 */
export function canSee(ctx: RequestContext, reach: Reach): boolean {
  if (!ctx.clientIds.includes(reach.clientId)) return false;
  const units = unitScopeOf(ctx, reach.clientId);
  return (
    units === null ||
    named(ctx, reach) ||
    reach.unitIds.length === 0 ||
    reach.unitIds.some((u) => units.includes(u))
  );
}

/**
 * The `Resource` for an action on a record: its units unless the record names the actor (the named-person exception,
 * plan §3.3) or covers every unit, and the people the action's "own" names.
 */
export function isoResource(
  ctx: RequestContext,
  type: IsoEntityType,
  reach: Reach,
  own: { ownerId?: string | null; approverId?: string | null } = {},
): Resource {
  return {
    type,
    clientId: reach.clientId,
    ...(named(ctx, reach) || reach.unitIds.length === 0 ? {} : { unitIds: [...reach.unitIds] }),
    ...(own.ownerId == null ? {} : { ownerId: own.ownerId }),
    ...(own.approverId == null ? {} : { approverId: own.approverId }),
  };
}

/**
 * The `Resource` for an action whose "own" names people other than an owner or approver (lead or auditor, chair; plan
 * §3.2): both are the actor when they are one of `people`, unset otherwise.
 */
export function selfResource(
  ctx: RequestContext,
  type: IsoEntityType,
  reach: Reach,
  people: readonly (string | null)[],
): Resource {
  const me = people.includes(ctx.personId) ? ctx.personId : null;
  return isoResource(ctx, type, reach, { ownerId: me, approverId: me });
}

/** The `Resource` for an action with no "own" grant: being named on the record widens nothing. */
export function unitResource(type: IsoEntityType, reach: Reach): Resource {
  return {
    type,
    clientId: reach.clientId,
    ...(reach.unitIds.length === 0 ? {} : { unitIds: [...reach.unitIds] }),
  };
}

/** `can()`, as a boolean for `allowedActions`. */
export const may = (ctx: RequestContext, action: Action, resource: Resource): boolean =>
  can(ctx, action, resource);

/** `can()`, or 403 FORBIDDEN naming the action. */
export function authorize(ctx: RequestContext, action: Action, resource: Resource): void {
  if (!can(ctx, action, resource)) forbidden(action);
}

/**
 * Whether the person holds one of `roles` in the client covering the record's units: client-wide, or a unit-limited
 * membership that overlaps them (a record over every unit overlaps any). Leave `unitIds` out to ask for the client.
 */
export function holdsRole(
  ctx: RequestContext,
  clientId: string,
  roles: readonly Role[],
  unitIds?: readonly string[],
): boolean {
  return live(ctx, clientId).some(
    (m) =>
      roles.includes(m.role) &&
      (m.unitIds === null ||
        unitIds === undefined ||
        unitIds.length === 0 ||
        m.unitIds.some((u) => unitIds.includes(u))),
  );
}

/** The units a role must cover for the person to act: none when the record names them (plan §3.3). */
export const unitsFor = (ctx: RequestContext, reach: Reach): readonly string[] | undefined =>
  named(ctx, reach) ? undefined : reach.unitIds;

/** A manager (FA, CO or CA) covering the record. */
export const isManager = (ctx: RequestContext, reach: Reach): boolean =>
  holdsRole(ctx, reach.clientId, MANAGERS, unitsFor(ctx, reach));
