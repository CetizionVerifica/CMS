import { describe, expect, it } from 'vitest';
import {
  Act,
  AccountOverride,
  AccountOverrideBody,
  AccountSummary,
  ActKind,
  ApiErrorResponse,
  ClauseNumber,
  effectiveFeatures,
  EntityType,
  ERROR_HTTP_STATUS,
  FeatureFlag,
  ISO_ENTITY_TYPES,
  IsoEntityType,
  KNOWN_FEATURES,
  KnownFeature,
  Me,
  Obligation,
  tolerant,
} from '../src/index.js';
import { obligation, versioned } from './samples.js';

/** Contracts 1.7.0: the ISO add-on's feature contracts (docs/iso/plan.md §7, ISO-0). */

describe('known features', () => {
  it('lists each known add-on once, with words for the console', () => {
    expect(KNOWN_FEATURES.map((f) => f.code)).toEqual(KnownFeature.options);
    for (const feature of KNOWN_FEATURES) {
      expect(FeatureFlag.safeParse(feature.code).success, feature.code).toBe(true);
      expect(feature.label.trim()).not.toBe('');
      expect(feature.description.trim()).not.toBe('');
    }
  });
  it('names the ISO add-on in the client-facing words, never the internal product name', () => {
    const iso = KNOWN_FEATURES.find((f) => f.code === 'isoManagement')!;
    expect(iso.label).toBe('ISO management systems');
    expect(`${iso.label} ${iso.description}`).not.toMatch(/canopy/i);
  });
});

describe('account override', () => {
  const override = { limits: {}, features: ['importer'], note: null };

  it('reads an override stored before removedFeatures existed', () => {
    expect(AccountOverride.parse(override)).toEqual(override);
  });
  it('takes a feature away, but not one it also adds', () => {
    expect(
      AccountOverride.safeParse({ ...override, removedFeatures: ['isoManagement'] }).success,
    ).toBe(true);
    const both = AccountOverride.safeParse({ ...override, removedFeatures: ['importer'] });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.path).toEqual(['removedFeatures']);
    expect(
      AccountOverride.safeParse({ ...override, removedFeatures: ['Not a flag'] }).success,
    ).toBe(false);
  });
  it('carries removedFeatures through the operator override route', () => {
    const body = AccountOverrideBody.parse({
      version: 3,
      override: { ...override, removedFeatures: ['isoManagement'] },
      reason: 'Customer asked to pause the ISO add-on',
    });
    expect(body.override.removedFeatures).toEqual(['isoManagement']);
  });
});

describe('effectiveFeatures', () => {
  it('is the plan plus added features, without the removed ones, sorted once each', () => {
    expect(effectiveFeatures(['sso', 'importer'], null)).toEqual(['importer', 'sso']);
    expect(effectiveFeatures(['sso', 'importer'], { features: ['isoManagement', 'sso'] })).toEqual([
      'importer',
      'isoManagement',
      'sso',
    ]);
    expect(
      effectiveFeatures(['isoManagement', 'importer'], {
        features: [],
        removedFeatures: ['isoManagement'],
      }),
    ).toEqual(['importer']);
  });
  it('turns a plan feature off for one account even when the plan includes it', () => {
    expect(
      effectiveFeatures(['isoManagement'], { features: [], removedFeatures: ['isoManagement'] }),
    ).toEqual([]);
  });
});

describe("the account's features on Me", () => {
  it('are optional until M5 sends them, and are flags when present', () => {
    const summary = { kind: 'CONSULTANCY', status: 'ACTIVE', trialEndsOn: null };
    expect(AccountSummary.safeParse(summary).success).toBe(true);
    expect(AccountSummary.safeParse({ ...summary, features: ['isoManagement'] }).success).toBe(
      true,
    );
    expect(AccountSummary.safeParse({ ...summary, features: ['ISO'] }).success).toBe(false);
    expect(Me.shape.account.unwrap().shape.features).toBeDefined();
  });
});

describe('FEATURE_NOT_ENABLED', () => {
  it('is a 403 that names the feature', () => {
    expect(ERROR_HTTP_STATUS.FEATURE_NOT_ENABLED).toBe(403);
    const body = {
      error: {
        code: 'FEATURE_NOT_ENABLED',
        message: 'ISO management systems is not turned on for your account.',
        details: { feature: 'isoManagement' },
      },
      requestId: 'req-1',
    };
    expect(ApiErrorResponse.safeParse(body).success).toBe(true);
    expect(
      ApiErrorResponse.safeParse({ ...body, error: { ...body.error, details: {} } }).success,
    ).toBe(false);
  });
});

describe('Act kind', () => {
  const act = {
    ...versioned,
    name: 'ISO 14001:2015',
    shortName: 'ISO 14001',
    jurisdiction: 'CENTRAL',
    stateCode: null,
    aliases: [],
  };

  it('is STATUTE or STANDARD, and missing on Acts stored before it existed', () => {
    expect(ActKind.options).toEqual(['STATUTE', 'STANDARD']);
    expect(Act.parse(act)).not.toHaveProperty('kind');
    expect(Act.safeParse({ ...act, kind: 'STANDARD' }).success).toBe(true);
    expect(Act.safeParse({ ...act, kind: 'ISO' }).success).toBe(false);
  });
  it('keeps a STANDARD act CENTRAL', () => {
    const state = { ...act, kind: 'STANDARD', jurisdiction: 'STATE', stateCode: 'WB' };
    expect(Act.safeParse(state).success).toBe(false);
    expect(Act.safeParse({ ...state, kind: 'STATUTE' }).success).toBe(true);
  });
  it('reads a kind a client does not know yet as UNKNOWN', () => {
    expect(tolerant(Act).parse({ ...act, kind: 'GUIDELINE' })).toMatchObject({
      kind: 'UNKNOWN',
    });
  });
});

describe('obligation clause references', () => {
  it('are optional clauses of a named standard, each once', () => {
    const ref = (standard: string, clauseNumber: string) => ({ standard, clauseNumber });
    const ok = (clauseRefs: unknown) => Obligation.safeParse({ ...obligation, clauseRefs }).success;
    expect(Obligation.safeParse(obligation).success).toBe(true);
    expect(ok([])).toBe(true);
    // 9001 8.2 and 14001 8.2 are different clauses, so the same number may appear once per standard.
    expect(ok([ref('ISO_9001', '8.2'), ref('ISO_14001', '8.2'), ref('ISO_45001', '9.1.1')])).toBe(
      true,
    );
    expect(ok([ref('ISO_9001', '7.1.5'), ref('ISO_9001', '7.1.5')])).toBe(false);
    expect(ok(['7.1.5'])).toBe(false);
    expect(ok([ref('ISO_9001', 'Clause 7')])).toBe(false);
    expect(ok([ref('ISO_27001', '7.1')])).toBe(false);
    expect(ok([{ ...ref('ISO_9001', '7.1'), title: 'x' }])).toBe(false);
  });
  it.each(['4', '6.1.2', '7.1.5.1', '10.2', '8.1.0'])('accepts clause number %s', (n) => {
    expect(ClauseNumber.safeParse(n).success).toBe(true);
  });
  it.each(['0', '06.1', '6.', '.6', '6.1.2.3.4', 'A.1', '6-1', ''])('rejects %j', (n) => {
    expect(ClauseNumber.safeParse(n).success).toBe(false);
  });
});

describe('ISO entity types', () => {
  it('are staged apart from EntityType until the database stores them', () => {
    expect(IsoEntityType.options).toEqual([...ISO_ENTITY_TYPES]);
    expect(new Set(ISO_ENTITY_TYPES).size).toBe(ISO_ENTITY_TYPES.length);
    for (const type of ISO_ENTITY_TYPES) {
      expect(EntityType.options as readonly string[]).not.toContain(type);
      expect(type).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
