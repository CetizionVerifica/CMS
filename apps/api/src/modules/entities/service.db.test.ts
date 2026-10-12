import {
  ApiErrorResponse,
  DEFAULT_CLIENT_SETTINGS,
  type ComplianceInstance,
  type Id,
  type Role,
} from '@canopy/contracts';
import * as r from '@canopy/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import { PostgresStore } from './service.js';
import { createTestDatabase, type TestDatabase } from './testing/postgres.js';

// The M6 routes on the Postgres store, under row-level security (CI `db` job). Skipped when DATABASE_URL is not set.
const url = process.env.DATABASE_URL;

const NOW = new Date('2026-10-12T06:30:00Z');
const error = (body: unknown) => ApiErrorResponse.parse(body).error;

type Actor = 'firmAdmin' | 'consultant' | 'clientAdmin' | 'otherFirmAdmin';

interface World {
  firmA: Id;
  firmB: Id;
  clientA: Id;
  clientB: Id;
  clientX: Id;
  companyA: Id;
  unitA: Id;
  locationId: Id;
  hr: Id;
  owner: Id;
  approver: Id;
  bina: Id;
  act: Id;
  category: Id;
  obligation: Id;
  obligationFree: Id;
  assignment: Id;
  instance: Id;
  people: Record<Actor, Id>;
}

describe.skipIf(!url)('M6 on the Postgres store', () => {
  let t: TestDatabase;
  let w: World;
  let app: FastifyInstance;
  let store: PostgresStore;
  const sessions = {} as Record<Actor, Record<string, string>>;
  let auth: ReturnType<typeof createTestAuth>;
  let signIn: (actor: Actor, firmId: Id, membership: object, firmClientIds: Id[]) => void;

  /** M5 loads a firm admin's clients per request; the test auth store fixes them at sign-in. */
  async function refreshFirmAdmin() {
    const all = await system(w.firmA, (tx) => r.clients.findAll(tx, {}));
    signIn(
      'firmAdmin',
      w.firmA,
      { role: 'FIRM_ADMIN', clientId: null },
      all.map((c) => c.id),
    );
  }

  const system = <T>(firmId: Id, fn: (tx: r.TenantTx) => Promise<T>) =>
    t.db.withTenant(r.systemContext(firmId, 'm6-db-test'), fn);

  async function call(actor: Actor, method: string, path: string, body?: unknown) {
    const res = await app.inject({
      method: method as 'GET',
      url: `/api/v1${path}`,
      headers: sessions[actor],
      ...(body === undefined ? {} : { payload: body as object }),
    });
    return { status: res.statusCode, body: res.body === '' ? null : res.json() };
  }

  const audits = (firmId: Id, entityType: 'client' | 'person' | 'department', id: Id) =>
    system(firmId, (tx) => r.auditEvents.forEntity(tx, entityType, id));

  beforeAll(async () => {
    t = await createTestDatabase(url!);
    const firmA = await t.admin.createFirm({ name: 'Demo Advisory' });
    const firmB = await t.admin.createFirm({ name: 'Second Ledger Consulting' });
    const person = (tx: r.TenantTx, displayName: string, email: string | null) =>
      r.people.create(tx, {
        displayName,
        nameNormalized: displayName.toLowerCase(),
        email,
        status: email === null ? 'UNCLAIMED' : 'ACTIVE',
      });
    const grant = (
      tx: r.TenantTx,
      personId: Id,
      role: Role,
      clientId: Id | null,
      consultantClientIds: Id[] | null = null,
    ) =>
      r.memberships.create(tx, {
        personId,
        role,
        clientId,
        consultantClientIds,
        unitIds: null,
        expiresAt: null,
      });

    w = await system(firmA, async (tx) => {
      const clientA = await r.clients.create(tx, {
        name: 'Kestrel Metals Group',
        settings: DEFAULT_CLIENT_SETTINGS,
      });
      const clientB = await r.clients.create(tx, {
        name: 'Bharat Mills',
        settings: DEFAULT_CLIENT_SETTINGS,
      });
      const location = await r.locations.create(tx, {
        country: 'India',
        countryCode: 'IN',
        state: 'West Bengal',
        stateCode: 'WB',
        city: 'Belur',
      });
      const company = await r.companies.create(tx, {
        clientId: clientA.id,
        name: 'Kestrel Aluminium',
      });
      const unit = await r.units.create(tx, {
        clientId: clientA.id,
        companyId: company.id,
        name: 'Belur Plant',
        locationId: location.id,
      });
      const hr = await r.departments.create(tx, {
        clientId: clientA.id,
        name: 'Human Resources',
        aliases: [],
      });
      const fa = await person(tx, 'Asha Admin', 'asha@demo.example');
      const consultant = await person(tx, 'Cyrus Consultant', 'cyrus@demo.example');
      const clientAdmin = await person(tx, 'Kiran Clientadmin', 'kiran@aditya.example');
      const owner = await person(tx, 'Omar Owner', null);
      const approver = await person(tx, 'Arun Approver', 'arun@aditya.example');
      const bina = await person(tx, 'Bina Owner', 'bina@bharat.example');
      await grant(tx, fa.id, 'FIRM_ADMIN', null);
      await grant(tx, consultant.id, 'CONSULTANT', null, [clientA.id]);
      await grant(tx, clientAdmin.id, 'CLIENT_ADMIN', clientA.id);
      await grant(tx, owner.id, 'OWNER', clientA.id);
      await grant(tx, approver.id, 'APPROVER', clientA.id);
      await grant(tx, bina.id, 'OWNER', clientB.id);
      const act = await r.acts.create(tx, {
        name: 'Income Tax Act, 1961',
        shortName: 'IT Act',
        jurisdiction: 'CENTRAL',
        stateCode: null,
        aliases: [],
      });
      const category = await r.categories.create(tx, { name: 'Payments', aliases: [] });
      const obligation = (title: string) =>
        r.obligations.create(tx, {
          externalRef: `TAX-${title.length}`,
          domain: 'TAX',
          jurisdiction: 'CENTRAL',
          stateCode: null,
          actId: act.id,
          categoryId: category.id,
          title,
          description: title,
          applicabilityText: null,
          criticality: 'HIGH',
          timelineType: 'TIME_BASED',
          recurrenceRule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
          ruleStatus: 'CONFIRMED',
          evidenceRequired: false,
          forms: [],
          logSheets: [],
          libraryVersion: 1,
        });
      const assigned = await obligation('Deposit TDS');
      const free = await obligation('File the annual return');
      const assignment = await r.assignments.create(tx, {
        clientId: clientA.id,
        unitId: unit.id,
        obligationId: assigned.id,
        departmentId: hr.id,
        defaultOwnerId: owner.id,
        defaultApproverId: approver.id,
        applicability: 'APPLICABLE',
        naReason: null,
        activeFrom: '2026-04-01' as never,
        activeTo: null,
      });
      const instance = await r.instances.create(tx, {
        clientId: clientA.id,
        unitId: unit.id,
        assignmentId: assignment.id,
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        dueDate: '2026-11-07',
        workflowState: 'OPEN',
        pendingKind: null,
        completedOn: null,
        naReason: null,
        ownerId: owner.id,
        approverId: approver.id,
        submittedAt: null,
        approvedAt: null,
        dueDateOverridden: false,
      } as unknown as Omit<ComplianceInstance, 'id' | 'firmId' | 'createdAt' | 'updatedAt'>);
      return {
        firmA,
        firmB,
        clientA: clientA.id,
        clientB: clientB.id,
        clientX: '',
        companyA: company.id,
        unitA: unit.id,
        locationId: location.id,
        hr: hr.id,
        owner: owner.id,
        approver: approver.id,
        bina: bina.id,
        act: act.id,
        category: category.id,
        obligation: assigned.id,
        obligationFree: free.id,
        assignment: assignment.id,
        instance: instance.id,
        people: {
          firmAdmin: fa.id,
          consultant: consultant.id,
          clientAdmin: clientAdmin.id,
          otherFirmAdmin: '',
        },
      };
    });
    await system(firmB, async (tx) => {
      const x = await r.clients.create(tx, {
        name: 'Xeno Holdings',
        settings: DEFAULT_CLIENT_SETTINGS,
      });
      const fb = await person(tx, 'Femi Admin', 'femi@ledger.example');
      await grant(tx, fb.id, 'FIRM_ADMIN', null);
      w.clientX = x.id;
      w.people.otherFirmAdmin = fb.id;
    });

    auth = createTestAuth();
    signIn = (actor: Actor, firmId: Id, membership: object, firmClientIds: Id[]) => {
      sessions[actor] = auth.signIn({
        firmId,
        personId: w.people[actor],
        memberships: [membership as never],
        principal: { firmClientIds },
      }).headers;
    };
    signIn('firmAdmin', firmA, { role: 'FIRM_ADMIN', clientId: null }, [w.clientA, w.clientB]);
    signIn(
      'consultant',
      firmA,
      { role: 'CONSULTANT', clientId: null, consultantClientIds: [w.clientA] },
      [],
    );
    signIn('clientAdmin', firmA, { role: 'CLIENT_ADMIN', clientId: w.clientA }, []);
    signIn('otherFirmAdmin', firmB, { role: 'FIRM_ADMIN', clientId: null }, [w.clientX]);

    store = new PostgresStore(t.db);
    app = buildServer({
      authStore: auth.store,
      clock: () => NOW,
      libraryAndEntities: { store, now: () => NOW },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  describe('tenant isolation', () => {
    it('lists only the clients of the actor and firm', async () => {
      const names = async (actor: Actor) =>
        ((await call(actor, 'GET', '/clients')).body as { items: { name: string }[] }).items.map(
          (c) => c.name,
        );
      expect(await names('firmAdmin')).toEqual(['Bharat Mills', 'Kestrel Metals Group']);
      expect(await names('consultant')).toEqual(['Kestrel Metals Group']);
      expect(await names('clientAdmin')).toEqual(['Kestrel Metals Group']);
      expect(await names('otherFirmAdmin')).toEqual(['Xeno Holdings']);
    });

    it("answers 404 for another firm's or another client's rows", async () => {
      expect((await call('otherFirmAdmin', 'GET', `/clients/${w.clientA}`)).status).toBe(404);
      expect((await call('firmAdmin', 'GET', `/clients/${w.clientX}`)).status).toBe(404);
      expect((await call('consultant', 'GET', `/clients/${w.clientB}`)).status).toBe(404);
      expect((await call('clientAdmin', 'GET', `/people/${w.bina}/memberships`)).status).toBe(404);
      expect((await call('otherFirmAdmin', 'GET', `/people/${w.owner}/memberships`)).status).toBe(
        404,
      );
    });

    it('shows client roles only the library their clients use', async () => {
      const titles = async (actor: Actor) =>
        (
          (await call(actor, 'GET', '/library/obligations')).body as { items: { title: string }[] }
        ).items
          .map((o) => o.title)
          .sort();
      expect(await titles('firmAdmin')).toEqual(['Deposit TDS', 'File the annual return']);
      expect(await titles('clientAdmin')).toEqual(['Deposit TDS']);
      expect((await call('otherFirmAdmin', 'GET', '/library/obligations')).body).toMatchObject({
        items: [],
      });
    });
  });

  describe('writes', () => {
    it('creates a client with an audit row and an outbox event in the same transaction', async () => {
      const res = await call('firmAdmin', 'POST', '/clients', { name: 'Chola Foods' });
      expect(res.status).toBe(201);
      const created = res.body as { id: Id; version: number };
      expect(created.version).toBe(1);
      const rows = await audits(w.firmA, 'client', created.id);
      expect(rows).toMatchObject([
        { action: 'CREATE', actorId: w.people.firmAdmin, actorKind: 'PERSON' },
      ]);
      const events = await system(w.firmA, (tx) => r.domainEvents.claimUnpublished(tx, 200));
      expect(events.filter((e) => e.aggregate.id === created.id).map((e) => e.type)).toEqual([
        'client.created',
      ]);
    });

    it('answers 409 STALE_VERSION with the current version, and archives and restores', async () => {
      const created = (await call('firmAdmin', 'POST', '/clients', { name: 'Dhruv Steel' }))
        .body as { id: Id };
      await refreshFirmAdmin();
      await call('firmAdmin', 'PATCH', `/clients/${created.id}`, { version: 1, name: 'Dhruv' });
      const stale = await call('firmAdmin', 'PATCH', `/clients/${created.id}`, {
        version: 1,
        name: 'Late',
      });
      expect(stale.status).toBe(409);
      expect(error(stale.body)).toMatchObject({
        code: 'STALE_VERSION',
        details: { currentVersion: 2 },
      });
      const archived = await call('firmAdmin', 'POST', `/clients/${created.id}/archive`, {
        version: 2,
        reason: 'Contract ended',
      });
      expect(archived.body).toMatchObject({ version: 3 });
      expect(archived.body).not.toMatchObject({ archivedAt: null });
      expect((await call('firmAdmin', 'GET', `/clients/${created.id}`)).status).toBe(404);
      const restored = await call('firmAdmin', 'POST', `/clients/${created.id}/restore`, {
        version: 3,
      });
      expect(restored.body).toMatchObject({ archivedAt: null, version: 4 });
      const rows = await audits(w.firmA, 'client', created.id);
      expect(rows.map((a) => a.action)).toEqual(['RESTORE', 'ARCHIVE', 'UPDATE', 'CREATE']);
      // The audit row records the archive time the database stored, not the app clock.
      expect(rows[1]?.after).toEqual({
        archivedAt: (archived.body as { archivedAt: string }).archivedAt,
      });
    });

    it('answers 409 DUPLICATE with the existing id, and the failed request leaves nothing behind', async () => {
      const res = await call('consultant', 'POST', `/clients/${w.clientA}/departments`, {
        name: 'Human Resources',
      });
      expect(res.status).toBe(409);
      expect(error(res.body)).toMatchObject({
        code: 'DUPLICATE',
        details: { field: 'name', existingId: w.hr },
      });
      const names = await system(w.firmA, (tx) =>
        r.departments.findAll(tx, { clientId: w.clientA }),
      );
      expect(names.map((d) => d.name)).toEqual(['Human Resources']);
    });

    it('does not reveal the id of a clashing person the actor cannot see', async () => {
      const res = await call('clientAdmin', 'POST', `/clients/${w.clientA}/people`, {
        displayName: 'Bina Again',
        email: 'BINA@bharat.example',
      });
      expect(res.status).toBe(400);
      expect(error(res.body).code).toBe('VALIDATION');
      expect(JSON.stringify(res.body)).not.toContain(w.bina);
    });

    it('lets a client admin add a person to their client, membership and audit included', async () => {
      const res = await call('clientAdmin', 'POST', `/clients/${w.clientA}/people`, {
        displayName: 'Priya  Plant',
        email: 'priya@aditya.example',
        role: 'APPROVER',
      });
      expect(res.status).toBe(201);
      const person = res.body as { id: Id; status: string; nameNormalized: string };
      expect(person).toMatchObject({ status: 'INVITED', nameNormalized: 'priya plant' });
      const memberships = await call('clientAdmin', 'GET', `/people/${person.id}/memberships`);
      expect(memberships.body).toMatchObject({
        items: [{ role: 'APPROVER', clientId: w.clientA }],
      });
      expect((await audits(w.firmA, 'person', person.id)).map((a) => a.action)).toEqual(['CREATE']);
      const listed = await call('clientAdmin', 'GET', `/clients/${w.clientA}/people?q=priya`);
      expect(listed.body).toMatchObject({ items: [{ id: person.id }] });
    });
  });

  describe('people', () => {
    it("keeps person changes inside the actor's clients, using M3's reach", async () => {
      const renamed = await call('consultant', 'PATCH', `/people/${w.owner}`, {
        version: 1,
        displayName: 'Omar O.',
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ nameNormalized: 'omar o.', version: 2 });
      const grant = (clientId: Id) => ({
        role: 'APPROVER',
        clientId,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: null,
      });
      expect(
        (await call('clientAdmin', 'POST', `/people/${w.owner}/memberships`, grant(w.clientA)))
          .status,
      ).toBe(201);
      // Bina now belongs to clients A and B; the consultant manages only A.
      expect(
        (await call('firmAdmin', 'POST', `/people/${w.bina}/memberships`, grant(w.clientA))).status,
      ).toBe(201);
      const shared = await call('consultant', 'PATCH', `/people/${w.bina}`, {
        version: 1,
        displayName: 'Bina B.',
      });
      expect(shared.status).toBe(403);
      expect(error(shared.body).message).toBe(
        'This person also belongs to a client you do not manage.',
      );
      expect(JSON.stringify(shared.body)).not.toContain(w.clientB);
      // Firm staff are hidden from client roles and changed by a firm admin only.
      expect(
        (await call('clientAdmin', 'GET', `/people/${w.people.consultant}/memberships`)).status,
      ).toBe(404);
      expect(
        (
          await call('consultant', 'POST', `/people/${w.people.firmAdmin}/memberships`, {
            ...grant(w.clientA),
          })
        ).status,
      ).toBe(403);
      const staff = await call('firmAdmin', 'GET', '/people');
      expect(
        (staff.body as { items: { displayName: string }[] }).items.map((p) => p.displayName),
      ).toEqual(['Asha Admin', 'Cyrus Consultant']);
    });

    it('merges people and moves their instances', async () => {
      const dup = await call('firmAdmin', 'POST', `/clients/${w.clientA}/people`, {
        displayName: 'Arun A.',
      });
      const dupId = (dup.body as { id: Id }).id;
      const res = await call('firmAdmin', 'PATCH', `/assignments/${w.assignment}`, {
        version: 1,
        defaultApproverId: dupId,
        applyToOpen: true,
      });
      expect(res.status).toBe(200);
      expect(
        (await system(w.firmA, (tx) => r.instances.forAssignment(tx, w.assignment)))[0],
      ).toMatchObject({ approverId: dupId, version: 2 });
      const approver = await system(w.firmA, (tx) => r.people.require(tx, w.approver));
      const merged = await call('firmAdmin', 'POST', `/people/${w.approver}/merge`, {
        version: approver.version,
        sourceIds: [dupId],
      });
      expect(merged.status).toBe(200);
      expect(
        (await system(w.firmA, (tx) => r.instances.forAssignment(tx, w.assignment)))[0],
      ).toMatchObject({ approverId: w.approver, version: 3 });
      expect((await system(w.firmA, (tx) => r.people.get(tx, dupId)))?.archivedAt).not.toBeNull();
    });
  });

  describe('lists', () => {
    it('pages by name with an opaque cursor, a total and search', async () => {
      signIn('firmAdmin', w.firmA, { role: 'FIRM_ADMIN', clientId: null }, [w.clientA, w.clientB]);
      const first = await call('firmAdmin', 'GET', '/clients?limit=1&count=true');
      const page1 = first.body as { items: { name: string }[]; nextCursor: string; total: number };
      expect(page1.items.map((c) => c.name)).toEqual(['Bharat Mills']);
      expect(page1.total).toBe(2);
      const second = await call('firmAdmin', 'GET', `/clients?limit=1&cursor=${page1.nextCursor}`);
      expect(second.body).toMatchObject({
        items: [{ name: 'Kestrel Metals Group' }],
        nextCursor: null,
      });
      expect((await call('firmAdmin', 'GET', '/clients?q=BHAR')).body).toMatchObject({
        items: [{ name: 'Bharat Mills' }],
      });
      const acts = await call('consultant', 'GET', '/library/acts?q=it%20act');
      expect(acts.body).toMatchObject({ items: [{ name: 'Income Tax Act, 1961' }] });
    });

    it('pages assignments in id order', async () => {
      const created = await call('firmAdmin', 'POST', `/clients/${w.clientA}/assignments`, {
        unitId: w.unitA,
        obligationId: w.obligationFree,
        departmentId: w.hr,
        defaultOwnerId: w.owner,
        defaultApproverId: w.approver,
        activeFrom: '2026-04-01',
      });
      expect(created.status).toBe(201);
      const page1 = (await call('firmAdmin', 'GET', `/clients/${w.clientA}/assignments?limit=1`))
        .body as { items: { id: Id }[]; nextCursor: string };
      expect(page1.items.map((a) => a.id)).toEqual([w.assignment]);
      const page2 = await call(
        'firmAdmin',
        'GET',
        `/clients/${w.clientA}/assignments?limit=1&cursor=${page1.nextCursor}`,
      );
      expect(page2.body).toMatchObject({
        items: [{ id: (created.body as { id: Id }).id }],
        nextCursor: null,
      });
      const again = await call('firmAdmin', 'POST', `/clients/${w.clientA}/assignments`, {
        unitId: w.unitA,
        obligationId: w.obligationFree,
        departmentId: w.hr,
        defaultOwnerId: w.owner,
        defaultApproverId: w.approver,
        activeFrom: '2026-04-01',
      });
      expect(error(again.body)).toMatchObject({
        code: 'DUPLICATE',
        details: { field: 'obligationId', existingId: (created.body as { id: Id }).id },
      });
    });
  });

  describe('the store itself', () => {
    const ctx = () => ({
      requestId: 'store-test',
      firmId: w.firmA,
      personId: w.people.firmAdmin,
      memberships: [
        {
          id: w.people.firmAdmin,
          firmId: w.firmA,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          archivedAt: null,
          version: 1,
          personId: w.people.firmAdmin,
          role: 'FIRM_ADMIN' as const,
          clientId: null,
          consultantClientIds: null,
          unitIds: null,
          expiresAt: null,
        },
      ],
      clientIds: [w.clientA, w.clientB],
      mfaSatisfied: true,
      asOf: '2026-10-12' as never,
    });

    it('maps every unique rule to the existing row and keeps the transaction usable', async () => {
      const rollback = new Error('rollback');
      await expect(
        store.transaction(ctx(), async (tx) => {
          const foils = await tx.companies.insert({ clientId: w.clientA, name: 'Kestrel Foils' });
          await expect(
            tx.companies.insert({ clientId: w.clientA, name: 'Kestrel Aluminium' }),
          ).rejects.toMatchObject({ field: 'name', existingId: w.companyA });
          await expect(
            tx.companies.update(foils.id, 1, { name: 'Kestrel Aluminium' }),
          ).rejects.toMatchObject({ field: 'name', existingId: w.companyA });
          expect(await tx.companies.update(foils.id, 7, { name: 'Kestrel Foils Ltd' })).toBe(
            'STALE',
          );
          await expect(
            tx.units.insert({
              clientId: w.clientA,
              companyId: w.companyA,
              name: 'Belur Plant',
              locationId: w.locationId,
            }),
          ).rejects.toMatchObject({ field: 'name', existingId: w.unitA });
          await expect(
            tx.locations.insert({
              country: 'India',
              countryCode: 'IN',
              state: 'west bengal',
              stateCode: 'WB',
              city: 'BELUR',
            }),
          ).rejects.toMatchObject({ field: 'location', existingId: w.locationId });
          await expect(
            tx.acts.insert({
              name: 'Income Tax Act, 1961',
              shortName: null,
              jurisdiction: 'CENTRAL',
              stateCode: null,
              aliases: [],
            }),
          ).rejects.toMatchObject({ field: 'name', existingId: w.act });
          await expect(
            tx.categories.insert({ name: 'Payments', aliases: [] }),
          ).rejects.toMatchObject({ field: 'name', existingId: w.category });
          // Not a duplicate: M3's error passes through unchanged.
          await expect(
            tx.departments.insert({ clientId: w.clientX, name: 'Elsewhere', aliases: [] }),
          ).rejects.toMatchObject({ name: 'DbError' });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(
        await system(w.firmA, (tx) => r.companies.findAll(tx, { clientId: w.clientA })),
      ).toHaveLength(1);
    });

    it('refuses a sort or search field outside the allow-list', async () => {
      await expect(
        store.transaction(ctx(), (tx) => tx.people.list({ orderBy: 'email', limit: 10 })),
      ).rejects.toThrow('people cannot be sorted by email');
      await expect(
        store.transaction(ctx(), (tx) =>
          tx.clients.list({
            orderBy: 'name',
            limit: 10,
            search: { text: 'a', fields: ['settings'] },
          }),
        ),
      ).rejects.toThrow('clients cannot be searched on settings');
    });

    it('archives on its own and never edits locations', async () => {
      await expect(
        store.transaction(ctx(), (tx) =>
          tx.companies.update(w.companyA, 1, { name: 'X', archivedAt: NOW.toISOString() }),
        ),
      ).rejects.toThrow('Archive or restore a row on its own');
      await expect(
        store.transaction(ctx(), (tx) => tx.locations.update(w.locationId, 1, { city: 'Howrah' })),
      ).rejects.toThrow('locations rows are not changed through this store');
    });

    it('returns null for a row the context cannot change, and the reach through M3', async () => {
      const otherFirm = { ...ctx(), firmId: w.firmB, clientIds: [] };
      expect(
        await store.transaction(otherFirm, (tx) =>
          tx.companies.update(w.companyA, 1, { name: 'Taken' }),
        ),
      ).toBeNull();
      const bina = await store.transaction(ctx(), (tx) => tx.personReach(w.bina));
      expect(bina.firmStaff).toBe(false);
      expect(bina.clientIds).toContain(w.clientB);
      expect(
        await store.transaction(ctx(), (tx) => tx.personReach(w.people.consultant)),
      ).toMatchObject({ firmStaff: true });
    });
  });
});
