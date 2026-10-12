import Fastify, { type FastifyInstance } from 'fastify';
import { libraryAndEntities, type M6Deps } from './modules/entities/index.js';

export interface ServerOptions {
  /** M6 · Library and entities. Mounted under /api/v1 when given (the database and M5 context are wired in main.ts). */
  libraryAndEntities?: M6Deps;
}

// Builds the app without listening, so tests can use `app.inject`.
// Modules register their routes here as they land (see apps/api/CLAUDE.md).
export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.get('/health', async () => ({ status: 'ok' }));

  if (options.libraryAndEntities) {
    const deps = options.libraryAndEntities;
    void app.register((scope) => libraryAndEntities(scope, deps), { prefix: '/api/v1' });
  }

  return app;
}
