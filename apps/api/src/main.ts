import { buildServer } from './server.js';
import { jobsFromEnv, wiringFromEnv } from './wiring.js';

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? '0.0.0.0';

const { options, database, auth } = wiringFromEnv(process.env, (info, message) =>
  app.log.error(info, message),
);
const app = buildServer(options);
const jobs = await jobsFromEnv(process.env, database, {
  auth,
  warn: (message) => app.log.warn(message),
  log: (line) => (line.error ? app.log.error(line, 'job failed') : app.log.info(line, 'job ran')),
});
// Jobs stop before the pool they use closes.
app.addHook('onClose', async () => {
  await jobs?.stop();
  await database?.close();
});

// A deploy or Ctrl+C stops the server cleanly: in-flight requests finish, the jobs stop, then the database pool closes.
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
