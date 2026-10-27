import { ENDPOINTS } from '@canopy/contracts';
import type { FastifyInstance } from 'fastify';
import { actionsHandlers } from './db-actions.js';
import { createCore } from './db-context.js';
import { certificationsHandlers } from './db-certifications.js';
import { documentsHandlers } from './db-documents.js';
import { filesHandlers } from './db-files.js';
import { nonconformitiesHandlers } from './db-nonconformities.js';
import { objectivesHandlers } from './db-objectives.js';
import { risksHandlers } from './db-risks.js';
import { systemsHandlers } from './db-systems.js';
import { parseInput } from './errors.js';
import { keyedRequest } from './idempotency.js';
import type { IsoCall, IsoEndpointId, IsoRouteOptions } from './types.js';

/**
 * M16's routes (docs/contracts/endpoints.md §10), one per handler, each from its `ENDPOINTS` entry: its method and
 * path, `config.feature` so M5 answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before anything else, the
 * contract's params, query and body, its status, and its response checked against the contract. The file routes are
 * mounted only with an `IsoFiles`.
 */

type AnyHandler = (call: IsoCall<IsoEndpointId>) => Promise<unknown>;

export function registerIsoRoutes(app: FastifyInstance, options: IsoRouteOptions): void {
  const core = createCore(options);
  const handlers: Partial<Record<IsoEndpointId, AnyHandler>> = {
    ...systemsHandlers(core),
    ...documentsHandlers(core),
    ...certificationsHandlers(core),
    ...risksHandlers(core),
    ...objectivesHandlers(core),
    ...actionsHandlers(core),
    ...nonconformitiesHandlers(core),
    ...(options.files === undefined ? {} : filesHandlers(core, options.files)),
  } as Partial<Record<IsoEndpointId, AnyHandler>>;

  for (const [id, handler] of Object.entries(handlers) as [IsoEndpointId, AnyHandler][]) {
    const endpoint = ENDPOINTS[id];
    app.route({
      method: endpoint.method,
      url: endpoint.path.replace(/\{(\w+)\}/g, ':$1'),
      config: { auth: 'session', feature: 'isoManagement' },
      handler: async (request, reply) => {
        const call = {
          ctx: request.ctx,
          params: endpoint.params!.parse(request.params) as Record<string, string>,
          query: endpoint.query === null ? undefined : parseInput(endpoint.query, request.query),
          body: endpoint.body === null ? undefined : parseInput(endpoint.body, request.body),
          key: endpoint.idempotent
            ? keyedRequest(request.headers['idempotency-key'], request.url, request.body)
            : undefined,
        } as IsoCall<IsoEndpointId>;
        const result = await handler(call);
        const checked = endpoint.response.safeParse(result);
        // A response the contract refuses is M16's bug, never the caller's: a 500, not a 400.
        if (!checked.success)
          throw new Error(`${String(id)}: the response does not match the contract`);
        return reply.status(endpoint.status).send(checked.data);
      },
    });
  }
}
