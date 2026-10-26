import { randomUUID } from 'node:crypto';
import {
  DEFAULT_ACCOUNT,
  ClientSummary as ClientSummarySchema,
  Membership as MembershipSchema,
  Person as PersonSchema,
  type AccountView,
  type ClientSummary,
  type Membership,
  type Person,
  type PersonStatus,
  type RequestContext,
  type Role,
} from '@canopy/contracts';
import {
  LOCKOUT,
  type AcceptInvite,
  type AccountStore,
  type InviteRecord,
  type Invitee,
  type LoginCandidate,
  type LoginToken,
  type MfaRecord,
  type NewInvite,
  type NewLoginToken,
  type NewSession,
  type SupportToken,
  userLimitReached,
} from './accounts.js';
import { activeMemberships, type Principal, type SessionRecord } from './context.js';
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

export interface PersonInput {
  readonly id?: string;
  readonly firmId?: string;
  readonly displayName?: string;
  readonly email?: string | null;
  readonly status?: PersonStatus;
}

/** A valid M0 `Person` (ACTIVE, with an email, unless given), with overrides. */
export function person(input: PersonInput = {}): Person {
  const status = input.status ?? 'ACTIVE';
  const displayName = input.displayName ?? 'Asha Rao';
  const id = input.id ?? randomUUID();
  return PersonSchema.parse({
    id,
    firmId: input.firmId ?? randomUUID(),
    createdAt: STAMP,
    updatedAt: STAMP,
    archivedAt: null,
    version: 1,
    displayName,
    nameNormalized: displayName.toLowerCase().replace(/\s+/g, ' ').trim(),
    email: status === 'UNCLAIMED' ? null : (input.email ?? `${id.slice(0, 8)}@example.com`),
    status,
  });
}

/** A valid M0 `ClientSummary` for a client in FY 2026-27, with overrides. */
export function clientSummary(input: Partial<ClientSummary> & { id: string }): ClientSummary {
  return ClientSummarySchema.parse({
    name: 'Client',
    fyStartMonth: 4,
    timeZone: 'Asia/Kolkata',
    unitCount: 1,
    period: {
      current: { fy: '2026-27', quarter: 3 },
      availableFys: ['2026-27'],
      availableUntil: null,
    },
    ...input,
  });
}

export interface StoredPerson {
  displayName: string;
  email: string | null;
  status: PersonStatus;
  passwordHash: string | null;
  failedAttempts: number;
  lockedUntil: string | null;
  /** The PlanetPulse support person: never a sign-in candidate, never invited. */
  support?: boolean;
}

/** A firm's account as `account()` returns it: an active consultancy with no limits unless set. */
export function accountView(firmId: string, overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: firmId,
    name: 'Firm',
    kind: DEFAULT_ACCOUNT.kind,
    status: DEFAULT_ACCOUNT.status,
    trialEndsOn: null,
    entitlements: {
      planCode: 'CONSULTANCY',
      limits: { companies: null, units: null, users: null, storageBytes: null },
      features: [],
    },
    usage: { companies: 0, units: 0, users: 0, storageBytes: 0 },
    ...overrides,
  };
}

/** An outbox event or audit row the in-memory store recorded, for assertions. */
export interface Recorded {
  readonly firmId: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/**
 * In-memory `AccountStore`: the reference behaviour the database adapter must match. Keys are
 * `${firmId}/${personId}` (or `${firmId}/${clientId}`) unless noted.
 */
export class InMemoryAuthStore implements AccountStore {
  readonly sessions = new Map<string, SessionRecord>();
  readonly principals = new Map<string, Principal>();
  readonly timeZones = new Map<string, string>();
  readonly firms = new Map<string, string>();
  /** `Me.clients` rows, keyed by firm and client. */
  readonly clients = new Map<string, ClientSummary>();
  readonly people = new Map<string, StoredPerson>();
  readonly mfa = new Map<string, MfaRecord>();
  readonly tokens = new Map<string, LoginToken>();
  /** Keyed by invite id. */
  readonly invites = new Map<string, InviteRecord>();
  /** Accounts by firm id; a firm missing here is an active consultancy with no limits. */
  readonly accounts = new Map<string, AccountView>();
  /** Accounts whose master library M6 has not copied yet; every other account has its library. */
  readonly libraryPending = new Set<string>();
  /** Accounts whose ISO catalogue copy is not recorded yet; every other account has it. */
  readonly isoCataloguePending = new Set<string>();
  /** Support tokens by hash, as the console's `platform_issue_support_token` stores them. */
  readonly supportTokens = new Map<string, SupportToken>();
  /** Support grants by id: when each ends and whether it was revoked. */
  readonly supportGrants = new Map<string, { endsAt: string; revoked: boolean }>();
  readonly outbox: Recorded[] = [];
  readonly audit: Recorded[] = [];

  /** Like `canopy_find_session`: the account's status, and nothing for a support session whose grant ended. */
  async findSession(tokenHash: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(tokenHash);
    if (session === undefined) return null;
    if (session.supportGrantId) {
      const grant = this.supportGrants.get(session.supportGrantId);
      if (!grant || grant.revoked || Date.parse(grant.endsAt) <= Date.now()) return null;
    }
    return { ...session, accountStatus: this.accounts.get(session.firmId)?.status ?? 'ACTIVE' };
  }

  async account(firmId: string): Promise<AccountView | null> {
    return this.accounts.get(firmId) ?? accountView(firmId);
  }

  async accountFeatures(firmId: string): Promise<readonly string[]> {
    return (await this.account(firmId))?.entitlements.features ?? [];
  }

  async isoCatalogueCopied(firmId: string): Promise<boolean> {
    return !this.isoCataloguePending.has(firmId);
  }

  async libraryCopied(firmId: string): Promise<boolean> {
    return !this.libraryPending.has(firmId);
  }

  async findSupportToken(tokenHash: string): Promise<SupportToken | null> {
    const token = this.supportTokens.get(tokenHash);
    if (token === undefined) return null;
    const grant = this.supportGrants.get(token.supportGrantId);
    return {
      ...token,
      grantLive: grant !== undefined && !grant.revoked && Date.parse(grant.endsAt) > Date.now(),
      accountStatus: this.accounts.get(token.firmId)?.status ?? 'ACTIVE',
    };
  }

  async loadPrincipal(firmId: string, personId: string): Promise<Principal | null> {
    const key = `${firmId}/${personId}`;
    const principal = this.principals.get(key);
    if (principal === undefined) return null;
    const stored = this.people.get(key);
    const mfa = this.mfa.get(key);
    return {
      ...principal,
      person: stored
        ? {
            ...principal.person,
            displayName: stored.displayName,
            nameNormalized: stored.displayName.toLowerCase().replace(/\s+/g, ' ').trim(),
            email: stored.email,
            status: stored.status,
          }
        : principal.person,
      mfaEnrolled: mfa ? mfa.enrolledAt !== null : principal.mfaEnrolled,
    };
  }

  async clientTimeZone(firmId: string, clientId: string): Promise<string | null> {
    return this.timeZones.get(`${firmId}/${clientId}`) ?? null;
  }

  async clientSummaries(ctx: RequestContext): Promise<ClientSummary[]> {
    return ctx.clientIds.flatMap((id) => {
      const summary = this.clients.get(`${ctx.firmId}/${id}`);
      return summary ? [summary] : [];
    });
  }

  async findLoginCandidates(email: string): Promise<LoginCandidate[]> {
    const wanted = email.toLowerCase();
    return [...this.people.entries()]
      .filter(
        ([, p]) => p.email?.toLowerCase() === wanted && p.status !== 'UNCLAIMED' && !p.support,
      )
      .map(([key, p]) => {
        const [firmId, personId] = key.split('/') as [string, string];
        return {
          firmId,
          personId,
          firmName: this.firms.get(firmId) ?? 'Firm',
          status: p.status,
          passwordHash: p.passwordHash,
          lockedUntil: p.lockedUntil,
          accountStatus: this.accounts.get(firmId)?.status ?? 'ACTIVE',
        };
      })
      .filter((c) => c.accountStatus !== 'DELETED');
  }

  async recordLoginFailure(firmId: string, personId: string, now: Date): Promise<boolean> {
    const stored = this.person(firmId, personId);
    stored.failedAttempts += 1;
    if (stored.failedAttempts >= LOCKOUT.attempts) {
      stored.lockedUntil = new Date(now.getTime() + LOCKOUT.minutes * 60_000).toISOString();
      stored.failedAttempts = 0;
    }
    return stored.lockedUntil !== null && Date.parse(stored.lockedUntil) > now.getTime();
  }

  async resetLoginFailures(firmId: string, personId: string): Promise<void> {
    const stored = this.people.get(`${firmId}/${personId}`);
    if (stored) stored.failedAttempts = 0;
  }

  async revokeAllSessions(firmId: string, personId: string): Promise<void> {
    for (const [hash, s] of this.sessions) {
      if (s.firmId === firmId && s.personId === personId) this.sessions.delete(hash);
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
      supportGrantId: session.supportGrantId ?? null,
    };
    this.sessions.set(session.tokenHash, record);
    const stored = this.people.get(`${session.firmId}/${session.personId}`);
    if (stored && !session.owesMfa) stored.failedAttempts = 0;
    this.audit.push({
      firmId: session.firmId,
      type: 'LOGIN',
      data: { personId: session.personId, method: session.method },
    });
    return record;
  }

  async revokeSession(_firmId: string, sessionId: string): Promise<void> {
    for (const [hash, s] of this.sessions) if (s.id === sessionId) this.sessions.delete(hash);
  }

  async markSessionMfa(_firmId: string, sessionId: string): Promise<void> {
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

  async completeMfa(firmId: string, personId: string, record: MfaRecord): Promise<void> {
    this.mfa.set(`${firmId}/${personId}`, record);
    this.outbox.push({ firmId, type: 'person.mfa_enrolled', data: { personId, via: 'SETTINGS' } });
  }

  async acceptMfaStep(firmId: string, personId: string, step: number): Promise<boolean> {
    const key = `${firmId}/${personId}`;
    const record = this.mfa.get(key);
    if (record === undefined || (record.lastStep !== null && record.lastStep >= step)) return false;
    this.mfa.set(key, { ...record, lastStep: step });
    return true;
  }

  async requestMagicLink(firmId: string, personId: string): Promise<void> {
    this.outbox.push({ firmId, type: 'auth.magic_link_requested', data: { personId } });
  }

  async createLoginToken(token: NewLoginToken): Promise<void> {
    const id = randomUUID();
    this.tokens.set(id, { ...token, id, usedAt: null });
  }

  async findLoginToken(tokenHash: string): Promise<LoginToken | null> {
    return [...this.tokens.values()].find((t) => t.tokenHash === tokenHash) ?? null;
  }

  async consumeLoginToken(firmId: string, tokenId: string, now: Date): Promise<boolean> {
    for (const [hash, support] of this.supportTokens) {
      if (support.id !== tokenId) continue;
      if (support.firmId !== firmId || support.usedAt !== null) return false;
      if (Date.parse(support.expiresAt) <= now.getTime()) return false;
      this.supportTokens.set(hash, { ...support, usedAt: now.toISOString() });
      return true;
    }
    const token = this.tokens.get(tokenId);
    if (
      token === undefined ||
      token.firmId !== firmId ||
      token.usedAt !== null ||
      Date.parse(token.expiresAt) <= now.getTime()
    ) {
      return false;
    }
    this.tokens.set(tokenId, { ...token, usedAt: now.toISOString() });
    return true;
  }

  async findInvitee(firmId: string, personId: string, now: Date): Promise<Invitee | null> {
    const key = `${firmId}/${personId}`;
    const stored = this.people.get(key);
    if (!stored) return null;
    const held = (this.principals.get(key)?.memberships ?? []).filter((m) => m.archivedAt === null);
    const invited = [...this.invites.values()].filter(
      (i) =>
        i.firmId === firmId &&
        i.personId === personId &&
        i.status === 'PENDING' &&
        Date.parse(i.linkExpiresAt) > now.getTime(),
    );
    return {
      personId,
      status: stored.status,
      email: stored.email,
      support: stored.support === true,
      roles: [...held, ...invited].map((r) => ({ role: r.role, clientId: r.clientId })),
    };
  }

  async findPersonIdByEmail(firmId: string, email: string): Promise<string | null> {
    const wanted = email.toLowerCase();
    for (const [key, p] of this.people) {
      const [keyFirm, personId] = key.split('/') as [string, string];
      if (keyFirm === firmId && p.email?.toLowerCase() === wanted) return personId;
    }
    return null;
  }

  async createInvite(invite: NewInvite): Promise<InviteRecord> {
    const now = invite.now.toISOString();
    // Like app_usage(): an ACTIVE or INVITED person with a live membership or an open invite holds a seat already.
    const account = await this.account(invite.firmId);
    const max = account?.entitlements.limits.users ?? null;
    const counted =
      invite.personId !== null && this.holdsSeat(invite.firmId, invite.personId, invite.now);
    if (account && max !== null && !counted) {
      if (account.usage.users >= max) throw userLimitReached(max, account.usage.users);
      if (this.accounts.has(invite.firmId)) {
        this.accounts.set(invite.firmId, {
          ...account,
          usage: { ...account.usage, users: account.usage.users + 1 },
        });
      }
    }
    let personId = invite.personId;
    if (personId === null) {
      personId = randomUUID();
      this.people.set(`${invite.firmId}/${personId}`, {
        displayName: invite.displayName ?? invite.email,
        email: null,
        status: 'UNCLAIMED',
        passwordHash: null,
        failedAttempts: 0,
        lockedUntil: null,
      });
      this.audit.push({ firmId: invite.firmId, type: 'CREATE', data: { personId } });
    } else {
      this.audit.push({ firmId: invite.firmId, type: 'UPDATE', data: { personId } });
    }
    for (const open of this.invites.values()) {
      if (open.personId === personId && open.status === 'PENDING') {
        this.invites.set(open.id, { ...open, status: 'REVOKED', updatedAt: now });
      }
    }
    const stored = this.person(invite.firmId, personId);
    stored.status = 'INVITED';
    stored.email = invite.email;
    const id = randomUUID();
    const record: InviteRecord = {
      id,
      firmId: invite.firmId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      personId,
      email: invite.email,
      ...invite.grant,
      status: 'PENDING',
      invitedById: invite.invitedById,
      linkExpiresAt: invite.linkExpiresAt,
      firmName: this.firms.get(invite.firmId) ?? 'Firm',
      displayName: stored.displayName,
      clientName:
        invite.grant.clientId === null
          ? null
          : (this.clients.get(`${invite.firmId}/${invite.grant.clientId}`)?.name ?? 'Client'),
    };
    this.invites.set(id, record);
    this.outbox.push({
      firmId: invite.firmId,
      type: 'person.invited',
      data: {
        personId,
        inviteId: id,
        role: invite.grant.role,
        clientId: invite.grant.clientId,
      },
    });
    return record;
  }

  async findInvite(firmId: string, inviteId: string): Promise<InviteRecord | null> {
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
      this.invites.set(inviteId, { ...invite, status: 'REVOKED', updatedAt: now.toISOString() });
      this.audit.push({ firmId, type: 'UPDATE', data: { personId: invite.personId } });
    }
  }

  async acceptInvite(accept: AcceptInvite): Promise<boolean> {
    const invite = this.invites.get(accept.inviteId);
    const token = this.tokens.get(accept.tokenId);
    if (
      invite === undefined ||
      invite.firmId !== accept.firmId ||
      invite.status !== 'PENDING' ||
      Date.parse(invite.linkExpiresAt) <= accept.now.getTime() ||
      token?.inviteId !== invite.id ||
      !(await this.consumeLoginToken(accept.firmId, accept.tokenId, accept.now))
    ) {
      return false;
    }
    const at = accept.now.toISOString();
    this.invites.set(invite.id, { ...invite, status: 'ACCEPTED', updatedAt: at });
    const key = `${invite.firmId}/${invite.personId}`;
    const stored = this.person(invite.firmId, invite.personId);
    stored.status = 'ACTIVE';
    stored.passwordHash = accept.passwordHash;
    if (accept.mfa !== null) {
      this.mfa.set(key, accept.mfa);
      this.outbox.push({
        firmId: invite.firmId,
        type: 'person.mfa_enrolled',
        data: { personId: invite.personId, via: 'INVITE' },
      });
    }
    if (accept.displayName !== null) stored.displayName = accept.displayName;
    const granted = membership({
      firmId: invite.firmId,
      personId: invite.personId,
      role: invite.role,
      clientId: invite.clientId,
      consultantClientIds: invite.consultantClientIds,
      unitIds: invite.unitIds,
      expiresAt: invite.expiresAt,
    });
    const existing = this.principals.get(key);
    this.principals.set(key, {
      person:
        existing?.person ??
        person({ id: invite.personId, firmId: invite.firmId, email: invite.email }),
      memberships: [...(existing?.memberships ?? []), granted],
      mfaEnrolled: false,
      mfaRequiredForFirmRoles: true,
      firmClientIds: existing?.firmClientIds ?? [],
    });
    this.audit.push({ firmId: invite.firmId, type: 'UPDATE', data: { personId: invite.personId } });
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
      data: {
        membershipId: granted.id,
        personId: invite.personId,
        role: granted.role,
        clientId: granted.clientId,
        change: 'GRANTED',
      },
    });
    // The db trigger canopy_activate_account: an admin accepting opens a PROVISIONING account, once its library
    // is copied (the trigger refuses before, and the transaction rolls back).
    const account = this.accounts.get(invite.firmId);
    if (account?.status === 'PROVISIONING' && invite.role === 'FIRM_ADMIN') {
      if (this.libraryPending.has(invite.firmId)) {
        throw new Error('canopy_activate_account: the account is still being set up');
      }
      const status = account.trialEndsOn === null ? 'ACTIVE' : 'TRIAL';
      this.accounts.set(invite.firmId, { ...account, status });
      this.outbox.push({
        firmId: invite.firmId,
        type: 'account.status_changed',
        data: { accountId: invite.firmId, from: 'PROVISIONING', to: status },
      });
    }
    return true;
  }

  private holdsSeat(firmId: string, personId: string, now: Date): boolean {
    const status = this.people.get(`${firmId}/${personId}`)?.status;
    if (status !== 'ACTIVE' && status !== 'INVITED') return false;
    const memberships = this.principals.get(`${firmId}/${personId}`)?.memberships ?? [];
    if (activeMemberships(memberships, now).length > 0) return true;
    return [...this.invites.values()].some(
      (i) =>
        i.firmId === firmId &&
        i.personId === personId &&
        i.status === 'PENDING' &&
        Date.parse(i.linkExpiresAt) > now.getTime(),
    );
  }

  private person(firmId: string, personId: string): StoredPerson {
    const stored = this.people.get(`${firmId}/${personId}`);
    if (stored === undefined) throw new Error('No such person');
    return stored;
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
      person: person({ id: personId, firmId, displayName: 'Test person' }),
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
