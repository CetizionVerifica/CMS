// M5 endpoints: sign-in, MFA, `GET /me` and invites. Any password of valid length signs in an ACTIVE person, and
// any six-digit code passes MFA. Magic links and invites go to the outbox (`GET /__mock/outbox`).
import type { z } from 'zod';
import type { Me } from '../../api/auth.js';
import {
  type Actor,
  actorFor,
  audit,
  type Clock,
  fresh,
  membershipsFor,
  MockError,
  notFound,
  visibleClientIds,
} from '../core.js';
import { actorOf, type HandlerContext, type PartialHandlers } from '../handler.js';
import {
  type FirmState,
  isFirmRole,
  type MockStore,
  type PersonRecord,
  type Session,
} from '../store.js';

const INVITE_DAYS = 7;

const pad = (n: number) => String(n).padStart(2, '0');

/** The FY label ("2024-25") containing `date` for an FY starting in `startMonth`. */
function fyOf(date: string, startMonth: number): string {
  const year = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= startMonth ? year : year - 1;
  return `${start}-${pad((start + 1) % 100)}`;
}

/** One client for the switcher and period picker (README decision 26), worked out from the fixture rows. */
function clientSummary(actor: Actor, client: FirmState['data']['clients'][number], today: string) {
  const startMonth = client.settings.fyStartMonth;
  const month = Number(today.slice(5, 7));
  const current = {
    fy: fyOf(today, startMonth),
    quarter: Math.floor(((month - startMonth + 12) % 12) / 3) + 1,
  };
  const instances = actor.firm.data.instances.filter((i) => i.clientId === client.id);
  const fys = new Set([current.fy, ...instances.map((i) => fyOf(i.periodStart, startMonth))]);
  const lastEnd = instances.reduce<string | null>(
    (last, i) => (last === null || i.periodEnd > last ? i.periodEnd : last),
    null,
  );
  const live = actor.firm.data.units.filter(
    (u) => u.clientId === client.id && u.archivedAt === null,
  );
  const scoped = membershipsFor(actor, client.id);
  const allUnits = scoped.some((m) => isFirmRole(m.role) || m.unitIds === null);
  const unitIds = new Set(scoped.flatMap((m) => m.unitIds ?? []));
  return {
    id: client.id,
    name: client.name,
    fyStartMonth: startMonth,
    timeZone: client.settings.timeZone,
    unitCount: allUnits ? live.length : live.filter((u) => unitIds.has(u.id)).length,
    period: {
      current,
      availableFys: [...fys].sort(),
      availableUntil: lastEnd === null ? null : lastEnd.slice(0, 7),
    },
  };
}

function me(
  firm: FirmState,
  person: PersonRecord,
  session: Session,
  clock: Clock,
): z.input<typeof Me> {
  const actor = actorFor(firm, session, person, clock.now());
  const clientIds = visibleClientIds(actor);
  const firmRole = actor.memberships.some((m) => isFirmRole(m.role));
  return {
    person,
    memberships: actor.memberships,
    clients: firm.data.clients
      .filter((c) => clientIds.includes(c.id))
      .map((c) => clientSummary(actor, c, clock.today())),
    csrfToken: session.csrfToken,
    // Firm-role people in the fixtures count as enrolled, so sign-in goes straight to the code step.
    mfa: { required: firmRole, enrolled: firmRole, satisfied: session.mfaSatisfied },
  };
}

function signIn(
  ctx: HandlerContext<'login' | 'verifyMagicLink' | 'acceptInvite'>,
  firm: FirmState,
  person: PersonRecord,
): z.input<typeof Me> {
  const session = ctx.store.openSession(firm.data.firm.id, person.id, false, ctx.clock.now());
  ctx.setSession(session);
  return me(firm, person, session, ctx.clock);
}

function findInvite(store: MockStore, token: string, now: string) {
  for (const firm of store.firms) {
    const invite = firm.invites.find((i) => i.token === token);
    if (invite?.status === 'PENDING' && invite.linkExpiresAt > now) return { firm, invite };
  }
  throw notFound();
}

const addDays = (instant: string, days: number) =>
  new Date(Date.parse(instant) + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const authHandlers: PartialHandlers<
  | 'login'
  | 'requestMagicLink'
  | 'verifyMagicLink'
  | 'logout'
  | 'enrollMfa'
  | 'verifyMfa'
  | 'getMe'
  | 'createInvite'
  | 'getInvite'
  | 'acceptInvite'
  | 'revokeInvite'
> = {
  login(ctx) {
    const match = ctx.store.findByEmail(ctx.body.email).find((m) => m.person.status === 'ACTIVE');
    if (match === undefined) throw new MockError('UNAUTHENTICATED', 'Email or password is wrong');
    return signIn(ctx, match.firm, match.person);
  },

  requestMagicLink(ctx) {
    // Always 202, so the response never reveals whether the email exists.
    const match = ctx.store.findByEmail(ctx.body.email).find((m) => m.person.status === 'ACTIVE');
    if (match !== undefined) {
      const token = ctx.store.token('magic');
      ctx.store.magicLinks.set(token, {
        firmId: match.firm.data.firm.id,
        personId: match.person.id,
      });
      ctx.store.outbox.push({ to: ctx.body.email, kind: 'MAGIC_LINK', token, at: ctx.clock.now() });
    }
    return null;
  },

  verifyMagicLink(ctx) {
    const link = ctx.store.magicLinks.get(ctx.body.token);
    if (link === undefined) throw new MockError('UNAUTHENTICATED', 'This link is invalid or used');
    ctx.store.magicLinks.delete(ctx.body.token);
    const found = ctx.store.findPerson(link.personId);
    if (found === undefined) throw new MockError('UNAUTHENTICATED', 'This link is invalid or used');
    return signIn(ctx, found.firm, found.person);
  },

  logout(ctx) {
    ctx.store.sessions.delete(actorOf(ctx).session.id);
    ctx.setSession(null);
    return null;
  },

  enrollMfa(ctx) {
    const actor = actorOf(ctx);
    const label = encodeURIComponent(`Canopy:${actor.person.email ?? actor.person.displayName}`);
    return { otpauthUrl: `otpauth://totp/${label}?secret=JBSWY3DPEHPK3PXP&issuer=Canopy` };
  },

  verifyMfa(ctx) {
    const actor = actorOf(ctx);
    actor.session.mfaSatisfied = true;
    return me(actor.firm, actor.person, actor.session, ctx.clock);
  },

  getMe(ctx) {
    const actor = actorOf(ctx);
    return me(actor.firm, actor.person, actor.session, ctx.clock);
  },

  createInvite(ctx) {
    const actor = actorOf(ctx);
    const body = ctx.body;
    ctx.authorize({ clientId: body.clientId });
    if (isFirmRole(body.role) && !actor.memberships.some((m) => m.role === 'FIRM_ADMIN')) {
      throw new MockError('FORBIDDEN', 'Only a firm admin invites firm roles', {
        action: 'invite.create',
      });
    }
    const people = actor.firm.data.people;
    const sameEmail = people.find(
      (p) => p.email?.toLowerCase() === body.email.toLowerCase() && p.id !== body.personId,
    );
    if (sameEmail !== undefined) {
      throw new MockError('DUPLICATE', 'Someone already has this email', {
        field: 'email',
        existingId: sameEmail.id,
      });
    }
    let person: PersonRecord;
    if (body.personId !== undefined) {
      const existing = people.find((p) => p.id === body.personId && p.archivedAt === null);
      if (existing === undefined) throw notFound();
      if (existing.status === 'ACTIVE') {
        throw new MockError('DUPLICATE', 'This person already has an account', {
          field: 'personId',
          existingId: existing.id,
        });
      }
      person = existing;
    } else {
      const displayName = body.displayName!;
      person = {
        ...fresh(ctx, actor.firm.data.firm.id),
        displayName,
        nameNormalized: displayName.toLowerCase().replace(/\s+/g, ' '),
        email: null,
        status: 'UNCLAIMED',
      };
      people.push(person);
    }
    Object.assign(person, { email: body.email, status: 'INVITED', updatedAt: ctx.clock.now() });
    const token = ctx.store.token('invite');
    const now = ctx.clock.now();
    const invite = {
      id: ctx.store.newId(),
      firmId: actor.firm.data.firm.id,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      personId: person.id,
      email: body.email,
      role: body.role,
      clientId: body.clientId,
      consultantClientIds: body.consultantClientIds,
      unitIds: body.unitIds,
      expiresAt: body.expiresAt,
      status: 'PENDING' as const,
      invitedById: actor.person.id,
      linkExpiresAt: addDays(now, INVITE_DAYS),
    };
    actor.firm.invites.push({ ...invite, token });
    ctx.store.outbox.push({ to: body.email, kind: 'INVITE', token, at: now });
    audit(ctx, actor, {
      action: 'MEMBERSHIP_CHANGE',
      entityType: 'person',
      entityId: person.id,
      clientId: body.clientId,
      after: { invitedRole: body.role, status: 'INVITED' },
    });
    return invite;
  },

  getInvite(ctx) {
    const { firm, invite } = findInvite(ctx.store, ctx.params.token!, ctx.clock.now());
    const person = firm.data.people.find((p) => p.id === invite.personId)!;
    return {
      email: invite.email,
      displayName: person.displayName,
      firmName: firm.data.firm.name,
      clientName: firm.data.clients.find((c) => c.id === invite.clientId)?.name ?? null,
      role: invite.role,
      linkExpiresAt: invite.linkExpiresAt,
    };
  },

  acceptInvite(ctx) {
    const { firm, invite } = findInvite(ctx.store, ctx.params.token!, ctx.clock.now());
    const person = firm.data.people.find((p) => p.id === invite.personId)!;
    const now = ctx.clock.now();
    Object.assign(person, {
      status: 'ACTIVE',
      email: invite.email,
      displayName: ctx.body.displayName ?? person.displayName,
      updatedAt: now,
    });
    firm.data.memberships.push({
      ...fresh(ctx, firm.data.firm.id),
      personId: person.id,
      role: invite.role,
      clientId: invite.clientId,
      consultantClientIds: invite.consultantClientIds,
      unitIds: invite.unitIds,
      expiresAt: invite.expiresAt,
    });
    Object.assign(invite, { status: 'ACCEPTED', updatedAt: now });
    return signIn(ctx, firm, person);
  },

  revokeInvite(ctx) {
    const actor = actorOf(ctx);
    const invite = actor.firm.invites.find((i) => i.id === ctx.params.id);
    if (invite === undefined) throw notFound();
    ctx.authorize({ clientId: invite.clientId });
    if (invite.status === 'PENDING') {
      Object.assign(invite, { status: 'REVOKED', updatedAt: ctx.clock.now() });
    }
    const view: Partial<typeof invite> = { ...invite };
    delete view.token;
    return view as Omit<typeof invite, 'token'>;
  },
};
