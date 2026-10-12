// The mock API: every endpoint in ENDPOINTS, served from the fixtures under /api/v1, with the same validation,
// role checks, error envelope, CSRF and Idempotency-Key rules a provider must follow (api-conventions.md).
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { ENDPOINTS, type Endpoint } from '../api/endpoints.js';
import { ApiErrorResponse } from '../api/error-details.js';
import { SESSION_COOKIE } from '../api/openapi.js';
import { ERROR_HTTP_STATUS } from '../errors.js';
import {
  actorFor,
  type Actor,
  authorize,
  type Clock,
  makeClock,
  MockError,
  type Scope,
} from './core.js';
import type { EndpointId, HandlerContext, Handlers } from './handler.js';
import { authHandlers } from './handlers/auth.js';
import { dashboardHandlers } from './handlers/dashboards.js';
import { entityHandlers } from './handlers/entities.js';
import { importHandlers } from './handlers/imports.js';
import { workHandlers } from './handlers/work.js';
import { activeMemberships, isFirmRole, MockStore, type Session } from './store.js';

export const MOCK_BASE_PATH = '/api/v1';

/** One handler per endpoint; the type fails to compile if an endpoint has none. */
export const HANDLERS: Handlers = {
  ...authHandlers,
  ...entityHandlers,
  ...workHandlers,
  ...importHandlers,
  ...dashboardHandlers,
};

export interface MockServerOptions {
  /** Pin "today" (client time zone) for derived status, e.g. "2023-03-15". Defaults to the real date. */
  today?: string;
  /** Check every response against the endpoint's schema and answer 500 INTERNAL if it does not match. */
  validateResponses?: boolean;
  store?: MockStore;
}

/** Endpoints a firm-role session may call before passing MFA. */
const BEFORE_MFA = new Set<EndpointId>(['getMe', 'logout', 'enrollMfa', 'verifyMfa']);

function cookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function validation(error: z.ZodError, prefix: string): MockError {
  return new MockError('VALIDATION', 'The request is not valid', {
    issues: error.issues.map((issue) => ({
      path: [prefix, ...issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p))],
      message: issue.message,
    })),
  });
}

/** The signed-in actor from the session cookie, or from `X-Mock-Person` (person id or email; tests and scripts). */
function resolveActor(store: MockStore, request: FastifyRequest, clock: Clock): Actor | null {
  const now = clock.now();
  const asPerson = header(request, 'x-mock-person');
  let session: Session | undefined;
  if (asPerson !== undefined) {
    const found = asPerson.includes('@')
      ? store.findByEmail(asPerson)[0]
      : store.findPerson(asPerson);
    if (found === undefined) return null;
    session = store.openSession(found.firm.data.firm.id, found.person.id, true, now);
    store.sessions.delete(session.id);
  } else {
    const id = cookie(request, SESSION_COOKIE);
    session = id === undefined ? undefined : store.sessions.get(id);
  }
  if (session === undefined) return null;
  const firm = store.firm(session.firmId);
  const person = firm.data.people.find((p) => p.id === session.personId && p.archivedAt === null);
  if (person === undefined || person.status === 'DISABLED') return null;
  return actorFor(firm, session, person, now);
}

function sendError(reply: FastifyReply, requestId: string, error: MockError): FastifyReply {
  const body = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
    requestId,
  };
  return reply.code(ERROR_HTTP_STATUS[error.code]).send(ApiErrorResponse.parse(body));
}

export function createMockServer(
  options: MockServerOptions = {},
): FastifyInstance & { store: MockStore } {
  const store = options.store ?? new MockStore();
  const clock = makeClock(options.today);
  const validateResponses = options.validateResponses ?? true;
  // No request logging: URLs can carry invite tokens, and evidence names are personal data.
  const app = Fastify({ logger: false });

  // Write endpoints with no body may be sent with or without a JSON content type.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(
        new MockError('VALIDATION', 'Body is not valid JSON', {
          issues: [{ path: ['body'], message: 'Invalid JSON' }],
        }),
      );
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    const requestId = header(request, 'x-request-id') ?? store.token('req');
    (request as FastifyRequest & { requestId: string }).requestId = requestId;
    void reply.header('x-request-id', requestId);
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = (request as FastifyRequest & { requestId: string }).requestId;
    if (error instanceof MockError) return sendError(reply, requestId, error);
    return sendError(reply, requestId, new MockError('INTERNAL', 'Mock server error'));
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(
      reply,
      (request as FastifyRequest & { requestId: string }).requestId,
      new MockError('NOT_FOUND', 'Not found'),
    ),
  );

  for (const [id, ep] of Object.entries(ENDPOINTS) as [EndpointId, Endpoint][]) {
    const url = MOCK_BASE_PATH + ep.path.replace(/\{(\w+)\}/g, ':$1');
    app.route({
      method: ep.method,
      url,
      handler: async (request, reply) => {
        const requestId = (request as FastifyRequest & { requestId: string }).requestId;
        const actor = ep.auth === 'public' ? null : resolveActor(store, request, clock);
        if (ep.auth !== 'public') {
          if (actor === null) throw new MockError('UNAUTHENTICATED', 'Sign in to continue');
          if (!actor.session.mfaSatisfied && !BEFORE_MFA.has(id)) {
            throw new MockError('MFA_REQUIRED', 'Enter your authenticator code', {
              enrolled: true,
            });
          }
          if (
            ep.method !== 'GET' &&
            !actor.session.viaHeader &&
            header(request, 'x-csrf-token') !== actor.session.csrfToken
          ) {
            throw new MockError('FORBIDDEN', 'Missing or wrong CSRF token', {
              action: ep.actions[0] ?? 'session.csrf',
            });
          }
        }

        const params = ep.params?.safeParse(request.params ?? {});
        if (params !== undefined && !params.success) throw validation(params.error, 'params');
        const query = ep.query?.safeParse(request.query ?? {});
        if (query !== undefined && !query.success) throw validation(query.error, 'query');
        const body = ep.body?.safeParse(request.body ?? {});
        if (body !== undefined && !body.success) throw validation(body.error, 'body');

        const idempotencyKey = ep.idempotent ? header(request, 'idempotency-key') : undefined;
        const cacheKey =
          idempotencyKey === undefined ? undefined : `${actor?.person.id}:${id}:${idempotencyKey}`;
        const cached = cacheKey === undefined ? undefined : store.idempotency.get(cacheKey);
        if (cached !== undefined) return reply.code(cached.status).send(cached.body);

        let authorized = ep.auth !== 'action';
        const ctx: HandlerContext<EndpointId> = {
          store,
          clock,
          requestId,
          actor,
          params: (params?.data ?? {}) as Record<string, string>,
          query: query?.data as never,
          body: body?.data as never,
          authorize(scope: Scope) {
            authorize(actor!, ep, scope);
            authorized = true;
          },
          setSession(session: Session | null) {
            void reply.header(
              'set-cookie',
              session === null
                ? `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
                : `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Lax`,
            );
          },
        };
        const result = (HANDLERS[id] as (c: HandlerContext<EndpointId>) => unknown)(ctx);
        if (!authorized) throw new Error(`${id} did not run the role check`);
        if (validateResponses) {
          const checked = ep.response.safeParse(result);
          if (!checked.success) {
            console.error(
              `mock: ${id} response does not match its schema`,
              checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            );
            throw new Error(`${id} response does not match its schema`);
          }
        }
        const json = result === null ? undefined : JSON.parse(JSON.stringify(result));
        if (cacheKey !== undefined)
          store.idempotency.set(cacheKey, { status: ep.status, body: json });
        return reply.code(ep.status).send(json);
      },
    });
  }

  // Mock-only helpers, outside the contract.
  app.get('/__mock/outbox', async () => ({ items: store.outbox }));
  app.post('/__mock/reset', async (_request, reply) => {
    store.reset();
    return reply.code(204).send();
  });
  /** Who can sign in, for a dev login picker. Emails are fixture addresses on reserved .example domains. */
  app.get('/__mock/people', async () => ({
    items: store.firms.flatMap((firm) =>
      firm.data.people
        .filter((p) => p.status === 'ACTIVE')
        .map((p) => ({
          id: p.id,
          firm: firm.data.firm.name,
          displayName: p.displayName,
          email: p.email,
          roles: activeMemberships(firm, p.id, clock.now()).map((m) => m.role),
          mfa: activeMemberships(firm, p.id, clock.now()).some((m) => isFirmRole(m.role)),
        })),
    ),
  }));

  return Object.assign(app, { store });
}
