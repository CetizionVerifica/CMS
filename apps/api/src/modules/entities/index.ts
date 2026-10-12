import type { FastifyInstance } from 'fastify';
import { assignmentRoutes } from '../assignments/routes.js';
import { clientRoutes } from '../clients/routes.js';
import { libraryRoutes } from '../library/routes.js';
import { peopleRoutes } from '../people/routes.js';
import { errorEnvelope, type M6Deps } from './http/route.js';
import { entityRoutes } from './routes.js';

export { HttpError } from './http/errors.js';
export type { M6Deps } from './http/route.js';
export type { Store, Tx } from './store.js';

const REQUEST_ID = /^[\w.:-]{1,200}$/;

/**
 * M6 · Library and entities API, mounted under /api/v1. Errors use the contracts envelope and every response carries
 * X-Request-Id (api-conventions.md §1, §4). Encapsulated, so its error handler applies to M6 routes only.
 */
export async function libraryAndEntities(app: FastifyInstance, deps: M6Deps): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    const sent = request.headers['x-request-id'];
    const id = typeof sent === 'string' && REQUEST_ID.test(sent) ? sent : request.id;
    reply.header('x-request-id', id);
  });
  app.setErrorHandler((error, request, reply) => {
    const requestId = String(reply.getHeader('x-request-id') ?? request.id);
    const { status, body } = errorEnvelope(error, requestId);
    if (status >= 500) request.log.error({ err: error, requestId }, 'M6 request failed');
    return reply.status(status).send(body);
  });
  clientRoutes(app, deps);
  entityRoutes(app, deps);
  peopleRoutes(app, deps);
  libraryRoutes(app, deps);
  assignmentRoutes(app, deps);
}
