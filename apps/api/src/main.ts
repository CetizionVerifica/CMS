import { createDatabase } from '@canopy/db';
import { PostgresStore } from './modules/entities/service.js';
import { buildServer } from './server.js';

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? '0.0.0.0';

// With a database, mount the modules that read and write it: M6 (library and entities) and M7 (instances). Without
// one (the e2e web server, a UI-only dev run) they stay unmounted. Sign-in (registerAuth) runs before every route.
const connectionString = process.env.DATABASE_URL;
const database = connectionString ? createDatabase({ connectionString }) : undefined;

const app = buildServer(
  database ? { database, libraryAndEntities: { store: new PostgresStore(database) } } : {},
);
app.addHook('onClose', async () => database?.close());
await app.listen({ port, host });
