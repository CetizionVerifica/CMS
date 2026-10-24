import { createHash } from 'node:crypto';
import {
  AccountView,
  ENDPOINTS,
  IdParams,
  type Membership,
  SupportGrant,
  type RequestContext,
  type Resource,
} from '@canopy/contracts';
import {
  account,
  auditEvents,
  DbError,
  domainEvents,
  firms,
  idempotencyKeys,
  memberships,
  people,
  supportGrants,
  tenantFromRequest,
  type Database,
  type IdempotencyRecord,
  type TenantTx,
} from '@canopy/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, authorize } from '../auth/index.js';
import { IDEMPOTENCY_TTL_MS } from './idempotency.js';

/**
 * The customer's own account (ADR M15-0001 decisions 5 and 11, docs/contracts/endpoints.md §8), under /api/v1 on the
 * customer session: `GET /account` (plan, limits and usage, read-only) and support access, which only the account's
 * admins grant and revoke. A support session never manages support access, whatever its membership says: PlanetPulse
 * cannot extend its own way in. Each grant and revoke writes the account's audit trail and a `support_access.*` event
 * in the same transaction (root CLAUDE.md rule 2); the operator trail gets its entry from the database (ADR M15-0004).
 */

export interface CustomerAccountDeps {
  readonly db: Database;
  readonly clock?: () => Date;
}

const session = { config: { auth: 'session' as const } };
const ACCOUNT: Resource = { type: 'account', clientId: null };

function toApiError(error: unknown): never {
  if (error instanceof DbError) throw new ApiError(error.code);
  throw error;
}

/** The request's `Idempotency-Key`, a UUID, with a hash of what it was first sent with. */
function keyOf(request: FastifyRequest): { key: string; path: string; hash: string } | undefined {
  const header = request.headers['idempotency-key'];
  if (header === undefined) return undefined;
  const key = z.uuid().safeParse(header);
  if (!key.success) {
    throw new ApiError('VALIDATION', {
      issues: [{ path: ['Idempotency-Key'], message: 'Expected a UUID' }],
    });
  }
  const path = request.url.split('?')[0]!;
  const hash = createHash('sha256')
    .update(JSON.stringify(['POST', path, request.body ?? null]))
    .digest('hex');
  return { key: key.data, path, hash };
}

function replay<T>(record: IdempotencyRecord, keyed: { path: string; hash: string }): T {
  if (record.path !== keyed.path || record.requestHash !== keyed.hash) {
    throw new ApiError('VALIDATION', {
      issues: [
        { path: ['Idempotency-Key'], message: 'This key was already used for a different request' },
      ],
    });
  }
  return record.responseBody as T;
}

export function registerCustomerAccountRoutes(
  app: FastifyInstance,
  deps: CustomerAccountDeps,
): void {
  const { db } = deps;
  const clock = deps.clock ?? (() => new Date());
  const e = ENDPOINTS;

  const inTenant = <T>(ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    db.withTenant(tenantFromRequest(ctx), fn).catch(toApiError);

  /** Fails closed: a person this context cannot read is refused too. */
  async function refuseSupport(tx: TenantTx, ctx: RequestContext, action: string): Promise<void> {
    const person = await people.get(tx, ctx.personId);
    if (!person || person.support) throw new ApiError('FORBIDDEN', { action });
  }

  /** A `support_access.*` event on the account, at the account's current version. */
  async function emit(
    tx: TenantTx,
    ctx: RequestContext,
    type: 'support_access.granted' | 'support_access.revoked',
    data: Record<string, unknown>,
  ) {
    const { version } = await firms.current(tx);
    await domainEvents.enqueue(tx, {
      type,
      clientId: null,
      actor: { kind: 'PERSON', personId: ctx.personId },
      requestId: ctx.requestId,
      aggregate: { type: 'account', id: ctx.firmId },
      aggregateVersion: version,
      data,
    });
  }

  /** The support person's memberships that are still open (a grant's, until it ends). */
  async function openMemberships(tx: TenantTx, personId: string): Promise<Membership[]> {
    return (await memberships.forPerson(tx, personId)).filter((m) => m.archivedAt === null);
  }

  /**
   * One audit entry per membership the grant gave, in the membership's client, so each client's own trail shows
   * PlanetPulse coming in (as the M0 mock does); then `support_access.granted`.
   */
  async function granted(tx: TenantTx, ctx: RequestContext, grant: SupportGrant) {
    for (const m of await openMemberships(tx, grant.supportPersonId)) {
      await auditEvents.append(tx, {
        clientId: m.clientId,
        requestId: ctx.requestId,
        actorId: ctx.personId,
        actorKind: 'PERSON',
        action: 'MEMBERSHIP_CHANGE',
        entityType: 'membership',
        entityId: m.id,
        before: null,
        after: {
          role: m.role,
          expiresAt: grant.endsAt,
          supportGrantId: grant.id,
          level: grant.level,
        },
        reason: 'Support access granted',
      });
    }
    await emit(tx, ctx, 'support_access.granted', {
      grantId: grant.id,
      level: grant.level,
      endsAt: grant.endsAt,
    });
  }

  /** One audit entry per membership the revoke ended (read before it ended them); then `support_access.revoked`. */
  async function revoked(
    tx: TenantTx,
    ctx: RequestContext,
    grant: SupportGrant,
    ended: Membership[],
    reason: string,
  ) {
    for (const m of ended) {
      await auditEvents.append(tx, {
        clientId: m.clientId,
        requestId: ctx.requestId,
        actorId: ctx.personId,
        actorKind: 'PERSON',
        action: 'MEMBERSHIP_CHANGE',
        entityType: 'membership',
        entityId: m.id,
        before: { expiresAt: m.expiresAt },
        after: { expiresAt: grant.revokedAt, supportGrantId: grant.id },
        reason,
      });
    }
    await emit(tx, ctx, 'support_access.revoked', { grantId: grant.id });
  }

  app.get('/account', session, async (request) => {
    authorize(request, 'account.read', ACCOUNT);
    return AccountView.parse(await inTenant(request.ctx, (tx) => account.get(tx)));
  });

  app.get('/account/support-grants', session, async (request) => {
    authorize(request, 'supportGrant.read', ACCOUNT);
    const ctx = request.ctx;
    const items = await inTenant(ctx, async (tx) => {
      await refuseSupport(tx, ctx, 'supportGrant.read');
      return supportGrants.list(tx, clock().toISOString());
    });
    return e.listSupportGrants.response.parse({ items });
  });

  app.post('/account/support-grants', session, async (request, reply) => {
    authorize(request, 'supportGrant.manage', ACCOUNT);
    const ctx = request.ctx;
    const body = e.createSupportGrant.body.parse(request.body);
    const keyed = keyOf(request);
    const run = async (tx: TenantTx): Promise<SupportGrant> => {
      await refuseSupport(tx, ctx, 'supportGrant.manage');
      const now = clock().toISOString();
      const live = await supportGrants.live(tx, now);
      const ending = live ? await openMemberships(tx, live.supportPersonId) : [];
      const { grant, ended } = await supportGrants.create(tx, {
        level: body.level,
        days: body.days,
        grantedById: ctx.personId,
        now,
      });
      if (ended) await revoked(tx, ctx, ended, ending, 'Replaced by a new support grant');
      await granted(tx, ctx, grant);
      return grant;
    };
    const find = (tx: TenantTx) =>
      keyed ? idempotencyKeys.find(tx, ctx.personId, keyed.key, clock()) : Promise.resolve(null);
    let grant: SupportGrant;
    try {
      grant = await inTenant(ctx, async (tx) => {
        const first = await find(tx);
        if (first) return replay<SupportGrant>(first, keyed!);
        const made = await run(tx);
        if (keyed) {
          const at = clock();
          await idempotencyKeys.record(tx, {
            personId: ctx.personId,
            key: keyed.key,
            method: 'POST',
            path: keyed.path,
            requestHash: keyed.hash,
            responseStatus: 201,
            responseBody: JSON.parse(JSON.stringify(made)) as IdempotencyRecord['responseBody'],
            createdAt: at.toISOString(),
            expiresAt: new Date(at.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
          });
        }
        return made;
      });
    } catch (error) {
      // Lost a race to a concurrent request with the same key: answer with the winner's grant.
      if (!keyed) throw error;
      const first = await inTenant(ctx, find);
      if (!first) throw error;
      grant = replay<SupportGrant>(first, keyed);
    }
    return reply.code(201).send(SupportGrant.parse(grant));
  });

  app.post('/account/support-grants/:id/revoke', session, async (request) => {
    authorize(request, 'supportGrant.manage', ACCOUNT);
    const ctx = request.ctx;
    const { id } = IdParams.parse(request.params);
    return SupportGrant.parse(
      await inTenant(ctx, async (tx) => {
        await refuseSupport(tx, ctx, 'supportGrant.manage');
        const now = clock().toISOString();
        const known = (await supportGrants.list(tx, now)).find((g) => g.id === id);
        if (!known) throw new ApiError('NOT_FOUND');
        // Already revoked or run out: nothing to end (409, as the M0 mock answers).
        if (known.status !== 'ACTIVE') throw new ApiError('INVALID_TRANSITION');
        const ending = await openMemberships(tx, known.supportPersonId);
        const { grant } = await supportGrants.revoke(tx, id, ctx.personId, now);
        await revoked(tx, ctx, grant, ending, 'Support access revoked');
        return grant;
      }),
    );
  });
}
