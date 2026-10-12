import { ApiErrorResponse, Assignment } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { newAssignment } from '../entities/testing/scenarios.js';
import { ACTORS, ids, testApp } from '../entities/testing/world.js';

const error = (body: unknown) => ApiErrorResponse.parse(body).error;
const url = `/clients/${ids.clientA}/assignments`;

describe('assignments', () => {
  it('creates an applicable assignment and asks the jobs to generate instances', async () => {
    const { call, store } = testApp();
    const res = await call('clientAdmin', 'POST', url, newAssignment());
    expect(Assignment.parse(res.body)).toMatchObject({
      applicability: 'APPLICABLE',
      naReason: null,
      activeTo: null,
    });
    expect(store.events).toMatchObject([{ type: 'assignment.created' }]);
  });

  it('refuses the same obligation, unit and department twice', async () => {
    const { call } = testApp();
    const res = await call(
      'clientAdmin',
      'POST',
      url,
      newAssignment({ obligationId: ids.obligation, departmentId: ids.hrAlias }),
    );
    expect(error(res.body)).toMatchObject({
      code: 'DUPLICATE',
      details: { existingId: ids.assignment },
    });
  });

  it('checks every reference belongs to the client', async () => {
    const { call } = testApp();
    for (const bad of [
      { unitId: ids.unitB },
      { departmentId: ids.deptB },
      { obligationId: ids.act },
      { defaultOwnerId: ids.clientA },
      { defaultApproverId: ids.clientA },
      { activeTo: '2020-01-01' },
    ]) {
      const res = await call('consultant', 'POST', url, newAssignment(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('returns per-item results for a bulk create', async () => {
    const { call, store } = testApp();
    const res = await call('consultant', 'POST', `${url}/bulk`, {
      items: [newAssignment(), newAssignment(), newAssignment({ unitId: ids.unitB })],
    });
    const { results } = res.body as {
      results: { index: number; ok: boolean; error?: { code: string } }[];
    };
    expect(results.map((r) => [r.index, r.ok, r.error?.code])).toEqual([
      [0, true, undefined],
      [1, false, 'DUPLICATE'],
      [2, false, 'VALIDATION'],
    ]);
    expect(store.events.filter((e) => e.type === 'assignment.created')).toHaveLength(1);
  });

  it('is 404 for a bulk create in a client the actor cannot see', async () => {
    const { call } = testApp();
    const res = await call('consultant', 'POST', `/clients/${ids.clientB}/assignments/bulk`, {
      items: [newAssignment()],
    });
    expect(res.status).toBe(404);
  });

  it('filters by the register columns, with "me" for the signed-in person', async () => {
    const { call } = testApp();
    const count = async (actor: Parameters<typeof call>[0], q: string) =>
      ((await call(actor, 'GET', `${url}${q}`)).body as { items: unknown[] }).items.length;
    expect(await count('owner', '?ownerId=me')).toBe(1);
    expect(await count('approver', '?approverId=me&applicability=APPLICABLE')).toBe(1);
    expect(await count('firmAdmin', `?unitId=${ids.unit2}`)).toBe(0);
    expect(
      await count('firmAdmin', `?departmentId=${ids.hrAlias}&obligationId=${ids.obligation}`),
    ).toBe(1);
  });

  it('limits owners and approvers to their units', async () => {
    const { call } = testApp();
    await call('firmAdmin', 'POST', url, newAssignment({ unitId: ids.unit2 }));
    const count = async (actor: Parameters<typeof call>[0], q = '') =>
      ((await call(actor, 'GET', `${url}${q}`)).body as { items: unknown[] }).items.length;
    expect(await count('owner')).toBe(1);
    expect(await count('owner', `?unitId=${ids.unit2}`)).toBe(0);
    expect(await count('viewer')).toBe(2);
  });

  it('reassigns open instances when asked, and audits each one', async () => {
    const { call, store } = testApp();
    const res = await call('clientAdmin', 'PATCH', `/assignments/${ids.assignment}`, {
      version: 1,
      defaultOwnerId: ids.duplicate,
      defaultApproverId: ACTORS.clientAdmin.person,
      applyToOpen: true,
    });
    expect(res.status).toBe(200);
    expect(store.instance(ids.instance)).toMatchObject({
      ownerId: ids.duplicate,
      approverId: ACTORS.clientAdmin.person,
    });
    // An approved instance keeps its people.
    expect(store.instance(ids.instanceDup)?.ownerId).toBe(ids.duplicate);
    expect(store.audits.map((a) => a.action)).toEqual(['UPDATE', 'REASSIGN']);
    expect(store.events.map((e) => e.type)).toEqual(['instance.reassigned', 'assignment.changed']);
    expect(store.events.at(-1)?.data).toEqual({
      assignmentId: ids.assignment,
      changed: ['defaultOwner', 'defaultApprover'],
      appliedToOpen: true,
    });
  });

  it('leaves instances alone without applyToOpen and checks the new values', async () => {
    const { call, store } = testApp();
    await call('clientAdmin', 'PATCH', `/assignments/${ids.assignment}`, {
      version: 1,
      defaultOwnerId: ids.duplicate,
      departmentId: ids.hr,
      activeTo: '2027-03-31',
    });
    expect(store.instance(ids.instance)?.ownerId).toBe(ACTORS.owner.person);
    for (const bad of [
      { departmentId: ids.deptB },
      { defaultApproverId: ids.unit1 },
      { activeTo: '2000-01-01' },
    ]) {
      const res = await call('clientAdmin', 'PATCH', `/assignments/${ids.assignment}`, {
        version: 2,
        ...bad,
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('records NOT_APPLICABLE with its reason, and clears it when applicable again', async () => {
    const { call, store } = testApp();
    const na = await call('clientAdmin', 'POST', `/assignments/${ids.assignment}/applicability`, {
      version: 1,
      applicability: 'NOT_APPLICABLE',
      reason: 'No boiler at this plant',
    });
    expect(Assignment.parse(na.body)).toMatchObject({ naReason: 'No boiler at this plant' });
    expect(store.audits.at(-1)).toMatchObject({
      action: 'APPLICABILITY_CHANGE',
      reason: 'No boiler at this plant',
    });
    expect(store.events.at(-1)?.data).toMatchObject({ from: 'APPLICABLE', to: 'NOT_APPLICABLE' });
    const back = await call('clientAdmin', 'POST', `/assignments/${ids.assignment}/applicability`, {
      version: 2,
      applicability: 'APPLICABLE',
      reason: 'Boiler installed',
    });
    expect(Assignment.parse(back.body).naReason).toBeNull();
    const missing = await call(
      'clientAdmin',
      'POST',
      `/assignments/${ids.assignment}/applicability`,
      {
        version: 3,
        applicability: 'TO_ASSESS',
      },
    );
    expect(missing.status).toBe(400);
  });

  it('archives with a reason and announces it', async () => {
    const { call, store } = testApp();
    await call('firmAdmin', 'POST', `/assignments/${ids.assignment}/archive`, {
      version: 1,
      reason: 'Closed',
    });
    expect(store.events.map((e) => e.type)).toEqual(['assignment.archived']);
    const again = await call('firmAdmin', 'POST', `/assignments/${ids.assignment}/archive`, {
      version: 2,
      reason: 'Closed',
    });
    expect(again.status).toBe(404);
  });
});
