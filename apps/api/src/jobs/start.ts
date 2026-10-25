import type { Database } from '@canopy/db';
import { s3SettingsFromEnv } from '../s3-env.js';
import { clamAvConfigFromEnv, clamAvScanner } from './clamav-scanner.js';
import type {
  Clock,
  IsoCatalogueCopier,
  JobDeps,
  LibraryCopier,
  LoginTokenIssuer,
  Mailer,
  Scanner,
} from './ports.js';
import { postgresJobStore } from './postgres-store.js';
import { startJobRunner, type JobRunner, type JobRunnerOptions } from './runner.js';
import { s3EvidenceObjects } from './s3-objects.js';
import { mailConfigFromEnv, smtpMailer } from './smtp-mailer.js';

export interface JobsFromEnvOptions extends Omit<JobRunnerOptions, 'mail'> {
  db: Database;
  /** M5's `AuthService.issueLoginToken`. Without it, sign-in link and invite emails are not sent. */
  issueLoginToken?: LoginTokenIssuer;
  /** Replaces the ClamAV scanner `CLAMAV_HOST` configures, for a host's own scanning service. */
  scanner?: Scanner;
  /** M6's `copyMasterLibrary` on the API's database. Without it, a new account's library is not copied. */
  copyLibrary?: LibraryCopier;
  /** M6's `copyIsoCatalogue` on the API's database. Without it, an account whose ISO add-on comes on is not copied. */
  copyIsoCatalogue?: IsoCatalogueCopier;
  /** Defaults to the system clock; tests pass a fixed one. */
  clock?: Clock;
}

/** Stands in when no SMTP server is set. The runner registers no job that sends, so it is never called. */
const NO_MAILER: Mailer = {
  send: () => Promise.reject(new Error('No mail transport is configured')),
};

/**
 * Boots the jobs for an API process: pg-boss on `JOBS_DATABASE_URL` (its own login; `connectionString` only when that
 * is unset, which works only for a superuser or a member of `canopy_jobs`, as in local development), the Postgres
 * store and an SMTP mailer, all from the environment (`SMTP_URL`, or `SMTP_HOST` with `SMTP_PORT`, `SMTP_USER`,
 * `SMTP_PASS` and `SMTP_SECURE`, plus `MAIL_FROM` and `APP_URL`). Without an SMTP server, instance generation and the
 * outbox relay still run and every email job is left off (the runner's `mail` is false, so the caller can warn), so
 * no send is ever recorded as done without a transport. The evidence scan runs when `CLAMAV_HOST` (or a given
 * scanner) and the `S3_*` bucket are set; otherwise the runner's `scan` is false. Throws on half-set mail or scanner
 * settings.
 */
export async function startJobsFromEnv(
  env: Record<string, string | undefined>,
  options: JobsFromEnvOptions,
): Promise<JobRunner> {
  const { db, clock, issueLoginToken, copyLibrary, copyIsoCatalogue, scanner, ...given } = options;
  // pg-boss runs as its own login, never the tenant one (ADR M9-0001 decision 16).
  const runnerOptions = {
    ...given,
    connectionString: env.JOBS_DATABASE_URL || given.connectionString,
  };
  const shared: Omit<JobDeps, 'mailer' | 'appUrl'> = {
    store: postgresJobStore(db),
    clock: clock ?? (() => new Date().toISOString()),
    ...(issueLoginToken && { issueLoginToken }),
    ...(copyLibrary && { copyLibrary }),
    ...(copyIsoCatalogue && { copyIsoCatalogue }),
    ...scanningFromEnv(env, scanner),
  };
  const mail = mailConfigFromEnv(env);
  if (!mail) {
    return startJobRunner(
      { ...shared, mailer: NO_MAILER, appUrl: '' },
      { ...runnerOptions, mail: false },
    );
  }
  const mailer = smtpMailer(mail);
  let runner: JobRunner;
  try {
    runner = await startJobRunner(
      { ...shared, mailer, appUrl: mail.appUrl },
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

/**
 * The evidence scan's scanner and storage: the given scanner or clamd at `CLAMAV_HOST`, reading from the `S3_*`
 * bucket. Neither when no scanner is set, so the scan job is left off. Throws when a scanner is set without storage.
 */
function scanningFromEnv(
  env: Record<string, string | undefined>,
  given: Scanner | undefined,
): Pick<JobDeps, 'scanner' | 'evidenceObjects'> {
  const clamAv = clamAvConfigFromEnv(env);
  const scanner = given ?? (clamAv ? clamAvScanner(clamAv) : undefined);
  if (!scanner) return {};
  const storage = s3SettingsFromEnv(env);
  if (!storage) {
    throw new Error(
      'A virus scanner is set but evidence storage is not (S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)',
    );
  }
  return { scanner, evidenceObjects: s3EvidenceObjects(storage) };
}
