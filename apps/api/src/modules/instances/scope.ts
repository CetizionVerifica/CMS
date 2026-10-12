import type { RequestContext, Role } from '@canopy/contracts';

/**
 * What part of a client a person may see in lists (endpoints.md §1). Pure: reads only the request context,
 * whose memberships are already active and unexpired.
 */

/** Roles that see every unit of a client they can see. */
const WHOLE_CLIENT: ReadonlySet<Role> = new Set([
  'FIRM_ADMIN',
  'CONSULTANT',
  'CLIENT_ADMIN',
  'VIEWER',
]);

function coversClient(m: RequestContext['memberships'][number], clientId: string): boolean {
  if (m.role === 'FIRM_ADMIN') return true;
  if (m.role === 'CONSULTANT') return (m.consultantClientIds ?? []).includes(clientId);
  return m.clientId === clientId;
}

/**
 * The units of `clientId` a person may list, or null for all of them. APPROVER and OWNER are limited to their
 * `unitIds` (null = all units); any whole-client role lifts the limit. A person with no role in the client
 * gets an empty list.
 */
export function unitScope(ctx: RequestContext, clientId: string): string[] | null {
  const here = ctx.memberships.filter((m) => m.archivedAt === null && coversClient(m, clientId));
  if (here.some((m) => WHOLE_CLIENT.has(m.role))) return null;
  if (here.some((m) => m.unitIds === null)) return null;
  return [...new Set(here.flatMap((m) => m.unitIds ?? []))].sort();
}

/** The roles a person holds in `clientId`. */
export function rolesIn(ctx: RequestContext, clientId: string): Set<Role> {
  return new Set(
    ctx.memberships
      .filter((m) => m.archivedAt === null && coversClient(m, clientId))
      .map((m) => m.role),
  );
}

/** Roles that may read derived status "as at" another date (api-conventions.md §1). */
const AS_OF_ROLES: ReadonlySet<Role> = new Set(['FIRM_ADMIN', 'CONSULTANT', 'VIEWER']);

export function mayChooseAsOf(ctx: RequestContext, clientId: string): boolean {
  return [...rolesIn(ctx, clientId)].some((role) => AS_OF_ROLES.has(role));
}

/** Every client in which the person holds one of `roles`, in `ctx.clientIds` order. */
export function clientsWithRole(ctx: RequestContext, roles: readonly Role[]): string[] {
  return ctx.clientIds.filter((clientId) => {
    const held = rolesIn(ctx, clientId);
    return roles.some((role) => held.has(role));
  });
}
