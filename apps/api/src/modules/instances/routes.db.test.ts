import {
  AuditEvent,
  Comment,
  ENDPOINTS,
  InstanceDetail,
  type ComplianceInstance,
} from '@canopy/contracts';
import { auditEvents, comments, systemContext } from '@canopy/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import {
  addInstance,
  createTestDb,
  seedFixture,
  type Cast,
  type Fixture,
  type TestDb,
} from './testing/fixture.js';

/**
 * M7 instance routes against Postgres with RLS on: every arrow of the state machine over HTTP, the role
 * matrix of endpoints.md §4 (each allowed role and at least one forbidden one), tenant isolation, and the
 * comment and AuditEvent each change writes. Today is 2023-01-20 in Asia/Kolkata.
 */

const NOW = new Date('2023-01-20T06:00:00Z');

let testDb: TestDb;
let app: FastifyInstance;
let f: Fixture;
let other: Fixture;
const auth = createTestAuth();
const headers = {} as Record<keyof Cast, Record<string, string>>;
let otherOwnerFirmB: Record<string, string>;

beforeAll(async () => {
  testDb = await createTestDb();
  f = await seedFixture(testDb.db, await testDb.createFirm('Firm A'), 'A');
  other = await seedFixture(testDb.db, await testDb.createFirm('Firm B'), 'B');
  for (const key of Object.keys(f.people) as (keyof Cast)[]) {
    headers[key] = auth.signIn({
      firmId: f.firmId,
      personId: f.people[key],
      memberships: f.memberships[key],
      principal: { firmClientIds: [f.clientId] },
    }).headers;
  }
  otherOwnerFirmB = auth.signIn({
    firmId: other.firmId,
    personId: other.people.owner,
    memberships: other.memberships.owner,
  }).headers;
  app = buildServer({
    authStore: auth.store,
    database: testDb.db,
    clock: () => NOW,
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

type Who = keyof Cast;

async function call(
  who: Who | Record<string, string>,
  method: string,
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    headers: typeof who === 'string' ? headers[who] : who,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return {
    status: res.statusCode,
    body: res.json() as Record<string, unknown> & { error?: { code: string } },
  };
}

async function historyOf(id: string): Promise<AuditEvent[]> {
  return testDb.db.withTenant(systemContext(f.firmId, 'assert'), (tx) =>
    auditEvents.forEntity(tx, 'instance', id),
  );
}

async function commentsOf(id: string): Promise<Comment[]> {
  return testDb.db.withTenant(systemContext(f.firmId, 'assert'), (tx) =>
    comments.forInstance(tx, id),
  );
}

let seq = 0;
/** A fresh instance on unit A, due on `dueDate`, in `state`. */
function fresh(
  state: Parameters<typeof addInstance>[2]['state'] = 'OPEN',
  extra: { dueDate?: string; assignment?: 'plain' | 'evidence' | 'unitB' } = {},
): Promise<ComplianceInstance> {
  seq += 1;
  const month = String((seq % 12) + 1).padStart(2, '0');
  return addInstance(testDb.db, f, {
    assignment: extra.assignment ?? 'plain',
    periodStart: `${2000 + Math.floor(seq / 12)}-${month}-01`,
    dueDate: extra.dueDate ?? '2023-02-15',
    state,
  });
}

describe('GET /instances/{id}', () => {
  it("returns InstanceDetail with engine status and the owner's actions", async () => {
    const i = await fresh('OPEN', { dueDate: '2023-01-25' });
    const { status, body } = await call('owner', 'GET', `/instances/${i.id}`);
    expect(status).toBe(200);
    const detail = InstanceDetail.parse(body);
    expect(detail.status).toBe('DUE_SOON');
    expect(detail.allowedActions).toEqual(['SUBMIT', 'REQUEST_NA', 'COMMENT', 'UPLOAD_EVIDENCE']);
    expect(detail.forms).toEqual([{ label: 'Form 21', fileName: null, templateFileId: null }]);
    expect(detail.evidenceRequired).toBe(false);
  });

  it('is OVERDUE with overdueDays after the due date', async () => {
    const i = await fresh('OPEN', { dueDate: '2023-01-15' });
    const { body } = await call('viewer', 'GET', `/instances/${i.id}`);
    expect(body).toMatchObject({ status: 'OVERDUE', overdueDays: 5, allowedActions: [] });
  });

  it("is 403 for an owner outside the instance's unit", async () => {
    const i = await fresh('OPEN', { assignment: 'unitB' });
    expect((await call('owner', 'GET', `/instances/${i.id}`)).status).toBe(403);
    expect((await call('otherOwner', 'GET', `/instances/${i.id}`)).status).toBe(200);
  });

  it('is 404 for another firm', async () => {
    const i = await fresh();
    const res = await call(otherOwnerFirmB, 'GET', `/instances/${i.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });

  it('lets a consultant read as at another date, not an owner', async () => {
    const i = await fresh('OPEN', { dueDate: '2023-01-25' });
    const asConsultant = await call('consultant', 'GET', `/instances/${i.id}?asOf=2023-02-01`);
    expect(asConsultant.body).toMatchObject({ status: 'OVERDUE', overdueDays: 7 });
    expect((await call('owner', 'GET', `/instances/${i.id}?asOf=2023-02-01`)).status).toBe(403);
  });
});

describe('workflow arrows over HTTP', () => {
  it('OPEN → submit (owner) writes the state, a SUBMIT comment and a TRANSITION event', async () => {
    const i = await fresh();
    const res = await call('owner', 'POST', `/instances/${i.id}/submit`, {
      version: i.version,
      completedOn: '2023-01-19',
      comment: 'Return filed.',
    });
    expect(res.status).toBe(200);
    const detail = InstanceDetail.parse(res.body);
    expect(detail).toMatchObject({
      workflowState: 'SUBMITTED',
      pendingKind: 'COMPLETION',
      completedOn: '2023-01-19',
      status: 'SUBMITTED',
      version: i.version + 1,
      lastComment: 'Return filed.',
    });
    expect((await commentsOf(i.id)).map((c) => [c.kind, c.body, c.authorId])).toEqual([
      ['SUBMIT', 'Return filed.', f.people.owner],
    ]);
    const [event] = await historyOf(i.id);
    expect(event).toMatchObject({
      action: 'TRANSITION',
      actorId: f.people.owner,
      actorKind: 'PERSON',
      clientId: f.clientId,
      before: { workflowState: 'OPEN' },
      after: { workflowState: 'SUBMITTED', completedOn: '2023-01-19' },
    });
  });

  it('SUBMITTED → approve (approver) → APPROVED, COMPLIED when on time', async () => {
    const i = await fresh('SUBMITTED');
    const res = await call('approver', 'POST', `/instances/${i.id}/approve`, {
      version: i.version,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ workflowState: 'APPROVED', status: 'COMPLIED' });
    expect((await commentsOf(i.id))[0]).toMatchObject({ kind: 'APPROVE', body: 'Approved.' });
  });

  it('a client admin approves as delegate', async () => {
    const i = await fresh('SUBMITTED');
    const res = await call('clientAdmin', 'POST', `/instances/${i.id}/approve`, {
      version: i.version,
      comment: 'Checked for the approver.',
    });
    expect(res.status).toBe(200);
    expect((await historyOf(i.id))[0]!.after).toMatchObject({ delegated: true });
  });

  it('SUBMITTED → send back (approver) → SENT_BACK → submit again', async () => {
    const i = await fresh('SUBMITTED');
    const back = await call('approver', 'POST', `/instances/${i.id}/send-back`, {
      version: i.version,
      reason: 'Wrong challan attached.',
    });
    expect(back.body).toMatchObject({ workflowState: 'SENT_BACK', completedOn: null });
    const again = await call('owner', 'POST', `/instances/${i.id}/submit`, {
      version: i.version + 1,
      completedOn: '2023-01-20',
      comment: 'Right challan now.',
    });
    expect(again.body).toMatchObject({ workflowState: 'SUBMITTED', completedOn: '2023-01-20' });
    expect((await historyOf(i.id)).map((e) => e.reason)).toEqual([null, 'Wrong challan attached.']);
  });

  it('OPEN → request NA (owner) → approve → NOT_APPLICABLE', async () => {
    const i = await fresh();
    const na = await call('owner', 'POST', `/instances/${i.id}/request-na`, {
      version: i.version,
      reason: 'No boilers on site.',
    });
    expect(na.body).toMatchObject({ workflowState: 'SUBMITTED', pendingKind: 'NA' });
    const ok = await call('approver', 'POST', `/instances/${i.id}/approve`, {
      version: i.version + 1,
    });
    expect(ok.body).toMatchObject({
      workflowState: 'NOT_APPLICABLE',
      status: 'NOT_APPLICABLE',
      completedOn: '2023-01-20',
      naReason: 'No boilers on site.',
    });
  });

  it.each(['consultant', 'firmAdmin', 'clientAdmin'] as const)(
    'APPROVED → reopen (%s) → OPEN',
    async (who) => {
      const i = await fresh('APPROVED');
      const res = await call(who, 'POST', `/instances/${i.id}/reopen`, {
        version: i.version,
        reason: 'Approved by mistake.',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ workflowState: 'OPEN', completedOn: null });
      expect((await commentsOf(i.id))[0]).toMatchObject({ kind: 'REOPEN' });
    },
  );
});

describe('refusals', () => {
  it.each([
    ['approver', 'submit'],
    ['clientAdmin', 'submit'],
    ['viewer', 'submit'],
    ['otherOwner', 'submit'],
  ] as const)('%s cannot %s (403)', async (who, action) => {
    const i = await fresh();
    const res = await call(who, 'POST', `/instances/${i.id}/${action}`, {
      version: i.version,
      completedOn: '2023-01-19',
      comment: 'x',
    });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it.each(['owner', 'consultant', 'viewer'] as const)('%s cannot approve (403)', async (who) => {
    const i = await fresh('SUBMITTED');
    expect(
      (await call(who, 'POST', `/instances/${i.id}/approve`, { version: i.version })).status,
    ).toBe(403);
  });

  it('an owner cannot reopen (403)', async () => {
    const i = await fresh('APPROVED');
    const res = await call('owner', 'POST', `/instances/${i.id}/reopen`, {
      version: i.version,
      reason: 'x',
    });
    expect(res.status).toBe(403);
  });

  it('a stale version is 409 STALE_VERSION and writes nothing', async () => {
    const i = await fresh();
    const res = await call('owner', 'POST', `/instances/${i.id}/submit`, {
      version: i.version + 1,
      completedOn: '2023-01-19',
      comment: 'x',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'STALE_VERSION',
      details: { currentVersion: i.version },
    });
    expect(await historyOf(i.id)).toEqual([]);
    expect(await commentsOf(i.id)).toEqual([]);
  });

  it('an invalid move is 409 INVALID_TRANSITION', async () => {
    const i = await fresh('APPROVED');
    const res = await call('approver', 'POST', `/instances/${i.id}/send-back`, {
      version: i.version,
      reason: 'x',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { from: 'APPROVED', action: 'SEND_BACK' },
    });
  });

  it('a future completion date is 422 DATE_IN_FUTURE', async () => {
    const i = await fresh();
    const res = await call('owner', 'POST', `/instances/${i.id}/submit`, {
      version: i.version,
      completedOn: '2023-01-21',
      comment: 'x',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'DATE_IN_FUTURE',
      details: { today: '2023-01-20' },
    });
  });

  it('evidence-required obligations need a clean file (422 EVIDENCE_REQUIRED)', async () => {
    const i = await fresh('OPEN', { assignment: 'evidence' });
    const res = await call('owner', 'POST', `/instances/${i.id}/submit`, {
      version: i.version,
      completedOn: '2023-01-19',
      comment: 'x',
    });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('EVIDENCE_REQUIRED');
  });

  it('a missing comment is 400 VALIDATION', async () => {
    const i = await fresh();
    const res = await call('owner', 'POST', `/instances/${i.id}/submit`, {
      version: i.version,
      completedOn: '2023-01-19',
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION');
  });
});

describe('POST /clients/{clientId}/instances/bulk-approve', () => {
  it('approves per item and reports each result', async () => {
    const a = await fresh('SUBMITTED');
    const b = await fresh('OPEN');
    const c = await fresh('SUBMITTED');
    const foreign = await addInstance(testDb.db, other, {
      periodStart: '2022-04-01',
      dueDate: '2023-02-15',
      state: 'SUBMITTED',
    });
    const res = await call('approver', 'POST', `/clients/${f.clientId}/instances/bulk-approve`, {
      items: [
        { id: a.id, version: a.version },
        { id: b.id, version: b.version },
        { id: c.id, version: c.version + 5 },
        { id: foreign.id, version: foreign.version },
      ],
    });
    expect(res.status).toBe(200);
    const parsed = ENDPOINTS.bulkApprove.response.parse(res.body);
    expect(parsed.results.map((r) => [r.ok, r.error?.code])).toEqual([
      [true, undefined],
      [false, 'INVALID_TRANSITION'],
      [false, 'STALE_VERSION'],
      [false, 'NOT_FOUND'],
    ]);
    expect(parsed.results[0]!.item).toMatchObject({
      workflowState: 'APPROVED',
      status: 'COMPLIED',
    });
  });

  it('is 403 for someone who approves nothing in the client', async () => {
    const a = await fresh('SUBMITTED');
    const res = await call('owner', 'POST', `/clients/${f.clientId}/instances/bulk-approve`, {
      items: [{ id: a.id, version: a.version }],
    });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /instances/{id}', () => {
  it('moves the due date with a reason, sets dueDateOverridden and audits it', async () => {
    const i = await fresh();
    const res = await call('clientAdmin', 'PATCH', `/instances/${i.id}`, {
      version: i.version,
      dueDate: '2023-03-01',
      reason: 'Extension granted by the inspector.',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dueDate: '2023-03-01', status: 'UPCOMING' });
    const [event] = await historyOf(i.id);
    expect(event).toMatchObject({
      action: 'DUE_DATE_CHANGE',
      before: { dueDate: '2023-02-15', dueDateOverridden: false },
      after: { dueDate: '2023-03-01', dueDateOverridden: true },
      reason: 'Extension granted by the inspector.',
    });
  });

  it('reassigns the approver to someone who approves there, audited as REASSIGN', async () => {
    const i = await fresh();
    const res = await call('consultant', 'PATCH', `/instances/${i.id}`, {
      version: i.version,
      approverId: f.people.clientAdmin,
      reason: 'Approver on leave.',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approverId: f.people.clientAdmin });
    expect((await historyOf(i.id))[0]).toMatchObject({
      action: 'REASSIGN',
      before: { approverId: f.people.approver },
      after: { approverId: f.people.clientAdmin },
    });
  });

  it('refuses an owner who does not own that unit (400)', async () => {
    const i = await fresh();
    const res = await call('clientAdmin', 'PATCH', `/instances/${i.id}`, {
      version: i.version,
      ownerId: f.people.otherOwner,
      reason: 'Cover.',
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION');
  });

  it('is 409 on an approved instance and 403 for an owner', async () => {
    const done = await fresh('APPROVED');
    const late = await call('clientAdmin', 'PATCH', `/instances/${done.id}`, {
      version: done.version,
      dueDate: '2023-03-01',
      reason: 'x',
    });
    expect(late.body.error).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { from: 'APPROVED', action: 'CHANGE_DUE_DATE' },
    });
    const open = await fresh();
    const owner = await call('owner', 'PATCH', `/instances/${open.id}`, {
      version: open.version,
      dueDate: '2023-03-01',
      reason: 'x',
    });
    expect(owner.status).toBe(403);
  });

  it('rejects a blank reason (400) and records nothing when nothing changes', async () => {
    const i = await fresh();
    const blank = await call('clientAdmin', 'PATCH', `/instances/${i.id}`, {
      version: i.version,
      dueDate: '2023-03-01',
      reason: '   ',
    });
    expect(blank.status).toBe(400);
    expect(blank.body.error?.code).toBe('VALIDATION');
    const same = await call('clientAdmin', 'PATCH', `/instances/${i.id}`, {
      version: i.version,
      approverId: f.people.approver,
      dueDate: i.dueDate,
      reason: 'No change.',
    });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ version: i.version, dueDate: i.dueDate });
    expect(await historyOf(i.id)).toEqual([]);
  });

  it('reassigns the owner, and names REASSIGN when a closed instance is reassigned', async () => {
    const i = await fresh('SENT_BACK');
    const second = await call('clientAdmin', 'PATCH', `/instances/${i.id}`, {
      version: i.version + 1,
      ownerId: f.people.owner,
      reason: 'x',
    });
    expect(second.body.error).toMatchObject({
      code: 'STALE_VERSION',
      details: { currentVersion: i.version },
    });
    const done = await fresh('NOT_APPLICABLE');
    const closed = await call('clientAdmin', 'PATCH', `/instances/${done.id}`, {
      version: done.version,
      ownerId: f.people.owner,
      reason: 'x',
    });
    expect(closed.body.error).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { from: 'NOT_APPLICABLE', action: 'REASSIGN' },
    });
    const bad = await call('clientAdmin', 'PATCH', `/instances/${i.id}`, {
      version: i.version,
      approverId: f.people.owner,
      reason: 'x',
    });
    expect(bad.status).toBe(400);
  });
});

describe('comments', () => {
  it('an owner comments; everyone allowed reads them in pages, oldest first', async () => {
    const i = await fresh();
    for (const text of ['First.', 'Second.', 'Third.']) {
      const res = await call('owner', 'POST', `/instances/${i.id}/comments`, { body: text });
      expect(res.status).toBe(201);
      expect(Comment.parse(res.body)).toMatchObject({ kind: 'NOTE', body: text });
    }
    const first = await call('viewer', 'GET', `/instances/${i.id}/comments?limit=2`);
    expect(first.status).toBe(200);
    const page1 = ENDPOINTS.listComments.response.parse(first.body);
    expect(page1.items.map((c) => c.body)).toEqual(['First.', 'Second.']);
    const second = await call(
      'viewer',
      'GET',
      `/instances/${i.id}/comments?limit=2&cursor=${page1.nextCursor}`,
    );
    const page2 = ENDPOINTS.listComments.response.parse(second.body);
    expect(page2).toEqual({
      items: [expect.objectContaining({ body: 'Third.' })],
      nextCursor: null,
    });
  });

  it('rejects a cursor that names no comment (400)', async () => {
    const i = await fresh();
    const res = await call('viewer', 'GET', `/instances/${i.id}/comments?cursor=bm9wZQ`);
    expect(res.status).toBe(400);
  });

  it('a viewer cannot comment (403)', async () => {
    const i = await fresh();
    expect(
      (await call('viewer', 'POST', `/instances/${i.id}/comments`, { body: 'x' })).status,
    ).toBe(403);
  });
});

describe('register and queues', () => {
  let ids: { early: string; late: string; unitB: string; submitted: string };

  beforeEach(async () => {
    if (ids) return;
    const early = await fresh('OPEN', { dueDate: '2023-01-05' });
    const late = await fresh('OPEN', { dueDate: '2023-06-30' });
    const unitB = await fresh('OPEN', { assignment: 'unitB', dueDate: '2023-01-06' });
    const submitted = await fresh('SUBMITTED', { dueDate: '2023-01-07' });
    ids = { early: early.id, late: late.id, unitB: unitB.id, submitted: submitted.id };
  });

  async function allPages(who: Who, query: string): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/clients/${f.clientId}/instances?limit=2${query}${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await call(who, 'GET', url);
      expect(res.status).toBe(200);
      const page = ENDPOINTS.listInstances.response.parse(res.body);
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    return seen;
  }

  it('pages through the whole register in due-date order', async () => {
    const all = await allPages('clientAdmin', '');
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(expect.arrayContaining(Object.values(ids)));
    expect(all.indexOf(ids.early)).toBeLessThan(all.indexOf(ids.unitB));
    expect(all.indexOf(ids.unitB)).toBeLessThan(all.indexOf(ids.late));
  });

  it('limits an owner to their units', async () => {
    const mine = await allPages('owner', '');
    expect(mine).toContain(ids.early);
    expect(mine).not.toContain(ids.unitB);
  });

  it('filters on engine status, which the database cannot', async () => {
    const overdue = await allPages('viewer', '&status=OVERDUE');
    expect(overdue).toEqual(expect.arrayContaining([ids.early, ids.unitB]));
    expect(overdue).not.toContain(ids.late);
    expect(overdue).not.toContain(ids.submitted);
  });

  it('filters by financial year', async () => {
    const fy = await allPages('consultant', '&fy=2022-23');
    expect(fy).toContain(ids.early);
    expect(fy).not.toContain(ids.late);
  });

  it('applies every register filter the repository takes, and several values in memory', async () => {
    const query = [
      `unitId=${f.unitA}`,
      `departmentId=${f.departmentId}`,
      `actId=${f.actId}`,
      `categoryId=${f.categoryId}`,
      'ownerId=me',
      `approverId=${f.people.approver}`,
      'criticality=HIGH',
      'workflowState=OPEN',
      'timelineType=TIME_BASED',
      'domain=HRS',
      'dueFrom=2023-01-05',
      'dueTo=2023-01-05',
      'hasEvidence=false',
      'q=Annual',
    ].join('&');
    expect(await allPages('owner', `&${query}`)).toEqual([ids.early]);

    const unknown = '00000000-0000-4000-8000-000000000000';
    const several = await allPages(
      'clientAdmin',
      `&departmentId=${f.departmentId},${unknown}&actId=${f.actId},${unknown}&categoryId=${f.categoryId},${unknown}&approverId=${f.people.viewer}`,
    );
    expect(several).toEqual([]);
    const mine = await allPages(
      'approver',
      `&departmentId=${f.departmentId},${unknown}&actId=${f.actId},${unknown}&categoryId=${f.categoryId},${unknown}&approverId=me`,
    );
    expect(mine).toEqual(expect.arrayContaining(Object.values(ids)));
  });

  it('filters by completion date', async () => {
    const done = await allPages('viewer', '&completedFrom=2023-01-09&completedTo=2023-01-09');
    expect(done).toContain(ids.submitted);
    expect(done).not.toContain(ids.early);
  });

  it("drops units outside an owner's scope even when asked for", async () => {
    expect(await allPages('owner', `&unitId=${f.unitB}`)).toEqual([]);
  });

  it('lets only consultants, firm admins and viewers choose asOf (403)', async () => {
    const owner = await call('owner', 'GET', `/clients/${f.clientId}/instances?asOf=2022-12-01`);
    expect(owner.status).toBe(403);
    const queue = await call('owner', 'GET', '/me/tasks?asOf=2022-12-01');
    expect(queue.status).toBe(403);
    const viewer = await call(
      'viewer',
      'GET',
      `/clients/${f.clientId}/instances?asOf=2022-12-01&limit=200`,
    );
    expect(viewer.status).toBe(200);
  });

  it('refuses a sort the register cannot do yet (400)', async () => {
    const res = await call('viewer', 'GET', `/clients/${f.clientId}/instances?sort=-dueDate`);
    expect(res.status).toBe(400);
  });

  it("does not show another firm's client (404)", async () => {
    const res = await call(otherOwnerFirmB, 'GET', `/clients/${f.clientId}/instances`);
    expect(res.status).toBe(404);
  });

  it("/me/tasks lists the owner's OPEN and SENT_BACK work", async () => {
    const res = await call('owner', 'GET', '/me/tasks?limit=200');
    expect(res.status).toBe(200);
    const items = ENDPOINTS.myTasks.response.parse(res.body).items;
    expect(items.map((r) => r.id)).toContain(ids.early);
    expect(items.every((r) => r.ownerId === f.people.owner)).toBe(true);
    expect(items.every((r) => r.workflowState === 'OPEN' || r.workflowState === 'SENT_BACK')).toBe(
      true,
    );
  });

  it('/me/approvals lists SUBMITTED work for the approver and the client admin', async () => {
    for (const who of ['approver', 'clientAdmin'] as const) {
      const res = await call(who, 'GET', '/me/approvals?limit=200');
      const items = ENDPOINTS.myApprovals.response.parse(res.body).items;
      expect(items.map((r) => r.id)).toContain(ids.submitted);
      expect(items.every((r) => r.workflowState === 'SUBMITTED')).toBe(true);
    }
  });

  it('queues are 403 for roles without one', async () => {
    expect((await call('viewer', 'GET', '/me/tasks')).status).toBe(403);
    expect((await call('owner', 'GET', '/me/approvals')).status).toBe(403);
  });
});
