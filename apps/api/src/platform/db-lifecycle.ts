import { canMoveAccount, PLATFORM_ENDPOINTS, type AccountStatus } from '@canopy/contracts';
import { accountOverrides, ownerInvites, type AccountRecord } from '@canopy/db';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../auth/index.js';
import { operatorToday, ownerInviteExpiry, statusMove } from './accounts.js';
import { accountView, changeAccount, choosablePlan, requireAccount } from './db-accounts.js';
import { mountPlatform, signedInOf, type PlatformDeps } from './db-http.js';
import { trail } from './db-trail.js';

function refuseMove(from: AccountStatus, to: AccountStatus): never {
  throw new ApiError('INVALID_TRANSITION', { from, to });
}

const statusChanged = (record: AccountRecord, to: AccountStatus) => ({
  type: 'account.status_changed',
  data: { accountId: record.id, from: record.status, to },
});

/**
 * The account's life after provisioning: status moves, trial end, plan, overrides, the owner's invite, onboarding
 * and deletion (ADR M15-0001 decisions 4-7, ADR M15-0002). Each change checks the account's version, and writes the
 * operator audit, the account's own trail and its outbox event in one transaction.
 */
export function registerLifecycleRoutes(api: FastifyInstance, deps: PlatformDeps): void {
  const { db } = deps;

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.setAccountStatus,
    async ({ request, requestId, params, body }) =>
      db.withOperator(requestId, async (tx) => {
        const record = await requireAccount(tx, params.id!);
        const action = statusMove(record.status, body.to);
        const reason = body.reason;
        // An ACTIVE account has no trial end; a suspended one keeps it, so resuming a trial says when it ran out.
        const { before, after } = await changeAccount(tx, record, body.version, {
          status: body.to,
          ...(body.to === 'ACTIVE' && { trialEndsOn: null }),
        });
        await trail(tx, request, requestId, {
          action,
          accountId: record.id,
          before: { status: before.status, trialEndsOn: before.trialEndsOn },
          after: { status: after.status, trialEndsOn: after.trialEndsOn },
          reason,
          account: { action: 'TRANSITION', event: statusChanged(record, body.to) },
        });
        return accountView(tx, after);
      }),
  );

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.extendTrial,
    async ({ request, requestId, params, body, now }) =>
      db.withOperator(requestId, async (tx) => {
        const record = await requireAccount(tx, params.id!);
        if (record.status !== 'TRIAL') refuseMove(record.status, 'TRIAL');
        const today = operatorToday(now);
        if (body.trialEndsOn < today) {
          throw new ApiError('VALIDATION', {
            issues: [{ path: ['body', 'trialEndsOn'], message: `Must not be before ${today}` }],
          });
        }
        const { before, after } = await changeAccount(tx, record, body.version, {
          trialEndsOn: body.trialEndsOn,
        });
        await trail(tx, request, requestId, {
          action: 'TRIAL_EXTEND',
          accountId: record.id,
          before: { trialEndsOn: before.trialEndsOn },
          after: { trialEndsOn: after.trialEndsOn },
          reason: body.reason?.trim() || null,
          account: { action: 'UPDATE' },
        });
        return accountView(tx, after);
      }),
  );

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.setAccountPlan,
    async ({ request, requestId, params, body }) =>
      db.withOperator(requestId, async (tx) => {
        const record = await requireAccount(tx, params.id!);
        const reason = body.reason;
        if (body.planCode === record.planCode) {
          throw new ApiError('VALIDATION', {
            issues: [
              { path: ['body', 'planCode'], message: 'The account is on this plan already' },
            ],
          });
        }
        await choosablePlan(tx, body.planCode, ['body', 'planCode']);
        const { before, after } = await changeAccount(tx, record, body.version, {
          planCode: body.planCode,
        });
        await trail(tx, request, requestId, {
          action: 'PLAN_CHANGE',
          accountId: record.id,
          before: { planCode: before.planCode },
          after: { planCode: after.planCode },
          reason,
          account: {
            action: 'UPDATE',
            event: {
              type: 'account.plan_changed',
              data: { accountId: record.id, from: before.planCode, to: after.planCode },
            },
          },
        });
        return accountView(tx, after);
      }),
  );

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.setAccountOverride,
    async ({ request, requestId, params, body }) =>
      db.withOperator(requestId, async (tx) => {
        const record = await requireAccount(tx, params.id!);
        const reason = body.reason;
        // The override's version is the account's (ADR M3-0003 decision 2).
        const { after } = await changeAccount(tx, record, body.version, {});
        const override = await accountOverrides.put(tx, record.id, body.override);
        await trail(tx, request, requestId, {
          action: 'OVERRIDE_CHANGE',
          accountId: record.id,
          before: override.before && { override: override.before },
          after: { override: override.after },
          reason,
          account: { action: 'UPDATE' },
        });
        return accountView(tx, after);
      }),
  );

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.resendOwnerInvite,
    async ({ request, requestId, params, now }) => {
      await db.withOperator(requestId, async (tx) => {
        const record = await requireAccount(tx, params.id!);
        if (record.status !== 'PROVISIONING') {
          throw new ApiError('VALIDATION', {
            issues: [{ path: ['id'], message: 'The owner has accepted already' }],
          });
        }
        const inviteExpiresAt = ownerInviteExpiry(now);
        await ownerInvites.resend(tx, {
          accountId: record.id,
          expiresAt: inviteExpiresAt,
          operatorId: signedInOf(request).operator.id,
          requestId,
        });
        await trail(tx, request, requestId, {
          action: 'OWNER_INVITE_SEND',
          accountId: record.id,
          before: null,
          after: { inviteExpiresAt },
        });
      });
      return undefined;
    },
  );

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.markOnboarded,
    async ({ request, requestId, params, body, now }) =>
      db.withOperator(requestId, async (tx) => {
        const record = await requireAccount(tx, params.id!);
        // Recorded once; a repeat answers with the account as it is.
        if (record.onboardedAt !== null) {
          if (record.version !== body.version) {
            throw new ApiError('STALE_VERSION', { currentVersion: record.version });
          }
          return accountView(tx, record);
        }
        const { after } = await changeAccount(tx, record, body.version, {
          onboardedAt: now.toISOString(),
        });
        await trail(tx, request, requestId, {
          action: 'ACCOUNT_UPDATE',
          accountId: record.id,
          before: { onboardedAt: null },
          after: { onboardedAt: after.onboardedAt },
          account: { action: 'UPDATE' },
        });
        return accountView(tx, after);
      }),
  );

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.requestAccountDeletion,
    async ({ request, requestId, params, body }) =>
      db.withOperator(requestId, async (tx) => {
        const record = await requireAccount(tx, params.id!);
        const reason = body.reason;
        if (body.confirmName !== record.name) {
          throw new ApiError('VALIDATION', {
            issues: [{ path: ['body', 'confirmName'], message: 'Type the account name exactly' }],
          });
        }
        if (!canMoveAccount(record.status, 'PENDING_DELETION')) {
          refuseMove(record.status, 'PENDING_DELETION');
        }
        // The database stamps deletion_requested_at itself: the grace period is its clock (ADR M15-0002).
        const { before, after } = await changeAccount(tx, record, body.version, {
          status: 'PENDING_DELETION',
          statusBeforeDeletion: record.status,
        });
        await trail(tx, request, requestId, {
          action: 'ACCOUNT_DELETE_REQUEST',
          accountId: record.id,
          before: { status: before.status },
          after: { status: after.status, deletionRequestedAt: after.deletionRequestedAt },
          reason,
          account: { action: 'TRANSITION', event: statusChanged(record, 'PENDING_DELETION') },
        });
        return accountView(tx, after);
      }),
  );

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.cancelAccountDeletion,
    async ({ request, requestId, params, body }) =>
      db.withOperator(requestId, async (tx) => {
        const record = await requireAccount(tx, params.id!);
        const reason = body.reason;
        const to = record.statusBeforeDeletion ?? 'SUSPENDED';
        if (record.status !== 'PENDING_DELETION' || !canMoveAccount(record.status, to)) {
          refuseMove(record.status, to);
        }
        const { before, after } = await changeAccount(tx, record, body.version, {
          status: to,
          statusBeforeDeletion: null,
          deletionRequestedAt: null,
        });
        await trail(tx, request, requestId, {
          action: 'ACCOUNT_DELETE_CANCEL',
          accountId: record.id,
          before: { status: before.status, deletionRequestedAt: before.deletionRequestedAt },
          after: { status: after.status },
          reason,
          account: { action: 'TRANSITION', event: statusChanged(record, to) },
        });
        return accountView(tx, after);
      }),
  );
}
