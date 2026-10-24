import type { Action, Can, Membership, RequestContext, Resource, Role } from '@canopy/contracts';

/**
 * The permission table (docs/contracts/endpoints.md, one row per `can()` action) and the `can()` check.
 *
 * A grant says how a role may perform an action:
 * - `all`: anywhere in the membership's scope.
 * - `own`: in scope, and only where the actor is the resource's owner (OWNER) or approver (APPROVER).
 *   A resource without `ownerId` / `approverId` is denied.
 * - `instance`: in scope, and only on `instance` resources (AP/OW read an instance's audit trail, not the
 *   client's).
 * A role missing from a row is denied. An action missing from the table is denied.
 *
 * Scope per membership (endpoints.md §1):
 * - FIRM_ADMIN: every client of the firm, and firm-level resources (`clientId: null`).
 * - CONSULTANT: clients in `consultantClientIds`, and firm-level resources.
 * - Client roles: their own client only; APPROVER and OWNER only their `unitIds` (all units when null).
 *   Firm-level resources only for rows marked `firmWide` (the library and locations, which every role reads).
 * A client-level resource must also be in `ctx.clientIds`.
 *
 * `ctx.memberships` holds active, non-expired memberships (the request context drops the rest); archived
 * memberships are ignored here too. MFA is enforced when the context is built, not here.
 */

export type Grant = 'all' | 'own' | 'instance';

export interface PolicyRule {
  readonly grants: Readonly<Partial<Record<Role, Grant>>>;
  /** Client roles may act on firm-level resources (`clientId: null`), e.g. reading the library. */
  readonly firmWide?: boolean;
}

const FIRM_ADMIN = { FIRM_ADMIN: 'all' } as const;
const FIRM_STAFF = { ...FIRM_ADMIN, CONSULTANT: 'all' } as const;
const MANAGERS = { ...FIRM_STAFF, CLIENT_ADMIN: 'all' } as const;
const EVERYONE = { ...MANAGERS, APPROVER: 'all', OWNER: 'all', VIEWER: 'all' } as const;
const ON_OWN_INSTANCES = { ...MANAGERS, APPROVER: 'own', OWNER: 'own' } as const;
const REPORT_READERS = { ...MANAGERS, APPROVER: 'all', VIEWER: 'all' } as const;

/** One row per action in docs/contracts/endpoints.md. `<resource>.*` covers every verb of a resource. */
export const POLICY: Readonly<Record<Action, PolicyRule>> = {
  // §2 Auth
  'person.invite': { grants: MANAGERS },

  // §8 The account (M15): account admins only. Support sessions are refused support grants by M15's routes.
  'account.read': { grants: FIRM_ADMIN },
  'supportGrant.read': { grants: FIRM_ADMIN },
  'supportGrant.manage': { grants: FIRM_ADMIN },

  // §3 Clients, entities, locations, departments
  'client.read': { grants: EVERYONE },
  'client.create': { grants: FIRM_ADMIN },
  'client.update': { grants: FIRM_STAFF },
  'client.archive': { grants: FIRM_ADMIN },
  // CLIENT_ADMIN reads settings and may change only the reminder settings; M6 enforces the field limit.
  'client.settings': { grants: MANAGERS },
  'entity.read': { grants: EVERYONE },
  'entity.write': { grants: MANAGERS },
  'location.read': { grants: EVERYONE, firmWide: true },
  'location.write': { grants: MANAGERS, firmWide: true },
  'department.read': { grants: EVERYONE },
  'department.write': { grants: MANAGERS },
  'department.merge': { grants: MANAGERS },

  // §3 People and memberships. The firm staff list has `clientId: null`, so only FA and CO reach it.
  // Which roles a manager may grant is `canGrantRole`.
  'person.read': { grants: EVERYONE },
  'person.write': { grants: MANAGERS },
  'person.merge': { grants: MANAGERS },
  'membership.write': { grants: MANAGERS },

  // §3 Library (firm-wide; client roles' reads are filtered to obligations assigned in their client)
  'library.read': { grants: EVERYONE, firmWide: true },
  'library.write': { grants: FIRM_STAFF },
  'library.push': { grants: FIRM_STAFF },

  // §3 Assignments
  'assignment.read': { grants: EVERYONE },
  'assignment.write': { grants: MANAGERS },
  'assignment.applicability': { grants: MANAGERS },

  // §4 Workflow, evidence, comments, audit
  'instance.read': { grants: EVERYONE },
  'instance.submit': { grants: { OWNER: 'own' } },
  'instance.approve': { grants: { CLIENT_ADMIN: 'all', APPROVER: 'own' } },
  'instance.reopen': { grants: MANAGERS },
  'instance.reassign': { grants: MANAGERS },
  'instance.dueDate': { grants: MANAGERS },
  'comment.read': { grants: { ...ON_OWN_INSTANCES, VIEWER: 'all' } },
  'comment.write': { grants: ON_OWN_INSTANCES },
  'evidence.write': { grants: ON_OWN_INSTANCES },
  'evidence.read': { grants: EVERYONE },
  'evidence.download': { grants: EVERYONE },
  // OWNER only before approval; M7's state machine enforces that part.
  'evidence.remove': { grants: { ...MANAGERS, OWNER: 'own' } },
  'audit.read': {
    grants: { ...MANAGERS, VIEWER: 'all', APPROVER: 'instance', OWNER: 'instance' },
  },

  // §5 Import
  'import.*': { grants: FIRM_STAFF },

  // §6 Dashboards, reports, exports
  'dashboard.portfolio': { grants: FIRM_STAFF },
  'dashboard.read': { grants: EVERYONE },
  'report.read': { grants: REPORT_READERS },
  'export.create': { grants: REPORT_READERS },
  'export.read': { grants: REPORT_READERS },
};

/** The rule for an action: its own row, else its `<resource>.*` row, else none (denied). */
export function ruleFor(action: Action): PolicyRule | undefined {
  if (Object.hasOwn(POLICY, action)) return POLICY[action];
  const wildcard = `${action.slice(0, action.indexOf('.'))}.*`;
  return Object.hasOwn(POLICY, wildcard) ? POLICY[wildcard] : undefined;
}

const FIRM_ROLE_SET: ReadonlySet<Role> = new Set<Role>(['FIRM_ADMIN', 'CONSULTANT']);

export function isFirmRole(role: Role): boolean {
  return FIRM_ROLE_SET.has(role);
}

/** Whether a membership covers the resource's client (and unit, for unit-limited roles). */
function inScope(m: Membership, resource: Resource, firmWide: boolean): boolean {
  const { clientId } = resource;
  switch (m.role) {
    case 'FIRM_ADMIN':
      return true;
    case 'CONSULTANT':
      return clientId === null || (m.consultantClientIds ?? []).includes(clientId);
    default:
      if (clientId === null) return firmWide;
      if (m.clientId !== clientId) return false;
      return (
        m.unitIds === null || resource.unitId === undefined || m.unitIds.includes(resource.unitId)
      );
  }
}

function grantHolds(grant: Grant, m: Membership, ctx: RequestContext, resource: Resource): boolean {
  switch (grant) {
    case 'all':
      return true;
    case 'instance':
      return resource.type === 'instance';
    case 'own':
      if (m.role === 'OWNER') return resource.ownerId === ctx.personId;
      if (m.role === 'APPROVER') return resource.approverId === ctx.personId;
      return false;
  }
}

/** The policy check (M0 `Can`): true when any of the actor's memberships allows the action on the resource. */
export const can: Can = (ctx, action, resource) => {
  const rule = ruleFor(action);
  if (rule === undefined) return false;
  if (resource.clientId !== null && !ctx.clientIds.includes(resource.clientId)) return false;
  return ctx.memberships.some((m) => {
    if (m.archivedAt !== null) return false;
    const grant = rule.grants[m.role];
    return (
      grant !== undefined &&
      inScope(m, resource, rule.firmWide === true) &&
      grantHolds(grant, m, ctx, resource)
    );
  });
};

/**
 * Whether the actor may grant (invite to, or create a membership with) `role`, for `clientId` when it is a
 * client role (endpoints.md §2 and §3): only FIRM_ADMIN grants firm roles; CONSULTANT and CLIENT_ADMIN grant
 * client roles in clients they manage.
 */
export function canGrantRole(ctx: RequestContext, role: Role, clientId: string | null): boolean {
  if (isFirmRole(role) !== (clientId === null)) return false;
  if (clientId !== null && !ctx.clientIds.includes(clientId)) return false;
  return ctx.memberships.some((m) => {
    if (m.archivedAt !== null) return false;
    if (m.role === 'FIRM_ADMIN') return true;
    if (clientId === null) return false;
    if (m.role === 'CONSULTANT') return (m.consultantClientIds ?? []).includes(clientId);
    return m.role === 'CLIENT_ADMIN' && m.clientId === clientId;
  });
}
