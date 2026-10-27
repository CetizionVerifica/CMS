import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type Reply, type Who } from './testing/fixture.js';

/**
 * Objectives and their readings (model §3.6): the standards and risk items an objective takes, its target against its
 * baseline, CLOSE (one TRANSITION with `after.action` CLOSE), readings by period, the lock once closed, unit scope (plan
 * §3.3), `ids` (contracts 1.8.5) and the audit trail (model §8).
 */

const NOW = new Date('2026-10-20T06:00:00Z');
let h: Harness;
/** 9001 and 14001 on unit A; 9001 only on unit B. */
let systemA: string;
let quality: string;
let riskA: string;
let riskB: string;

beforeAll(async () => {
  h = await createHarness('Objective', NOW);
  systemA = (
    await h.ok('clientAdmin', 'POST', '/systems', {
      name: 'Stonebridge system',
      standardIds: [h.f.std9001, h.f.std14001],
      unitIds: [h.f.unitA],
    })
  ).id as string;
  quality = (
    await h.ok('clientAdmin', 'POST', '/systems', {
      name: 'Highmoor quality',
      standardIds: [h.f.std9001],
      unitIds: [h.f.unitB],
    })
  ).id as string;
  const item = async (managementSystemId: string) =>
    (
      await h.ok('clientAdmin', 'POST', '/risks', {
        managementSystemId,
        kind: 'OPPORTUNITY',
        activity: 'Scrap recovery',
        description: 'Remelt our own offcuts',
        likelihood: 3,
        severity: 2,
        ownerId: h.f.people.clientAdmin,
      })
    ).id as string;
  riskA = await item(systemA);
  riskB = await item(quality);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const code = (reply: Reply) => (reply.body.error as { code?: string } | undefined)?.code;
const field = (reply: Reply) =>
  (reply.body.error as { details?: { issues?: { path: unknown[] }[] } } | undefined)?.details
    ?.issues?.[0]?.path;

const audit = (entityId: string) =>
  h.testDb.query<{
    action: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    reason: string | null;
  }>(
    'SELECT action, before, after, reason FROM audit_event WHERE entity_id = $1 ORDER BY at, action, after::text, reason',
    [entityId],
  );

const OBJECTIVE = {
  standards: ['ISO_14001'],
  text: 'Cut water drawn per tonne',
  target: 3,
  unitOfMeasure: 'kL per tonne',
  baseline: 4,
  direction: 'DECREASE',
  readingRule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
  dueOn: '2027-03-31',
};

const createObjective = (fields: Record<string, unknown> = {}, who: Who = 'clientAdmin') =>
  h.send(who, 'POST', '/objectives', {
    managementSystemId: systemA,
    ownerId: h.f.people.owner,
    ...OBJECTIVE,
    ...fields,
  });

async function objective(fields: Record<string, unknown> = {}, who: Who = 'clientAdmin') {
  const reply = await createObjective(fields, who);
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  const id = reply.body.id as string;
  // The row's createdAt is the database's clock; set it to the test's day, which the closing date is checked against.
  await h.testDb.query('UPDATE objective SET created_at = $2 WHERE id = $1', [
    id,
    NOW.toISOString(),
  ]);
  return reply.body as { id: string; version: number } & Record<string, unknown>;
}

const listIds = async (query: string, who: Who = 'clientAdmin') => {
  const reply = await h.send(who, 'GET', `/objectives?limit=200${query}`);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return (reply.body.items ?? []).map((i) => i.id as string);
};

describe('createIsoObjective', () => {
  it('adds an open objective with its progress, audited as CREATE', async () => {
    const created = await objective({ riskItemIds: [riskA] });
    expect(created).toMatchObject({
      managementSystemId: systemA,
      standards: ['ISO_14001'],
      riskItemIds: [riskA],
      closedOn: null,
      outcome: null,
      version: 1,
      progress: expect.objectContaining({ latestValue: null }),
    });
    expect((await audit(created.id)).map((e) => e.action)).toEqual(['CREATE']);
  });

  it('checks the standards, the risk items, the owner and the target (400 VALIDATION)', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ managementSystemId: quality, standards: ['ISO_14001'] }, 'standards'],
      [{ riskItemIds: [riskB] }, 'riskItemIds'],
      [
        {
          ownerId: h.f.people.otherOwner,
          managementSystemId: systemA,
          riskItemIds: ['0190a0b0-0000-7000-8000-000000000000'],
        },
        'riskItemIds',
      ],
      [{ direction: 'DECREASE', baseline: 2, target: 3 }, 'target'],
      [{ direction: 'INCREASE', baseline: 4, target: 3 }, 'target'],
    ];
    for (const [fields, path] of cases) {
      const reply = await createObjective(fields);
      expect([JSON.stringify(fields), reply.status, code(reply), field(reply)]).toEqual([
        JSON.stringify(fields),
        400,
        'VALIDATION',
        [path],
      ]);
    }
    expect((await createObjective({ direction: 'MAINTAIN', baseline: 2, target: 3 })).status).toBe(
      201,
    );
    expect((await createObjective({ baseline: 3, target: 3 })).status).toBe(201);
  });

  it('lets FA, CO and CA add objectives, and an owner only as its owner', async () => {
    for (const who of ['firmAdmin', 'consultant', 'clientAdmin', 'owner'] as Who[]) {
      expect([who, (await createObjective({}, who)).status]).toEqual([who, 201]);
    }
    expect((await createObjective({ ownerId: h.f.people.clientAdmin }, 'owner')).status).toBe(403);
    for (const who of ['approver', 'viewer'] as Who[]) {
      expect([who, (await createObjective({}, who)).status]).toEqual([who, 403]);
    }
  });
});

describe('getIsoObjective and listIsoObjectives', () => {
  it('lists by due date and applies every filter', async () => {
    const late = await objective({ dueOn: '2027-09-30', text: 'Recycle all pallets' });
    const early = await objective({ dueOn: '2026-12-31', standards: ['ISO_9001'] });
    const ids = await listIds(`&managementSystemId=${systemA}`);
    expect(ids.indexOf(early.id)).toBeLessThan(ids.indexOf(late.id));
    expect(await listIds('&standard=ISO_9001')).toContain(early.id);
    expect(await listIds('&standard=ISO_9001')).not.toContain(late.id);
    expect(await listIds('&q=pallets')).toEqual([late.id]);
    expect(await listIds('&ownerId=me', 'owner')).toContain(late.id);
    expect(await listIds('&open=false')).not.toContain(late.id);
  });

  it('narrows to the ids given within the reader’s units, dropping unknown and archived ids', async () => {
    const a = await objective();
    const b = await objective({
      managementSystemId: quality,
      standards: ['ISO_9001'],
      ownerId: h.f.people.otherOwner,
    });
    const unknown = '0190a0b0-0000-7000-8000-000000000000';
    const ids = [a.id, b.id, unknown].join(',');
    expect((await listIds(`&ids=${ids}`)).sort()).toEqual([a.id, b.id].sort());
    expect(await listIds(`&ids=${ids}`, 'owner')).toEqual([a.id]);
    expect(await listIds(`&ids=${ids}`, 'otherOwner')).toEqual([b.id]);
    expect(await listIds(`&ids=${ids}&open=false`)).toEqual([]);
  });

  it('keeps AP and OW to their system’s units and the objectives they own', async () => {
    const a = await objective();
    expect((await h.send('otherOwner', 'GET', `/objectives/${a.id}`)).status).toBe(404);
    expect((await h.send('approverB', 'GET', `/objectives/${a.id}`)).status).toBe(404);
    expect((await h.send('viewer', 'GET', `/objectives/${a.id}`)).status).toBe(200);
    const named = await objective({
      managementSystemId: quality,
      standards: ['ISO_9001'],
      ownerId: h.f.people.owner,
    });
    expect((await h.send('owner', 'GET', `/objectives/${named.id}`)).status).toBe(200);
    expect(await listIds('', 'owner')).toContain(named.id);
  });
});

describe('updateIsoObjective', () => {
  it('audits field edits as UPDATE, a new owner as REASSIGN and a new due date with its reason', async () => {
    const o = await objective();
    const bare = await h.send('clientAdmin', 'PATCH', `/objectives/${o.id}`, {
      version: 1,
      dueOn: '2027-06-30',
    });
    expect([bare.status, code(bare)]).toEqual([422, 'REASON_REQUIRED']);
    await h.ok('clientAdmin', 'PATCH', `/objectives/${o.id}`, {
      version: 1,
      text: 'Cut fresh water drawn per tonne',
      ownerId: h.f.people.clientAdmin,
      dueOn: '2027-06-30',
      reason: 'Plant shutdown in March',
    });
    const events = (await audit(o.id)).slice(1);
    expect(events.map((e) => [e.action, e.reason]).sort()).toEqual([
      ['DUE_DATE_CHANGE', 'Plant shutdown in March'],
      ['REASSIGN', 'Plant shutdown in March'],
      ['UPDATE', null],
    ]);
  });

  it('keeps the merged target on the direction’s side and checks the standards', async () => {
    const o = await objective();
    const flipped = await h.send('clientAdmin', 'PATCH', `/objectives/${o.id}`, {
      version: 1,
      direction: 'INCREASE',
    });
    expect([flipped.status, field(flipped)]).toEqual([400, ['target']]);
    const foreign = await h.send('clientAdmin', 'PATCH', `/objectives/${o.id}`, {
      version: 1,
      riskItemIds: [riskB],
    });
    expect([foreign.status, field(foreign)]).toEqual([400, ['riskItemIds']]);
  });

  it('lets managers and the owner edit, and no one else', async () => {
    const o = await objective({ ownerId: h.f.people.clientAdmin });
    for (const who of ['owner', 'approver', 'viewer'] as Who[]) {
      const reply = await h.send(who, 'PATCH', `/objectives/${o.id}`, { version: 1, text: 'No' });
      expect([who, reply.status]).toEqual([who, 403]);
    }
    expect(
      (await h.send('consultant', 'PATCH', `/objectives/${o.id}`, { version: 1, text: 'Yes' }))
        .status,
    ).toBe(200);
  });
});

describe('closeIsoObjective', () => {
  it('records the outcome in one TRANSITION; the objective then takes no edits or readings', async () => {
    const o = await objective();
    await h.ok('owner', 'POST', `/objectives/${o.id}/readings`, {
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      value: 3.5,
    });
    const closed = await h.send('owner', 'POST', `/objectives/${o.id}/close`, {
      version: 1,
      closedOn: '2026-10-20',
      outcome: 'NOT_ACHIEVED',
    });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({
      closedOn: '2026-10-20',
      outcome: 'NOT_ACHIEVED',
      version: 2,
    });
    const transitions = (await audit(o.id)).filter((e) => e.action === 'TRANSITION');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      before: { closedOn: null, outcome: null },
      after: { action: 'CLOSE', closedOn: '2026-10-20', outcome: 'NOT_ACHIEVED' },
    });
    expect(transitions[0]!.after).not.toHaveProperty('delegated');

    const edit = await h.send('owner', 'PATCH', `/objectives/${o.id}`, {
      version: 2,
      text: 'Late',
    });
    expect([edit.status, code(edit)]).toEqual([409, 'INVALID_TRANSITION']);
    const reading = await h.send('owner', 'POST', `/objectives/${o.id}/readings`, {
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      value: 3.8,
    });
    expect([reading.status, code(reading)]).toEqual([409, 'INVALID_TRANSITION']);
    const readings = (await h.ok('owner', 'GET', `/objectives/${o.id}/readings`)).items as {
      id: string;
    }[];
    const correct = await h.send(
      'owner',
      'PATCH',
      `/objectives/${o.id}/readings/${readings[0]!.id}`,
      { version: 1, value: 3.4 },
    );
    expect([correct.status, code(correct)]).toEqual([409, 'INVALID_TRANSITION']);
    const again = await h.send('owner', 'POST', `/objectives/${o.id}/close`, {
      version: 2,
      closedOn: '2026-10-20',
      outcome: 'ACHIEVED',
    });
    expect([again.status, code(again)]).toEqual([409, 'INVALID_TRANSITION']);
  });

  it('marks a manager’s close as delegated, and needs a date from creation to today', async () => {
    const o = await objective();
    const future = await h.send('clientAdmin', 'POST', `/objectives/${o.id}/close`, {
      version: 1,
      closedOn: '2026-10-21',
      outcome: 'ACHIEVED',
    });
    expect([future.status, field(future)]).toEqual([400, ['closedOn']]);
    const before = await h.send('clientAdmin', 'POST', `/objectives/${o.id}/close`, {
      version: 1,
      closedOn: '2026-10-19',
      outcome: 'ACHIEVED',
    });
    expect([before.status, field(before)]).toEqual([400, ['closedOn']]);
    const approver = await h.send('approver', 'POST', `/objectives/${o.id}/close`, {
      version: 1,
      closedOn: '2026-10-20',
      outcome: 'ACHIEVED',
    });
    expect(approver.status).toBe(403);
    await h.ok('clientAdmin', 'POST', `/objectives/${o.id}/close`, {
      version: 1,
      closedOn: '2026-10-20',
      outcome: 'ACHIEVED',
    });
    expect((await audit(o.id)).find((e) => e.action === 'TRANSITION')!.after).toMatchObject({
      action: 'CLOSE',
      delegated: true,
    });
  });
});

describe('objective readings', () => {
  it('records, lists by period and corrects readings, each audited', async () => {
    const o = await objective();
    const path = `/objectives/${o.id}/readings`;
    const oct = await h.ok('owner', 'POST', path, {
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      value: 3.6,
    });
    const sep = await h.ok('owner', 'POST', path, {
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      value: 3.9,
      note: 'Meter replaced',
    });
    expect(oct).toMatchObject({ objectiveId: o.id, recordedById: h.f.people.owner, version: 1 });
    expect(
      ((await h.ok('viewer', 'GET', path)).items as { id: string }[]).map((r) => r.id),
    ).toEqual([sep.id, oct.id]);
    const fixed = await h.ok('clientAdmin', 'PATCH', `${path}/${oct.id}`, {
      version: 1,
      value: 3.5,
    });
    expect(fixed).toMatchObject({ value: 3.5, version: 2, periodStart: '2026-10-01' });
    expect((await audit(oct.id as string)).map((e) => e.action)).toEqual(['CREATE', 'UPDATE']);
    // Progress reads periods that have ended: September's.
    const progress = (await h.ok('owner', 'GET', `/objectives/${o.id}`)).progress;
    expect(progress).toMatchObject({ latestValue: 3.9 });
  });

  it('refuses a period not yet started and an overlapping period', async () => {
    const o = await objective();
    const path = `/objectives/${o.id}/readings`;
    const ahead = await h.send('owner', 'POST', path, {
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      value: 3,
    });
    expect([ahead.status, field(ahead)]).toEqual([400, ['periodStart']]);
    await h.ok('owner', 'POST', path, {
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      value: 3,
    });
    const overlap = await h.send('owner', 'POST', path, {
      periodStart: '2026-10-15',
      periodEnd: '2026-11-14',
      value: 3,
    });
    expect([overlap.status, field(overlap)]).toEqual([400, ['periodStart']]);
    const backwards = await h.send('owner', 'POST', path, {
      periodStart: '2026-09-30',
      periodEnd: '2026-09-01',
      value: 3,
    });
    expect([backwards.status, code(backwards)]).toEqual([400, 'VALIDATION']);
  });

  it('lets managers and the objective owner write, keeps unit scope, and refuses another objective’s reading', async () => {
    const o = await objective({ ownerId: h.f.people.clientAdmin });
    const path = `/objectives/${o.id}/readings`;
    const body = { periodStart: '2026-10-01', periodEnd: '2026-10-31', value: 3 };
    expect((await h.send('owner', 'POST', path, body)).status).toBe(403);
    expect((await h.send('approver', 'POST', path, body)).status).toBe(403);
    expect((await h.send('otherOwner', 'GET', path)).status).toBe(404);
    const reading = await h.ok('consultant', 'POST', path, body);
    const other = await objective();
    expect(
      (
        await h.send('clientAdmin', 'PATCH', `/objectives/${other.id}/readings/${reading.id}`, {
          version: 1,
          value: 2,
        })
      ).status,
    ).toBe(404);
  });
});
