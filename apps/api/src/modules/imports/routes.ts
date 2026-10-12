import {
  ImportCreateBody,
  ImportIssueDecisionBody,
  ImportIssueGroupParams,
  ImportIssueQuery,
  ImportListQuery,
  ImportMappingBody,
  ImportRowQuery,
  ImportUploadedBody,
  MappingTemplateCreateBody,
  MappingTemplateListQuery,
  MappingTemplateUpdateBody,
  Id,
} from '@canopy/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authorize } from '../../auth/index.js';
import type { Actor, ImportSteps } from './steps.js';

/**
 * Routes for endpoints.md §5. Thin: parse with the contract schemas, then call the service, which checks
 * permissions and the step order. Every route needs a session (FIRM_ADMIN and CONSULTANT pass `can()`).
 */

const IdParams = z.strictObject({ id: Id });
const ClientParams = z.strictObject({ clientId: Id });
const SESSION = { config: { auth: 'session' as const } };

function actor(request: FastifyRequest): Actor {
  return {
    ctx: request.ctx,
    authorize: (action, resource) => authorize(request, action, resource),
  };
}

export function importRoutes(app: FastifyInstance, steps: ImportSteps): void {
  app.post('/clients/:clientId/imports', SESSION, async (request, reply) => {
    const { clientId } = ClientParams.parse(request.params);
    const ticket = await steps.start(
      actor(request),
      clientId,
      ImportCreateBody.parse(request.body),
    );
    return reply.status(201).send(ticket);
  });

  app.post('/imports/:id/uploaded', SESSION, async (request) => {
    const { id } = IdParams.parse(request.params);
    return steps.uploaded(actor(request), id, ImportUploadedBody.parse(request.body));
  });

  app.put('/imports/:id/mapping', SESSION, async (request) => {
    const { id } = IdParams.parse(request.params);
    return steps.setMapping(actor(request), id, ImportMappingBody.parse(request.body));
  });

  app.post('/imports/:id/parse', SESSION, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    return reply.status(202).send(await steps.parse(actor(request), id));
  });

  app.get('/imports/:id', SESSION, async (request) => {
    const { id } = IdParams.parse(request.params);
    return steps.get(actor(request), id);
  });

  app.get('/imports/:id/issues', SESSION, async (request) => {
    const { id } = IdParams.parse(request.params);
    return steps.issues(actor(request), id, ImportIssueQuery.parse(request.query));
  });

  app.patch('/imports/:id/issues/:groupKey', SESSION, async (request) => {
    const { id, groupKey } = ImportIssueGroupParams.parse(request.params);
    return steps.decide(actor(request), id, groupKey, ImportIssueDecisionBody.parse(request.body));
  });

  app.get('/imports/:id/rows', SESSION, async (request) => {
    const { id } = IdParams.parse(request.params);
    return steps.rows(actor(request), id, ImportRowQuery.parse(request.query));
  });

  app.post('/imports/:id/cancel', SESSION, async (request) => {
    const { id } = IdParams.parse(request.params);
    return steps.cancel(actor(request), id);
  });

  app.get('/clients/:clientId/imports', SESSION, async (request) => {
    const { clientId } = ClientParams.parse(request.params);
    return steps.history(actor(request), clientId, ImportListQuery.parse(request.query));
  });

  app.get('/clients/:clientId/mapping-templates', SESSION, async (request) => {
    const { clientId } = ClientParams.parse(request.params);
    return steps.templates(actor(request), clientId, MappingTemplateListQuery.parse(request.query));
  });

  app.post('/clients/:clientId/mapping-templates', SESSION, async (request, reply) => {
    const { clientId } = ClientParams.parse(request.params);
    const template = await steps.createTemplate(
      actor(request),
      clientId,
      MappingTemplateCreateBody.parse(request.body),
    );
    return reply.status(201).send(template);
  });

  app.patch('/mapping-templates/:id', SESSION, async (request) => {
    const { id } = IdParams.parse(request.params);
    return steps.updateTemplate(actor(request), id, MappingTemplateUpdateBody.parse(request.body));
  });
}
