// Route table for the shell (apps/web/CLAUDE.md "Routes"). The sidebar, the client switcher and the `[...stub]`
// placeholder pages all read it, so a route exists in one place.
import type { Role } from '@canopy/contracts';

export type Scope = 'client' | 'firm';

export type RouteDef = {
  /** Path under `/c/[clientId]` for client routes, or from the root for firm routes. */
  path: string;
  label: string;
  scope: Scope;
  /** The module that ships the real page. Until it does, the `[...stub]` page shows a placeholder. */
  module: 'M12' | 'M13';
  /** Roles that see the route. Absent = every role. */
  roles?: readonly Role[];
};

const FIRM: readonly Role[] = ['FIRM_ADMIN', 'CONSULTANT'];
const MANAGERS: readonly Role[] = ['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN'];

export const ROUTES: readonly RouteDef[] = [
  { path: 'overview', label: 'Overview', scope: 'client', module: 'M13' },
  { path: 'register', label: 'Register', scope: 'client', module: 'M12' },
  { path: 'calendar', label: 'Calendar', scope: 'client', module: 'M12' },
  {
    path: 'approvals',
    label: 'Approvals',
    scope: 'client',
    module: 'M12',
    roles: ['CLIENT_ADMIN', 'APPROVER'],
  },
  { path: 'evidence', label: 'Evidence', scope: 'client', module: 'M12' },
  {
    path: 'reports',
    label: 'Reports',
    scope: 'client',
    module: 'M13',
    roles: [...MANAGERS, 'APPROVER', 'VIEWER'],
  },
  {
    path: 'audit',
    label: 'Audit trail',
    scope: 'client',
    module: 'M13',
    roles: [...MANAGERS, 'VIEWER'],
  },
  { path: 'setup/entities', label: 'Entities', scope: 'client', module: 'M13', roles: MANAGERS },
  { path: 'setup/people', label: 'People', scope: 'client', module: 'M13', roles: MANAGERS },
  {
    path: 'setup/departments',
    label: 'Departments',
    scope: 'client',
    module: 'M13',
    roles: MANAGERS,
  },
  { path: 'setup/reminders', label: 'Reminders', scope: 'client', module: 'M13', roles: MANAGERS },
  { path: 'import', label: 'Import', scope: 'client', module: 'M13', roles: FIRM },
  { path: 'portfolio', label: 'Portfolio', scope: 'firm', module: 'M13', roles: FIRM },
  { path: 'library/acts', label: 'Acts', scope: 'firm', module: 'M13' },
  { path: 'library/obligations', label: 'Obligations', scope: 'firm', module: 'M13' },
  // The customer's own account: plan, usage and PlanetPulse support access (ADR M15-0001 decisions 5 and 11).
  { path: 'account', label: 'Account', scope: 'firm', module: 'M13', roles: ['FIRM_ADMIN'] },
];

export function clientHref(clientId: string, path = 'overview'): string {
  return `/c/${encodeURIComponent(clientId)}/${path}`;
}

export function firmHref(path: string): string {
  return `/${path}`;
}

export function hrefFor(route: RouteDef, clientId?: string): string {
  return route.scope === 'client' && clientId
    ? clientHref(clientId, route.path)
    : firmHref(route.path);
}

/** Whether any of the actor's roles may see the route. */
export function visibleTo(route: RouteDef, roles: readonly Role[]): boolean {
  return !route.roles || route.roles.some((r) => roles.includes(r));
}

/** The route a stub page stands in for, or undefined (the stub then 404s). */
export function findRoute(scope: Scope, segments: readonly string[]): RouteDef | undefined {
  const path = segments.join('/');
  return ROUTES.find((r) => r.scope === scope && r.path === path);
}

export function routeByPath(path: string): RouteDef {
  const route = ROUTES.find((r) => r.path === path);
  if (!route) throw new Error(`Unknown route ${path}`);
  return route;
}

/**
 * The same page for another client: `/c/a/register/123?fy=2022-23` → `/c/b/register?fy=2022-23`.
 * A record id belongs to the old client, so only the section is kept; firm pages go to the new client's overview.
 */
export function switchClientHref(pathname: string, search: string, clientId: string): string {
  const match = /^\/c\/[^/]+\/(.+)$/.exec(pathname);
  const rest = match?.[1] ?? '';
  const section = ROUTES.filter((r) => r.scope === 'client')
    .map((r) => r.path)
    .sort((a, b) => b.length - a.length)
    .find((p) => rest === p || rest.startsWith(`${p}/`));
  const query = search && search !== '?' ? (search.startsWith('?') ? search : `?${search}`) : '';
  return `${clientHref(clientId, section ?? 'overview')}${query}`;
}

/** The client id in a pathname, if it is a client route. */
export function clientIdFromPath(pathname: string): string | undefined {
  const match = /^\/c\/([^/]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

/** Only same-site paths are accepted as a post-login destination, so `?next=` can't redirect off the site. */
export function safeNextPath(next: string | null | undefined): string | undefined {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\'))
    return undefined;
  // Control characters (tabs, newlines) could change how a browser reads the path.
  if ([...next].some((ch) => ch.charCodeAt(0) < 0x20)) return undefined;
  return next;
}
