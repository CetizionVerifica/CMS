// Typed API client (MODULES.md M11). Every response is parsed with its schema, so drift between the web app and the
// API (or the mock) fails loudly at the boundary instead of rendering wrong data. Errors follow api-conventions.md §4.
import { ErrorCode, ErrorEnvelope, PortfolioRow } from '@canopy/contracts';
import { z } from 'zod';

import { Accepted, InvitePreview, MeResponse, type LoginRequest } from './types';

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

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function call<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<ApiResult<z.output<S>>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.cookie) headers.cookie = options.cookie;
    if (options.requestId) headers['x-request-id'] = options.requestId;
    if (method !== 'GET' && options.csrfToken) headers['x-csrf-token'] = options.csrfToken;

    const res = await doFetch(`${base}${API_PREFIX}${path}`, {
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

    const parsed = schema.safeParse(json);
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

  const id = (value: string) => encodeURIComponent(value);

  return {
    me: () => call('GET', '/me', MeResponse),
    portfolio: () => call('GET', '/portfolio', z.array(PortfolioRow)),
    login: (body: LoginRequest) => call('POST', '/auth/login', Accepted, body),
    requestMagicLink: (email: string) => call('POST', '/auth/magic-link', Accepted, { email }),
    verifyMagicLink: (token: string) =>
      call('POST', '/auth/magic-link/verify', Accepted, { token }),
    verifyMfa: (code: string) => call('POST', '/auth/mfa/verify', Accepted, { code }),
    logout: () => call('POST', '/auth/logout', Accepted, {}),
    invite: (token: string) => call('GET', `/invites/${id(token)}`, InvitePreview),
    acceptInvite: (token: string, body: { email: string; password: string }) =>
      call('POST', `/invites/${id(token)}/accept`, Accepted, body),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
