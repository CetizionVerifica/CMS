import { ApiErrorResponse, type Act, type Assignment, type Obligation } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { newAssignment } from '../entities/testing/scenarios.js';
import { FIRM_A, ids, seedIsoLibrary, testApp, type ActorName } from '../entities/testing/world.js';

// The ISO add-on's off switch in the library and assignments (docs/iso/plan.md §4.4-4.5, ISO-9b). Off hides and
// refuses STANDARD rows with 403 FEATURE_NOT_ENABLED; it never deletes. On, they behave like any other row, except that
// a STANDARD act's values are fixed (400, routes.test.ts).

const error = (body: unknown) => ApiErrorResponse.parse(body).error;
const OFF = { code: 'FEATURE_NOT_ENABLED', details: { feature: 'isoManagement' } };

function app(iso: boolean) {
  const t = testApp();
  seedIsoLibrary(t.store);
  if (iso) t.setFeatures(FIRM_A, ['isoManagement']);
  return t;
}

const STAFF: ActorName[] = ['firmAdmin', 'consultant'];
/** Every firm-A actor who sees client A, where the ISO activity is assigned. */
const IN_CLIENT_A: ActorName[] = [...STAFF, 'clientAdmin', 'approver', 'owner', 'viewer'];

const itemsOf = <T>(body: unknown) => (body as { items: T[] }).items;

describe('lists leave STANDARD rows out while the add-on is off', () => {
  it.each(IN_CLIENT_A)('%s: acts, obligations and assignments', async (actor) => {
    for (const iso of [false, true]) {
      const { call } = app(iso);
      const acts = itemsOf<Act>((await call(actor, 'GET', '/library/acts?limit=100')).body);
      const obligations = itemsOf<Obligation>(
        (await call(actor, 'GET', '/library/obligations?limit=100')).body,
      );
      const assignments = itemsOf<Assignment>(
        (await call(actor, 'GET', `/clients/${ids.clientA}/assignments?limit=100`)).body,
      );
      const listed = {
        act: acts.some((a) => a.id === ids.isoAct),
        obligation: obligations.some((o) => o.id === ids.isoObligation),
        assignment: assignments.some((a) => a.id === ids.isoAssignment),
      };
      expect(listed, `iso ${iso}`).toEqual({ act: iso, obligation: iso, assignment: iso });
      // Laws are listed either way.
      expect(obligations.some((o) => o.id === ids.obligation)).toBe(true);
    }
  });

  it('counts only what it lists', async () => {
    const { call } = app(false);
    const res = await call('firmAdmin', 'GET', '/library/obligations?limit=1&count=true');
    expect((res.body as { total: number }).total).toBe(3);
  });
});

describe('routes that name a STANDARD row answer 403 while the add-on is off', () => {
  it.each(IN_CLIENT_A)('%s: the activity by id', async (actor) => {
    const off = await app(false).call(actor, 'GET', `/library/obligations/${ids.isoObligation}`);
    expect(off.status).toBe(403);
    expect(error(off.body)).toMatchObject(OFF);
    const on = await app(true).call(actor, 'GET', `/library/obligations/${ids.isoObligation}`);
    expect(on.status).toBe(200);
  });

  it('is still 404 in another firm', async () => {
    const res = await app(false).call(
      'otherFirmAdmin',
      'GET',
      `/library/obligations/${ids.isoObligation}`,
    );
    expect(res.status).toBe(404);
  });

  it.each(STAFF)('%s: activity create, update, archive and push', async (actor) => {
    for (const iso of [false, true]) {
      const { call, store } = app(iso);
      const created = await call(actor, 'POST', '/library/obligations', {
        externalRef: 'ISO-OWN-1',
        domain: 'OTHER',
        jurisdiction: 'CENTRAL',
        stateCode: null,
        actId: ids.isoAct,
        categoryId: ids.category,
        title: 'Our own ISO activity',
        description: 'A consultant-defined activity.',
        applicabilityText: null,
        criticality: 'MEDIUM',
        timelineType: 'TIME_BASED',
        recurrenceRule: { kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 0 },
        ruleStatus: 'CONFIRMED',
        evidenceRequired: true,
        forms: [],
        logSheets: [],
      });
      const updated = await call(actor, 'PATCH', `/library/obligations/${ids.isoObligation}`, {
        version: 1,
        title: 'Monthly workplace inspection',
      });
      const pushed = await call(actor, 'POST', `/library/obligations/${ids.isoObligation}/push`, {
        clientIds: [ids.clientA],
      });
      const archived = await call(
        actor,
        'POST',
        `/library/obligations/${ids.isoObligation}/archive`,
        { version: 2, reason: 'Not used' },
      );
      const statuses = [created, updated, pushed, archived].map((r) => r.status);
      if (iso) {
        // On: create, update and push work; archive waits for the assignment to be archived first (400).
        expect(statuses).toEqual([201, 200, 200, 400]);
      } else {
        expect(statuses).toEqual([403, 403, 403, 403]);
        for (const r of [created, updated, pushed, archived])
          expect(error(r.body)).toMatchObject(OFF);
        expect(store.raw('obligations', ids.isoObligation)).toMatchObject({ version: 1 });
        expect(store.events).toEqual([]);
        expect(store.audits).toEqual([]);
      }
    }
  });

  it.each(STAFF)('%s: a STANDARD act: 403 before the fixed-values 400', async (actor) => {
    for (const iso of [false, true]) {
      const { call } = app(iso);
      const want = iso ? 400 : 403;
      const edit = await call(actor, 'PATCH', `/library/acts/${ids.isoAct}`, {
        version: 1,
        shortName: 'OHS',
      });
      const into = await call(actor, 'POST', `/library/acts/${ids.isoAct}/merge`, {
        version: 1,
        sourceIds: [ids.actDup],
      });
      const from = await call(actor, 'POST', `/library/acts/${ids.act}/merge`, {
        version: 1,
        sourceIds: [ids.isoAct],
      });
      expect(
        [edit, into, from].map((r) => r.status),
        `iso ${iso}`,
      ).toEqual([want, want, want]);
      if (!iso) expect(error(edit.body)).toMatchObject(OFF);
    }
  });

  it.each(STAFF)('%s: moving a law onto a STANDARD act: 403 off, 400 on', async (actor) => {
    for (const iso of [false, true]) {
      const res = await app(iso).call(actor, 'PATCH', `/library/obligations/${ids.obligation}`, {
        version: 1,
        actId: ids.isoAct,
      });
      expect(error(res.body).code, `iso ${iso}`).toBe(iso ? 'VALIDATION' : 'FEATURE_NOT_ENABLED');
    }
  });

  it.each(['firmAdmin', 'consultant', 'clientAdmin'] as const)(
    '%s: assignment create, bulk, update, applicability and archive',
    async (actor) => {
      for (const iso of [false, true]) {
        const { call, store } = app(iso);
        const url = `/clients/${ids.clientA}/assignments`;
        const created = await call(
          actor,
          'POST',
          url,
          newAssignment({ obligationId: ids.isoObligation, departmentId: ids.hrAlias }),
        );
        const bulk = await call(actor, 'POST', `${url}/bulk`, {
          items: [
            newAssignment({ obligationId: ids.isoObligation, unitId: ids.unit2 }),
            newAssignment(),
          ],
        });
        const updated = await call(actor, 'PATCH', `/assignments/${ids.isoAssignment}`, {
          version: 1,
          activeTo: '2027-03-31',
        });
        const na = await call(actor, 'POST', `/assignments/${ids.isoAssignment}/applicability`, {
          version: 2,
          applicability: 'NOT_APPLICABLE',
          reason: 'No site work',
        });
        const archived = await call(actor, 'POST', `/assignments/${ids.isoAssignment}/archive`, {
          version: 3,
          reason: 'Closed',
        });
        const bulkResults = (bulk.body as { results: { ok: boolean; error?: { code: string } }[] })
          .results;
        if (iso) {
          expect([created, updated, na, archived].map((r) => r.status)).toEqual([
            201, 200, 200, 200,
          ]);
          expect(bulkResults.map((r) => r.ok)).toEqual([true, true]);
        } else {
          expect([created, updated, na, archived].map((r) => r.status)).toEqual([
            403, 403, 403, 403,
          ]);
          for (const r of [created, updated, na, archived])
            expect(error(r.body)).toMatchObject(OFF);
          // Per item: the law's assignment is created, the ISO one refused.
          expect(bulkResults.map((r) => r.error?.code ?? 'ok')).toEqual([
            'FEATURE_NOT_ENABLED',
            'ok',
          ]);
          expect(store.raw('assignments', ids.isoAssignment)).toMatchObject({
            version: 1,
            archivedAt: null,
          });
        }
      }
    },
  );

  it('turning the add-on back on brings everything back as it was', async () => {
    const t = app(false);
    expect((await t.call('owner', 'GET', `/library/obligations/${ids.isoObligation}`)).status).toBe(
      403,
    );
    t.setFeatures(FIRM_A, ['isoManagement']);
    const res = await t.call('owner', 'GET', `/library/obligations/${ids.isoObligation}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: ids.isoObligation, version: 1 });
  });
});

describe('clauseRefs', () => {
  const refs = [{ standard: 'ISO_45001', clauseNumber: '9.1.1' }];
  const body = (actId: string) => ({
    externalRef: null,
    domain: 'OTHER',
    jurisdiction: 'CENTRAL',
    stateCode: null,
    actId,
    categoryId: ids.category,
    title: 'Names clause references',
    description: 'A body that names clauseRefs.',
    applicabilityText: null,
    criticality: 'MEDIUM',
    timelineType: 'TIME_BASED',
    recurrenceRule: { kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 0 },
    ruleStatus: 'CONFIRMED',
    evidenceRequired: true,
    forms: [],
    logSheets: [],
    clauseRefs: refs,
  });

  it.each(STAFF)(
    '%s: a create or update naming them is 400, on and off, under either kind',
    async (actor) => {
      for (const iso of [false, true]) {
        const { call, store } = app(iso);
        for (const [actId, id] of [
          [ids.act, ids.obligation],
          [ids.isoAct, ids.isoObligation],
        ] as const) {
          const created = await call(actor, 'POST', '/library/obligations', body(actId));
          const updated = await call(actor, 'PATCH', `/library/obligations/${id}`, {
            version: 1,
            clauseRefs: refs,
          });
          for (const res of [created, updated]) {
            expect(error(res.body).code, `iso ${iso} ${actId}`).toBe('VALIDATION');
          }
        }
        // Only the catalogue copy writes them: the stored references are as seeded.
        expect(store.raw('obligations', ids.isoObligation)?.clauseRefs).toEqual(refs);
        expect(store.raw('obligations', ids.obligation)?.clauseRefs).toBeUndefined();
        expect(store.audits).toEqual([]);
      }
    },
  );
});
