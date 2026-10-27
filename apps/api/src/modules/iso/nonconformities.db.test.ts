import { randomUUID } from 'node:crypto';
import { clients, nonconformities } from '@canopy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attach, createHarness, type Harness, type Reply, type Who } from './testing/fixture.js';
import {
  seedAction,
  seedConsultant,
  seedFinding,
  seedInstance,
  seedNc,
  seedOtherClientRisk,
  setNcState,
} from './testing/records.js';

/**
 * Nonconformities, incidents and near misses (model §3.10, §3.11, §4.1): RAISE and every arrow through the engine,
 * maker-checker, the investigation PATCH and the reassign route with their refusals, the incident rules in the
 * client's time zone, `ids` and the other list filters, unit scope (plan §3.3), files with their lock and the incident
 * download rule (model §6), and the audit trail with no free text (model §8, non-negotiable 6).
 */

const NOW = new Date('2026-10-20T06:00:00Z');
let h: Harness;
/** Unit A only, on 9001 and 14001. */
let systemA: string;
/** Unit B only. */
let systemB: string;
/** Both units. */
let systemAB: string;

beforeAll(async () => {
  h = await createHarness('Nc', NOW);
  const system = async (name: string, unitIds: string[]) =>
    (
      await h.ok('clientAdmin', 'POST', '/systems', {
        name,
        standardIds: [h.f.std9001, h.f.std14001],
        unitIds,
      })
    ).id as string;
  systemA = await system('Stonebridge system', [h.f.unitA]);
  systemB = await system('Highmoor system', [h.f.unitB]);
  systemAB = await system('Both plants system', [h.f.unitA, h.f.unitB]);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const code = (reply: Reply) => (reply.body.error as { code?: string } | undefined)?.code;
const details = (reply: Reply) =>
  (reply.body.error as { details?: Record<string, unknown> } | undefined)?.details;
const field = (reply: Reply) =>
  (details(reply)?.issues as { path: unknown[] }[] | undefined)?.[0]?.path;

const audit = (entityId: string) =>
  h.testDb.query<{
    action: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    reason: string | null;
    actor_id: string | null;
  }>(
    'SELECT action, before, after, reason, actor_id FROM audit_event WHERE entity_id = $1 ORDER BY at, action, after::text, reason',
    [entityId],
  );

type Nc = { id: string; version: number; state: string } & Record<string, unknown>;

const INCIDENT = {
  occurredAt: '2026-10-19T04:00:00Z',
  location: 'Press shop',
  type: 'INJURY',
  outcome: 'FIRST_AID',
  reportable: false,
};

const raiseBody = (fields: Record<string, unknown> = {}) => ({
  managementSystemId: systemA,
  source: 'PROCESS',
  severity: 'MINOR',
  standards: ['ISO_9001'],
  clauseIds: [h.f.clauses['9001:10.1']],
  unitId: h.f.unitA,
  description: 'Calibration record missing',
  ownerId: h.f.people.owner,
  approverId: h.f.people.approver,
  dueOn: '2026-11-30',
  ...fields,
});

const tryRaise = (fields: Record<string, unknown> = {}, who: Who = 'clientAdmin') =>
  h.send(who, 'POST', '/nonconformities', raiseBody(fields));

async function raise(fields: Record<string, unknown> = {}, who: Who = 'clientAdmin') {
  const reply = await tryRaise(fields, who);
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return reply.body as Nc;
}

const get = async (id: string, who: Who = 'clientAdmin') =>
  (await h.ok(who, 'GET', `/nonconformities/${id}`)) as Nc;

const step = (id: string, path: string, body: object, who: Who = 'owner') =>
  h.send(who, 'POST', `/nonconformities/${id}/${path}`, body);

async function ok(id: string, path: string, body: object, who: Who = 'owner') {
  const reply = await step(id, path, body, who);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body as Nc;
}

const ROOT_CAUSE = {
  containment: 'Quarantined the batch',
  correction: 'Recalibrated the gauge',
  rootCauseMethod: 'FIVE_WHYS',
  rootCause: 'No calibration schedule',
  similarOccurrences: 'None found',
};

/** An NC through ADD_ROOT_CAUSE (as its owner). */
async function withRootCause(fields: Record<string, unknown> = {}) {
  const nc = await raise(fields);
  return ok(nc.id, 'root-cause', { version: nc.version, ...ROOT_CAUSE });
}

const ncAction = (id: string, fields = {}) =>
  h.ok('clientAdmin', 'POST', '/actions', {
    subject: { type: 'NONCONFORMITY', id },
    text: 'Add the gauge to the calibration plan',
    ownerId: h.f.people.owner,
    dueOn: '2026-11-15',
    ...fields,
  }) as Promise<Nc>;

const completeAction = (action: Nc) =>
  h.ok('owner', 'POST', `/actions/${action.id}/complete`, {
    version: action.version,
    doneOn: '2026-10-20',
  });

/** An NC through PLAN_ACTIONS and SUBMIT, effectiveness due today: ready for the approver. */
async function awaiting() {
  const nc = await withRootCause();
  const action = await ncAction(nc.id);
  const planned = await ok(nc.id, 'plan-actions', {
    version: nc.version,
    effectivenessDueOn: '2026-10-20',
  });
  await completeAction(action);
  return ok(nc.id, 'submit', {
    version: planned.version,
    riskReview: 'No change',
    systemChange: 'None needed',
  });
}

describe('raiseIsoNonconformity', () => {
  it('raises an OPEN NC numbered by the database, reported on the client day, audited without its text', async () => {
    const nc = await raise({}, 'owner');
    expect(nc).toMatchObject({
      state: 'OPEN',
      reportedById: h.f.people.owner,
      reportedOn: '2026-10-20',
      findingId: null,
      status: { timing: 'ON_TIME' },
    });
    expect(typeof nc.number).toBe('number');
    const next = await raise();
    expect(next.number).toBe((nc.number as number) + 1);
    const events = await audit(nc.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'CREATE',
      after: { action: 'RAISE', number: nc.number },
    });
    expect(JSON.stringify(events[0])).not.toContain('Calibration record missing');
  });

  it('is refused to a viewer, and for a unit the raiser does not cover', async () => {
    expect(code(await tryRaise({}, 'viewer'))).toBe('FORBIDDEN');
    const other = await tryRaise({ managementSystemId: systemB, unitId: h.f.unitB }, 'owner');
    expect(other.status).toBe(404);
    const inA = await tryRaise({ unitId: h.f.unitB }, 'owner');
    expect([403, 400]).toContain(inA.status);
  });

  it('refuses an audit source by hand, a past due date, the owner as approver, and the wrong people', async () => {
    expect(field(await tryRaise({ source: 'INTERNAL_AUDIT' }))).toEqual(['source']);
    expect(field(await tryRaise({ dueOn: '2026-10-19' }))).toEqual(['dueOn']);
    expect(field(await tryRaise({ approverId: h.f.people.owner }))).toEqual(['approverId']);
    // The owner owns: an approver cannot; the approver approves: an owner cannot.
    expect(
      field(await tryRaise({ ownerId: h.f.people.approver, approverId: h.f.people.clientAdmin })),
    ).toEqual(['ownerId']);
    expect(field(await tryRaise({ approverId: h.f.people.otherOwner }))).toEqual(['approverId']);
    // The owner of unit B does not cover unit A.
    expect(field(await tryRaise({ ownerId: h.f.people.otherOwner }))).toEqual(['ownerId']);
  });

  it("refuses standards that are not the system's and clauses of other standards", async () => {
    const system = (
      await h.ok('clientAdmin', 'POST', '/systems', {
        name: 'Quality only',
        standardIds: [h.f.std9001],
        unitIds: [h.f.unitA],
      })
    ).id as string;
    expect(
      field(
        await tryRaise({ managementSystemId: system, standards: ['ISO_14001'], clauseIds: [] }),
      ),
    ).toEqual(['standards']);
    expect(field(await tryRaise({ clauseIds: [h.f.clauses['14001:4.1']] }))).toEqual(['clauseIds']);
  });

  it('takes an incident with a unit, and refuses one dated after now', async () => {
    const nc = await raise({ source: 'INCIDENT', incident: INCIDENT });
    expect(nc.incident).toMatchObject({
      type: 'INJURY',
      outcome: 'FIRST_AID',
      investigatorIds: [],
    });
    const events = await audit(nc.id);
    expect(events[0]!.after).toMatchObject({ incident: { type: 'INJURY', outcome: 'FIRST_AID' } });
    expect(JSON.stringify(events[0])).not.toContain('Press shop');
    const late = await tryRaise({
      source: 'INCIDENT',
      incident: { ...INCIDENT, occurredAt: '2026-10-20T07:00:00Z' },
    });
    expect(field(late)).toEqual(['incident.occurredAt']);
    expect(field(await tryRaise({ source: 'INCIDENT', incident: INCIDENT, unitId: null }))).toEqual(
      ['unitId'],
    );
    expect(
      field(
        await tryRaise({
          source: 'NEAR_MISS',
          incident: { ...INCIDENT, type: 'NEAR_MISS', outcome: 'NONE' },
        }),
      ),
    ).toBeUndefined();
  });

  it("links the statutory notice only to a statutory instance on the NC's unit", async () => {
    const onA = await seedInstance(h, h.f.unitA);
    const onB = await seedInstance(h, h.f.unitB);
    const activity = await seedInstance(h, h.f.unitA, { standard: true });
    const withNotice = (statutoryInstanceId: string) =>
      tryRaise({
        source: 'INCIDENT',
        incident: { ...INCIDENT, reportable: true, statutoryInstanceId },
      });
    expect((await withNotice(onA)).status).toBe(201);
    expect(field(await withNotice(onB))).toEqual(['incident.statutoryInstanceId']);
    expect(field(await withNotice(activity))).toEqual(['incident.statutoryInstanceId']);
    expect((await tryRaise({ sourceInstanceId: activity })).status).toBe(201);
  });

  it('names people of the client through the role lookup: a consultant as investigator, not a disabled, archived or other one', async () => {
    const consultant = await seedConsultant(h);
    const disabled = await seedConsultant(h, { status: 'DISABLED' });
    const archived = await seedConsultant(h, { archived: true });
    const elsewhere = await seedConsultant(h, {
      clientIds: [(await seedOtherClientRisk(h)).clientId],
    });
    const investigate = (id: string) =>
      tryRaise({ source: 'INCIDENT', incident: { ...INCIDENT, investigatorIds: [id] } });
    expect((await investigate(consultant)).status).toBe(201);
    for (const id of [disabled, archived, elsewhere]) {
      expect(field(await investigate(id))).toEqual(['incident.investigatorIds']);
    }
  });
});

describe('the client time zone', () => {
  it("places an incident on the client's day, not the server's or India's", async () => {
    const nc = await seedNc(h, systemA, {
      unitId: h.f.unitA,
      source: 'INCIDENT',
      reportedOn: '2026-10-19' as never,
      incident: {
        ...INCIDENT,
        personCategory: null,
        lostDays: null,
        statutoryInstanceId: null,
        investigatorIds: [],
        workerParticipation: false,
      } as never,
    });
    // 20:00 UTC on the 19th is the 20th in Kolkata, after the NC was reported.
    const patch = (version: number) =>
      h.send('owner', 'PATCH', `/nonconformities/${nc.id}`, {
        version,
        incident: { occurredAt: '2026-10-19T20:00:00Z' },
      });
    expect(field(await patch(nc.version))).toEqual(['incident.occurredAt']);
    const client = await h.asSystem((tx) => clients.require(tx, h.f.clientId));
    const setZone = (timeZone: string) =>
      h.asSystem(async (tx) => {
        const current = await clients.require(tx, h.f.clientId);
        await clients.update(tx, current.id, current.version, {
          settings: { ...current.settings, timeZone },
        });
      });
    await setZone('Europe/London');
    try {
      // In London it is still the 19th: allowed.
      expect((await patch(nc.version)).status).toBe(200);
    } finally {
      await setZone(client.settings.timeZone);
    }
  });
});

describe('the nonconformity machine', () => {
  it('ADD_ROOT_CAUSE needs the investigation, and for an incident a risk review', async () => {
    const nc = await raise();
    const missing = await step(nc.id, 'root-cause', {
      version: nc.version,
      containment: 'Quarantined',
    });
    expect(code(missing)).toBe('VALIDATION');
    const incident = await raise({ source: 'INCIDENT', incident: INCIDENT });
    const noReview = await step(incident.id, 'root-cause', {
      version: incident.version,
      ...ROOT_CAUSE,
    });
    expect(field(noReview)).toEqual(['relatedRiskItemIds']);
    const done = await ok(incident.id, 'root-cause', {
      version: incident.version,
      ...ROOT_CAUSE,
      riskReview: 'No change to the hazard register',
    });
    expect(done.state).toBe('ROOT_CAUSE_FOUND');
    const events = await audit(incident.id);
    expect(events.at(-1)).toMatchObject({
      action: 'TRANSITION',
      after: { action: 'ADD_ROOT_CAUSE', state: 'ROOT_CAUSE_FOUND' },
    });
    expect(events.at(-1)!.after!.delegated).toBeUndefined();
  });

  it('records a disposition with who authorised it, no later than ADD_ROOT_CAUSE', async () => {
    const nc = await raise();
    const alone = await step(nc.id, 'root-cause', {
      version: nc.version,
      ...ROOT_CAUSE,
      disposition: 'SEGREGATION',
    });
    expect(field(alone)).toEqual(['dispositionAuthorisedById']);
    const done = await ok(nc.id, 'root-cause', {
      version: nc.version,
      ...ROOT_CAUSE,
      disposition: 'SEGREGATION',
      dispositionAuthorisedById: h.f.people.approver,
    });
    const late = await h.send('owner', 'PATCH', `/nonconformities/${nc.id}`, {
      version: done.version,
      disposition: 'CONCESSION',
    });
    expect(field(late)).toEqual(['disposition']);
  });

  it('PLAN_ACTIONS needs an OPEN action and an effectiveness date not past', async () => {
    const nc = await withRootCause();
    const none = await step(nc.id, 'plan-actions', {
      version: nc.version,
      effectivenessDueOn: '2026-12-01',
    });
    expect(field(none)).toEqual(['actions']);
    await ncAction(nc.id);
    const past = await step(nc.id, 'plan-actions', {
      version: nc.version,
      effectivenessDueOn: '2026-10-19',
    });
    expect(field(past)).toEqual(['effectivenessDueOn']);
    const planned = await ok(nc.id, 'plan-actions', {
      version: nc.version,
      effectivenessDueOn: '2026-12-01',
    });
    expect(planned).toMatchObject({ state: 'ACTIONS_PLANNED', effectivenessDueOn: '2026-12-01' });
    expect(planned.allowedActions).toEqual(['SUBMIT']);
    expect((await get(nc.id, 'viewer')).allowedActions).toEqual([]);
    expect((await get(nc.id, 'approver')).allowedActions).toEqual(['CANCEL']);
  });

  it('SUBMIT needs every action settled and one done; then the approver verifies, never a maker', async () => {
    const nc = await withRootCause();
    const action = await ncAction(nc.id);
    const planned = await ok(nc.id, 'plan-actions', {
      version: nc.version,
      effectivenessDueOn: '2026-10-20',
    });
    const open = await step(nc.id, 'submit', {
      version: planned.version,
      riskReview: 'None',
      systemChange: 'None',
    });
    expect(field(open)).toEqual(['actions']);
    await completeAction(action);
    const noReview = await step(nc.id, 'submit', { version: planned.version });
    expect(field(noReview)).toEqual(['riskReview']);
    const submitted = await ok(nc.id, 'submit', {
      version: planned.version,
      riskReview: 'None',
      systemChange: 'None',
    });
    expect(submitted.state).toBe('AWAITING_VERIFICATION');
    expect((await get(nc.id, 'approver')).allowedActions).toEqual([
      'VERIFY_EFFECTIVE',
      'VERIFY_NOT_EFFECTIVE',
      'CANCEL',
    ]);
    expect(
      code(
        await step(
          nc.id,
          'verify-effective',
          { version: submitted.version, effectivenessNote: 'No repeat' },
          'owner',
        ),
      ),
    ).toBe('FORBIDDEN');
    const closed = await ok(
      nc.id,
      'verify-effective',
      { version: submitted.version, effectivenessNote: 'No repeat in a month' },
      'approver',
    );
    expect(closed).toMatchObject({ state: 'CLOSED', effective: true, closedOn: '2026-10-20' });
    expect(closed.status).toMatchObject({ timing: 'CLOSED' });
  });

  it('keeps maker-checker: a client admin who took a maker step does not verify', async () => {
    const nc = await raise();
    const found = await ok(
      nc.id,
      'root-cause',
      { version: nc.version, ...ROOT_CAUSE },
      'clientAdmin',
    );
    const events = await audit(nc.id);
    expect(events.at(-1)!.after).toMatchObject({ action: 'ADD_ROOT_CAUSE', delegated: true });
    const submitted = await ok(nc.id, 'submit-no-action', {
      version: found.version,
      noActionReason: 'One-off',
      riskReview: 'None',
      systemChange: 'None',
    });
    const refused = await step(
      nc.id,
      'verify-effective',
      { version: submitted.version, effectivenessNote: 'Fine' },
      'clientAdmin',
    );
    expect(code(refused)).toBe('FORBIDDEN');
    expect((await get(nc.id, 'clientAdmin')).allowedActions).toEqual(['CANCEL']);
    const other = await ok(
      nc.id,
      'verify-effective',
      { version: submitted.version, effectivenessNote: 'Fine' },
      'otherAdmin',
    );
    expect(other.state).toBe('CLOSED');
    expect((await audit(nc.id)).at(-1)!.after).toMatchObject({
      action: 'VERIFY_EFFECTIVE',
      delegated: true,
    });
  });

  it('VERIFY_EFFECTIVE waits for the effectiveness date; VERIFY_NOT_EFFECTIVE does not', async () => {
    const nc = await withRootCause();
    const action = await ncAction(nc.id);
    const planned = await ok(nc.id, 'plan-actions', {
      version: nc.version,
      effectivenessDueOn: '2026-11-01',
    });
    await completeAction(action);
    const submitted = await ok(nc.id, 'submit', {
      version: planned.version,
      riskReview: 'None',
      systemChange: 'None',
    });
    expect((await get(nc.id, 'approver')).allowedActions).toEqual([
      'VERIFY_NOT_EFFECTIVE',
      'CANCEL',
    ]);
    const early = await step(
      nc.id,
      'verify-effective',
      { version: submitted.version, effectivenessNote: 'Fine' },
      'approver',
    );
    expect(field(early)).toEqual(['effectivenessDueOn']);
    const back = await ok(
      nc.id,
      'verify-not-effective',
      { version: submitted.version, reason: 'The gauge drifted again', backTo: 'OPEN' },
      'approver',
    );
    expect(back).toMatchObject({ state: 'OPEN', effective: false, effectivenessDueOn: null });
    const events = await audit(nc.id);
    expect(events.at(-1)).toMatchObject({
      reason: 'The gauge drifted again',
      after: { action: 'VERIFY_NOT_EFFECTIVE' },
    });
    // Found not effective, it needs corrective actions: no SUBMIT_NO_ACTION any more.
    const again = await ok(nc.id, 'root-cause', { version: back.version, ...ROOT_CAUSE });
    expect(again.allowedActions).toEqual(['PLAN_ACTIONS']);
    const noAction = await step(nc.id, 'submit-no-action', {
      version: again.version,
      noActionReason: 'One-off',
      riskReview: 'None',
      systemChange: 'None',
    });
    expect(field(noAction)).toEqual(['effective']);
  });

  it('refuses SUBMIT_NO_ACTION for a MAJOR NC, and for a lost-time incident', async () => {
    const body = (nc: Nc) => ({
      version: nc.version,
      noActionReason: 'One-off',
      riskReview: 'None',
      systemChange: 'None',
    });
    const major = await withRootCause({ severity: 'MAJOR' });
    expect(major.allowedActions).toEqual(['PLAN_ACTIONS']);
    expect(field(await step(major.id, 'submit-no-action', body(major)))).toEqual(['severity']);
    const lost = await raise({
      source: 'INCIDENT',
      incident: { ...INCIDENT, outcome: 'LOST_TIME', lostDays: 3 },
    });
    const found = await ok(lost.id, 'root-cause', {
      version: lost.version,
      ...ROOT_CAUSE,
      riskReview: 'Reviewed',
    });
    expect(field(await step(lost.id, 'submit-no-action', body(found)))).toEqual([
      'incident.outcome',
    ]);
    const minor = await withRootCause();
    expect(minor.allowedActions).toEqual(['PLAN_ACTIONS', 'SUBMIT_NO_ACTION']);
    expect((await ok(minor.id, 'submit-no-action', body(minor))).state).toBe(
      'AWAITING_VERIFICATION',
    );
  });

  it('REOPEN by a client admin needs an action added since then, done, before the next SUBMIT', async () => {
    const nc = await awaiting();
    const done = await ok(
      nc.id,
      'verify-effective',
      { version: nc.version, effectivenessNote: 'Held' },
      'approver',
    );
    expect(
      code(
        await step(
          nc.id,
          'reopen',
          { version: done.version, reason: 'Repeat found', backTo: 'OPEN' },
          'approver',
        ),
      ),
    ).toBe('FORBIDDEN');
    const past = await step(
      nc.id,
      'reopen',
      {
        version: done.version,
        reason: 'Repeat found',
        backTo: 'ACTIONS_PLANNED',
        effectivenessDueOn: '2026-10-20',
      },
      'clientAdmin',
    );
    expect(field(past)).toEqual(['effectivenessDueOn']);
    const reopened = await ok(
      nc.id,
      'reopen',
      {
        version: done.version,
        reason: 'Repeat found',
        backTo: 'ACTIONS_PLANNED',
        effectivenessDueOn: '2026-12-01',
      },
      'clientAdmin',
    );
    expect(reopened).toMatchObject({ state: 'ACTIONS_PLANNED', closedOn: null, effective: null });
    const stale = await step(nc.id, 'submit', {
      version: reopened.version,
      riskReview: 'None',
      systemChange: 'None',
    });
    expect(field(stale)).toEqual(['actions']);
    await completeAction(await ncAction(nc.id));
    expect((await ok(nc.id, 'submit', { version: reopened.version })).state).toBe(
      'AWAITING_VERIFICATION',
    );
  });

  it('CANCEL is final; a wrong state is 409 and a stale version 409', async () => {
    const nc = await raise();
    expect(code(await step(nc.id, 'submit', { version: nc.version }))).toBe('INVALID_TRANSITION');
    expect(
      details(
        await step(nc.id, 'plan-actions', {
          version: nc.version,
          effectivenessDueOn: '2026-12-01',
        }),
      ),
    ).toEqual({
      entity: 'nonconformity',
      from: 'OPEN',
      action: 'PLAN_ACTIONS',
    });
    expect(
      code(await step(nc.id, 'cancel', { version: nc.version + 1, reason: 'Twice' }, 'approver')),
    ).toBe('STALE_VERSION');
    expect(code(await step(nc.id, 'cancel', { version: nc.version }, 'approver'))).toBe(
      'REASON_REQUIRED',
    );
    const cancelled = await ok(
      nc.id,
      'cancel',
      { version: nc.version, reason: 'Raised twice' },
      'approver',
    );
    expect(cancelled).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'Raised twice',
      allowedActions: [],
    });
    expect(
      code(
        await step(nc.id, 'cancel', { version: cancelled.version, reason: 'Again' }, 'approver'),
      ),
    ).toBe('INVALID_TRANSITION');
    const edit = await h.send('owner', 'PATCH', `/nonconformities/${nc.id}`, {
      version: cancelled.version,
      rootCause: 'x',
    });
    expect(details(edit)).toMatchObject({
      entity: 'nonconformity',
      from: 'CANCELLED',
      action: 'UPDATE',
    });
  });

  it('answers a repeated Idempotency-Key with the first response', async () => {
    const nc = await raise();
    const headers = { 'idempotency-key': randomUUID() };
    const first = await h.send(
      'approver',
      'POST',
      `/nonconformities/${nc.id}/cancel`,
      { version: nc.version, reason: 'Twice' },
      headers,
    );
    const again = await h.send(
      'approver',
      'POST',
      `/nonconformities/${nc.id}/cancel`,
      { version: nc.version, reason: 'Twice' },
      headers,
    );
    expect(first.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect((await audit(nc.id)).filter((e) => e.action === 'TRANSITION')).toHaveLength(1);
  });
});

describe('updateIsoNonconformity and reassignIsoNonconformity', () => {
  it('lets the owner and a client admin edit the investigation, not FA or CO; the text is not recorded', async () => {
    const nc = await raise();
    for (const who of ['firmAdmin', 'consultant', 'otherOwner', 'approver'] as const) {
      const reply = await h.send(who, 'PATCH', `/nonconformities/${nc.id}`, {
        version: nc.version,
        rootCause: 'x',
      });
      expect([403, 404], who).toContain(reply.status);
    }
    const edited = (await h.ok('owner', 'PATCH', `/nonconformities/${nc.id}`, {
      version: nc.version,
      description: 'Calibration record missing for gauge 7',
    })) as Nc;
    expect(edited.version).toBe(nc.version + 1);
    const event = (await audit(nc.id)).at(-1)!;
    expect(event).toMatchObject({
      action: 'UPDATE',
      before: { description: '[not recorded]' },
      after: { description: '[not recorded]' },
    });
  });

  it('moves the unit only for a writer of the new unit', async () => {
    const nc = await raise({ managementSystemId: systemAB });
    const moved = await h.send('owner', 'PATCH', `/nonconformities/${nc.id}`, {
      version: nc.version,
      unitId: h.f.unitB,
    });
    expect(code(moved)).toBe('FORBIDDEN');
    const asAdmin = await h.send('clientAdmin', 'PATCH', `/nonconformities/${nc.id}`, {
      version: nc.version,
      unitId: h.f.unitB,
    });
    // The owner of unit A does not cover unit B.
    expect(field(asAdmin)).toEqual(['ownerId']);
  });

  it('reassigns for FA, CO and CA with a reason, never for the NC owner', async () => {
    const nc = await raise();
    const refused = await step(
      nc.id,
      'reassign',
      { version: nc.version, ownerId: h.f.people.clientAdmin, reason: 'Leave' },
      'owner',
    );
    expect(code(refused)).toBe('FORBIDDEN');
    for (const body of [
      { approverId: h.f.people.clientAdmin },
      { dueOn: '2026-12-31' },
      { severity: 'MAJOR' },
    ]) {
      expect(
        code(await step(nc.id, 'reassign', { version: nc.version, ...body, reason: 'x' }, 'owner')),
      ).toBe('FORBIDDEN');
    }
    expect(
      code(
        await step(
          nc.id,
          'reassign',
          { version: nc.version, ownerId: h.f.people.clientAdmin },
          'firmAdmin',
        ),
      ),
    ).toBe('REASON_REQUIRED');
    const moved = await ok(
      nc.id,
      'reassign',
      {
        version: nc.version,
        ownerId: h.f.people.clientAdmin,
        dueOn: '2026-12-31',
        reason: 'Owner on leave',
      },
      'firmAdmin',
    );
    expect(moved).toMatchObject({ ownerId: h.f.people.clientAdmin, dueOn: '2026-12-31' });
    const events = (await audit(nc.id)).filter((e) => e.action !== 'CREATE');
    expect(events.map((e) => [e.action, e.reason]).sort()).toEqual([
      ['DUE_DATE_CHANGE', 'Owner on leave'],
      ['REASSIGN', 'Owner on leave'],
    ]);
    const severity = await ok(
      nc.id,
      'reassign',
      { version: moved.version, severity: 'MAJOR', reason: 'Wider' },
      'consultant',
    );
    expect(severity.severity).toBe('MAJOR');
    expect((await audit(nc.id)).at(-1)).toMatchObject({
      action: 'UPDATE',
      reason: 'Wider',
      after: { severity: 'MAJOR' },
    });
  });

  it('refuses severity and outcome after ROOT_CAUSE_FOUND, on a finding NC, and an outcome without an incident', async () => {
    const nc = await withRootCause();
    await ncAction(nc.id);
    const planned = await ok(nc.id, 'plan-actions', {
      version: nc.version,
      effectivenessDueOn: '2026-12-01',
    });
    const late = await step(
      nc.id,
      'reassign',
      { version: planned.version, severity: 'MAJOR', reason: 'x' },
      'clientAdmin',
    );
    expect(details(late)).toEqual({
      entity: 'nonconformity',
      from: 'ACTIONS_PLANNED',
      action: 'UPDATE',
    });
    const outcome = await step(
      nc.id,
      'reassign',
      { version: planned.version, incident: { outcome: 'FIRST_AID' }, reason: 'x' },
      'clientAdmin',
    );
    expect(field(outcome)).toEqual(['incident']);
    const { finding } = await seedFinding(h, systemA, 'MINOR_NC');
    const fromFinding = await get(finding.nonconformityId!);
    expect(fromFinding.findingId).toBe(finding.id);
    const severity = await step(
      fromFinding.id,
      'reassign',
      { version: fromFinding.version, severity: 'MAJOR', reason: 'x' },
      'clientAdmin',
    );
    expect(field(severity)).toEqual(['severity']);
  });

  it('moves the incident outcome with lostDays on reassign, and lostDays alone on the PATCH', async () => {
    const nc = await raise({ source: 'INCIDENT', incident: INCIDENT });
    const lost = await ok(
      nc.id,
      'reassign',
      { version: nc.version, incident: { outcome: 'LOST_TIME', lostDays: 2 }, reason: 'Off work' },
      'clientAdmin',
    );
    expect(lost.incident).toMatchObject({ outcome: 'LOST_TIME', lostDays: 2 });
    const same = await step(
      nc.id,
      'reassign',
      { version: lost.version, incident: { outcome: 'LOST_TIME', lostDays: 4 }, reason: 'x' },
      'clientAdmin',
    );
    expect(field(same)).toEqual(['incident.lostDays']);
    const patched = (await h.ok('owner', 'PATCH', `/nonconformities/${nc.id}`, {
      version: lost.version,
      incident: { lostDays: 4, location: 'Press shop bay 2' },
    })) as Nc;
    expect(patched.incident).toMatchObject({ outcome: 'LOST_TIME', lostDays: 4 });
    expect(JSON.stringify(await audit(nc.id))).not.toContain('bay 2');
  });
});

describe('listIsoNonconformities', () => {
  it('lists newest first and filters by state, source, incident, owner, standard, q and overdue', async () => {
    const system = (
      await h.ok('clientAdmin', 'POST', '/systems', {
        name: 'List system',
        standardIds: [h.f.std9001, h.f.std14001],
        unitIds: [h.f.unitA],
      })
    ).id as string;
    const late = await seedNc(h, system, {
      dueOn: '2026-10-15' as never,
      reportedOn: '2026-10-01' as never,
      description: 'Late delivery note',
    });
    const env = await raise({
      managementSystemId: system,
      standards: ['ISO_14001'],
      clauseIds: [],
      source: 'INCIDENT',
      incident: INCIDENT,
    });
    const third = await raise({ managementSystemId: system, ownerId: h.f.people.clientAdmin });
    const list = async (q: string) =>
      (
        (await h.ok('clientAdmin', 'GET', `/nonconformities?managementSystemId=${system}${q}`))
          .items as Nc[]
      ).map((n) => n.id);
    expect(await list('')).toEqual([third.id, env.id, late.id]);
    expect(await list('&overdue=true')).toEqual([late.id]);
    expect(await list('&overdue=false')).toEqual([third.id, env.id]);
    expect(await list('&incident=true')).toEqual([env.id]);
    expect(await list('&incident=false')).toEqual([third.id, late.id]);
    expect(await list('&source=INCIDENT')).toEqual([env.id]);
    expect(await list('&standard=ISO_14001')).toEqual([env.id]);
    expect(await list(`&ownerId=${h.f.people.clientAdmin}`)).toEqual([third.id]);
    expect(await list('&q=late%20delivery')).toEqual([late.id]);
    expect(await list(`&q=${String(third.number)}`)).toContain(third.id);
    expect(await list('&state=CLOSED')).toEqual([]);
    const first = await h.ok(
      'clientAdmin',
      'GET',
      `/nonconformities?managementSystemId=${system}&limit=2&count=true`,
    );
    expect(first.total).toBe(3);
    const second = await h.ok(
      'clientAdmin',
      'GET',
      `/nonconformities?managementSystemId=${system}&limit=2&cursor=${String(first.nextCursor)}`,
    );
    expect((second.items as Nc[]).map((n) => n.id)).toEqual([late.id]);
  });

  it('takes ids with unit scope: other clients, other units and archived NCs drop out with no error', async () => {
    const mine = await raise();
    const onB = await raise({
      managementSystemId: systemB,
      unitId: h.f.unitB,
      ownerId: h.f.people.otherOwner,
    });
    const unitless = await seedNc(h, systemB, {
      ownerId: h.f.people.otherOwner,
      approverId: h.f.people.approverB,
    });
    const archived = await seedNc(h, systemA);
    await h.asSystem((tx) => nonconformities.archive(tx, archived.id, archived.version));
    const ids = [
      mine.id,
      onB.id,
      unitless.id,
      archived.id,
      '01900000-0000-7000-8000-000000000000',
    ].join(',');
    const asOwner = await h.ok('owner', 'GET', `/nonconformities?ids=${ids}`);
    expect((asOwner.items as Nc[]).map((n) => n.id)).toEqual([mine.id]);
    const asAdmin = await h.ok('clientAdmin', 'GET', `/nonconformities?ids=${ids}`);
    expect((asAdmin.items as Nc[]).map((n) => n.id).sort()).toEqual(
      [mine.id, onB.id, unitless.id].sort(),
    );
    // A plant-A owner sees none of a plant-B-only system's unit-less NCs, by id or list.
    expect((await h.send('owner', 'GET', `/nonconformities/${unitless.id}`)).status).toBe(404);
  });
});

describe('files on a nonconformity', () => {
  const subject = (id: string) => ({ type: 'nonconformity' as const, id });

  it('takes files from its owner and a client admin, not FA or CO, and locks them once closed', async () => {
    const nc = await raise();
    await attach(h, 'owner', subject(nc.id));
    await attach(h, 'clientAdmin', subject(nc.id));
    for (const who of ['firmAdmin', 'consultant'] as const) {
      const reply = await h.send(who, 'POST', '/files/upload-url', {
        subject: subject(nc.id),
        fileName: 'photo.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
      });
      expect(code(reply), who).toBe('FORBIDDEN');
    }
    const listed = await h.ok(
      'firmAdmin',
      'GET',
      `/files?subjectType=nonconformity&subjectId=${nc.id}`,
    );
    expect(listed.items).toHaveLength(2);
    const stored = await h.asSystem((tx) => nonconformities.require(tx, nc.id));
    await setNcState(h, stored, 'CLOSED');
    const fileId = (listed.items as { id: string }[])[0]!.id;
    for (const who of ['owner', 'clientAdmin'] as const) {
      const add = await h.send(who, 'POST', '/files/upload-url', {
        subject: subject(nc.id),
        fileName: 'late.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
      });
      expect(details(add), who).toEqual({
        entity: 'nonconformity',
        from: 'CLOSED',
        action: 'UPDATE',
      });
      const remove = await h.send(who, 'POST', `/files/${fileId}/remove`, { reason: 'Wrong file' });
      expect(code(remove), who).toBe('INVALID_TRANSITION');
    }
    const edit = await h.send('owner', 'PATCH', `/nonconformities/${nc.id}`, {
      version: stored.version + 1,
      rootCause: 'x',
    });
    expect(code(edit)).toBe('INVALID_TRANSITION');
  });

  it("lets only the incident's people and managers download its files", async () => {
    const nc = await raise({
      source: 'INCIDENT',
      incident: { ...INCIDENT, investigatorIds: [h.f.people.otherAdmin] },
    });
    const file = await attach(h, 'owner', subject(nc.id), 'statement.pdf');
    await h.scan(file.id as string, 'CLEAN');
    const download = (who: Who) => h.send(who, 'GET', `/files/${String(file.id)}/download-url`);
    for (const who of [
      'owner',
      'approver',
      'otherAdmin',
      'clientAdmin',
      'consultant',
      'firmAdmin',
    ] as const) {
      expect((await download(who)).status, who).toBe(200);
    }
    expect(code(await download('viewer'))).toBe('FORBIDDEN');
    // The approver of unit B is not named and reads no unit-A record.
    expect((await download('approverB')).status).toBe(404);
    // An action on it takes the same rule.
    const action = await seedAction(h, { type: 'NONCONFORMITY', id: nc.id });
    const onAction = await attach(h, 'owner', { type: 'iso_action', id: action.id }, 'notes.pdf');
    await h.scan(onAction.id as string, 'CLEAN');
    expect(code(await h.send('viewer', 'GET', `/files/${String(onAction.id)}/download-url`))).toBe(
      'FORBIDDEN',
    );
  });
});
