import type { Can, RequestContext, Resource } from '../schemas/context.js';
import { FIRM_ROLES } from '../enums.js';
import { ENDPOINTS } from './endpoints.js';

/**
 * The M0 stub `can()` (domain-model.md §8): allows by the endpoints.md role matrix in `ENDPOINTS`, within each
 * membership's scope. `limited` access counts as allowed; the restriction in the endpoint's notes is the provider's
 * check. M5 replaces this with the real policy; modules use it until then.
 */
export const can: Can = (ctx, action, resource) =>
  Object.values(ENDPOINTS)
    .filter((ep) => ep.actions.includes(action))
    .some((ep) =>
      ctx.memberships.some((m) => {
        const access = ep.roles[m.role];
        if (access === undefined || !inScope(ctx, m, resource)) return false;
        if (access !== 'own') return true;
        if (m.role === 'OWNER') return resource.ownerId === ctx.personId;
        return m.role === 'APPROVER' && resource.approverId === ctx.personId;
      }),
    );

const firmRoles: readonly string[] = FIRM_ROLES;

function inScope(
  ctx: RequestContext,
  m: RequestContext['memberships'][number],
  resource: Resource,
): boolean {
  // Firm roles act only after MFA (api-conventions.md §1).
  if (firmRoles.includes(m.role) && !ctx.mfaSatisfied) return false;
  if (m.role === 'FIRM_ADMIN') return true;
  // Firm-level resources (the library, firm staff): the role matrix alone decides.
  if (resource.clientId === null) return true;
  if (m.role === 'CONSULTANT') return m.consultantClientIds!.includes(resource.clientId);
  if (m.clientId !== resource.clientId) return false;
  if (m.unitIds === null) return true;
  // A record over several units (docs/iso/plan.md §3.3) needs one of them; a single-unit record needs its unit.
  if (resource.unitIds !== undefined && !resource.unitIds.some((id) => m.unitIds!.includes(id))) {
    return false;
  }
  return resource.unitId === undefined || m.unitIds.includes(resource.unitId);
}
