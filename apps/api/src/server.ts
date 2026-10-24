import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Database } from '@canopy/db';
import {
  redactUrl,
  registerAuth,
  registerAuthRoutes,
  SecretBox,
  type AccountStore,
  type AuthOptions,
  type AuthStore,
} from './auth/index.js';
import { MemoryReportsStore } from './modules/dashboard/memory-store.js';
import type { ReportsStore } from './modules/dashboard/ports.js';
import { registerDashboardRoutes } from './modules/dashboard/routes.js';
import { MemoryExportFiles, type ExportFiles } from './modules/reports/files.js';
import { registerReportRoutes } from './modules/reports/routes.js';
import { IdempotencyCache, InProcessRunner, type ExportRunner } from './modules/reports/service.js';
import { libraryAndEntities, type M6Deps } from './modules/entities/index.js';
import { registerAuditRoutes } from './modules/audit/routes.js';
import { createAuditService } from './modules/audit/service.js';
import { registerEvidenceRoutes } from './modules/evidence/routes.js';
import { createEvidenceService } from './modules/evidence/service.js';
import type { EvidenceStorage } from './modules/evidence/storage.js';
import { imports, type ImportOptions } from './modules/imports/index.js';
import { registerInstanceRoutes } from './modules/instances/routes.js';
import { createInstanceService } from './modules/instances/service.js';

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
  /**
   * M10 dashboards and reports. main.ts wires the Postgres store (and S3 export files when configured); without
   * them the default store is empty and exports stay in memory.
   */
  readonly reports?: {
    readonly store?: ReportsStore;
    readonly files?: ExportFiles;
    readonly runner?: ExportRunner;
    readonly exportRateLimit?: { max: number; timeWindow: string | number };
  };
  /** M6 · Library and entities, mounted under /api/v1 when given (main.ts wires the database store). */
  readonly libraryAndEntities?: M6Deps;
  /** M8 · imports, mounted under /api/v1 when given (store, file storage and the engine's inferRule). */
  readonly imports?: ImportOptions;
  /** M7 · Tenant database for the instance, vault and audit trail routes, mounted under /api/v1 when given. */
  readonly database?: Database;
  /** M7 · Evidence file storage; with `database`, the evidence routes are mounted too. */
  readonly evidenceStorage?: EvidenceStorage;
}

const NO_SESSIONS: AuthStore = {
  findSession: async () => null,
  loadPrincipal: async () => null,
  clientTimeZone: async () => null,
};

/**
 * `TRUST_PROXY`: a comma-separated list of the load balancers' addresses or CIDRs. Unset or "false": no proxy is
 * trusted. "true" is refused: Fastify would then take the leftmost `X-Forwarded-For` entry, which the browser
 * writes, so anyone could pick the address that per-IP sign-in limits count.
 */
export function trustProxyFromEnv(value: string | undefined): string[] | false {
  if (value === undefined || value.trim() === '' || value.trim() === 'false') return false;
  const entries = value.split(',').map((entry) => entry.trim());
  for (const entry of entries) {
    if (!isProxyAddress(entry)) {
      throw new Error(
        `TRUST_PROXY must list proxy addresses or CIDRs (for example 10.0.0.0/8), not ${JSON.stringify(entry)}`,
      );
    }
  }
  return entries;
}

function isProxyAddress(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128);
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

  const clock = options.clock ?? (() => new Date());
  const reports = {
    store: options.reports?.store ?? new MemoryReportsStore(clock),
    files: options.reports?.files ?? new MemoryExportFiles(),
    runner: options.reports?.runner ?? new InProcessRunner(),
    idempotency: new IdempotencyCache(),
    clock,
    onExportError: (info: object) => app.log.error(info, 'export failed'),
    exportRateLimit: options.reports?.exportRateLimit,
  };
  registerDashboardRoutes(app, reports);
  registerReportRoutes(app, reports);
  if (options.libraryAndEntities) {
    const deps = options.libraryAndEntities;
    void app.register((scope) => libraryAndEntities(scope, deps), { prefix: '/api/v1' });
  }
  const importOptions = options.imports;
  if (importOptions) {
    void app.register(async (scope) => imports(scope, importOptions), { prefix: '/api/v1' });
  }

  const { database } = options;
  if (database) {
    void app.register(
      async (api) => {
        registerInstanceRoutes(api, createInstanceService({ db: database, clock: options.clock }));
        registerAuditRoutes(api, createAuditService({ db: database }));
        if (options.evidenceStorage) {
          const storage = options.evidenceStorage;
          registerEvidenceRoutes(
            api,
            createEvidenceService({ db: database, storage, clock: options.clock }),
          );
        }
      },
      { prefix: '/api/v1' },
    );
  }

  return app;
}
