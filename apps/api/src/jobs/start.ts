import type { Database } from '@canopy/db';
import type { Clock } from './ports.js';
import { postgresJobStore } from './postgres-store.js';
import { startJobRunner, type JobRunner, type JobRunnerOptions } from './runner.js';
import { mailConfigFromEnv, smtpMailer } from './smtp-mailer.js';

export interface JobsFromEnvOptions extends JobRunnerOptions {
  db: Database;
  /** Defaults to the system clock; tests pass a fixed one. */
  clock?: Clock;
}

/**
 * Boots the jobs for an API process: pg-boss on `connectionString`, the Postgres store and an SMTP mailer, all from
 * the environment (`SMTP_URL`, or `SMTP_HOST` with `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_SECURE`, plus
 * `MAIL_FROM` and `APP_URL`). Returns null and starts nothing when no SMTP server is configured, so sends are
 * never recorded as done without a transport. Throws on half-set mail settings.
 */
export async function startJobsFromEnv(
  env: Record<string, string | undefined>,
  options: JobsFromEnvOptions,
): Promise<JobRunner | null> {
  const mail = mailConfigFromEnv(env);
  if (!mail) return null;
  const mailer = smtpMailer(mail);
  const { db, clock, ...runnerOptions } = options;
  const runner = await startJobRunner(
    {
      store: postgresJobStore(db),
      mailer,
      clock: clock ?? (() => new Date().toISOString()),
      appUrl: mail.appUrl,
    },
    runnerOptions,
  );
  return {
    ...runner,
    stop: async () => {
      await runner.stop();
      mailer.close();
    },
  };
}
