import {
  type Action,
  type Can,
  type Endpoint,
  type Id,
  type Membership,
  type RequestContext,
  type Resource,
  type Role,
} from '@canopy/contracts';
import { forbidden, notFound } from './errors.js';

/**
 * Who may call what, for the M6 routes. The endpoint table in @canopy/contracts names the roles per endpoint; M5's
 * `can()` decides per action.
 */

function active(ctx: RequestContext): Membership[] {
  return ctx.memberships.filter((m) => m.archivedAt === null);
}

export function hasRole(ctx: RequestContext, ...roles: Role[]): boolean {
  return active(ctx).some((m) => roles.includes(m.role));
}

/** Firm admins and consultants: they change the library and see firm staff. */
export function isFirmStaff(ctx: RequestContext): boolean {
  return hasRole(ctx, 'FIRM_ADMIN', 'CONSULTANT');
}

/** `ctx.clientIds` holds every client the actor sees, a firm admin's whole firm included (M5). */
export function canSeeClient(ctx: RequestContext, clientId: Id): boolean {
  return ctx.clientIds.includes(clientId);
}

function membershipApplies(m: Membership, clientId: Id | null, unitId?: Id): boolean {
  switch (m.role) {
    case 'FIRM_ADMIN':
      return true;
    case 'CONSULTANT':
      return clientId === null || (m.consultantClientIds ?? []).includes(clientId);
    default:
      if (clientId === null) return true;
      if (m.clientId !== clientId) return false;
      return unitId === undefined || m.unitIds === null || m.unitIds.includes(unitId);
  }
}

/** The actor's roles that reach a resource in `clientId` (null for firm-wide rows such as the library). */
export function rolesFor(ctx: RequestContext, clientId: Id | null, unitId?: Id): Role[] {
  return [
    ...new Set(
      active(ctx)
        .filter((m) => membershipApplies(m, clientId, unitId))
        .map((m) => m.role),
    ),
  ];
}

/**
 * Units an actor is limited to in a client: null when some role sees every unit, else the union of the OWNER and
 * APPROVER memberships' units (endpoints.md §1).
 */
export function unitScope(ctx: RequestContext, clientId: Id): Id[] | null {
  const applying = active(ctx).filter((m) => membershipApplies(m, clientId));
  const units = new Set<Id>();
  for (const m of applying) {
    if ((m.role !== 'OWNER' && m.role !== 'APPROVER') || m.unitIds === null) return null;
    m.unitIds.forEach((u) => units.add(u));
  }
  return [...units];
}

/**
 * Checks an endpoint call against its role table and `can()`. A client the actor cannot see is 404, never 403
 * (api-conventions.md §5). Returns the actor's roles that reach the resource and the endpoint allows.
 */
export function authorize(
  ctx: RequestContext,
  endpoint: Endpoint,
  resource: Resource,
  can: Can,
): Role[] {
  if (resource.clientId !== null && !canSeeClient(ctx, resource.clientId)) throw notFound();
  const action: Action = endpoint.actions[0] ?? 'session.use';
  const roles = rolesFor(ctx, resource.clientId, resource.unitId).filter(
    (r) => endpoint.roles[r] !== undefined,
  );
  if (roles.length === 0 || !can(ctx, action, resource)) throw forbidden(action);
  return roles;
}
