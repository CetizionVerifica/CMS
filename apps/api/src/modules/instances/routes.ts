import { ClientParams, ENDPOINTS, IdParams } from '@canopy/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authorize } from '../../auth/index.js';
import type { Actor, InstanceService } from './service.js';

/**
 * M7 instance routes (docs/contracts/endpoints.md §4). Thin: parse with the contract schemas, hand the
 * actor to the service, reply with the contract status. Errors reach M5's error handler.
 */

/** The acting person and M5's `authorize` for one request. */
export function actor(request: FastifyRequest): Actor {
  return {
    ctx: request.ctx,
    authorize: (action, resource) => authorize(request, action, resource),
  };
}

export const session = { config: { auth: 'session' as const } };

export function registerInstanceRoutes(app: FastifyInstance, service: InstanceService): void {
  const e = ENDPOINTS;

  app.get('/clients/:clientId/instances', session, async (request) => {
    const { clientId } = ClientParams.parse(request.params);
    return service.list(actor(request), clientId, e.listInstances.query.parse(request.query));
  });

  app.get('/instances/:id', session, async (request) => {
    const { id } = IdParams.parse(request.params);
    return service.get(actor(request), id, e.getInstance.query.parse(request.query));
  });

  app.post('/instances/:id/submit', session, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = e.submitInstance.body.parse(request.body);
    return service.transition(actor(request), id, body.version, {
      action: 'SUBMIT',
      completedOn: body.completedOn,
      comment: body.comment,
    });
  });

  app.post('/instances/:id/request-na', session, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = e.requestNa.body.parse(request.body);
    return service.transition(actor(request), id, body.version, {
      action: 'REQUEST_NA',
      reason: body.reason,
    });
  });

  app.post('/instances/:id/approve', session, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = e.approveInstance.body.parse(request.body);
    return service.transition(actor(request), id, body.version, {
      action: 'APPROVE',
      comment: body.comment,
    });
  });

  app.post('/instances/:id/send-back', session, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = e.sendBackInstance.body.parse(request.body);
    return service.transition(actor(request), id, body.version, {
      action: 'SEND_BACK',
      reason: body.reason,
    });
  });

  app.post('/instances/:id/reopen', session, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = e.reopenInstance.body.parse(request.body);
    return service.transition(actor(request), id, body.version, {
      action: 'REOPEN',
      reason: body.reason,
    });
  });

  app.post('/clients/:clientId/instances/bulk-approve', session, async (request) => {
    const { clientId } = ClientParams.parse(request.params);
    const body = e.bulkApprove.body.parse(request.body);
    return service.bulkApprove(actor(request), clientId, body);
  });

  app.patch('/instances/:id', session, async (request) => {
    const { id } = IdParams.parse(request.params);
    return service.update(actor(request), id, e.updateInstance.body.parse(request.body));
  });

  app.get('/me/approvals', session, async (request) =>
    service.queue(actor(request), 'approvals', e.myApprovals.query.parse(request.query)),
  );

  app.get('/me/tasks', session, async (request) =>
    service.queue(actor(request), 'tasks', e.myTasks.query.parse(request.query)),
  );

  app.get('/instances/:id/comments', session, async (request) => {
    const { id } = IdParams.parse(request.params);
    return service.listComments(actor(request), id, e.listComments.query.parse(request.query));
  });

  app.post('/instances/:id/comments', session, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const comment = await service.addComment(
      actor(request),
      id,
      e.createComment.body.parse(request.body),
    );
    return reply.status(201).send(comment);
  });
}
