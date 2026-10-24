import { PLATFORM_ENDPOINTS } from '@canopy/contracts';
import { operatorAudit, plans, subscriptions, usageSnapshots } from '@canopy/db';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../auth/index.js';
import { operatorToday } from './accounts.js';
import { requireAccount } from './db-accounts.js';
import { mountPlatform, signedInOf, type PlatformDeps } from './db-http.js';
import { trail } from './db-trail.js';
import type { OperatorIdempotency } from './idempotency.js';

/**
 * Offline billing, usage history, renewals and the operator audit (ADR M15-0001 decisions 6, 7, 12). Amounts are in
 * paise; prices are never stored on plans.
 */
export function registerBillingRoutes(
  api: FastifyInstance,
  deps: PlatformDeps,
  idempotency: OperatorIdempotency,
): void {
  const { db } = deps;

  mountPlatform(api, deps, PLATFORM_ENDPOINTS.listSubscriptions, async ({ requestId, params }) =>
    db.withOperator(requestId, async (tx) => {
      await requireAccount(tx, params.id!);
      return { items: await subscriptions.list(tx, params.id!) };
    }),
  );

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.recordSubscription,
    async ({ request, requestId, params, body, now }) => {
      const operatorId = signedInOf(request).operator.id;
      return idempotency.run(
        {
          operatorId,
          header: request.headers['idempotency-key'],
          path: `/accounts/${params.id}/subscriptions`,
          body,
        },
        now,
        () =>
          db.withOperator(requestId, async (tx) => {
            const record = await requireAccount(tx, params.id!);
            // A billing period may name a retired plan: the account may still be on it.
            if (!(await plans.get(tx, body.planCode))) {
              throw new ApiError('VALIDATION', {
                issues: [{ path: ['body', 'planCode'], message: 'No plan with this code' }],
              });
            }
            const subscription = await subscriptions.record(tx, {
              ...body,
              accountId: record.id,
              recordedById: operatorId,
            });
            await trail(tx, request, requestId, {
              action: 'SUBSCRIPTION_RECORD',
              accountId: record.id,
              before: null,
              after: {
                subscriptionId: subscription.id,
                planCode: subscription.planCode,
                startsOn: subscription.startsOn,
                endsOn: subscription.endsOn,
                amountPaise: subscription.amountPaise,
              },
            });
            return subscription;
          }),
      );
    },
  );

  mountPlatform(api, deps, PLATFORM_ENDPOINTS.listUsage, async ({ requestId, params, query }) =>
    db.withOperator(requestId, async (tx) => {
      await requireAccount(tx, params.id!);
      return { items: await usageSnapshots.list(tx, params.id!, query.from, query.to) };
    }),
  );

  mountPlatform(api, deps, PLATFORM_ENDPOINTS.listRenewals, async ({ requestId, query, now }) => ({
    items: await db.withOperator(requestId, (tx) =>
      subscriptions.renewals(tx, operatorToday(now), query.withinDays),
    ),
  }));

  mountPlatform(api, deps, PLATFORM_ENDPOINTS.listOperatorAudit, async ({ requestId, query }) =>
    db.withOperator(requestId, (tx) =>
      operatorAudit.query(tx, {
        ...(query.accountId && { accountId: query.accountId }),
        ...(query.action && { action: query.action }),
        ...(query.from && { from: query.from }),
        ...(query.to && { to: query.to }),
        limit: query.limit,
        cursor: query.cursor ?? null,
      }),
    ),
  );
}
