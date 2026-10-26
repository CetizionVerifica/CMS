import type {
  Certification,
  ControlledDocument,
  ManagementSystem,
  RequestContext,
} from '@canopy/contracts';
import { LocalDate } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../auth/index.js';
import { membership, type MembershipInput } from '../../auth/testing.js';
import {
  authorize,
  canSee,
  certificateReach,
  checklistRowReach,
  documentReach,
  holdsRole,
  isManager,
  isoResource,
  listScope,
  may,
  selfResource,
  systemReach,
  unitResource,
  unitScopeOf,
  unitsFor,
  type Reach,
} from './access.js';

const FIRM = '0190f000-0000-7000-8000-0000000000f1';
const CLIENT = '0190f000-0000-7000-8000-0000000000c1';
const OTHER = '0190f000-0000-7000-8000-0000000000c2';
const U1 = '0190f000-0000-7000-8000-0000000000e1';
const U2 = '0190f000-0000-7000-8000-0000000000e2';
const ME = '0190f000-0000-7000-8000-000000000001';
const SOMEONE = '0190f000-0000-7000-8000-000000000002';

function ctx(...held: MembershipInput[]): RequestContext {
  return {
    requestId: 'req-1',
    firmId: FIRM,
    personId: ME,
    memberships: held.map((m) =>
      membership({ firmId: FIRM, personId: ME, clientId: CLIENT, ...m }),
    ),
    clientIds: [CLIENT, OTHER],
    mfaSatisfied: true,
    asOf: LocalDate.parse('2026-10-20'),
  };
}

const firmWide = (role: 'FIRM_ADMIN' | 'CONSULTANT'): MembershipInput =>
  role === 'FIRM_ADMIN'
    ? { role, clientId: null }
    : { role, clientId: null, consultantClientIds: [CLIENT] };

const system = (unitIds: string[]) =>
  ({ id: 'sys', clientId: CLIENT, unitIds, standardIds: ['std'] }) as unknown as ManagementSystem;
const reach = (unitIds: string[], people: (string | null)[] = []): Reach => ({
  clientId: CLIENT,
  unitIds,
  people,
});

describe('reach builders', () => {
  it('take the record’s units, else the system’s, and the people it names', () => {
    expect(systemReach(system([U1]))).toEqual(reach([U1]));
    expect(checklistRowReach(system([U1]), { ownerId: ME })).toEqual(reach([U1], [ME]));
    expect(
      documentReach(system([]), { ownerId: ME, approverId: SOMEONE } as ControlledDocument),
    ).toEqual(reach([], [ME, SOMEONE]));
    const cert = (unitIds: string[]) => ({ clientId: CLIENT, unitIds }) as Certification;
    expect(certificateReach(system([U1, U2]), cert([U2]))).toEqual(reach([U2]));
    expect(certificateReach(system([U1, U2]), cert([]))).toEqual(reach([U1, U2]));
  });
});

describe('unit scope (plan §3.3)', () => {
  it('limits APPROVER and OWNER to their units; any whole-client role lifts it', () => {
    expect(unitScopeOf(ctx({ role: 'OWNER', unitIds: [U2, U1] }), CLIENT)).toEqual([U1, U2]);
    expect(unitScopeOf(ctx({ role: 'APPROVER', unitIds: null }), CLIENT)).toBeNull();
    expect(
      unitScopeOf(ctx({ role: 'OWNER', unitIds: [U1] }, { role: 'VIEWER' }), CLIENT),
    ).toBeNull();
    expect(unitScopeOf(ctx(firmWide('FIRM_ADMIN')), CLIENT)).toBeNull();
    expect(unitScopeOf(ctx(firmWide('CONSULTANT')), CLIENT)).toBeNull();
    // A consultant not assigned the client, and an archived membership, hold nothing there.
    expect(unitScopeOf(ctx(firmWide('CONSULTANT')), OTHER)).toEqual([]);
    expect(
      unitScopeOf(ctx({ role: 'CLIENT_ADMIN', archivedAt: '2026-01-01T00:00:00Z' }), CLIENT),
    ).toEqual([]);
    expect(listScope(ctx({ role: 'OWNER', unitIds: [U1] }), CLIENT)).toEqual({
      unitIds: [U1],
      personId: ME,
    });
    expect(listScope(ctx({ role: 'CLIENT_ADMIN' }), CLIENT)).toBeUndefined();
  });

  it('sees a record of its units, one over every unit, or one that names it', () => {
    const owner = ctx({ role: 'OWNER', unitIds: [U1] });
    expect(canSee(owner, reach([U1, U2]))).toBe(true);
    expect(canSee(owner, reach([]))).toBe(true);
    expect(canSee(owner, reach([U2]))).toBe(false);
    expect(canSee(owner, reach([U2], [ME]))).toBe(true);
    expect(
      canSee(owner, { ...reach([U1]), clientId: '0190f000-0000-7000-8000-0000000000c9' }),
    ).toBe(false);
    expect(canSee(ctx({ role: 'VIEWER' }), reach([U2]))).toBe(true);
  });
});

describe('the Resource builder (plan §3.2)', () => {
  it('sets unitIds from the record unless it covers every unit or names the actor', () => {
    const owner = ctx({ role: 'OWNER', unitIds: [U1] });
    expect(isoResource(owner, 'controlled_document', reach([U1]), { ownerId: SOMEONE })).toEqual({
      type: 'controlled_document',
      clientId: CLIENT,
      unitIds: [U1],
      ownerId: SOMEONE,
    });
    expect(isoResource(owner, 'controlled_document', reach([]))).toEqual({
      type: 'controlled_document',
      clientId: CLIENT,
    });
    expect(
      isoResource(owner, 'controlled_document', reach([U2], [ME]), {
        ownerId: ME,
        approverId: null,
      }),
    ).toEqual({ type: 'controlled_document', clientId: CLIENT, ownerId: ME });
    expect(unitResource('clause_assessment', reach([U2], [ME]))).toEqual({
      type: 'clause_assessment',
      clientId: CLIENT,
      unitIds: [U2],
    });
    expect(unitResource('clause_assessment', reach([]))).toEqual({
      type: 'clause_assessment',
      clientId: CLIENT,
    });
  });

  it('grants a non-lead auditor and a chair their own steps, in each role', () => {
    const team = reach([U1], [SOMEONE, ME]);
    const outsider = reach([U1], [SOMEONE]);
    const asAuditor = (who: RequestContext, r: Reach) =>
      may(who, 'isoAudit.conduct', selfResource(who, 'internal_audit', r, r.people as string[]));
    const asChair = (who: RequestContext, r: Reach) =>
      may(who, 'isoReview.write', selfResource(who, 'management_review', r, r.people as string[]));
    const roles: [string, RequestContext, boolean][] = [
      ['FIRM_ADMIN', ctx(firmWide('FIRM_ADMIN')), true],
      ['CONSULTANT', ctx(firmWide('CONSULTANT')), true],
      ['CLIENT_ADMIN', ctx({ role: 'CLIENT_ADMIN' }), true],
      ['APPROVER', ctx({ role: 'APPROVER', unitIds: [U1] }), false],
      ['OWNER', ctx({ role: 'OWNER', unitIds: [U1] }), false],
      ['VIEWER', ctx({ role: 'VIEWER' }), false],
    ];
    for (const [role, who, whole] of roles) {
      const named = role !== 'VIEWER';
      expect([role, asAuditor(who, team), asChair(who, team)]).toEqual([role, named, named]);
      expect([role, asAuditor(who, outsider), asChair(who, outsider)]).toEqual([
        role,
        whole,
        whole,
      ]);
    }
    expect(selfResource(ctx({ role: 'OWNER' }), 'internal_audit', outsider, [SOMEONE])).toEqual({
      type: 'internal_audit',
      clientId: CLIENT,
      unitIds: [U1],
    });
  });

  it('answers 403 FORBIDDEN naming the action', () => {
    const viewer = ctx({ role: 'VIEWER' });
    try {
      authorize(viewer, 'isoSystem.write', { type: 'management_system', clientId: CLIENT });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).details).toEqual({ action: 'isoSystem.write' });
    }
    expect(() =>
      authorize(viewer, 'isoSystem.read', { type: 'management_system', clientId: CLIENT }),
    ).not.toThrow();
  });
});

describe('roles held over a record', () => {
  it('finds a role over the record’s units, any units for a record over all of them', () => {
    const approver = ctx({ role: 'APPROVER', unitIds: [U1] });
    expect(holdsRole(approver, CLIENT, ['APPROVER'], [U1, U2])).toBe(true);
    expect(holdsRole(approver, CLIENT, ['APPROVER'], [U2])).toBe(false);
    expect(holdsRole(approver, CLIENT, ['APPROVER'], [])).toBe(true);
    expect(holdsRole(approver, CLIENT, ['APPROVER'])).toBe(true);
    expect(holdsRole(approver, CLIENT, ['CLIENT_ADMIN'])).toBe(false);
    expect(holdsRole(ctx({ role: 'APPROVER', unitIds: null }), CLIENT, ['APPROVER'], [U2])).toBe(
      true,
    );
    expect(unitsFor(approver, reach([U2], [ME]))).toBeUndefined();
    expect(unitsFor(approver, reach([U2]))).toEqual([U2]);
    expect(isManager(ctx({ role: 'CLIENT_ADMIN' }), reach([U2]))).toBe(true);
    expect(isManager(approver, reach([U1]))).toBe(false);
  });
});
