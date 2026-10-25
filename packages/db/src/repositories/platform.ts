import {
  AccountOverride,
  AccountStatus,
  Email,
  Id,
  Instant,
  LocalDate,
  Name,
  OperatorAuditAction,
  OperatorAuditEvent,
  Plan,
  PlanCode,
  PlanLimits,
  PlatformOperator,
  Subscription,
  UsageSnapshot,
  FeatureFlag,
} from '@canopy/contracts';
import { and, asc, desc, eq, gt, gte, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { TokenHash } from '../auth-lookups.js';
import type { OperatorTx, TenantTx } from '../database.js';
import { DbError, rethrow, validate } from '../errors.js';
import * as s from '../schema/index.js';
import { decodeCursor, encodeCursor, pageLimit, type Page } from './crud.js';
import { Lockout } from './auth.js';

/**
 * The platform operator's own storage (ADR M15-0001 decisions 5-9, 12; ADR M3-0003): operators and their
 * credentials and sessions, plans, overrides, offline subscriptions, usage snapshots and the append-only operator
 * audit. Everything on OperatorTx touches the `platform` schema or the firm row only, never a tenant table, and needs
 * no `canopy_app`. The two M9 jobs (`accountJobs`) run in an account's own system context instead. Never log what
 * these take or return: credentials carry password hashes, sealed MFA secrets and CSRF tokens.
 */

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const at = (value: string): Date => new Date(validate(Instant, value));
const RequestId = z.string().min(1).max(200);

/** M5's stored scrypt form; the table has the same CHECK. */
const PasswordHash = z
  .string()
  .max(1000)
  .regex(/^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/, 'Expected an scrypt hash');
/** M5's SecretBox `v1.<iv>.<tag>.<ciphertext>`; the table has the same CHECK. */
const SealedSecret = z.string().regex(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/, 'Expected a sealed secret');

// ---------- operators ----------

export const NewOperator = z.strictObject({
  email: Email,
  displayName: Name,
  passwordHash: PasswordHash,
  mfaSealedSecret: SealedSecret,
});
export type NewOperator = z.infer<typeof NewOperator>;

/** What sign-in needs: the operator and their credential. MFA is always enrolled (the CLI does it). */
export interface OperatorLogin {
  operator: PlatformOperator;
  passwordHash: string;
  mfaSealedSecret: string;
  mfaLastStep: number | null;
  failedAttempts: number;
  lockedUntil: string | null;
}

const operatorOf = (r: typeof s.operator.$inferSelect): PlatformOperator =>
  validate(PlatformOperator, {
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    createdAt: r.createdAt.toISOString(),
    disabledAt: iso(r.disabledAt),
  });

export const operators = {
  /** For the deploy-time CLI only: the operator and their credential, in one transaction. */
  async create(tx: OperatorTx, input: NewOperator): Promise<PlatformOperator> {
    const n = validate(NewOperator, input);
    const [row] = await tx
      .insert(s.operator)
      .values({ email: n.email, displayName: n.displayName })
      .returning()
      .catch(rethrow);
    await tx
      .insert(s.operatorCredential)
      .values({
        operatorId: row!.id,
        passwordHash: n.passwordHash,
        mfaSealedSecret: n.mfaSealedSecret,
      })
      .catch(rethrow);
    return operatorOf(row!);
  },
  async get(tx: OperatorTx, operatorId: string): Promise<PlatformOperator | null> {
    const [row] = await tx
      .select()
      .from(s.operator)
      .where(eq(s.operator.id, validate(Id, operatorId)))
      .catch(rethrow);
    return row ? operatorOf(row) : null;
  },
  async list(tx: OperatorTx): Promise<PlatformOperator[]> {
    const rows = await tx
      .select()
      .from(s.operator)
      .orderBy(asc(s.operator.createdAt), asc(s.operator.id))
      .catch(rethrow);
    return rows.map(operatorOf);
  },
  /** By email, case-insensitively; disabled operators too (sign-in refuses them after the password). */
  async findForLogin(tx: OperatorTx, email: string): Promise<OperatorLogin | null> {
    const c = s.operatorCredential;
    const [row] = await tx
      .select({ operator: s.operator, credential: c })
      .from(s.operator)
      .innerJoin(c, eq(c.operatorId, s.operator.id))
      .where(sql`lower(${s.operator.email}) = ${validate(Email, email).toLowerCase()}`)
      .catch(rethrow);
    if (!row) return null;
    return {
      operator: operatorOf(row.operator),
      passwordHash: row.credential.passwordHash,
      mfaSealedSecret: row.credential.mfaSealedSecret,
      mfaLastStep: row.credential.mfaLastStep,
      failedAttempts: row.credential.failedAttempts,
      lockedUntil: iso(row.credential.lockedUntil),
    };
  },
  /** Disables the operator and ends their sessions. False when already disabled or unknown. */
  async disable(tx: OperatorTx, operatorId: string, now: string): Promise<boolean> {
    const id = validate(Id, operatorId);
    const rows = await tx
      .update(s.operator)
      .set({ disabledAt: at(now) })
      .where(and(eq(s.operator.id, id), isNull(s.operator.disabledAt)))
      .returning({ id: s.operator.id })
      .catch(rethrow);
    if (rows.length === 1) await operatorSessions.revokeAllFor(tx, id, now);
    return rows.length === 1;
  },
  /** Sets the password and clears failed attempts and any lock (the CLI's reset). */
  async setPassword(tx: OperatorTx, operatorId: string, passwordHash: string): Promise<void> {
    await tx
      .update(s.operatorCredential)
      .set({
        passwordHash: validate(PasswordHash, passwordHash),
        failedAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(s.operatorCredential.operatorId, validate(Id, operatorId)))
      .catch(rethrow);
  },
  /** A new TOTP secret (the CLI's re-enrolment); the last step starts again. */
  async setMfa(tx: OperatorTx, operatorId: string, sealedSecret: string): Promise<void> {
    await tx
      .update(s.operatorCredential)
      .set({ mfaSealedSecret: validate(SealedSecret, sealedSecret), mfaLastStep: null })
      .where(eq(s.operatorCredential.operatorId, validate(Id, operatorId)))
      .catch(rethrow);
  },
  /**
   * Counts a failed sign-in (wrong password or code) in one statement. The `attempts`-th failure in a row locks
   * sign-in until `now + minutes` and starts the count again, as for customers (`credentials.recordFailure`).
   */
  async recordFailure(
    tx: OperatorTx,
    operatorId: string,
    now: string,
    lockout: Lockout,
  ): Promise<{ lockedUntil: string | null }> {
    const { attempts, minutes } = validate(Lockout, lockout);
    const lockAt = new Date(at(now).getTime() + minutes * 60_000);
    const c = s.operatorCredential;
    const reached = sql`${c.failedAttempts} + 1 >= ${attempts}`;
    const [row] = await tx
      .update(c)
      .set({
        failedAttempts: sql`case when ${reached} then 0 else ${c.failedAttempts} + 1 end`,
        lockedUntil: sql`case when ${reached} then ${lockAt}::timestamptz else ${c.lockedUntil} end`,
      })
      .where(eq(c.operatorId, validate(Id, operatorId)))
      .returning({ lockedUntil: c.lockedUntil })
      .catch(rethrow);
    return { lockedUntil: iso(row?.lockedUntil ?? null) };
  },
  async resetFailures(tx: OperatorTx, operatorId: string): Promise<void> {
    await tx
      .update(s.operatorCredential)
      .set({ failedAttempts: 0 })
      .where(eq(s.operatorCredential.operatorId, validate(Id, operatorId)))
      .catch(rethrow);
  },
  /** Records `step` as the last TOTP step used, only if later than the stored one. False on a replayed code. */
  async acceptMfaStep(tx: OperatorTx, operatorId: string, step: number): Promise<boolean> {
    const c = s.operatorCredential;
    const n = validate(z.int().min(0), step);
    const rows = await tx
      .update(c)
      .set({ mfaLastStep: n })
      .where(
        and(
          eq(c.operatorId, validate(Id, operatorId)),
          or(isNull(c.mfaLastStep), lt(c.mfaLastStep, n)),
        ),
      )
      .returning({ id: c.operatorId })
      .catch(rethrow);
    return rows.length === 1;
  },
};

// ---------- operator sessions ----------

export const NewOperatorSession = z.strictObject({
  operatorId: Id,
  tokenHash: TokenHash,
  csrfToken: z.string().min(16).max(200),
  expiresAt: Instant,
  ip: z.string().max(100).nullable(),
  /** The sign-in time; defaults to the database clock. */
  createdAt: Instant.optional(),
});
export type NewOperatorSession = z.infer<typeof NewOperatorSession>;

export interface OperatorSession {
  id: string;
  operatorId: string;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

const sessionOf = (r: typeof s.operatorSession.$inferSelect): OperatorSession => ({
  id: r.id,
  operatorId: r.operatorId,
  csrfToken: r.csrfToken,
  createdAt: r.createdAt.toISOString(),
  lastSeenAt: r.lastSeenAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
});

export const operatorSessions = {
  /** Stores a session for the hash of its `op_sid` token. */
  async create(tx: OperatorTx, session: NewOperatorSession): Promise<OperatorSession> {
    const { createdAt, ...n } = validate(NewOperatorSession, session);
    const [row] = await tx
      .insert(s.operatorSession)
      .values({
        ...n,
        expiresAt: new Date(n.expiresAt),
        ...(createdAt === undefined
          ? {}
          : { createdAt: new Date(createdAt), lastSeenAt: new Date(createdAt) }),
      })
      .returning()
      .catch(rethrow);
    return sessionOf(row!);
  },
  /**
   * The open session for a token hash with its operator, or null when it is unknown, revoked, expired at `now`, or
   * its operator is disabled. The idle limit is the API's (`lastSeenAt`).
   */
  async find(
    tx: OperatorTx,
    tokenHash: string,
    now: string,
  ): Promise<{ session: OperatorSession; operator: PlatformOperator } | null> {
    const t = s.operatorSession;
    const [row] = await tx
      .select({ session: t, operator: s.operator })
      .from(t)
      .innerJoin(s.operator, eq(s.operator.id, t.operatorId))
      .where(
        and(
          eq(t.tokenHash, validate(TokenHash, tokenHash)),
          isNull(t.revokedAt),
          gt(t.expiresAt, at(now)),
          isNull(s.operator.disabledAt),
        ),
      )
      .catch(rethrow);
    return row ? { session: sessionOf(row.session), operator: operatorOf(row.operator) } : null;
  },
  async touch(tx: OperatorTx, sessionId: string, now: string): Promise<void> {
    await tx
      .update(s.operatorSession)
      .set({ lastSeenAt: at(now) })
      .where(eq(s.operatorSession.id, validate(Id, sessionId)))
      .catch(rethrow);
  },
  /** False when the session is unknown or already revoked. */
  async revoke(tx: OperatorTx, sessionId: string, now: string): Promise<boolean> {
    const t = s.operatorSession;
    const rows = await tx
      .update(t)
      .set({ revokedAt: at(now) })
      .where(and(eq(t.id, validate(Id, sessionId)), isNull(t.revokedAt)))
      .returning({ id: t.id })
      .catch(rethrow);
    return rows.length === 1;
  },
  async revokeAllFor(tx: OperatorTx, operatorId: string, now: string): Promise<number> {
    const t = s.operatorSession;
    const rows = await tx
      .update(t)
      .set({ revokedAt: at(now) })
      .where(and(eq(t.operatorId, validate(Id, operatorId)), isNull(t.revokedAt)))
      .returning({ id: t.id })
      .catch(rethrow);
    return rows.length;
  },
};

// ---------- plans and overrides ----------

const planOf = (r: typeof s.plan.$inferSelect): Plan =>
  validate(Plan, {
    code: r.code,
    name: r.name,
    limits: r.limits,
    features: r.features,
    retiredAt: iso(r.retiredAt),
  });

export const PlanChange = z.strictObject({
  name: Name,
  limits: PlanLimits,
  features: z.array(FeatureFlag).max(50),
  retired: z.boolean(),
});
export type PlanChange = z.infer<typeof PlanChange>;

export const plans = {
  /** Every plan, retired ones too, by code. */
  async list(tx: OperatorTx): Promise<Plan[]> {
    const rows = await tx.select().from(s.plan).orderBy(asc(s.plan.code)).catch(rethrow);
    return rows.map(planOf);
  },
  async get(tx: OperatorTx, code: string): Promise<Plan | null> {
    const [row] = await tx
      .select()
      .from(s.plan)
      .where(eq(s.plan.code, validate(PlanCode, code)))
      .catch(rethrow);
    return row ? planOf(row) : null;
  },
  /**
   * Creates or replaces a plan (`PUT /plans/{code}`). Retiring keeps the first retirement time; un-retiring clears
   * it. Returns the plan before (null when new) and after, for the operator audit.
   */
  async upsert(
    tx: OperatorTx,
    code: string,
    change: PlanChange,
    now: string,
  ): Promise<{ before: Plan | null; after: Plan }> {
    const c = validate(PlanCode, code);
    const p = validate(PlanChange, change);
    const before = await plans.get(tx, c);
    const retiredAt = p.retired ? (before?.retiredAt ? at(before.retiredAt) : at(now)) : null;
    const values = { name: p.name, limits: p.limits, features: p.features, retiredAt };
    const [row] = await tx
      .insert(s.plan)
      .values({ code: c, ...values })
      .onConflictDoUpdate({ target: s.plan.code, set: values })
      .returning()
      .catch(rethrow);
    return { before, after: planOf(row!) };
  },
};

const overrideOf = (r: typeof s.accountOverride.$inferSelect): AccountOverride =>
  validate(AccountOverride, {
    limits: r.limits,
    features: r.features,
    removedFeatures: r.removedFeatures,
    note: r.note,
  });

export const accountOverrides = {
  /** The account's override, or null when it has none (the plan applies as is). */
  async get(tx: OperatorTx, accountId: string): Promise<AccountOverride | null> {
    const [row] = await tx
      .select()
      .from(s.accountOverride)
      .where(eq(s.accountOverride.accountId, validate(Id, accountId)))
      .catch(rethrow);
    return row ? overrideOf(row) : null;
  },
  /**
   * Replaces the override (`PUT /accounts/{id}/override`). The optimistic version is the account's: the caller bumps
   * it with `platformAccounts.update` in the same transaction.
   */
  async put(
    tx: OperatorTx,
    accountId: string,
    override: AccountOverride,
  ): Promise<{ before: AccountOverride | null; after: AccountOverride }> {
    const id = validate(Id, accountId);
    const o = validate(AccountOverride, override);
    const before = await accountOverrides.get(tx, id);
    // A missing removedFeatures removes nothing, so a put without it turns every plan feature back on.
    const values = {
      limits: o.limits,
      features: o.features,
      removedFeatures: o.removedFeatures ?? [],
      note: o.note,
    };
    const [row] = await tx
      .insert(s.accountOverride)
      .values({ accountId: id, ...values })
      .onConflictDoUpdate({
        target: s.accountOverride.accountId,
        set: { ...values, version: sql`${s.accountOverride.version} + 1`, updatedAt: sql`now()` },
      })
      .returning()
      .catch(rethrow);
    return { before, after: overrideOf(row!) };
  },
};

// ---------- subscriptions and renewals ----------

export const NewSubscription = z
  .strictObject({
    accountId: Id,
    planCode: PlanCode,
    startsOn: LocalDate,
    endsOn: LocalDate,
    amountPaise: z.int().min(0),
    invoiceNumber: z.string().trim().min(1).max(100).nullable(),
    paidOn: LocalDate.nullable(),
    recordedById: Id,
  })
  .refine((n) => n.endsOn >= n.startsOn, {
    path: ['endsOn'],
    message: 'endsOn must not be before startsOn',
  });
export type NewSubscription = z.input<typeof NewSubscription>;

const subscriptionOf = (r: typeof s.subscription.$inferSelect): Subscription =>
  validate(Subscription, { ...r, recordedAt: r.recordedAt.toISOString() });

export interface Renewal {
  accountId: string;
  name: string;
  status: AccountStatus;
  planCode: string;
  endsOn: string;
  kind: 'SUBSCRIPTION' | 'TRIAL';
}

export const subscriptions = {
  /** The account's billing periods, latest end first. */
  async list(tx: OperatorTx, accountId: string): Promise<Subscription[]> {
    const t = s.subscription;
    const rows = await tx
      .select()
      .from(t)
      .where(eq(t.accountId, validate(Id, accountId)))
      .orderBy(desc(t.endsOn), desc(t.id))
      .catch(rethrow);
    return rows.map(subscriptionOf);
  },
  async record(tx: OperatorTx, input: NewSubscription): Promise<Subscription> {
    const n = validate(NewSubscription, input);
    const [row] = await tx.insert(s.subscription).values(n).returning().catch(rethrow);
    return subscriptionOf(row!);
  },
  /**
   * Accounts to renew (`GET /renewals`): those whose latest subscription ends from `today` to `today + withinDays`,
   * and TRIAL accounts whose trial ends in that window. DELETED and PENDING_DELETION accounts are left out. Soonest
   * first. `today` is the operator's date; dates are compared as dates.
   */
  async renewals(tx: OperatorTx, today: string, withinDays: number): Promise<Renewal[]> {
    const from = validate(LocalDate, today);
    const days = validate(z.int().min(1).max(365), withinDays);
    const { rows } = await tx
      .execute<{
        account_id: string;
        name: string;
        status: AccountStatus;
        plan_code: string;
        ends_on: string;
        kind: 'SUBSCRIPTION' | 'TRIAL';
      }>(
        sql`
        WITH latest AS (
          SELECT DISTINCT ON (account_id) account_id, ends_on
          FROM platform.subscription ORDER BY account_id, ends_on DESC
        ), due AS (
          SELECT f.id AS account_id, f.name, f.status, f.plan_code, l.ends_on, 'SUBSCRIPTION' AS kind
          FROM firm f JOIN latest l ON l.account_id = f.id
          WHERE f.status NOT IN ('DELETED', 'PENDING_DELETION')
          UNION ALL
          SELECT f.id, f.name, f.status, f.plan_code, f.trial_ends_on, 'TRIAL'
          FROM firm f WHERE f.status = 'TRIAL'
        )
        SELECT account_id, name, status, plan_code, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, kind FROM due
        WHERE ends_on BETWEEN ${from}::date AND ${from}::date + ${days}::int
        ORDER BY ends_on, name, account_id, kind`,
      )
      .catch(rethrow);
    return rows.map((r) => ({
      accountId: r.account_id,
      name: r.name,
      status: r.status,
      planCode: r.plan_code,
      endsOn: r.ends_on,
      kind: r.kind,
    }));
  },
};

// ---------- usage snapshots ----------

const snapshotOf = (r: typeof s.usageSnapshot.$inferSelect): UsageSnapshot =>
  validate(UsageSnapshot, {
    accountId: r.accountId,
    takenOn: r.takenOn,
    usage: {
      companies: r.companies,
      units: r.units,
      users: r.users,
      storageBytes: r.storageBytes,
    },
    activeUsers30d: r.activeUsers30d,
    instances: r.instances,
  });

export const usageSnapshots = {
  /** The account's snapshots from `from` to `to` (dates, inclusive), oldest first. */
  async list(
    tx: OperatorTx,
    accountId: string,
    from: string,
    to: string,
  ): Promise<UsageSnapshot[]> {
    const t = s.usageSnapshot;
    const rows = await tx
      .select()
      .from(t)
      .where(
        and(
          eq(t.accountId, validate(Id, accountId)),
          gte(t.takenOn, validate(LocalDate, from)),
          lte(t.takenOn, validate(LocalDate, to)),
        ),
      )
      .orderBy(asc(t.takenOn))
      .catch(rethrow);
    return rows.map(snapshotOf);
  },
};

// ---------- operator audit ----------

export const NewOperatorAuditEvent = z.strictObject({
  /** Null for the system (jobs). */
  operatorId: Id.nullable(),
  action: OperatorAuditAction,
  accountId: Id.nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().trim().min(1).max(2000).nullable(),
  requestId: RequestId,
  ip: z.string().max(100).nullable(),
});
export type NewOperatorAuditEvent = z.infer<typeof NewOperatorAuditEvent>;

/** Person fields never go in the operator's trail (audit note I4 on PR #123), as in platform_record_account_event. */
const PERSON_FIELDS = ['email', 'displayName', 'phone', 'ownerEmail', 'ownerName'];

/** A person field at any depth, as `platform_record_account_event` checks (audit of #171, Low 2). */
function carriesPersonField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(carriesPersonField);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([k, v]) => PERSON_FIELDS.includes(k) || carriesPersonField(v));
}

const auditOf = (r: typeof s.operatorAuditEvent.$inferSelect): OperatorAuditEvent =>
  validate(OperatorAuditEvent, { ...r, at: r.at.toISOString() });

export const OperatorAuditFilter = z.strictObject({
  accountId: Id.optional(),
  action: OperatorAuditAction.optional(),
  from: Instant.optional(),
  to: Instant.optional(),
  limit: z.int().optional(),
  cursor: z.string().nullable().optional(),
});
export type OperatorAuditFilter = z.infer<typeof OperatorAuditFilter>;

export const operatorAudit = {
  /** Appends one entry; the table refuses UPDATE, DELETE and TRUNCATE for every role. */
  async append(tx: OperatorTx, entry: NewOperatorAuditEvent): Promise<OperatorAuditEvent> {
    const e = validate(NewOperatorAuditEvent, entry);
    if (carriesPersonField([e.before, e.after])) {
      throw new DbError('VALIDATION', 'Operator audit carries account fields only');
    }
    const [row] = await tx.insert(s.operatorAuditEvent).values(e).returning().catch(rethrow);
    return auditOf(row!);
  },
  /** `GET /audit`: newest first, by account, action and time (`from` inclusive, `to` exclusive). */
  async query(tx: OperatorTx, filter: OperatorAuditFilter = {}): Promise<Page<OperatorAuditEvent>> {
    const f = validate(OperatorAuditFilter, filter);
    const t = s.operatorAuditEvent;
    const limit = pageLimit(f.limit);
    const conditions: SQL[] = [];
    if (f.accountId) conditions.push(eq(t.accountId, f.accountId));
    if (f.action) conditions.push(eq(t.action, f.action));
    if (f.from) conditions.push(gte(t.at, at(f.from)));
    if (f.to) conditions.push(lt(t.at, at(f.to)));
    if (f.cursor) conditions.push(lt(t.id, decodeCursor(f.cursor)));
    const rows = await tx
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(desc(t.id))
      .limit(limit + 1)
      .catch(rethrow);
    const items = rows.slice(0, limit).map(auditOf);
    return {
      items,
      nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!.id) : null,
    };
  },
};

// ---------- the owner invite ----------

export const ownerInvites = {
  /**
   * A fresh owner invite for a PROVISIONING account (`POST /accounts/{id}/owner-invite`): earlier links stop working
   * and M9 emails the new one from person.invited. VALIDATION when the account is not PROVISIONING; NOT_FOUND when
   * there is no such account. Returns the new invite id.
   */
  async resend(
    tx: OperatorTx,
    input: { accountId: string; expiresAt: string; operatorId: string; requestId: string },
  ): Promise<string> {
    const { rows } = await tx
      .execute<{ id: string }>(
        sql`SELECT platform_resend_owner_invite(${validate(Id, input.accountId)}, ${at(input.expiresAt)},
          ${validate(Id, input.operatorId)}, ${validate(RequestId, input.requestId)}) AS id`,
      )
      .catch(rethrow);
    return rows[0]!.id;
  },
};

// ---------- the M9 account jobs (tenant side) ----------

export const accountJobs = {
  /**
   * Ends the trial of the context's account when `trial_ends_on` is before `now`'s date in the account's time zone:
   * SUSPENDED, with its audit row, account.status_changed (actor SYSTEM, `job`) and the ACCOUNT_SUSPEND operator
   * entry. Needs a firm-wide system context. True when it suspended the account.
   */
  async endTrial(tx: TenantTx, now: string, job: string): Promise<boolean> {
    const { rows } = await tx
      .execute<{ ended: boolean }>(
        sql`SELECT app_end_trial(${at(now)}, ${validate(z.string().min(1).max(100), job)}) AS ended`,
      )
      .catch(rethrow);
    return rows[0]!.ended;
  },
  /**
   * Records that M6 copied the master library, in the transaction that copied it (the account.created handler).
   * Set once: only while the account is PROVISIONING and the time is unset. True when it set it.
   */
  async markLibraryCopied(tx: TenantTx): Promise<boolean> {
    const { rows } = await tx
      .execute<{ marked: boolean }>(sql`SELECT app_mark_library_copied() AS marked`)
      .catch(rethrow);
    return rows[0]!.marked;
  },
  /**
   * The last day of the context's account's latest recorded subscription, paid or not (the one that ends last), or
   * null when it has none. Any tenant context of the account; a date only, never the amount or invoice.
   */
  async subscriptionEndsOn(tx: TenantTx): Promise<LocalDate | null> {
    const { rows } = await tx
      .execute<{
        ends_on: string | null;
      }>(sql`SELECT to_char(app_subscription_ends_on(), 'YYYY-MM-DD') AS ends_on`)
      .catch(rethrow);
    const endsOn = rows[0]!.ends_on;
    return endsOn === null ? null : LocalDate.parse(endsOn);
  },
  /** Takes the context's account's usage snapshot for `on`, replacing one already taken that day. */
  async takeUsageSnapshot(tx: TenantTx, on: string): Promise<void> {
    await tx
      .execute(sql`SELECT app_take_usage_snapshot(${validate(LocalDate, on)}::date)`)
      .catch(rethrow);
  },
};
