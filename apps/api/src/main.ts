import { createDatabase } from '@canopy/db';
import { inferRule } from '@canopy/engine';
import { PostgresStore } from './modules/entities/service.js';
import { repositoryStore, s3ImportFilesFromEnv } from './modules/imports/index.js';
import { buildServer, type ServerOptions } from './server.js';

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? '0.0.0.0';

// With a database, mount the modules that read and write it: M6 (library and entities), M7 (instances) and, when
// upload storage is configured too (S3_*), M8 (imports). Without one (the e2e web server, a UI-only dev run) they stay
// unmounted. Sign-in (registerAuth) runs before every route.
const connectionString = process.env.DATABASE_URL;
const database = connectionString ? createDatabase({ connectionString }) : undefined;
const importFiles = database ? s3ImportFilesFromEnv(process.env) : null;

const options: ServerOptions = database
  ? {
      database,
      libraryAndEntities: { store: new PostgresStore(database) },
      ...(importFiles && {
        imports: {
          store: repositoryStore(database),
          files: importFiles,
          inferRule,
          // The batch id and error class only: a parse error can quote cell values from the register.
          onBackgroundError: (error, batchId) =>
            app.log.error(
              { batchId, error: error instanceof Error ? error.name : 'unknown' },
              'import parse failed',
            ),
        },
      }),
    }
  : {};

const app = buildServer(options);
app.addHook('onClose', async () => database?.close());
await app.listen({ port, host });
