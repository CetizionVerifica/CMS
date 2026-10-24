import { createDatabase, type Database } from '@canopy/db';
import { inferRule } from '@canopy/engine';
import { startJobsFromEnv, type JobRunner, type JobRunnerOptions } from './jobs/index.js';
import { PostgresReportsStore } from './modules/dashboard/db-store.js';
import { PostgresStore } from './modules/entities/service.js';
import { repositoryStore, s3ImportFilesFromEnv } from './modules/imports/index.js';
import { S3ExportFiles } from './modules/reports/files.js';
import type { ServerOptions } from './server.js';

/** Where a failed background import parse is reported: counts and ids only, never row data. */
export type ImportErrorLog = (info: { batchId: string; error: string }, message: string) => void;

export interface Wiring {
  readonly options: ServerOptions;
  /** The database the options use, if any; main.ts closes it on shutdown. */
  readonly database?: Database;
}

/**
 * The server options for the environment. With DATABASE_URL, the modules that read and write the database are
 * mounted: M6 (library and entities), M7 (instances), M10 (dashboards and reports on the Postgres store) and, when
 * object storage is configured too (S3_*), M8 (imports) and M10's export files. Without it (the e2e web server, a
 * UI-only dev run) they stay unmounted, and M10 keeps its empty default store. Sign-in (registerAuth) runs before
 * every route.
 */
export function wiringFromEnv(env: NodeJS.ProcessEnv, logImportError: ImportErrorLog): Wiring {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) return { options: {} };
  const database = createDatabase({ connectionString });
  const importFiles = s3ImportFilesFromEnv(env);
  const exportFiles = s3ExportFilesFromEnv(env);
  return {
    database,
    options: {
      database,
      libraryAndEntities: { store: new PostgresStore(database) },
      reports: {
        store: new PostgresReportsStore(database),
        // Without object storage, finished exports stay in the process (server.ts's default).
        ...(exportFiles && { files: exportFiles }),
      },
      ...(importFiles && {
        imports: {
          store: repositoryStore(database),
          files: importFiles,
          inferRule,
          // The batch id and error class only: a parse error can quote cell values from the register.
          onBackgroundError: (error, batchId) =>
            logImportError(
              { batchId, error: error instanceof Error ? error.name : 'unknown' },
              'import parse failed',
            ),
        },
      }),
    },
  };
}

/** M10's export files in the same S3 bucket as imports (keys under `exports/`, imports under `imports/`). */
function s3ExportFilesFromEnv(env: NodeJS.ProcessEnv): S3ExportFiles | null {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null;
  return new S3ExportFiles({
    bucket: S3_BUCKET,
    region: S3_REGION ?? 'ap-south-1',
    ...(S3_ENDPOINT && { endpoint: S3_ENDPOINT }),
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  });
}

export interface JobsWiring {
  /** Told why the jobs did not start; main.ts passes the server logger's warn. */
  readonly warn: (message: string) => void;
  /** Per-run job lines (counts only). */
  readonly log?: JobRunnerOptions['log'];
  /** Tests replace the M9 boot. */
  readonly start?: typeof startJobsFromEnv;
}

/**
 * Starts the M9 jobs on the API's database: instance generation and the outbox relay always, and reminders, digests
 * and workflow emails when the environment configures mail. Without a database nothing starts and nothing is said,
 * as for the modules above; with one but no SMTP server it warns, because reminders and approval emails would
 * silently never go out. Half-set mail settings throw, so a deploy fails at boot rather than running without mail.
 */
export async function jobsFromEnv(
  env: NodeJS.ProcessEnv,
  database: Database | undefined,
  { warn, log, start = startJobsFromEnv }: JobsWiring,
): Promise<JobRunner | null> {
  const connectionString = env.DATABASE_URL;
  if (!database || !connectionString) return null;
  const jobs = await start(env, { db: database, connectionString, ...(log && { log }) });
  if (!jobs.mail)
    warn(
      'email jobs not started: no SMTP server configured (set SMTP_URL or SMTP_HOST, MAIL_FROM and APP_URL); instance generation still runs',
    );
  return jobs;
}
