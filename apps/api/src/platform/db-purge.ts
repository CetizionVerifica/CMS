import { platformAccounts, type OperatorDatabase } from '@canopy/db';
import type { JobDefinition, JobReport } from '../jobs/index.js';
import { lockDeletion, recentlyDeleted } from './db-deletion.js';
import { accountPrefixes, type AccountObjects } from './purge-objects.js';

export const ACCOUNT_PURGE = 'account-purge';

export interface AccountPurgeDeps {
  /** The console's own login (`OPERATOR_DATABASE_URL`): only `canopy_operator` may call the purge. */
  db: OperatorDatabase;
  objects: AccountObjects;
}

/**
 * Purges every account whose 30-day grace period has ended (ADR M15-0002 decision 5): first its files, prefix by
 * prefix, then its rows through `platform_purge_account`, which writes ACCOUNT_PURGE. Each account is done in one
 * transaction that holds its row lock (`lockDeletion`) throughout, after checking again that it is still due, so an
 * operator's cancel cannot slip in between the files and the rows: it waits, then finds the account DELETED. The
 * database's clock decides, as it does in the purge and the cancel. A storage failure rolls the account back to
 * PENDING_DELETION with whatever files are left, and the next night finishes.
 *
 * Accounts purged in the last 7 days are swept again, files and rows: a write that committed after the purge's
 * snapshot, or an upload that landed after its prefix was emptied, is removed then. Counts only, never keys or names.
 */
export async function runAccountPurge(
  deps: AccountPurgeDeps,
  requestId: string,
): Promise<JobReport> {
  const { due, swept } = await deps.db.withOperator(requestId, async (tx) => ({
    due: await platformAccounts.dueForPurge(tx),
    swept: await recentlyDeleted(tx),
  }));
  const report: JobReport = {
    due: due.length,
    purged: 0,
    notDue: 0,
    swept: swept.length,
    objects: 0,
    rows: 0,
  };
  const removeFiles = async (accountId: string) => {
    for (const prefix of accountPrefixes(accountId)) {
      report.objects! += await deps.objects.deletePrefix(prefix);
    }
  };
  const total = (counts: Record<string, number>) =>
    Object.values(counts).reduce((sum, n) => sum + n, 0);

  for (const accountId of due) {
    await deps.db.withOperator(requestId, async (tx) => {
      const state = await lockDeletion(tx, accountId);
      // Cancelled, or purged by another instance, since the list was read.
      if (state?.status !== 'PENDING_DELETION' || !state.graceOver) {
        report.notDue! += 1;
        return;
      }
      await removeFiles(accountId);
      report.rows! += total(await platformAccounts.purge(tx, accountId));
      report.purged! += 1;
    });
  }
  for (const accountId of swept) {
    await removeFiles(accountId);
    report.rows! += total(
      await deps.db.withOperator(requestId, (tx) => platformAccounts.purge(tx, accountId)),
    );
  }
  return report;
}

/**
 * The purge as one of M9's scheduled jobs, nightly at 02:00 India time, after the account job (00:30) and instance
 * generation (01:00). It catches up once after downtime. M9's runner gets it from the server's wiring only when the
 * operator API is enabled and object storage is configured: without storage the files would outlive their rows.
 */
export function accountPurgeJob(db: OperatorDatabase, objects: AccountObjects): JobDefinition {
  return {
    name: ACCOUNT_PURGE,
    cron: '0 2 * * *',
    tz: 'Asia/Kolkata',
    sendsMail: false,
    catchUp: true,
    run: (_deps, requestId) => runAccountPurge({ db, objects }, requestId),
  };
}
