import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import type { Action, RequestContext, Resource } from '@canopy/contracts';
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from 'fastify';
import { DbError } from '@canopy/db';
import { ZodError } from 'zod';
import { buildRequestContext, mfaRequired, type AuthStore, type SessionRecord } from './context.js';
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
    /** A stricter per-route limit per client IP (login, magic link, invites), on top of the API-wide one. */
    routeLimit?: RateLimit;
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
  /** Requests per client IP per window across the whole API. Default 300 per minute. */
  readonly rateLimit?: RateLimit;
}

export interface RateLimit {
  readonly max: number;
  /** Milliseconds, or a duration such as '1 minute'. */
  readonly timeWindow: string | number;
}

export const DEFAULT_RATE_LIMIT = { max: 300, timeWindow: '1 minute' } as const;

const contexts = new WeakMap<FastifyRequest, RequestContext>();
/** Requests on `session-pre-mfa` routes whose actor still owes MFA, with whether they have enrolled. */
const mfaPending = new WeakMap<FastifyRequest, { enrolled: boolean }>();
const sessions = new WeakMap<FastifyRequest, SessionRecord>();

/** The session behind a session route's request (auth routes use it for logout and MFA). */
export function sessionOf(request: FastifyRequest): SessionRecord {
  const session = sessions.get(request);
  if (session === undefined) throw new Error('sessionOf() is only available on session routes');
  return session;
}

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
    if (session) sessions.set(request, session);
    if (principal && !ctx.mfaSatisfied && mfaRequired(principal, ctx.memberships)) {
      mfaPending.set(request, { enrolled: principal.mfaEnrolled });
    }
  };
}

type Limiter = ReturnType<FastifyInstance['createRateLimit']>;

function routeLimitHook(
  app: FastifyInstance,
  limiters: Map<string, Limiter>,
  url: string,
  limit: RateLimit,
): onRequestHookHandler {
  return async (request) => {
    // Created on first use: the rate-limit plugin's decorators exist once the app is ready. Counters are
    // per path, so a GET route and the HEAD route Fastify adds for it share one budget.
    let check = limiters.get(url);
    if (check === undefined) {
      check = app.createRateLimit(limit);
      limiters.set(url, check);
    }
    const result = await check(request);
    if (!result.isAllowed && result.isExceeded) {
      throw new ApiError('RATE_LIMITED', { retryAfterSeconds: result.ttlInSeconds });
    }
  };
}

function toApiError(error: FastifyError | Error): ApiError | null {
  if (error instanceof ApiError) return error;
  // Repository errors carry a contract code; their messages name tables, so the default message is sent.
  if (error instanceof DbError) return new ApiError(error.code);
  if (error instanceof ZodError) {
    return new ApiError('VALIDATION', {
      issues: error.issues.map((i) => ({
        path: i.path.map((key) => (typeof key === 'symbol' ? String(key) : key)),
        message: i.message,
      })),
    });
  }
  const fastifyError = error as FastifyError;
  if (fastifyError.validation) {
    return new ApiError('VALIDATION', {
      issues: fastifyError.validation.map((v) => ({
        path: v.instancePath.split('/').filter((key) => key !== ''),
        message: v.message ?? 'Not valid.',
      })),
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
 * Installs auth on the app: the API-wide rate limit, the session cookie parser, the per-route context hook, `req.ctx`, and the error
 * and not-found handlers that render `ErrorEnvelope`s. Call it in `buildServer` before any route.
 */
export function registerAuth(app: FastifyInstance, options: AuthOptions): void {
  void app.register(fastifyCookie);

  // Every request is rate limited per client IP, before the session is looked up, so guessing session
  // tokens is throttled too. Login, magic link and invite routes add stricter per-route limits
  // (`config.routeLimit`). The limiter is created on first use because the plugin loads asynchronously.
  void app.register(fastifyRateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) =>
      new ApiError('RATE_LIMITED', { retryAfterSeconds: Math.ceil(context.ttl / 1000) }),
  });
  let limiter: ReturnType<FastifyInstance['rateLimit']> | undefined;
  app.addHook('onRequest', async function (request, reply) {
    limiter ??= app.rateLimit(options.rateLimit ?? DEFAULT_RATE_LIMIT);
    await limiter.call(this, request, reply);
  });

  app.decorateRequest('ctx', {
    getter(this: FastifyRequest) {
      const ctx = contexts.get(this);
      if (ctx === undefined) {
        throw new Error('req.ctx is only available on routes with config.auth "session"');
      }
      return ctx;
    },
  });

  const routeLimiters = new Map<string, Limiter>();
  app.addHook('onRoute', (route) => {
    const auth = route.config?.auth;
    if (auth === undefined || !ROUTE_AUTH.includes(auth)) {
      throw new Error(
        `${String(route.method)} ${route.url}: declare config.auth (${ROUTE_AUTH.join(', ')})`,
      );
    }
    // The plugin's own per-route `config.rateLimit` would never fire behind the API-wide limiter.
    if (route.config?.rateLimit !== undefined) {
      throw new Error(
        `${String(route.method)} ${route.url}: use config.routeLimit, not config.rateLimit`,
      );
    }
    const existing = route.onRequest ?? [];
    route.onRequest = [
      ...(route.config?.routeLimit
        ? [routeLimitHook(app, routeLimiters, route.url, route.config.routeLimit)]
        : []),
      ...(auth === 'public' ? [] : [sessionHook(options, auth)]),
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

/**
 * Throws `FORBIDDEN` unless `can()` allows the action for the request's actor. On a `session-pre-mfa`
 * route whose actor still owes MFA it throws `MFA_REQUIRED`: those routes only complete MFA.
 */
export function authorize(request: FastifyRequest, action: Action, resource: Resource): void {
  const pending = mfaPending.get(request);
  if (pending) throw new ApiError('MFA_REQUIRED', pending);
  if (!can(request.ctx, action, resource)) throw new ApiError('FORBIDDEN', { action });
}

/** Throws `NOT_FOUND` when a client (from a body or a loaded row) is outside the actor's clients. */
export function requireClient(ctx: RequestContext, clientId: string): void {
  if (!ctx.clientIds.includes(clientId)) throw new ApiError('NOT_FOUND');
}
