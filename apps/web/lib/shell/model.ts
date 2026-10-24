// What the shell shows for the signed-in user: their roles, the clients in the switcher and the sidebar sections.
// Plain data, built on the server and passed to the client frame (icons are attached there, since components can't
// cross the server/client boundary).
import {
  DEFAULT_ACCOUNT,
  FIRM_ROLES,
  type ClientPeriods,
  type Me,
  type Role,
} from '@canopy/contracts';

import { hrefFor, routeByPath, visibleTo } from '../routes';

export type ShellClient = {
  id: string;
  name: string;
  /** "3 units" */
  meta: string;
  overdueCount: number;
  fyStartMonth: number;
  timeZone: string;
  /** The engine's current quarter (the contract types it as an int 1-4). */
  thisPeriod: { fy: string; quarter: 1 | 2 | 3 | 4 };
} & Omit<ClientPeriods, 'current'>;

export type ShellUser = { name: string; detail: string; email: string | null };

export type ShellModel = {
  user: ShellUser;
  clients: ShellClient[];
  isFirmUser: boolean;
  /** Roles per client id (firm roles included), and firm roles alone for firm-level pages. */
  roles: { firm: Role[]; byClient: Record<string, Role[]> };
  /** Instances waiting on the user's approval (GET /me/approvals), shown on the Approvals item. */
  approvalsWaiting: number;
  /** A line above every page about the account itself: a support visit, a closing account or a trial. */
  notice?: ShellNotice;
  /** False for a company account with one client: there is nothing to switch to (ADR M15-0001). */
  showClientSwitcher?: boolean;
};

/** The account's state, for the line above every page; ShellFrame words it. */
export type ShellNotice =
  { kind: 'support' } | { kind: 'closing' } | { kind: 'trial'; endsOn: string };

/**
 * What the account's state means for everyone signed in to it. A PlanetPulse support visit comes first, so support
 * never forgets whose account it is in; then a closing account; then a trial with its end date. A paused account
 * signs nobody in, so it never reaches the shell.
 */
export function accountNotice(me: Pick<Me, 'person' | 'account'>): ShellNotice | undefined {
  const account = me.account ?? DEFAULT_ACCOUNT;
  if (me.person.support) return { kind: 'support' };
  if (account.status === 'PENDING_DELETION') return { kind: 'closing' };
  if (account.status === 'TRIAL' && account.trialEndsOn) {
    return { kind: 'trial', endsOn: account.trialEndsOn };
  }
  return undefined;
}

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

export function isFirmUser(me: Pick<Me, 'memberships'>): boolean {
  return me.memberships.some((m) => firmRoles.includes(m.role));
}

/** The actor's roles, limited to one client when given: firm roles apply everywhere, client roles to their client. */
export function rolesFor(me: Pick<Me, 'memberships'>, clientId?: string): Role[] {
  const roles = me.memberships
    .filter((m) => m.clientId === null || clientId === undefined || m.clientId === clientId)
    .map((m) => m.role);
  return [...new Set(roles)];
}

function unitsLabel(n: number): string {
  return `${n} ${n === 1 ? 'unit' : 'units'}`;
}

/** People who see the Approvals page, and so its badge (the same roles GET /me/approvals allows). */
export const APPROVAL_ROLES: readonly Role[] = routeByPath('approvals').roles ?? [];

/**
 * `overdue` comes from GET /portfolio (firm users); client users see no count. `approvalsWaiting` comes from
 * GET /me/approvals.
 */
export function buildShellModel(
  me: Me,
  overdue: Record<string, number> = {},
  approvalsWaiting = 0,
): ShellModel {
  const roles = rolesFor(me);
  const clients = me.clients
    .map(({ id, name, unitCount, fyStartMonth, timeZone, period }): ShellClient => ({
      id,
      name,
      meta: unitsLabel(unitCount),
      overdueCount: overdue[id] ?? 0,
      fyStartMonth,
      timeZone,
      thisPeriod: { fy: period.current.fy, quarter: period.current.quarter as 1 | 2 | 3 | 4 },
      availableFys: period.availableFys,
      availableUntil: period.availableUntil,
    }))
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
    approvalsWaiting,
    notice: accountNotice(me),
    showClientSwitcher: !(
      (me.account ?? DEFAULT_ACCOUNT).kind === 'ENTERPRISE' && clients.length <= 1
    ),
  };
}

const CLIENT_SECTIONS: { label?: string; paths: string[] }[] = [
  { paths: ['overview', 'register', 'calendar', 'approvals', 'evidence'] },
  { label: 'Reporting', paths: ['reports', 'audit'] },
  { label: 'Setup', paths: ['setup/entities', 'setup/people', 'import'] },
];

const FIRM_SECTION = { label: 'Firm', paths: ['portfolio', 'library/acts', 'account'] };

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
