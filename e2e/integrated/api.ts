import { randomUUID } from 'node:crypto';

import { request, type APIRequestContext } from '@playwright/test';

import { visit } from './helpers.js';
import { API_URL, addressOf, storageStateOf, type AccountKey } from './stack.js';

// Direct calls to the real API as a signed-in account, with the session the setup project saved: for steps whose
// screens have not shipped yet, and for the security checks, which must see the API's own answers.

export interface ApiSession {
  readonly http: APIRequestContext;
  readonly csrfToken: string;
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  dispose(): Promise<void>;
}

async function wrap(http: APIRequestContext, csrfToken: string): Promise<ApiSession> {
  const parse = async (res: Awaited<ReturnType<APIRequestContext['get']>>) => {
    const text = await res.text();
    return { status: res.status(), body: text ? (JSON.parse(text) as unknown) : null };
  };
  return {
    http,
    csrfToken,
    get: async (path) => parse(await http.get(`/api/v1${path}`)),
    post: async (path, body) =>
      parse(
        await http.post(`/api/v1${path}`, {
          headers: { 'x-csrf-token': csrfToken, 'idempotency-key': randomUUID() },
          ...(body === undefined ? {} : { data: body }),
        }),
      ),
    dispose: () => http.dispose(),
  };
}

/**
 * The API as `key`, signed in with the browser state from auth.setup.ts. `address` picks another of the journey's
 * addresses (stack.ts `addressOf`), for a sweep that makes more calls than one address may per minute.
 */
export async function apiAs(key: AccountKey, address = 0): Promise<ApiSession> {
  const http = await request.newContext({
    baseURL: API_URL,
    storageState: storageStateOf(key),
    extraHTTPHeaders: { 'x-forwarded-for': addressOf(key, visit() + address) },
  });
  const me = await http.get('/api/v1/me');
  if (!me.ok()) throw new Error(`GET /me as ${key}: ${me.status()}`);
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  return wrap(http, csrfToken);
}

/** The API with no session at all. */
export async function anonymousApi(): Promise<ApiSession> {
  const http = await request.newContext({ baseURL: API_URL });
  return wrap(http, 'no-session-csrf-token');
}

export interface Row {
  id: string;
  version: number;
  title: string;
  externalRef: string | null;
  workflowState: string;
  ownerId: string;
  approverId: string;
  dueDate: string;
}

export const itemsOf = (body: unknown) => (body as { items: Row[] }).items;
