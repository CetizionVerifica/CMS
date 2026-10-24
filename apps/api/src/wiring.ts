import {
  createDatabase,
  createOperatorDatabase,
  type Database,
  type OperatorDatabase,
} from '@canopy/db';
import { inferRule } from '@canopy/engine';
import { AuthService, SecretBox, createDbAccountStore } from './auth/index.js';
import { startJobsFromEnv, type JobRunner, type JobRunnerOptions } from './jobs/index.js';
import { PostgresReportsStore } from './modules/dashboard/db-store.js';
import { createS3Storage } from './modules/evidence/storage.js';
import { PostgresStore } from './modules/entities/service.js';
import { copyMasterLibrary } from './modules/library/db-library-copy.js';
import { repositoryStore, s3ImportFilesFromEnv } from './modules/imports/index.js';
import { S3ExportFiles } from './modules/reports/files.js';
import { ipAllowlistFromEnv, type PlatformOptions } from './platform/index.js';
import { s3SettingsFromEnv } from './s3-env.js';
import type { ServerOptions } from './server.js';

/** Where a failed background import parse is reported: counts and ids only, never row data. */
export type ImportErrorLog = (info: { batchId: string; error: string }, message: string) => void;

export interface Wiring {
  readonly options: ServerOptions;
  /** The database the options use, if any; main.ts closes it on shutdown. */
  readonly database?: Database;
  /** M5's sign-in service on the same account store, for M9's sign-in link and invite emails (`issueLoginToken`). */
  readonly auth?: AuthService;
  /** The operator console's own database login, when the operator API is on; main.ts closes it on shutdown. */
  readonly operatorDatabase?: OperatorDatabase;
}

/**
 * M15's operator API (ADR M15-0001 decision 9). `PLATFORM_ENABLED=true` mounts it under /api/platform/v1 on its own
 * database login, `OPERATOR_DATABASE_URL`, a member of canopy_operator only (ADR M3-0002), never DATABASE_URL.
 * `PLATFORM_IP_ALLOWLIST` (addresses or CIDRs) answers 404 to every other address, and production needs one (ADR
 * M15-0003 decision 10). `APP_URL`, the customer app's origin, is where support sessions open (decision 7). Anything
 * but "true" or "false" for PLATFORM_ENABLED fails the boot, as does a missing or reused login, a missing APP_URL, or
 * no allowlist with NODE_ENV=production.
 */
function platformFromEnv(env: NodeJS.ProcessEnv, secrets: SecretBox): PlatformOptions | null {
  const enabled = env.PLATFORM_ENABLED?.trim() ?? '';
  if (enabled === '' || enabled === 'false') return null;
  if (enabled !== 'true') {
    throw new Error(`PLATFORM_ENABLED must be "true" or "false", not ${JSON.stringify(enabled)}`);
  }
  const connectionString = env.OPERATOR_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'OPERATOR_DATABASE_URL is required with PLATFORM_ENABLED=true: the console login, a member of canopy_operator only',
    );
  }
  if (connectionString === env.DATABASE_URL) {
    throw new Error('OPERATOR_DATABASE_URL must be its own login, not DATABASE_URL');
  }
  const allowlist = ipAllowlistFromEnv(env.PLATFORM_IP_ALLOWLIST);
  if (!allowlist && env.NODE_ENV === 'production') {
    throw new Error(
      'PLATFORM_IP_ALLOWLIST is required with PLATFORM_ENABLED=true in production: the addresses or CIDRs the operator signs in from',
    );
  }
  const appUrl = appOrigin(env.APP_URL);
  return { db: createOperatorDatabase({ connectionString }), secrets, allowlist, appUrl };
}

function appOrigin(value: string | undefined): string {
  let url: URL | undefined;
  try {
    url = value ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new Error(
      'APP_URL is required with PLATFORM_ENABLED=true: the customer app origin, for example https://app.example.com',
    );
  }
  return url.origin;
}

/**
 * The server options for the environment. With DATABASE_URL, the modules that read and write the database are
 * mounted: M6 (library and entities), M7 (instances), M10 (dashboards and reports on the Postgres store) and, when
 * object storage is configured too (S3_*), M7's evidence routes, M8 (imports) and M10's export files. Without it (the e2e web server, a
 * UI-only dev run) they stay unmounted, and M10 keeps its empty default store. Sign-in (registerAuth) runs before
 * every route; with DATABASE_URL it reads sessions and accounts from M5's database store and serves the sign-in,
 * MFA and invite routes, which need AUTH_SECRET_KEY (32 bytes, base64) to seal MFA secrets.
 */
export function wiringFromEnv(env: NodeJS.ProcessEnv, logImportError: ImportErrorLog): Wiring {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) return { options: {} };
  const authSecretKey = env.AUTH_SECRET_KEY;
  if (!authSecretKey) {
    throw new Error(
      'AUTH_SECRET_KEY is required with DATABASE_URL: 32 bytes, base64 (openssl rand -base64 32); it seals MFA secrets',
    );
  }
  // Checks the key's length before anything connects.
  const secrets = new SecretBox(authSecretKey);
  const database = createDatabase({ connectionString });
  const accountStore = createDbAccountStore(database, {});
  const importFiles = s3ImportFilesFromEnv(env);
  const exportFiles = s3ExportFilesFromEnv(env);
  const s3 = s3SettingsFromEnv(env);
  const platform = platformFromEnv(env, secrets);
  return {
    database,
    auth: new AuthService({ store: accountStore, secrets }),
    ...(platform && { operatorDatabase: platform.db }),
    options: {
      ...(platform && { platform }),
      database,
      accountStore,
      authSecretKey,
      // Evidence keys live under `evidence/` in the bucket imports and exports share; the routes mount only with storage.
      ...(s3 && { evidenceStorage: createS3Storage(s3) }),
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
  const settings = s3SettingsFromEnv(env);
  return settings && new S3ExportFiles(settings);
}

export interface JobsWiring {
  /** Told why the jobs did not start; main.ts passes the server logger's warn. */
  readonly warn: (message: string) => void;
  /** Per-run job lines (counts only). */
  readonly log?: JobRunnerOptions['log'];
  /** M5's sign-in service (`Wiring.auth`): issues the one-time tokens in sign-in link and invite emails. */
  readonly auth?: Pick<AuthService, 'issueLoginToken'>;
  /** Tests replace the M9 boot. */
  readonly start?: typeof startJobsFromEnv;
}

/**
 * Starts the M9 jobs on the API's database: instance generation, the outbox relay and M6's master library copy for
 * new accounts (`account.created`, ADR M6-0001) always, reminders, digests
 * and workflow emails when the environment configures mail, and the evidence virus scan when it configures a scanner. Without a database nothing starts and nothing is said,
 * as for the modules above; with one but no SMTP server it warns, because reminders and approval emails would
 * silently never go out, and without a scanner, because uploaded evidence would never become downloadable. Half-set mail settings throw, so a deploy fails at boot rather than running without mail.
 */
export async function jobsFromEnv(
  env: NodeJS.ProcessEnv,
  database: Database | undefined,
  { warn, log, auth, start = startJobsFromEnv }: JobsWiring,
): Promise<JobRunner | null> {
  const connectionString = env.DATABASE_URL;
  if (!database || !connectionString) return null;
  const jobs = await start(env, {
    db: database,
    connectionString,
    ...(log && { log }),
    ...(auth && { issueLoginToken: (input) => auth.issueLoginToken(input) }),
    copyLibrary: (accountId, requestId) => copyMasterLibrary(database, accountId, requestId),
  });
  if (!jobs.mail)
    warn(
      'email jobs not started: no SMTP server configured (set SMTP_URL or SMTP_HOST, MAIL_FROM and APP_URL); instance generation still runs',
    );
  else if (!jobs.loginEmails)
    warn(
      'sign-in link and invite emails not sent: no sign-in service to issue their one-time tokens',
    );
  if (!jobs.scan)
    warn(
      'evidence scan not started: no virus scanner configured (set CLAMAV_HOST); uploaded evidence stays unavailable',
    );
  return jobs;
}
