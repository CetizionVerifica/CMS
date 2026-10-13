import { buildServer } from './server.js';
import { wiringFromEnv } from './wiring.js';

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? '0.0.0.0';

const { options, database } = wiringFromEnv(process.env, (info, message) =>
  app.log.error(info, message),
);
const app = buildServer(options);
app.addHook('onClose', async () => database?.close());

// A deploy or Ctrl+C stops the server cleanly: in-flight requests finish, then the database pool closes.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}

await app.listen({ port, host });
