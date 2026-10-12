import { ENDPOINTS, IdParams } from '@canopy/contracts';
import type { FastifyInstance } from 'fastify';
import { actor, session } from '../instances/routes.js';
import type { EvidenceService } from './service.js';

/** M7 evidence routes (endpoints.md §4). Thin: parse with the contract schemas, call the service. */

export function registerEvidenceRoutes(app: FastifyInstance, service: EvidenceService): void {
  const e = ENDPOINTS;

  app.post('/instances/:id/evidence/upload-url', session, async (request) => {
    const { id } = IdParams.parse(request.params);
    return service.uploadUrl(actor(request), id, e.evidenceUploadUrl.body.parse(request.body));
  });

  app.post('/instances/:id/evidence', session, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const created = await service.confirm(
      actor(request),
      id,
      e.confirmEvidence.body.parse(request.body),
    );
    return reply.code(201).send(created);
  });

  app.get('/instances/:id/evidence', session, async (request) => {
    const { id } = IdParams.parse(request.params);
    return service.listForInstance(actor(request), id);
  });

  app.get('/evidence/:id/download-url', session, async (request) => {
    const { id } = IdParams.parse(request.params);
    return service.downloadUrl(actor(request), id);
  });

  app.post('/evidence/:id/remove', session, async (request) => {
    const { id } = IdParams.parse(request.params);
    return service.remove(actor(request), id, e.removeEvidence.body.parse(request.body));
  });
}
