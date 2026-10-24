import { ApiErrorResponse, Membership, Person } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { ACTORS, FIRM_A, ids, membershipId, testApp, uid } from '../entities/testing/world.js';
import { normalizeName, statusForEmail } from './routes.js';

const error = (body: unknown) => ApiErrorResponse.parse(body).error;
const displayNames = (body: unknown) =>
  (body as { items: { displayName: string }[] }).items.map((p) => p.displayName);

describe('names and status', () => {
  it('normalises names for de-duplication', () => {
    expect(normalizeName('  Omar   OWNER\t')).toBe('omar owner');
  });

  it('keeps status in step with email', () => {
    expect(statusForEmail(null, null)).toBe('UNCLAIMED');
    expect(statusForEmail(null, 'a@example.com')).toBe('INVITED');
    expect(statusForEmail({ status: 'INVITED' }, null)).toBe('UNCLAIMED');
    expect(statusForEmail({ status: 'DISABLED' }, null)).toBe('DISABLED');
    expect(statusForEmail({ status: 'ACTIVE' }, 'b@example.com')).toBe('ACTIVE');
    expect(() => statusForEmail({ status: 'ACTIVE' }, null)).toThrow(/cannot be removed/);
  });
});

describe('people', () => {
  it('lists firm staff for firm roles only', async () => {
    const { call } = testApp();
    expect(displayNames((await call('consultant', 'GET', '/people')).body)).toEqual([
      'Asha Admin',
      'Bela Consultant',
      'Cyrus Consultant',
    ]);
    expect((await call('clientAdmin', 'GET', '/people')).status).toBe(403);
  });

  it('lists the people of a client: members, default owners and instance owners', async () => {
    const { call } = testApp();
    const res = await call('viewer', 'GET', `/clients/${ids.clientA}/people?q=omar`);
    expect(displayNames(res.body)).toEqual(['Omar Owner', 'Omar  owner']);
    const b = await call('consultantB', 'GET', `/clients/${ids.clientB}/people`);
    expect(displayNames(b.body)).toEqual(['Arun Approver', 'Bimal Unclaimed']);
  });

  it('adds a person to a client as an unclaimed owner', async () => {
    const { call, store } = testApp();
    const res = await call('clientAdmin', 'POST', `/clients/${ids.clientA}/people`, {
      displayName: 'Neha  Nair',
    });
    const person = Person.parse(res.body);
    expect(person).toMatchObject({ status: 'UNCLAIMED', email: null, nameNormalized: 'neha nair' });
    expect(store.events).toMatchObject([
      {
        type: 'membership.changed',
        data: { personId: person.id, role: 'OWNER', change: 'GRANTED' },
      },
    ]);
    const list = await call('clientAdmin', 'GET', `/clients/${ids.clientA}/people?q=neha`);
    expect(displayNames(list.body)).toEqual(['Neha  Nair']);
  });

  it('refuses a second person with the same email', async () => {
    const { call } = testApp();
    const res = await call('firmAdmin', 'POST', `/clients/${ids.clientA}/people`, {
      displayName: 'Someone',
      email: 'OWNER@example.com',
    });
    expect(error(res.body)).toMatchObject({ code: 'DUPLICATE', details: { field: 'email' } });
  });

  it('makes an unclaimed person ready to invite when an email is added', async () => {
    const { call } = testApp();
    const res = await call('clientAdmin', 'PATCH', `/people/${ids.duplicate}`, {
      version: 1,
      email: 'omar.owner@example.com',
    });
    expect(res.body).toMatchObject({ status: 'INVITED', email: 'omar.owner@example.com' });
  });

  it("does not let a client admin change firm staff or another client's people", async () => {
    const { call } = testApp();
    const staff = await call('clientAdmin', 'PATCH', `/people/${ACTORS.consultant.person}`, {
      version: 1,
      displayName: 'X',
    });
    expect(staff.status).toBe(404);
    const elsewhere = await call('clientAdmin', 'PATCH', `/people/${ids.unclaimed}`, {
      version: 1,
      displayName: 'X',
    });
    expect(elsewhere.status).toBe(404);
  });

  it('merges a duplicate: instances, assignments and memberships move, the duplicate is archived', async () => {
    const { call, store } = testApp();
    const res = await call('clientAdmin', 'POST', `/people/${ACTORS.owner.person}/merge`, {
      version: 1,
      sourceIds: [ids.duplicate],
    });
    expect(res.status).toBe(200);
    expect(store.instance(ids.instanceDup)?.ownerId).toBe(ACTORS.owner.person);
    expect(store.raw('people', ids.duplicate)?.archivedAt).not.toBeNull();
    expect(store.audits.map((a) => a.action)).toEqual(['MERGE_ALIAS', 'REASSIGN', 'MERGE_ALIAS']);
    expect(store.events.map((e) => e.type)).toEqual(['instance.reassigned', 'alias.merged']);
  });

  it('moves default ownership and memberships, ending roles the target already holds', async () => {
    const { call, store } = testApp();
    await call('firmAdmin', 'POST', `/people/${ids.unclaimed}/memberships`, {
      role: 'OWNER',
      clientId: ids.clientB,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: null,
    });
    await call('firmAdmin', 'POST', `/people/${ids.duplicate}/memberships`, {
      role: 'OWNER',
      clientId: ids.clientB,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: null,
    });
    await call('firmAdmin', 'POST', `/people/${ids.duplicate}/memberships`, {
      role: 'VIEWER',
      clientId: ids.clientB,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: '2027-01-01T00:00:00Z',
    });
    const res = await call('firmAdmin', 'POST', `/people/${ids.unclaimed}/merge`, {
      version: 1,
      sourceIds: [ids.duplicate],
    });
    expect(res.status).toBe(200);
    const memberships = (await call('firmAdmin', 'GET', `/people/${ids.unclaimed}/memberships`))
      .body as { items: Membership[] };
    expect(memberships.items.map((m) => m.role).sort()).toEqual(['OWNER', 'VIEWER']);
    expect(store.raw('assignments', ids.assignmentB)?.defaultOwnerId).toBe(ids.unclaimed);
  });

  it('moves a default approver too', async () => {
    const { call, store } = testApp();
    await call('firmAdmin', 'PATCH', `/assignments/${ids.assignment}`, {
      version: 1,
      defaultApproverId: ids.duplicate,
    });
    await call('firmAdmin', 'POST', `/people/${ACTORS.owner.person}/merge`, {
      version: 1,
      sourceIds: [ids.duplicate],
    });
    expect(store.raw('assignments', ids.assignment)?.defaultApproverId).toBe(ACTORS.owner.person);
  });

  it('never merges away someone who has signed in, or a person into themselves', async () => {
    const { call } = testApp();
    const active = await call('firmAdmin', 'POST', `/people/${ids.duplicate}/merge`, {
      version: 1,
      sourceIds: [ACTORS.owner.person],
    });
    expect(active.status).toBe(400);
    const self = await call('firmAdmin', 'POST', `/people/${ids.duplicate}/merge`, {
      version: 1,
      sourceIds: [ids.duplicate],
    });
    expect(self.status).toBe(400);
    const stale = await call('firmAdmin', 'POST', `/people/${ids.duplicate}/merge`, {
      version: 3,
      sourceIds: [ids.unclaimed],
    });
    expect(stale.status).toBe(409);
    const missing = await call('firmAdmin', 'POST', `/people/${ids.duplicate}/merge`, {
      version: 1,
      sourceIds: [ids.clientA],
    });
    expect(missing.status).toBe(404);
  });
});

describe('memberships', () => {
  const grant = (over: Record<string, unknown>) => ({
    role: 'VIEWER',
    clientId: ids.clientA,
    consultantClientIds: null,
    unitIds: null,
    expiresAt: '2027-03-31T00:00:00Z',
    ...over,
  });

  it('lets only a firm admin grant firm roles', async () => {
    const { call } = testApp();
    const firmRole = grant({
      role: 'CONSULTANT',
      clientId: null,
      consultantClientIds: [ids.clientA],
      expiresAt: null,
    });
    const byClientAdmin = await call(
      'clientAdmin',
      'POST',
      `/people/${ACTORS.owner.person}/memberships`,
      firmRole,
    );
    expect(byClientAdmin.status).toBe(403);
    const byConsultant = await call(
      'consultant',
      'POST',
      `/people/${ACTORS.owner.person}/memberships`,
      firmRole,
    );
    expect(byConsultant.status).toBe(403);
    const byAdmin = await call(
      'firmAdmin',
      'POST',
      `/people/${ACTORS.owner.person}/memberships`,
      firmRole,
    );
    expect(byAdmin.status).toBe(201);
  });

  it('limits consultants and client admins to their own clients', async () => {
    const { call } = testApp();
    const res = await call(
      'clientAdmin',
      'POST',
      `/people/${ACTORS.owner.person}/memberships`,
      grant({ clientId: ids.clientB }),
    );
    expect(res.status).toBe(404);
  });

  it('checks the membership shape, units, clients and expiry', async () => {
    const { call } = testApp();
    const url = `/people/${ACTORS.owner.person}/memberships`;
    expect((await call('firmAdmin', 'POST', url, grant({ expiresAt: null }))).status).toBe(400);
    expect(
      (
        await call(
          'firmAdmin',
          'POST',
          url,
          grant({ role: 'APPROVER', unitIds: [ids.unitB], expiresAt: null }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await call('firmAdmin', 'POST', url, grant({ expiresAt: '2020-01-01T00:00:00Z' }))).status,
    ).toBe(400);
    expect(
      (
        await call(
          'firmAdmin',
          'POST',
          url,
          grant({
            role: 'CONSULTANT',
            clientId: null,
            consultantClientIds: [ids.clientX],
            expiresAt: null,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'firmAdmin',
          'POST',
          url,
          grant({ role: 'OWNER', clientId: null, expiresAt: null }),
        )
      ).status,
    ).toBe(400);
  });

  it('refuses a role the person already holds in that client', async () => {
    const { call } = testApp();
    const res = await call(
      'firmAdmin',
      'POST',
      `/people/${ACTORS.owner.person}/memberships`,
      grant({ role: 'OWNER', expiresAt: null }),
    );
    expect(error(res.body)).toMatchObject({
      code: 'DUPLICATE',
      details: { existingId: membershipId('owner') },
    });
  });

  it('shows consultants only the memberships in their clients', async () => {
    const { call } = testApp();
    const own = await call('consultant', 'GET', `/people/${ACTORS.consultant.person}/memberships`);
    expect((own.body as { items: unknown[] }).items).toEqual([]);
    const all = await call('firmAdmin', 'GET', `/people/${ACTORS.consultant.person}/memberships`);
    expect((all.body as { items: unknown[] }).items).toHaveLength(1);
  });

  it('changes scope with the shape re-checked and announces it', async () => {
    const { call, store } = testApp();
    const bad = await call('clientAdmin', 'PATCH', `/memberships/${membershipId('viewer')}`, {
      version: 1,
      unitIds: [ids.unit1],
    });
    expect(bad.status).toBe(400);
    const ok = await call('clientAdmin', 'PATCH', `/memberships/${membershipId('approver')}`, {
      version: 1,
      unitIds: null,
    });
    expect(Membership.parse(ok.body).unitIds).toBeNull();
    expect(store.audits.at(-1)).toMatchObject({ action: 'MEMBERSHIP_CHANGE' });
    expect(store.events.at(-1)).toMatchObject({ data: { change: 'UPDATED' } });
  });

  it('keeps the last firm admin', async () => {
    const { call } = testApp();
    const res = await call(
      'firmAdmin',
      'POST',
      `/memberships/${membershipId('firmAdmin')}/archive`,
      {
        version: 1,
        reason: 'Leaving',
      },
    );
    expect(res.status).toBe(400);
  });

  it('lets a second firm admin end the first one', async () => {
    const { call, store } = testApp();
    await call(
      'firmAdmin',
      'POST',
      `/people/${ACTORS.consultant.person}/memberships`,
      grant({ role: 'FIRM_ADMIN', clientId: null, expiresAt: null }),
    );
    const res = await call(
      'firmAdmin',
      'POST',
      `/memberships/${membershipId('firmAdmin')}/archive`,
      {
        version: 1,
        reason: 'Leaving',
      },
    );
    expect(res.status).toBe(200);
    expect(store.events.at(-1)).toMatchObject({ data: { change: 'REVOKED', role: 'FIRM_ADMIN' } });
  });
});

describe('who may change a person', () => {
  it('keeps a consultant to the clients they are assigned to', async () => {
    const { call, store } = testApp();
    // consultantB works in client B only.
    const takeover = await call('consultantB', 'PATCH', `/people/${ACTORS.firmAdmin.person}`, {
      version: 1,
      email: 'attacker@example.com',
    });
    expect(takeover.status).toBe(403);
    const edit = await call('consultantB', 'PATCH', `/people/${ACTORS.owner.person}`, {
      version: 1,
      displayName: 'X',
    });
    expect(edit.status).toBe(404);
    const merge = await call('consultantB', 'POST', `/people/${ACTORS.owner.person}/merge`, {
      version: 1,
      sourceIds: [ids.duplicate],
    });
    expect(merge.status).toBe(404);
    const steal = await call('consultantB', 'POST', `/people/${ids.unclaimed}/merge`, {
      version: 1,
      sourceIds: [ids.duplicate],
    });
    expect(steal.status).toBe(404);
    const read = await call('consultantB', 'GET', `/people/${ACTORS.owner.person}/memberships`);
    expect(read.status).toBe(404);
    expect(store.audits).toEqual([]);
  });

  it('lets only a firm admin change firm staff', async () => {
    const { call } = testApp();
    const res = await call('consultant', 'PATCH', `/people/${ACTORS.firmAdmin.person}`, {
      version: 1,
      displayName: 'X',
    });
    expect(res.status).toBe(403);
    const own = await call('firmAdmin', 'PATCH', `/people/${ACTORS.consultant.person}`, {
      version: 1,
      displayName: 'Chitra C',
    });
    expect(own.status).toBe(200);
  });

  it('lets only a firm admin change the email of a person who has signed in', async () => {
    const { call } = testApp();
    for (const actor of ['clientAdmin', 'consultant'] as const) {
      const res = await call(actor, 'PATCH', `/people/${ACTORS.owner.person}`, {
        version: 1,
        email: 'someone.else@example.com',
      });
      expect(res.status, actor).toBe(403);
    }
    const rename = await call('clientAdmin', 'PATCH', `/people/${ACTORS.owner.person}`, {
      version: 1,
      displayName: 'Omar O',
    });
    expect(rename.status).toBe(200);
    const admin = await call('firmAdmin', 'PATCH', `/people/${ACTORS.owner.person}`, {
      version: 2,
      email: 'omar.new@example.com',
    });
    expect(Person.parse(admin.body)).toMatchObject({
      email: 'omar.new@example.com',
      status: 'ACTIVE',
    });
  });

  it('refuses a merge that reaches a client the actor does not manage, and changes nothing', async () => {
    const { call, store } = testApp();
    await call('firmAdmin', 'POST', `/people/${ids.duplicate}/memberships`, {
      role: 'OWNER',
      clientId: ids.clientB,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: null,
    });
    const before = store.audits.length;
    const res = await call('clientAdmin', 'POST', `/people/${ACTORS.owner.person}/merge`, {
      version: 1,
      sourceIds: [ids.duplicate],
    });
    expect(res.status).toBe(403);
    expect(store.raw('people', ids.duplicate)?.archivedAt).toBeNull();
    expect(store.audits).toHaveLength(before);
    const firm = await call('firmAdmin', 'POST', `/people/${ACTORS.owner.person}/merge`, {
      version: 1,
      sourceIds: [ids.duplicate],
    });
    expect(firm.status).toBe(200);
  });
});

describe('adding a person to a client', () => {
  it('invites a person created with an email, in the role asked for', async () => {
    const { call, store } = testApp();
    const res = await call('clientAdmin', 'POST', `/clients/${ids.clientA}/people`, {
      displayName: 'Neha Nair',
      email: 'neha@example.com',
      role: 'APPROVER',
    });
    expect(res.status).toBe(201);
    const person = Person.parse(res.body);
    expect(person).toMatchObject({ status: 'INVITED', email: 'neha@example.com' });
    const [membership] = (
      (await call('clientAdmin', 'GET', `/people/${person.id}/memberships`)).body as {
        items: Membership[];
      }
    ).items;
    expect(membership).toMatchObject({ role: 'APPROVER', clientId: ids.clientA, unitIds: null });
    expect(store.events.find((e) => e.type === 'membership.changed')?.data).toMatchObject({
      role: 'APPROVER',
      change: 'GRANTED',
    });
  });

  it('defaults to OWNER and leaves a person without an email unclaimed', async () => {
    const { call } = testApp();
    const res = await call('consultant', 'POST', `/clients/${ids.clientA}/people`, {
      displayName: 'Ravi Rao',
    });
    const person = Person.parse(res.body);
    expect(person.status).toBe('UNCLAIMED');
    const list = await call('consultant', 'GET', `/people/${person.id}/memberships`);
    expect((list.body as { items: Membership[] }).items.map((m) => m.role)).toEqual(['OWNER']);
  });

  it('refuses a role the actor may not grant', async () => {
    const { call } = testApp();
    const res = await call('clientAdmin', 'POST', `/clients/${ids.clientA}/people`, {
      displayName: 'Ravi Rao',
      role: 'FIRM_ADMIN',
    });
    expect(res.status).toBe(400);
  });
});

describe('granting a membership', () => {
  const ownerIn = (clientId: string) => ({
    role: 'OWNER',
    clientId,
    consultantClientIds: null,
    unitIds: null,
    expiresAt: null,
  });

  it('needs the actor to reach the person already', async () => {
    const { call, store } = testApp();
    // consultantB works in client B; the owner belongs to client A only.
    const res = await call(
      'consultantB',
      'POST',
      `/people/${ACTORS.owner.person}/memberships`,
      ownerIn(ids.clientB),
    );
    expect(res.status).toBe(404);
    const listed = await call('consultantB', 'GET', `/clients/${ids.clientB}/people`);
    expect(displayNames(listed.body)).not.toContain(ACTORS.owner.name);
    expect(store.audits).toEqual([]);
  });

  it('gives firm staff client roles from a firm admin only', async () => {
    const { call } = testApp();
    const res = await call(
      'consultantB',
      'POST',
      `/people/${ACTORS.firmAdmin.person}/memberships`,
      {
        ...ownerIn(ids.clientB),
        role: 'CLIENT_ADMIN',
      },
    );
    expect(res.status).toBe(403);
    const admin = await call(
      'firmAdmin',
      'POST',
      `/people/${ACTORS.consultant.person}/memberships`,
      ownerIn(ids.clientB),
    );
    expect(admin.status).toBe(201);
  });

  it('lets a client admin grant another role to their own person', async () => {
    const { call } = testApp();
    const res = await call('clientAdmin', 'POST', `/people/${ACTORS.owner.person}/memberships`, {
      ...ownerIn(ids.clientA),
      role: 'APPROVER',
    });
    expect(res.status).toBe(201);
  });
});

describe("an email already used outside the actor's clients", () => {
  it('is refused without revealing who holds it', async () => {
    const { call } = testApp();
    const held = await call('firmAdmin', 'POST', `/clients/${ids.clientB}/people`, {
      displayName: 'Bina Owner',
      email: 'bina@bharat.example',
    });
    const heldId = (held.body as { id: string }).id;
    const res = await call('clientAdmin', 'POST', `/clients/${ids.clientA}/people`, {
      displayName: 'Bina Again',
      email: 'BINA@bharat.example',
    });
    expect(res.status).toBe(400);
    expect(error(res.body)).toMatchObject({
      code: 'VALIDATION',
      message: "This email can't be used here; ask your account admin.",
      details: { issues: [{ path: ['body', 'email'] }] },
    });
    expect(JSON.stringify(res.body)).not.toContain(heldId);
    const seen = await call('firmAdmin', 'POST', `/clients/${ids.clientA}/people`, {
      displayName: 'Bina Again',
      email: 'bina@bharat.example',
    });
    expect(error(seen.body)).toMatchObject({
      code: 'DUPLICATE',
      details: { field: 'email', existingId: heldId },
    });
  });
});

describe('the PlanetPulse support person', () => {
  const supportId = uid(900);
  const supportMembership = uid(901);
  const AT = '2026-10-01T00:00:00Z';

  /** A support grant at ADMIN level: the support person with a FIRM_ADMIN membership (ADR M15-0001 decision 11). */
  function withSupport() {
    const world = testApp();
    const base = { firmId: FIRM_A, createdAt: AT, updatedAt: AT, archivedAt: null, version: 1 };
    world.store.seed('people', {
      ...base,
      id: supportId,
      displayName: 'PlanetPulse support',
      nameNormalized: 'planetpulse support',
      email: 'support@planetpulse.life',
      status: 'ACTIVE',
      support: true,
    });
    world.store.seed('memberships', {
      ...base,
      id: supportMembership,
      personId: supportId,
      role: 'FIRM_ADMIN',
      clientId: null,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: '2026-10-19T00:00:00Z',
    });
    return world;
  }
  const refused = (res: { status: number; body: unknown }, action: string) => {
    expect(res.status).toBe(403);
    expect(error(res.body)).toMatchObject({ code: 'FORBIDDEN', details: { action } });
  };

  it('cannot be renamed, given another email or disabled', async () => {
    const { call, store } = withSupport();
    for (const patch of [
      { displayName: 'Someone else' },
      { email: 'mine@kestrel-metals.example' },
      { email: null },
    ]) {
      refused(
        await call('firmAdmin', 'PATCH', `/people/${supportId}`, { version: 1, ...patch }),
        'person.write',
      );
    }
    expect(store.raw('people', supportId)).toMatchObject({
      displayName: 'PlanetPulse support',
      version: 1,
    });
    expect(store.audits).toEqual([]);
  });

  it('is never merged, into or away', async () => {
    const { call } = withSupport();
    refused(
      await call('firmAdmin', 'POST', `/people/${ACTORS.firmAdmin.person}/merge`, {
        version: 1,
        sourceIds: [supportId],
      }),
      'person.write',
    );
    refused(
      await call('firmAdmin', 'POST', `/people/${supportId}/merge`, {
        version: 1,
        sourceIds: [ids.duplicate],
      }),
      'person.write',
    );
  });

  it('gets no membership, and keeps the ones its grant gave', async () => {
    const { call, store } = withSupport();
    refused(
      await call('firmAdmin', 'POST', `/people/${supportId}/memberships`, {
        role: 'OWNER',
        clientId: ids.clientA,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: null,
      }),
      'membership.write',
    );
    refused(
      await call('firmAdmin', 'PATCH', `/memberships/${supportMembership}`, {
        version: 1,
        expiresAt: '2027-01-01T00:00:00Z',
      }),
      'membership.write',
    );
    refused(
      await call('firmAdmin', 'POST', `/memberships/${supportMembership}/archive`, {
        version: 1,
        reason: 'Not needed',
      }),
      'membership.write',
    );
    expect(store.raw('memberships', supportMembership)).toMatchObject({
      archivedAt: null,
      version: 1,
    });
    expect(store.events).toEqual([]);
  });

  it('does not count as the firm’s last admin', async () => {
    const { call } = withSupport();
    const res = await call(
      'firmAdmin',
      'POST',
      `/memberships/${membershipId('firmAdmin')}/archive`,
      {
        version: 1,
        reason: 'Leaving',
      },
    );
    expect(res.status).toBe(400);
    expect(error(res.body).message).toMatch(/at least one firm admin/);
  });

  it('keeps a READ_ONLY grant as made: client roles cannot change or re-grant its VIEWER membership', async () => {
    const world = testApp();
    const base = { firmId: FIRM_A, createdAt: AT, updatedAt: AT, archivedAt: null, version: 1 };
    world.store.seed('people', {
      ...base,
      id: supportId,
      displayName: 'PlanetPulse support',
      nameNormalized: 'planetpulse support',
      email: 'support@planetpulse.life',
      status: 'ACTIVE',
      support: true,
    });
    world.store.seed('memberships', {
      ...base,
      id: supportMembership,
      personId: supportId,
      role: 'VIEWER',
      clientId: ids.clientA,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: '2026-10-19T00:00:00Z',
    });
    const { call, store } = world;
    refused(
      await call('clientAdmin', 'PATCH', `/memberships/${supportMembership}`, {
        version: 1,
        expiresAt: '2027-01-01T00:00:00Z',
      }),
      'membership.write',
    );
    for (const actor of ['clientAdmin', 'consultant'] as const) {
      refused(
        await call(actor, 'POST', `/memberships/${supportMembership}/archive`, {
          version: 1,
          reason: 'Not needed',
        }),
        'membership.write',
      );
    }
    refused(
      await call('clientAdmin', 'POST', `/people/${supportId}/memberships`, {
        role: 'APPROVER',
        clientId: ids.clientA,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: null,
      }),
      'membership.write',
    );
    refused(
      await call('clientAdmin', 'PATCH', `/people/${supportId}`, {
        version: 1,
        displayName: 'Someone else',
      }),
      'person.write',
    );
    expect(store.raw('memberships', supportMembership)).toMatchObject({
      archivedAt: null,
      expiresAt: '2026-10-19T00:00:00Z',
      version: 1,
    });
    expect(store.audits).toEqual([]);
  });

  it('refuses a membership change when the member cannot be read', async () => {
    const world = testApp();
    const orphan = uid(902);
    world.store.seed('memberships', {
      firmId: FIRM_A,
      createdAt: AT,
      updatedAt: AT,
      archivedAt: null,
      version: 1,
      id: orphan,
      personId: uid(903),
      role: 'VIEWER',
      clientId: ids.clientA,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: null,
    });
    refused(
      await world.call('firmAdmin', 'POST', `/memberships/${orphan}/archive`, {
        version: 1,
        reason: 'Not needed',
      }),
      'membership.write',
    );
    refused(
      await world.call('firmAdmin', 'PATCH', `/memberships/${orphan}`, {
        version: 1,
        expiresAt: '2027-01-01T00:00:00Z',
      }),
      'membership.write',
    );
  });

  it('is still listed with the firm’s staff, marked as support', async () => {
    const { call } = withSupport();
    const res = await call('firmAdmin', 'GET', '/people?q=planetpulse');
    expect((res.body as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ id: supportId, support: true }),
    ]);
  });
});
