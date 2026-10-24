import { Id } from '@canopy/contracts';
import { z } from 'zod';
import type { Consumer } from './consumers.js';
import type { JobDeps, LibraryCopier, OutboxEvent } from './ports.js';

const AccountCreatedData = z.object({ accountId: Id });

function copier(deps: JobDeps): LibraryCopier {
  if (!deps.copyLibrary) throw new Error('A new account needs copyLibrary');
  return deps.copyLibrary;
}

/**
 * Copies the master library into a new account on `account.created` (ADR M15-0001 decision 8). The event lives in
 * the new account's own outbox, so its `firmId` is the account; one naming another account is refused rather than
 * copied anywhere. M6's copier records the copy once, so a repeated delivery copies nothing.
 */
async function copyNewAccountLibrary(deps: JobDeps, event: OutboxEvent, requestId: string) {
  const { accountId } = AccountCreatedData.parse(event.data);
  if (accountId !== event.firmId) {
    throw new Error('account.created names another account than the one whose outbox it is in');
  }
  const { copied, categories, acts, obligations } = await copier(deps)(accountId, requestId);
  return { copied: copied ? 1 : 0, categories, acts, obligations };
}

export const ACCOUNT_CONSUMERS: readonly Consumer[] = [
  // Always registered: without the copier the delivery throws and pg-boss retries it, so no event is dropped.
  { type: 'account.created', handle: copyNewAccountLibrary },
];
