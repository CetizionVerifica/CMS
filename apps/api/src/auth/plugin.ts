import fastifyCookie from '@fastify/cookie';
import type { Action, RequestContext, Resource } from '@canopy/contracts';
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from 'fastify';
import { ZodError } from 'zod';
import { buildRequestContext, type AuthStore } from './context.js';
import { ApiError, errorEnvelope } from './errors.js';
import { can } from './policy.js';
import { hashToken, sameToken } from './tokens.js';

/**
 * How a route is reached. Every route must declare one in `config.auth`; registration throws otherwise,
 * so no route is reachable without a decision.
 * - `public`: no session (login, magic link, invite acceptance, health).
 * - `session`: a valid session with MFA done where required; `req.ctx` is set.
 * - `session-pre-mfa`: a valid session, MFA may be pending (`/me`, MFA enroll/verify, logout).
 */
export const ROUTE_AUTH = ['public', 'session', 'session-pre-mfa'] as const;
export type RouteAuth = (typeof ROUTE_AUTH)[number];

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
  interface FastifyRequest {
    /** The request context. Set on `session` and `session-pre-mfa` routes; reading it elsewhere throws. */
    readonly ctx: RequestContext;
  }
}

export const SESSION_COOKIE = 'sid';
export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthOptions {
  readonly store: AuthStore;
  /** Defaults to the system clock. */
  readonly clock?: () => Date;
}

const contexts = new WeakMap<FastifyRequest, RequestContext>();

function sessionHook(options: AuthOptions, auth: RouteAuth): onRequestHookHandler {
  const clock = options.clock ?? (() => new Date());
  return async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await options.store.findSession(hashToken(token)) : null;
    const principal = session
      ? await options.store.loadPrincipal(session.firmId, session.personId)
      : null;
    const params = request.params as Record<string, unknown> | undefined;
    const clientId = typeof params?.clientId === 'string' ? params.clientId : undefined;
    const timeZone =
      session && clientId
        ? ((await options.store.clientTimeZone(session.firmId, clientId)) ?? undefined)
        : undefined;

    const ctx = buildRequestContext({
      requestId: request.id,
      session,
      principal,
      now: clock(),
      timeZone,
      allowBeforeMfa: auth === 'session-pre-mfa',
    });

    if (!SAFE_METHODS.has(request.method)) {
      const header = request.headers[CSRF_HEADER];
      if (session === null || typeof header !== 'string' || !sameToken(header, session.csrfToken)) {
        throw new ApiError('FORBIDDEN', undefined, 'Missing or invalid CSRF token.');
      }
    }
    // A client outside the actor's clients is reported as not found, not forbidden (endpoints.md §1).
    if (clientId !== undefined && !ctx.clientIds.includes(clientId))
      throw new ApiError('NOT_FOUND');

    contexts.set(request, ctx);
  };
}

function toApiError(error: FastifyError | Error): ApiError | null {
  if (error instanceof ApiError) return error;
  if (error instanceof ZodError) {
    return new ApiError('VALIDATION', {
      issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const fastifyError = error as FastifyError;
  if (fastifyError.validation) {
    return new ApiError('VALIDATION', {
      issues: fastifyError.validation.map((v) => ({ path: v.instancePath, message: v.message })),
    });
  }
  switch (fastifyError.statusCode) {
    case 404:
      return new ApiError('NOT_FOUND');
    case 413:
      return new ApiError('FILE_TOO_LARGE');
    case 415:
      return new ApiError('UNSUPPORTED_FILE');
    case 429:
      return new ApiError('RATE_LIMITED');
    default:
      return fastifyError.statusCode !== undefined && fastifyError.statusCode < 500
        ? new ApiError('VALIDATION')
        : null;
  }
}

function sendError(request: FastifyRequest, reply: FastifyReply, error: ApiError) {
  return reply.status(error.statusCode).send(errorEnvelope(error, request.id));
}

/**
 * Installs auth on the app: the session cookie parser, the per-route context hook, `req.ctx`, and the error
 * and not-found handlers that render `ErrorEnvelope`s. Call it in `buildServer` before any route.
 */
export function registerAuth(app: FastifyInstance, options: AuthOptions): void {
  void app.register(fastifyCookie);

  app.decorateRequest('ctx', {
    getter(this: FastifyRequest) {
      const ctx = contexts.get(this);
      if (ctx === undefined) {
        throw new Error('req.ctx is only available on routes with config.auth "session"');
      }
      return ctx;
    },
  });

  app.addHook('onRoute', (route) => {
    const auth = route.config?.auth;
    if (auth === undefined || !ROUTE_AUTH.includes(auth)) {
      throw new Error(
        `${String(route.method)} ${route.url}: declare config.auth (${ROUTE_AUTH.join(', ')})`,
      );
    }
    if (auth === 'public') return;
    const existing = route.onRequest ?? [];
    route.onRequest = [
      sessionHook(options, auth),
      ...(Array.isArray(existing) ? existing : [existing]),
    ];
  });

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    const apiError = toApiError(error);
    if (apiError) return sendError(request, reply, apiError);
    request.log.error({ err: error }, 'unhandled error');
    return sendError(request, reply, new ApiError('INTERNAL'));
  });

  app.setNotFoundHandler((request, reply) => sendError(request, reply, new ApiError('NOT_FOUND')));
}

/** Throws `FORBIDDEN` unless `can()` allows the action for the request's actor. */
export function authorize(request: FastifyRequest, action: Action, resource: Resource): void {
  if (!can(request.ctx, action, resource)) throw new ApiError('FORBIDDEN', { action });
}

/** Throws `NOT_FOUND` when a client (from a body or a loaded row) is outside the actor's clients. */
export function requireClient(ctx: RequestContext, clientId: string): void {
  if (!ctx.clientIds.includes(clientId)) throw new ApiError('NOT_FOUND');
}
