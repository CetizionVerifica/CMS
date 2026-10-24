import type { Database } from '@canopy/db';
import type { Clock, LoginTokenIssuer, Mailer } from './ports.js';
import { postgresJobStore } from './postgres-store.js';
import { startJobRunner, type JobRunner, type JobRunnerOptions } from './runner.js';
import { mailConfigFromEnv, smtpMailer } from './smtp-mailer.js';

export interface JobsFromEnvOptions extends Omit<JobRunnerOptions, 'mail'> {
  db: Database;
  /** M5's `AuthService.issueLoginToken`. Without it, sign-in link and invite emails are not sent. */
  issueLoginToken?: LoginTokenIssuer;
  /** Defaults to the system clock; tests pass a fixed one. */
  clock?: Clock;
}

/** Stands in when no SMTP server is set. The runner registers no job that sends, so it is never called. */
const NO_MAILER: Mailer = {
  send: () => Promise.reject(new Error('No mail transport is configured')),
};

/**
 * Boots the jobs for an API process: pg-boss on `connectionString`, the Postgres store and an SMTP mailer, all from
 * the environment (`SMTP_URL`, or `SMTP_HOST` with `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_SECURE`, plus
 * `MAIL_FROM` and `APP_URL`). Without an SMTP server, instance generation and the outbox relay still run and every
 * email job is left off (the runner's `mail` is false, so the caller can warn), so no send is ever recorded as done
 * without a transport. Throws on half-set mail settings.
 */
export async function startJobsFromEnv(
  env: Record<string, string | undefined>,
  options: JobsFromEnvOptions,
): Promise<JobRunner> {
  const { db, clock, issueLoginToken, ...runnerOptions } = options;
  const store = postgresJobStore(db);
  const now = clock ?? (() => new Date().toISOString());
  const mail = mailConfigFromEnv(env);
  if (!mail) {
    return startJobRunner(
      {
        store,
        mailer: NO_MAILER,
        clock: now,
        appUrl: '',
        ...(issueLoginToken && { issueLoginToken }),
      },
      { ...runnerOptions, mail: false },
    );
  }
  const mailer = smtpMailer(mail);
  let runner: JobRunner;
  try {
    runner = await startJobRunner(
      {
        store,
        mailer,
        clock: now,
        appUrl: mail.appUrl,
        ...(issueLoginToken && { issueLoginToken }),
      },
      { ...runnerOptions, mail: true },
    );
  } catch (error) {
    mailer.close();
    throw error;
  }
  return {
    ...runner,
    stop: async () => {
      await runner.stop();
      mailer.close();
    },
  };
}
