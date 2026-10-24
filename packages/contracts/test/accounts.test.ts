import { readFileSync } from 'node:fs';
import { validate } from '@readme/openapi-parser';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ACCOUNT_TRANSITIONS,
  AccountCreateBody,
  AccountStatus,
  AccountStatusBody,
  ApiErrorResponse,
  buildPlatformOpenApi,
  canMoveAccount,
  CONTRACTS_VERSION,
  DEFAULT_ACCOUNT,
  ENDPOINTS,
  type Endpoint,
  ERROR_HTTP_STATUS,
  Firm,
  Gstin,
  Me,
  OPERATOR_SESSION_COOKIE,
  EXPORT_ACCOUNT_STATUSES,
  PLATFORM_ENDPOINTS,
  PlanCode,
  SubscriptionCreateBody,
  SupportGrant,
  SupportGrantCreateBody,
  tolerant,
  WORKING_ACCOUNT_STATUSES,
} from '../src/index.js';
import { loadFixtureSet } from '../src/fixtures/index.js';

const firmBSet = loadFixtureSet('firm-b.synthetic');

const platform = Object.entries(PLATFORM_ENDPOINTS) as [string, Endpoint][];
const [, platformMd = ''] = readFileSync(
  new URL('../../../docs/contracts/endpoints.md', import.meta.url),
  'utf8',
).split(/^## 9\. /m);
const committed = JSON.parse(
  readFileSync(new URL('../../../docs/contracts/openapi.platform.json', import.meta.url), 'utf8'),
) as unknown;

const ID = '018f3f6e-4c2a-7b1d-9e8f-0a1b2c3d4e5f';
const ID2 = '018f3f6e-4c2a-7b1d-9e8f-0a1b2c3d4e60';

describe('account lifecycle', () => {
  it('lists a move set for every status, and only statuses as targets', () => {
    expect(Object.keys(ACCOUNT_TRANSITIONS).sort()).toEqual([...AccountStatus.options].sort());
    for (const targets of Object.values(ACCOUNT_TRANSITIONS)) {
      for (const to of targets) expect(AccountStatus.options).toContain(to);
    }
  });

  it('follows ADR M15-0001 decision 3', () => {
    expect(canMoveAccount('PROVISIONING', 'TRIAL')).toBe(true);
    expect(canMoveAccount('PROVISIONING', 'ACTIVE')).toBe(true);
    expect(canMoveAccount('PROVISIONING', 'SUSPENDED')).toBe(false);
    expect(canMoveAccount('TRIAL', 'ACTIVE')).toBe(true);
    expect(canMoveAccount('ACTIVE', 'TRIAL')).toBe(false);
    expect(canMoveAccount('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canMoveAccount('SUSPENDED', 'ACTIVE')).toBe(true);
    expect(canMoveAccount('ACTIVE', 'DELETED')).toBe(false);
    expect(canMoveAccount('PENDING_DELETION', 'DELETED')).toBe(true);
    expect(canMoveAccount('DELETED', 'ACTIVE')).toBe(false);
    expect(ACCOUNT_TRANSITIONS.DELETED).toEqual([]);
  });

  it('lets admins export only while deletion is pending, never while working or suspended', () => {
    const working: readonly string[] = WORKING_ACCOUNT_STATUSES;
    expect(EXPORT_ACCOUNT_STATUSES.some((s) => working.includes(s))).toBe(false);
    expect(EXPORT_ACCOUNT_STATUSES).toEqual(['PENDING_DELETION']);
  });

  it('lets the status route ask only for converts, suspends and resumes', () => {
    const body = { version: 1, to: 'SUSPENDED', reason: 'Unpaid invoice' };
    expect(AccountStatusBody.parse(body).to).toBe('SUSPENDED');
    expect(AccountStatusBody.safeParse({ ...body, to: 'DELETED' }).success).toBe(false);
    expect(AccountStatusBody.safeParse({ ...body, reason: '' }).success).toBe(false);
  });
});

describe('account schemas', () => {
  it('reads firms stored before accounts existed as active consultancies', () => {
    const stored = { ...firmBSet.firm } as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_ACCOUNT)) delete stored[key];
    expect(Firm.parse(stored)).toMatchObject(DEFAULT_ACCOUNT);
  });

  it('checks plan codes and GSTINs by shape', () => {
    expect(PlanCode.safeParse('STARTER').success).toBe(true);
    expect(PlanCode.safeParse('starter').success).toBe(false);
    expect(Gstin.safeParse('27AAPFU0939F1ZV').success).toBe(true);
    expect(Gstin.safeParse('27AAPFU0939F1Z').success).toBe(false);
  });

  it('provisions with the plan defaults', () => {
    const body = AccountCreateBody.parse({
      name: 'Kestrel Metals Group',
      kind: 'ENTERPRISE',
      planCode: 'BUSINESS',
      legalName: 'Kestrel Metals Group Private Limited',
      owner: { displayName: 'Asha Rao', email: 'asha.rao@kestrel-metals.example' },
    });
    expect(body).toMatchObject({
      timeZone: 'Asia/Kolkata',
      fyStartMonth: 4,
      gstin: null,
      activeNow: false,
    });
  });

  it('refuses a trial end together with activeNow, and a client name for a consultancy', () => {
    const base = {
      name: 'Osprey Textiles Group',
      kind: 'CONSULTANCY',
      planCode: 'CONSULTANCY',
      legalName: 'Osprey Textiles Group LLP',
      owner: { displayName: 'Dev Iyer', email: 'dev.iyer@osprey.example' },
    };
    expect(AccountCreateBody.safeParse(base).success).toBe(true);
    expect(
      AccountCreateBody.safeParse({ ...base, activeNow: true, trialEndsOn: '2026-11-30' }).success,
    ).toBe(false);
    expect(AccountCreateBody.safeParse({ ...base, clientName: 'Osprey' }).success).toBe(false);
  });

  it('keeps support grants between 1 and 30 days, 7 by default', () => {
    expect(SupportGrantCreateBody.parse({ level: 'READ_ONLY' }).days).toBe(7);
    expect(SupportGrantCreateBody.safeParse({ level: 'ADMIN', days: 31 }).success).toBe(false);
    expect(SupportGrantCreateBody.safeParse({ level: 'ADMIN', days: 0 }).success).toBe(false);
  });

  it('checks a support grant ends after it starts and is revoked exactly when it says so', () => {
    const grant = {
      id: ID,
      accountId: ID2,
      level: 'READ_ONLY',
      status: 'ACTIVE',
      startsAt: '2026-10-24T06:00:00Z',
      endsAt: '2026-10-31T06:00:00Z',
      grantedById: ID,
      revokedAt: null,
      revokedById: null,
      supportPersonId: ID2,
    };
    expect(SupportGrant.safeParse(grant).success).toBe(true);
    expect(SupportGrant.safeParse({ ...grant, endsAt: grant.startsAt }).success).toBe(false);
    expect(SupportGrant.safeParse({ ...grant, status: 'REVOKED' }).success).toBe(false);
  });

  it('refuses a subscription that ends before it starts', () => {
    const body = {
      planCode: 'BUSINESS',
      startsOn: '2026-11-01',
      endsOn: '2027-10-31',
      amountPaise: 12_000_000,
      invoiceNumber: 'PP-2026-0042',
      paidOn: null,
    };
    expect(SubscriptionCreateBody.safeParse(body).success).toBe(true);
    expect(SubscriptionCreateBody.safeParse({ ...body, endsOn: '2026-10-31' }).success).toBe(false);
  });

  it('lets clients read a Me without an account', () => {
    expect(ENDPOINTS.getMe.response.shape.account.safeParse(undefined).success).toBe(true);
    expect(
      Me.shape.account.safeParse({ kind: 'ENTERPRISE', status: 'TRIAL', trialEndsOn: '2026-11-23' })
        .success,
    ).toBe(true);
  });
});

describe('account errors', () => {
  it('answers 403 for a paused account and a plan limit', () => {
    expect(ERROR_HTTP_STATUS.ACCOUNT_SUSPENDED).toBe(403);
    expect(ERROR_HTTP_STATUS.PLAN_LIMIT_REACHED).toBe(403);
  });

  it('carries the limit, the maximum and the count', () => {
    const body = {
      error: {
        code: 'PLAN_LIMIT_REACHED',
        message: 'Your plan allows 3 units. Contact PlanetPulse to upgrade.',
        details: { limit: 'units', max: 3, used: 3 },
      },
      requestId: 'req-1',
    };
    expect(ApiErrorResponse.safeParse(body).success).toBe(true);
    const wrong = {
      ...body,
      error: { ...body.error, details: { limit: 'plants', max: 3, used: 3 } },
    };
    expect(ApiErrorResponse.safeParse(wrong).success).toBe(false);
  });

  it('describes an account move refused as INVALID_TRANSITION', () => {
    const body = {
      error: {
        code: 'INVALID_TRANSITION',
        message: 'A DELETED account cannot become ACTIVE.',
        details: { from: 'DELETED', to: 'ACTIVE' },
      },
      requestId: 'req-2',
    };
    expect(ApiErrorResponse.safeParse(body).success).toBe(true);
  });
});

describe('operator endpoint table', () => {
  it('lists the same paths as endpoints.md §9', () => {
    const rows = platformMd.split('\n').filter((line) => /^\| (GET|POST|PUT|PATCH)\b/.test(line));
    const documented = new Set(
      rows.flatMap((row) =>
        [...row.matchAll(/`(\/[a-z][\w\-/{}]*)`/g)].map((match) => match[1] as string),
      ),
    );
    const coded = new Set(platform.map(([, ep]) => ep.path));
    expect([...coded].filter((path) => !documented.has(path))).toEqual([]);
    expect([...documented].filter((path) => !coded.has(path))).toEqual([]);
  });

  it('has one endpoint per method and path, all from M15, with no roles or can() actions', () => {
    const keys = platform.map(([, ep]) => `${ep.method} ${ep.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [id, ep] of platform) {
      expect(ep.module, id).toBe('M15');
      expect(ep.roles, id).toEqual({});
      expect(ep.actions, id).toEqual([]);
      if (ep.method === 'GET') expect(ep.body, id).toBeNull();
    }
    expect(platform.filter(([, ep]) => ep.auth === 'public').map(([id]) => id)).toEqual([
      'operatorLogin',
    ]);
  });

  it('has responses with no transforms, parseable tolerantly', () => {
    for (const [id, ep] of platform) {
      const input = z.toJSONSchema(ep.response, { io: 'input', unrepresentable: 'any' });
      const output = z.toJSONSchema(ep.response, { io: 'output', unrepresentable: 'any' });
      expect(input, id).toEqual(output);
      expect(() => tolerant(ep.response)).not.toThrow();
    }
  });

  it('honours Idempotency-Key on account creation and subscription records', () => {
    expect(
      platform
        .filter(([, ep]) => ep.idempotent)
        .map(([id]) => id)
        .sort(),
    ).toEqual(['createAccount', 'recordSubscription']);
  });
});

describe('operator OpenAPI document', () => {
  const doc = buildPlatformOpenApi();

  it('matches the committed docs/contracts/openapi.platform.json (run `pnpm --filter @canopy/contracts openapi`)', () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(doc)));
  });

  it('is valid OpenAPI 3.1', async () => {
    const result = await validate(structuredClone(doc) as never);
    expect(result).toMatchObject({ valid: true, warnings: [] });
  });

  it('is served under /api/platform/v1 with the operator cookie', () => {
    expect(doc.info.version).toBe(CONTRACTS_VERSION);
    expect(doc.servers).toEqual([{ url: '/api/platform/v1' }]);
    expect(doc.components.securitySchemes.session).toMatchObject({ name: OPERATOR_SESSION_COOKIE });
    const ids = Object.values(doc.paths).flatMap((ops) =>
      Object.values(ops).map((op) => op.operationId),
    );
    expect(ids.sort()).toEqual(platform.map(([id]) => id).sort());
  });
});
