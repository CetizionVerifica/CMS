import type { PersonStatus, Role } from '@canopy/contracts';
import type { AuthStore, SessionRecord } from './context.js';

/**
 * Storage for sign-in, MFA and invites (M5 PR 2). The database adapter on M3's repositories implements it;
 * tests use `InMemoryAuthStore`. Each method is one transaction. Methods that change who can sign in or
 * what they can do write their `AuditEvent` and outbox event in that same transaction, as their comments say.
 * Lookups by email or token hash run before a tenant is known and return only ids, hashes and states.
 */
export interface AccountStore extends AuthStore {
  /** ACTIVE, INVITED and DISABLED people with this email (case-insensitive), across firms. */
  findLoginCandidates(email: string): Promise<LoginCandidate[]>;
  /** Counts a failed password; after `LOCKOUT.attempts` failures in a row the account locks for `LOCKOUT.minutes`. */
  recordLoginFailure(firmId: string, personId: string, now: Date): Promise<void>;
  /** Stores a session and resets failed attempts. Audit: `LOGIN` on the person. */
  createSession(session: NewSession): Promise<SessionRecord>;
  revokeSession(sessionId: string): Promise<void>;
  markSessionMfa(sessionId: string): Promise<void>;

  getMfa(firmId: string, personId: string): Promise<MfaRecord | null>;
  saveMfa(firmId: string, personId: string, record: MfaRecord): Promise<void>;

  /** Outbox: `auth.magic_link_requested { personId }`; M9 then calls `issueLoginToken`. */
  requestMagicLink(firmId: string, personId: string, requestId: string): Promise<void>;
  createLoginToken(token: NewLoginToken): Promise<void>;
  findLoginToken(tokenHash: string): Promise<LoginToken | null>;
  /** Marks the token used; false when it was already used (another request won). */
  consumeLoginToken(tokenId: string, now: Date): Promise<boolean>;

  /** The person an invite is for, in the actor's tenant, or null. */
  findInvitee(firmId: string, personId: string): Promise<Invitee | null>;
  /**
   * Records the invite, sets the person INVITED with the email, revokes earlier open invites for the person.
   * Audit: `UPDATE` on the person. Outbox: `person.invited { personId, inviteId, role, clientId }`.
   */
  createInvite(invite: NewInvite): Promise<{ inviteId: string }>;
  findInvite(firmId: string, inviteId: string): Promise<Invite | null>;
  /** Audit: `UPDATE` on the person. Open tokens of the invite stop working. */
  revokeInvite(
    firmId: string,
    inviteId: string,
    actorId: string,
    requestId: string,
    now: Date,
  ): Promise<void>;
  /**
   * Accepts an open invite: sets the password, the person ACTIVE, grants the membership, marks the invite
   * accepted. Audit: `UPDATE` on the person and `MEMBERSHIP_CHANGE`. Outbox: `person.claimed` and
   * `membership.changed` (GRANTED).
   */
  acceptInvite(accept: AcceptInvite): Promise<void>;
}

export const LOCKOUT = { attempts: 10, minutes: 15 } as const;
export const SESSION_HOURS = 12;
export const MAGIC_LINK_MINUTES = 15;
export const INVITE_DAYS = 7;

export interface LoginCandidate {
  readonly firmId: string;
  readonly personId: string;
  readonly firmName: string;
  readonly status: PersonStatus;
  readonly passwordHash: string | null;
  readonly lockedUntil: string | null;
}

export interface NewSession {
  readonly firmId: string;
  readonly personId: string;
  readonly tokenHash: string;
  readonly csrfToken: string;
  readonly mfaSatisfied: boolean;
  readonly expiresAt: string;
  readonly requestId: string;
  /** How the person signed in, for the audit event. */
  readonly method: 'PASSWORD' | 'MAGIC_LINK' | 'INVITE';
}

export interface MfaRecord {
  /** The TOTP secret sealed with `SecretBox`. */
  readonly sealedSecret: string;
  /** Null until the first code is verified. */
  readonly enrolledAt: string | null;
  /** The last accepted time step; a code for this step or earlier is refused (no replay). */
  readonly lastStep: number | null;
}

export type LoginTokenKind = 'MAGIC_LINK' | 'INVITE';

export interface NewLoginToken {
  readonly firmId: string;
  readonly personId: string;
  readonly kind: LoginTokenKind;
  readonly inviteId: string | null;
  readonly tokenHash: string;
  readonly expiresAt: string;
}

export interface LoginToken extends NewLoginToken {
  readonly id: string;
  readonly usedAt: string | null;
  /** For INVITE tokens: whether the invite is still open (not accepted, revoked or expired). */
  readonly inviteOpen: boolean;
}

/** The membership an invite grants. */
export interface Grant {
  readonly role: Role;
  readonly clientId: string | null;
  readonly consultantClientIds: readonly string[] | null;
  readonly unitIds: readonly string[] | null;
  readonly expiresAt: string | null;
}

export interface Invitee {
  readonly personId: string;
  readonly status: PersonStatus;
  readonly email: string | null;
}

export interface NewInvite {
  readonly firmId: string;
  readonly personId: string;
  readonly email: string;
  readonly grant: Grant;
  readonly createdById: string;
  readonly expiresAt: string;
  readonly requestId: string;
}

export interface Invite extends Omit<NewInvite, 'requestId'> {
  readonly id: string;
  readonly firmName: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
}

export interface AcceptInvite {
  readonly firmId: string;
  readonly inviteId: string;
  readonly tokenId: string;
  readonly passwordHash: string;
  readonly requestId: string;
  readonly now: Date;
}
