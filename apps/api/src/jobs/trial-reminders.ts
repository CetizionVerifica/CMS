import type { Id, LocalDate } from '@canopy/contracts';
import { daysBetween, localDateIn } from '@canopy/engine';
import type { JobDeps, JobReport } from './ports.js';
import { deliver } from './send.js';

export const TRIAL_REMINDERS = 'trial-reminders';

/** Days before the trial's last day on which its admins hear it is ending (ADR M9-0003). */
export const TRIAL_REMINDER_DAYS: readonly number[] = [7, 1];

/** The reminder's day: India time, like the job that ends the trial and the schedule (ADR M9-0003). */
const TRIAL_TIME_ZONE = 'Asia/Kolkata';

export function accountUrl(appUrl: string): string {
  return new URL('/account', appUrl).toString();
}

/**
 * Daily, mid-morning India time: each account in TRIAL whose last day is 7 days or 1 day away emails each of its
 * admins. The send is about the account, not a client, so its send-log row names neither a client nor an instance,
 * and it goes once per admin and day (`ACCOUNT_NOTIFICATION_KINDS`). A missed run is caught up once the same day;
 * a whole missed day skips that day's reminder rather than sending it late with the wrong count. Each account is
 * its own transaction, so one failure does not stop the others; the job still fails afterwards so pg-boss retries.
 */
export async function runTrialReminders(deps: JobDeps, requestId: string): Promise<JobReport> {
  const report: JobReport = { firms: 0, admins: 0 };
  const now = deps.clock();
  const today = localDateIn(now, TRIAL_TIME_ZONE);
  const failures: unknown[] = [];
  for (const firmId of await deps.store.listFirmIds()) {
    try {
      await remindAccount(deps, firmId, requestId, now, today, report);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${TRIAL_REMINDERS}: ${failures.length} account(s) failed`);
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
    if ((await tx.accountStatus()) !== 'TRIAL') return null;
    const trial = await tx.accountTrial();
    if (trial.trialEndsOn === null) return null;
    const daysLeft = daysBetween(today, trial.trialEndsOn);
    if (!TRIAL_REMINDER_DAYS.includes(daysLeft)) return null;
    const admins = await tx.listAccountAdmins(now);
    return { name: trial.name, trialEndsOn: trial.trialEndsOn, daysLeft, admins };
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
        kind: 'TRIAL_ENDING',
        sendDate: today,
      },
      { name: admin.displayName, email: admin.email, canReceive: admin.canReceive },
      {
        kind: 'TRIAL_ENDING',
        recipientName: admin.displayName,
        accountName: found.name,
        trialEndsOn: found.trialEndsOn,
        daysLeft: found.daysLeft,
        url: accountUrl(deps.appUrl),
      },
      TRIAL_REMINDERS,
      report,
    );
  }
}
