import type { RequestContext, Role } from '@canopy/contracts';
import {
  INVITE_DAYS,
  MAGIC_LINK_MINUTES,
  SESSION_HOURS,
  type AccountStore,
  type Grant,
  type LoginCandidate,
  type LoginTokenKind,
  type NewSession,
} from './accounts.js';
import { activeMemberships, mfaRequired } from './context.js';
import { ApiError } from './errors.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';
import { can, canGrantRole } from './policy.js';
import type { SecretBox } from './secretbox.js';
import { hashToken, newToken } from './tokens.js';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.js';

/** A new session: the raw cookie token goes to the client once and is never stored. */
export interface IssuedSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly mfaRequired: boolean;
  readonly mfaEnrolled: boolean;
}

export type LoginResult =
  | { readonly status: 'OK'; readonly session: IssuedSession }
  | { readonly status: 'CHOOSE_FIRM'; readonly firms: { firmId: string; firmName: string }[] };

export interface InviteInput {
  readonly personId: string;
  readonly email: string;
  readonly grant: Grant;
}

export interface AuthServiceOptions {
  readonly store: AccountStore;
  readonly secrets: SecretBox;
  readonly clock?: () => Date;
}

const addMinutes = (now: Date, minutes: number) =>
  new Date(now.getTime() + minutes * 60_000).toISOString();

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
   * more than one firm, the caller picks one (`CHOOSE_FIRM`) and posts again with `firmId`.
   */
  async login(
    input: { email: string; password: string; firmId?: string },
    requestId: string,
  ): Promise<LoginResult> {
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
      return {
        status: 'CHOOSE_FIRM',
        firms: matched.map((c) => ({ firmId: c.firmId, firmName: c.firmName })),
      };
    }
    const [person] = matched as [LoginCandidate];
    return {
      status: 'OK',
      session: await this.startSession(person.firmId, person.personId, 'PASSWORD', requestId),
    };
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
    if (!(await this.store.consumeLoginToken(found.id, this.clock()))) {
      throw new ApiError(
        'UNAUTHENTICATED',
        undefined,
        'This link has expired or was already used.',
      );
    }
    return this.startSession(found.firmId, found.personId, 'MAGIC_LINK', requestId);
  }

  async logout(sessionId: string): Promise<void> {
    await this.store.revokeSession(sessionId);
  }

  /** Starts (or restarts, before the first code) TOTP enrolment. */
  async enrollMfa(
    ctx: RequestContext,
    account: string,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const existing = await this.store.getMfa(ctx.firmId, ctx.personId);
    if (existing?.enrolledAt) throw new ApiError('DUPLICATE', undefined, 'MFA is already set up.');
    const secret = newTotpSecret();
    await this.store.saveMfa(ctx.firmId, ctx.personId, {
      sealedSecret: this.secrets.seal(secret),
      enrolledAt: null,
      lastStep: null,
    });
    return { secret, otpauthUri: otpauthUri(secret, account) };
  }

  /** Verifies a code, completes enrolment on the first one, and marks the session MFA-satisfied. */
  async verifyMfa(ctx: RequestContext, sessionId: string, code: string): Promise<void> {
    const now = this.clock();
    const record = await this.store.getMfa(ctx.firmId, ctx.personId);
    if (record === null) {
      throw new ApiError('MFA_REQUIRED', { enrolled: false }, 'Set up MFA first.');
    }
    const step = verifyTotp(this.secrets.open(record.sealedSecret), code, now);
    if (step === null || (record.lastStep !== null && step <= record.lastStep)) {
      throw new ApiError('VALIDATION', {
        issues: [{ path: 'code', message: 'Code is not correct.' }],
      });
    }
    await this.store.saveMfa(ctx.firmId, ctx.personId, {
      ...record,
      enrolledAt: record.enrolledAt ?? now.toISOString(),
      lastStep: step,
    });
    await this.store.markSessionMfa(sessionId);
  }

  /** Invites an UNCLAIMED (imported) or INVITED person to claim their account with a membership. */
  async invite(ctx: RequestContext, input: InviteInput, requestId: string) {
    const { grant } = input;
    this.authorizeGrant(ctx, grant);
    const invitee = await this.store.findInvitee(ctx.firmId, input.personId);
    if (invitee === null) throw new ApiError('NOT_FOUND');
    if (invitee.status !== 'UNCLAIMED' && invitee.status !== 'INVITED') {
      throw new ApiError(
        'DUPLICATE',
        { personId: input.personId },
        'This person already has an account.',
      );
    }
    return this.store.createInvite({
      firmId: ctx.firmId,
      personId: input.personId,
      email: input.email,
      grant,
      createdById: ctx.personId,
      expiresAt: addMinutes(this.clock(), INVITE_DAYS * 24 * 60),
      requestId,
    });
  }

  /** What the invite page shows. Any unusable token is NOT_FOUND. */
  async inviteDetails(token: string) {
    const found = await this.usableToken(token, 'INVITE');
    const invite = await this.store.findInvite(found.firmId, found.inviteId!);
    if (invite === null) throw new ApiError('NOT_FOUND');
    return { firmName: invite.firmName, email: invite.email, role: invite.grant.role };
  }

  async acceptInvite(token: string, password: string, requestId: string): Promise<IssuedSession> {
    const now = this.clock();
    const found = await this.usableToken(token, 'INVITE');
    const passwordHash = await hashPassword(password);
    if (!(await this.store.consumeLoginToken(found.id, now))) throw new ApiError('NOT_FOUND');
    await this.store.acceptInvite({
      firmId: found.firmId,
      inviteId: found.inviteId!,
      tokenId: found.id,
      passwordHash,
      requestId,
      now,
    });
    return this.startSession(found.firmId, found.personId, 'INVITE', requestId);
  }

  async revokeInvite(ctx: RequestContext, inviteId: string, requestId: string): Promise<void> {
    const invite = await this.store.findInvite(ctx.firmId, inviteId);
    if (
      invite === null ||
      (invite.grant.clientId !== null && !ctx.clientIds.includes(invite.grant.clientId))
    ) {
      throw new ApiError('NOT_FOUND');
    }
    this.authorizeGrant(ctx, invite.grant);
    if (invite.acceptedAt !== null || invite.revokedAt !== null) {
      throw new ApiError('INVALID_TRANSITION', {
        from: invite.acceptedAt ? 'ACCEPTED' : 'REVOKED',
        action: 'REVOKE',
      });
    }
    await this.store.revokeInvite(ctx.firmId, inviteId, ctx.personId, requestId, this.clock());
  }

  /** person.invite on the grant's client, and the right to grant that role (endpoints.md §2). */
  private authorizeGrant(ctx: RequestContext, grant: Grant): void {
    const allowed =
      can(ctx, 'person.invite', { type: 'person', clientId: grant.clientId }) &&
      canGrantRole(ctx, grant.role, grant.clientId) &&
      (grant.consultantClientIds ?? []).every((id) => canGrantRole(ctx, 'OWNER', id));
    if (!allowed) throw new ApiError('FORBIDDEN', { action: 'person.invite' });
    checkGrantShape(grant);
  }

  private async usableToken(token: string, kind: LoginTokenKind) {
    const found = await this.store.findLoginToken(hashToken(token));
    const usable =
      found !== null &&
      found.kind === kind &&
      found.usedAt === null &&
      Date.parse(found.expiresAt) > this.clock().getTime() &&
      (kind !== 'INVITE' || (found.inviteId !== null && found.inviteOpen));
    if (!usable) {
      throw kind === 'INVITE'
        ? new ApiError('NOT_FOUND')
        : new ApiError('UNAUTHENTICATED', undefined, 'This link has expired or was already used.');
    }
    return found;
  }

  private async startSession(
    firmId: string,
    personId: string,
    method: NewSession['method'],
    requestId: string,
  ): Promise<IssuedSession> {
    const now = this.clock();
    const principal = await this.store.loadPrincipal(firmId, personId);
    const active = principal ? activeMemberships(principal.memberships, now) : [];
    const token = newToken();
    const csrfToken = newToken();
    const expiresAt = addMinutes(now, SESSION_HOURS * 60);
    const needsMfa = principal !== null && mfaRequired(principal, active);
    await this.store.createSession({
      firmId,
      personId,
      tokenHash: hashToken(token),
      csrfToken,
      mfaSatisfied: false,
      expiresAt,
      requestId,
      method,
    });
    return {
      token,
      csrfToken,
      expiresAt,
      mfaRequired: needsMfa,
      mfaEnrolled: principal?.mfaEnrolled ?? false,
    };
  }
}

const UNIT_ROLES: readonly Role[] = ['OWNER', 'APPROVER'];

/** The membership shape rules of the M0 `Membership` schema, as `VALIDATION` errors. */
function checkGrantShape(grant: Grant): void {
  const issues: { path: string; message: string }[] = [];
  if ((grant.role === 'CONSULTANT') !== (grant.consultantClientIds !== null)) {
    issues.push({ path: 'consultantClientIds', message: 'Required for CONSULTANT only.' });
  }
  if (grant.unitIds !== null && !UNIT_ROLES.includes(grant.role)) {
    issues.push({ path: 'unitIds', message: 'Only OWNER and APPROVER are limited to units.' });
  }
  if (grant.role === 'VIEWER' && grant.expiresAt === null) {
    issues.push({ path: 'expiresAt', message: 'VIEWER access needs an expiry date.' });
  }
  if (issues.length > 0) throw new ApiError('VALIDATION', { issues });
}
