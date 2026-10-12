import { randomUUID } from 'node:crypto';
import type { Membership, Role } from '@canopy/contracts';
import { Membership as MembershipSchema } from '@canopy/contracts';
import type { PersonStatus } from '@canopy/contracts';
import {
  LOCKOUT,
  type AcceptInvite,
  type AccountStore,
  type Invite,
  type Invitee,
  type LoginCandidate,
  type LoginToken,
  type MfaRecord,
  type NewInvite,
  type NewLoginToken,
  type NewSession,
} from './accounts.js';
import type { Principal, SessionRecord } from './context.js';
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
  return MembershipSchema.parse({
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

export interface StoredPerson {
  name: string;
  email: string | null;
  status: PersonStatus;
  passwordHash: string | null;
  failedAttempts: number;
  lockedUntil: string | null;
}

/** An outbox event or audit row the in-memory store recorded, for assertions. */
export interface Recorded {
  readonly firmId: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/**
 * In-memory `AccountStore`: the reference behaviour the database adapter must match. Keys are
 * `${firmId}/${personId}` unless noted.
 */
export class InMemoryAuthStore implements AccountStore {
  readonly sessions = new Map<string, SessionRecord>();
  readonly principals = new Map<string, Principal>();
  readonly timeZones = new Map<string, string>();
  readonly firms = new Map<string, string>();
  readonly people = new Map<string, StoredPerson>();
  readonly mfa = new Map<string, MfaRecord>();
  readonly tokens = new Map<string, LoginToken>();
  readonly invites = new Map<string, Invite>();
  readonly outbox: Recorded[] = [];
  readonly audit: Recorded[] = [];

  async findSession(tokenHash: string): Promise<SessionRecord | null> {
    return this.sessions.get(tokenHash) ?? null;
  }

  async loadPrincipal(firmId: string, personId: string): Promise<Principal | null> {
    const key = `${firmId}/${personId}`;
    const principal = this.principals.get(key);
    if (principal === undefined) return null;
    const person = this.people.get(key);
    const mfa = this.mfa.get(key);
    return {
      ...principal,
      ...(person
        ? { status: person.status, profile: { name: person.name, email: person.email } }
        : {}),
      mfaEnrolled: mfa ? mfa.enrolledAt !== null : principal.mfaEnrolled,
    };
  }

  async clientTimeZone(firmId: string, clientId: string): Promise<string | null> {
    return this.timeZones.get(`${firmId}/${clientId}`) ?? null;
  }

  async findLoginCandidates(email: string): Promise<LoginCandidate[]> {
    const wanted = email.toLowerCase();
    return [...this.people.entries()]
      .filter(([, p]) => p.email?.toLowerCase() === wanted && p.status !== 'UNCLAIMED')
      .map(([key, p]) => {
        const [firmId, personId] = key.split('/') as [string, string];
        return {
          firmId,
          personId,
          firmName: this.firms.get(firmId) ?? 'Firm',
          status: p.status,
          passwordHash: p.passwordHash,
          lockedUntil: p.lockedUntil,
        };
      });
  }

  async recordLoginFailure(firmId: string, personId: string, now: Date): Promise<void> {
    const person = this.person(firmId, personId);
    person.failedAttempts += 1;
    if (person.failedAttempts >= LOCKOUT.attempts) {
      person.lockedUntil = new Date(now.getTime() + LOCKOUT.minutes * 60_000).toISOString();
      person.failedAttempts = 0;
    }
  }

  async createSession(session: NewSession): Promise<SessionRecord> {
    const record: SessionRecord = {
      id: randomUUID(),
      firmId: session.firmId,
      personId: session.personId,
      csrfToken: session.csrfToken,
      mfaSatisfied: session.mfaSatisfied,
      expiresAt: session.expiresAt,
    };
    this.sessions.set(session.tokenHash, record);
    const person = this.people.get(`${session.firmId}/${session.personId}`);
    if (person) person.failedAttempts = 0;
    this.audit.push({
      firmId: session.firmId,
      type: 'LOGIN',
      data: { personId: session.personId, method: session.method },
    });
    return record;
  }

  async revokeSession(sessionId: string): Promise<void> {
    for (const [hash, s] of this.sessions) if (s.id === sessionId) this.sessions.delete(hash);
  }

  async markSessionMfa(sessionId: string): Promise<void> {
    for (const [hash, s] of this.sessions) {
      if (s.id === sessionId) this.sessions.set(hash, { ...s, mfaSatisfied: true });
    }
  }

  async getMfa(firmId: string, personId: string): Promise<MfaRecord | null> {
    return this.mfa.get(`${firmId}/${personId}`) ?? null;
  }

  async saveMfa(firmId: string, personId: string, record: MfaRecord): Promise<void> {
    this.mfa.set(`${firmId}/${personId}`, record);
  }

  async requestMagicLink(firmId: string, personId: string): Promise<void> {
    this.outbox.push({ firmId, type: 'auth.magic_link_requested', data: { personId } });
  }

  async createLoginToken(token: NewLoginToken): Promise<void> {
    const id = randomUUID();
    this.tokens.set(id, { ...token, id, usedAt: null, inviteOpen: true });
  }

  async findLoginToken(tokenHash: string): Promise<LoginToken | null> {
    const token = [...this.tokens.values()].find((t) => t.tokenHash === tokenHash);
    if (token === undefined) return null;
    const invite = token.inviteId ? this.invites.get(token.inviteId) : undefined;
    const inviteOpen =
      invite !== undefined && invite.acceptedAt === null && invite.revokedAt === null;
    return { ...token, inviteOpen };
  }

  async consumeLoginToken(tokenId: string, now: Date): Promise<boolean> {
    const token = this.tokens.get(tokenId);
    if (token === undefined || token.usedAt !== null) return false;
    this.tokens.set(tokenId, { ...token, usedAt: now.toISOString() });
    return true;
  }

  async findInvitee(firmId: string, personId: string): Promise<Invitee | null> {
    const person = this.people.get(`${firmId}/${personId}`);
    return person ? { personId, status: person.status, email: person.email } : null;
  }

  async createInvite(invite: NewInvite): Promise<{ inviteId: string }> {
    for (const open of this.invites.values()) {
      if (
        open.personId === invite.personId &&
        open.acceptedAt === null &&
        open.revokedAt === null
      ) {
        this.invites.set(open.id, { ...open, revokedAt: STAMP });
      }
    }
    const id = randomUUID();
    this.invites.set(id, {
      firmId: invite.firmId,
      personId: invite.personId,
      email: invite.email,
      grant: invite.grant,
      createdById: invite.createdById,
      expiresAt: invite.expiresAt,
      id,
      firmName: this.firms.get(invite.firmId) ?? 'Firm',
      acceptedAt: null,
      revokedAt: null,
    });
    const person = this.person(invite.firmId, invite.personId);
    person.status = 'INVITED';
    person.email = invite.email;
    this.audit.push({ firmId: invite.firmId, type: 'UPDATE', data: { personId: invite.personId } });
    this.outbox.push({
      firmId: invite.firmId,
      type: 'person.invited',
      data: {
        personId: invite.personId,
        inviteId: id,
        role: invite.grant.role,
        clientId: invite.grant.clientId,
      },
    });
    return { inviteId: id };
  }

  async findInvite(firmId: string, inviteId: string): Promise<Invite | null> {
    const invite = this.invites.get(inviteId);
    return invite && invite.firmId === firmId ? invite : null;
  }

  async revokeInvite(
    firmId: string,
    inviteId: string,
    _actorId: string,
    _requestId: string,
    now: Date,
  ): Promise<void> {
    const invite = this.invites.get(inviteId);
    if (invite && invite.firmId === firmId) {
      this.invites.set(inviteId, { ...invite, revokedAt: now.toISOString() });
      this.audit.push({ firmId, type: 'UPDATE', data: { personId: invite.personId } });
    }
  }

  async acceptInvite(accept: AcceptInvite): Promise<void> {
    const invite = this.invites.get(accept.inviteId);
    if (invite === undefined || invite.firmId !== accept.firmId) throw new Error('No such invite');
    this.invites.set(invite.id, { ...invite, acceptedAt: accept.now.toISOString() });
    const key = `${invite.firmId}/${invite.personId}`;
    const person = this.person(invite.firmId, invite.personId);
    person.status = 'ACTIVE';
    person.passwordHash = accept.passwordHash;
    const granted = membership({
      firmId: invite.firmId,
      personId: invite.personId,
      role: invite.grant.role,
      clientId: invite.grant.clientId,
      consultantClientIds: invite.grant.consultantClientIds
        ? [...invite.grant.consultantClientIds]
        : null,
      unitIds: invite.grant.unitIds ? [...invite.grant.unitIds] : null,
      expiresAt: invite.grant.expiresAt,
    });
    const existing = this.principals.get(key);
    this.principals.set(key, {
      status: 'ACTIVE',
      profile: { name: person.name, email: person.email },
      memberships: [...(existing?.memberships ?? []), granted],
      mfaEnrolled: false,
      mfaRequiredForFirmRoles: true,
      firmClientIds: existing?.firmClientIds ?? [],
    });
    this.audit.push({
      firmId: invite.firmId,
      type: 'MEMBERSHIP_CHANGE',
      data: { personId: invite.personId },
    });
    this.outbox.push({
      firmId: invite.firmId,
      type: 'person.claimed',
      data: { personId: invite.personId },
    });
    this.outbox.push({
      firmId: invite.firmId,
      type: 'membership.changed',
      data: { membershipId: granted.id, personId: invite.personId, change: 'GRANTED' },
    });
  }

  private person(firmId: string, personId: string): StoredPerson {
    const person = this.people.get(`${firmId}/${personId}`);
    if (person === undefined) throw new Error('No such person');
    return person;
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
      profile: { name: 'Test person', email: null },
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
