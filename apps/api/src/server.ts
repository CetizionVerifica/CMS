import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from '@canopy/db';
import { registerAuth, type AuthOptions, type AuthStore } from './auth/index.js';
import { registerInstanceRoutes } from './modules/instances/routes.js';
import { createInstanceService } from './modules/instances/service.js';

export interface ServerOptions {
  /** Session storage for auth. Until M5's repository-backed store lands, the default knows no sessions. */
  readonly authStore?: AuthStore;
  readonly clock?: () => Date;
  readonly rateLimit?: AuthOptions['rateLimit'];
  /** Tenant database. Module routes under /api/v1 are registered only when it is given. */
  readonly database?: Database;
}

const NO_SESSIONS: AuthStore = {
  findSession: async () => null,
  loadPrincipal: async () => null,
  clientTimeZone: async () => null,
};

// Builds the app without listening, so tests can use `app.inject`.
// Modules register their routes here as they land (see apps/api/CLAUDE.md). Every route declares
// `config.auth`; see apps/api/src/auth/CLAUDE.md.
export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', genReqId: () => randomUUID() });

  registerAuth(app, {
    store: options.authStore ?? NO_SESSIONS,
    clock: options.clock,
    rateLimit: options.rateLimit,
  });

  app.get('/health', { config: { auth: 'public' } }, async () => ({ status: 'ok' }));

  const { database } = options;
  if (database) {
    void app.register(
      async (api) => {
        registerInstanceRoutes(api, createInstanceService({ db: database, clock: options.clock }));
      },
      { prefix: '/api/v1' },
    );
  }

  return app;
}
