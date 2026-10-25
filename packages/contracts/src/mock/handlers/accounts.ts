// M15 customer routes: the account's plan and usage, and PlanetPulse support grants. Fixture firms are active
// consultancies on the CONSULTANCY plan (unlimited). `POST /__mock/support-sessions/{grantId}` stands in for the
// operator console and returns a token for `POST /auth/support/verify`.
import type { z } from 'zod';
import { SUPPORT_SESSION_HOURS } from '../../defaults.js';
import type { SupportGrant } from '../../schemas/accounts.js';
import { audit, MockError, notFound, type Actor } from '../core.js';
import { actorOf, type PartialHandlers } from '../handler.js';
import { activeMemberships, type FirmState, type MockStore } from '../store.js';
import { me } from './auth.js';

type GrantRecord = z.input<typeof SupportGrant>;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A grant as it reads at `now`: ACTIVE ones past their end read EXPIRED. */
function view(grant: GrantRecord, now: string): GrantRecord {
  return grant.status === 'ACTIVE' && grant.endsAt <= now ? { ...grant, status: 'EXPIRED' } : grant;
}

type AuditContext = Parameters<typeof audit>[0];

/**
 * Revokes a live grant at `now`: its memberships expire and its support sessions end, each membership change audited
 * (ADR M15-0001 decision 11). Used by revoke and by a new grant replacing the last.
 */
function endGrant(
  ctx: AuditContext & { store: MockStore },
  actor: Actor,
  grant: GrantRecord,
  now: string,
  reason: string,
): void {
  grant.status = 'REVOKED';
  grant.revokedAt = now;
  grant.revokedById = actor.person.id;
  for (const m of actor.firm.data.memberships) {
    if (m.personId === grant.supportPersonId && m.expiresAt !== null && m.expiresAt > now) {
      const before = m.expiresAt;
      m.expiresAt = now;
      m.updatedAt = now;
      audit(ctx, actor, {
        action: 'MEMBERSHIP_CHANGE',
        entityType: 'membership',
        entityId: m.id,
        clientId: m.clientId,
        before: { expiresAt: before },
        after: { expiresAt: now, supportGrantId: grant.id },
        reason,
      });
    }
  }
  for (const [id, session] of ctx.store.sessions) {
    if (session.personId === grant.supportPersonId) ctx.store.sessions.delete(id);
  }
}

/** The account's support person (`support: true`): one per account, reused by every grant. */
function supportPerson(store: MockStore, firm: FirmState, now: string): string {
  const existing = firm.data.people.find((p) => p.support === true);
  if (existing !== undefined) return existing.id;
  const id = store.newId();
  firm.data.people.push({
    id,
    firmId: firm.data.firm.id,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    version: 1,
    displayName: SUPPORT_PERSON_NAME,
    nameNormalized: SUPPORT_PERSON_NAME.toLowerCase(),
    email: SUPPORT_EMAIL,
    status: 'ACTIVE',
    support: true,
  });
  return id;
}

/** How the mock names the support person; the real provider adds the operator's name. */
export const SUPPORT_PERSON_NAME = 'PlanetPulse support';
/**
 * The support person's email in every account. It has no password and never matches an email lookup, so it signs in
 * only through support sessions.
 */
export const SUPPORT_EMAIL = 'support@planetpulse.life';

export const accountHandlers: PartialHandlers<
  | 'getAccount'
  | 'listSupportGrants'
  | 'createSupportGrant'
  | 'revokeSupportGrant'
  | 'verifySupportSession'
> = {
  getAccount(ctx) {
    ctx.authorize({ clientId: null });
    const actor = actorOf(ctx);
    const d = actor.firm.data;
    const now = ctx.clock.now();
    const live = <T extends { archivedAt: string | null }>(rows: T[]) =>
      rows.filter((r) => r.archivedAt === null).length;
    return {
      id: d.firm.id,
      name: d.firm.name,
      kind: d.firm.kind ?? 'CONSULTANCY',
      status: d.firm.status ?? 'ACTIVE',
      trialEndsOn: d.firm.trialEndsOn ?? null,
      features: [...actor.features],
      entitlements: {
        planCode: d.firm.planCode ?? 'CONSULTANCY',
        limits: { companies: null, units: null, users: null, storageBytes: null },
        features: [...actor.features],
      },
      usage: {
        companies: live(d.companies),
        units: live(d.units),
        // People ACTIVE or INVITED with a live membership, support people excluded (ADR M15-0001 decision 5).
        users: d.people.filter(
          (p) =>
            p.archivedAt === null &&
            (p.status === 'ACTIVE' || p.status === 'INVITED') &&
            p.support !== true &&
            activeMemberships(actor.firm, p.id, now).length > 0,
        ).length,
        storageBytes: d.evidence
          .filter((e) => e.archivedAt === null)
          .reduce((sum, e) => sum + e.sizeBytes, 0),
      },
    };
  },

  listSupportGrants(ctx) {
    ctx.authorize({ clientId: null });
    const now = ctx.clock.now();
    const grants = actorOf(ctx).firm.supportGrants.map((g) => view(g, now));
    return { items: [...grants].sort((a, b) => b.startsAt.localeCompare(a.startsAt)) };
  },

  createSupportGrant(ctx) {
    ctx.authorize({ clientId: null });
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const now = ctx.clock.now();
    // One live grant at a time: a new grant ends the one before it, sessions included.
    for (const grant of firm.supportGrants) {
      if (view(grant, now).status === 'ACTIVE') {
        endGrant(ctx, actor, grant, now, 'Replaced by a new support grant');
      }
    }
    const grantId = ctx.store.newId();
    const endsAt = iso(Date.parse(now) + ctx.body.days * DAY_MS);
    const personId = supportPerson(ctx.store, firm, now);
    const base = {
      firmId: firm.data.firm.id,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      version: 1,
      personId,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: endsAt,
    };
    const added =
      ctx.body.level === 'ADMIN'
        ? [{ ...base, id: ctx.store.newId(), role: 'FIRM_ADMIN' as const, clientId: null }]
        : firm.data.clients
            .filter((c) => c.archivedAt === null)
            .map((c) => ({
              ...base,
              id: ctx.store.newId(),
              role: 'VIEWER' as const,
              clientId: c.id,
            }));
    for (const m of added) {
      firm.data.memberships.push(m);
      audit(ctx, actor, {
        action: 'MEMBERSHIP_CHANGE',
        entityType: 'membership',
        entityId: m.id,
        clientId: m.clientId,
        after: { role: m.role, expiresAt: endsAt, supportGrantId: grantId, level: ctx.body.level },
        reason: 'Support access granted',
      });
    }
    const grant: GrantRecord = {
      id: grantId,
      accountId: firm.data.firm.id,
      level: ctx.body.level,
      status: 'ACTIVE',
      startsAt: now,
      endsAt,
      grantedById: actor.person.id,
      revokedAt: null,
      revokedById: null,
      supportPersonId: personId,
    };
    firm.supportGrants.push(grant);
    return grant;
  },

  revokeSupportGrant(ctx) {
    ctx.authorize({ clientId: null });
    const actor = actorOf(ctx);
    const grant = actor.firm.supportGrants.find((g) => g.id === ctx.params.id);
    if (grant === undefined) throw notFound();
    const now = ctx.clock.now();
    if (view(grant, now).status !== 'ACTIVE') {
      throw new MockError('INVALID_TRANSITION', 'This grant has already ended');
    }
    endGrant(ctx, actor, grant, now, 'Support access revoked');
    return grant;
  },

  verifySupportSession(ctx) {
    const pending = ctx.store.supportTokens.get(ctx.body.token);
    ctx.store.supportTokens.delete(ctx.body.token);
    const now = ctx.clock.now();
    if (pending === undefined || pending.expiresAt <= now)
      throw new MockError('UNAUTHENTICATED', 'This link is invalid or used');
    const firm = ctx.store.firm(pending.firmId);
    const grant = firm.supportGrants.find((g) => g.id === pending.grantId);
    if (grant === undefined || view(grant, now).status !== 'ACTIVE') {
      throw new MockError('UNAUTHENTICATED', 'This support access has ended');
    }
    const person = firm.data.people.find((p) => p.id === grant.supportPersonId)!;
    // The operator passed MFA in the console, so the session starts with MFA satisfied.
    const session = ctx.store.openSession(firm.data.firm.id, person.id, false, now);
    session.mfaSatisfied = true;
    // It lasts until the earlier of SUPPORT_SESSION_HOURS and the grant end.
    const cap = iso(Date.parse(now) + SUPPORT_SESSION_HOURS * HOUR_MS);
    session.expiresAt = cap < grant.endsAt ? cap : grant.endsAt;
    session.capped = true;
    ctx.setSession(session);
    return me(firm, person, session, ctx.clock, ctx.features ?? firm.features);
  },
};
