// What the shell shows for the signed-in user: their roles, the clients in the switcher and the sidebar sections.
// Plain data, built on the server and passed to the client frame (icons are attached there, since components can't
// cross the server/client boundary).
import { FIRM_ROLES, type Role } from '@canopy/contracts';

import type { ClientShellInfo, MeResponse } from '../api/types';
import { hrefFor, routeByPath, visibleTo } from '../routes';

export type ShellClient = {
  id: string;
  name: string;
  /** "3 units" */
  meta: string;
  overdueCount: number;
  fyStartMonth: number;
  timeZone: string;
} & Omit<ClientShellInfo, 'unitCount'>;

export type ShellUser = { name: string; detail: string; email: string | null };

export type ShellModel = {
  user: ShellUser;
  clients: ShellClient[];
  isFirmUser: boolean;
  /** Roles per client id (firm roles included), and firm roles alone for firm-level pages. */
  roles: { firm: Role[]; byClient: Record<string, Role[]> };
};

export type NavSection = { label?: string; items: { path: string; label: string; href: string }[] };

const ROLE_LABEL: Record<Role, string> = {
  FIRM_ADMIN: 'Firm admin',
  CONSULTANT: 'Consultant',
  CLIENT_ADMIN: 'Client admin',
  APPROVER: 'Approver',
  OWNER: 'Owner',
  VIEWER: 'Viewer',
};

const firmRoles: readonly Role[] = FIRM_ROLES;

export function isFirmUser(me: Pick<MeResponse, 'memberships'>): boolean {
  return me.memberships.some((m) => firmRoles.includes(m.role));
}

/** The actor's roles, limited to one client when given: firm roles apply everywhere, client roles to their client. */
export function rolesFor(me: Pick<MeResponse, 'memberships'>, clientId?: string): Role[] {
  const roles = me.memberships
    .filter((m) => m.clientId === null || clientId === undefined || m.clientId === clientId)
    .map((m) => m.role);
  return [...new Set(roles)];
}

function unitsLabel(n: number): string {
  return `${n} ${n === 1 ? 'unit' : 'units'}`;
}

/** `overdue` comes from GET /portfolio (firm users); client users see no count. */
export function buildShellModel(me: MeResponse, overdue: Record<string, number> = {}): ShellModel {
  const roles = rolesFor(me);
  const clients = me.clients
    .filter((c) => c.archivedAt === null)
    .map((c): ShellClient | undefined => {
      const info = me.shell[c.id];
      if (!info) return undefined;
      const { unitCount, ...period } = info;
      return {
        id: c.id,
        name: c.name,
        meta: unitsLabel(unitCount),
        overdueCount: overdue[c.id] ?? 0,
        fyStartMonth: c.settings.fyStartMonth,
        timeZone: c.settings.timeZone,
        ...period,
      };
    })
    .filter((c): c is ShellClient => !!c)
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    user: {
      name: me.person.displayName,
      detail: roles.map((r) => ROLE_LABEL[r]).join(', '),
      email: me.person.email,
    },
    clients,
    isFirmUser: isFirmUser(me),
    roles: {
      firm: roles.filter((r) => firmRoles.includes(r)),
      byClient: Object.fromEntries(clients.map((c) => [c.id, rolesFor(me, c.id)])),
    },
  };
}

const CLIENT_SECTIONS: { label?: string; paths: string[] }[] = [
  { paths: ['overview', 'register', 'calendar', 'approvals', 'evidence'] },
  { label: 'Reporting', paths: ['reports', 'audit'] },
  { label: 'Setup', paths: ['setup/entities', 'setup/people', 'import'] },
];

const FIRM_SECTION = { label: 'Firm', paths: ['portfolio', 'library/acts'] };

/**
 * Sidebar sections (spec 01 "Default nav"). With no client selected only the firm items show. Items a role can't
 * use are left out rather than shown disabled.
 */
export function navSections(roles: readonly Role[], clientId?: string): NavSection[] {
  const groups = clientId ? [...CLIENT_SECTIONS, FIRM_SECTION] : [FIRM_SECTION];
  return groups
    .map((g) => ({
      ...(g.label ? { label: g.label } : {}),
      items: g.paths
        .map(routeByPath)
        .filter((r) => visibleTo(r, roles))
        .map((r) => ({
          path: r.path,
          label: r.path === 'library/acts' ? 'Library' : r.label,
          href: hrefFor(r, clientId),
        })),
    }))
    .filter((g) => g.items.length > 0);
}

/** Where a signed-in user lands: firm users on the portfolio, client users on their (first) client's overview. */
export function homeHref(model: Pick<ShellModel, 'clients' | 'isFirmUser'>): string {
  if (model.isFirmUser) return '/portfolio';
  const first = model.clients[0];
  return first ? `/c/${encodeURIComponent(first.id)}/overview` : '/library/acts';
}
