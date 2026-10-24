import type { Membership, Person } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { membershipLines, parseEmail, personRows, ROLE_LABEL } from './people-model';

const base = {
  firmId: 'f',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  archivedAt: null,
  version: 1,
};
const CLIENT = 'c1';
const membership = (over: Partial<Membership>): Membership => ({
  ...base,
  id: 'm',
  personId: 'p',
  role: 'OWNER',
  clientId: CLIENT,
  consultantClientIds: null,
  unitIds: null,
  expiresAt: null,
  ...over,
});

describe('people model', () => {
  it('shows status in words and says when an email is needed', () => {
    const people: Person[] = [
      {
        ...base,
        id: 'a',
        displayName: 'Asha Kulkarni',
        nameNormalized: 'asha kulkarni',
        email: 'asha@kestrel.example',
        status: 'ACTIVE',
      },
      {
        ...base,
        id: 'b',
        displayName: 'Ravi N',
        nameNormalized: 'ravi n',
        email: null,
        status: 'UNCLAIMED',
      },
    ];
    expect(personRows(people)).toEqual([
      {
        id: 'a',
        name: 'Asha Kulkarni',
        email: 'asha@kestrel.example',
        status: 'Active',
        version: 1,
        emailRequired: true,
      },
      {
        id: 'b',
        name: 'Ravi N',
        email: null,
        status: 'Not invited',
        version: 1,
        emailRequired: false,
      },
    ]);
  });

  it('lists the roles in this client with their scope', () => {
    expect(
      membershipLines(
        [
          membership({}),
          membership({ role: 'APPROVER', unitIds: ['u1'] }),
          membership({ role: 'APPROVER', unitIds: ['u1', 'u2'] }),
          membership({ role: 'CONSULTANT', clientId: null, consultantClientIds: [CLIENT] }),
          membership({ clientId: 'other' }),
        ],
        CLIENT,
      ),
    ).toEqual([
      'Owner · all units',
      'Approver · 1 unit',
      'Approver · 2 units',
      'Consultant · firm-wide',
    ]);
    expect(Object.keys(ROLE_LABEL)).toHaveLength(6);
  });

  it('reads an email, none, or not an email', () => {
    expect(parseEmail('  Asha@Kestrel.Example ')).toBe('asha@kestrel.example');
    expect(parseEmail('  ')).toBeNull();
    expect(parseEmail('asha@')).toBeUndefined();
    expect(parseEmail('a b@c.d')).toBeUndefined();
  });
});
