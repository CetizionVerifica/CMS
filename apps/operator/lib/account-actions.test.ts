import { describe, expect, it } from 'vitest';

import { accountActions, featuresFrom, limitFrom, overrideFrom } from './account-actions';
import { account, PLANS } from './test/fake-api';

describe('the account actions on offer', () => {
  it('follows the contracts transition table for each status', () => {
    const open = (
      status: Parameters<typeof accountActions>[0]['status'],
      onboardedAt: string | null = null,
    ) => accountActions({ status, onboardedAt });
    expect(open('PROVISIONING')).toEqual(['resendInvite']);
    expect(open('TRIAL')).toEqual(['convert', 'extendTrial', 'suspend', 'markOnboarded']);
    expect(open('ACTIVE')).toEqual(['suspend', 'markOnboarded', 'requestDeletion']);
    expect(open('ACTIVE', '2026-10-24T00:00:00Z')).toEqual(['suspend', 'requestDeletion']);
    expect(open('SUSPENDED')).toEqual(['resume', 'requestDeletion']);
    expect(open('PENDING_DELETION')).toEqual(['cancelDeletion']);
    expect(open('DELETED')).toEqual([]);
  });
});

describe('limits and features typed by the operator', () => {
  it('reads blank, unlimited and whole numbers', () => {
    expect(limitFrom(' ')).toEqual({ value: undefined });
    expect(limitFrom('Unlimited')).toEqual({ value: null });
    expect(limitFrom('12')).toEqual({ value: 12 });
    expect(limitFrom('1.5')).toHaveProperty('error');
    expect(featuresFrom('importer, reports importer')).toEqual(['importer', 'reports']);
  });

  it('shows as the override what differs from the plan', () => {
    const entitlements = {
      planCode: 'BUSINESS',
      limits: { ...PLANS[1]!.limits, users: 200 },
      features: ['importer', 'sso'],
    };
    expect(overrideFrom(entitlements, PLANS[1])).toEqual({
      limits: { users: 200 },
      features: ['sso'],
    });
    expect(overrideFrom(account().entitlements, undefined)).toEqual({ limits: {}, features: [] });
  });
});
