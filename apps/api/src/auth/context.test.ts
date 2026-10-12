import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  activeMemberships,
  buildRequestContext,
  visibleClientIds,
  type Principal,
  type SessionRecord,
} from './context.js';
import { ApiError } from './errors.js';
import { membership, person } from './testing.js';

const NOW = new Date('2026-10-11T20:00:00Z'); // 2026-10-12 01:30 in Asia/Kolkata
const FIRM = randomUUID();
const PERSON = randomUUID();
const C1 = randomUUID();
const C2 = randomUUID();
const C3 = randomUUID();

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: randomUUID(),
    firmId: FIRM,
    personId: PERSON,
    csrfToken: 'csrf',
    mfaSatisfied: true,
    expiresAt: '2026-10-12T00:00:00Z',
    ...overrides,
  };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    person: person({ id: PERSON, firmId: FIRM, email: 'asha@example.com' }),
    memberships: [membership({ role: 'CLIENT_ADMIN', clientId: C1 })],
    mfaEnrolled: false,
    mfaRequiredForFirmRoles: true,
    firmClientIds: [C1, C2, C3],
    ...overrides,
  };
}

function build(s: SessionRecord | null, p: Principal | null, extra = {}) {
  return buildRequestContext({ requestId: 'r', session: s, principal: p, now: NOW, ...extra });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ApiError ? error.code : 'not an ApiError';
  }
  return undefined;
}

describe('activeMemberships', () => {
  it('drops archived and expired memberships, keeps unexpired viewers', () => {
    const live = membership({ role: 'OWNER' });
    const archived = membership({ role: 'OWNER', archivedAt: '2026-01-01T00:00:00Z' });
    const expired = membership({ role: 'VIEWER', expiresAt: '2026-10-11T20:00:00Z' });
    const viewer = membership({ role: 'VIEWER', expiresAt: '2026-10-11T20:00:01Z' });
    expect(activeMemberships([live, archived, expired, viewer], NOW)).toEqual([live, viewer]);
  });
});

describe('visibleClientIds', () => {
  it('gives a firm admin every client, a consultant their list, client roles their client', () => {
    expect(visibleClientIds([membership({ role: 'FIRM_ADMIN' })], [C2, C1])).toEqual(
      [C1, C2].sort(),
    );
    expect(
      visibleClientIds([membership({ role: 'CONSULTANT', consultantClientIds: [C3] })], [C1]),
    ).toEqual([C3]);
    expect(
      visibleClientIds(
        [membership({ role: 'OWNER', clientId: C2 }), membership({ role: 'VIEWER', clientId: C2 })],
        [C1],
      ),
    ).toEqual([C2]);
  });
});

describe('buildRequestContext', () => {
  it('builds the M0 RequestContext with asOf in the time zone', () => {
    const ctx = build(session(), principal());
    expect(ctx).toMatchObject({
      requestId: 'r',
      firmId: FIRM,
      personId: PERSON,
      clientIds: [C1],
      mfaSatisfied: true,
      asOf: '2026-10-12',
    });
    expect(build(session(), principal(), { timeZone: 'UTC' }).asOf).toBe('2026-10-11');
  });

  it('rejects missing, expired and orphaned sessions and inactive people', () => {
    expect(codeOf(() => build(null, principal()))).toBe('UNAUTHENTICATED');
    expect(codeOf(() => build(session({ expiresAt: NOW.toISOString() }), principal()))).toBe(
      'UNAUTHENTICATED',
    );
    expect(codeOf(() => build(session(), null))).toBe('UNAUTHENTICATED');
    for (const status of ['UNCLAIMED', 'INVITED', 'DISABLED'] as const) {
      expect(codeOf(() => build(session(), principal({ person: person({ status }) })))).toBe(
        'UNAUTHENTICATED',
      );
    }
  });

  it('reports expired access when only expired memberships remain', () => {
    const expired = membership({ role: 'VIEWER', expiresAt: '2026-10-01T00:00:00Z' });
    expect(codeOf(() => build(session(), principal({ memberships: [expired] })))).toBe(
      'ACCESS_EXPIRED',
    );
    const archived = membership({ role: 'OWNER', archivedAt: '2026-01-01T00:00:00Z' });
    expect(codeOf(() => build(session(), principal({ memberships: [archived] })))).toBe(
      'FORBIDDEN',
    );
    expect(codeOf(() => build(session(), principal({ memberships: [] })))).toBe('FORBIDDEN');
  });

  it('requires MFA for firm roles when the firm requires it', () => {
    const consultant = principal({
      memberships: [membership({ role: 'CONSULTANT', consultantClientIds: [C1] })],
    });
    const pending = session({ mfaSatisfied: false });
    let thrown: unknown;
    try {
      build(pending, consultant);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'MFA_REQUIRED', details: { enrolled: false } });
    expect(build(pending, consultant, { allowBeforeMfa: true }).mfaSatisfied).toBe(false);
    expect(build(pending, { ...consultant, mfaRequiredForFirmRoles: false }).clientIds).toEqual([
      C1,
    ]);
    // Client roles never need MFA.
    expect(build(pending, principal()).mfaSatisfied).toBe(false);
  });
});
