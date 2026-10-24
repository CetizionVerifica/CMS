import type { AccountStatus, Id } from '@canopy/contracts';
import { localDateIn } from '@canopy/engine';
import type { JobDeps, JobReport } from './ports.js';

export const ACCOUNT_DAILY = 'account-daily';

/** The usage snapshot's day: India time, like the job's schedule. */
const SNAPSHOT_TIME_ZONE = 'Asia/Kolkata';

/** Accounts whose users the jobs work for: instances, reminders and digests (ADR M15-0001 decision 4). */
const SERVED: readonly AccountStatus[] = ['TRIAL', 'ACTIVE'];

/** Accounts with usage worth recording: everything opened and not yet purged. */
const COUNTED: readonly AccountStatus[] = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'PENDING_DELETION'];

/**
 * The firms in TRIAL or ACTIVE. Each status is read in the firm's own transaction, since `listFirmIds` returns ids
 * only. A suspended, closing or deleted account, and one still being set up, gets no instances, reminders or digests.
 */
export async function servedFirmIds(deps: JobDeps, requestId: string): Promise<Id[]> {
  const served: Id[] = [];
  for (const firmId of await deps.store.listFirmIds()) {
    const status = await deps.store.withFirm(firmId, requestId, (tx) => tx.accountStatus());
    if (SERVED.includes(status)) served.push(firmId);
  }
  return served;
}

/**
 * Nightly, before generation: ends each trial whose last day has passed (the account becomes SUSPENDED, so the
 * generation that follows skips it), then records each opened account's usage for the operator console. Each
 * account is one transaction, so one failure does not undo the others; the job still fails afterwards so pg-boss
 * retries it. Re-running it the same day changes nothing new.
 */
export async function runAccountDaily(deps: JobDeps, requestId: string): Promise<JobReport> {
  const report: JobReport = { firms: 0, trialsEnded: 0, snapshots: 0 };
  const now = deps.clock();
  const today = localDateIn(now, SNAPSHOT_TIME_ZONE);
  const failures: unknown[] = [];
  for (const firmId of await deps.store.listFirmIds()) {
    report.firms! += 1;
    try {
      await deps.store.withFirm(firmId, requestId, async (tx) => {
        const status = await tx.accountStatus();
        if (status === 'TRIAL' && (await tx.endTrial(now, ACCOUNT_DAILY))) report.trialsEnded! += 1;
        if (COUNTED.includes(status)) {
          await tx.takeUsageSnapshot(today);
          report.snapshots! += 1;
        }
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${ACCOUNT_DAILY}: ${failures.length} account(s) failed`);
  }
  return report;
}
