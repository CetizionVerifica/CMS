import { platformAccounts, type OperatorDatabase } from '@canopy/db';
import type { JobDefinition, JobReport } from '../jobs/index.js';
import { accountPrefixes, type AccountObjects } from './purge-objects.js';

export const ACCOUNT_PURGE = 'account-purge';

export interface AccountPurgeDeps {
  /** The console's own login (`OPERATOR_DATABASE_URL`): only `canopy_operator` may call the purge. */
  db: OperatorDatabase;
  objects: AccountObjects;
}

/**
 * Purges every account whose 30-day grace period has ended (ADR M15-0002 decision 5): first its files, prefix by
 * prefix, then its rows through `platform_purge_account`, which writes ACCOUNT_PURGE. Both steps are idempotent, so a
 * run that fails between them deletes nothing twice and finishes the next night. The database's clock decides which
 * accounts are due, as it does in the purge itself, so no account loses its files and keeps its rows. Counts only,
 * never keys or names.
 */
export async function runAccountPurge(
  deps: AccountPurgeDeps,
  requestId: string,
): Promise<JobReport> {
  const due = await deps.db.withOperator(requestId, (tx) => platformAccounts.dueForPurge(tx));
  const report: JobReport = { due: due.length, purged: 0, objects: 0, rows: 0 };
  for (const accountId of due) {
    for (const prefix of accountPrefixes(accountId)) {
      report.objects! += await deps.objects.deletePrefix(prefix);
    }
    const counts = await deps.db.withOperator(requestId, (tx) =>
      platformAccounts.purge(tx, accountId),
    );
    // Zero rows when another instance purged it first: the call then only sweeps the tombstone again.
    report.purged! += 1;
    report.rows! += Object.values(counts).reduce((sum, n) => sum + n, 0);
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
