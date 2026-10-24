import { randomUUID } from 'node:crypto';
import type { Membership, RequestContext, Resource, Role } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { POLICY, can, canGrantRole, ruleFor } from './policy.js';
import { membership, type MembershipInput } from './testing.js';

// The role matrix of docs/contracts/endpoints.md, transcribed cell by cell, independent of POLICY.
// ✓ allowed in scope · own only as the instance's owner (OW) or approver (AP) · inst only on instance
// resources · blank denied. Read-only "r" cells are ✓ on the read action and blank on the write action.
type Cell = '✓' | 'own' | 'inst' | '';
const ROLES = ['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN', 'APPROVER', 'OWNER', 'VIEWER'] as const;
//                               FA    CO    CA    AP      OW      VI
const MATRIX: Record<string, readonly [Cell, Cell, Cell, Cell, Cell, Cell]> = {
  'person.invite': ['✓', '✓', '✓', '', '', ''],
  'account.read': ['✓', '', '', '', '', ''],
  'supportGrant.read': ['✓', '', '', '', '', ''],
  'supportGrant.manage': ['✓', '', '', '', '', ''],
  'client.read': ['✓', '✓', '✓', '✓', '✓', '✓'],
  'client.create': ['✓', '', '', '', '', ''],
  'client.update': ['✓', '✓', '', '', '', ''],
  'client.archive': ['✓', '', '', '', '', ''],
  'client.settings': ['✓', '✓', '✓', '', '', ''],
  'entity.read': ['✓', '✓', '✓', '✓', '✓', '✓'],
  'entity.write': ['✓', '✓', '✓', '', '', ''],
  'location.read': ['✓', '✓', '✓', '✓', '✓', '✓'],
  'location.write': ['✓', '✓', '✓', '', '', ''],
  'department.read': ['✓', '✓', '✓', '✓', '✓', '✓'],
  'department.write': ['✓', '✓', '✓', '', '', ''],
  'department.merge': ['✓', '✓', '✓', '', '', ''],
  'person.read': ['✓', '✓', '✓', '✓', '✓', '✓'],
  'person.write': ['✓', '✓', '✓', '', '', ''],
  'person.merge': ['✓', '✓', '✓', '', '', ''],
  'membership.write': ['✓', '✓', '✓', '', '', ''],
  'library.read': ['✓', '✓', '✓', '✓', '✓', '✓'],
  'library.write': ['✓', '✓', '', '', '', ''],
  'library.push': ['✓', '✓', '', '', '', ''],
  'assignment.read': ['✓', '✓', '✓', '✓', '✓', '✓'],
  'assignment.write': ['✓', '✓', '✓', '', '', ''],
  'assignment.applicability': ['✓', '✓', '✓', '', '', ''],
  'instance.read': ['✓', '✓', '✓', '✓', '✓', '✓'],
  'instance.submit': ['', '', '', '', 'own', ''],
  'instance.approve': ['', '', '✓', 'own', '', ''],
  'instance.reopen': ['✓', '✓', '✓', '', '', ''],
  'instance.reassign': ['✓', '✓', '✓', '', '', ''],
  'instance.dueDate': ['✓', '✓', '✓', '', '', ''],
  'comment.read': ['✓', '✓', '✓', 'own', 'own', '✓'],
  'comment.write': ['✓', '✓', '✓', 'own', 'own', ''],
  'evidence.write': ['✓', '✓', '✓', 'own', 'own', ''],
  'evidence.read': ['✓', '✓', '✓', '✓', '✓', '✓'],
  'evidence.download': ['✓', '✓', '✓', '✓', '✓', '✓'],
  'evidence.remove': ['✓', '✓', '✓', '', 'own', ''],
  'audit.read': ['✓', '✓', '✓', 'inst', 'inst', '✓'],
  'import.*': ['✓', '✓', '', '', '', ''],
  'dashboard.portfolio': ['✓', '✓', '', '', '', ''],
  'dashboard.read': ['✓', '✓', '✓', '✓', '✓', '✓'],
  'report.read': ['✓', '✓', '✓', '✓', '', '✓'],
  'export.create': ['✓', '✓', '✓', '✓', '', '✓'],
  'export.read': ['✓', '✓', '✓', '✓', '', '✓'],
};

const CLIENT = randomUUID();
const OTHER_CLIENT = randomUUID();
const UNIT = randomUUID();
const OTHER_UNIT = randomUUID();
const ACTOR = randomUUID();
const SOMEONE_ELSE = randomUUID();

function scoped(role: Role, overrides: Partial<MembershipInput> = {}): Membership {
  const base: MembershipInput =
    role === 'FIRM_ADMIN'
      ? { role }
      : role === 'CONSULTANT'
        ? { role, consultantClientIds: [CLIENT] }
        : { role, clientId: CLIENT };
  return membership({ ...base, personId: ACTOR, ...overrides });
}

function ctxFor(memberships: Membership[], clientIds: string[] = [CLIENT]): RequestContext {
  return {
    requestId: 'req-1',
    firmId: randomUUID(),
    personId: ACTOR,
    memberships,
    clientIds,
    mfaSatisfied: true,
    asOf: '2026-10-12' as RequestContext['asOf'],
  };
}

function instance(overrides: Partial<Resource> = {}): Resource {
  return {
    type: 'instance',
    clientId: CLIENT,
    unitId: UNIT,
    ownerId: SOMEONE_ELSE,
    approverId: SOMEONE_ELSE,
    ...overrides,
  };
}

describe('POLICY', () => {
  it('has exactly the actions of the endpoints.md role matrix', () => {
    expect(Object.keys(POLICY).sort()).toEqual(Object.keys(MATRIX).sort());
  });
});

describe.each(Object.entries(MATRIX))('can(%s)', (action, cells) => {
  const concrete = action === 'import.*' ? 'import.commit' : action;

  it.each(ROLES.map((role, i) => [role, cells[i]] as const))('%s: %s', (role, cell) => {
    const ctx = ctxFor([scoped(role)]);
    const notOwn = instance();
    const own = instance({ ownerId: ACTOR, approverId: ACTOR });
    const clientLevel = instance({ type: 'client', unitId: undefined });

    switch (cell) {
      case '✓':
        expect(can(ctx, concrete, notOwn)).toBe(true);
        expect(can(ctx, concrete, clientLevel)).toBe(true);
        break;
      case 'own':
        expect(can(ctx, concrete, notOwn)).toBe(false);
        expect(can(ctx, concrete, own)).toBe(true);
        expect(can(ctx, concrete, instance({ ownerId: undefined, approverId: undefined }))).toBe(
          false,
        );
        break;
      case 'inst':
        expect(can(ctx, concrete, notOwn)).toBe(true);
        expect(can(ctx, concrete, clientLevel)).toBe(false);
        break;
      case '':
        expect(can(ctx, concrete, own)).toBe(false);
        expect(can(ctx, concrete, clientLevel)).toBe(false);
        break;
    }
  });
});

describe('can() scope', () => {
  it('denies actions missing from the table', () => {
    const ctx = ctxFor([scoped('FIRM_ADMIN')]);
    expect(can(ctx, 'instance.delete', instance())).toBe(false);
    expect(can(ctx, 'nothing.read', instance())).toBe(false);
    expect(ruleFor('import.parse')).toBe(POLICY['import.*']);
    expect(ruleFor('instance.delete')).toBeUndefined();
  });

  it('denies a client outside ctx.clientIds, even for a firm admin', () => {
    const ctx = ctxFor([scoped('FIRM_ADMIN')]);
    expect(can(ctx, 'instance.read', instance({ clientId: OTHER_CLIENT }))).toBe(false);
  });

  it('limits a consultant to consultantClientIds', () => {
    const ctx = ctxFor([scoped('CONSULTANT')], [CLIENT, OTHER_CLIENT]);
    expect(can(ctx, 'instance.read', instance())).toBe(true);
    expect(can(ctx, 'instance.read', instance({ clientId: OTHER_CLIENT }))).toBe(false);
  });

  it.each(['CLIENT_ADMIN', 'APPROVER', 'OWNER', 'VIEWER'] as const)(
    'limits %s to its own client',
    (role) => {
      const ctx = ctxFor([scoped(role)], [CLIENT, OTHER_CLIENT]);
      expect(can(ctx, 'instance.read', instance())).toBe(true);
      expect(can(ctx, 'instance.read', instance({ clientId: OTHER_CLIENT }))).toBe(false);
    },
  );

  it.each(['APPROVER', 'OWNER'] as const)('limits %s to its units', (role) => {
    const ctx = ctxFor([scoped(role, { unitIds: [UNIT] })]);
    expect(can(ctx, 'instance.read', instance())).toBe(true);
    expect(can(ctx, 'instance.read', instance({ unitId: OTHER_UNIT }))).toBe(false);
    // Client-level reads (lists) are filtered by the query, not denied.
    expect(can(ctx, 'instance.read', instance({ unitId: undefined }))).toBe(true);
    // Own instances in another unit are still out of scope.
    const own = { ownerId: ACTOR, approverId: ACTOR, unitId: OTHER_UNIT };
    expect(can(ctx, 'comment.write', instance(own))).toBe(false);
  });

  it('does not limit a client admin to units', () => {
    const ctx = ctxFor([scoped('CLIENT_ADMIN', {})]);
    expect(can(ctx, 'instance.approve', instance({ unitId: OTHER_UNIT }))).toBe(true);
  });

  it('lets only firm staff reach firm-level resources, except firm-wide reads', () => {
    const firmLevel: Resource = { type: 'person', clientId: null };
    expect(can(ctxFor([scoped('FIRM_ADMIN')]), 'person.read', firmLevel)).toBe(true);
    expect(can(ctxFor([scoped('CONSULTANT')]), 'person.read', firmLevel)).toBe(true);
    expect(can(ctxFor([scoped('CLIENT_ADMIN')]), 'person.read', firmLevel)).toBe(false);
    expect(can(ctxFor([scoped('CONSULTANT')]), 'dashboard.portfolio', firmLevel)).toBe(true);

    const library: Resource = { type: 'obligation', clientId: null };
    for (const role of ROLES) {
      expect(can(ctxFor([scoped(role)]), 'library.read', library)).toBe(true);
    }
    expect(can(ctxFor([scoped('CLIENT_ADMIN')]), 'library.write', library)).toBe(false);
    expect(can(ctxFor([scoped('CONSULTANT')]), 'library.write', library)).toBe(true);
    const location: Resource = { type: 'location', clientId: null };
    expect(can(ctxFor([scoped('CLIENT_ADMIN')]), 'location.write', location)).toBe(true);
    expect(can(ctxFor([scoped('OWNER')]), 'location.write', location)).toBe(false);
  });

  it('denies client roles client-level actions with clientId null; lists filter by ctx.clientIds', () => {
    const anyClient: Resource = { type: 'instance', clientId: null };
    for (const role of ['CLIENT_ADMIN', 'APPROVER', 'OWNER', 'VIEWER'] as const) {
      expect(can(ctxFor([scoped(role)]), 'client.read', { type: 'client', clientId: null })).toBe(
        false,
      );
      expect(can(ctxFor([scoped(role)]), 'instance.read', anyClient)).toBe(false);
    }
    expect(
      can(ctxFor([scoped('FIRM_ADMIN')]), 'client.read', { type: 'client', clientId: null }),
    ).toBe(true);
  });

  it('ignores archived memberships', () => {
    const ctx = ctxFor([scoped('CLIENT_ADMIN', { archivedAt: '2026-01-02T00:00:00Z' })]);
    expect(can(ctx, 'instance.read', instance())).toBe(false);
  });

  it('allows when any membership allows', () => {
    const ctx = ctxFor([scoped('VIEWER'), scoped('OWNER', { unitIds: [UNIT] })]);
    expect(can(ctx, 'instance.submit', instance({ ownerId: ACTOR }))).toBe(true);
    expect(can(ctx, 'instance.submit', instance())).toBe(false);
  });

  it('does not let an approver act as owner or the reverse', () => {
    expect(
      can(ctxFor([scoped('APPROVER')]), 'instance.approve', instance({ ownerId: ACTOR })),
    ).toBe(false);
    expect(can(ctxFor([scoped('OWNER')]), 'comment.write', instance({ approverId: ACTOR }))).toBe(
      false,
    );
  });
});

describe('canGrantRole', () => {
  const fa = ctxFor([scoped('FIRM_ADMIN')]);
  const co = ctxFor([scoped('CONSULTANT')], [CLIENT, OTHER_CLIENT]);
  const ca = ctxFor([scoped('CLIENT_ADMIN')], [CLIENT, OTHER_CLIENT]);

  it('lets only a firm admin grant firm roles', () => {
    expect(canGrantRole(fa, 'FIRM_ADMIN', null)).toBe(true);
    expect(canGrantRole(fa, 'CONSULTANT', null)).toBe(true);
    expect(canGrantRole(co, 'CONSULTANT', null)).toBe(false);
    expect(canGrantRole(ca, 'FIRM_ADMIN', null)).toBe(false);
  });

  it('lets consultants and client admins grant client roles in clients they manage', () => {
    for (const role of ['CLIENT_ADMIN', 'APPROVER', 'OWNER', 'VIEWER'] as const) {
      expect(canGrantRole(fa, role, CLIENT)).toBe(true);
      expect(canGrantRole(co, role, CLIENT)).toBe(true);
      expect(canGrantRole(ca, role, CLIENT)).toBe(true);
      expect(canGrantRole(co, role, OTHER_CLIENT)).toBe(false);
      expect(canGrantRole(ca, role, OTHER_CLIENT)).toBe(false);
    }
  });

  it('rejects mismatched role and client, clients outside the context, and other roles', () => {
    expect(canGrantRole(fa, 'FIRM_ADMIN', CLIENT)).toBe(false);
    expect(canGrantRole(fa, 'OWNER', null)).toBe(false);
    expect(canGrantRole(fa, 'OWNER', OTHER_CLIENT)).toBe(false);
    for (const role of ['APPROVER', 'OWNER', 'VIEWER'] as const) {
      expect(canGrantRole(ctxFor([scoped(role)]), 'OWNER', CLIENT)).toBe(false);
    }
    const archived = ctxFor([scoped('FIRM_ADMIN', { archivedAt: '2026-01-02T00:00:00Z' })]);
    expect(canGrantRole(archived, 'OWNER', CLIENT)).toBe(false);
  });
});
