// Shapes the people screen shows. Statuses and roles in words; the API decides who may do what.
import type { Membership, Person, PersonStatus, Role } from '@canopy/contracts';

export const STATUS_LABEL: Record<PersonStatus, string> = {
  UNCLAIMED: 'Not invited',
  INVITED: 'Invited',
  ACTIVE: 'Active',
  DISABLED: 'Disabled',
};

export const ROLE_LABEL: Record<Role, string> = {
  FIRM_ADMIN: 'Account admin',
  CONSULTANT: 'Consultant',
  CLIENT_ADMIN: 'Client admin',
  APPROVER: 'Approver',
  OWNER: 'Owner',
  VIEWER: 'Viewer',
};

/** The roles a person can be added with here; a viewer is invited, with an end date. */
export const ADD_ROLE_OPTIONS = [
  { value: 'OWNER', label: 'Owner' },
  { value: 'APPROVER', label: 'Approver' },
  { value: 'CLIENT_ADMIN', label: 'Client admin' },
] as const;

export type PersonRow = {
  id: string;
  name: string;
  email: string | null;
  status: string;
  version: number;
  /** An active person signs in with their email, so it can be changed but not removed. */
  emailRequired: boolean;
};

export const personRows = (people: readonly Person[]): PersonRow[] =>
  people.map((p) => ({
    id: p.id,
    name: p.displayName,
    email: p.email,
    status: STATUS_LABEL[p.status],
    version: p.version,
    emailRequired: p.status === 'ACTIVE',
  }));

/** "Owner · all units", "Approver · 2 units", for this client only. */
export function membershipLines(memberships: readonly Membership[], clientId: string): string[] {
  return memberships
    .filter((m) => m.clientId === clientId || m.clientId === null)
    .map((m) => {
      const scope =
        m.clientId === null
          ? 'firm-wide'
          : m.unitIds === null
            ? 'all units'
            : m.unitIds.length === 1
              ? '1 unit'
              : `${m.unitIds.length} units`;
      return `${ROLE_LABEL[m.role]} · ${scope}`;
    });
}

/** A typed email, or null for none; undefined when it is not an email at all. */
export function parseEmail(text: string): string | null | undefined {
  const email = text.trim();
  if (email === '') return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.toLowerCase() : undefined;
}
