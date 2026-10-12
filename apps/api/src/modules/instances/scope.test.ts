import { LocalDate, type Membership, type RequestContext } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { membership, type MembershipInput } from '../../auth/testing.js';
import { clientsWithRole, mayChooseAsOf, rolesIn, unitScope } from './scope.js';

const FIRM = '0190f000-0000-7000-8000-0000000000f1';
const CLIENT = '0190f000-0000-7000-8000-0000000000c1';
const OTHER_CLIENT = '0190f000-0000-7000-8000-0000000000c2';
const U1 = '0190f000-0000-7000-8000-0000000000e1';
const U2 = '0190f000-0000-7000-8000-0000000000e2';
const ME = '0190f000-0000-7000-8000-000000000001';

function ctx(...held: MembershipInput[]): RequestContext {
  const memberships: Membership[] = held.map((m) =>
    membership({ firmId: FIRM, personId: ME, ...m }),
  );
  return {
    requestId: 'req-1',
    firmId: FIRM,
    personId: ME,
    memberships,
    clientIds: [CLIENT, OTHER_CLIENT],
    mfaSatisfied: true,
    asOf: LocalDate.parse('2023-04-20'),
  };
}

describe('unitScope', () => {
  it('is null (every unit) for whole-client roles', () => {
    expect(unitScope(ctx({ role: 'FIRM_ADMIN', clientId: null }), CLIENT)).toBeNull();
    expect(
      unitScope(ctx({ role: 'CONSULTANT', clientId: null, consultantClientIds: [CLIENT] }), CLIENT),
    ).toBeNull();
    expect(unitScope(ctx({ role: 'CLIENT_ADMIN', clientId: CLIENT }), CLIENT)).toBeNull();
    expect(unitScope(ctx({ role: 'VIEWER', clientId: CLIENT }), CLIENT)).toBeNull();
  });

  it('is the union of owner and approver units, and null when one covers every unit', () => {
    const scoped = ctx(
      { role: 'OWNER', clientId: CLIENT, unitIds: [U2] },
      { role: 'APPROVER', clientId: CLIENT, unitIds: [U1, U2] },
    );
    expect(unitScope(scoped, CLIENT)).toEqual([U1, U2].sort());
    expect(
      unitScope(ctx({ role: 'APPROVER', clientId: CLIENT, unitIds: null }), CLIENT),
    ).toBeNull();
  });

  it('is empty in a client the person has no role in, and ignores archived memberships', () => {
    expect(
      unitScope(ctx({ role: 'OWNER', clientId: OTHER_CLIENT, unitIds: [U1] }), CLIENT),
    ).toEqual([]);
    expect(
      unitScope(
        ctx({ role: 'CONSULTANT', clientId: null, consultantClientIds: [OTHER_CLIENT] }),
        CLIENT,
      ),
    ).toEqual([]);
    const archived = ctx({
      role: 'CLIENT_ADMIN',
      clientId: CLIENT,
      archivedAt: '2026-01-02T00:00:00Z',
    });
    expect(unitScope(archived, CLIENT)).toEqual([]);
    expect(rolesIn(archived, CLIENT).size).toBe(0);
  });
});

describe('mayChooseAsOf and clientsWithRole', () => {
  it('lets firm admins, consultants and viewers choose asOf, not client roles', () => {
    expect(mayChooseAsOf(ctx({ role: 'VIEWER', clientId: CLIENT }), CLIENT)).toBe(true);
    expect(mayChooseAsOf(ctx({ role: 'FIRM_ADMIN', clientId: null }), CLIENT)).toBe(true);
    expect(mayChooseAsOf(ctx({ role: 'CLIENT_ADMIN', clientId: CLIENT }), CLIENT)).toBe(false);
    expect(mayChooseAsOf(ctx({ role: 'OWNER', clientId: CLIENT }), CLIENT)).toBe(false);
  });

  it('lists the clients where any of the roles is held, in clientIds order', () => {
    const both = ctx(
      { role: 'APPROVER', clientId: OTHER_CLIENT },
      { role: 'OWNER', clientId: CLIENT },
    );
    expect(clientsWithRole(both, ['APPROVER', 'OWNER'])).toEqual([CLIENT, OTHER_CLIENT]);
    expect(clientsWithRole(both, ['CLIENT_ADMIN'])).toEqual([]);
  });
});
