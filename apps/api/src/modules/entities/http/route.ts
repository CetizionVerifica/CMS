import type { Can, Endpoint, RequestContext, Resource, Role } from '@canopy/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { DuplicateError, type Store } from '../store.js';
import { authorize } from './access.js';
import { duplicate, fromZod, HttpError } from './errors.js';

/** What the M6 routes need from the app: the database, the policy and the request context (M5). */
export interface M6Deps {
  store: Store;
  /** M5's policy check; `stubCan` until M5 merges. */
  can: Can;
  /** The signed-in actor. Throws HttpError UNAUTHENTICATED (or MFA_REQUIRED) when there is none. */
  context(request: FastifyRequest): Promise<RequestContext>;
  /** Clock for archive timestamps; tests pin it. */
  now?: () => Date;
}

type Parsed<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface Call<E extends Endpoint> {
  ctx: RequestContext;
  params: Record<string, string>;
  query: Parsed<E['query']>;
  body: Parsed<E['body']>;
  /** Checks the endpoint's roles and `can()` for a resource; returns the actor's roles that apply. */
  authorize(resource: Resource): Role[];
}

export type Handler<E extends Endpoint> = (
  call: Call<E>,
) => Promise<z.input<E['response']> | z.output<E['response']>>;

function parse<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw fromZod(result.error, where);
  return result.data;
}

/** Registers one endpoint from the contracts table: path, method and status come from the table, never retyped. */
export function mount<E extends Endpoint>(
  app: FastifyInstance,
  deps: M6Deps,
  endpoint: E,
  handler: Handler<E>,
): void {
  const url = endpoint.path.replace(/\{(\w+)\}/g, ':$1');
  app.route({
    method: endpoint.method,
    url,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = await deps.context(request);
      const params = endpoint.params
        ? (parse(endpoint.params, request.params, 'params') as Record<string, string>)
        : {};
      const query = (
        endpoint.query ? parse(endpoint.query, request.query ?? {}, 'query') : undefined
      ) as Parsed<E['query']>;
      const body = (
        endpoint.body ? parse(endpoint.body, request.body ?? {}, 'body') : undefined
      ) as Parsed<E['body']>;
      const result = await handler({
        ctx,
        params,
        query,
        body,
        authorize: (resource) => authorize(ctx, endpoint, resource, deps.can),
      });
      return reply.status(endpoint.status).send(result);
    },
  });
}

/** The `{ error, requestId }` envelope for anything a route throws (api-conventions.md §4). */
export function errorEnvelope(thrown: unknown, requestId: string) {
  const error =
    thrown instanceof DuplicateError ? duplicate(thrown.field, thrown.existingId) : thrown;
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
        requestId,
      },
    };
  }
  const fastifyError = error as { statusCode?: number; code?: string; message?: string };
  // Fastify's own 4xx (malformed JSON, wrong content type, body too large) is a validation problem.
  if (
    typeof fastifyError.statusCode === 'number' &&
    fastifyError.statusCode >= 400 &&
    fastifyError.statusCode < 500
  ) {
    const message = fastifyError.message ?? 'Invalid request';
    return {
      status: 400,
      body: {
        error: { code: 'VALIDATION', message, details: { issues: [{ path: [], message }] } },
        requestId,
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: 'Something went wrong.' }, requestId },
  };
}
