import { describe, expect, it } from 'vitest';
import { can, type Membership, type RequestContext, type Resource } from '../src/index.js';
import { ID, membership } from './samples.js';

const OTHER_CLIENT = '0192f0c8-1a2b-7c3d-8e4f-0000000000f1';
const OTHER_UNIT = '0192f0c8-1a2b-7c3d-8e4f-0000000000f2';

function ctx(
  memberships: Partial<Membership>[],
  overrides: Partial<RequestContext> = {},
): RequestContext {
  return {
    requestId: 'req-1',
    firmId: ID.firm,
    personId: ID.owner,
    memberships: memberships.map((m) => ({ ...membership, ...m }) as Membership),
    clientIds: [ID.client],
    mfaSatisfied: true,
    asOf: '2026-10-11',
    ...overrides,
  } as RequestContext;
}

const instance: Resource = {
  type: 'instance',
  clientId: ID.client,
  unitId: ID.unit,
  ownerId: ID.owner,
  approverId: ID.approver,
};

const owner = { role: 'OWNER' as const, clientId: ID.client, unitIds: null };

describe('stub can()', () => {
  it('lets an owner submit only their own instance', () => {
    expect(can(ctx([owner]), 'instance.submit', instance)).toBe(true);
    expect(can(ctx([owner]), 'instance.submit', { ...instance, ownerId: ID.approver })).toBe(false);
    expect(can(ctx([owner]), 'instance.approve', instance)).toBe(false);
  });

  it('keeps client roles inside their client and units', () => {
    expect(can(ctx([owner]), 'instance.read', { ...instance, clientId: OTHER_CLIENT })).toBe(false);
    const scoped = { ...owner, unitIds: [ID.unit] };
    expect(can(ctx([scoped]), 'instance.read', instance)).toBe(true);
    expect(can(ctx([scoped]), 'instance.read', { ...instance, unitId: OTHER_UNIT })).toBe(false);
  });

  it('scopes consultants to their clients and needs MFA for firm roles', () => {
    const consultant = {
      role: 'CONSULTANT' as const,
      clientId: null,
      consultantClientIds: [ID.client],
      unitIds: null,
    };
    expect(can(ctx([consultant]), 'instance.dueDate', instance)).toBe(true);
    expect(
      can(ctx([consultant]), 'instance.dueDate', { ...instance, clientId: OTHER_CLIENT }),
    ).toBe(false);
    expect(can(ctx([consultant], { mfaSatisfied: false }), 'instance.dueDate', instance)).toBe(
      false,
    );
    const admin = { role: 'FIRM_ADMIN' as const, clientId: null, unitIds: null };
    expect(can(ctx([admin]), 'library.write', { type: 'obligation', clientId: null })).toBe(true);
  });

  it('denies unknown actions', () => {
    const admin = { role: 'FIRM_ADMIN' as const, clientId: null, unitIds: null };
    expect(can(ctx([admin]), 'instance.due_date', instance)).toBe(false);
    expect(can(ctx([admin]), 'instance.teleport', instance)).toBe(false);
  });
});

// The ISO actions after ISO-1a: one action per route, so the stub's union over every endpoint that names an action
// grants no role a right that only another action's route gives it (docs/iso/plan.md §3.2).
describe('stub can() on the ISO actions', () => {
  const admin = { role: 'FIRM_ADMIN' as const, clientId: null, unitIds: null };
  const consultant = {
    role: 'CONSULTANT' as const,
    clientId: null,
    consultantClientIds: [ID.client],
    unitIds: null,
  };
  const clientAdmin = { role: 'CLIENT_ADMIN' as const, clientId: ID.client, unitIds: null };
  const approver = { role: 'APPROVER' as const, clientId: ID.client, unitIds: null };
  const asApprover = { personId: ID.approver };
  // ISO entity types join `EntityType` in ISO-1b; the stub reads only the client, units and people.
  const nc: Resource = {
    type: 'instance',
    clientId: ID.client,
    unitId: ID.unit,
    ownerId: ID.owner,
    approverId: ID.approver,
  };
  // A review names its chair as both owner and approver, as the mock's selfScope does.
  const chairedBy = (personId: string): Resource => ({
    type: 'instance',
    clientId: ID.client,
    unitIds: [ID.unit],
    ownerId: personId,
    approverId: personId,
  });

  it("gives an NC's investigation (isoNc.work) to CA and its owner only", () => {
    expect(can(ctx([admin]), 'isoNc.work', nc)).toBe(false);
    expect(can(ctx([consultant]), 'isoNc.work', nc)).toBe(false);
    expect(can(ctx([clientAdmin]), 'isoNc.work', nc)).toBe(true);
    expect(can(ctx([owner]), 'isoNc.work', nc)).toBe(true);
    expect(can(ctx([owner]), 'isoNc.work', { ...nc, ownerId: ID.approver })).toBe(false);
  });

  it("gives an NC's reassignment (isoNc.reassign) to FA, CO and CA, never its owner", () => {
    expect(can(ctx([admin]), 'isoNc.reassign', nc)).toBe(true);
    expect(can(ctx([consultant]), 'isoNc.reassign', nc)).toBe(true);
    expect(can(ctx([clientAdmin]), 'isoNc.reassign', nc)).toBe(true);
    expect(can(ctx([owner]), 'isoNc.reassign', nc)).toBe(false);
    expect(can(ctx([owner]), 'isoNc.reassign', { ...nc, approverId: ID.owner })).toBe(false);
  });

  it("gives a review's plan (isoReview.plan) to FA, CO and CA, never its chair", () => {
    const review = chairedBy(ID.owner);
    expect(can(ctx([admin]), 'isoReview.plan', review)).toBe(true);
    expect(can(ctx([consultant]), 'isoReview.plan', review)).toBe(true);
    expect(can(ctx([clientAdmin]), 'isoReview.plan', review)).toBe(true);
    expect(can(ctx([owner]), 'isoReview.plan', review)).toBe(false);
    expect(can(ctx([approver], asApprover), 'isoReview.plan', chairedBy(ID.approver))).toBe(false);
  });

  it("gives a review's attendees and minutes (isoReview.write) to its chair as AP or OW", () => {
    expect(can(ctx([owner]), 'isoReview.write', chairedBy(ID.owner))).toBe(true);
    expect(can(ctx([approver], asApprover), 'isoReview.write', chairedBy(ID.approver))).toBe(true);
    expect(can(ctx([owner]), 'isoReview.write', chairedBy(ID.approver))).toBe(false);
    expect(can(ctx([approver], asApprover), 'isoReview.write', chairedBy(ID.owner))).toBe(false);
    expect(can(ctx([clientAdmin]), 'isoReview.write', chairedBy(ID.owner))).toBe(true);
  });

  it('lets a unit-limited membership act on a record over several units only when one is theirs', () => {
    const scoped = { ...approver, unitIds: [ID.unit] };
    const system: Resource = {
      type: 'instance',
      clientId: ID.client,
      unitIds: [OTHER_UNIT, ID.unit],
    };
    expect(can(ctx([scoped], asApprover), 'isoSystem.read', system)).toBe(true);
    expect(
      can(ctx([scoped], asApprover), 'isoSystem.read', { ...system, unitIds: [OTHER_UNIT] }),
    ).toBe(false);
    // A client-wide membership needs none of them.
    expect(
      can(ctx([approver], asApprover), 'isoSystem.read', { ...system, unitIds: [OTHER_UNIT] }),
    ).toBe(true);
    // The stub has no named-person exception (plan §3.3): a resource that lists other units is refused even to its
    // chair. The provider applies the exception by leaving unitIds out for a record that names the actor, as the
    // mock's isoScope does, and then the chair may write it.
    const named: Resource = {
      type: 'instance',
      clientId: ID.client,
      ownerId: ID.approver,
      approverId: ID.approver,
    };
    expect(
      can(ctx([scoped], asApprover), 'isoReview.write', {
        ...chairedBy(ID.approver),
        unitIds: [OTHER_UNIT],
      }),
    ).toBe(false);
    expect(can(ctx([scoped], asApprover), 'isoReview.write', named)).toBe(true);
  });
});
