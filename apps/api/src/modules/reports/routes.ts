import { ClientParams, ENDPOINTS, IdParams } from '@canopy/contracts';
import type { FastifyInstance } from 'fastify';
import { ApiError, authorize } from '../../auth/index.js';
import { routePath } from '../dashboard/routes.js';
import {
  actReport,
  createExport,
  departmentReport,
  exportDownloadUrl,
  getExport,
  IdempotencyKey,
  overdueReport,
  type ReportsDeps,
} from './service.js';

/** Export requests per person-IP per minute (api-conventions.md §5, RATE_LIMITED). */
export const EXPORT_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

/** M10 report and export routes: thin, they validate, authorise and call the service. */
export function registerReportRoutes(app: FastifyInstance, deps: ReportsDeps): void {
  const { actReport: act, departmentReport: dept, overdueReport: overdue } = ENDPOINTS;
  const { createExport: create, getExport: get, exportDownloadUrl: download } = ENDPOINTS;

  app.get(routePath(act), { config: { auth: 'session' } }, async (req) => {
    const { clientId } = ClientParams.parse(req.params);
    const query = act.query.parse(req.query);
    authorize(req, 'report.read', { type: 'client', clientId });
    return actReport(deps, req.ctx, clientId, query);
  });

  app.get(routePath(dept), { config: { auth: 'session' } }, async (req) => {
    const { clientId } = ClientParams.parse(req.params);
    const query = dept.query.parse(req.query);
    authorize(req, 'report.read', { type: 'client', clientId });
    return departmentReport(deps, req.ctx, clientId, query);
  });

  app.get(routePath(overdue), { config: { auth: 'session' } }, async (req) => {
    const { clientId } = ClientParams.parse(req.params);
    const query = overdue.query.parse(req.query);
    authorize(req, 'report.read', { type: 'client', clientId });
    return overdueReport(deps, req.ctx, clientId, query);
  });

  app.post(
    routePath(create),
    { config: { auth: 'session', routeLimit: deps.exportRateLimit ?? EXPORT_RATE_LIMIT } },
    async (req, reply) => {
      const { clientId } = ClientParams.parse(req.params);
      const body = create.body.parse(req.body ?? {});
      const header = req.headers['idempotency-key'];
      const key = header === undefined ? undefined : IdempotencyKey.safeParse(header);
      if (key !== undefined && !key.success) {
        throw new ApiError('VALIDATION', {
          issues: [{ path: ['Idempotency-Key'], message: 'Expected a UUID' }],
        });
      }
      authorize(req, 'export.create', { type: 'client', clientId });
      const job = await createExport(deps, req.ctx, clientId, body, key?.data);
      return reply.status(create.status).send(job);
    },
  );

  app.get(routePath(get), { config: { auth: 'session' } }, async (req) => {
    const { id } = IdParams.parse(req.params);
    return getExport(deps, req.ctx, id);
  });

  app.get(routePath(download), { config: { auth: 'session' } }, async (req) => {
    const { id } = IdParams.parse(req.params);
    return exportDownloadUrl(deps, req.ctx, id);
  });
}
