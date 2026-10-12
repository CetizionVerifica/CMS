import { ApiErrorResponse, Membership, Person } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { ACTORS, ids, membershipId, testApp } from '../entities/testing/world.js';
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
