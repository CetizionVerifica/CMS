import { AccountView, SupportGrant } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { formatBytes, formatInstant, grantRows, usageRows } from './account-model';

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
});
