// The console's client for the operator API (ADR M15-0001 decision 9, ADR M15-0003). It runs in the browser: the
// `op_sid` cookie is HttpOnly with Path=/api/platform, so only requests to /api/platform carry it, and next.config.ts
// forwards that path to the API. Methods, paths and schemas come from the contracts' PLATFORM_ENDPOINTS table, and
// every response is parsed with its schema.
import { ErrorCode, ErrorEnvelope, PLATFORM_ENDPOINTS, type Endpoint } from '@canopy/contracts';
import type { z } from 'zod';

export const PLATFORM_PREFIX = '/api/platform/v1';

export class OperatorApiError extends Error {
  constructor(
    readonly status: number,
    /** Branch on this, never on `message`. `UNKNOWN` = not a contract error body (or no answer at all). */
    readonly code: ErrorCode | 'UNKNOWN',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OperatorApiError';
  }
}

export function isOperatorApiError(
  error: unknown,
  ...codes: (ErrorCode | 'UNKNOWN')[]
): error is OperatorApiError {
  return error instanceof OperatorApiError && (codes.length === 0 || codes.includes(error.code));
}

export type PlatformEndpointName = keyof typeof PLATFORM_ENDPOINTS;
type EndpointOf<N extends PlatformEndpointName> = (typeof PLATFORM_ENDPOINTS)[N];
type InputOf<S> = S extends z.ZodType ? z.input<S> : never;

export type PlatformRequest<N extends PlatformEndpointName> = {
  params?: Record<string, string>;
  query?: InputOf<EndpointOf<N>['query']>;
  body?: InputOf<EndpointOf<N>['body']>;
  /** For the two creating routes: the same key on a retry returns the first answer (ADR M15-0003 decision 3). */
  idempotencyKey?: string;
};

export type PlatformResponse<N extends PlatformEndpointName> = z.output<EndpointOf<N>['response']>;

/** `?status=TRIAL&q=kestrel`: undefined and empty values left out. */
export function queryString(query: Record<string, unknown> | undefined): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new TypeError(`Query parameter ${key} must be a scalar`);
    }
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export type OperatorClientOptions = {
  fetch?: typeof fetch;
  /** From GET /me; sent as X-CSRF-Token on every state-changing request. */
  csrfToken?: () => string | undefined;
  /** Called on 401 from any route but sign-in, so the console can send the operator back to it. */
  onSignedOut?: () => void;
};

export function createOperatorClient(options: OperatorClientOptions = {}) {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function call<N extends PlatformEndpointName>(
    name: N,
    request: PlatformRequest<N> = {},
  ): Promise<PlatformResponse<N>> {
    const endpoint: Endpoint = PLATFORM_ENDPOINTS[name];
    const path = endpoint.path.replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = request.params?.[key];
      if (value === undefined) throw new Error(`Missing path parameter ${key}`);
      return encodeURIComponent(value);
    });
    const headers: Record<string, string> = { accept: 'application/json' };
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    const csrf = options.csrfToken?.();
    if (endpoint.method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
    if (request.idempotencyKey) headers['idempotency-key'] = request.idempotencyKey;

    let res: Response;
    try {
      res = await doFetch(
        `${PLATFORM_PREFIX}${path}${queryString(request.query as Record<string, unknown>)}`,
        {
          method: endpoint.method,
          headers,
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          credentials: 'same-origin',
          cache: 'no-store',
        },
      );
    } catch {
      throw new OperatorApiError(0, 'UNKNOWN', 'The console could not reach the server.');
    }
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const envelope = ErrorEnvelope.safeParse(json);
      const error = envelope.success
        ? new OperatorApiError(
            res.status,
            envelope.data.error.code,
            envelope.data.error.message,
            envelope.data.error.details,
          )
        : new OperatorApiError(res.status, 'UNKNOWN', `Request failed with ${res.status}`);
      if (res.status === 401 && name !== 'operatorLogin') options.onSignedOut?.();
      throw error;
    }
    // 202 and 204 have no body; the contract's NoContent is null.
    const parsed = endpoint.response.safeParse(json ?? null);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new OperatorApiError(
        res.status,
        'UNKNOWN',
        `Unexpected response from ${endpoint.method} ${path}: ${issues}`,
      );
    }
    return parsed.data as PlatformResponse<N>;
  }

  return { call };
}

export type OperatorClient = ReturnType<typeof createOperatorClient>;

/** What to show for a failed call: the API's own message, which never carries personal data. */
export function errorMessage(error: unknown): string {
  if (isOperatorApiError(error, 'STALE_VERSION')) {
    return 'Someone changed this account since you opened it. Reload it and try again.';
  }
  if (isOperatorApiError(error)) return error.message;
  return 'Something went wrong. Try again.';
}

/** The field errors of a 400 VALIDATION answer, by the last segment of each path ("body.owner.email" → "email"). */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!isOperatorApiError(error, 'VALIDATION')) return {};
  const issues = (error.details?.issues ?? []) as { path?: unknown[]; message?: string }[];
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path?.filter((p) => p !== 'body' && p !== 'query').join('.');
    if (key && issue.message && !(key in out)) out[key] = issue.message;
  }
  return out;
}
