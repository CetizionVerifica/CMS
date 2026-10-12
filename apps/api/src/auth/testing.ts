import { randomUUID } from 'node:crypto';
import { Membership, type Role } from '@canopy/contracts';
import type { AuthStore, Principal, SessionRecord } from './context.js';
import { CSRF_HEADER, SESSION_COOKIE } from './plugin.js';
import { hashToken, newToken } from './tokens.js';

/**
 * Test helpers for routes behind auth: an in-memory `AuthStore` and `signIn`, which returns the headers
 * `app.inject` needs. For tests only; the server uses the store built on M3's repositories.
 */

const STAMP = '2026-01-01T00:00:00Z';

export type MembershipInput = Partial<Omit<Membership, 'role'>> & { role: Role };

/** A valid membership for `role` (validated against the M0 schema), with overrides. */
export function membership(input: MembershipInput): Membership {
  const firmRole = input.role === 'FIRM_ADMIN' || input.role === 'CONSULTANT';
  return Membership.parse({
    id: randomUUID(),
    firmId: randomUUID(),
    createdAt: STAMP,
    updatedAt: STAMP,
    archivedAt: null,
    version: 1,
    personId: randomUUID(),
    clientId: firmRole ? null : randomUUID(),
    consultantClientIds: input.role === 'CONSULTANT' ? [] : null,
    unitIds: null,
    expiresAt: input.role === 'VIEWER' ? '2099-01-01T00:00:00Z' : null,
    ...input,
  });
}

export class InMemoryAuthStore implements AuthStore {
  readonly sessions = new Map<string, SessionRecord>();
  readonly principals = new Map<string, Principal>();
  readonly timeZones = new Map<string, string>();

  async findSession(tokenHash: string): Promise<SessionRecord | null> {
    return this.sessions.get(tokenHash) ?? null;
  }

  async loadPrincipal(firmId: string, personId: string): Promise<Principal | null> {
    return this.principals.get(`${firmId}/${personId}`) ?? null;
  }

  async clientTimeZone(firmId: string, clientId: string): Promise<string | null> {
    return this.timeZones.get(`${firmId}/${clientId}`) ?? null;
  }
}

export interface SignInInput {
  readonly memberships: readonly MembershipInput[];
  readonly firmId?: string;
  readonly personId?: string;
  readonly mfaSatisfied?: boolean;
  readonly principal?: Partial<Principal>;
  readonly expiresAt?: string;
}

export interface SignedIn {
  readonly firmId: string;
  readonly personId: string;
  readonly token: string;
  readonly csrfToken: string;
  /** Cookie and CSRF headers for `app.inject`. */
  readonly headers: Record<string, string>;
}

export function createTestAuth() {
  const store = new InMemoryAuthStore();

  function signIn(input: SignInInput): SignedIn {
    const firmId = input.firmId ?? randomUUID();
    const personId = input.personId ?? randomUUID();
    const memberships = input.memberships.map((m) => membership({ firmId, personId, ...m }));
    const clientIds = memberships.flatMap((m) => [
      ...(m.clientId === null ? [] : [m.clientId]),
      ...(m.consultantClientIds ?? []),
    ]);
    store.principals.set(`${firmId}/${personId}`, {
      status: 'ACTIVE',
      memberships,
      mfaEnrolled: true,
      mfaRequiredForFirmRoles: true,
      firmClientIds: clientIds,
      ...input.principal,
    });
    const token = newToken();
    const csrfToken = newToken();
    store.sessions.set(hashToken(token), {
      id: randomUUID(),
      firmId,
      personId,
      csrfToken,
      mfaSatisfied: input.mfaSatisfied ?? true,
      expiresAt: input.expiresAt ?? '2099-01-01T00:00:00Z',
    });
    return {
      firmId,
      personId,
      token,
      csrfToken,
      headers: { cookie: `${SESSION_COOKIE}=${token}`, [CSRF_HEADER]: csrfToken },
    };
  }

  return { store, signIn };
}
