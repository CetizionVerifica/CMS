import { describe, expect, it } from 'vitest';

import {
  accountActions,
  featureSource,
  featuresFrom,
  limitFrom,
  noteFrom,
  overrideFrom,
  withFeature,
} from './account-actions';
import { account, PLANS } from './test/fake-api';

describe('the account actions on offer', () => {
  it('follows the contracts transition table for each status', () => {
    const open = (
      status: Parameters<typeof accountActions>[0]['status'],
      onboardedAt: string | null = null,
    ) => accountActions({ status, onboardedAt, purgeAfter: null });
    expect(open('PROVISIONING')).toEqual(['resendInvite']);
    expect(open('TRIAL')).toEqual(['convert', 'extendTrial', 'suspend', 'markOnboarded']);
    expect(open('ACTIVE')).toEqual(['suspend', 'markOnboarded', 'requestDeletion']);
    expect(open('ACTIVE', '2026-10-24T00:00:00Z')).toEqual(['suspend', 'requestDeletion']);
    expect(open('SUSPENDED')).toEqual(['resume', 'requestDeletion']);
    expect(open('PENDING_DELETION')).toEqual(['cancelDeletion']);
    expect(open('DELETED')).toEqual([]);
  });

  it('stops offering the cancel once the account is due for purge', () => {
    const now = Date.parse('2026-11-23T05:00:00.000Z');
    const pending = (purgeAfter: string) =>
      accountActions({ status: 'PENDING_DELETION', onboardedAt: null, purgeAfter }, now);
    expect(pending('2026-11-23T05:00:01.000Z')).toEqual(['cancelDeletion']);
    expect(pending('2026-11-23T05:00:00.000Z')).toEqual([]);
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
      removedFeatures: [],
    });
    expect(overrideFrom(account().entitlements, undefined)).toEqual({
      limits: {},
      features: [],
      removedFeatures: [],
    });
  });

  it('shows as removed the plan features the account goes without', () => {
    const plan = { ...PLANS[1]!, features: ['importer', 'isoManagement'] };
    const current = overrideFrom({ planCode: 'BUSINESS', limits: plan.limits, features: [] }, plan);
    expect(current).toEqual({
      limits: {},
      features: [],
      removedFeatures: ['importer', 'isoManagement'],
    });
    expect(featureSource('isoManagement', plan, current)).toBe('removed');
  });
});

describe('the add-on switch', () => {
  const plan = PLANS[1]!;
  const withIso = { ...plan, features: ['importer', 'isoManagement'] };
  const parts = { limits: { users: 200 }, features: ['sso'], removedFeatures: [] };

  it('adds an add-on the plan lacks, and takes it away again, keeping the limits and other flags', () => {
    const on = withFeature(parts, plan, 'isoManagement', true);
    expect(on).toEqual({
      limits: { users: 200 },
      features: ['sso', 'isoManagement'],
      removedFeatures: [],
    });
    expect(featureSource('isoManagement', plan, on)).toBe('added');
    expect(withFeature(on, plan, 'isoManagement', false)).toEqual(parts);
    expect(featureSource('isoManagement', plan, parts)).toBe('off');
  });

  it('removes an add-on the plan includes, and gives it back by dropping the removal', () => {
    const off = withFeature(parts, withIso, 'isoManagement', false);
    expect(off).toEqual({
      limits: { users: 200 },
      features: ['sso'],
      removedFeatures: ['isoManagement'],
    });
    expect(withFeature(off, withIso, 'isoManagement', true)).toEqual(parts);
    expect(featureSource('isoManagement', withIso, parts)).toBe('plan');
  });

  it('reads the note from the newest override change only when it is there', () => {
    const event = (after: Record<string, unknown> | null) => ({
      id: '01900000-0000-7000-8000-0000000000e1',
      at: '2026-10-24T04:00:00.000Z',
      operatorId: null,
      action: 'OVERRIDE_CHANGE' as const,
      accountId: null,
      before: null,
      after,
      reason: null,
      requestId: 'req-1',
      ip: null,
    });
    expect(noteFrom(undefined)).toBeNull();
    expect(noteFrom(event(null))).toBeNull();
    expect(noteFrom(event({ override: 'odd' }))).toBeNull();
    expect(noteFrom(event({ override: { note: null } }))).toBeNull();
    expect(noteFrom(event({ override: { note: 'Pilot' } }))).toBe('Pilot');
  });
});
