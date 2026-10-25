import { AccountView, KNOWN_FEATURES, SupportGrant } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../lib/api/client';

import {
  addOnRows,
  formatBytes,
  formatInstant,
  grantRows,
  grantSummary,
  isClosingRefusal,
  planName,
  usageRows,
} from './account-model';

const ID = '00000000-0000-5000-8000-0000000000a1';
const view = AccountView.parse({
  id: ID,
  name: 'Kestrel Metals Group',
  kind: 'ENTERPRISE',
  status: 'TRIAL',
  trialEndsOn: '2026-11-23',
  entitlements: {
    planCode: 'BUSINESS',
    limits: { companies: 3, units: 20, users: null, storageBytes: 10 * 1024 ** 3 },
    features: [],
  },
  usage: { companies: 3, units: 4, users: 12, storageBytes: 1536 * 1024 ** 2 },
});

const grant = (over: Partial<SupportGrant>) =>
  SupportGrant.parse({
    id: ID,
    accountId: ID,
    level: 'READ_ONLY',
    status: 'ACTIVE',
    startsAt: '2026-10-24T05:00:00.000Z',
    endsAt: '2026-10-31T05:00:00.000Z',
    grantedById: ID,
    revokedAt: null,
    revokedById: null,
    supportPersonId: ID,
    ...over,
  });

describe('account model', () => {
  it('lists every known add-on, On only when the account has it', () => {
    const on = addOnRows(['isoManagement', 'somethingElse']);
    expect(on.map((r) => r.code)).toEqual(KNOWN_FEATURES.map((f) => f.code));
    expect(on[0]).toEqual({
      code: 'isoManagement',
      label: 'ISO management systems',
      description: KNOWN_FEATURES[0]!.description,
      on: true,
    });
    expect(addOnRows([]).every((r) => !r.on)).toBe(true);
    expect(addOnRows(['somethingElse']).every((r) => !r.on)).toBe(true);
  });

  it('puts each limit beside its usage and flags one at the limit', () => {
    expect(usageRows(view)).toEqual([
      { label: 'Companies', used: '3', limit: '3', atLimit: true },
      { label: 'Units', used: '4', limit: '20', atLimit: false },
      { label: 'Users', used: '12', limit: 'No limit', atLimit: false },
      { label: 'Evidence storage', used: '1.5 GB', limit: '10 GB', atLimit: false },
    ]);
  });

  it('formats sizes in powers of 1024', () => {
    expect([0, 1023, 1024, 10 * 1024, 5 * 1024 ** 4, 1024 ** 5].map(formatBytes)).toEqual([
      '0 bytes',
      '1023 bytes',
      '1 KB',
      '10 KB',
      '5 TB',
      '1024 TB',
    ]);
  });

  it("shows times in India's time and words each grant", () => {
    expect(formatInstant('2026-10-24T05:00:00.000Z')).toBe('24 Oct 2026, 10:30 IST');
    expect(
      grantRows([
        grant({}),
        grant({
          level: 'ADMIN',
          status: 'REVOKED',
          revokedAt: '2026-10-25T05:00:00.000Z',
          revokedById: ID,
        }),
        grant({ status: 'EXPIRED' }),
      ]).map(({ level, status, live, until }) => [level, status, live, until]),
    ).toEqual([
      ['Read only', 'Active', true, '31 Oct 2026, 10:30 IST'],
      ['Admin', 'Revoked', false, '25 Oct 2026, 10:30 IST'],
      ['Read only', 'Ended', false, '31 Oct 2026, 10:30 IST'],
    ]);
  });

  it('words a plan code and what a new grant gives', () => {
    expect(['BUSINESS', 'CONSULTANCY', 'ENTERPRISE_PLUS'].map(planName)).toEqual([
      'Business',
      'Consultancy',
      'Enterprise plus',
    ]);
    const now = new Date('2026-10-24T05:00:00.000Z');
    expect(grantSummary('ADMIN', 7, now, false)).toBe(
      'Admin access for 7 days, until about 31 Oct 2026, 10:30 IST. Support can act as an account admin, for example to fix a setup or an import.',
    );
    expect(grantSummary('READ_ONLY', 1, now, true)).toBe(
      'Read only access for 1 day, until about 25 Oct 2026, 10:30 IST. Support can look at every client, but change nothing. The current access ends now.',
    );
  });
});

describe('isClosingRefusal', () => {
  it('is the API refusing a closing account, and nothing else', () => {
    const paused = (status: string) =>
      new ApiError(403, 'ACCOUNT_SUSPENDED', 'Your account is paused.', { status });
    expect(isClosingRefusal(paused('PENDING_DELETION'))).toBe(true);
    expect(isClosingRefusal(paused('SUSPENDED'))).toBe(false);
    expect(isClosingRefusal(new ApiError(403, 'ACCOUNT_SUSPENDED', 'Paused.'))).toBe(false);
    expect(
      isClosingRefusal(new ApiError(403, 'FORBIDDEN', 'No.', { status: 'PENDING_DELETION' })),
    ).toBe(false);
    expect(isClosingRefusal(new Error('PENDING_DELETION'))).toBe(false);
  });
});
