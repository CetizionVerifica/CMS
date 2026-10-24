import type { Id, LocalDate } from '@canopy/contracts';
import { daysBetween, localDateIn } from '@canopy/engine';
import type { JobDeps, JobReport } from './ports.js';
import { deliver } from './send.js';
import { accountUrl } from './trial-reminders.js';

export const RENEWAL_REMINDERS = 'renewal-reminders';

/** Days before the latest subscription's last day on which an ACTIVE account's admins hear it ends (ADR M9-0004). */
export const RENEWAL_REMINDER_DAYS: readonly number[] = [30, 7];

/** The reminder's day: India time, like the trial reminders and the schedule (ADR M9-0004). */
const RENEWAL_TIME_ZONE = 'Asia/Kolkata';

/**
 * Daily, mid-morning India time: each ACTIVE account whose latest paid subscription ends in 30 or 7 days emails
 * each of its admins (ADR M9-0004). Like the trial reminder, the send is about the account, so its send-log row
 * names neither a client nor an instance and goes once per admin and day. A trial, a paused or closing account, and
 * an account with no subscription get nothing. Each account is its own transaction; the job fails afterwards when
 * any did, so pg-boss retries, and a retry sends nothing twice.
 */
export async function runRenewalReminders(deps: JobDeps, requestId: string): Promise<JobReport> {
  const report: JobReport = { firms: 0, admins: 0 };
  const now = deps.clock();
  const today = localDateIn(now, RENEWAL_TIME_ZONE);
  const failures: unknown[] = [];
  for (const firmId of await deps.store.listFirmIds()) {
    try {
      await remindAccount(deps, firmId, requestId, now, today, report);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${RENEWAL_REMINDERS}: ${failures.length} account(s) failed`,
    );
  }
  return report;
}

async function remindAccount(
  deps: JobDeps,
  firmId: Id,
  requestId: string,
  now: string,
  today: LocalDate,
  report: JobReport,
): Promise<void> {
  const found = await deps.store.withFirm(firmId, requestId, async (tx) => {
    if ((await tx.accountStatus()) !== 'ACTIVE') return null;
    const endsOn = await tx.subscriptionEndsOn();
    if (endsOn === null) return null;
    const daysLeft = daysBetween(today, endsOn);
    if (!RENEWAL_REMINDER_DAYS.includes(daysLeft)) return null;
    const { name } = await tx.accountTrial();
    return { name, endsOn, daysLeft, admins: await tx.listAccountAdmins(now) };
  });
  if (!found) return;
  report.firms! += 1;
  for (const admin of found.admins) {
    report.admins! += 1;
    await deliver(
      deps,
      firmId,
      requestId,
      {
        clientId: null,
        instanceId: null,
        recipientId: admin.personId,
        kind: 'RENEWAL_DUE',
        sendDate: today,
      },
      { name: admin.displayName, email: admin.email, canReceive: admin.canReceive },
      {
        kind: 'RENEWAL_DUE',
        recipientName: admin.displayName,
        accountName: found.name,
        endsOn: found.endsOn,
        daysLeft: found.daysLeft,
        url: accountUrl(deps.appUrl),
      },
      RENEWAL_REMINDERS,
      report,
    );
  }
}
