import { describe, expect, it } from 'vitest';

import { ShellMe } from './types';

const period = {
  current: { fy: '2022-23', quarter: 4 },
  availableFys: ['2022-23'],
  availableUntil: null,
};

describe('ShellMe', () => {
  it('needs the per-client shell context on top of the contract Me', () => {
    const client = { id: '00000000-0000-5000-8000-000000000101', name: 'Demo Metals' };
    const me = {
      person: {
        id: '00000000-0000-5000-8000-000000000201',
        firmId: '00000000-0000-5000-8000-0000000000f1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        archivedAt: null,
        version: 1,
        displayName: 'Owner 01',
        nameNormalized: 'owner 01',
        email: 'owner@demo.test',
        status: 'ACTIVE',
      },
      memberships: [],
      csrfToken: 'csrf-token-0123456789',
      mfa: { required: false, enrolled: false, satisfied: true },
    };
    const full = { ...client, fyStartMonth: 4, timeZone: 'Asia/Kolkata', unitCount: 3, period };
    expect(ShellMe.safeParse({ ...me, clients: [full] }).success).toBe(true);
    expect(ShellMe.safeParse({ ...me, clients: [client] }).success).toBe(false);
    expect(
      ShellMe.safeParse({
        ...me,
        clients: [{ ...full, period: { ...period, availableUntil: '2023-13' } }],
      }).success,
    ).toBe(false);
  });
});
