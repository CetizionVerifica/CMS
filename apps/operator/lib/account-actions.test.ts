import { describe, expect, it } from 'vitest';

import {
  accountActions,
  featureSource,
  featuresFrom,
  isoSetup,
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

  it('always names the flag it switches, on in features and off in removedFeatures (ISO-5b)', () => {
    const on = withFeature(parts, 'isoManagement', true);
    expect(on).toEqual({
      limits: { users: 200 },
      features: ['sso', 'isoManagement'],
      removedFeatures: [],
    });
    expect(featureSource('isoManagement', plan, on)).toBe('added');
    // Off names the flag even on a plan without it, so a plan edit that adds it later leaves it off.
    expect(withFeature(on, 'isoManagement', false)).toEqual({
      limits: { users: 200 },
      features: ['sso'],
      removedFeatures: ['isoManagement'],
    });
    expect(featureSource('isoManagement', plan, parts)).toBe('off');
  });

  it('turns off an add-on the plan includes, and on again by naming it', () => {
    const off = withFeature(parts, 'isoManagement', false);
    expect(off.removedFeatures).toEqual(['isoManagement']);
    expect(featureSource('isoManagement', withIso, off)).toBe('removed');
    expect(withFeature(off, 'isoManagement', true)).toEqual({
      limits: { users: 200 },
      features: ['sso', 'isoManagement'],
      removedFeatures: [],
    });
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

describe('the ISO set-up line (ISO-5b)', () => {
  const NOW = Date.parse('2026-10-25T10:00:00.000Z');
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
  const entry = (
    at: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ) => ({
    id: '01900000-0000-7000-8000-0000000000e2',
    at,
    operatorId: null,
    action: 'OVERRIDE_CHANGE' as const,
    accountId: '01900000-0000-7000-8000-0000000000a1',
    before,
    after,
    reason: null,
    requestId: 'r',
    ip: null,
  });
  const switchedOn = (m: number) =>
    entry(minutesAgo(m), { features: ['importer'] }, { features: ['importer', 'isoManagement'] });
  const resumed = (m: number) =>
    entry(minutesAgo(m), { status: 'SUSPENDED' }, { status: 'ACTIVE' });
  const base = {
    status: 'ACTIVE' as const,
    createdAt: minutesAgo(10_000),
    isoCatalogueCopiedAt: null,
  };

  it('shows the copy time once copied', () => {
    expect(
      isoSetup({ ...base, isoCatalogueCopiedAt: minutesAgo(1) }, [switchedOn(20)], NOW),
    ).toEqual({ state: 'copied', at: minutesAgo(1) });
  });

  it('flags a TRIAL or ACTIVE account 15 minutes after the switch-on, not before', () => {
    expect(isoSetup(base, [switchedOn(14)], NOW)).toEqual({ state: 'waiting' });
    expect(isoSetup(base, [switchedOn(16)], NOW)).toEqual({ state: 'late', since: minutesAgo(16) });
    expect(isoSetup({ ...base, status: 'TRIAL' }, [switchedOn(16)], NOW).state).toBe('late');
  });

  it('never flags a SUSPENDED or PROVISIONING account, and counts from a resume', () => {
    expect(isoSetup({ ...base, status: 'SUSPENDED' }, [switchedOn(60)], NOW)).toEqual({
      state: 'notYet',
    });
    expect(isoSetup({ ...base, status: 'PROVISIONING' }, [], NOW).state).toBe('notYet');
    // Switched on an hour ago while suspended, resumed 5 minutes ago: not late yet.
    expect(isoSetup(base, [resumed(5), switchedOn(60)], NOW)).toEqual({ state: 'waiting' });
    expect(isoSetup(base, [resumed(20), switchedOn(60)], NOW)).toEqual({
      state: 'late',
      since: minutesAgo(20),
    });
  });

  it('counts from the account’s creation when a plan gave it the add-on', () => {
    expect(isoSetup({ ...base, createdAt: minutesAgo(5) }, [], NOW)).toEqual({ state: 'waiting' });
    expect(isoSetup(base, [], NOW)).toEqual({ state: 'late', since: base.createdAt });
  });
});
