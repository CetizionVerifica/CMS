import { Id, Instant, type Membership, type Person, Role } from '@canopy/contracts';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { LoginTokenKind, TokenHash } from '../auth-lookups.js';
import type { TenantTx } from '../database.js';
import { DbError, rethrow, validate } from '../errors.js';
import * as s from '../schema/index.js';
import { memberships, people } from './tenancy.js';

/**
 * Sign-in storage for M5's AccountStore (apps/api/src/auth/accounts.ts), ADR M3-0001. Lookups before a tenant
 * is known are on `Database` (`findLoginCandidates`, `findSession`, `findLoginToken`); everything here runs in
 * `withTenant`, usually `systemContext(firmId, requestId)`. RLS lets a person reach their own rows and firm staff
 * every row of the firm. As everywhere, the caller writes the audit and outbox rows in the same transaction.
 * Never log what these take or return: they carry password hashes, CSRF tokens and sealed MFA secrets.
 */

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const at = (value: string): Date => new Date(validate(Instant, value));

/** MFA state: the TOTP secret sealed by M5's SecretBox, when it was confirmed, and the last step accepted. */
export const MfaRecord = z.strictObject({
  /** SecretBox's `v1.<iv>.<tag>.<ciphertext>`; the table has the same CHECK. */
  sealedSecret: z.string().regex(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/, 'Expected a sealed secret'),
  enrolledAt: Instant.nullable(),
  lastStep: z.int().min(0).nullable(),
});
export type MfaRecord = z.infer<typeof MfaRecord>;

export interface Credential {
  personId: string;
  passwordHash: string | null;
  mfaEnrolled: boolean;
  failedAttempts: number;
  lockedUntil: string | null;
}

export const Lockout = z.strictObject({ attempts: z.int().min(1), minutes: z.int().min(1) });
export type Lockout = z.infer<typeof Lockout>;

/** M5's stored scrypt form (apps/api/src/auth/passwords.ts); the table has the same CHECK. */
const PasswordHash = z
  .string()
  .max(1000)
  .regex(/^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/, 'Expected an scrypt hash');

export const credentials = {
  async get(tx: TenantTx, personId: string): Promise<Credential | null> {
    const t = s.authCredential;
    const [row] = await tx
      .select({
        personId: t.personId,
        passwordHash: t.passwordHash,
        enrolledAt: t.mfaEnrolledAt,
        failedAttempts: t.failedAttempts,
        lockedUntil: t.lockedUntil,
      })
      .from(t)
      .where(eq(t.personId, validate(Id, personId)))
      .catch(rethrow);
    if (!row) return null;
    return {
      personId: row.personId,
      passwordHash: row.passwordHash,
      mfaEnrolled: row.enrolledAt !== null,
      failedAttempts: row.failedAttempts,
      lockedUntil: iso(row.lockedUntil),
    };
  },
  /** Sets the password and clears failed attempts and any lock. */
  async setPassword(tx: TenantTx, personId: string, passwordHash: string): Promise<void> {
    await tx
      .insert(s.authCredential)
      .values({
        personId: validate(Id, personId),
        passwordHash: validate(PasswordHash, passwordHash),
      })
      .onConflictDoUpdate({
        target: s.authCredential.personId,
        set: { passwordHash, failedAttempts: 0, lockedUntil: null },
      })
      .catch(rethrow);
  },
  /**
   * Counts a failed password in one statement (concurrent failures all count). The `attempts`-th failure in a
   * row locks the account until `now + minutes` and starts the count again. Returns the lock, if any.
   */
  async recordFailure(
    tx: TenantTx,
    personId: string,
    now: string,
    lockout: Lockout,
  ): Promise<{ lockedUntil: string | null }> {
    const { attempts, minutes } = validate(Lockout, lockout);
    const lockAt = new Date(at(now).getTime() + minutes * 60_000);
    const t = s.authCredential;
    const reached = sql`${t.failedAttempts} + 1 >= ${attempts}`;
    const [row] = await tx
      .insert(t)
      .values({
        personId: validate(Id, personId),
        failedAttempts: attempts <= 1 ? 0 : 1,
        lockedUntil: attempts <= 1 ? lockAt : null,
      })
      .onConflictDoUpdate({
        target: t.personId,
        set: {
          failedAttempts: sql`case when ${reached} then 0 else ${t.failedAttempts} + 1 end`,
          lockedUntil: sql`case when ${reached} then ${lockAt}::timestamptz else ${t.lockedUntil} end`,
        },
      })
      .returning({ lockedUntil: t.lockedUntil })
      .catch(rethrow);
    return { lockedUntil: iso(row?.lockedUntil ?? null) };
  },
  /** After a successful sign-in. */
  async resetFailures(tx: TenantTx, personId: string): Promise<void> {
    await tx
      .update(s.authCredential)
      .set({ failedAttempts: 0 })
      .where(eq(s.authCredential.personId, validate(Id, personId)))
      .catch(rethrow);
  },
  async getMfa(tx: TenantTx, personId: string): Promise<MfaRecord | null> {
    const t = s.authCredential;
    const [row] = await tx
      .select({
        sealedSecret: t.mfaSealedSecret,
        enrolledAt: t.mfaEnrolledAt,
        lastStep: t.mfaLastStep,
      })
      .from(t)
      .where(eq(t.personId, validate(Id, personId)))
      .catch(rethrow);
    if (!row || row.sealedSecret === null) return null;
    return {
      sealedSecret: row.sealedSecret,
      enrolledAt: iso(row.enrolledAt),
      lastStep: row.lastStep,
    };
  },
  async saveMfa(tx: TenantTx, personId: string, record: MfaRecord): Promise<void> {
    const r = validate(MfaRecord, record);
    const values = {
      mfaSealedSecret: r.sealedSecret,
      mfaEnrolledAt: r.enrolledAt === null ? null : new Date(r.enrolledAt),
      mfaLastStep: r.lastStep,
    };
    await tx
      .insert(s.authCredential)
      .values({ personId: validate(Id, personId), ...values })
      .onConflictDoUpdate({ target: s.authCredential.personId, set: values })
      .catch(rethrow);
  },
  /**
   * Records `step` as the last accepted TOTP step, only if it is later than the stored one. False when the
   * step (or a later one) was already used: a replayed code, or a concurrent request that won.
   */
  async acceptMfaStep(tx: TenantTx, personId: string, step: number): Promise<boolean> {
    const t = s.authCredential;
    const n = validate(z.int().min(0), step);
    const rows = await tx
      .update(t)
      .set({ mfaLastStep: n })
      .where(
        and(
          eq(t.personId, validate(Id, personId)),
          sql`${t.mfaSealedSecret} is not null`,
          or(isNull(t.mfaLastStep), lt(t.mfaLastStep, n)),
        ),
      )
      .returning({ id: t.id })
      .catch(rethrow);
    return rows.length === 1;
  },
};

export const SessionMethod = z.enum(['PASSWORD', 'MAGIC_LINK', 'INVITE']);
export type SessionMethod = z.infer<typeof SessionMethod>;

export const NewSession = z.strictObject({
  personId: Id,
  tokenHash: TokenHash,
  csrfToken: z.string().min(32).max(200),
  mfaSatisfied: z.boolean(),
  expiresAt: Instant,
  method: SessionMethod,
});
export type NewSession = z.infer<typeof NewSession>;

export interface StoredSession {
  id: string;
  firmId: string;
  personId: string;
  csrfToken: string;
  mfaSatisfied: boolean;
  expiresAt: string;
}

export const sessions = {
  /** Stores a session for the hash of its cookie token. Clear failed attempts with `credentials.resetFailures`. */
  async create(tx: TenantTx, session: NewSession): Promise<StoredSession> {
    const n = validate(NewSession, session);
    const t = s.authSession;
    const [row] = await tx
      .insert(t)
      .values({ ...n, expiresAt: new Date(n.expiresAt) })
      .returning()
      .catch(rethrow);
    return {
      id: row!.id,
      firmId: row!.firmId,
      personId: row!.personId,
      csrfToken: row!.csrfToken,
      mfaSatisfied: row!.mfaSatisfied,
      expiresAt: row!.expiresAt.toISOString(),
    };
  },
  /** False when the session is unknown here or already revoked. */
  async revoke(tx: TenantTx, sessionId: string, now: string): Promise<boolean> {
    const t = s.authSession;
    const rows = await tx
      .update(t)
      .set({ revokedAt: at(now) })
      .where(and(eq(t.id, validate(Id, sessionId)), isNull(t.revokedAt)))
      .returning({ id: t.id })
      .catch(rethrow);
    return rows.length === 1;
  },
  /** Ends every open session of a person (disabled, password reset); returns how many. */
  async revokeAllForPerson(tx: TenantTx, personId: string, now: string): Promise<number> {
    const t = s.authSession;
    const rows = await tx
      .update(t)
      .set({ revokedAt: at(now) })
      .where(and(eq(t.personId, validate(Id, personId)), isNull(t.revokedAt)))
      .returning({ id: t.id })
      .catch(rethrow);
    return rows.length;
  },
  /** False when the session is unknown here or revoked. */
  async markMfa(tx: TenantTx, sessionId: string): Promise<boolean> {
    const t = s.authSession;
    const rows = await tx
      .update(t)
      .set({ mfaSatisfied: true })
      .where(and(eq(t.id, validate(Id, sessionId)), isNull(t.revokedAt)))
      .returning({ id: t.id })
      .catch(rethrow);
    return rows.length === 1;
  },
  async touch(tx: TenantTx, sessionId: string, now: string): Promise<void> {
    await tx
      .update(s.authSession)
      .set({ lastSeenAt: at(now) })
      .where(eq(s.authSession.id, validate(Id, sessionId)))
      .catch(rethrow);
  },
};

export const NewLoginToken = z
  .strictObject({
    personId: Id,
    kind: LoginTokenKind,
    inviteId: Id.nullable(),
    tokenHash: TokenHash,
    expiresAt: Instant,
  })
  .refine((t) => (t.kind === 'INVITE') === (t.inviteId !== null), {
    message: 'INVITE tokens carry an invite id; magic links do not',
    path: ['inviteId'],
  });
export type NewLoginToken = z.infer<typeof NewLoginToken>;

export const loginTokens = {
  /** Stores a sign-in link by the hash of its token; returns its id. */
  async create(tx: TenantTx, token: NewLoginToken): Promise<string> {
    const n = validate(NewLoginToken, token);
    const [row] = await tx
      .insert(s.authToken)
      .values({ ...n, expiresAt: new Date(n.expiresAt) })
      .returning({ id: s.authToken.id })
      .catch(rethrow);
    return row!.id;
  },
  /** Marks the token used if it is unused and unexpired at `now`; false when another request won. */
  async consume(tx: TenantTx, tokenId: string, now: string): Promise<boolean> {
    const t = s.authToken;
    const when = at(now);
    const rows = await tx
      .update(t)
      .set({ usedAt: when })
      .where(and(eq(t.id, validate(Id, tokenId)), isNull(t.usedAt), gt(t.expiresAt, when)))
      .returning({ id: t.id })
      .catch(rethrow);
    return rows.length === 1;
  },
};

/** The membership an invite grants on acceptance (the membership shape rules apply). */
export const Grant = z.strictObject({
  role: Role,
  clientId: Id.nullable(),
  consultantClientIds: z.array(Id).nullable(),
  unitIds: z.array(Id).nullable(),
  expiresAt: Instant.nullable(),
});
export type Grant = z.infer<typeof Grant>;

export const NewInvite = z.strictObject({
  personId: Id,
  email: z.email().max(320),
  grant: Grant,
  createdById: Id,
  expiresAt: Instant,
});
export type NewInvite = z.infer<typeof NewInvite>;

export interface Invite {
  id: string;
  firmId: string;
  firmName: string;
  personId: string;
  email: string;
  grant: Grant;
  createdById: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

type InviteRow = typeof s.authInvite.$inferSelect;

function toInvite(row: InviteRow, firmName: string): Invite {
  return {
    id: row.id,
    firmId: row.firmId,
    firmName,
    personId: row.personId,
    email: row.email,
    grant: {
      role: row.role,
      clientId: row.clientId,
      consultantClientIds: row.consultantClientIds,
      unitIds: row.unitIds,
      expiresAt: iso(row.membershipExpiresAt),
    },
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: iso(row.acceptedAt),
    revokedAt: iso(row.revokedAt),
  };
}

async function firmName(tx: TenantTx): Promise<string> {
  const [row] = await tx.select({ name: s.firm.name }).from(s.firm).catch(rethrow);
  return row?.name ?? '';
}

const isOpen = (when: Date) =>
  and(
    isNull(s.authInvite.acceptedAt),
    isNull(s.authInvite.revokedAt),
    gt(s.authInvite.expiresAt, when),
  );

/** A person write: the row before and after, for the caller's `UPDATE` audit event. */
export interface PersonChange {
  before: Person;
  after: Person;
}

export const invites = {
  /**
   * Records an invite and revokes the person's earlier open invites (returned, for the audit). An UNCLAIMED,
   * INVITED or DISABLED person becomes INVITED with the email (`person`, before and after); an ACTIVE person is
   * left as is and the email must be theirs (VALIDATION otherwise). DUPLICATE when another person of the firm
   * has the email; NOT_FOUND when the person is not visible here.
   */
  async create(
    tx: TenantTx,
    invite: NewInvite,
    now: string,
  ): Promise<{ invite: Invite; revokedInviteIds: string[]; person: PersonChange | null }> {
    const n = validate(NewInvite, invite);
    const when = at(now);
    const before = await people.require(tx, n.personId);
    let person: PersonChange | null = null;
    if (before.status === 'ACTIVE') {
      if (before.email?.toLowerCase() !== n.email.toLowerCase()) {
        throw new DbError('VALIDATION', 'An active person is invited at their own email');
      }
    } else {
      const after = await people.update(tx, before.id, before.version, {
        status: 'INVITED',
        email: n.email,
      });
      person = { before, after };
    }
    const t = s.authInvite;
    const revoked = await tx
      .update(t)
      .set({ revokedAt: when })
      .where(and(eq(t.personId, n.personId), isNull(t.acceptedAt), isNull(t.revokedAt)))
      .returning({ id: t.id })
      .catch(rethrow);
    const [row] = await tx
      .insert(t)
      .values({
        personId: n.personId,
        email: n.email,
        role: n.grant.role,
        clientId: n.grant.clientId,
        consultantClientIds: n.grant.consultantClientIds,
        unitIds: n.grant.unitIds,
        membershipExpiresAt: n.grant.expiresAt === null ? null : new Date(n.grant.expiresAt),
        createdById: n.createdById,
        expiresAt: new Date(n.expiresAt),
      })
      .returning()
      .catch(rethrow);
    return {
      invite: toInvite(row!, await firmName(tx)),
      revokedInviteIds: revoked.map((r) => r.id),
      person,
    };
  },
  async get(tx: TenantTx, inviteId: string): Promise<Invite | null> {
    const [row] = await tx
      .select()
      .from(s.authInvite)
      .where(eq(s.authInvite.id, validate(Id, inviteId)))
      .catch(rethrow);
    return row ? toInvite(row, await firmName(tx)) : null;
  },
  /** Revokes an open invite (its tokens stop working); null when it is not open or not visible here. */
  async revoke(tx: TenantTx, inviteId: string, now: string): Promise<Invite | null> {
    const when = at(now);
    const [row] = await tx
      .update(s.authInvite)
      .set({ revokedAt: when })
      .where(and(eq(s.authInvite.id, validate(Id, inviteId)), isOpen(when)))
      .returning()
      .catch(rethrow);
    return row ? toInvite(row, await firmName(tx)) : null;
  },
  /**
   * Accepts an open invite with one of its unused tokens: uses the token, marks the invite accepted, sets the
   * password, makes the person ACTIVE and grants the membership. NOT_FOUND when the invite is not open or the
   * token is used, expired or not the invite's; FORBIDDEN when a client-role invite names someone who holds a
   * firm role (nothing is changed then, as the transaction rolls back).
   */
  async accept(
    tx: TenantTx,
    accept: { inviteId: string; tokenId: string; passwordHash: string; now: string },
  ): Promise<{ invite: Invite; person: PersonChange; membership: Membership }> {
    const when = at(accept.now);
    const inviteId = validate(Id, accept.inviteId);
    const token = s.authToken;
    const used = await tx
      .update(token)
      .set({ usedAt: when })
      .where(
        and(
          eq(token.id, validate(Id, accept.tokenId)),
          eq(token.inviteId, inviteId),
          isNull(token.usedAt),
          gt(token.expiresAt, when),
        ),
      )
      .returning({ id: token.id })
      .catch(rethrow);
    if (used.length !== 1) throw new DbError('NOT_FOUND', 'No open invite for this link');
    const [row] = await tx
      .update(s.authInvite)
      .set({ acceptedAt: when })
      .where(and(eq(s.authInvite.id, inviteId), isOpen(when)))
      .returning()
      .catch(rethrow);
    if (!row) throw new DbError('NOT_FOUND', 'No open invite for this link');
    // A client-role invite never sets the password of someone who holds a firm role (audit of #39, finding 1).
    if (row.clientId !== null) {
      const { rows: held } = await tx
        .execute<{ firm: boolean }>(sql`SELECT app_person_has_firm_role(${row.personId}) AS firm`)
        .catch(rethrow);
      if (held[0]?.firm) {
        throw new DbError('FORBIDDEN', 'A client invite cannot be accepted by firm staff');
      }
    }
    const before = await people.require(tx, row.personId);
    const after = await people.update(tx, before.id, before.version, {
      status: 'ACTIVE',
      email: row.email,
    });
    await credentials.setPassword(tx, row.personId, accept.passwordHash);
    const membership = await memberships.create(tx, {
      personId: row.personId,
      role: row.role,
      clientId: row.clientId,
      consultantClientIds: row.consultantClientIds,
      unitIds: row.unitIds,
      expiresAt: iso(row.membershipExpiresAt),
    });
    return { invite: toInvite(row, await firmName(tx)), person: { before, after }, membership };
  },
};
