// Typed API client (MODULES.md M11). Every response is parsed with its schema, so drift between the web app and the
// API (or the mock) fails loudly at the boundary instead of rendering wrong data. Methods, paths, bodies and response
// schemas come from the contracts' endpoint table. Errors follow api-conventions.md §4.
import {
  ENDPOINTS,
  ErrorCode,
  ErrorEnvelope,
  type Endpoint,
  type InviteAcceptBody,
  type LoginBody,
} from '@canopy/contracts';
import type { z } from 'zod';

export const API_PREFIX = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** Branch on this, never on `message` (api-conventions.md §4). `UNKNOWN` = not a contract error body. */
    readonly code: ErrorCode | 'UNKNOWN',
    message: string,
    readonly details?: Record<string, unknown>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isApiError(error: unknown, ...codes: (ErrorCode | 'UNKNOWN')[]): error is ApiError {
  return error instanceof ApiError && (codes.length === 0 || codes.includes(error.code));
}

export type ApiClientOptions = {
  /** Origin of the API, e.g. "http://localhost:4000". The `/api/v1` prefix is added here. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Cookie header forwarded from the browser request (server-side calls). */
  cookie?: string;
  /** From GET /me; required on state-changing requests. */
  csrfToken?: string;
  requestId?: string;
};

export type ApiResult<T> = { data: T; setCookies: string[] };

export type EndpointName = keyof typeof ENDPOINTS;
type EndpointOf<N extends EndpointName> = (typeof ENDPOINTS)[N];
type InputOf<S> = S extends z.ZodType ? z.input<S> : never;

/** What `call(name, request)` sends: path params by name, the query as its contract input, and the body. */
export type CallRequest<N extends EndpointName> = {
  params?: Record<string, string>;
  query?: InputOf<EndpointOf<N>['query']>;
  body?: InputOf<EndpointOf<N>['body']>;
};

export type CallResponse<N extends EndpointName> = z.output<EndpointOf<N>['response']>;

/** `?a=1&status=OVERDUE,DUE_SOON`: arrays comma-separated, undefined and null left out (api-conventions.md §3). */
export function queryString(query: Record<string, unknown> | undefined): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    search.set(key, Array.isArray(value) ? value.map(String).join(',') : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function send<S extends z.ZodType>(
    endpoint: Pick<Endpoint, 'method' | 'path'>,
    schema: S,
    request: { params?: Record<string, string>; query?: unknown; body?: unknown } = {},
  ): Promise<ApiResult<z.output<S>>> {
    const { method } = endpoint;
    const { body } = request;
    const path = endpoint.path.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = request.params?.[name];
      if (value === undefined) throw new Error(`Missing path parameter ${name}`);
      return encodeURIComponent(value);
    });
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.cookie) headers.cookie = options.cookie;
    if (options.requestId) headers['x-request-id'] = options.requestId;
    if (method !== 'GET' && options.csrfToken) headers['x-csrf-token'] = options.csrfToken;

    const query = queryString(request.query as Record<string, unknown> | undefined);
    const res = await doFetch(`${base}${API_PREFIX}${path}${query}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      redirect: 'manual',
    });
    const requestId = res.headers.get('x-request-id') ?? undefined;
    const json: unknown = await res.json().catch(() => undefined);

    if (!res.ok) {
      const envelope = ErrorEnvelope.safeParse(json);
      if (envelope.success) {
        const { code, message, details } = envelope.data.error;
        throw new ApiError(res.status, code, message, details, requestId);
      }
      throw new ApiError(
        res.status,
        'UNKNOWN',
        `Request failed with ${res.status}`,
        undefined,
        requestId,
      );
    }

    // 202 and 204 have no body; the contract's NoContent is null.
    const parsed = schema.safeParse(json ?? null);
    if (!parsed.success) {
      // Messages only: the body may hold personal data, so it is never put in the error (root rule 6).
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new ApiError(
        res.status,
        'UNKNOWN',
        `Unexpected response from ${method} ${path}: ${issues}`,
        undefined,
        requestId,
      );
    }
    return { data: parsed.data, setCookies: res.headers.getSetCookie?.() ?? [] };
  }

  /** Any endpoint in the contracts' table by name, e.g. `call('getInstance', { params: { id } })`. */
  function call<N extends EndpointName>(
    name: N,
    request: CallRequest<N> = {},
  ): Promise<ApiResult<CallResponse<N>>> {
    const endpoint: Endpoint = ENDPOINTS[name];
    return send(endpoint, endpoint.response, request) as Promise<ApiResult<CallResponse<N>>>;
  }

  const token = (value: string) => ({ params: { token: value } });

  return {
    call,
    me: () => call('getMe'),
    portfolio: () => call('portfolio'),
    login: (body: LoginBody) => call('login', { body }),
    requestMagicLink: (email: string) => call('requestMagicLink', { body: { email } }),
    verifyMagicLink: (value: string) => call('verifyMagicLink', { body: { token: value } }),
    verifyMfa: (code: string) => call('verifyMfa', { body: { code } }),
    logout: () => call('logout'),
    invite: (value: string) => call('getInvite', token(value)),
    acceptInvite: (value: string, body: InviteAcceptBody) =>
      call('acceptInvite', { ...token(value), body }),
    /** SUBMITTED instances waiting on the signed-in person, for the Approvals badge. */
    approvalsWaiting: async () => {
      const { data } = await call('myApprovals', { query: { limit: '1', count: 'true' } });
      return data.total ?? data.items.length;
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
