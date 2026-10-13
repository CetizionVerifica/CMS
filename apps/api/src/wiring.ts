import { createDatabase, type Database } from '@canopy/db';
import { inferRule } from '@canopy/engine';
import { PostgresStore } from './modules/entities/service.js';
import { repositoryStore, s3ImportFilesFromEnv } from './modules/imports/index.js';
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
 * mounted: M6 (library and entities), M7 (instances) and, when upload storage is configured too (S3_*), M8 (imports).
 * Without it (the e2e web server, a UI-only dev run) they stay unmounted. Sign-in (registerAuth) runs before every route.
 */
export function wiringFromEnv(env: NodeJS.ProcessEnv, logImportError: ImportErrorLog): Wiring {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) return { options: {} };
  const database = createDatabase({ connectionString });
  const importFiles = s3ImportFilesFromEnv(env);
  return {
    database,
    options: {
      database,
      libraryAndEntities: { store: new PostgresStore(database) },
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
