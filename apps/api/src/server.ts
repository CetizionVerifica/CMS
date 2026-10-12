import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from '@canopy/db';
import { registerAuth, type AuthOptions, type AuthStore } from './auth/index.js';
import { MemoryReportsStore } from './modules/dashboard/memory-store.js';
import type { ReportsStore } from './modules/dashboard/ports.js';
import { registerDashboardRoutes } from './modules/dashboard/routes.js';
import { MemoryExportFiles, type ExportFiles } from './modules/reports/files.js';
import { registerReportRoutes } from './modules/reports/routes.js';
import { IdempotencyCache, InProcessRunner, type ExportRunner } from './modules/reports/service.js';
import { libraryAndEntities, type M6Deps } from './modules/entities/index.js';
import { registerInstanceRoutes } from './modules/instances/routes.js';
import { createInstanceService } from './modules/instances/service.js';

export interface ServerOptions {
  /** Session storage for auth. Until M5's repository-backed store lands, the default knows no sessions. */
  readonly authStore?: AuthStore;
  readonly clock?: () => Date;
  readonly rateLimit?: AuthOptions['rateLimit'];
  /** M10 dashboards and reports. Until the Postgres adapter lands, the default store is empty. */
  readonly reports?: {
    readonly store?: ReportsStore;
    readonly files?: ExportFiles;
    readonly runner?: ExportRunner;
    readonly exportRateLimit?: { max: number; timeWindow: string | number };
  };
  /** M6 · Library and entities, mounted under /api/v1 when given (main.ts wires the database store). */
  readonly libraryAndEntities?: M6Deps;
  /** M7 · Tenant database for the instance routes, mounted under /api/v1 when given. */
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
