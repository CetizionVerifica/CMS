import type {
  ClientSummary,
  Invite,
  MembershipGrant,
  PersonStatus,
  RequestContext,
} from '@canopy/contracts';
import type { AuthStore, SessionRecord } from './context.js';

/**
 * Storage for sign-in, MFA and invites (M5 PR 2). The database adapter on M3's repositories implements it;
 * tests use `InMemoryAuthStore`. Each method is one transaction. Methods that change who can sign in or
 * what they can do write their `AuditEvent` and outbox event in that same transaction, as their comments say.
 * Lookups by email or token hash run before a tenant is known and return only ids, hashes and states.
 */
export interface AccountStore extends AuthStore {
  /**
   * `Me.clients`: the clients in `ctx.clientIds` with the units the person may see counted and the periods computed
   * with the engine (`ClientPeriods`).
   */
  clientSummaries(ctx: RequestContext): Promise<ClientSummary[]>;

  /** ACTIVE, INVITED and DISABLED people with this email (case-insensitive), across firms. */
  findLoginCandidates(email: string): Promise<LoginCandidate[]>;
  /** Counts a failed password; after `LOCKOUT.attempts` failures in a row the account locks for `LOCKOUT.minutes`. */
  recordLoginFailure(firmId: string, personId: string, now: Date): Promise<void>;
  /** Stores a session and resets failed attempts. Audit: `LOGIN` on the person. */
  createSession(session: NewSession): Promise<SessionRecord>;
  revokeSession(firmId: string, sessionId: string, now: Date): Promise<void>;
  markSessionMfa(firmId: string, sessionId: string): Promise<void>;

  getMfa(firmId: string, personId: string): Promise<MfaRecord | null>;
  saveMfa(firmId: string, personId: string, record: MfaRecord): Promise<void>;
  /**
   * Records `step` as the last accepted TOTP step only if it is later than the stored one, in one statement.
   * False for a replayed code or when a concurrent request won.
   */
  acceptMfaStep(firmId: string, personId: string, step: number): Promise<boolean>;

  /** Outbox: `auth.magic_link_requested { personId }`; M9 then calls `issueLoginToken`. */
  requestMagicLink(firmId: string, personId: string, requestId: string): Promise<void>;
  createLoginToken(token: NewLoginToken): Promise<void>;
  findLoginToken(tokenHash: string): Promise<LoginToken | null>;
  /** Marks the token used if it is unused and unexpired; false when another request won. */
  consumeLoginToken(firmId: string, tokenId: string, now: Date): Promise<boolean>;

  /** The person an invite is for, in the actor's tenant, or null. */
  findInvitee(firmId: string, personId: string): Promise<Invitee | null>;
  /** The person in the firm who has this email (case-insensitive), or null. */
  findPersonIdByEmail(firmId: string, email: string): Promise<string | null>;
  /**
   * Records the invite, sets the person INVITED with the email (creating them first when `personId` is null),
   * revokes earlier pending invites for the person. Audit: `CREATE` on a new person, `UPDATE` on an existing
   * one. Outbox: `person.invited { personId, inviteId, role, clientId }`.
   */
  createInvite(invite: NewInvite): Promise<InviteRecord>;
  findInvite(firmId: string, inviteId: string): Promise<InviteRecord | null>;
  /** Sets the invite REVOKED. Audit: `UPDATE` on the person. Open tokens of the invite stop working. */
  revokeInvite(
    firmId: string,
    inviteId: string,
    actorId: string,
    requestId: string,
    now: Date,
  ): Promise<void>;
  /**
   * Accepts a pending invite with one of its unused, unexpired tokens: uses the token, sets the password (and the
   * display name when given), the person ACTIVE, grants the membership, marks the invite ACCEPTED. False, changing
   * nothing, when the token or invite is no longer usable (another request won). Audit: `UPDATE` on the person and
   * `MEMBERSHIP_CHANGE`. Outbox: `person.claimed` and `membership.changed` (GRANTED).
   */
  acceptInvite(accept: AcceptInvite): Promise<boolean>;
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
}

/** The membership an invite grants (the M0 `MembershipGrant`). */
export type Grant = MembershipGrant;

export interface Invitee {
  readonly personId: string;
  readonly status: PersonStatus;
  readonly email: string | null;
}

export interface NewInvite {
  readonly firmId: string;
  /** Null to create the person, INVITED, with `displayName`. */
  readonly personId: string | null;
  readonly displayName: string | null;
  readonly email: string;
  readonly grant: Grant;
  readonly invitedById: string;
  readonly linkExpiresAt: string;
  readonly requestId: string;
  readonly now: Date;
}

/**
 * A stored invite: the M0 `Invite` with the names the accept page shows. The store keeps status PENDING after
 * `linkExpiresAt`; the service reports such an invite as EXPIRED.
 */
export interface InviteRecord extends Invite {
  readonly firmName: string;
  readonly displayName: string;
  readonly clientName: string | null;
}

export interface AcceptInvite {
  readonly firmId: string;
  readonly inviteId: string;
  readonly tokenId: string;
  readonly passwordHash: string;
  /** The name the person chose on the accept page, or null to keep the imported one. */
  readonly displayName: string | null;
  readonly requestId: string;
  readonly now: Date;
}
