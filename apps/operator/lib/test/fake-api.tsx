// A fake operator API for the screen tests: answers by method and path, records each request, and renders a screen
// inside a signed-in SessionProvider. Data is fictional (root CLAUDE.md).
import type { Account, OperatorMe, Plan } from '@canopy/contracts';
import { Toaster } from '@canopy/ui';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

import { SessionProvider } from '../session';

export type Sent = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
};

type Answer = { status?: number; body?: unknown };
type Reply = Answer | ((sent: Sent) => Answer);

export const ME: OperatorMe = {
  operator: {
    id: '01900000-0000-7000-8000-0000000000a1',
    email: 'ops@planetpulse.example',
    displayName: 'Meera Iyer',
    createdAt: '2026-10-01T00:00:00.000Z',
    disabledAt: null,
  },
  csrfToken: 'csrf-token-for-tests-0001',
  session: { expiresAt: '2026-10-24T14:00:00.000Z', idleExpiresAt: '2026-10-24T10:30:00.000Z' },
};

export const PLANS: Plan[] = [
  {
    code: 'STARTER',
    name: 'Starter',
    limits: { companies: 1, units: 3, users: 10, storageBytes: null },
    features: [],
    retiredAt: null,
  },
  {
    code: 'BUSINESS',
    name: 'Business',
    limits: { companies: 5, units: 25, users: 150, storageBytes: null },
    features: ['importer'],
    retiredAt: null,
  },
  {
    code: 'LEGACY',
    name: 'Legacy',
    limits: { companies: 2, units: 5, users: 20, storageBytes: null },
    features: [],
    retiredAt: '2026-01-01T00:00:00.000Z',
  },
];

export function account(over: Partial<Account> = {}): Account {
  return {
    id: '01900000-0000-7000-8000-0000000000b1',
    name: 'Kestrel Metals Group',
    kind: 'ENTERPRISE',
    status: 'TRIAL',
    profile: {
      legalName: 'Kestrel Metals Group Private Limited',
      gstin: null,
      timeZone: 'Asia/Kolkata',
      fyStartMonth: 4,
    },
    planCode: 'BUSINESS',
    entitlements: { planCode: 'BUSINESS', limits: PLANS[1]!.limits, features: ['importer'] },
    usage: { companies: 1, units: 4, users: 150, storageBytes: 2048 },
    trialEndsOn: '2026-11-23' as Account['trialEndsOn'],
    libraryCopiedAt: '2026-10-24T03:31:00.000Z',
    onboardedAt: null,
    deletionRequestedAt: null,
    purgeAfter: null,
    createdAt: '2026-10-24T03:30:00.000Z',
    version: 3,
    ...over,
  };
}

const PREFIX = '/api/platform/v1';

/** Routes are "METHOD /path" with `{id}` style placeholders matching one segment. */
export function fakeApi(routes: Record<string, Reply>) {
  const sent: Sent[] = [];
  const table = Object.entries({ 'GET /me': { body: ME }, ...routes }).map(([key, reply]) => {
    const [method, path] = key.split(' ') as [string, string];
    const pattern = new RegExp(`^${path.replace(/\{\w+\}/g, '[^/]+')}$`);
    return { method, pattern, reply };
  });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://console.example');
    const path = url.pathname.slice(PREFIX.length);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const s: Sent = {
      method,
      path,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body,
    };
    sent.push(s);
    const route = table.find((r) => r.method === method && r.pattern.test(path));
    const reply: Answer = route
      ? typeof route.reply === 'function'
        ? (route.reply as (sent: Sent) => Answer)(s)
        : (route.reply as Answer)
      : {
          status: 404,
          body: { error: { code: 'NOT_FOUND', message: 'Not found.' }, requestId: 'r' },
        };
    const status = reply.status ?? 200;
    return new Response(
      status === 204 || reply.body === undefined ? null : JSON.stringify(reply.body),
      {
        status,
        headers: { 'content-type': 'application/json' },
      },
    );
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

export function apiError(status: number, code: string, message: string, details?: unknown) {
  return {
    status,
    body: { error: { code, message, ...(details ? { details } : {}) }, requestId: 'req-1' },
  };
}

/** Renders `ui` once the fake session has loaded; find its content with `findBy…`. */
export function renderSignedIn(
  ui: ReactElement,
  fetch: typeof globalThis.fetch,
  navigate = vi.fn(),
) {
  const view = render(
    <SessionProvider path="/accounts" navigate={navigate} fetchImpl={fetch}>
      {(state) =>
        state.state === 'ready' ? (
          <>
            {ui}
            <Toaster />
          </>
        ) : (
          <p>loading session</p>
        )
      }
    </SessionProvider>,
  );
  return { ...view, navigate };
}

export const list = <T,>(items: T[]) => ({ body: { items } });
export const page = <T,>(items: T[], nextCursor: string | null = null) => ({
  body: { items, nextCursor },
});
