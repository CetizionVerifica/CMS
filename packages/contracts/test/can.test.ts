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
