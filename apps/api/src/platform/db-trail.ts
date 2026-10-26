import type { AuditAction, OperatorAuditAction } from '@canopy/contracts';
import { operatorAudit, platformAccounts, type OperatorTx } from '@canopy/db';
import type { FastifyRequest } from 'fastify';
import { featureChange, featuresChanged } from './accounts.js';
import { signedInOf } from './db-http.js';

export interface TrailEntry {
  action: OperatorAuditAction;
  accountId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason?: string | null;
  /**
   * The same change in the account's own audit trail, with actor OPERATOR (ADR M15-0001 decision 12), and the outbox
   * event it raises, if any. Left out for changes that are not the account's, such as a plan's definition.
   */
  account?: {
    action: AuditAction;
    event?: { type: string; data: Record<string, unknown> };
  };
}

/**
 * Writes an operator action to the operator audit and, for an account change, to the account's own trail, in the
 * caller's transaction. Account fields only: never a person's name or email.
 */
export async function trail(
  tx: OperatorTx,
  request: FastifyRequest,
  requestId: string,
  entry: TrailEntry,
): Promise<void> {
  const { operator } = signedInOf(request);
  const reason = entry.reason ?? null;
  await operatorAudit.append(tx, {
    operatorId: operator.id,
    action: entry.action,
    accountId: entry.accountId,
    before: entry.before,
    after: entry.after,
    reason,
    requestId,
    ip: request.ip,
  });
  if (entry.account && entry.accountId !== null) {
    await platformAccounts.recordEvent(tx, {
      accountId: entry.accountId,
      action: entry.account.action,
      before: entry.before,
      after: entry.after,
      reason,
      requestId,
      operatorId: operator.id,
      event: entry.account.event ?? null,
    });
  }
}

/** The account's effective features (plan §4.2), as `platformAccounts.entitlements` computes them. */
export async function features(tx: OperatorTx, accountId: string): Promise<string[]> {
  return (await platformAccounts.entitlements(tx, accountId)).features;
}

/**
 * When the account's features changed, an entry in its own trail that raises `account.features_changed`, for a change
 * whose own entry already carries another event (a plan change raises `account.plan_changed`). Nothing otherwise.
 */
export async function recordFeatureChange(
  tx: OperatorTx,
  request: FastifyRequest,
  requestId: string,
  accountId: string,
  before: string[],
  after: string[],
  reason: string | null,
): Promise<void> {
  const change = featureChange(before, after);
  if (!change) return;
  await platformAccounts.recordEvent(tx, {
    accountId,
    action: 'UPDATE',
    before: { features: before },
    after: { features: after },
    reason,
    requestId,
    operatorId: signedInOf(request).operator.id,
    event: featuresChanged(accountId, change),
  });
}
