import {
  AccountKind,
  AccountProfile,
  AccountStatus,
  AccountView,
  AuditAction,
  ClientSettings,
  Email,
  FeatureFlag,
  FirmSettings,
  Id,
  Instant,
  LocalDate,
  Name,
  OperatorSupportGrant,
  PlanCode,
  PlanLimits,
  SUPPORT_GRANT_MAX_DAYS,
  SupportAccessLevel,
  SupportGrant,
  Usage,
} from '@canopy/contracts';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { TokenHash } from '../auth-lookups.js';
import type { OperatorTx, TenantTx } from '../database.js';
import { DbError, rethrow, validate } from '../errors.js';
import * as s from '../schema/index.js';

/**
 * Customer accounts (ADR M15-0001, M3-0002). An account is a firm. The app side reads its own account through
 * `app_account()` and `app_usage()` and manages PlanetPulse support grants; the operator side (OperatorTx) reads
 * firm rows and calls the `platform_*` functions, the only writes it makes inside a tenant (migration 0020).
 * As everywhere, the caller writes the audit and outbox rows of app-side changes in the same transaction.
 */

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const at = (value: string): Date => new Date(validate(Instant, value));
const instantOrNull = (value: string | null | undefined): Date | null | undefined =>
  value === undefined || value === null ? value : at(value);

/** The whole firm's counts, whatever the caller's client scope. */
export const AccountUsage = Usage.extend({
  instances: z.int().min(0),
  activeUsers30d: z.int().min(0),
});
export type AccountUsage = z.infer<typeof AccountUsage>;

function usageOf(r: Record<string, unknown> | undefined): AccountUsage {
  if (!r) throw new DbError('NOT_FOUND', 'No usage for this account');
  return validate(AccountUsage, {
    companies: r.companies,
    units: r.units,
    users: r.users,
    storageBytes: Number(r.storage_bytes),
    instances: r.instances,
    activeUsers30d: r.active_users_30d,
  });
}

// ---------- app side ----------

export const account = {
  /** The caller's own account with its effective limits and usage (`GET /account`, plan-limit checks). */
  async get(tx: TenantTx): Promise<AccountView> {
    const [row] = (
      await tx.execute<Record<string, unknown>>(sql`
        SELECT f.id, f.name, a.kind, a.status, a.plan_code, a.trial_ends_on, a.limits, a.features
        FROM app_account() a CROSS JOIN LATERAL (SELECT id, name FROM firm WHERE id = app_firm_id()) f`)
    ).rows;
    if (!row) throw new DbError('NOT_FOUND', 'No account in this context');
    const usage = await account.usage(tx);
    return validate(AccountView, {
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      trialEndsOn: row.trial_ends_on ?? null,
      entitlements: { planCode: row.plan_code, limits: row.limits, features: row.features },
      usage: {
        companies: usage.companies,
        units: usage.units,
        users: usage.users,
        storageBytes: usage.storageBytes,
      },
    });
  },
  async usage(tx: TenantTx): Promise<AccountUsage> {
    const { rows } = await tx.execute<Record<string, unknown>>(sql`SELECT * FROM app_usage()`);
    return usageOf(rows[0]);
  },
};

export const SupportGrantRequest = z.strictObject({
  level: SupportAccessLevel,
  days: z.int().min(1).max(SUPPORT_GRANT_MAX_DAYS),
  grantedById: Id,
  now: Instant,
});
export type SupportGrantRequest = z.infer<typeof SupportGrantRequest>;

type GrantRow = typeof s.supportGrant.$inferSelect;

function grantOf(row: GrantRow, now: Date): SupportGrant {
  return validate(SupportGrant, {
    id: row.id,
    accountId: row.firmId,
    level: row.level,
    status: row.revokedAt ? 'REVOKED' : row.endsAt <= now ? 'EXPIRED' : 'ACTIVE',
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    grantedById: row.grantedById,
    revokedAt: iso(row.revokedAt),
    revokedById: row.revokedById,
    supportPersonId: row.supportPersonId,
  });
}

/** The support person's name and address (ADR M15-0001 decision 11). It never has a credential. */
export const SUPPORT_PERSON = {
  displayName: 'PlanetPulse support',
  email: 'support@planetpulse.life',
} as const;

/** Ends a grant's memberships and sessions at `when`; returns how many sessions ended. */
async function closeGrant(tx: TenantTx, grant: GrantRow, when: Date): Promise<number> {
  await tx
    .update(s.membership)
    .set({ archivedAt: when, expiresAt: when })
    .where(and(eq(s.membership.personId, grant.supportPersonId), isNull(s.membership.archivedAt)))
    .catch(rethrow);
  const sessions = await tx
    .update(s.authSession)
    .set({ revokedAt: when })
    .where(and(eq(s.authSession.supportGrantId, grant.id), isNull(s.authSession.revokedAt)))
    .returning({ id: s.authSession.id })
    .catch(rethrow);
  return sessions.length;
}

export const supportGrants = {
  /** Newest first. Needs a firm staff context (decision 11: account admins manage support access). */
  async list(tx: TenantTx, now: string): Promise<SupportGrant[]> {
    const when = at(now);
    const rows = await tx
      .select()
      .from(s.supportGrant)
      .orderBy(desc(s.supportGrant.createdAt), desc(s.supportGrant.id))
      .catch(rethrow);
    return rows.map((r) => grantOf(r, when));
  },
  /** The grant that is neither revoked nor over at `now`, if any. */
  async live(tx: TenantTx, now: string): Promise<SupportGrant | null> {
    const when = at(now);
    const [row] = await tx
      .select()
      .from(s.supportGrant)
      .where(and(isNull(s.supportGrant.revokedAt), gt(s.supportGrant.endsAt, when)))
      .catch(rethrow);
    return row ? grantOf(row, when) : null;
  },
  /**
   * Starts a grant: ends the live one (one at a time), creates or reuses the support person, and gives it
   * memberships that expire with the grant: ADMIN is one FIRM_ADMIN membership, READ_ONLY one VIEWER membership per
   * client that exists now. Returns the new grant and the one it ended.
   */
  async create(
    tx: TenantTx,
    request: SupportGrantRequest,
  ): Promise<{ grant: SupportGrant; ended: SupportGrant | null }> {
    const r = validate(SupportGrantRequest, request);
    const when = at(r.now);
    const endsAt = new Date(when.getTime() + r.days * 86_400_000);
    const ended = await supportGrants.revokeLive(tx, r.grantedById, r.now);
    let [person] = await tx
      .select({ id: s.person.id })
      .from(s.person)
      .where(eq(s.person.support, true))
      .catch(rethrow);
    person ??= (
      await tx
        .insert(s.person)
        .values({
          displayName: SUPPORT_PERSON.displayName,
          nameNormalized: SUPPORT_PERSON.displayName.toLowerCase(),
          email: SUPPORT_PERSON.email,
          status: 'ACTIVE',
          support: true,
        })
        .returning({ id: s.person.id })
        .catch(rethrow)
    )[0];
    const [row] = await tx
      .insert(s.supportGrant)
      .values({
        level: r.level,
        startsAt: when,
        endsAt,
        grantedById: r.grantedById,
        supportPersonId: person!.id,
      })
      .returning()
      .catch(rethrow);
    if (r.level === 'ADMIN') {
      await tx
        .insert(s.membership)
        .values({ personId: person!.id, role: 'FIRM_ADMIN', expiresAt: endsAt })
        .catch(rethrow);
    } else {
      const clients = await tx
        .select({ id: s.client.id })
        .from(s.client)
        .where(isNull(s.client.archivedAt))
        .catch(rethrow);
      if (clients.length > 0) {
        await tx
          .insert(s.membership)
          .values(
            clients.map((c) => ({
              personId: person!.id,
              role: 'VIEWER' as const,
              clientId: c.id,
              expiresAt: endsAt,
            })),
          )
          .catch(rethrow);
      }
    }
    return { grant: grantOf(row!, when), ended };
  },
  /** Revokes the grant now: its memberships end and its sessions are signed out. NOT_FOUND when not live. */
  async revoke(
    tx: TenantTx,
    grantId: string,
    revokedById: string,
    now: string,
  ): Promise<{ grant: SupportGrant; sessionsEnded: number }> {
    const when = at(now);
    const [row] = await tx
      .update(s.supportGrant)
      .set({ revokedAt: when, revokedById: validate(Id, revokedById) })
      .where(
        and(
          eq(s.supportGrant.id, validate(Id, grantId)),
          isNull(s.supportGrant.revokedAt),
          gt(s.supportGrant.endsAt, when),
        ),
      )
      .returning()
      .catch(rethrow);
    if (!row) throw new DbError('NOT_FOUND', 'No live support grant with this id');
    const sessionsEnded = await closeGrant(tx, row, when);
    return { grant: grantOf(row, when), sessionsEnded };
  },
  /** Revokes the live grant, if any, as `revokedById`; returns it. */
  async revokeLive(tx: TenantTx, revokedById: string, now: string): Promise<SupportGrant | null> {
    const live = await supportGrants.live(tx, now);
    if (!live) return null;
    return (await supportGrants.revoke(tx, live.id, revokedById, now)).grant;
  },
  /**
   * Ends the memberships and sessions of grants that ran out by `now` (a job, so expired support people keep no
   * membership rows that look live). Returns how many grants it closed.
   */
  async closeExpired(tx: TenantTx, now: string): Promise<number> {
    const when = at(now);
    const rows = await tx
      .select()
      .from(s.supportGrant)
      .where(and(isNull(s.supportGrant.revokedAt), sql`${s.supportGrant.endsAt} <= ${when}`))
      .catch(rethrow);
    let closed = 0;
    for (const row of rows) {
      const open = await tx
        .select({ id: s.membership.id })
        .from(s.membership)
        .where(and(eq(s.membership.personId, row.supportPersonId), isNull(s.membership.archivedAt)))
        .catch(rethrow);
      if (open.length === 0) continue;
      await closeGrant(tx, row, when);
      closed++;
    }
    return closed;
  },
};

// ---------- operator side ----------

/** An account row as the operator reads it: firm columns only, no settings, no people. */
export const AccountRecord = z.strictObject({
  id: Id,
  name: Name,
  kind: AccountKind,
  status: AccountStatus,
  planCode: PlanCode,
  trialEndsOn: LocalDate.nullable(),
  profile: AccountProfile.partial(),
  onboardedAt: Instant.nullable(),
  deletionRequestedAt: Instant.nullable(),
  statusBeforeDeletion: AccountStatus.nullable(),
  createdAt: Instant,
  version: z.int().min(1),
});
export type AccountRecord = z.infer<typeof AccountRecord>;

const recordColumns = {
  id: s.firm.id,
  name: s.firm.name,
  kind: s.firm.kind,
  status: s.firm.status,
  planCode: s.firm.planCode,
  trialEndsOn: s.firm.trialEndsOn,
  profile: s.firm.profile,
  onboardedAt: s.firm.onboardedAt,
  deletionRequestedAt: s.firm.deletionRequestedAt,
  statusBeforeDeletion: s.firm.statusBeforeDeletion,
  createdAt: s.firm.createdAt,
  version: s.firm.version,
};

function recordOf(r: {
  [K in keyof typeof recordColumns]: (typeof recordColumns)[K]['_']['data'] | null;
}): AccountRecord {
  return validate(AccountRecord, {
    ...r,
    onboardedAt: iso(r.onboardedAt as Date | null),
    deletionRequestedAt: iso(r.deletionRequestedAt as Date | null),
    createdAt: (r.createdAt as Date).toISOString(),
  });
}

export const NewAccount = z
  .strictObject({
    name: Name,
    kind: AccountKind,
    planCode: PlanCode,
    trialEndsOn: LocalDate.nullable(),
    settings: FirmSettings,
    profile: AccountProfile,
    /** ENTERPRISE only: the one client the company works in. */
    client: z.strictObject({ name: Name, settings: ClientSettings }).nullable(),
    owner: z.strictObject({ displayName: Name, email: Email }),
    inviteExpiresAt: Instant,
    operatorId: Id,
    requestId: z.string().min(1).max(200),
  })
  .refine((a) => a.client === null || a.kind === 'ENTERPRISE', {
    path: ['client'],
    message: 'Only an ENTERPRISE account has a client of its own',
  });
export type NewAccount = z.input<typeof NewAccount>;

export const AccountEvent = z.strictObject({
  accountId: Id,
  action: AuditAction,
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().trim().min(1).max(2000).nullable(),
  requestId: z.string().min(1).max(200),
  operatorId: Id,
  /** An `account.*` or `support_access.*` outbox event, or null for none. Data carries ids and enums only. */
  event: z
    .strictObject({
      type: z.string().regex(/^(account|support_access)\.[a-z_]+$/),
      data: z.record(z.string(), z.unknown()),
    })
    .nullable(),
});
export type AccountEvent = z.infer<typeof AccountEvent>;

export const AccountChange = z
  .strictObject({
    name: Name,
    status: AccountStatus,
    planCode: PlanCode,
    trialEndsOn: LocalDate.nullable(),
    profile: AccountProfile,
    onboardedAt: Instant.nullable(),
    deletionRequestedAt: Instant.nullable(),
    statusBeforeDeletion: AccountStatus.nullable(),
  })
  .partial();
export type AccountChange = z.infer<typeof AccountChange>;

export const platformAccounts = {
  async list(tx: OperatorTx): Promise<AccountRecord[]> {
    const rows = await tx
      .select(recordColumns)
      .from(s.firm)
      .orderBy(s.firm.name, s.firm.id)
      .catch(rethrow);
    return rows.map(recordOf);
  },
  async get(tx: OperatorTx, accountId: string): Promise<AccountRecord | null> {
    const [row] = await tx
      .select(recordColumns)
      .from(s.firm)
      .where(eq(s.firm.id, validate(Id, accountId)))
      .catch(rethrow);
    return row ? recordOf(row) : null;
  },
  /**
   * Creates the account in PROVISIONING and provisions it in the same transaction: its client (ENTERPRISE), the
   * owner as an INVITED person with a FIRM_ADMIN invite, and the account.created and person.invited events (M9 sends
   * the invite email from person.invited, as for any invite). The library copy follows in `withNewAccount`.
   */
  async create(
    tx: OperatorTx,
    input: NewAccount,
  ): Promise<{ accountId: string; ownerId: string; inviteId: string; clientId: string | null }> {
    const a = validate(NewAccount, input);
    const { rows } = await tx
      .execute<{ id: string }>(
        sql`
        SELECT platform_create_account(${a.name}, ${a.kind}::account_kind, ${a.planCode}, ${a.trialEndsOn}::date,
          ${JSON.stringify(a.settings)}::jsonb, ${JSON.stringify(a.profile)}::jsonb) AS id`,
      )
      .catch(rethrow);
    const accountId = rows[0]!.id;
    const provisioned = await tx
      .execute<{ owner_id: string; invite_id: string; client_id: string | null }>(
        sql`
        SELECT * FROM platform_provision_account(${accountId}, ${a.client?.name ?? null},
          ${a.client ? JSON.stringify(a.client.settings) : null}::jsonb, ${a.owner.displayName},
          ${a.owner.displayName.toLowerCase()}, ${a.owner.email}, ${at(a.inviteExpiresAt)}::timestamptz,
          ${a.operatorId}, ${a.requestId})`,
      )
      .catch(rethrow);
    const p = provisioned.rows[0]!;
    return { accountId, ownerId: p.owner_id, inviteId: p.invite_id, clientId: p.client_id };
  },
  /** Applies `change` when the row is at `version`; STALE_VERSION otherwise. The caller records the event. */
  async update(
    tx: OperatorTx,
    accountId: string,
    version: number,
    change: AccountChange,
  ): Promise<{ before: AccountRecord; after: AccountRecord }> {
    const id = validate(Id, accountId);
    const c = validate(AccountChange, change);
    const before = await platformAccounts.get(tx, id);
    if (!before) throw new DbError('NOT_FOUND', 'No account with this id');
    const [row] = await tx
      .update(s.firm)
      .set({
        ...c,
        onboardedAt: instantOrNull(c.onboardedAt),
        deletionRequestedAt: instantOrNull(c.deletionRequestedAt),
        version: sql`${s.firm.version} + 1`,
      })
      .where(and(eq(s.firm.id, id), eq(s.firm.version, version)))
      .returning(recordColumns)
      .catch(rethrow);
    if (!row) throw new DbError('STALE_VERSION', 'The account changed since it was read');
    return { before, after: recordOf(row) };
  },
  /** The account's own audit trail (actor OPERATOR, entity account) and optionally its outbox event. */
  async recordEvent(tx: OperatorTx, input: AccountEvent): Promise<void> {
    const e = validate(AccountEvent, input);
    await tx
      .execute(
        sql`
        SELECT platform_record_account_event(${e.accountId}, ${e.action}::audit_action,
          ${e.before === null ? null : JSON.stringify(e.before)}::jsonb,
          ${e.after === null ? null : JSON.stringify(e.after)}::jsonb, ${e.reason}, ${e.requestId},
          ${e.operatorId}, ${e.event?.type ?? null}, ${e.event ? JSON.stringify(e.event.data) : null}::jsonb)`,
      )
      .catch(rethrow);
  },
  async usage(tx: OperatorTx, accountId: string): Promise<AccountUsage> {
    const { rows } = await tx
      .execute<Record<string, unknown>>(
        sql`SELECT * FROM platform_usage(${validate(Id, accountId)})`,
      )
      .catch(rethrow);
    return usageOf(rows[0]);
  },
  /** The owner invited at provisioning, or null before provisioning. */
  async owner(
    tx: OperatorTx,
    accountId: string,
  ): Promise<{ email: string; displayName: string; accepted: boolean } | null> {
    const { rows } = await tx
      .execute<{ email: string; display_name: string; accepted: boolean }>(
        sql`SELECT * FROM platform_account_owner(${validate(Id, accountId)})`,
      )
      .catch(rethrow);
    const [r] = rows;
    return r ? { email: r.email, displayName: r.display_name, accepted: r.accepted } : null;
  },
  /** Effective limits and features: the plan overlaid with the account's override. */
  async entitlements(
    tx: OperatorTx,
    accountId: string,
  ): Promise<{ planCode: string; limits: PlanLimits; features: string[] }> {
    const id = validate(Id, accountId);
    const [row] = await tx
      .select({
        planCode: s.firm.planCode,
        limits: sql<PlanLimits>`${s.plan.limits} || coalesce(${s.accountOverride.limits}, '{}'::jsonb)`,
        features: sql<
          string[]
        >`ARRAY(SELECT DISTINCT unnest(${s.plan.features} || coalesce(${s.accountOverride.features}, '{}'::text[])) ORDER BY 1)`,
      })
      .from(s.firm)
      .innerJoin(s.plan, eq(s.plan.code, s.firm.planCode))
      .leftJoin(s.accountOverride, eq(s.accountOverride.accountId, s.firm.id))
      .where(eq(s.firm.id, id))
      .catch(rethrow);
    if (!row) throw new DbError('NOT_FOUND', 'No account with this id');
    return {
      planCode: row.planCode,
      limits: validate(PlanLimits, row.limits),
      features: z.array(FeatureFlag).parse(row.features),
    };
  },
};

export const IssueSupportToken = z.strictObject({
  accountId: Id,
  grantId: Id,
  tokenHash: TokenHash,
  expiresAt: Instant,
});
export type IssueSupportToken = z.infer<typeof IssueSupportToken>;

// The columns canopy_operator may read (migration 0020); selecting any other one is refused.
const operatorGrantColumns = {
  id: s.supportGrant.id,
  accountId: s.supportGrant.firmId,
  level: s.supportGrant.level,
  startsAt: s.supportGrant.startsAt,
  endsAt: s.supportGrant.endsAt,
  revokedAt: s.supportGrant.revokedAt,
};

function operatorGrantOf(
  r: {
    id: string;
    accountId: string;
    level: SupportAccessLevel;
    startsAt: Date;
    endsAt: Date;
    revokedAt: Date | null;
  },
  now: Date,
): OperatorSupportGrant {
  return validate(OperatorSupportGrant, {
    ...r,
    status: r.revokedAt ? 'REVOKED' : r.endsAt <= now ? 'EXPIRED' : 'ACTIVE',
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    revokedAt: iso(r.revokedAt),
  });
}

export const platformSupport = {
  /** One account's grants, newest first, as the operator may see them (no person ids). */
  async list(tx: OperatorTx, accountId: string, now: string): Promise<OperatorSupportGrant[]> {
    const rows = await tx
      .select(operatorGrantColumns)
      .from(s.supportGrant)
      .where(eq(s.supportGrant.firmId, validate(Id, accountId)))
      .orderBy(desc(s.supportGrant.startsAt), desc(s.supportGrant.id))
      .catch(rethrow);
    return rows.map((r) => operatorGrantOf(r, at(now)));
  },
  /** Every account's live grant (the console's "support access" column). */
  async live(tx: OperatorTx, now: string): Promise<OperatorSupportGrant[]> {
    const when = at(now);
    const rows = await tx
      .select(operatorGrantColumns)
      .from(s.supportGrant)
      .where(and(isNull(s.supportGrant.revokedAt), gt(s.supportGrant.endsAt, when)))
      .catch(rethrow);
    return rows.map((r) => operatorGrantOf(r, when));
  },
  /** Stores the one-time token the console opens the app with; refused unless the grant is live. */
  async issueToken(tx: OperatorTx, input: IssueSupportToken): Promise<void> {
    const t = validate(IssueSupportToken, input);
    await tx
      .execute(
        sql`
        SELECT platform_issue_support_token(${t.accountId}, ${t.grantId}, ${t.tokenHash},
          ${at(t.expiresAt)}::timestamptz)`,
      )
      .catch(rethrow);
  },
};

/** Ids of accounts in any of `statuses` (jobs: trial reminders, nightly usage snapshots). */
export async function accountIdsWithStatus(
  tx: OperatorTx,
  statuses: AccountStatus[],
): Promise<string[]> {
  if (statuses.length === 0) return [];
  const rows = await tx
    .select({ id: s.firm.id })
    .from(s.firm)
    .where(inArray(s.firm.status, statuses))
    .catch(rethrow);
  return rows.map((r) => r.id);
}
