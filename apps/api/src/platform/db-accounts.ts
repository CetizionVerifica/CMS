import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_FIRM_SETTINGS,
  PLATFORM_ENDPOINTS,
  type Account,
} from '@canopy/contracts';
import {
  DbError,
  platformAccounts,
  plans,
  type AccountChange,
  type AccountRecord,
  type OperatorTx,
} from '@canopy/db';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../auth/index.js';
import {
  accountOf,
  after,
  cursorOf,
  featureChange,
  featuresChanged,
  matches,
  newestFirst,
  ownerInviteExpiry,
  profileOf,
  trialEndFor,
} from './accounts.js';
import { mountPlatform, signedInOf, type PlatformDeps } from './db-http.js';
import { features, trail } from './db-trail.js';
import type { OperatorIdempotency } from './idempotency.js';

/** The account as the contract shows it, read in the caller's transaction. */
export async function accountView(tx: OperatorTx, record: AccountRecord): Promise<Account> {
  const [entitlements, usage] = await Promise.all([
    platformAccounts.entitlements(tx, record.id),
    platformAccounts.usage(tx, record.id),
  ]);
  return accountOf(record, entitlements, usage);
}

/** The account, or 404. */
export async function requireAccount(tx: OperatorTx, id: string): Promise<AccountRecord> {
  const record = await platformAccounts.get(tx, id);
  if (!record) throw new ApiError('NOT_FOUND');
  return record;
}

/**
 * Applies a change when the account is still at `version` (409 STALE_VERSION with the current version otherwise),
 * and returns the account before and after.
 */
export async function changeAccount(
  tx: OperatorTx,
  record: AccountRecord,
  version: number,
  change: AccountChange,
): Promise<{ before: AccountRecord; after: AccountRecord }> {
  if (record.version !== version) {
    throw new ApiError('STALE_VERSION', { currentVersion: record.version });
  }
  try {
    return await platformAccounts.update(tx, record.id, version, change);
  } catch (error) {
    if (error instanceof DbError && error.code === 'STALE_VERSION') {
      const current = await requireAccount(tx, record.id);
      throw new ApiError('STALE_VERSION', { currentVersion: current.version });
    }
    throw error;
  }
}

/** A plan an account may be put on: it exists and is not retired. */
export async function choosablePlan(tx: OperatorTx, code: string, path: string[]): Promise<void> {
  const plan = await plans.get(tx, code);
  if (!plan || plan.retiredAt !== null) {
    throw new ApiError('VALIDATION', {
      issues: [{ path, message: plan ? 'This plan is retired' : 'No plan with this code' }],
    });
  }
}

/** Plans, and listing, provisioning, reading and editing accounts (ADR M15-0001 decisions 5, 10). */
export function registerAccountRoutes(
  api: FastifyInstance,
  deps: PlatformDeps,
  idempotency: OperatorIdempotency,
): void {
  const { db } = deps;

  mountPlatform(api, deps, PLATFORM_ENDPOINTS.listPlans, async ({ requestId }) => ({
    items: await db.withOperator(requestId, (tx) => plans.list(tx)),
  }));

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.upsertPlan,
    async ({ request, requestId, params, body, now }) =>
      db.withOperator(requestId, async (tx) => {
        // The accounts on the plan, with their features before the edit. A deleted account has none to change.
        const onPlan = (await platformAccounts.list(tx)).filter(
          (a) => a.planCode === params.code && a.status !== 'DELETED',
        );
        const featuresBefore = new Map<string, string[]>();
        for (const account of onPlan)
          featuresBefore.set(account.id, await features(tx, account.id));
        const { before, after: plan } = await plans.upsert(
          tx,
          params.code!,
          body,
          now.toISOString(),
        );
        await trail(tx, request, requestId, {
          action: 'PLAN_CHANGE',
          accountId: null,
          before: before && { plan: before },
          after: { plan },
        });
        // Each account whose features the edit changed: its own operator entry, trail entry and event (plan §4.3).
        for (const account of onPlan) {
          const was = featuresBefore.get(account.id)!;
          const is = await features(tx, account.id);
          const change = featureChange(was, is);
          if (!change) continue;
          await trail(tx, request, requestId, {
            action: 'PLAN_CHANGE',
            accountId: account.id,
            before: { planCode: account.planCode, features: was },
            after: { planCode: account.planCode, features: is },
            account: { action: 'UPDATE', event: featuresChanged(account.id, change) },
          });
        }
        return plan;
      }),
  );

  mountPlatform(api, deps, PLATFORM_ENDPOINTS.listAccounts, async ({ requestId, query }) =>
    db.withOperator(requestId, async (tx) => {
      const records = (await platformAccounts.list(tx))
        .filter(
          (r) =>
            (query.status === undefined || r.status === query.status) &&
            (query.kind === undefined || r.kind === query.kind) &&
            matches(r, query.q),
        )
        .sort(newestFirst);
      const rest = after(records, query.cursor);
      const page = rest.slice(0, query.limit);
      return {
        items: await Promise.all(page.map((r) => accountView(tx, r))),
        nextCursor: rest.length > query.limit ? cursorOf(page[page.length - 1]!) : null,
        ...(query.count === true && { total: records.length }),
      };
    }),
  );

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.createAccount,
    async ({ request, requestId, body, now }) =>
      idempotency.run(
        {
          operatorId: signedInOf(request).operator.id,
          header: request.headers['idempotency-key'],
          path: '/accounts',
          body,
        },
        now,
        () =>
          db.withOperator(requestId, async (tx) => {
            await choosablePlan(tx, body.planCode, ['body', 'planCode']);
            const trialEndsOn = trialEndFor(body, now);
            const inviteExpiresAt = ownerInviteExpiry(now);
            const created = await platformAccounts.create(tx, {
              name: body.name,
              kind: body.kind,
              planCode: body.planCode,
              trialEndsOn,
              settings: DEFAULT_FIRM_SETTINGS,
              profile: {
                legalName: body.legalName,
                gstin: body.gstin,
                timeZone: body.timeZone,
                fyStartMonth: body.fyStartMonth,
              },
              client:
                body.kind === 'ENTERPRISE'
                  ? { name: body.clientName ?? body.name, settings: DEFAULT_CLIENT_SETTINGS }
                  : null,
              owner: body.owner,
              inviteExpiresAt,
              operatorId: signedInOf(request).operator.id,
              requestId,
            });
            const record = await requireAccount(tx, created.accountId);
            const summary = {
              name: record.name,
              kind: record.kind,
              planCode: record.planCode,
              status: record.status,
              trialEndsOn: record.trialEndsOn,
            };
            await trail(tx, request, requestId, {
              action: 'ACCOUNT_CREATE',
              accountId: record.id,
              before: null,
              after: summary,
              account: { action: 'CREATE' },
            });
            await trail(tx, request, requestId, {
              action: 'OWNER_INVITE_SEND',
              accountId: record.id,
              before: null,
              after: { inviteExpiresAt },
            });
            return accountView(tx, record);
          }),
      ),
  );

  mountPlatform(api, deps, PLATFORM_ENDPOINTS.getAccount, async ({ requestId, params }) =>
    db.withOperator(requestId, async (tx) => accountView(tx, await requireAccount(tx, params.id!))),
  );

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.updateAccount,
    async ({ request, requestId, params, body }) =>
      db.withOperator(requestId, async (tx) => {
        const record = await requireAccount(tx, params.id!);
        const change = await changeAccount(tx, record, body.version, {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.profile && { profile: { ...profileOf(record), ...body.profile } }),
        });
        await trail(tx, request, requestId, {
          action: 'ACCOUNT_UPDATE',
          accountId: record.id,
          before: { name: change.before.name, profile: change.before.profile },
          after: { name: change.after.name, profile: change.after.profile },
          account: { action: 'UPDATE' },
        });
        return accountView(tx, change.after);
      }),
  );
}
