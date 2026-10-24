// In-process demo API, used while `CANOPY_API_URL` is unset (local dev and e2e). It answers the routes the shell calls
// (sign-in, /me, the portfolio, the approvals count) with the same status codes and error envelopes the real API
// uses, so the client code is identical either way, and hands every other route to M0's mock server
// (mock-delegate.ts). People are pseudonyms (fixtures.md §5); nothing here is real data.
import {
  DEFAULT_CLIENT_SETTINGS,
  DerivedStatus,
  LocalDate,
  type Client,
  type ErrorCode,
  type ClientPeriods,
  type InvitePreview,
  type Me,
  type Membership,
  type Person,
  type PortfolioRow,
  type Role,
} from '@canopy/contracts';

import { FIRM_B_AS_OF } from '@canopy/contracts/fixtures';

import { delegateToM0 } from './mock-delegate';

export const MOCK_PASSWORD = 'demo-password';
export const MOCK_MFA_CODE = '123456';
/** Tokens are at least 16 characters (contracts `InviteTokenParams`). */
export const MOCK_INVITE_TOKEN = 'demo-invite-0001';
export const SESSION_COOKIE = 'pp_session';
/** What GET /me/approvals counts for an approver, so the Approvals badge shows in the demo. */
export const MOCK_APPROVALS_WAITING = 3;

const FIRM_ID = '00000000-0000-5000-8000-0000000000f1';
/**
 * Firms `MOCK_TWO_FIRM_EMAIL` signs in to, so the sign-in form's firm choice can be tried. The demo has one firm's
 * data, so either choice opens the same demo firm.
 */
export const MOCK_FIRMS = [
  { id: FIRM_ID, name: 'Demo Advisory' },
  { id: '00000000-0000-5000-8000-0000000000f2', name: 'Demo Partners' },
] as const;
export const MOCK_TWO_FIRM_EMAIL = 'twofirms@demo.test';
const T = '2026-01-01T00:00:00.000Z';
const base = { firmId: FIRM_ID, createdAt: T, updatedAt: T, archivedAt: null, version: 1 };
const uid = (n: number) => `00000000-0000-5000-8000-${n.toString(16).padStart(12, '0')}`;

export const MOCK_CLIENTS = {
  demoMetals: uid(0x101),
  northwind: uid(0x102),
  sunrise: uid(0x103),
} as const;

const clients: Client[] = [
  { ...base, id: MOCK_CLIENTS.demoMetals, name: 'Demo Metals', settings: DEFAULT_CLIENT_SETTINGS },
  {
    ...base,
    id: MOCK_CLIENTS.northwind,
    name: 'Northwind Textiles',
    // Firm B's Harbour Retail Group (mock-delegate.ts) keeps a January financial year.
    settings: { ...DEFAULT_CLIENT_SETTINGS, fyStartMonth: 1 },
  },
  { ...base, id: MOCK_CLIENTS.sunrise, name: 'Sunrise Foods', settings: DEFAULT_CLIENT_SETTINGS },
];

/**
 * The period the demo opens on: the one holding M0's firm B "today" (FIRM_B_AS_OF, 2024-11-15), so the client pages
 * that M0's mock answers (mock-delegate.ts) show firm B's data rather than an empty period.
 */
const DEMO_PERIOD: ClientPeriods = {
  current: { fy: '2024-25', quarter: 3 },
  availableFys: ['2022-23', '2023-24', '2024-25'],
  availableUntil: '2025-03',
};

const shellInfo: Record<string, { unitCount: number; period: ClientPeriods }> = {
  [MOCK_CLIENTS.demoMetals]: {
    unitCount: 3,
    period: DEMO_PERIOD,
  },
  [MOCK_CLIENTS.northwind]: {
    unitCount: 1,
    // A January FY: FIRM_B_AS_OF falls in its Q4, and Harbour's data runs through calendar 2024, as M0 reports it.
    period: {
      current: { fy: '2024-25', quarter: 4 },
      availableFys: ['2024-25'],
      availableUntil: '2024-12',
    },
  },
  [MOCK_CLIENTS.sunrise]: {
    unitCount: 5,
    // No data at all, so only the year holding FIRM_B_AS_OF, as M0 reports a client without instances.
    period: { current: DEMO_PERIOD.current, availableFys: ['2024-25'], availableUntil: null },
  },
};

const overdue: Record<string, number> = {
  [MOCK_CLIENTS.demoMetals]: 5,
  [MOCK_CLIENTS.northwind]: 0,
  [MOCK_CLIENTS.sunrise]: 12,
};

type MockUser = { person: Person; memberships: Membership[] };

function user(n: number, name: string, email: string, roles: [Role, string | null][]): MockUser {
  const id = uid(0x200 + n);
  return {
    person: {
      ...base,
      id,
      displayName: name,
      nameNormalized: name.toLowerCase(),
      email,
      status: 'ACTIVE',
    },
    memberships: roles.map(([role, clientId], i) => ({
      ...base,
      id: uid(0x300 + n * 10 + i),
      personId: id,
      role,
      clientId,
      consultantClientIds:
        role === 'CONSULTANT' ? [MOCK_CLIENTS.demoMetals, MOCK_CLIENTS.northwind] : null,
      unitIds: null,
      expiresAt: role === 'VIEWER' ? '2099-01-01T00:00:00.000Z' : null,
    })),
  };
}

/** Demo accounts, one per kind of user the shell treats differently. Password for all: MOCK_PASSWORD. */
export const MOCK_USERS: MockUser[] = [
  user(1, 'Consultant 01', 'consultant@demo.test', [['CONSULTANT', null]]),
  user(2, 'Firm Admin 01', 'admin@demo.test', [['FIRM_ADMIN', null]]),
  user(3, 'Owner 01', 'owner@demo.test', [['OWNER', MOCK_CLIENTS.demoMetals]]),
  user(4, 'Approver 01', 'approver@demo.test', [['APPROVER', MOCK_CLIENTS.demoMetals]]),
  user(5, 'Consultant 02', MOCK_TWO_FIRM_EMAIL, [['CONSULTANT', null]]),
];

function visibleClientIds(u: MockUser): string[] {
  const ids = new Set<string>();
  for (const m of u.memberships) {
    if (m.role === 'FIRM_ADMIN') clients.forEach((c) => ids.add(c.id));
    else if (m.role === 'CONSULTANT') m.consultantClientIds?.forEach((c) => ids.add(c));
    else if (m.clientId) ids.add(m.clientId);
  }
  return [...ids];
}

const isFirmUser = (u: MockUser) =>
  u.memberships.some((m) => m.role === 'FIRM_ADMIN' || m.role === 'CONSULTANT');

// Session cookie: "<personId>.<mfa 0|1>". Mock only; the real API issues opaque, server-side sessions.
function sessionUser(cookieHeader: string | null): { user: MockUser; mfa: boolean } | undefined {
  const value = cookieHeader
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  const [personId, mfa] = decodeURIComponent(value ?? '').split('.');
  const found = MOCK_USERS.find((u) => u.person.id === personId);
  return found ? { user: found, mfa: mfa === '1' } : undefined;
}

function sessionCookie(value: string, maxAge = 60 * 60 * 8): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function json(status: number, body: unknown, setCookie?: string): Response {
  const headers = new Headers({ 'x-request-id': 'mock' });
  if (body !== null) headers.set('content-type', 'application/json; charset=utf-8');
  if (setCookie) headers.append('set-cookie', setCookie);
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

/** The contract's `Me`: GET /me, login, magic-link verify, MFA verify and invite accept all return it. */
function meBody(u: MockUser, mfa: boolean): Me {
  const ids = visibleClientIds(u);
  const firm = isFirmUser(u);
  return {
    person: u.person,
    memberships: u.memberships,
    clients: clients
      .filter((c) => ids.includes(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        fyStartMonth: c.settings.fyStartMonth,
        timeZone: c.settings.timeZone,
        ...shellInfo[c.id]!,
      })),
    csrfToken: `mock-csrf-${u.person.id}`,
    // As the API: `satisfied` is whether this session passed MFA, so a client user's stays false.
    mfa: { required: firm, enrolled: firm, satisfied: firm && mfa },
  };
}

function fail(status: number, code: ErrorCode, message: string, details?: Record<string, unknown>) {
  return json(status, {
    error: { code, message, ...(details ? { details } : {}) },
    requestId: 'mock',
  });
}

function emptyResult(asOf: LocalDate, overdueCount: number): PortfolioRow['result'] {
  const counts = Object.fromEntries(
    DerivedStatus.options.map((s) => [s, 0]),
  ) as PortfolioRow['result']['counts'];
  const instanceIds = Object.fromEntries(
    DerivedStatus.options.map((s) => [s, [] as string[]]),
  ) as PortfolioRow['result']['instanceIds'];
  counts.OVERDUE = overdueCount;
  instanceIds.OVERDUE = Array.from({ length: overdueCount }, (_, i) => uid(0x10000 + i));
  return { engineVersion: 'mock', asOf, score: null, onTimeRate: null, counts, instanceIds };
}

const AS_OF = LocalDate.parse(FIRM_B_AS_OF);

async function readJson(init: RequestInit | undefined): Promise<Record<string, unknown>> {
  try {
    return typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A `fetch` that answers /api/v1 routes from the fixtures above. */
export const mockFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const session = sessionUser(headers.get('cookie'));
  const body = await readJson(init);

  // Public routes.
  if (method === 'POST' && path === '/auth/login') {
    const found = MOCK_USERS.find((u) => u.person.email === String(body.email ?? '').toLowerCase());
    if (!found || body.password !== MOCK_PASSWORD) {
      return fail(401, 'UNAUTHENTICATED', 'Email or password is incorrect.');
    }
    // Like the real API: the password matched in every firm listed, so naming one is all that's left.
    if (found.person.email === MOCK_TWO_FIRM_EMAIL) {
      if (body.firmId === undefined) {
        return fail(409, 'FIRM_CHOICE_REQUIRED', 'Choose the firm to sign in to.', {
          firms: MOCK_FIRMS,
        });
      }
      if (!MOCK_FIRMS.some((f) => f.id === body.firmId)) {
        return fail(401, 'UNAUTHENTICATED', 'Email or password is incorrect.');
      }
    }
    // As the API: signing in never passes MFA; only firm users then owe the verify step.
    return json(200, meBody(found, false), sessionCookie(`${found.person.id}.0`));
  }
  if (method === 'POST' && path === '/auth/magic-link') return json(202, null);
  if (method === 'POST' && path === '/auth/magic-link/verify') {
    return fail(401, 'UNAUTHENTICATED', 'This sign-in link has expired.');
  }
  const invite = /^\/invites\/([^/]+)(\/accept)?$/.exec(path);
  if (invite) {
    if (decodeURIComponent(invite[1]!) !== MOCK_INVITE_TOKEN)
      return fail(404, 'NOT_FOUND', 'Invite not found.');
    if (method === 'GET' && !invite[2]) {
      const preview: InvitePreview = {
        email: 'owner02@demo.test',
        displayName: 'Owner 02',
        firmName: MOCK_FIRMS[0].name,
        clientName: 'Demo Metals',
        role: 'OWNER',
        linkExpiresAt: '2099-01-01T00:00:00.000Z',
      };
      return json(200, preview);
    }
    if (method === 'POST' && invite[2]) {
      if (typeof body.password !== 'string' || body.password.length < 12) {
        return fail(400, 'VALIDATION', 'Password too short.', {
          issues: [{ path: ['password'], message: 'Use at least 12 characters' }],
        });
      }
      // Signs in as the owner account so the journey can continue into the shell.
      const owner = MOCK_USERS[2]!;
      return json(200, meBody(owner, false), sessionCookie(`${owner.person.id}.0`));
    }
  }

  // Session routes.
  if (!session) return fail(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  const { user: me } = session;

  if (method === 'POST' && path === '/auth/logout') return json(204, null, sessionCookie('', 0));
  if (method === 'POST' && path === '/auth/mfa/verify') {
    if (body.code !== MOCK_MFA_CODE)
      return fail(401, 'MFA_REQUIRED', 'That code is not right.', { enrolled: true });
    return json(200, meBody(me, true), sessionCookie(`${me.person.id}.1`));
  }
  if (method === 'GET' && path === '/me') return json(200, meBody(me, session.mfa));
  if (isFirmUser(me) && !session.mfa)
    return fail(401, 'MFA_REQUIRED', 'Verify your sign-in code.', { enrolled: true });
  if (method === 'GET' && path === '/portfolio') {
    if (!isFirmUser(me))
      return fail(403, 'FORBIDDEN', 'Not allowed.', { action: 'dashboard.portfolio' });
    const rows: PortfolioRow[] = clients
      .filter((c) => visibleClientIds(me).includes(c.id))
      .map((c) => ({
        clientId: c.id,
        clientName: c.name,
        result: emptyResult(AS_OF, overdue[c.id] ?? 0),
        dueThisWeek: 0,
        lastActivityAt: null,
      }));
    return json(200, { items: rows });
  }
  if (method === 'GET' && path === '/me/approvals') {
    if (!me.memberships.some((m) => m.role === 'CLIENT_ADMIN' || m.role === 'APPROVER'))
      return fail(403, 'FORBIDDEN', 'Not allowed.', { action: 'instance.read' });
    // Counts only: the shell's badge reads `total`. The approvals page brings its own rows (M12).
    const total = MOCK_APPROVALS_WAITING;
    return json(200, {
      items: [],
      nextCursor: null,
      ...(url.searchParams.get('count') === 'true' ? { total } : {}),
    });
  }
  // Everything else (M7, M10 and the other modules' endpoints) comes from M0's mock server.
  return delegateToM0(
    me.person.email ?? '',
    method,
    url,
    typeof init?.body === 'string' ? init.body : undefined,
  );
};
