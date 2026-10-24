import { ClientParams, ENDPOINTS, IdParams } from '@canopy/contracts';
import type { FastifyInstance } from 'fastify';
import { actor, session } from '../instances/routes.js';
import type { AuditService } from './service.js';

/** M7 evidence vault and audit trail routes (endpoints.md §4). Thin: parse, call the service. */

export function registerAuditRoutes(app: FastifyInstance, service: AuditService): void {
  const e = ENDPOINTS;

  app.get('/clients/:clientId/evidence', session, async (request) => {
    const { clientId } = ClientParams.parse(request.params);
    return service.vault(actor(request), clientId, e.evidenceVault.query.parse(request.query));
  });

  app.get('/clients/:clientId/audit', session, async (request) => {
    const { clientId } = ClientParams.parse(request.params);
    return service.clientTrail(actor(request), clientId, e.clientAudit.query.parse(request.query));
  });

  app.get('/instances/:id/audit', session, async (request) => {
    const { id } = IdParams.parse(request.params);
    return service.instanceTrail(actor(request), id, e.instanceAudit.query.parse(request.query));
  });
}
