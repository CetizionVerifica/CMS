import type { Membership, RequestContext } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { systemContext, tenantFromRequest, tenantSettings } from '../src/tenant-context.js';

const FIRM = '01920000-0000-7000-8000-00000000000f';
const PERSON = '01920000-0000-7000-8000-00000000000a';
const C1 = '01920000-0000-7000-8000-0000000000c1';
const C2 = '01920000-0000-7000-8000-0000000000c2';

function membership(role: Membership['role'], archivedAt: string | null = null): Membership {
  const firmRole = role === 'FIRM_ADMIN' || role === 'CONSULTANT';
  return {
    id: '01920000-0000-7000-8000-0000000000ee',
    firmId: FIRM,
    createdAt: '2026-10-11T00:00:00Z',
    updatedAt: '2026-10-11T00:00:00Z',
    archivedAt,
    version: 1,
    personId: PERSON,
    role,
    clientId: firmRole ? null : C1,
    consultantClientIds: role === 'CONSULTANT' ? [C1] : null,
    unitIds: null,
    expiresAt: role === 'VIEWER' ? '2027-01-01T00:00:00Z' : null,
  };
}

function request(memberships: Membership[]): RequestContext {
  return {
    requestId: 'req-1',
    firmId: FIRM,
    personId: PERSON,
    memberships,
    clientIds: [C1, C2],
    mfaSatisfied: true,
    asOf: '2026-10-11' as RequestContext['asOf'],
  };
}

describe('tenantSettings', () => {
  it('renders a client list as a Postgres array literal', () => {
    expect(
      tenantSettings({ firmId: FIRM, personId: PERSON, clientIds: [C1, C2], requestId: 'r' }),
    ).toEqual({
      'app.firm_id': FIRM,
      'app.person_id': PERSON,
      'app.client_ids': `{${C1},${C2}}`,
      'app.all_clients': 'off',
      'app.request_id': 'r',
    });
  });

  it('renders a firm-wide system context', () => {
    expect(tenantSettings(systemContext(FIRM, 'job:reminders'))).toEqual({
      'app.firm_id': FIRM,
      'app.person_id': '',
      'app.client_ids': '',
      'app.all_clients': 'on',
      'app.request_id': 'job:reminders',
    });
  });

  it('renders an empty client list as an empty array', () => {
    expect(
      tenantSettings({ firmId: FIRM, personId: null, clientIds: [], requestId: 'r' })[
        'app.client_ids'
      ],
    ).toBe('{}');
  });

  it.each([
    ['a firm id that is not a UUID', { firmId: "x' or '1'='1" }],
    ['an upper-case UUID', { firmId: FIRM.toUpperCase() }],
    ['a client id that is not a UUID', { clientIds: ['nope'] }],
    ['an empty request id', { requestId: '' }],
    ['an unknown key', { bypass: true }],
  ])('rejects %s', (_label, patch) => {
    expect(() =>
      tenantSettings({ firmId: FIRM, personId: null, clientIds: [C1], requestId: 'r', ...patch }),
    ).toThrow();
  });
});

describe('tenantFromRequest', () => {
  it('gives a firm admin every client of the firm', () => {
    expect(tenantFromRequest(request([membership('FIRM_ADMIN')]))).toEqual({
      firmId: FIRM,
      personId: PERSON,
      clientIds: 'ALL',
      requestId: 'req-1',
    });
  });

  it.each(['CONSULTANT', 'CLIENT_ADMIN', 'APPROVER', 'OWNER', 'VIEWER'] as const)(
    'limits a %s to the request’s clients',
    (role) => {
      expect(tenantFromRequest(request([membership(role)])).clientIds).toEqual([C1, C2]);
    },
  );

  it('ignores an archived firm admin membership', () => {
    const ctx = request([membership('FIRM_ADMIN', '2026-10-01T00:00:00Z'), membership('OWNER')]);
    expect(tenantFromRequest(ctx).clientIds).toEqual([C1, C2]);
  });
});
