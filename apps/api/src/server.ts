import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  redactUrl,
  registerAuth,
  registerAuthRoutes,
  SecretBox,
  type AccountStore,
  type AuthOptions,
  type AuthStore,
} from './auth/index.js';

export interface ServerOptions {
  /** Session storage for auth. Until M5's repository-backed store lands, the default knows no sessions. */
  readonly authStore?: AuthStore;
  /** Sign-in, MFA and invite storage. When given, the `/api/v1/auth`, `/me` and `/invites` routes are served. */
  readonly accountStore?: AccountStore;
  /** 32 bytes, base64: seals MFA secrets. Default `AUTH_SECRET_KEY`. Required with `accountStore`. */
  readonly authSecretKey?: string;
  readonly clock?: () => Date;
  readonly rateLimit?: AuthOptions['rateLimit'];
  /** Fastify `trustProxy`: set behind a load balancer so rate limits see the client IP. Default `TRUST_PROXY`. */
  readonly trustProxy?: FastifyServerOptions['trustProxy'];
}

const NO_SESSIONS: AuthStore = {
  findSession: async () => null,
  loadPrincipal: async () => null,
  clientTimeZone: async () => null,
};

/** `TRUST_PROXY`: "true", or a comma-separated list of proxy addresses or CIDRs. Unset: false. */
export function trustProxyFromEnv(value: string | undefined): FastifyServerOptions['trustProxy'] {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  return value;
}

// Builds the app without listening, so tests can use `app.inject`.
// Modules register their routes here as they land (see apps/api/CLAUDE.md). Every route declares
// `config.auth`; see apps/api/src/auth/CLAUDE.md.
export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : {
            // Invite and magic-link tokens must never reach the logs (auth/CLAUDE.md).
            serializers: {
              req: (req) => ({ method: req.method, url: redactUrl(req.url), id: req.id }),
            },
          },
    genReqId: () => randomUUID(),
    trustProxy: options.trustProxy ?? trustProxyFromEnv(process.env.TRUST_PROXY),
  });

  const store = options.accountStore ?? options.authStore ?? NO_SESSIONS;
  registerAuth(app, { store, clock: options.clock, rateLimit: options.rateLimit });

  if (options.accountStore) {
    const key = options.authSecretKey ?? process.env.AUTH_SECRET_KEY;
    if (!key) throw new Error('AUTH_SECRET_KEY is required to serve sign-in routes');
    registerAuthRoutes(app, {
      store: options.accountStore,
      secrets: new SecretBox(key),
      clock: options.clock,
    });
  }

  app.get('/health', { config: { auth: 'public' } }, async () => ({ status: 'ok' }));

  return app;
}
