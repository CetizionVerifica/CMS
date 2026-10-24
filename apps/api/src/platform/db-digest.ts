import { operators, subscriptions, type OperatorDatabase } from '@canopy/db';
import type { JobDefinition, JobReport, Mailer } from '../jobs/index.js';
import { operatorToday } from './accounts.js';
import { OPERATOR_DIGEST_DAYS, renderOperatorDigest } from './operator-digest.js';

export const OPERATOR_DIGEST = 'operator-digest';

export interface OperatorDigestDeps {
  /** The console's own login (`OPERATOR_DATABASE_URL`): renewals and the operators live in the platform schema. */
  db: OperatorDatabase;
  mailer: Mailer;
  /** The current instant as an ISO UTC string, as the jobs' clock gives it. */
  clock: () => string;
}

/**
 * Emails every enabled operator the accounts whose trial or latest subscription ends in the next 14 days (ADR
 * M15-0005). Nothing is sent on a day with none. One read, then one email per operator; a transport failure fails
 * the run, so the job's retry may send that day's digest to an operator twice, never a customer anything.
 */
export async function runOperatorDigest(
  deps: OperatorDigestDeps,
  requestId: string,
): Promise<JobReport> {
  const today = operatorToday(new Date(deps.clock()));
  const { due, recipients } = await deps.db.withOperator(requestId, async (tx) => ({
    due: await subscriptions.renewals(tx, today, OPERATOR_DIGEST_DAYS),
    recipients: (await operators.list(tx)).filter((o) => o.disabledAt === null),
  }));
  const report: JobReport = { due: due.length, operators: recipients.length, sent: 0 };
  if (due.length === 0) return report;
  for (const operator of recipients) {
    await deps.mailer.send({
      ...renderOperatorDigest(operator.displayName, today, due),
      to: { name: operator.displayName, email: operator.email },
      idempotencyKey: `${OPERATOR_DIGEST}:${operator.id}:${today}`,
    });
    report.sent! += 1;
  }
  return report;
}

/**
 * The digest as one of M9's scheduled jobs, daily at 09:30 India time. pg-boss runs each slot once across API
 * instances; the job sends mail, so it runs only with a mailer. M9's runner gets it from the server's wiring only
 * when the operator API is enabled.
 */
export function operatorDigestJob(db: OperatorDatabase): JobDefinition {
  return {
    name: OPERATOR_DIGEST,
    cron: '30 9 * * *',
    tz: 'Asia/Kolkata',
    sendsMail: true,
    run: (deps, requestId) =>
      runOperatorDigest({ db, mailer: deps.mailer, clock: deps.clock }, requestId),
  };
}
