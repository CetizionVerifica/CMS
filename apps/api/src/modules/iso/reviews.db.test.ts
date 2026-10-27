import { isoActions, isoCatalogue } from '@canopy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type Reply, type Who } from './testing/fixture.js';
import { seedAction, seedNc, setNcState } from './testing/records.js';

/**
 * Management reviews (model §1.9, §3.13, §4.5): PLAN with its rows, the PATCH and the replan route, every
 * MANAGEMENT_REVIEW arrow through the engine with its guards, input notes and output decisions, and the figures:
 * computed live while PLANNED, stored once at RECORD_HELD and never recomputed, each figure's ids cut for the reader,
 * and the INCIDENTS row withheld from a reader who may not read every incident it counts (model §3.13 item 4).
 */

const NOW = new Date('2026-10-20T06:00:00Z');
/** Systems and records are dated to this day, before the test's, so a review held on the test's day counts them. */
const CREATED = '2026-01-05T06:00:00Z';
let h: Harness;
/** Unit A only, on 9001 and 14001. */
let systemA: string;
/** Both units, on 9001 only. */
let systemAB: string;
/** Unit B only, on 9001 only. */
let systemB: string;

const backdate = (table: string, id: string, at = CREATED) =>
  h.testDb.query(`UPDATE ${table} SET created_at = $2 WHERE id = $1`, [id, at]);

beforeAll(async () => {
  h = await createHarness('Review', NOW);
  // Sourced inputs beside the fixture's PREVIOUS_ACTIONS (14001) and CUSTOMER_SATISFACTION (9001, MANUAL).
  await h.asSystem((tx) =>
    isoCatalogue.createReviewInputDefs(tx, [
      {
        standardId: h.f.std9001,
        key: 'RISKS_AND_OPPORTUNITIES',
        clauseNumber: '9.3.2',
        item: 'f',
        title: 'Risks and opportunities',
        source: 'RISKS',
      },
      {
        standardId: h.f.std9001,
        key: 'NONCONFORMITIES',
        clauseNumber: '9.3.2',
        item: 'c4',
        title: 'Nonconformities and corrective actions',
        source: 'NONCONFORMITIES',
      },
      {
        standardId: h.f.std9001,
        key: 'INCIDENTS',
        clauseNumber: '9.3.2',
        item: 'c5',
        title: 'Incidents',
        source: 'INCIDENTS',
      },
    ]),
  );
  const system = async (name: string, standardIds: string[], unitIds: string[]) => {
    const id = (await h.ok('clientAdmin', 'POST', '/systems', { name, standardIds, unitIds }))
      .id as string;
    await backdate('management_system', id);
    return id;
  };
  systemA = await system('Stonebridge system', [h.f.std9001, h.f.std14001], [h.f.unitA]);
  systemAB = await system('Both plants system', [h.f.std9001], [h.f.unitA, h.f.unitB]);
  systemB = await system('Highmoor system', [h.f.std9001], [h.f.unitB]);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const code = (reply: Reply) => (reply.body.error as { code?: string } | undefined)?.code;
const field = (reply: Reply) =>
  ((reply.body.error as { details?: { issues?: { path: unknown[] }[] } } | undefined)?.details
    ?.issues ?? [])[0]?.path;

const audit = (entityId: string) =>
  h.testDb.query<{
    action: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    reason: string | null;
  }>(
    'SELECT action, before, after, reason FROM audit_event WHERE entity_id = $1 ORDER BY at, action, after::text',
    [entityId],
  );

type Review = { id: string; version: number; state: string } & Record<string, unknown>;
type Input = {
  id: string;
  version: number;
  key: string;
  notes: string | null;
  sourceFigures: {
    asOf: string;
    since: string;
    figures: { key: string; value: number; ids: string[] }[];
  } | null;
  figuresStoredAt: string | null;
  figuresWithheld: boolean;
};

const PATH = (id: string) => `/management-reviews/${id}`;

/** The ids a review list returns. */
const listIds = async (who: Who, query = '') =>
  ((await h.ok(who, 'GET', `/management-reviews?limit=200${query}`)).items as { id: string }[]).map(
    (r) => r.id,
  );

async function plan(fields: Record<string, unknown> = {}, who: Who = 'clientAdmin') {
  const reply = await h.send(who, 'POST', '/management-reviews', {
    managementSystemId: systemAB,
    standards: ['ISO_9001'],
    plannedOn: '2026-10-20',
    chairId: h.f.people.clientAdmin,
    attendeeIds: [h.f.people.approver],
    ...fields,
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return reply.body as Review;
}

const inputs = async (id: string, who: Who = 'clientAdmin') =>
  (await h.ok(who, 'GET', `${PATH(id)}/inputs`)).items as unknown as Input[];
const outputs = async (id: string, who: Who = 'clientAdmin') =>
  (await h.ok(who, 'GET', `${PATH(id)}/outputs`)).items as unknown as {
    id: string;
    version: number;
    key: string;
  }[];
const inputOf = async (id: string, key: string, who: Who = 'clientAdmin') =>
  (await inputs(id, who)).find((i) => i.key === key)!;
const valueOf = (input: Input, key: string) =>
  input.sourceFigures!.figures.find((f) => f.key === key)!;

/** Notes on every input. */
async function noted(review: Review): Promise<Review> {
  for (const row of await inputs(review.id)) {
    await h.ok('clientAdmin', 'PATCH', `${PATH(review.id)}/inputs/${row.id}`, {
      version: row.version,
      notes: 'Discussed',
    });
  }
  return review;
}

async function held(review: Review, heldOn = '2026-10-20', who: Who = 'clientAdmin') {
  const reply = await h.send(who, 'POST', `${PATH(review.id)}/held`, {
    version: review.version,
    heldOn,
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body as Review;
}

const INCIDENT = {
  occurredAt: '2026-10-10T04:00:00Z',
  location: 'Press shop',
  type: 'INJURY' as const,
  outcome: 'FIRST_AID' as const,
  personCategory: null,
  lostDays: null,
  reportable: false,
  statutoryInstanceId: null,
  investigatorIds: [],
  workerParticipation: false,
};

/** An incident NC at `unitId`, owned and approved by people of that unit, dated before the test's day. */
async function incidentAt(systemId: string, unitId: string) {
  const unitB = unitId === h.f.unitB;
  const nc = await seedNc(h, systemId, {
    source: 'INCIDENT',
    unitId,
    incident: INCIDENT,
    ownerId: unitB ? h.f.people.otherOwner : h.f.people.owner,
    approverId: unitB ? h.f.people.approverB : h.f.people.approver,
  });
  await backdate('nonconformity', nc.id);
  return nc;
}

describe('planIsoManagementReview', () => {
  it('adds one row per key of its standards, audited as CREATE naming the keys', async () => {
    const review = await plan({
      managementSystemId: systemA,
      standards: ['ISO_14001', 'ISO_9001'],
    });
    expect(review).toMatchObject({
      standards: ['ISO_9001', 'ISO_14001'],
      state: 'PLANNED',
      heldOn: null,
      version: 1,
      allowedActions: ['CANCEL', 'RECORD_HELD'],
    });
    expect((await inputs(review.id)).map((i) => i.key)).toEqual([
      'PREVIOUS_ACTIONS',
      'RISKS_AND_OPPORTUNITIES',
      'CUSTOMER_SATISFACTION',
      'NONCONFORMITIES',
      'INCIDENTS',
    ]);
    expect((await outputs(review.id)).map((o) => o.key)).toEqual(['SUITABILITY']);
    const [event] = await audit(review.id);
    expect(event).toMatchObject({
      action: 'CREATE',
      after: {
        inputKeys: [
          'PREVIOUS_ACTIONS',
          'RISKS_AND_OPPORTUNITIES',
          'CUSTOMER_SATISFACTION',
          'NONCONFORMITIES',
          'INCIDENTS',
        ],
        outputKeys: ['SUITABILITY'],
      },
    });
    expect(event!.after).not.toHaveProperty('delegated');
    const byConsultant = await plan({}, 'consultant');
    expect((await audit(byConsultant.id))[0]!.after).toMatchObject({ delegated: true });
  });

  it('checks the standards and the people, and leaves planning to managers', async () => {
    const tries: [Record<string, unknown>, Who, number, unknown][] = [
      [{ standards: ['ISO_14001'] }, 'clientAdmin', 400, ['standards']],
      [{ chairId: h.f.people.viewer }, 'clientAdmin', 400, ['chairId']],
      [{ attendeeIds: [h.f.people.viewer] }, 'clientAdmin', 400, ['attendeeIds']],
      [{}, 'owner', 403, undefined],
      [{}, 'approver', 403, undefined],
      [{ managementSystemId: systemB }, 'owner', 404, undefined],
    ];
    for (const [fields, who, status, path] of tries) {
      const reply = await h.send(who, 'POST', '/management-reviews', {
        managementSystemId: systemAB,
        standards: ['ISO_9001'],
        plannedOn: '2026-11-20',
        chairId: h.f.people.clientAdmin,
        ...fields,
      });
      expect([JSON.stringify(fields), who, reply.status, field(reply)]).toEqual([
        JSON.stringify(fields),
        who,
        status,
        path,
      ]);
    }
  });
});

describe('reading reviews', () => {
  it('shows a plant-A owner none of a plant-B-only system', async () => {
    const review = await plan({ managementSystemId: systemB });
    expect(await listIds('owner')).not.toContain(review.id);
    for (const path of ['', '/inputs', '/outputs']) {
      expect((await h.send('owner', 'GET', `${PATH(review.id)}${path}`)).status).toBe(404);
    }
    expect((await h.send('otherOwner', 'GET', PATH(review.id))).status).toBe(200);
    // Named on it, the owner reads it.
    const named = await plan({ managementSystemId: systemB, attendeeIds: [h.f.people.owner] });
    expect((await h.send('owner', 'GET', PATH(named.id))).status).toBe(200);
  });

  it('lists by planned date, then creation, with q over the minutes and the system name', async () => {
    const later = await plan({ managementSystemId: systemB, plannedOn: '2027-02-01' });
    const earlier = await plan({ managementSystemId: systemB, plannedOn: '2027-01-15' });
    await h.ok('clientAdmin', 'PATCH', PATH(earlier.id), { version: 1, minutes: 'Kiln budget' });
    const ids = (query: string) => listIds('clientAdmin', query);
    const all = await ids(`&managementSystemId=${systemB}&from=2027-01-01`);
    expect(all).toEqual([earlier.id, later.id]);
    expect(await ids('&q=kiln')).toEqual([earlier.id]);
    expect(await ids('&q=highmoor&from=2027-01-01')).toEqual([earlier.id, later.id]);
  });
});

describe('updateIsoManagementReview', () => {
  it('lets the chair edit, not an attendee, until the review is final', async () => {
    const review = await plan({
      chairId: h.f.people.owner,
      attendeeIds: [h.f.people.otherOwner],
    });
    const edited = await h.ok('owner', 'PATCH', PATH(review.id), {
      version: 1,
      minutes: 'Agenda circulated',
    });
    expect(edited).toMatchObject({ minutes: 'Agenda circulated', version: 2 });
    const attendee = await h.send('otherOwner', 'PATCH', PATH(review.id), {
      version: 2,
      minutes: 'Changed',
    });
    expect(attendee.status).toBe(403);
    await h.ok('clientAdmin', 'POST', `${PATH(review.id)}/cancel`, {
      version: 2,
      reason: 'Merged with the next review',
    });
    const late = await h.send('clientAdmin', 'PATCH', PATH(review.id), {
      version: 3,
      minutes: 'Late',
    });
    expect([late.status, late.body.error]).toMatchObject([
      409,
      { details: { entity: 'management_review', from: 'CANCELLED', action: 'UPDATE' } },
    ]);
  });
});

describe('replanIsoManagementReview', () => {
  it('refuses the chair, an owner or approver, and needs a reason for a new date or chair', async () => {
    const review = await plan({ chairId: h.f.people.approver });
    for (const who of ['approver', 'owner'] as const) {
      const reply = await h.send(who, 'POST', `${PATH(review.id)}/replan`, {
        version: 1,
        plannedOn: '2026-12-01',
        reason: 'Auditor availability',
      });
      expect([who, reply.status]).toEqual([who, 403]);
    }
    const bare = await h.send('clientAdmin', 'POST', `${PATH(review.id)}/replan`, {
      version: 1,
      plannedOn: '2026-12-01',
    });
    expect([bare.status, code(bare)]).toEqual([422, 'REASON_REQUIRED']);
    const moved = await h.ok('clientAdmin', 'POST', `${PATH(review.id)}/replan`, {
      version: 1,
      plannedOn: '2026-12-01',
      chairId: h.f.people.clientAdmin,
      reason: 'Auditor availability',
    });
    expect(moved).toMatchObject({ plannedOn: '2026-12-01', chairId: h.f.people.clientAdmin });
    const events = (await audit(review.id)).filter((e) => e.action !== 'CREATE');
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          action: 'DUE_DATE_CHANGE',
          before: { plannedOn: '2026-10-20' },
          after: { plannedOn: '2026-12-01' },
          reason: 'Auditor availability',
        },
        {
          action: 'REASSIGN',
          before: { chairId: h.f.people.approver },
          after: { chairId: h.f.people.clientAdmin },
          reason: 'Auditor availability',
        },
      ]),
    );
  });

  it('drops a standard and adds it back, naming the keys in the UPDATE', async () => {
    const review = await plan({
      managementSystemId: systemA,
      standards: ['ISO_9001', 'ISO_14001'],
    });
    const first = await inputOf(review.id, 'PREVIOUS_ACTIONS');
    const dropped = await h.ok('clientAdmin', 'POST', `${PATH(review.id)}/replan`, {
      version: 1,
      standards: ['ISO_9001'],
    });
    expect((await inputs(review.id)).map((i) => i.key)).not.toContain('PREVIOUS_ACTIONS');
    const back = await h.ok('clientAdmin', 'POST', `${PATH(review.id)}/replan`, {
      version: dropped.version,
      standards: ['ISO_14001', 'ISO_9001'],
    });
    expect(back).toMatchObject({ standards: ['ISO_9001', 'ISO_14001'] });
    const again = await inputOf(review.id, 'PREVIOUS_ACTIONS');
    expect(again.id).not.toBe(first.id);
    expect(again.notes).toBeNull();
    const updates = (await audit(review.id)).filter((e) => e.action === 'UPDATE');
    expect(updates.map((e) => e.after)).toEqual(
      expect.arrayContaining([
        { standards: ['ISO_9001'], inputKeysRemoved: ['PREVIOUS_ACTIONS'] },
        { standards: ['ISO_9001', 'ISO_14001'], inputKeysAdded: ['PREVIOUS_ACTIONS'] },
      ]),
    );
    // Not a standard of the system.
    const reply = await h.send('clientAdmin', 'POST', `${PATH(review.id)}/replan`, {
      version: back.version,
      standards: ['ISO_45001'],
    });
    expect([reply.status, field(reply)]).toEqual([400, ['standards']]);
  });

  it('is only for a PLANNED review', async () => {
    const review = await held(await noted(await plan()));
    const reply = await h.send('clientAdmin', 'POST', `${PATH(review.id)}/replan`, {
      version: review.version,
      plannedOn: '2026-12-01',
      reason: 'Too late',
    });
    expect([reply.status, reply.body.error]).toMatchObject([
      409,
      { details: { entity: 'management_review', from: 'HELD', action: 'UPDATE' } },
    ]);
  });
});

describe('recordIsoManagementReviewHeld', () => {
  it('needs a day not after today, attendees and notes on every input', async () => {
    const review = await plan({ attendeeIds: [] });
    const tries: [Record<string, unknown>, unknown][] = [
      [{ heldOn: '2026-10-21', attendeeIds: [h.f.people.approver] }, ['heldOn']],
      [{ heldOn: '2026-10-20' }, ['attendeeIds']],
      [{ heldOn: '2026-10-20', attendeeIds: [h.f.people.approver] }, ['inputs']],
    ];
    for (const [fields, path] of tries) {
      const reply = await h.send('clientAdmin', 'POST', `${PATH(review.id)}/held`, {
        version: 1,
        ...fields,
      });
      expect([JSON.stringify(fields), reply.status, field(reply)]).toEqual([
        JSON.stringify(fields),
        400,
        path,
      ]);
    }
    expect((await audit(review.id)).map((e) => e.action)).toEqual(['CREATE']);
  });

  it('stores the figures once, and a held review keeps them whatever changes after', async () => {
    const review = await plan();
    const nc = await seedNc(h, systemAB, { unitId: h.f.unitA });
    await backdate('nonconformity', nc.id);
    const risk = await h.ok('clientAdmin', 'POST', '/risks', {
      managementSystemId: systemAB,
      ownerId: h.f.people.owner,
      kind: 'RISK',
      activity: 'Packaging supply',
      description: 'One supplier makes every carton',
      likelihood: 2,
      severity: 3,
    });
    const gone = await h.ok('clientAdmin', 'POST', '/risks', {
      managementSystemId: systemAB,
      ownerId: h.f.people.owner,
      kind: 'OPPORTUNITY',
      activity: 'Solar roof',
      description: 'Roof space for panels',
      likelihood: 4,
      severity: 4,
    });
    await backdate('risk_item', risk.id as string);
    await backdate('risk_item', gone.id as string);

    // PLANNED: computed on each read, nothing stored.
    const live = await inputOf(review.id, 'NONCONFORMITIES');
    expect(live.figuresStoredAt).toBeNull();
    expect(valueOf(live, 'open').ids).toContain(nc.id);

    const done = await held(await noted(review));
    expect(done).toMatchObject({ state: 'HELD', heldOn: '2026-10-20', version: 2 });
    const stored = await inputs(review.id);
    for (const row of stored.filter((r) => r.key !== 'CUSTOMER_SATISFACTION')) {
      // Stored when the step ran (the database's clock).
      expect([row.key, row.figuresStoredAt, row.sourceFigures?.asOf]).toEqual([
        row.key,
        expect.any(String),
        '2026-10-20',
      ]);
    }
    expect((await inputOf(review.id, 'CUSTOMER_SATISFACTION')).sourceFigures).toBeNull();

    // An NC it counted closes, a risk is re-rated and another archived: the stored copy stands.
    await setNcState(h, nc, 'CLOSED');
    await h.ok('clientAdmin', 'PATCH', `/risks/${risk.id}`, {
      version: risk.version,
      likelihood: 5,
      severity: 5,
    });
    await h.ok('clientAdmin', 'POST', `/risks/${gone.id}/archive`, {
      version: gone.version,
      reason: 'Roof sold',
    });
    expect(await inputs(review.id)).toEqual(stored);

    // Stored once: the step is not taken again.
    const again = await h.send('clientAdmin', 'POST', `${PATH(review.id)}/held`, {
      version: 2,
      heldOn: '2026-10-20',
    });
    expect([again.status, code(again)]).toEqual([409, 'INVALID_TRANSITION']);
    const [event] = (await audit(review.id)).filter((e) => e.action === 'TRANSITION');
    expect(event!.after).toMatchObject({
      action: 'RECORD_HELD',
      engineVersion: expect.any(String),
      figures: expect.arrayContaining([
        expect.objectContaining({
          key: 'NONCONFORMITIES',
          source: 'NONCONFORMITIES',
          asOf: '2026-10-20',
          values: expect.objectContaining({ open: valueOf(stored[2]!, 'open').value }),
        }),
      ]),
    });
  });

  it('counts a backdated review up to its heldOn, and stores none before the system began', async () => {
    const backdated = await held(await noted(await plan()), '2026-09-30');
    const row = await inputOf(backdated.id, 'NONCONFORMITIES');
    expect(row.sourceFigures).toMatchObject({ asOf: '2026-09-30' });
    expect(row.figuresStoredAt).toEqual(expect.any(String));

    const before = await held(await noted(await plan()), '2026-01-04');
    for (const r of await inputs(before.id)) {
      expect([r.key, r.sourceFigures, r.figuresStoredAt]).toEqual([r.key, null, null]);
    }
    const [event] = (await audit(before.id)).filter((e) => e.action === 'TRANSITION');
    expect(event!.after).toMatchObject({ figures: [], engineVersion: expect.any(String) });
  });
});

describe('figures for each reader', () => {
  it('gives a unit-limited reader and a chair outside the units the system values with ids cut', async () => {
    const system = (
      await h.ok('clientAdmin', 'POST', '/systems', {
        name: 'Riverbend system',
        standardIds: [h.f.std9001],
        unitIds: [h.f.unitA],
      })
    ).id as string;
    await backdate('management_system', system);
    const nc = await incidentAt(system, h.f.unitA);
    const review = await held(
      await noted(
        await plan({
          managementSystemId: system,
          chairId: h.f.people.approverB,
          attendeeIds: [h.f.people.clientAdmin],
        }),
      ),
    );
    const mine = await inputOf(review.id, 'INCIDENTS', 'owner');
    expect(valueOf(mine, 'incidents')).toMatchObject({ value: 1, ids: [nc.id] });
    // The chair reads the review (named on it) but not the unit A incident: the value stays, the ids go.
    const chair = await inputOf(review.id, 'INCIDENTS', 'approverB');
    expect(chair.figuresWithheld).toBe(false);
    expect(chair.notes).toBe('Discussed');
    expect(valueOf(chair, 'incidents')).toMatchObject({ value: 1, ids: [] });
    expect(
      valueOf(await inputOf(review.id, 'NONCONFORMITIES', 'approverB'), 'raised'),
    ).toMatchObject({ value: 1, ids: [] });
  });

  it('withholds the INCIDENTS row from a reader who cannot read an incident it counts, but not from the chair or an attendee', async () => {
    // One system per review: a review held earlier on the same system would start the next one's window.
    const systems: string[] = [];
    const review = async (fields: Record<string, unknown>) => {
      const system = (
        await h.ok('clientAdmin', 'POST', '/systems', {
          name: `Kestrelganj system ${systems.length + 1}`,
          standardIds: [h.f.std9001],
          unitIds: [h.f.unitA, h.f.unitB],
        })
      ).id as string;
      systems.push(system);
      await backdate('management_system', system);
      await incidentAt(system, h.f.unitB);
      return held(await noted(await plan({ managementSystemId: system, ...fields })));
    };
    const plain = await review({});
    const chaired = await review({ chairId: h.f.people.owner });
    const attended = await review({ attendeeIds: [h.f.people.owner] });

    // `reader`: one who reads every incident counted (after the narrowing, the unit B owner no longer sees the system).
    const check = async (reader: Who) => {
      const withheld = await inputOf(plain.id, 'INCIDENTS', 'owner');
      expect(withheld).toMatchObject({ figuresWithheld: true, sourceFigures: null, notes: null });
      // Other inputs keep their values with the ids cut.
      expect(valueOf(await inputOf(plain.id, 'NONCONFORMITIES', 'owner'), 'raised')).toMatchObject({
        value: 1,
        ids: [],
      });
      for (const id of [chaired.id, attended.id]) {
        const shown = await inputOf(id, 'INCIDENTS', 'owner');
        expect(shown).toMatchObject({ figuresWithheld: false, notes: 'Discussed' });
        expect(valueOf(shown, 'incidents')).toMatchObject({ value: 1, ids: [] });
      }
      const full = await inputOf(plain.id, 'INCIDENTS', reader);
      expect(full.figuresWithheld).toBe(false);
      expect(valueOf(full, 'incidents').ids).toHaveLength(1);
    };
    await check('otherOwner');

    // The systems narrowed to unit A: the incident at unit B stays out of the owner's reach.
    for (const system of systems) {
      const current = await h.ok('clientAdmin', 'GET', `/systems/${system}`);
      await h.ok('clientAdmin', 'PATCH', `/systems/${system}`, {
        version: current.version,
        unitIds: [h.f.unitA],
      });
    }
    expect((await h.send('otherOwner', 'GET', PATH(plain.id))).status).toBe(404);
    await check('viewer');
  });
});

describe('input notes and output decisions', () => {
  it('keeps notes on every input of a held review, audited on the review', async () => {
    const review = await held(await noted(await plan()));
    const row = await inputOf(review.id, 'NONCONFORMITIES');
    const cleared = await h.send('clientAdmin', 'PATCH', `${PATH(review.id)}/inputs/${row.id}`, {
      version: row.version,
      notes: null,
    });
    expect([cleared.status, field(cleared)]).toEqual([400, ['notes']]);
    const edited = await h.ok('clientAdmin', 'PATCH', `${PATH(review.id)}/inputs/${row.id}`, {
      version: row.version,
      notes: 'Two repeat findings',
    });
    expect(edited).toMatchObject({ notes: 'Two repeat findings', version: row.version + 1 });
    // Storing the figures did not move the version the notes were read with.
    expect(row.version).toBe(2);
    expect((await audit(review.id)).at(-1)).toMatchObject({
      action: 'UPDATE',
      before: { input: 'NONCONFORMITIES', notes: 'Discussed' },
      after: { input: 'NONCONFORMITIES', notes: 'Two repeat findings' },
    });
    // Another review's row is not this review's.
    const other = await plan();
    const foreign = await h.send('clientAdmin', 'PATCH', `${PATH(other.id)}/inputs/${row.id}`, {
      version: 3,
      notes: 'x',
    });
    expect(foreign.status).toBe(404);
  });
});

describe('closeIsoManagementReview', () => {
  it('needs a decision on every output and every review action settled', async () => {
    const review = await held(await noted(await plan()));
    const close = (version: number) =>
      h.send('clientAdmin', 'POST', `${PATH(review.id)}/close`, { version });
    const undecided = await close(2);
    expect([undecided.status, field(undecided)]).toEqual([400, ['outputs']]);
    const [output] = await outputs(review.id);
    await h.ok('clientAdmin', 'PATCH', `${PATH(review.id)}/outputs/${output!.id}`, {
      version: output!.version,
      decision: 'Keep the scope',
    });
    const action = await seedAction(h, { type: 'MANAGEMENT_REVIEW', id: review.id });
    const open = await close(2);
    expect([open.status, field(open)]).toEqual([400, ['actions']]);
    await h.asSystem((tx) =>
      isoActions.update(tx, action.id, action.version, {
        state: 'DONE',
        doneOn: '2026-10-19' as never,
      }),
    );
    // The owner neither chairs it nor manages it.
    expect((await h.send('owner', 'POST', `${PATH(review.id)}/close`, { version: 2 })).status).toBe(
      403,
    );
    expect(
      await h.ok('clientAdmin', 'POST', `${PATH(review.id)}/close`, { version: 2 }),
    ).toMatchObject({ state: 'CLOSED', allowedActions: [] });
    const late = await h.send('clientAdmin', 'PATCH', `${PATH(review.id)}/outputs/${output!.id}`, {
      version: output!.version + 1,
      decision: 'Changed',
    });
    expect(late.status).toBe(409);
  });

  it('cancels with a reason, after which the inputs have no figures', async () => {
    const review = await plan();
    const bare = await h.send('clientAdmin', 'POST', `${PATH(review.id)}/cancel`, { version: 1 });
    expect([bare.status, code(bare)]).toEqual([422, 'REASON_REQUIRED']);
    const cancelled = await h.ok('consultant', 'POST', `${PATH(review.id)}/cancel`, {
      version: 1,
      reason: 'Merged with the next review',
    });
    expect(cancelled).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'Merged with the next review',
    });
    expect((await audit(review.id)).at(-1)).toMatchObject({
      action: 'TRANSITION',
      after: { action: 'CANCEL', state: 'CANCELLED', delegated: true },
      reason: 'Merged with the next review',
    });
    for (const row of await inputs(review.id)) expect(row.sourceFigures).toBeNull();
  });
});
