import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth, type AuthStore } from './auth/index.js';

export interface ServerOptions {
  /** Session storage for auth. Until M5's repository-backed store lands, the default knows no sessions. */
  readonly authStore?: AuthStore;
  readonly clock?: () => Date;
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

  registerAuth(app, { store: options.authStore ?? NO_SESSIONS, clock: options.clock });

  app.get('/health', { config: { auth: 'public' } }, async () => ({ status: 'ok' }));

  return app;
}
