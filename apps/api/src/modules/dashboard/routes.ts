import { ClientParams, ENDPOINTS, type Endpoint } from '@canopy/contracts';
import type { FastifyInstance } from 'fastify';
import { authorize } from '../../auth/index.js';
import { breakdown, calendar, overview, portfolio, type DashboardDeps } from './service.js';

/** API base path (api-conventions.md §1). */
export const API_PREFIX = '/api/v1';

/** Fastify path for a contract endpoint: `/clients/{clientId}/overview` → `/api/v1/clients/:clientId/overview`. */
export function routePath(endpoint: Endpoint): string {
  return API_PREFIX + endpoint.path.replace(/\{(\w+)\}/g, ':$1');
}

/** M10 dashboard routes: thin, they validate, authorise and call the service. */
export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardDeps): void {
  const { portfolio: p, clientOverview, breakdown: b, calendar: cal } = ENDPOINTS;

  app.get(routePath(p), { config: { auth: 'session' } }, async (req) => {
    const query = p.query.parse(req.query);
    authorize(req, 'dashboard.portfolio', { type: 'client', clientId: null });
    return portfolio(deps, req.ctx, query);
  });

  app.get(routePath(clientOverview), { config: { auth: 'session' } }, async (req) => {
    const { clientId } = ClientParams.parse(req.params);
    const query = clientOverview.query.parse(req.query);
    authorize(req, 'dashboard.read', { type: 'client', clientId });
    return overview(deps, req.ctx, clientId, query);
  });

  app.get(routePath(b), { config: { auth: 'session' } }, async (req) => {
    const { clientId } = ClientParams.parse(req.params);
    const query = b.query.parse(req.query);
    authorize(req, 'dashboard.read', { type: 'client', clientId });
    return breakdown(deps, req.ctx, clientId, query);
  });

  app.get(routePath(cal), { config: { auth: 'session' } }, async (req) => {
    const { clientId } = ClientParams.parse(req.params);
    const query = cal.query.parse(req.query);
    authorize(req, 'instance.read', { type: 'client', clientId });
    return calendar(deps, req.ctx, clientId, query);
  });
}
