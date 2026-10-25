import { LocalDate } from '@canopy/contracts';
import type { AccountRecord } from '@canopy/db';
import { describe, expect, it } from 'vitest';
import {
  accountOf,
  after,
  cursorOf,
  featureChange,
  featuresChanged,
  overrideToStore,
  matches,
  newestFirst,
  operatorToday,
  ownerInviteExpiry,
  profileOf,
  statusMove,
  trialEndFor,
} from './accounts.js';

const record = (over: Partial<AccountRecord> = {}): AccountRecord => ({
  id: '0192f3a1-0000-7000-8000-000000000001',
  name: 'Kestrel Metals Group',
  kind: 'ENTERPRISE',
  status: 'TRIAL',
  planCode: 'BUSINESS',
  trialEndsOn: LocalDate.parse('2026-11-23'),
  profile: {
    legalName: 'Kestrel Metals Group Private Limited',
    gstin: null,
    timeZone: 'Asia/Kolkata',
    fyStartMonth: 4,
  },
  onboardedAt: null,
  libraryCopiedAt: null,
  deletionRequestedAt: null,
  statusBeforeDeletion: null,
  createdAt: '2026-10-24T03:30:00.000Z',
  version: 1,
  ...over,
});

describe('operator dates', () => {
  it("are the operator's date in India", () => {
    expect(operatorToday(new Date('2026-10-23T18:29:59.000Z'))).toBe('2026-10-23');
    expect(operatorToday(new Date('2026-10-23T18:30:00.000Z'))).toBe('2026-10-24');
  });

  it('give a trial 30 days from today unless told otherwise, and none when ACTIVE at once', () => {
    const now = new Date('2026-10-24T03:30:00.000Z');
    expect(trialEndFor({ activeNow: false }, now)).toBe('2026-11-23');
    expect(trialEndFor({ activeNow: false, trialEndsOn: LocalDate.parse('2026-12-31') }, now)).toBe(
      '2026-12-31',
    );
    expect(trialEndFor({ activeNow: true }, now)).toBeNull();
    // Late evening in India is the next day there.
    expect(trialEndFor({ activeNow: false }, new Date('2026-10-24T20:00:00.000Z'))).toBe(
      '2026-11-24',
    );
  });

  it('give the owner 72 hours to accept', () => {
    expect(ownerInviteExpiry(new Date('2026-10-24T03:30:00.000Z'))).toBe(
      '2026-10-27T03:30:00.000Z',
    );
  });
});

describe('the account view', () => {
  const entitlements = {
    planCode: 'BUSINESS',
    limits: { companies: 5, units: 50, users: 100, storageBytes: null },
    features: [],
  };
  const usage = {
    companies: 1,
    units: 2,
    users: 3,
    storageBytes: 4,
    instances: 9,
    activeUsers30d: 2,
  };

  it('shows counts and entitlements only, and when a deletion may purge', () => {
    const view = accountOf(
      record({ deletionRequestedAt: '2026-10-24T03:30:00.000Z', status: 'PENDING_DELETION' }),
      entitlements,
      usage,
    );
    expect(view.usage).toEqual({ companies: 1, units: 2, users: 3, storageBytes: 4 });
    expect(view.purgeAfter).toBe('2026-11-23T03:30:00.000Z');
    expect(view.libraryCopiedAt).toBeNull();
    expect(view).not.toHaveProperty('statusBeforeDeletion');
    expect(accountOf(record(), entitlements, usage).purgeAfter).toBeNull();
    const copied = '2026-10-24T03:31:00.000Z';
    expect(
      accountOf(record({ libraryCopiedAt: copied }), entitlements, usage).libraryCopiedAt,
    ).toBe(copied);
    // The ISO catalogue copy time goes across too (ISO-5b); a record without it reads as not copied.
    expect(
      accountOf(record({ isoCatalogueCopiedAt: copied }), entitlements, usage).isoCatalogueCopiedAt,
    ).toBe(copied);
    expect(accountOf(record(), entitlements, usage).isoCatalogueCopiedAt).toBeNull();
  });

  it('fills the profile of a firm from before accounts with the defaults', () => {
    expect(profileOf(record({ name: 'Demo Advisory', profile: {} }))).toEqual({
      legalName: 'Demo Advisory',
      gstin: null,
      timeZone: 'Asia/Kolkata',
      fyStartMonth: 4,
    });
  });
});

describe('status moves', () => {
  it('name the operator action', () => {
    expect(statusMove('TRIAL', 'ACTIVE')).toBe('TRIAL_CONVERT');
    expect(statusMove('TRIAL', 'SUSPENDED')).toBe('ACCOUNT_SUSPEND');
    expect(statusMove('ACTIVE', 'SUSPENDED')).toBe('ACCOUNT_SUSPEND');
    expect(statusMove('SUSPENDED', 'ACTIVE')).toBe('ACCOUNT_RESUME');
  });

  it.each([
    ['PROVISIONING', 'ACTIVE'],
    ['PROVISIONING', 'SUSPENDED'],
    ['ACTIVE', 'ACTIVE'],
    ['SUSPENDED', 'SUSPENDED'],
    ['PENDING_DELETION', 'ACTIVE'],
    ['PENDING_DELETION', 'SUSPENDED'],
    ['DELETED', 'ACTIVE'],
  ] as const)('refuse %s to %s with 409', (from, to) => {
    expect(() => statusMove(from, to)).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION', details: { from, to } }),
    );
  });
});

describe('the account list', () => {
  const a = record({
    id: '0192f3a1-0000-7000-8000-00000000000a',
    createdAt: '2026-10-20T00:00:00.000Z',
  });
  const b = record({
    id: '0192f3a1-0000-7000-8000-00000000000b',
    createdAt: '2026-10-22T00:00:00.000Z',
  });
  const c = record({
    id: '0192f3a1-0000-7000-8000-00000000000c',
    createdAt: '2026-10-22T00:00:00.000Z',
  });

  it('runs newest first, then by id, and pages after a cursor', () => {
    const sorted = [a, b, c].sort(newestFirst);
    expect(sorted.map((r) => r.id.slice(-1))).toEqual(['c', 'b', 'a']);
    expect(after(sorted, cursorOf(c)).map((r) => r.id.slice(-1))).toEqual(['b', 'a']);
    expect(after(sorted, cursorOf(b)).map((r) => r.id.slice(-1))).toEqual(['a']);
    expect(after(sorted, undefined)).toHaveLength(3);
    expect(() => after(sorted, 'bm9wZQ')).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });

  it('searches the name and the legal name, ignoring case', () => {
    expect(matches(a, undefined)).toBe(true);
    expect(matches(a, 'kestrel metals')).toBe(true);
    expect(matches(a, 'private limited')).toBe(true);
    expect(matches(a, 'osprey')).toBe(false);
    expect(matches(record({ profile: {} }), 'limited')).toBe(false);
  });
});

describe('the override and its features (ISO-5b)', () => {
  const stored = {
    limits: { users: 90 },
    features: ['isoManagement', 'earlyAccess'],
    removedFeatures: [],
    note: 'Pilot',
  };

  it('keeps an add-on the body names in neither list as stored', () => {
    expect(
      overrideToStore({ limits: {}, features: ['beta'], removedFeatures: [], note: null }, stored),
    ).toEqual({ limits: {}, features: ['beta', 'isoManagement'], removedFeatures: [], note: null });
    const off = { ...stored, features: [], removedFeatures: ['isoManagement'] };
    expect(overrideToStore({ limits: {}, features: [], note: null }, off)).toEqual({
      limits: {},
      features: [],
      removedFeatures: ['isoManagement'],
      note: null,
    });
  });

  it('changes an add-on the body names, and other flags exactly as the body says', () => {
    expect(
      overrideToStore(
        { limits: {}, features: [], removedFeatures: ['isoManagement'], note: null },
        stored,
      ),
    ).toEqual({ limits: {}, features: [], removedFeatures: ['isoManagement'], note: null });
    expect(overrideToStore({ limits: {}, features: ['isoManagement'], note: null }, null)).toEqual({
      limits: {},
      features: ['isoManagement'],
      removedFeatures: [],
      note: null,
    });
  });

  it('says which flags turned on and off, or null', () => {
    expect(featureChange(['importer'], ['importer', 'isoManagement'])).toEqual({
      added: ['isoManagement'],
      removed: [],
    });
    expect(featureChange(['b', 'a'], ['c'])).toEqual({ added: ['c'], removed: ['a', 'b'] });
    expect(featureChange(['importer'], ['importer'])).toBeNull();
    expect(featuresChanged('acc-1', { added: ['isoManagement'], removed: [] })).toEqual({
      type: 'account.features_changed',
      data: { accountId: 'acc-1', added: ['isoManagement'], removed: [] },
    });
  });
});
