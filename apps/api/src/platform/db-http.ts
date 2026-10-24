import type { Endpoint, PlatformOperator } from '@canopy/contracts';
import { operatorSessions, type OperatorDatabase, type OperatorSession } from '@canopy/db';
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { z } from 'zod';
import { ApiError, hashToken, sameToken, type SecretBox } from '../auth/index.js';
import { CSRF_HEADER, isOpen, OPERATOR_COOKIE } from './session.js';

/** What the operator routes need: the operator's own database login, M5's secret box and a clock. */
export interface PlatformDeps {
  readonly db: OperatorDatabase;
  readonly secrets: SecretBox;
  readonly clock: () => Date;
  /** `Secure` on the `op_sid` cookie. */
  readonly secure: boolean;
  /** The customer app's origin, for support-session links. */
  readonly appUrl: string;
}

export interface SignedIn {
  operator: PlatformOperator;
  session: OperatorSession;
}

const signedIn = new WeakMap<FastifyRequest, SignedIn>();
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The operator behind a request on a signed-in route. */
export function signedInOf(request: FastifyRequest): SignedIn {
  const found = signedIn.get(request);
  if (!found) throw new Error('signedInOf() is only available on signed-in operator routes');
  return found;
}

/**
 * The operator session check on every route but sign-in: the `op_sid` cookie only (the customer `sid` is never
 * read), an open session of an operator who is not disabled, 30 minutes idle at most, and the session's CSRF token
 * on every state-changing request. An idle session is revoked. Each request moves the idle clock on.
 */
export function operatorSessionHook(deps: PlatformDeps): onRequestHookHandler {
  return async (request) => {
    const token = request.cookies[OPERATOR_COOKIE];
    if (!token) throw new ApiError('UNAUTHENTICATED');
    const now = deps.clock();
    const found = await deps.db.withOperator(request.id, async (tx) => {
      const open = await operatorSessions.find(tx, hashToken(token), now.toISOString());
      if (!open) return null;
      if (!isOpen(open.session, now)) {
        await operatorSessions.revoke(tx, open.session.id, now.toISOString());
        return null;
      }
      if (!SAFE_METHODS.has(request.method)) {
        const header = request.headers[CSRF_HEADER];
        if (typeof header !== 'string' || !sameToken(header, open.session.csrfToken)) {
          throw new ApiError('FORBIDDEN', undefined, 'Missing or invalid CSRF token.');
        }
      }
      await operatorSessions.touch(tx, open.session.id, now.toISOString());
      return { ...open, session: { ...open.session, lastSeenAt: now.toISOString() } };
    });
    if (!found) throw new ApiError('UNAUTHENTICATED');
    signedIn.set(request, found);
  };
}

type Parsed<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface PlatformCall<E extends Endpoint> {
  request: FastifyRequest;
  reply: FastifyReply;
  /** The id the response echoes; operator audit rows carry it. */
  requestId: string;
  now: Date;
  params: Record<string, string>;
  query: Parsed<E['query']>;
  body: Parsed<E['body']>;
}

export type PlatformHandler<E extends Endpoint> = (
  call: PlatformCall<E>,
) => Promise<z.input<E['response']> | undefined>;

/**
 * Registers one operator endpoint from `PLATFORM_ENDPOINTS`: path, method and status come from the contract. To M5's
 * customer auth every operator route is `public`: it never reads a customer session. The operator session hook
 * runs instead on every endpoint the contract does not mark public. Responses are parsed with the contract schema,
 * so nothing the contract leaves out (such as a person's details) can be sent.
 */
export function mountPlatform<E extends Endpoint>(
  api: FastifyInstance,
  deps: PlatformDeps,
  endpoint: E,
  handler: PlatformHandler<E>,
  options: { routeLimit?: { max: number; timeWindow: string | number } } = {},
): void {
  api.route({
    method: endpoint.method,
    url: endpoint.path.replace(/\{(\w+)\}/g, ':$1'),
    config: {
      auth: 'public',
      ...(options.routeLimit && { routeLimit: options.routeLimit }),
    },
    ...(endpoint.auth === 'public' ? {} : { onRequest: operatorSessionHook(deps) }),
    handler: async (request, reply) => {
      const params = (endpoint.params?.parse(request.params) ?? {}) as Record<string, string>;
      const query = endpoint.query?.parse(request.query ?? {}) as Parsed<E['query']>;
      const body = endpoint.body?.parse(request.body ?? {}) as Parsed<E['body']>;
      const result = await handler({
        request,
        reply,
        requestId: request.id,
        now: deps.clock(),
        params,
        query,
        body,
      });
      if (endpoint.status === 204 || endpoint.status === 202) {
        return reply.status(endpoint.status).send();
      }
      return reply.status(endpoint.status).send(endpoint.response.parse(result));
    },
  });
}
