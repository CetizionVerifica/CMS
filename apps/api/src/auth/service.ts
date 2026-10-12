import type {
  Invite,
  InviteBody,
  InvitePreview,
  Me,
  MembershipGrant,
  MfaEnrollment,
  RequestContext,
} from '@canopy/contracts';
import {
  INVITE_DAYS,
  MAGIC_LINK_MINUTES,
  SESSION_HOURS,
  type AccountStore,
  type InviteRecord,
  type LoginCandidate,
  type LoginTokenKind,
  type NewSession,
} from './accounts.js';
import { buildRequestContext, mfaRequired, type Principal, type SessionRecord } from './context.js';
import { ApiError } from './errors.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';
import { can, canGrantRole } from './policy.js';
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

/** Sign-in, MFA and invite flows (endpoints.md §2). Routes validate input and call these. */
export class AuthService {
  private readonly store: AccountStore;
  private readonly secrets: SecretBox;
  private readonly clock: () => Date;

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
      // WIP: 409 FIRM_CHOICE_REQUIRED with details { firms: [{ id, name }] } once contracts add the code.
      throw new ApiError(
        'DUPLICATE',
        undefined,
        'This email signs in to more than one firm; choose one.',
      );
    }
    const [person] = matched as [LoginCandidate];
    return this.startSession(person.firmId, person.personId, 'PASSWORD', requestId);
  }

  /** Always succeeds, so it reveals nothing; ACTIVE people with the email get a link (sent by M9). */
  async requestMagicLink(email: string, requestId: string): Promise<void> {
    const candidates = await this.store.findLoginCandidates(email);
    for (const c of candidates.filter((x) => x.status === 'ACTIVE')) {
      await this.store.requestMagicLink(c.firmId, c.personId, requestId);
    }
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
    if (!(await this.store.consumeLoginToken(found.firmId, found.id, this.clock()))) {
      throw new ApiError('UNAUTHENTICATED', undefined, LINK_EXPIRED);
    }
    return this.startSession(found.firmId, found.personId, 'MAGIC_LINK', requestId);
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
      throw new ApiError('VALIDATION', {
        issues: [{ path: ['code'], message: 'Code is not correct.' }],
      });
    }
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
      const invitee = await this.store.findInvitee(ctx.firmId, personId);
      if (invitee === null) throw new ApiError('NOT_FOUND');
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
    };
  }

  async acceptInvite(
    token: string,
    input: { password: string; displayName?: string | undefined },
    requestId: string,
  ): Promise<IssuedSession> {
    const now = this.clock();
    const { found, invite } = await this.pendingInvite(token);
    const passwordHash = await hashPassword(input.password);
    const accepted = await this.store.acceptInvite({
      firmId: invite.firmId,
      inviteId: invite.id,
      tokenId: found.id,
      passwordHash,
      displayName: input.displayName ?? null,
      requestId,
      now,
    });
    if (!accepted) throw new ApiError('NOT_FOUND');
    return this.startSession(invite.firmId, invite.personId, 'INVITE', requestId);
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
  private async startSession(
    firmId: string,
    personId: string,
    method: NewSession['method'],
    requestId: string,
  ): Promise<IssuedSession> {
    const now = this.clock();
    const principal = await this.store.loadPrincipal(firmId, personId);
    const token = newToken();
    const pending = {
      firmId,
      personId,
      csrfToken: newToken(),
      mfaSatisfied: false,
      expiresAt: addMinutes(now, SESSION_HOURS * 60),
    };
    const ctx = buildRequestContext({
      requestId,
      session: { id: 'pending', ...pending },
      principal,
      now,
      allowBeforeMfa: true,
    });
    const record = await this.store.createSession({
      ...pending,
      tokenHash: hashToken(token),
      requestId,
      method,
    });
    return { token, record, me: await this.buildMe(ctx, record, principal!) };
  }

  private async buildMe(
    ctx: RequestContext,
    session: SessionRecord,
    principal: Principal,
  ): Promise<Me> {
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
    };
  }
}
