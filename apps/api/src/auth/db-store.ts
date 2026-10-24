import {
  LocalDate,
  type ClientSummary,
  type Membership,
  type Person,
  type RequestContext,
} from '@canopy/contracts';
import {
  account as accounts,
  auditEvents,
  clients,
  credentials,
  DbError,
  domainEvents,
  firms,
  invites,
  loginTokens,
  memberships,
  people,
  sessions,
  systemContext,
  tenantFromRequest,
  units,
  type Database,
  type Invite as StoredInvite,
  type TenantTx,
} from '@canopy/db';
import { clientPeriods, localDateIn } from '@canopy/engine';
import {
  LOCKOUT,
  type AcceptInvite,
  type AccountStore,
  type InviteRecord,
  type Invitee,
  type LoginCandidate,
  type LoginToken,
  type MfaRecord,
  type NewInvite,
  type NewLoginToken,
  type NewSession,
  type SupportToken,
  userLimitReached,
} from './accounts.js';
import type { Principal, SessionRecord } from './context.js';

/** First and last due dates of a client's generated instances, or null when none are generated yet. */
export type GeneratedRange = (
  tx: TenantTx,
  clientId: string,
) => Promise<{ from: LocalDate; to: LocalDate } | null>;

export interface DbAccountStoreOptions {
  /** Default: M3's `clients.generatedRange`, the due dates of the client's instances the context sees. */
  readonly generatedRange?: GeneratedRange;
  readonly clock?: () => Date;
}

const defaultGeneratedRange: GeneratedRange = async (tx, clientId) => {
  const range = await clients.generatedRange(tx, clientId);
  return range && { from: LocalDate.parse(range.from), to: LocalDate.parse(range.to) };
};

/** Correlates the reads made before a request context exists (no request id is passed to them). */
const LOOKUP_REQUEST = 'auth-lookup';
const PAGE = 200;

const normalise = (name: string) => name.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * `AccountStore` on M3's repositories (ADR M3-0001). Firm-keyed calls run in the firm's system context, because
 * they happen before a request context exists or change rows a client context cannot (people with firm roles);
 * M5's `can()` has already decided the actor may do them. Each method is one transaction with its audit and
 * outbox rows, matching `InMemoryAuthStore`.
 */
export function createDbAccountStore(db: Database, options: DbAccountStoreOptions): AccountStore {
  const clock = options.clock ?? (() => new Date());
  const generatedRange: GeneratedRange = options.generatedRange ?? defaultGeneratedRange;
  const asFirm = <T>(firmId: string, requestId: string, fn: (tx: TenantTx) => Promise<T>) =>
    db.withTenant(systemContext(firmId, requestId), fn);

  async function personAudit(
    tx: TenantTx,
    requestId: string,
    actorId: string | null,
    action: 'CREATE' | 'UPDATE',
    before: Person | null,
    after: Person,
  ) {
    await auditEvents.append(tx, {
      clientId: null,
      requestId,
      actorId,
      actorKind: actorId === null ? 'SYSTEM' : 'PERSON',
      action,
      entityType: 'person',
      entityId: after.id,
      before: before === null ? null : personFields(before),
      after: personFields(after),
      reason: null,
    });
  }

  async function inviteRecord(tx: TenantTx, invite: StoredInvite): Promise<InviteRecord> {
    const person = await people.require(tx, invite.personId);
    const client =
      invite.grant.clientId === null ? null : await clients.get(tx, invite.grant.clientId);
    return {
      id: invite.id,
      firmId: invite.firmId,
      createdAt: invite.createdAt,
      updatedAt: invite.acceptedAt ?? invite.revokedAt ?? invite.createdAt,
      archivedAt: null,
      personId: invite.personId,
      email: invite.email,
      role: invite.grant.role,
      clientId: invite.grant.clientId,
      consultantClientIds: invite.grant.consultantClientIds,
      unitIds: invite.grant.unitIds,
      expiresAt: invite.grant.expiresAt,
      status: invite.acceptedAt ? 'ACCEPTED' : invite.revokedAt ? 'REVOKED' : 'PENDING',
      invitedById: invite.createdById,
      linkExpiresAt: invite.expiresAt,
      firmName: invite.firmName,
      displayName: person.displayName,
      clientName: client?.name ?? null,
    };
  }

  async function allClientIds(tx: TenantTx): Promise<string[]> {
    const ids: string[] = [];
    let after: { key: string; id: string } | null = null;
    for (;;) {
      const { items } = await clients.query(tx, { includeArchived: true, after, limit: PAGE });
      ids.push(...items.map((c) => c.id));
      if (items.length < PAGE) return ids;
      const last = items[items.length - 1]!;
      after = { key: last.id, id: last.id };
    }
  }

  return {
    async findSession(tokenHash: string): Promise<SessionRecord | null> {
      return db.findSession(tokenHash);
    },

    async loadPrincipal(firmId: string, personId: string): Promise<Principal | null> {
      return asFirm(firmId, LOOKUP_REQUEST, async (tx) => {
        const person = await people.get(tx, personId);
        if (person === null || person.archivedAt !== null) return null;
        // One transaction is one connection: its queries run one after another.
        const held = await memberships.forPerson(tx, personId);
        const credential = await credentials.get(tx, personId);
        const firm = await firms.current(tx);
        const firmClientIds = await allClientIds(tx);
        return {
          person,
          memberships: held,
          mfaEnrolled: credential?.mfaEnrolled ?? false,
          mfaRequiredForFirmRoles: firm.settings.mfaRequiredForFirmRoles,
          firmClientIds,
        };
      });
    },

    async clientTimeZone(firmId: string, clientId: string): Promise<string | null> {
      return asFirm(firmId, LOOKUP_REQUEST, async (tx) => {
        const client = await clients.get(tx, clientId);
        return client?.settings.timeZone ?? null;
      });
    },

    async clientSummaries(ctx: RequestContext): Promise<ClientSummary[]> {
      return db.withTenant(tenantFromRequest(ctx), async (tx) => {
        const summaries: ClientSummary[] = [];
        for (const clientId of ctx.clientIds) {
          const client = await clients.get(tx, clientId);
          if (client === null || client.archivedAt !== null) continue;
          const scope = unitScope(ctx.memberships, clientId);
          const { total } = await units.query(tx, {
            where: scope === null ? { clientId } : { clientId, id: scope },
            count: true,
            limit: 1,
          });
          const { timeZone, fyStartMonth } = client.settings;
          const today = localDateIn(clock().toISOString(), timeZone);
          const range = await generatedRange(tx, client.id);
          summaries.push({
            id: client.id,
            name: client.name,
            fyStartMonth,
            timeZone,
            unitCount: total ?? 0,
            period: clientPeriods({
              today,
              fyStartMonth,
              generatedFrom: range?.from ?? null,
              generatedTo: range?.to ?? null,
            }),
          });
        }
        return summaries;
      });
    },

    async findLoginCandidates(email: string): Promise<LoginCandidate[]> {
      return db.findLoginCandidates(email);
    },

    async account(firmId: string) {
      return asFirm(firmId, LOOKUP_REQUEST, (tx) => accounts.get(tx)).catch((error: unknown) => {
        if (error instanceof DbError && error.code === 'NOT_FOUND') return null;
        throw error;
      });
    },

    async findSupportToken(tokenHash: string): Promise<SupportToken | null> {
      return db.findSupportToken(tokenHash);
    },

    async recordLoginFailure(firmId: string, personId: string, now: Date): Promise<boolean> {
      const { lockedUntil } = await asFirm(firmId, LOOKUP_REQUEST, (tx) =>
        credentials.recordFailure(tx, personId, now.toISOString(), LOCKOUT),
      );
      return lockedUntil !== null && Date.parse(lockedUntil) > now.getTime();
    },

    async resetLoginFailures(firmId: string, personId: string): Promise<void> {
      await asFirm(firmId, LOOKUP_REQUEST, (tx) => credentials.resetFailures(tx, personId));
    },

    async revokeAllSessions(firmId: string, personId: string, now: Date): Promise<void> {
      await asFirm(firmId, LOOKUP_REQUEST, (tx) =>
        sessions.revokeAllForPerson(tx, personId, now.toISOString()),
      );
    },

    async createSession(session: NewSession): Promise<SessionRecord> {
      return asFirm(session.firmId, session.requestId, async (tx) => {
        const stored = await sessions.create(tx, {
          personId: session.personId,
          tokenHash: session.tokenHash,
          csrfToken: session.csrfToken,
          mfaSatisfied: session.mfaSatisfied,
          expiresAt: session.expiresAt,
          createdAt: session.createdAt,
          method: session.method,
          ...(session.supportGrantId === undefined
            ? {}
            : { supportGrantId: session.supportGrantId }),
        });
        if (!session.owesMfa) await credentials.resetFailures(tx, session.personId);
        await auditEvents.append(tx, {
          clientId: null,
          requestId: session.requestId,
          actorId: session.personId,
          actorKind: 'PERSON',
          action: 'LOGIN',
          entityType: 'person',
          entityId: session.personId,
          before: null,
          after: { method: session.method },
          reason: null,
        });
        return stored;
      });
    },

    async revokeSession(firmId: string, sessionId: string, now: Date): Promise<void> {
      await asFirm(firmId, LOOKUP_REQUEST, (tx) =>
        sessions.revoke(tx, sessionId, now.toISOString()),
      );
    },

    async markSessionMfa(firmId: string, sessionId: string): Promise<void> {
      await asFirm(firmId, LOOKUP_REQUEST, (tx) => sessions.markMfa(tx, sessionId));
    },

    async getMfa(firmId: string, personId: string): Promise<MfaRecord | null> {
      return asFirm(firmId, LOOKUP_REQUEST, (tx) => credentials.getMfa(tx, personId));
    },

    async saveMfa(firmId: string, personId: string, record: MfaRecord): Promise<void> {
      await asFirm(firmId, LOOKUP_REQUEST, (tx) => credentials.saveMfa(tx, personId, record));
    },

    async acceptMfaStep(firmId: string, personId: string, step: number): Promise<boolean> {
      return asFirm(firmId, LOOKUP_REQUEST, (tx) => credentials.acceptMfaStep(tx, personId, step));
    },

    async requestMagicLink(firmId: string, personId: string, requestId: string): Promise<void> {
      await asFirm(firmId, requestId, async (tx) => {
        const person = await people.require(tx, personId);
        await domainEvents.enqueue(tx, {
          type: 'auth.magic_link_requested',
          clientId: null,
          actor: { kind: 'PERSON', personId },
          requestId,
          aggregate: { type: 'person', id: personId },
          aggregateVersion: person.version,
          data: { personId },
        });
      });
    },

    async createLoginToken(token: NewLoginToken): Promise<void> {
      await asFirm(token.firmId, LOOKUP_REQUEST, (tx) =>
        loginTokens.create(tx, {
          personId: token.personId,
          kind: token.kind,
          inviteId: token.inviteId,
          tokenHash: token.tokenHash,
          expiresAt: token.expiresAt,
        }),
      );
    },

    async findLoginToken(tokenHash: string): Promise<LoginToken | null> {
      const found = await db.findLoginToken(tokenHash);
      if (found === null) return null;
      return {
        id: found.id,
        firmId: found.firmId,
        personId: found.personId,
        kind: found.kind,
        inviteId: found.inviteId,
        tokenHash: found.tokenHash,
        expiresAt: found.expiresAt,
        usedAt: found.usedAt,
      };
    },

    async consumeLoginToken(firmId: string, tokenId: string, now: Date): Promise<boolean> {
      return asFirm(firmId, LOOKUP_REQUEST, (tx) =>
        loginTokens.consume(tx, tokenId, now.toISOString()),
      );
    },

    async findInvitee(firmId: string, personId: string, now: Date): Promise<Invitee | null> {
      return asFirm(firmId, LOOKUP_REQUEST, async (tx) => {
        const person = await people.get(tx, personId);
        if (person === null || person.archivedAt !== null) return null;
        const held = await memberships.forPerson(tx, personId);
        // The firm's system context sees every invite of the person, whoever sent it.
        const invited = (await invites.openForPerson(tx, personId, now.toISOString())).map(
          (i) => i.grant,
        );
        return {
          personId,
          status: person.status,
          email: person.email,
          support: person.support === true,
          roles: [...held, ...invited].map((r) => ({ role: r.role, clientId: r.clientId })),
        };
      });
    },

    async findPersonIdByEmail(firmId: string, email: string): Promise<string | null> {
      return asFirm(firmId, LOOKUP_REQUEST, async (tx) => {
        const person = await people.findByEmail(tx, email);
        return person?.id ?? null;
      });
    },

    async createInvite(invite: NewInvite): Promise<InviteRecord> {
      return asFirm(invite.firmId, invite.requestId, async (tx) => {
        const before = await accounts.get(tx);
        let personId = invite.personId;
        if (personId === null) {
          const displayName = invite.displayName ?? invite.email;
          const created = await people.create(tx, {
            displayName,
            nameNormalized: normalise(displayName),
            email: null,
            status: 'UNCLAIMED',
          });
          await personAudit(tx, invite.requestId, invite.invitedById, 'CREATE', null, created);
          personId = created.id;
        }
        const result = await invites.create(
          tx,
          {
            personId,
            email: invite.email,
            grant: {
              role: invite.grant.role,
              clientId: invite.grant.clientId,
              consultantClientIds: invite.grant.consultantClientIds,
              unitIds: invite.grant.unitIds,
              expiresAt: invite.grant.expiresAt,
            },
            createdById: invite.invitedById,
            expiresAt: invite.linkExpiresAt,
          },
          invite.now.toISOString(),
        );
        // The seat count after the insert says whether this invite took a seat (ADR M5-0002 decision 3).
        const max = before.entitlements.limits.users;
        if (max !== null) {
          const { users } = await accounts.usage(tx);
          if (users > before.usage.users && users > max) {
            throw userLimitReached(max, before.usage.users);
          }
        }
        const after = result.person?.after ?? (await people.require(tx, personId));
        if (result.person) {
          await personAudit(
            tx,
            invite.requestId,
            invite.invitedById,
            'UPDATE',
            result.person.before,
            result.person.after,
          );
        }
        await domainEvents.enqueue(tx, {
          type: 'person.invited',
          clientId: invite.grant.clientId,
          actor: { kind: 'PERSON', personId: invite.invitedById },
          requestId: invite.requestId,
          aggregate: { type: 'person', id: personId },
          aggregateVersion: after.version,
          data: {
            personId,
            inviteId: result.invite.id,
            role: invite.grant.role,
            clientId: invite.grant.clientId,
          },
        });
        return inviteRecord(tx, result.invite);
      });
    },

    async findInvite(firmId: string, inviteId: string): Promise<InviteRecord | null> {
      return asFirm(firmId, LOOKUP_REQUEST, async (tx) => {
        const invite = await invites.get(tx, inviteId);
        return invite === null ? null : inviteRecord(tx, invite);
      });
    },

    async revokeInvite(
      firmId: string,
      inviteId: string,
      actorId: string,
      requestId: string,
      now: Date,
    ): Promise<void> {
      await asFirm(firmId, requestId, async (tx) => {
        const revoked = await invites.revoke(tx, inviteId, now.toISOString());
        if (revoked === null) return;
        await auditEvents.append(tx, {
          clientId: revoked.grant.clientId,
          requestId,
          actorId,
          actorKind: 'PERSON',
          action: 'UPDATE',
          entityType: 'person',
          entityId: revoked.personId,
          before: { inviteId, inviteStatus: 'PENDING' },
          after: { inviteId, inviteStatus: 'REVOKED' },
          reason: null,
        });
      });
    },

    // A link already used or an invite no longer open is NOT_FOUND from the repository; the transaction rolls back.
    async acceptInvite(accept: AcceptInvite): Promise<boolean> {
      return asFirm(accept.firmId, accept.requestId, async (tx) => {
        const { person, membership } = await invites.accept(tx, {
          inviteId: accept.inviteId,
          tokenId: accept.tokenId,
          passwordHash: accept.passwordHash,
          now: accept.now.toISOString(),
        });
        let after = person.after;
        if (accept.displayName !== null && accept.displayName !== after.displayName) {
          after = await people.update(tx, after.id, after.version, {
            displayName: accept.displayName,
            nameNormalized: normalise(accept.displayName),
          });
        }
        await personAudit(tx, accept.requestId, after.id, 'UPDATE', person.before, after);
        await auditEvents.append(tx, {
          clientId: membership.clientId,
          requestId: accept.requestId,
          actorId: after.id,
          actorKind: 'PERSON',
          action: 'MEMBERSHIP_CHANGE',
          entityType: 'membership',
          entityId: membership.id,
          before: null,
          after: membershipFields(membership),
          reason: null,
        });
        const actor = { kind: 'PERSON' as const, personId: after.id };
        await domainEvents.enqueue(tx, {
          type: 'person.claimed',
          clientId: membership.clientId,
          actor,
          requestId: accept.requestId,
          aggregate: { type: 'person', id: after.id },
          aggregateVersion: after.version,
          data: { personId: after.id },
        });
        await domainEvents.enqueue(tx, {
          type: 'membership.changed',
          clientId: membership.clientId,
          actor,
          requestId: accept.requestId,
          aggregate: { type: 'membership', id: membership.id },
          aggregateVersion: membership.version,
          data: {
            membershipId: membership.id,
            personId: after.id,
            role: membership.role,
            clientId: membership.clientId,
            change: 'GRANTED',
          },
        });
        return true;
      }).catch((error: unknown) => {
        if (error instanceof DbError && error.code === 'NOT_FOUND') return false;
        throw error;
      });
    },
  };
}

/** The units of a client a person's memberships limit them to, or null for all of them. */
function unitScope(held: readonly Membership[], clientId: string): string[] | null {
  const inClient = held.filter((m) => m.clientId === clientId);
  if (inClient.length === 0 || inClient.some((m) => m.unitIds === null)) return null;
  return [...new Set(inClient.flatMap((m) => m.unitIds ?? []))];
}

/** A person's audit fields: no email, which is personal data the audit trail does not need. */
function personFields(person: Person): Record<string, unknown> {
  return { status: person.status, displayName: person.displayName, version: person.version };
}

function membershipFields(m: Membership): Record<string, unknown> {
  return {
    personId: m.personId,
    role: m.role,
    clientId: m.clientId,
    consultantClientIds: m.consultantClientIds,
    unitIds: m.unitIds,
    expiresAt: m.expiresAt,
  };
}
