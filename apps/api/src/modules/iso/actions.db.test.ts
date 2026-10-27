import { LocalDate, type IsoAction } from '@canopy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type Reply, type Who } from './testing/fixture.js';
import {
  closeAudit,
  seedAction,
  seedFinding,
  seedNc,
  seedReview,
  setNcState,
} from './testing/records.js';

/**
 * Actions on every subject (model §3.12): COMPLETE, CANCEL and REOPEN through the engine, the subject open as §3.12
 * defines it, no actions on MAJOR_NC, MINOR_NC or GOOD_PRACTICE findings, the treatment-action rule on risk items
 * (§3.5: the control in place, then the residual rating cleared with `sourceActionId`), `allowedActions`, unit scope
 * (plan §3.3) and the audit trail (model §8).
 */

const NOW = new Date('2026-10-20T06:00:00Z');
let h: Harness;
/** Unit A only, on 9001 and 14001. */
let systemA: string;

beforeAll(async () => {
  h = await createHarness('Action', NOW);
  systemA = (
    await h.ok('clientAdmin', 'POST', '/systems', {
      name: 'Stonebridge system',
      standardIds: [h.f.std9001, h.f.std14001],
      unitIds: [h.f.unitA],
    })
  ).id as string;
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
  }>(
    'SELECT action, before, after, reason FROM audit_event WHERE entity_id = $1 ORDER BY at, action, after::text, reason',
    [entityId],
  );

type Subject = IsoAction['subject'];

async function riskItem(fields: Record<string, unknown> = {}) {
  return h.ok('clientAdmin', 'POST', '/risks', {
    managementSystemId: systemA,
    kind: 'RISK',
    activity: 'Packaging supply',
    description: 'One supplier makes every carton',
    likelihood: 4,
    severity: 4,
    ownerId: h.f.people.owner,
    ...fields,
  }) as Promise<{ id: string; version: number } & Record<string, unknown>>;
}

async function objective(ownerId = h.f.people.owner) {
  const o = await h.ok('clientAdmin', 'POST', '/objectives', {
    managementSystemId: systemA,
    standards: ['ISO_9001'],
    text: 'On-time delivery',
    target: 98,
    unitOfMeasure: '%',
    baseline: 90,
    direction: 'INCREASE',
    readingRule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    ownerId,
    dueOn: '2027-03-31',
  });
  await h.testDb.query('UPDATE objective SET created_at = $2 WHERE id = $1', [
    o.id,
    NOW.toISOString(),
  ]);
  return o as { id: string; version: number };
}

const createAction = (
  subject: Subject,
  fields: Record<string, unknown> = {},
  who: Who = 'clientAdmin',
) =>
  h.send(who, 'POST', '/actions', {
    subject,
    text: 'Qualify a second carton supplier',
    ownerId: h.f.people.owner,
    dueOn: '2026-11-30',
    ...fields,
  });

async function action(
  subject: Subject,
  fields: Record<string, unknown> = {},
  who: Who = 'clientAdmin',
) {
  const reply = await createAction(subject, fields, who);
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return reply.body as { id: string; version: number } & Record<string, unknown>;
}

const step = (
  id: string,
  name: 'complete' | 'cancel' | 'reopen',
  body: object,
  who: Who = 'clientAdmin',
) => h.send(who, 'POST', `/actions/${id}/${name}`, body);

const ncSubject = async (fields = {}) => {
  const nc = await seedNc(h, systemA, fields);
  return { nc, subject: { type: 'NONCONFORMITY' as const, id: nc.id } };
};

describe('createIsoAction', () => {
  it('adds an OPEN action on each kind of subject, audited as CREATE', async () => {
    const { subject: onNc } = await ncSubject();
    const item = await riskItem();
    const goal = await objective();
    const { finding } = await seedFinding(h, systemA, 'OFI');
    const review = await seedReview(h, systemA);
    const subjects: [Subject, Record<string, unknown>][] = [
      [onNc, {}],
      [{ type: 'RISK_ITEM' as const, id: item.id }, { controlHierarchy: 'ENGINEERING' }],
      [{ type: 'OBJECTIVE' as const, id: goal.id }, {}],
      [{ type: 'AUDIT_FINDING' as const, id: finding.id }, {}],
      [{ type: 'MANAGEMENT_REVIEW' as const, id: review.id }, { outputKey: 'SUITABILITY' }],
    ];
    for (const [subject, fields] of subjects) {
      const created = await action(subject, fields);
      expect(created).toMatchObject({
        subject,
        state: 'OPEN',
        doneOn: null,
        version: 1,
        status: { timing: 'ON_TIME' },
        allowedActions: ['COMPLETE', 'CANCEL'],
        ...fields,
      });
      expect(await audit(created.id)).toMatchObject([
        { action: 'CREATE', after: { subject, ownerId: h.f.people.owner, state: 'OPEN' } },
      ]);
    }
  });

  it('refuses MAJOR_NC, MINOR_NC and GOOD_PRACTICE findings (400 on subject)', async () => {
    for (const type of ['MAJOR_NC', 'MINOR_NC', 'GOOD_PRACTICE'] as const) {
      const { finding } = await seedFinding(h, systemA, type);
      const reply = await createAction({ type: 'AUDIT_FINDING' as const, id: finding.id });
      expect([type, reply.status, code(reply), field(reply)]).toEqual([
        type,
        400,
        'VALIDATION',
        ['subject'],
      ]);
    }
  });

  it('checks the hierarchy on a HAZARD, the review’s outputs and the owner (400 VALIDATION)', async () => {
    const hazard = await riskItem({
      kind: 'HAZARD',
      impact: 'Crush injury',
      routine: true,
      personsExposed: ['WORKER'],
      condition: 'NORMAL',
    });
    const bare = await createAction({ type: 'RISK_ITEM' as const, id: hazard.id });
    expect([bare.status, field(bare)]).toEqual([400, ['controlHierarchy']]);
    const review = await seedReview(h, systemA, { standards: ['ISO_14001'] });
    const output = await createAction(
      { type: 'MANAGEMENT_REVIEW' as const, id: review.id },
      { outputKey: 'SUITABILITY' },
    );
    expect([output.status, field(output)]).toEqual([400, ['outputKey']]);
    const { subject } = await ncSubject({ unitId: h.f.unitA });
    for (const who of ['approver', 'otherOwner', 'viewer'] as Who[]) {
      const reply = await createAction(subject, { ownerId: h.f.people[who] });
      expect([who, reply.status, field(reply)]).toEqual([who, 400, ['ownerId']]);
    }
    expect((await createAction(subject, { ownerId: h.f.people.otherAdmin })).status).toBe(201);
  });

  it('answers 404 for a subject the actor cannot see, another kind’s id or an archived subject', async () => {
    const { subject } = await ncSubject();
    expect((await createAction(subject, {}, 'otherOwner')).status).toBe(404);
    expect((await createAction({ type: 'RISK_ITEM' as const, id: subject.id })).status).toBe(404);
    const item = await riskItem();
    await h.ok('clientAdmin', 'POST', `/risks/${item.id}/archive`, { version: 1, reason: 'Gone' });
    expect((await createAction({ type: 'RISK_ITEM' as const, id: item.id })).status).toBe(404);
  });

  it('lets FA, CO and CA add actions, and an owner only on a subject they own', async () => {
    const { subject } = await ncSubject();
    for (const who of ['firmAdmin', 'consultant', 'clientAdmin', 'owner'] as Who[]) {
      expect([who, (await createAction(subject, {}, who)).status]).toEqual([who, 201]);
    }
    for (const who of ['approver', 'viewer'] as Who[]) {
      expect([who, (await createAction(subject, {}, who)).status]).toEqual([who, 403]);
    }
    const theirs = await seedNc(h, systemA, { ownerId: h.f.people.clientAdmin });
    expect(
      (await createAction({ type: 'NONCONFORMITY' as const, id: theirs.id }, {}, 'owner')).status,
    ).toBe(403);
  });
});

describe('the subject closed to its actions (model §3.12)', () => {
  /** A subject with one OPEN action and one DONE action, then closed by `close`. */
  async function closedSubject(subject: Subject, close: () => Promise<void>) {
    const open = await action(
      subject,
      subject.type === 'RISK_ITEM' ? { controlHierarchy: 'ENGINEERING' } : {},
    );
    const done = await seedAction(h, subject, {
      state: 'DONE',
      doneOn: LocalDate.parse('2026-10-19'),
    });
    await close();
    return { open, done };
  }

  const locks: [
    string,
    () => Promise<{ subject: Subject; close: () => Promise<void> }>,
    unknown,
  ][] = [
    [
      'a CLOSED nonconformity',
      async () => {
        const { nc, subject } = await ncSubject();
        return { subject, close: () => setNcState(h, nc, 'CLOSED') };
      },
      { entity: 'nonconformity', from: 'CLOSED', action: 'UPDATE' },
    ],
    [
      'a closed objective',
      async () => {
        const goal = await objective();
        return {
          subject: { type: 'OBJECTIVE' as const, id: goal.id },
          close: async () => {
            await h.ok('clientAdmin', 'POST', `/objectives/${goal.id}/close`, {
              version: 1,
              closedOn: '2026-10-20',
              outcome: 'ACHIEVED',
            });
          },
        };
      },
      { entity: 'objective', from: 'CLOSED', action: 'UPDATE' },
    ],
    [
      'a finding of a CLOSED audit',
      async () => {
        const { finding, auditId } = await seedFinding(h, systemA, 'OFI');
        return {
          subject: { type: 'AUDIT_FINDING' as const, id: finding.id },
          close: () => closeAudit(h, auditId),
        };
      },
      { entity: 'internal_audit', from: 'CLOSED', action: 'UPDATE' },
    ],
    [
      'a CLOSED management review',
      async () => {
        const review = await seedReview(h, systemA);
        return {
          subject: { type: 'MANAGEMENT_REVIEW' as const, id: review.id },
          close: async () => {
            await h.testDb.query(
              "UPDATE management_review SET state = 'CLOSED', held_on = '2026-10-19' WHERE id = $1",
              [review.id],
            );
          },
        };
      },
      { entity: 'management_review', from: 'CLOSED', action: 'UPDATE' },
    ],
    [
      'an archived risk item',
      async () => {
        const item = await riskItem();
        return {
          subject: { type: 'RISK_ITEM' as const, id: item.id },
          close: async () => {
            await h.ok('clientAdmin', 'POST', `/risks/${item.id}/archive`, {
              version: 1,
              reason: 'Gone',
            });
          },
        };
      },
      { entity: 'risk_item', from: 'ARCHIVED', action: 'UPDATE' },
    ],
  ];

  it.each(locks)(
    'refuses field edits, COMPLETE and REOPEN on %s, and still CANCELs',
    async (_name, make, lock) => {
      const { subject, close } = await make();
      const { open, done } = await closedSubject(subject, close);
      const refusals = [
        await h.send('clientAdmin', 'PATCH', `/actions/${open.id}`, { version: 1, text: 'Late' }),
        await step(open.id, 'complete', { version: 1, doneOn: '2026-10-20' }),
        await step(done.id, 'reopen', { version: 1, reason: 'Not fixed' }),
      ];
      for (const reply of refusals) {
        expect([reply.status, code(reply), details(reply)], JSON.stringify(reply.body)).toEqual([
          409,
          'INVALID_TRANSITION',
          lock,
        ]);
      }
      const cancelled = await step(open.id, 'cancel', { version: 1, reason: 'Subject closed' });
      expect([cancelled.status, cancelled.body.state]).toEqual([200, 'CANCELLED']);
      expect((await audit(open.id)).map((e) => e.action)).toEqual(['CREATE', 'TRANSITION']);
      // A closed subject's actions offer only CANCEL while OPEN, and nothing once settled.
      expect((await h.ok('clientAdmin', 'GET', `/actions/${done.id}`)).allowedActions).toEqual([]);
    },
  );

  it('refuses a new action on a closed subject with 409 naming it', async () => {
    const { nc, subject } = await ncSubject();
    await setNcState(h, nc, 'CANCELLED');
    const reply = await createAction(subject);
    expect([reply.status, details(reply)]).toEqual([
      409,
      { entity: 'nonconformity', from: 'CANCELLED', action: 'UPDATE' },
    ]);
  });
});

describe('completeIsoAction, cancelIsoAction and reopenIsoAction', () => {
  it('lets the action’s owner complete it, a client admin as delegate, with doneOn not in the future', async () => {
    const { subject } = await ncSubject();
    const mine = await action(subject);
    const future = await step(mine.id, 'complete', { version: 1, doneOn: '2026-10-21' }, 'owner');
    expect([
      future.status,
      field(future),
      (details(future)?.issues as { message: string }[])[0]!.message,
    ]).toEqual([400, ['doneOn'], 'doneOn is not in the future']);
    for (const who of ['approver', 'viewer', 'consultant'] as Who[]) {
      expect([
        who,
        (await step(mine.id, 'complete', { version: 1, doneOn: '2026-10-20' }, who)).status,
      ]).toEqual([who, 403]);
    }
    const done = await step(
      mine.id,
      'complete',
      { version: 1, doneOn: '2026-10-18', effectivenessNote: 'Works' },
      'owner',
    );
    expect(done.body).toMatchObject({
      state: 'DONE',
      doneOn: '2026-10-18',
      effectivenessNote: 'Works',
      version: 2,
    });
    const transition = (await audit(mine.id)).at(-1)!;
    expect(transition).toMatchObject({
      action: 'TRANSITION',
      before: { state: 'OPEN', doneOn: null },
      after: { action: 'COMPLETE', state: 'DONE', doneOn: '2026-10-18' },
    });
    expect(transition.after).not.toHaveProperty('delegated');
    const again = await step(mine.id, 'complete', { version: 2, doneOn: '2026-10-20' }, 'owner');
    expect([again.status, details(again)]).toEqual([
      409,
      { entity: 'iso_action', from: 'DONE', action: 'COMPLETE' },
    ]);

    const theirs = await action(subject);
    await step(theirs.id, 'complete', { version: 1, doneOn: '2026-10-20' });
    expect((await audit(theirs.id)).at(-1)!.after).toMatchObject({
      action: 'COMPLETE',
      delegated: true,
    });
  });

  it('lets the subject’s approver or a client admin cancel, with a reason', async () => {
    const { subject } = await ncSubject();
    const a = await action(subject);
    const bare = await step(a.id, 'cancel', { version: 1 });
    expect([bare.status, code(bare)]).toEqual([422, 'REASON_REQUIRED']);
    for (const who of ['owner', 'viewer', 'approverB'] as Who[]) {
      const reply = await step(a.id, 'cancel', { version: 1, reason: 'No' }, who);
      expect([who, reply.status]).toEqual([who, who === 'approverB' ? 404 : 403]);
    }
    const cancelled = await step(a.id, 'cancel', { version: 1, reason: 'Duplicate' }, 'approver');
    expect(cancelled.body).toMatchObject({ state: 'CANCELLED', cancelReason: 'Duplicate' });
    expect((await audit(a.id)).at(-1)).toMatchObject({
      action: 'TRANSITION',
      after: { action: 'CANCEL', state: 'CANCELLED', cancelReason: 'Duplicate' },
      reason: 'Duplicate',
    });
    // A risk item names no approver: only a client admin cancels its actions.
    const item = await riskItem();
    const treatment = await action({ type: 'RISK_ITEM' as const, id: item.id });
    expect(
      (await step(treatment.id, 'cancel', { version: 1, reason: 'No' }, 'approver')).status,
    ).toBe(403);
  });

  it('lets a client admin reopen a settled action with a reason, clearing doneOn and cancelReason', async () => {
    const { subject } = await ncSubject();
    const a = await action(subject);
    const early = await step(a.id, 'reopen', { version: 1, reason: 'No' });
    expect([early.status, details(early)]).toEqual([
      409,
      { entity: 'iso_action', from: 'OPEN', action: 'REOPEN' },
    ]);
    await step(a.id, 'complete', { version: 1, doneOn: '2026-10-20' }, 'owner');
    for (const who of ['owner', 'consultant', 'firmAdmin', 'approver'] as Who[]) {
      expect([who, (await step(a.id, 'reopen', { version: 2, reason: 'No' }, who)).status]).toEqual(
        [who, 403],
      );
    }
    const bare = await step(a.id, 'reopen', { version: 2 });
    expect([bare.status, code(bare)]).toEqual([422, 'REASON_REQUIRED']);
    const reopened = await step(a.id, 'reopen', { version: 2, reason: 'Recurred' });
    expect(reopened.body).toMatchObject({ state: 'OPEN', doneOn: null, version: 3 });
    expect((await audit(a.id)).at(-1)).toMatchObject({
      action: 'TRANSITION',
      before: { state: 'DONE', doneOn: '2026-10-20' },
      after: { action: 'REOPEN', state: 'OPEN', doneOn: null },
      reason: 'Recurred',
    });
    const stale = await step(a.id, 'cancel', { version: 2, reason: 'Late' });
    expect([stale.status, code(stale)]).toEqual([409, 'STALE_VERSION']);
  });

  it('offers each role its allowed actions', async () => {
    const { subject } = await ncSubject();
    const a = await action(subject);
    const allowed = async (who: Who) => (await h.ok(who, 'GET', `/actions/${a.id}`)).allowedActions;
    expect(await allowed('clientAdmin')).toEqual(['COMPLETE', 'CANCEL']);
    expect(await allowed('owner')).toEqual(['COMPLETE']);
    expect(await allowed('approver')).toEqual(['CANCEL']);
    expect(await allowed('viewer')).toEqual([]);
    expect(await allowed('consultant')).toEqual([]);
    await step(a.id, 'complete', { version: 1, doneOn: '2026-10-20' }, 'owner');
    expect(await allowed('clientAdmin')).toEqual(['REOPEN']);
    expect(await allowed('owner')).toEqual([]);
  });
});

describe('updateIsoAction', () => {
  it('audits field edits as UPDATE, a new owner as REASSIGN and a moved due date with its reason', async () => {
    const { subject } = await ncSubject();
    const a = await action(subject);
    const bare = await h.send('clientAdmin', 'PATCH', `/actions/${a.id}`, {
      version: 1,
      dueOn: '2026-12-15',
    });
    expect([bare.status, code(bare)]).toEqual([422, 'REASON_REQUIRED']);
    await h.ok('clientAdmin', 'PATCH', `/actions/${a.id}`, {
      version: 1,
      text: 'Qualify two carton suppliers',
      ownerId: h.f.people.otherAdmin,
      dueOn: '2026-12-15',
      reason: 'Buyer on leave',
    });
    expect(
      (await audit(a.id))
        .slice(1)
        .map((e) => [e.action, e.reason])
        .sort(),
    ).toEqual([
      ['DUE_DATE_CHANGE', 'Buyer on leave'],
      ['REASSIGN', 'Buyer on leave'],
      ['UPDATE', null],
    ]);
  });

  it('refuses edits once the action is settled, and from anyone but managers and the subject’s owner', async () => {
    const { subject } = await ncSubject({ ownerId: h.f.people.clientAdmin });
    const a = await action(subject);
    expect(
      (await h.send('owner', 'PATCH', `/actions/${a.id}`, { version: 1, text: 'No' })).status,
    ).toBe(403);
    expect(
      (await h.send('approver', 'PATCH', `/actions/${a.id}`, { version: 1, text: 'No' })).status,
    ).toBe(403);
    await step(a.id, 'cancel', { version: 1, reason: 'Duplicate' });
    const settled = await h.send('clientAdmin', 'PATCH', `/actions/${a.id}`, {
      version: 2,
      text: 'Late',
    });
    expect([settled.status, details(settled)]).toEqual([
      409,
      { entity: 'iso_action', from: 'CANCELLED', action: 'UPDATE' },
    ]);
  });
});

describe('treatment actions on a risk item (model §3.5)', () => {
  it('puts each control in place, then clears the residual rating when the last OPEN action completes', async () => {
    const item = await riskItem({ residualLikelihood: 2, residualSeverity: 3 });
    const first = await action(
      { type: 'RISK_ITEM' as const, id: item.id },
      { controlHierarchy: 'ENGINEERING' },
    );
    const second = await action(
      { type: 'RISK_ITEM' as const, id: item.id },
      { controlHierarchy: 'ADMINISTRATIVE', text: 'Two weeks of carton stock' },
    );

    await step(first.id, 'complete', { version: 1, doneOn: '2026-10-20' }, 'owner');
    let controls = (await h.ok('owner', 'GET', `/risks/${item.id}/controls`)).items as Record<
      string,
      unknown
    >[];
    expect(controls).toMatchObject([
      {
        text: 'Qualify a second carton supplier',
        hierarchy: 'ENGINEERING',
        sourceActionId: first.id,
      },
    ]);
    let events = await audit(item.id);
    expect(events.slice(1).map((e) => e.action)).toEqual(['DUE_DATE_CHANGE']);
    expect(events.at(-1)).toMatchObject({
      before: { reviewDueOn: null },
      after: { reviewDueOn: '2026-10-20', sourceActionId: first.id },
    });
    // One treatment action is still OPEN: the residual rating stands.
    expect(await h.ok('owner', 'GET', `/risks/${item.id}`)).toMatchObject({
      residualRating: 6,
      version: 2,
    });

    await step(second.id, 'complete', { version: 1, doneOn: '2026-10-20' }, 'owner');
    controls = (await h.ok('owner', 'GET', `/risks/${item.id}/controls`)).items as Record<
      string,
      unknown
    >[];
    expect(controls.map((c) => c.sourceActionId)).toEqual([first.id, second.id]);
    events = await audit(item.id);
    const cleared = events.filter((e) => e.action === 'UPDATE');
    expect(cleared).toEqual([
      {
        action: 'UPDATE',
        before: { residualLikelihood: 2, residualSeverity: 3, residualRating: 6 },
        after: {
          residualLikelihood: null,
          residualSeverity: null,
          residualRating: null,
          sourceActionId: second.id,
        },
        reason: null,
      },
    ]);
    const rated = await h.ok('owner', 'GET', `/risks/${item.id}`);
    expect(rated).toMatchObject({ residualRating: null, reviewDueOn: '2026-10-20', version: 3 });

    // The owner's re-rating is a PATCH: its UPDATE carries no source action.
    await h.ok('owner', 'PATCH', `/risks/${item.id}`, {
      version: 3,
      residualLikelihood: 1,
      residualSeverity: 3,
    });
    const rerating = (await audit(item.id)).filter((e) => e.action === 'UPDATE').at(-1)!;
    expect(rerating.after).toMatchObject({ residualRating: 3 });
    expect(rerating.after).not.toHaveProperty('sourceActionId');
    expect(
      (await audit(controls[1]!.id as string)).map((e) => [e.action, e.after?.sourceActionId]),
    ).toEqual([['CREATE', second.id]]);
  });
});

describe('listIsoActions', () => {
  it('lists by due date and applies every filter', async () => {
    const { subject } = await ncSubject();
    const late = await action(subject, { dueOn: '2026-12-31', resources: 'Two buyers' });
    const overdue = await seedAction(h, subject, {
      dueOn: LocalDate.parse('2026-10-01'),
      text: 'Fix the gauge',
    });
    const done = await seedAction(h, subject, {
      state: 'DONE',
      doneOn: LocalDate.parse('2026-10-02'),
      dueOn: LocalDate.parse('2026-10-01'),
    });
    const ids = async (query: string, who: Who = 'clientAdmin') =>
      (
        (
          await h.ok(
            who,
            'GET',
            `/actions?subjectType=NONCONFORMITY&subjectId=${subject.id}${query}`,
          )
        ).items as {
          id: string;
        }[]
      ).map((a) => a.id);
    expect(await ids('')).toEqual([overdue.id, done.id, late.id]);
    expect(await ids('&state=OPEN')).toEqual([overdue.id, late.id]);
    expect(await ids('&overdue=true')).toEqual([overdue.id]);
    expect(await ids('&q=buyers')).toEqual([late.id]);
    expect(await ids('&ownerId=me', 'owner')).toEqual([overdue.id, done.id, late.id]);
    expect(await ids('&from=2026-10-15')).toEqual([late.id]);
    expect(await ids('', 'otherOwner')).toEqual([]);
    expect((await h.ok('clientAdmin', 'GET', `/actions/${overdue.id}`)).status).toMatchObject({
      timing: 'OVERDUE',
      overdueDays: 19,
    });
  });

  it('filters by system and due-date range, and pages overdue actions without short pages', async () => {
    const other = (
      await h.ok('clientAdmin', 'POST', '/systems', {
        name: 'Paging system',
        standardIds: [h.f.std9001],
        unitIds: [h.f.unitA],
      })
    ).id as string;
    const nc = await seedNc(h, other);
    const subject = { type: 'NONCONFORMITY' as const, id: nc.id };
    const first = await seedAction(h, subject, { dueOn: LocalDate.parse('2026-10-05') });
    const fine = await seedAction(h, subject, {
      dueOn: LocalDate.parse('2026-10-10'),
      state: 'DONE',
      doneOn: LocalDate.parse('2026-10-09'),
    });
    const second = await seedAction(h, subject, { dueOn: LocalDate.parse('2026-10-12') });
    const notYet = await seedAction(h, subject, { dueOn: LocalDate.parse('2026-11-12') });
    const ids = async (query: string) =>
      (
        (await h.ok('clientAdmin', 'GET', `/actions?managementSystemId=${other}${query}`))
          .items as { id: string }[]
      ).map((a) => a.id);
    expect(await ids('')).toEqual([first.id, fine.id, second.id, notYet.id]);
    const inA = (
      (await h.ok('clientAdmin', 'GET', `/actions?managementSystemId=${systemA}&limit=200`))
        .items as {
        id: string;
      }[]
    ).map((a) => a.id);
    expect(inA).not.toContain(notYet.id);
    expect(await ids('&to=2026-10-10')).toEqual([first.id, fine.id]);
    expect(await ids('&from=2026-10-06&to=2026-10-31')).toEqual([fine.id, second.id]);
    const page1 = await h.ok(
      'clientAdmin',
      'GET',
      `/actions?managementSystemId=${other}&overdue=true&limit=1`,
    );
    expect((page1.items as { id: string }[]).map((a) => a.id)).toEqual([first.id]);
    const page2 = await h.ok(
      'clientAdmin',
      'GET',
      `/actions?managementSystemId=${other}&overdue=true&limit=1&cursor=${String(page1.nextCursor)}`,
    );
    expect((page2.items as { id: string }[]).map((a) => a.id)).toEqual([second.id]);
    expect(page2.nextCursor).toBeNull();
  });
});
