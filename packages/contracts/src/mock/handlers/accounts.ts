// M15 customer routes: the account's plan and usage, and PlanetPulse support grants. Fixture firms are active
// consultancies on the CONSULTANCY plan (unlimited). `POST /__mock/support-sessions/{grantId}` stands in for the
// operator console and returns a token for `POST /auth/support/verify`.
import type { z } from 'zod';
import type { SupportGrant } from '../../schemas/accounts.js';
import { MockError, notFound } from '../core.js';
import { actorOf, type PartialHandlers } from '../handler.js';
import type { FirmState, MockStore } from '../store.js';
import { me } from './auth.js';

type GrantRecord = z.input<typeof SupportGrant>;

const DAY_MS = 86_400_000;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A grant as it reads at `now`: ACTIVE ones past their end read EXPIRED. */
function view(grant: GrantRecord, now: string): GrantRecord {
  return grant.status === 'ACTIVE' && grant.endsAt <= now ? { ...grant, status: 'EXPIRED' } : grant;
}

/** Ends the grant's memberships at `at`, so the support person loses access at once. */
function endMemberships(firm: FirmState, grant: GrantRecord, at: string): void {
  for (const m of firm.data.memberships) {
    if (m.personId === grant.supportPersonId && m.expiresAt !== null && m.expiresAt > at) {
      m.expiresAt = at;
      m.updatedAt = at;
    }
  }
}

/** The account's support person: one per account, reused by every grant. */
function supportPerson(store: MockStore, firm: FirmState, now: string): string {
  const existing = firm.data.people.find((p) => p.displayName === SUPPORT_PERSON_NAME);
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
  });
  return id;
}

/** How the mock names the support person; the real provider adds the operator's name. */
export const SUPPORT_PERSON_NAME = 'PlanetPulse support';
/** The support person's email in every account. It has no password, so it signs in only through support sessions. */
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
    const d = actorOf(ctx).firm.data;
    const live = <T extends { archivedAt: string | null }>(rows: T[]) =>
      rows.filter((r) => r.archivedAt === null).length;
    return {
      id: d.firm.id,
      name: d.firm.name,
      kind: d.firm.kind ?? 'CONSULTANCY',
      status: d.firm.status ?? 'ACTIVE',
      trialEndsOn: d.firm.trialEndsOn ?? null,
      entitlements: {
        planCode: d.firm.planCode ?? 'CONSULTANCY',
        limits: { companies: null, units: null, users: null, storageBytes: null },
        features: [],
      },
      usage: {
        companies: live(d.companies),
        units: live(d.units),
        users: d.people.filter(
          (p) =>
            (p.status === 'ACTIVE' || p.status === 'INVITED') &&
            p.displayName !== SUPPORT_PERSON_NAME,
        ).length,
        storageBytes: d.evidence.reduce((sum, e) => sum + e.sizeBytes, 0),
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
    // One live grant at a time: a new grant ends the one before it.
    for (const grant of firm.supportGrants) {
      if (view(grant, now).status === 'ACTIVE') {
        grant.status = 'REVOKED';
        grant.revokedAt = now;
        grant.revokedById = actor.person.id;
        endMemberships(firm, grant, now);
      }
    }
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
    if (ctx.body.level === 'ADMIN') {
      firm.data.memberships.push({
        ...base,
        id: ctx.store.newId(),
        role: 'FIRM_ADMIN',
        clientId: null,
      });
    } else {
      for (const client of firm.data.clients.filter((c) => c.archivedAt === null)) {
        firm.data.memberships.push({
          ...base,
          id: ctx.store.newId(),
          role: 'VIEWER',
          clientId: client.id,
        });
      }
    }
    const grant: GrantRecord = {
      id: ctx.store.newId(),
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
    grant.status = 'REVOKED';
    grant.revokedAt = now;
    grant.revokedById = actor.person.id;
    endMemberships(actor.firm, grant, now);
    for (const [id, session] of ctx.store.sessions) {
      if (session.personId === grant.supportPersonId) ctx.store.sessions.delete(id);
    }
    return grant;
  },

  verifySupportSession(ctx) {
    const pending = ctx.store.supportTokens.get(ctx.body.token);
    ctx.store.supportTokens.delete(ctx.body.token);
    if (pending === undefined)
      throw new MockError('UNAUTHENTICATED', 'This link is invalid or used');
    const firm = ctx.store.firm(pending.firmId);
    const grant = firm.supportGrants.find((g) => g.id === pending.grantId);
    const now = ctx.clock.now();
    if (grant === undefined || view(grant, now).status !== 'ACTIVE') {
      throw new MockError('UNAUTHENTICATED', 'This support access has ended');
    }
    const person = firm.data.people.find((p) => p.id === grant.supportPersonId)!;
    // The operator passed MFA in the console, so the session starts with MFA satisfied.
    const session = ctx.store.openSession(firm.data.firm.id, person.id, false, now);
    session.mfaSatisfied = true;
    ctx.setSession(session);
    return me(firm, person, session, ctx.clock);
  },
};
