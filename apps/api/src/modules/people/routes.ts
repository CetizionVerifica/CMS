import {
  ENDPOINTS,
  FIRM_ROLES,
  Membership,
  type Id,
  type MembershipGrant,
  type Person,
  type RequestContext,
  type Role,
} from '@canopy/contracts';
import type { FastifyInstance } from 'fastify';
import { canGrantRole } from '../../auth/index.js';
import { canSeeClient, hasRole, isFirmStaff } from '../entities/http/access.js';
import { duplicate, forbidden, HttpError, invalid, notFound } from '../entities/http/errors.js';
import { pageOf } from '../entities/http/page.js';
import { mount, type Call, type M6Deps } from '../entities/http/route.js';
import { emit } from '../entities/events.js';
import type { PersonReach, Tx } from '../entities/store.js';
import { auditedInsert, auditedUpdate, getLive, instantOf } from '../entities/write.js';
import { replacePersonEverywhere } from './merge.js';

/** People and memberships (docs/contracts/endpoints.md §3). */

const firmRoles: readonly Role[] = FIRM_ROLES;

/** Lower case with whitespace collapsed: the per-firm dedupe key (domain-model.md §3). */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A person's status follows their email (README decision 10): adding an email to an UNCLAIMED person makes them
 * INVITED (ready for M5 to send the invite); removing it from an INVITED person makes them UNCLAIMED again.
 */
export function statusForEmail(person: Pick<Person, 'status'> | null, email: string | null) {
  const current = person?.status ?? 'UNCLAIMED';
  if (current === 'UNCLAIMED' && email !== null) return 'INVITED';
  if (current === 'INVITED' && email === null) return 'UNCLAIMED';
  if (current === 'ACTIVE' && email === null) {
    throw invalid('An active person signs in with their email; it cannot be removed.', [
      'body',
      'email',
    ]);
  }
  return current;
}

type PersonCall = Pick<Call<never>, 'ctx' | 'authorize'>;

/**
 * The PlanetPulse support person comes and goes with a support grant (ADR M15-0001 decision 11): no people or
 * membership route edits, merges, disables or re-grants them. The database refuses it too (ADR M3-0002 decision 7);
 * this answers the contract error first.
 */
export function refuseSupportPerson(
  person: Pick<Person, 'support'> | null | undefined,
  type: 'person' | 'membership',
): void {
  if (person?.support) {
    throw new HttpError(
      'FORBIDDEN',
      'PlanetPulse support access is managed under Account, Support access.',
      { action: `${type}.write` },
    );
  }
}

/**
 * Refuses a change to a membership of the support person. Fails closed: a membership whose person this context
 * cannot read is refused too, so the check never depends on what the context happens to see.
 */
async function refuseSupportMembership(tx: Tx, personId: Id): Promise<void> {
  const person = await tx.people.get(personId);
  if (!person) throw forbidden('membership.write');
  refuseSupportPerson(person, 'membership');
}

/**
 * Checks a route on one person (endpoints.md §3). A firm admin reaches everyone. Anyone else, consultants included,
 * reaches only people of the clients they work in; firm staff (people holding a firm role) are changed by a firm admin
 * alone. A write must stay inside the actor's clients, because a person shared with another client is that client's
 * person too. A person the actor cannot see is 404. Returns the person's reach, or null for a firm admin; its client ids
 * may include clients the actor cannot see, so they decide and are never returned.
 */
async function authorizePerson(
  tx: Tx,
  call: PersonCall,
  type: 'person' | 'membership',
  personId: Id,
  access: 'read' | 'write',
): Promise<PersonReach | null> {
  const { ctx } = call;
  if (hasRole(ctx, 'FIRM_ADMIN')) {
    call.authorize({ type, clientId: null });
    return null;
  }
  const reach = await tx.personReach(personId);
  if (reach.firmStaff) {
    // Consultants list firm staff, so they may read them, but never change them.
    if (!isFirmStaff(ctx)) throw notFound();
    if (access === 'write') throw forbidden(`${type}.write`);
    call.authorize({ type, clientId: null });
    return reach;
  }
  const mine = reach.clientIds.filter((clientId) => ctx.clientIds.includes(clientId));
  if (mine.length === 0) throw notFound();
  if (access === 'write' && mine.length < reach.clientIds.length) {
    throw new HttpError('FORBIDDEN', 'This person also belongs to a client you do not manage.', {
      action: `${type}.write`,
    });
  }
  for (const clientId of mine) call.authorize({ type, clientId });
  return reach;
}

export function peopleRoutes(app: FastifyInstance, deps: M6Deps): void {
  const { store } = deps;
  const clock = () => (deps.now ?? (() => new Date()))();

  /**
   * Who may grant, change or end a membership with this role and client (endpoints.md §3): firm roles only a firm
   * admin; client roles a firm admin, a consultant of that client or a client admin of that client.
   */
  function authorizeMembership(
    call: { authorize: (r: { type: 'membership'; clientId: Id | null }) => Role[] },
    ctx: RequestContext,
    role: Role,
    clientId: Id | null,
  ) {
    if (firmRoles.includes(role)) {
      call.authorize({ type: 'membership', clientId: null });
      if (!hasRole(ctx, 'FIRM_ADMIN')) throw forbidden('membership.write');
      return;
    }
    if (clientId === null) throw invalid(`${role} is a client role; clientId is required`);
    call.authorize({ type: 'membership', clientId });
  }

  /** Checks a membership's references: clients and units exist, a viewer's access ends in the future. */
  async function checkGrant(tx: Tx, grant: MembershipGrant) {
    const clientIds = [
      ...(grant.clientId === null ? [] : [grant.clientId]),
      ...(grant.consultantClientIds ?? []),
    ];
    for (const id of clientIds) {
      const client = await tx.clients.get(id);
      if (!client || client.archivedAt !== null) {
        throw invalid('Unknown client.', ['body', 'clientId']);
      }
    }
    for (const id of grant.unitIds ?? []) {
      const unit = await tx.units.get(id);
      if (!unit || unit.archivedAt !== null || unit.clientId !== grant.clientId) {
        throw invalid('Unknown unit for this client.', ['body', 'unitIds']);
      }
    }
    if (grant.expiresAt !== null && grant.expiresAt <= instantOf(clock())) {
      throw invalid('expiresAt must be in the future.', ['body', 'expiresAt']);
    }
  }

  function membershipEvent(
    tx: Tx,
    m: Membership,
    change: 'GRANTED' | 'UPDATED' | 'REVOKED',
  ): Promise<void> {
    return emit(
      tx,
      {
        type: 'membership.changed',
        data: {
          membershipId: m.id,
          personId: m.personId,
          role: m.role,
          clientId: m.clientId,
          change,
        },
      },
      { type: 'membership', id: m.id, version: m.version },
      m.clientId,
    );
  }

  // ---------- people ----------

  mount(app, deps, ENDPOINTS.listFirmPeople, async (call) => {
    call.authorize({ type: 'person', clientId: null });
    return store.transaction(call.ctx, async (tx) =>
      pageOf(tx.people, call.query, {
        orderBy: 'nameNormalized',
        where: { id: await tx.firmStaffIds() },
        ...(call.query.q
          ? { search: { text: call.query.q, fields: ['displayName', 'email'] as const } }
          : {}),
      }),
    );
  });

  mount(app, deps, ENDPOINTS.listClientPeople, async (call) => {
    const clientId = call.params.clientId as Id;
    call.authorize({ type: 'person', clientId });
    return store.transaction(call.ctx, async (tx) => {
      await getLive(tx.clients, clientId);
      return pageOf(tx.people, call.query, {
        orderBy: 'nameNormalized',
        where: { id: await tx.clientPersonIds(clientId) },
        ...(call.query.q
          ? { search: { text: call.query.q, fields: ['displayName', 'email'] as const } }
          : {}),
      });
    });
  });

  mount(app, deps, ENDPOINTS.createClientPerson, async (call) => {
    const clientId = call.params.clientId as Id;
    call.authorize({ type: 'person', clientId });
    const { body, ctx } = call;
    if (!canGrantRole(ctx, body.role, clientId)) throw forbidden('membership.write');
    return store.transaction(ctx, async (tx) => {
      await getLive(tx.clients, clientId);
      const values = {
        displayName: body.displayName,
        nameNormalized: normalizeName(body.displayName),
        email: body.email,
        status: statusForEmail(null, body.email),
      };
      // A person belongs to a client through a membership (ADR 0006): the role asked for (OWNER by default, the role
      // imported people have) on every unit; PATCH /memberships/{id} narrows the units.
      const grant = {
        role: body.role,
        clientId,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: null,
      };
      const { person, membership } = await tx.createPersonInClient(values, grant);
      for (const [entityType, entityId, after] of [
        ['person', person.id, values],
        ['membership', membership.id, { personId: person.id, ...grant }],
      ] as const) {
        await tx.audit({
          clientId,
          action: 'CREATE',
          entityType,
          entityId,
          before: null,
          after: { ...after },
        });
      }
      await membershipEvent(tx, membership, 'GRANTED');
      return person;
    });
  });

  mount(app, deps, ENDPOINTS.updatePerson, async (call) => {
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.people, call.params.id as Id);
      await authorizePerson(tx, call, 'person', row.id, 'write');
      refuseSupportPerson(row, 'person');
      const email = body.email === undefined ? row.email : body.email;
      // An active person signs in with their email, so changing it hands over the account: firm admins only.
      if (row.status === 'ACTIVE' && email !== row.email && !hasRole(call.ctx, 'FIRM_ADMIN')) {
        throw new HttpError(
          'FORBIDDEN',
          'Only a firm admin can change the email of a person who has signed in.',
          {
            action: 'person.write',
          },
        );
      }
      return auditedUpdate({
        tx,
        repo: tx.people,
        entityType: 'person',
        row,
        version: body.version,
        patch: {
          displayName: body.displayName,
          nameNormalized:
            body.displayName === undefined ? undefined : normalizeName(body.displayName),
          email: body.email,
          status: statusForEmail(row, email),
        },
        clientId: null,
      });
    });
  });

  mount(app, deps, ENDPOINTS.mergePeople, async (call) => {
    const { body, ctx } = call;
    return store.transaction(ctx, async (tx) => {
      const target = await getLive(tx.people, call.params.id as Id);
      // Every person involved must be within the actor's reach, so no other client's rows are left on an archived
      // source.
      for (const id of [target.id, ...body.sourceIds]) {
        const person = id === target.id ? target : await getLive(tx.people, id);
        await authorizePerson(tx, call, 'person', id, 'write');
        refuseSupportPerson(person, 'person');
      }
      return replacePersonEverywhere({
        tx,
        target,
        version: body.version,
        sourceIds: body.sourceIds,
        now: clock(),
      });
    });
  });

  // ---------- memberships ----------

  mount(app, deps, ENDPOINTS.listMemberships, async (call) => {
    const { ctx } = call;
    return store.transaction(ctx, async (tx) => {
      const person = await getLive(tx.people, call.params.id as Id);
      await authorizePerson(tx, call, 'membership', person.id, 'read');
      const all = await tx.memberships.findAll({ personId: person.id });
      // Consultants and client admins see the memberships of their clients only.
      const items = hasRole(ctx, 'FIRM_ADMIN')
        ? all
        : all.filter((m) => m.clientId !== null && canSeeClient(ctx, m.clientId));
      return { items };
    });
  });

  mount(app, deps, ENDPOINTS.createMembership, async (call) => {
    const { body, ctx } = call;
    authorizeMembership(call, ctx, body.role, body.clientId);
    return store.transaction(ctx, async (tx) => {
      const person = await getLive(tx.people, call.params.id as Id);
      // A grant links the person to another client, so the actor must already reach them; and firm staff take client
      // roles from a firm admin only.
      const reach = await authorizePerson(tx, call, 'membership', person.id, 'read');
      if (reach !== null && reach.firmStaff) throw forbidden('membership.write');
      refuseSupportPerson(person, 'membership');
      await checkGrant(tx, body);
      const existing = (await tx.memberships.findAll({ personId: person.id })).find(
        (m) => m.role === body.role && m.clientId === body.clientId,
      );
      if (existing) throw duplicate('role', existing.id);
      const membership = await auditedInsert(
        tx,
        tx.memberships,
        'membership',
        { personId: person.id, ...body },
        (m) => m.clientId,
      );
      await membershipEvent(tx, membership, 'GRANTED');
      return membership;
    });
  });

  mount(app, deps, ENDPOINTS.updateMembership, async (call) => {
    const { body, ctx } = call;
    return store.transaction(ctx, async (tx) => {
      const row = await getLive(tx.memberships, call.params.id as Id);
      authorizeMembership(call, ctx, row.role, row.clientId);
      await refuseSupportMembership(tx, row.personId);
      const patch = {
        consultantClientIds: body.consultantClientIds,
        unitIds: body.unitIds,
        expiresAt: body.expiresAt,
      };
      const next = { ...row, ...definedOnly(patch) };
      const shape = Membership.safeParse(next);
      if (!shape.success) {
        throw invalid(shape.error.issues[0]?.message ?? 'Invalid membership', ['body']);
      }
      // Only a changed expiry has to lie in the future.
      await checkGrant(tx, {
        ...next,
        expiresAt: body.expiresAt === undefined ? null : next.expiresAt,
      });
      const membership = await auditedUpdate({
        tx,
        repo: tx.memberships,
        entityType: 'membership',
        row,
        version: body.version,
        patch,
        clientId: row.clientId,
        action: 'MEMBERSHIP_CHANGE',
      });
      if (membership !== row) await membershipEvent(tx, membership, 'UPDATED');
      return membership;
    });
  });

  mount(app, deps, ENDPOINTS.archiveMembership, async (call) => {
    const { body, ctx } = call;
    return store.transaction(ctx, async (tx) => {
      const row = await getLive(tx.memberships, call.params.id as Id);
      authorizeMembership(call, ctx, row.role, row.clientId);
      await refuseSupportMembership(tx, row.personId);
      if (row.role === 'FIRM_ADMIN') {
        // The support person's FIRM_ADMIN membership ends with its grant, so it never counts as an admin; nor does
        // one whose person this context cannot read.
        const admins = [];
        for (const m of await tx.memberships.findAll({ role: 'FIRM_ADMIN' })) {
          const person = await tx.people.get(m.personId);
          if (person && !person.support) admins.push(m);
        }
        if (admins.length <= 1) {
          throw invalid('The firm needs at least one firm admin.', ['params', 'id']);
        }
      }
      const membership = await auditedUpdate({
        tx,
        repo: tx.memberships,
        entityType: 'membership',
        row,
        version: body.version,
        patch: { archivedAt: instantOf(clock()) },
        clientId: row.clientId,
        action: 'MEMBERSHIP_CHANGE',
        reason: body.reason,
      });
      await membershipEvent(tx, membership, 'REVOKED');
      return membership;
    });
  });
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
