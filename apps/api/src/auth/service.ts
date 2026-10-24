import {
  EXPORT_ACCOUNT_STATUSES,
  SUPPORT_SESSION_HOURS,
  WORKING_ACCOUNT_STATUSES,
  type AccountStatus,
  type Invite,
  type InviteBody,
  type InvitePreview,
  type Me,
  type MembershipGrant,
  type MfaEnrollment,
  type RequestContext,
} from '@canopy/contracts';
import {
  INVITE_DAYS,
  MAGIC_LINK_MINUTES,
  SESSION_HOURS,
  type AccountStore,
  type InviteRecord,
  type LoginCandidate,
  type LoginTokenKind,
  type MfaRecord,
  type NewSession,
} from './accounts.js';
import {
  activeMemberships,
  buildRequestContext,
  mfaRequired,
  type Principal,
  type SessionRecord,
} from './context.js';
import { ApiError } from './errors.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';
import { can, canGrantRole, isFirmRole } from './policy.js';
import type { SecretBox } from './secretbox.js';
import { hashToken, newToken } from './tokens.js';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.js';

/** A new session. The raw cookie token goes to the browser once and is never stored. */
export interface IssuedSession {
  readonly token: string;
  readonly record: SessionRecord;
  readonly me: Me;
}

export interface AuthServiceOptions {
  readonly store: AccountStore;
  readonly secrets: SecretBox;
  readonly clock?: () => Date;
}

const addMinutes = (now: Date, minutes: number) =>
  new Date(now.getTime() + minutes * 60_000).toISOString();

const LINK_EXPIRED = 'This link has expired or was already used.';
const SUPPORT_LINK =
  'This support link has expired or was already used. Open it again from the console.';

const working: readonly AccountStatus[] = WORKING_ACCOUNT_STATUSES;
/** Accounts whose people may still ask for a sign-in: working ones, and admins of one pending deletion. */
const signInStatuses: readonly AccountStatus[] = [
  ...WORKING_ACCOUNT_STATUSES,
  ...EXPORT_ACCOUNT_STATUSES,
];
const TOO_MANY_CODES = 'Too many incorrect codes. Sign in again.';

/** Wrong MFA codes one session may send before it is revoked; the person's account locks after `LOCKOUT.attempts`. */
export const MFA_SESSION_FAILURES = 5;
/** A person gets at most one magic link per this many seconds, whoever asks. */
export const MAGIC_LINK_INTERVAL_SECONDS = 60;
/** Bound on the per-process counters below; the oldest entries go first. */
const TRACKED = 10_000;

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > TRACKED) map.delete(map.keys().next().value!);
}

/** Sign-in, MFA and invite flows (endpoints.md §2). Routes validate input and call these. */
export class AuthService {
  private readonly store: AccountStore;
  private readonly secrets: SecretBox;
  private readonly clock: () => Date;
  /** Wrong MFA codes per session id, in this process. */
  private readonly mfaFailures = new Map<string, number>();
  /** Last magic link per `firmId/personId`, in this process. */
  private readonly magicLinks = new Map<string, number>();

  constructor(options: AuthServiceOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Email and password. Every failure looks the same (`UNAUTHENTICATED`, similar time), whether the email
   * is unknown, the password wrong or the account locked. When the email and password match people in
   * more than one firm, the caller picks one and posts again with `firmId`.
   */
  async login(
    input: { email: string; password: string; firmId?: string | undefined },
    requestId: string,
  ): Promise<IssuedSession> {
    const now = this.clock();
    const candidates = (await this.store.findLoginCandidates(input.email)).filter(
      (c): c is LoginCandidate & { passwordHash: string } =>
        c.status === 'ACTIVE' &&
        c.passwordHash !== null &&
        (input.firmId === undefined || c.firmId === input.firmId),
    );
    if (candidates.length === 0) {
      await verifyAgainstDummy(input.password);
      throw new ApiError('UNAUTHENTICATED', undefined, 'Email or password is not correct.');
    }
    const matched: LoginCandidate[] = [];
    for (const candidate of candidates) {
      const locked =
        candidate.lockedUntil !== null && Date.parse(candidate.lockedUntil) > now.getTime();
      const ok = await verifyPassword(input.password, candidate.passwordHash);
      if (ok && !locked) matched.push(candidate);
      else if (!ok) await this.store.recordLoginFailure(candidate.firmId, candidate.personId, now);
    }
    if (matched.length === 0) {
      throw new ApiError('UNAUTHENTICATED', undefined, 'Email or password is not correct.');
    }
    if (matched.length > 1) {
      throw new ApiError('FIRM_CHOICE_REQUIRED', {
        firms: matched.map((c) => ({ id: c.firmId, name: c.firmName })),
      });
    }
    const [person] = matched as [LoginCandidate];
    // After the password check, so a wrong password says nothing about the account.
    if (!signInStatuses.includes(person.accountStatus)) {
      throw new ApiError('ACCOUNT_SUSPENDED', { status: person.accountStatus });
    }
    return this.startSession(person.firmId, person.personId, 'PASSWORD', requestId);
  }

  /**
   * Always succeeds, so it reveals nothing; ACTIVE people with the email get a link (sent by M9). While the account
   * is PENDING_DELETION only its account admins can sign in, so only they get one.
   */
  async requestMagicLink(email: string, requestId: string): Promise<void> {
    const candidates = await this.store.findLoginCandidates(email);
    const at = this.clock();
    const now = at.getTime();
    for (const c of candidates.filter(
      (x) => x.status === 'ACTIVE' && signInStatuses.includes(x.accountStatus),
    )) {
      if (!working.includes(c.accountStatus) && !(await this.isAccountAdmin(c, at))) continue;
      const key = `${c.firmId}/${c.personId}`;
      const last = this.magicLinks.get(key);
      if (last !== undefined && now - last < MAGIC_LINK_INTERVAL_SECONDS * 1000) continue;
      remember(this.magicLinks, key, now);
      await this.store.requestMagicLink(c.firmId, c.personId, requestId);
    }
  }

  private async isAccountAdmin(c: LoginCandidate, now: Date): Promise<boolean> {
    const principal = await this.store.loadPrincipal(c.firmId, c.personId);
    return (
      principal !== null &&
      activeMemberships(principal.memberships, now).some((m) => m.role === 'FIRM_ADMIN')
    );
  }

  /**
   * Creates a one-time sign-in token and returns the raw value for the email. M9 calls this when it handles
   * `auth.magic_link_requested` (kind MAGIC_LINK) or `person.invited` (kind INVITE), so raw tokens never
   * sit in the database or the outbox.
   */
  async issueLoginToken(input: {
    firmId: string;
    personId: string;
    kind: LoginTokenKind;
    inviteId?: string;
  }): Promise<{ token: string; expiresAt: string }> {
    const now = this.clock();
    const token = newToken();
    const expiresAt =
      input.kind === 'MAGIC_LINK'
        ? addMinutes(now, MAGIC_LINK_MINUTES)
        : addMinutes(now, INVITE_DAYS * 24 * 60);
    await this.store.createLoginToken({
      firmId: input.firmId,
      personId: input.personId,
      kind: input.kind,
      inviteId: input.inviteId ?? null,
      tokenHash: hashToken(token),
      expiresAt,
    });
    return { token, expiresAt };
  }

  async verifyMagicLink(token: string, requestId: string): Promise<IssuedSession> {
    const found = await this.usableToken(token, 'MAGIC_LINK');
    // Refused before the link is used up, so it still works if the account is resumed within its life.
    await this.sessionContext(found.firmId, found.personId, requestId);
    if (!(await this.store.consumeLoginToken(found.firmId, found.id, this.clock()))) {
      throw new ApiError('UNAUTHENTICATED', undefined, LINK_EXPIRED);
    }
    return this.startSession(found.firmId, found.personId, 'MAGIC_LINK', requestId);
  }

  /**
   * Exchanges the one-time token the operator console opened the app with for a PlanetPulse support session
   * (ADR M15-0001 decision 11): MFA satisfied (the operator passed it in the console), ending at the earlier of
   * `SUPPORT_SESSION_HOURS` and the grant's end. Any unusable token is UNAUTHENTICATED.
   */
  async verifySupportSession(token: string, requestId: string): Promise<IssuedSession> {
    const now = this.clock();
    const found = await this.store.findSupportToken(hashToken(token));
    if (
      found === null ||
      found.usedAt !== null ||
      Date.parse(found.expiresAt) <= now.getTime() ||
      !found.grantLive ||
      Date.parse(found.grantEndsAt) <= now.getTime()
    ) {
      throw new ApiError('UNAUTHENTICATED', undefined, SUPPORT_LINK);
    }
    if (!working.includes(found.accountStatus)) {
      throw new ApiError('ACCOUNT_SUSPENDED', { status: found.accountStatus });
    }
    await this.sessionContext(found.firmId, found.personId, requestId, found.supportGrantId);
    if (!(await this.store.consumeLoginToken(found.firmId, found.id, now))) {
      throw new ApiError('UNAUTHENTICATED', undefined, SUPPORT_LINK);
    }
    const capped = Math.min(
      now.getTime() + SUPPORT_SESSION_HOURS * 3_600_000,
      Date.parse(found.grantEndsAt),
    );
    return this.startSession(found.firmId, found.personId, 'SUPPORT', requestId, {
      supportGrantId: found.supportGrantId,
      expiresAt: new Date(capped).toISOString(),
    });
  }

  async logout(session: SessionRecord): Promise<void> {
    await this.store.revokeSession(session.firmId, session.id, this.clock());
  }

  /** `Me` for a session's request context. */
  async me(ctx: RequestContext, session: SessionRecord): Promise<Me> {
    const principal = await this.store.loadPrincipal(ctx.firmId, ctx.personId);
    if (principal === null) throw new ApiError('UNAUTHENTICATED');
    return this.buildMe(ctx, session, principal);
  }

  /** Starts (or restarts, before the first code) TOTP enrolment. */
  async enrollMfa(ctx: RequestContext): Promise<MfaEnrollment> {
    const existing = await this.store.getMfa(ctx.firmId, ctx.personId);
    if (existing?.enrolledAt) {
      throw new ApiError(
        'DUPLICATE',
        { field: 'mfa', existingId: ctx.personId },
        'MFA is already set up.',
      );
    }
    const principal = await this.store.loadPrincipal(ctx.firmId, ctx.personId);
    const secret = newTotpSecret();
    await this.store.saveMfa(ctx.firmId, ctx.personId, {
      sealedSecret: this.secrets.seal(secret),
      enrolledAt: null,
      lastStep: null,
    });
    return { otpauthUrl: otpauthUri(secret, principal?.person.email ?? ctx.personId) };
  }

  /** Verifies a code, completes enrolment on the first one, and marks the session MFA-satisfied. */
  async verifyMfa(ctx: RequestContext, session: SessionRecord, code: string): Promise<Me> {
    const now = this.clock();
    const record = await this.store.getMfa(ctx.firmId, ctx.personId);
    if (record === null) {
      throw new ApiError('MFA_REQUIRED', { enrolled: false }, 'Set up MFA first.');
    }
    const step = verifyTotp(this.secrets.open(record.sealedSecret), code, now);
    if (step === null || !(await this.store.acceptMfaStep(ctx.firmId, ctx.personId, step))) {
      await this.mfaFailed(session, now);
      throw new ApiError('VALIDATION', {
        issues: [{ path: ['code'], message: 'Code is not correct.' }],
      });
    }
    this.mfaFailures.delete(session.id);
    await this.store.resetLoginFailures(ctx.firmId, ctx.personId);
    if (record.enrolledAt === null) {
      await this.store.saveMfa(ctx.firmId, ctx.personId, {
        ...record,
        enrolledAt: now.toISOString(),
        lastStep: step,
      });
    }
    await this.store.markSessionMfa(session.firmId, session.id);
    return this.me({ ...ctx, mfaSatisfied: true }, { ...session, mfaSatisfied: true });
  }

  /**
   * Invites an existing UNCLAIMED (imported) or INVITED person, or a new person by name, to claim an account
   * with a membership.
   */
  async invite(ctx: RequestContext, body: InviteBody, requestId: string): Promise<Invite> {
    const { personId, displayName, email, ...grant } = body;
    this.authorizeGrant(ctx, grant);
    if (personId !== undefined) {
      const invitee = await this.store.findInvitee(ctx.firmId, personId, this.clock());
      // Claiming the account brings every role the person holds, so the inviter must be able to grant each one;
      // otherwise the person is outside their scope and reads as not found.
      // The PlanetPulse support person gets access only from a support grant (ADR M15-0001 decision 11).
      if (
        invitee === null ||
        invitee.support ||
        invitee.roles.some((r) => !canGrantRole(ctx, r.role, r.clientId))
      ) {
        throw new ApiError('NOT_FOUND');
      }
      if (invitee.status !== 'UNCLAIMED' && invitee.status !== 'INVITED') {
        throw new ApiError(
          'DUPLICATE',
          { field: 'personId', existingId: personId },
          'This person already has an account.',
        );
      }
    }
    const owner = await this.store.findPersonIdByEmail(ctx.firmId, email);
    if (owner !== null && owner !== personId) {
      throw new ApiError(
        'DUPLICATE',
        { field: 'email', existingId: owner },
        'Someone in this firm already has this email.',
      );
    }
    const now = this.clock();
    const record = await this.store.createInvite({
      firmId: ctx.firmId,
      personId: personId ?? null,
      displayName: displayName ?? null,
      email,
      grant,
      invitedById: ctx.personId,
      linkExpiresAt: addMinutes(now, INVITE_DAYS * 24 * 60),
      requestId,
      now,
    });
    return this.inviteView(record);
  }

  /** What the invite page shows. Any unusable token, or an invite no longer pending, is NOT_FOUND. */
  async invitePreview(token: string): Promise<InvitePreview> {
    const { invite } = await this.pendingInvite(token);
    return {
      email: invite.email,
      displayName: invite.displayName,
      firmName: invite.firmName,
      clientName: invite.clientName,
      role: invite.role,
      linkExpiresAt: invite.linkExpiresAt,
      mfaRequired: await this.inviteNeedsMfa(invite),
    };
  }

  /**
   * TOTP setup for an invite whose role needs MFA, before the account exists (docs/security/review.md F14). The invite
   * token is the only credential, so setup restarts until the invite is accepted; NOT_FOUND for an invite with no MFA.
   */
  async enrollInviteMfa(token: string): Promise<MfaEnrollment> {
    const { invite } = await this.pendingInvite(token);
    if (!(await this.inviteNeedsMfa(invite))) throw new ApiError('NOT_FOUND');
    const existing = await this.store.getMfa(invite.firmId, invite.personId);
    if (existing?.enrolledAt) {
      throw new ApiError(
        'DUPLICATE',
        { field: 'mfa', existingId: invite.personId },
        'MFA is already set up.',
      );
    }
    const secret = newTotpSecret();
    await this.store.saveMfa(invite.firmId, invite.personId, {
      sealedSecret: this.secrets.seal(secret),
      enrolledAt: null,
      lastStep: null,
    });
    return { otpauthUrl: otpauthUri(secret, invite.email) };
  }

  async acceptInvite(
    token: string,
    input: { password: string; displayName?: string | undefined; mfaCode?: string | undefined },
    requestId: string,
  ): Promise<IssuedSession> {
    const now = this.clock();
    const { found, invite } = await this.pendingInvite(token);
    const account = await this.store.account(invite.firmId);
    // A PROVISIONING account takes only its owner's invite, the FIRM_ADMIN invite the owner "created" for
    // themselves; accepting it opens the account (ADR M15-0001 decision 3, the db's canopy_activate_account).
    const opening =
      account?.status === 'PROVISIONING' &&
      invite.role === 'FIRM_ADMIN' &&
      invite.invitedById === invite.personId;
    if (account && !working.includes(account.status) && !opening) {
      throw new ApiError('ACCOUNT_SUSPENDED', { status: account.status });
    }
    // The owner waits for M6's master library copy (ADR M15-0001 decision 8): the page says the account is still
    // being set up. The trigger refuses too, so nothing opens without its library.
    if (opening && !(await this.store.libraryCopied(invite.firmId))) {
      throw new ApiError('ACCOUNT_SUSPENDED', { status: 'PROVISIONING' });
    }
    // A firm role completes MFA setup here, before the password is set, so no session ever exists with a password
    // and no MFA (F14). A missing or wrong code changes nothing and leaves the invite usable.
    const mfa = await this.inviteNeedsMfa(invite);
    const enrolment = mfa ? await this.checkInviteMfa(invite, input.mfaCode, now) : null;
    const passwordHash = await hashPassword(input.password);
    const accepted = await this.store.acceptInvite({
      firmId: invite.firmId,
      inviteId: invite.id,
      tokenId: found.id,
      passwordHash,
      displayName: input.displayName ?? null,
      mfa: enrolment,
      requestId,
      now,
    });
    if (!accepted) throw new ApiError('NOT_FOUND');
    return this.startSession(invite.firmId, invite.personId, 'INVITE', requestId, undefined, mfa);
  }

  /** A firm role in a firm that requires MFA: the accept page sets up the authenticator first. */
  private async inviteNeedsMfa(invite: InviteRecord): Promise<boolean> {
    if (!isFirmRole(invite.role)) return false;
    const principal = await this.store.loadPrincipal(invite.firmId, invite.personId);
    return principal?.mfaRequiredForFirmRoles ?? true;
  }

  /**
   * Checks the authenticator's first code against the invite's setup and returns the completed enrolment, which the
   * store saves with the accept so a failed accept leaves the setup open to restart.
   */
  private async checkInviteMfa(
    invite: InviteRecord,
    code: string | undefined,
    now: Date,
  ): Promise<MfaRecord | null> {
    const record = await this.store.getMfa(invite.firmId, invite.personId);
    if (record === null || code === undefined) {
      throw new ApiError('MFA_REQUIRED', { enrolled: false }, 'Set up MFA first.');
    }
    const step = verifyTotp(this.secrets.open(record.sealedSecret), code, now);
    if (step === null || !(await this.store.acceptMfaStep(invite.firmId, invite.personId, step))) {
      throw new ApiError('VALIDATION', {
        issues: [{ path: ['mfaCode'], message: 'Code is not correct.' }],
      });
    }
    return record.enrolledAt === null
      ? { ...record, enrolledAt: now.toISOString(), lastStep: step }
      : null;
  }

  async revokeInvite(ctx: RequestContext, inviteId: string, requestId: string): Promise<Invite> {
    const invite = await this.store.findInvite(ctx.firmId, inviteId);
    if (invite === null || (invite.clientId !== null && !ctx.clientIds.includes(invite.clientId))) {
      throw new ApiError('NOT_FOUND');
    }
    this.authorizeGrant(ctx, invite);
    if (this.inviteView(invite).status !== 'PENDING') {
      throw new ApiError('INVALID_TRANSITION', undefined, 'Only a pending invite can be revoked.');
    }
    await this.store.revokeInvite(ctx.firmId, inviteId, ctx.personId, requestId, this.clock());
    const revoked = await this.store.findInvite(ctx.firmId, inviteId);
    if (revoked === null) throw new ApiError('NOT_FOUND');
    return this.inviteView(revoked);
  }

  /** person.invite on the grant's client, and the right to grant that role (endpoints.md §2). */
  private authorizeGrant(ctx: RequestContext, grant: MembershipGrant): void {
    const allowed =
      can(ctx, 'person.invite', { type: 'person', clientId: grant.clientId }) &&
      canGrantRole(ctx, grant.role, grant.clientId) &&
      (grant.consultantClientIds ?? []).every((id) => canGrantRole(ctx, 'OWNER', id));
    if (!allowed) throw new ApiError('FORBIDDEN', { action: 'person.invite' });
  }

  /** The contract `Invite`: a PENDING invite past its link expiry is EXPIRED. */
  private inviteView(record: InviteRecord): Invite {
    const invite: Invite = {
      id: record.id,
      firmId: record.firmId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archivedAt: record.archivedAt,
      personId: record.personId,
      email: record.email,
      role: record.role,
      clientId: record.clientId,
      consultantClientIds: record.consultantClientIds,
      unitIds: record.unitIds,
      expiresAt: record.expiresAt,
      status: record.status,
      invitedById: record.invitedById,
      linkExpiresAt: record.linkExpiresAt,
    };
    const expired =
      invite.status === 'PENDING' && Date.parse(invite.linkExpiresAt) <= this.clock().getTime();
    return expired ? { ...invite, status: 'EXPIRED' } : invite;
  }

  private async pendingInvite(token: string) {
    const found = await this.usableToken(token, 'INVITE');
    const invite =
      found.inviteId === null ? null : await this.store.findInvite(found.firmId, found.inviteId);
    if (
      invite === null ||
      invite.personId !== found.personId ||
      this.inviteView(invite).status !== 'PENDING'
    ) {
      throw new ApiError('NOT_FOUND');
    }
    return { found, invite };
  }

  private async usableToken(token: string, kind: LoginTokenKind) {
    const found = await this.store.findLoginToken(hashToken(token));
    const usable =
      found !== null &&
      found.kind === kind &&
      found.usedAt === null &&
      Date.parse(found.expiresAt) > this.clock().getTime();
    if (!usable) {
      throw kind === 'INVITE'
        ? new ApiError('NOT_FOUND')
        : new ApiError('UNAUTHENTICATED', undefined, LINK_EXPIRED);
    }
    return found;
  }

  /**
   * Checks the person may sign in (ACTIVE, with an active membership) before any session exists, then stores the
   * session and returns `Me` for it.
   */
  /**
   * Counts a wrong MFA code: the session is revoked after `MFA_SESSION_FAILURES`, and when the person's failures
   * (passwords and codes) reach `LOCKOUT.attempts` the account locks and all their sessions end.
   */
  private async mfaFailed(session: SessionRecord, now: Date): Promise<void> {
    const locked = await this.store.recordLoginFailure(session.firmId, session.personId, now);
    if (locked) {
      this.mfaFailures.delete(session.id);
      await this.store.revokeAllSessions(session.firmId, session.personId, now);
      throw new ApiError('UNAUTHENTICATED', undefined, TOO_MANY_CODES);
    }
    const failures = (this.mfaFailures.get(session.id) ?? 0) + 1;
    if (failures >= MFA_SESSION_FAILURES) {
      this.mfaFailures.delete(session.id);
      await this.store.revokeSession(session.firmId, session.id, now);
      throw new ApiError('UNAUTHENTICATED', undefined, TOO_MANY_CODES);
    }
    remember(this.mfaFailures, session.id, failures);
  }

  /**
   * The request context a new session would get, or the error that refuses it: the person must be ACTIVE with an
   * active membership, and the account must let them in (`checkAccount`). Called before a link is used up.
   */
  private async sessionContext(
    firmId: string,
    personId: string,
    requestId: string,
    supportGrantId: string | null = null,
  ): Promise<{ ctx: RequestContext; principal: Principal }> {
    const now = this.clock();
    const [principal, account] = [
      await this.store.loadPrincipal(firmId, personId),
      await this.store.account(firmId),
    ];
    const ctx = buildRequestContext({
      requestId,
      session: {
        id: 'pending',
        firmId,
        personId,
        csrfToken: 'pending',
        mfaSatisfied: false,
        expiresAt: addMinutes(now, 1),
        accountStatus: account?.status ?? 'ACTIVE',
        supportGrantId,
      },
      principal,
      now,
      allowBeforeMfa: true,
      // A sign-in lands on `/me`, which an admin of an account pending deletion may still reach.
      allowWhilePendingDeletion: true,
    });
    return { ctx, principal: principal! };
  }

  private async startSession(
    firmId: string,
    personId: string,
    method: NewSession['method'],
    requestId: string,
    support?: { supportGrantId: string; expiresAt: string },
    /** MFA was passed in this step: an invite that completed MFA setup. */
    mfaPassed = false,
  ): Promise<IssuedSession> {
    const now = this.clock();
    const { ctx: pendingCtx, principal } = await this.sessionContext(
      firmId,
      personId,
      requestId,
      support?.supportGrantId ?? null,
    );
    const token = newToken();
    // The operator passed MFA in the console to open a support session.
    const mfaSatisfied = support !== undefined || mfaPassed;
    const pending = {
      firmId,
      personId,
      csrfToken: newToken(),
      mfaSatisfied,
      expiresAt: support?.expiresAt ?? addMinutes(now, SESSION_HOURS * 60),
    };
    const record = await this.store.createSession({
      ...pending,
      owesMfa: !mfaSatisfied && mfaRequired(principal, pendingCtx.memberships),
      createdAt: now.toISOString(),
      tokenHash: hashToken(token),
      requestId,
      method,
      ...(support ? { supportGrantId: support.supportGrantId } : {}),
    });
    const ctx = { ...pendingCtx, mfaSatisfied };
    return { token, record, me: await this.buildMe(ctx, record, principal) };
  }

  private async buildMe(
    ctx: RequestContext,
    session: SessionRecord,
    principal: Principal,
  ): Promise<Me> {
    const account = await this.store.account(ctx.firmId);
    return {
      person: principal.person,
      memberships: [...ctx.memberships],
      clients: await this.store.clientSummaries(ctx),
      csrfToken: session.csrfToken,
      mfa: {
        required: mfaRequired(principal, ctx.memberships),
        enrolled: principal.mfaEnrolled,
        satisfied: session.mfaSatisfied,
      },
      session: { expiresAt: session.expiresAt },
      ...(account
        ? {
            account: {
              kind: account.kind,
              status: account.status,
              trialEndsOn: account.trialEndsOn,
            },
          }
        : {}),
    };
  }
}
