import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attach, createHarness, type Harness, type Reply, type Who } from './testing/fixture.js';

/**
 * Audit programmes, internal audits, their checklists and findings (model §3.7, §3.9, §4.3): the plan and its checks,
 * every INTERNAL_AUDIT arrow through the engine with its guards and delegation, the checklist rules, findings raising
 * their nonconformity in the same step, the finding type moves, `ids` and the other list filters, the programme's
 * coverage, files with their lock (model §6), and the audit trail with no free text (model §8, non-negotiable 6).
 */

const NOW = new Date('2026-10-20T06:00:00Z');
let h: Harness;
/** Unit A only, on 9001 and 14001. */
let systemA: string;
/** Both units, on 9001 only. */
let systemAB: string;

beforeAll(async () => {
  h = await createHarness('Audit', NOW);
  const system = async (name: string, standardIds: string[], unitIds: string[]) =>
    (await h.ok('clientAdmin', 'POST', '/systems', { name, standardIds, unitIds })).id as string;
  systemA = await system('Stonebridge system', [h.f.std9001, h.f.std14001], [h.f.unitA]);
  systemAB = await system('Both plants system', [h.f.std9001], [h.f.unitA, h.f.unitB]);
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
    'SELECT action, before, after, reason FROM audit_event WHERE entity_id = $1 ORDER BY at, action, after::text',
    [entityId],
  );

const c = (key: string) => h.f.clauses[key]!;

let fys = 0;
/** A fresh programme (one per system and FY). */
async function programme(systemId = systemA): Promise<string> {
  const start = 2030 + fys++;
  const fy = `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
  return (
    await h.ok('clientAdmin', 'POST', '/audit-programmes', { managementSystemId: systemId, fy })
  ).id as string;
}

type Audit = { id: string; version: number; state: string } & Record<string, unknown>;

/** An audit of 9001 clause 4.1 led by the unit A owner, reported to the client admin. */
async function plan(fields: Record<string, unknown> = {}, systemId = systemA): Promise<Audit> {
  return (await h.ok('clientAdmin', 'POST', '/internal-audits', {
    programmeId: await programme(systemId),
    title: 'Stores audit',
    plannedStart: '2026-10-12',
    plannedEnd: '2026-10-13',
    clauseIds: [c('9001:4.1')],
    leadAuditorId: h.f.people.owner,
    reportedToIds: [h.f.people.clientAdmin],
    ...fields,
  })) as Audit;
}

async function started(fields: Record<string, unknown> = {}, systemId = systemA): Promise<Audit> {
  const a = await plan(fields, systemId);
  return (await h.ok('owner', 'POST', `/internal-audits/${a.id}/start`, { version: 1 })) as Audit;
}

const path = (a: { id: string }) => `/internal-audits/${a.id}`;

async function row(a: Audit, clauseKey = '9001:4.1', who: Who = 'owner') {
  return h.ok(who, 'POST', `${path(a)}/checklist`, {
    clauseId: c(clauseKey),
    question: 'Is the context recorded?',
  });
}

const NC = (fields: Record<string, unknown> = {}) => ({
  ownerId: h.f.people.owner,
  approverId: h.f.people.approver,
  dueOn: '2026-11-30',
  ...fields,
});

describe('audit programmes', () => {
  it('one per system and FY; newest FY first; coverage from the engine', async () => {
    const system = (
      await h.ok('clientAdmin', 'POST', '/systems', {
        name: 'Programme system',
        standardIds: [h.f.std9001],
        unitIds: [h.f.unitA],
      })
    ).id as string;
    const older = await h.ok('clientAdmin', 'POST', '/audit-programmes', {
      managementSystemId: system,
      fy: '2025-26',
    });
    const newer = await h.ok('clientAdmin', 'POST', '/audit-programmes', {
      managementSystemId: system,
      fy: '2026-27',
      notes: 'Two audits',
    });
    const dup = await h.send('consultant', 'POST', '/audit-programmes', {
      managementSystemId: system,
      fy: '2026-27',
    });
    expect([dup.status, code(dup), details(dup)]).toEqual([
      409,
      'DUPLICATE',
      { field: 'fy', existingId: newer.id },
    ]);
    const list = await h.ok('owner', 'GET', `/audit-programmes?managementSystemId=${system}`);
    expect((list.items as { id: string }[]).map((p) => p.id)).toEqual([newer.id, older.id]);
    expect(
      (
        (await h.ok('owner', 'GET', `/audit-programmes?managementSystemId=${system}&fy=2025-26`))
          .items as { id: string }[]
      ).map((p) => p.id),
    ).toEqual([older.id]);
    // Nothing reported yet: the assessable clauses (not "4") and unit A are uncovered.
    expect(newer.coverage).toEqual({
      fy: '2026-27',
      uncoveredClauseIds: [c('9001:4.1'), c('9001:8.3'), c('9001:10.1')],
      uncoveredUnitIds: [h.f.unitA],
      planned: { count: 0, ids: [] },
      reported: { count: 0, ids: [] },
      cancelled: { count: 0, ids: [] },
    });
    expect(
      (
        await h.send('owner', 'POST', '/audit-programmes', {
          managementSystemId: system,
          fy: '2027-28',
        })
      ).status,
    ).toBe(403);

    // A reported audit with a CONFORMS row on unit A covers clause 4.1 and the unit.
    const a = (await h.ok('clientAdmin', 'POST', '/internal-audits', {
      programmeId: newer.id,
      title: 'Context audit',
      plannedStart: '2026-10-12',
      plannedEnd: '2026-10-13',
      clauseIds: [c('9001:4.1')],
      unitIds: [h.f.unitA],
      leadAuditorId: h.f.people.owner,
      reportedToIds: [h.f.people.clientAdmin],
    })) as Audit;
    await h.ok('owner', 'POST', `${path(a)}/start`, { version: 1 });
    const r = await row(a);
    await h.ok('owner', 'PATCH', `${path(a)}/checklist/${r.id}`, {
      version: 1,
      result: 'CONFORMS',
    });
    await h.ok('owner', 'POST', `${path(a)}/report`, { version: 2, summary: 'Conforms' });
    const cancelled = (await h.ok('clientAdmin', 'POST', '/internal-audits', {
      programmeId: newer.id,
      title: 'Dropped audit',
      plannedStart: '2026-12-01',
      plannedEnd: '2026-12-01',
      leadAuditorId: h.f.people.clientAdmin,
    })) as Audit;
    await h.ok('clientAdmin', 'POST', `${path(cancelled)}/cancel`, {
      version: 1,
      reason: 'Merged',
    });
    const after = await h.ok('clientAdmin', 'PATCH', `/audit-programmes/${newer.id}`, {
      version: 1,
      notes: 'One audit',
    });
    expect(after.coverage).toEqual({
      fy: '2026-27',
      uncoveredClauseIds: [c('9001:8.3'), c('9001:10.1')],
      uncoveredUnitIds: [],
      planned: { count: 1, ids: [a.id] },
      reported: { count: 1, ids: [a.id] },
      cancelled: { count: 1, ids: [cancelled.id] },
    });
    // The unit B owner sees neither the programme nor its audits' counts.
    expect(
      (await h.ok('otherOwner', 'GET', `/audit-programmes?managementSystemId=${system}`)).items,
    ).toEqual([]);
    expect((await audit(newer.id as string)).map((e) => e.action)).toEqual(['CREATE', 'UPDATE']);
  });
});

describe('planning an internal audit', () => {
  it('checks clauses, units, people and independence against the system', async () => {
    const programmeId = await programme();
    const base = {
      programmeId,
      title: 'Stores audit',
      plannedStart: '2026-10-12',
      plannedEnd: '2026-10-13',
      leadAuditorId: h.f.people.owner,
    };
    const send = (fields: Record<string, unknown>, who: Who = 'clientAdmin') =>
      h.send(who, 'POST', '/internal-audits', { ...base, ...fields });
    // A clause of a standard the system does not have (14001 is systemA's, so use AB's 9001-only).
    const abProgramme = await programme(systemAB);
    const r1 = await send({ programmeId: abProgramme, clauseIds: [c('14001:4.1')] });
    expect([r1.status, field(r1)]).toEqual([400, ['clauseIds']]);
    const r2 = await send({ unitIds: [h.f.unitB] });
    expect([r2.status, field(r2)]).toEqual([400, ['unitIds']]);
    const r3 = await send({ auditeeIds: [h.f.people.viewer] });
    expect([r3.status, field(r3)]).toEqual([400, ['auditeeIds']]);
    const r4 = await send({ auditeeIds: [h.f.people.owner] });
    expect([r4.status, field(r4)]).toEqual([400, ['independenceNote']]);
    expect((await send({}, 'owner')).status).toBe(403);
    const created = await h.ok('consultant', 'POST', '/internal-audits', {
      ...base,
      auditeeIds: [h.f.people.owner],
      independenceNote: 'Audits a process they do not run',
    });
    expect(created).toMatchObject({
      state: 'PLANNED',
      managementSystemId: systemA,
      allowedActions: ['START', 'CANCEL'],
    });
    expect((await h.ok('owner', 'GET', path(created as Audit))).allowedActions).toEqual(['START']);
    expect((await h.ok('approver', 'GET', path(created as Audit))).allowedActions).toEqual([]);
    expect((await audit(created.id as string))[0]).toMatchObject({
      action: 'CREATE',
      after: expect.objectContaining({
        independenceNote: 'Audits a process they do not run',
        state: 'PLANNED',
      }),
    });
  });

  it('edits group into DUE_DATE_CHANGE, REASSIGN and UPDATE with the reason', async () => {
    const a = await plan();
    const noReason = await h.send('clientAdmin', 'PATCH', path(a), {
      version: 1,
      plannedEnd: '2026-10-14',
    });
    expect([noReason.status, code(noReason)]).toEqual([422, 'REASON_REQUIRED']);
    const edited = await h.ok('clientAdmin', 'PATCH', path(a), {
      version: 1,
      plannedEnd: '2026-10-14',
      leadAuditorId: h.f.people.approver,
      title: 'Stores and despatch audit',
      reason: 'Despatch added',
    });
    expect(edited).toMatchObject({ version: 2, leadAuditorId: h.f.people.approver });
    const events = (await audit(a.id)).slice(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'DUE_DATE_CHANGE',
          after: { plannedEnd: '2026-10-14' },
          reason: 'Despatch added',
        }),
        expect.objectContaining({
          action: 'REASSIGN',
          after: { leadAuditorId: h.f.people.approver },
          reason: 'Despatch added',
        }),
        expect.objectContaining({
          action: 'UPDATE',
          after: { title: 'Stores and despatch audit' },
          reason: null,
        }),
      ]),
    );
    expect(events).toHaveLength(3);
    const lead = await h.send('clientAdmin', 'PATCH', path(a), {
      version: 2,
      auditorIds: [h.f.people.approver],
    });
    expect([lead.status, field(lead)]).toEqual([400, ['auditorIds']]);
  });

  it('a unit move covers the new units, and keeps rows and findings on the audit', async () => {
    const a = await started({ unitIds: [h.f.unitA] }, systemAB);
    await row(a);
    const r = await h.ok('owner', 'POST', `${path(a)}/checklist`, {
      clauseId: c('9001:4.1'),
      unitId: h.f.unitA,
      question: 'Is the context recorded on site?',
    });
    expect(r.unitId).toBe(h.f.unitA);
    const stranded = await h.send('clientAdmin', 'PATCH', path(a), {
      version: 2,
      unitIds: [h.f.unitB],
    });
    expect([stranded.status, field(stranded)]).toEqual([400, ['unitIds']]);
    // The unit B approver does not see a unit A audit; the lead auditor sees it but does not plan it.
    expect((await h.send('approverB', 'PATCH', path(a), { version: 2, unitIds: [] })).status).toBe(
      404,
    );
    expect((await h.send('owner', 'PATCH', path(a), { version: 2, unitIds: [] })).status).toBe(403);
    const moved = await h.ok('clientAdmin', 'PATCH', path(a), {
      version: 2,
      unitIds: [h.f.unitA, h.f.unitB],
    });
    expect(moved.unitIds).toEqual([h.f.unitA, h.f.unitB]);
  });

  it('a REPORTED audit is locked to edits, rows and findings (409)', async () => {
    const a = await started();
    const r = await row(a);
    await h.ok('owner', 'PATCH', `${path(a)}/checklist/${r.id}`, {
      version: 1,
      result: 'CONFORMS',
    });
    await h.ok('owner', 'POST', `${path(a)}/report`, { version: 2, summary: 'Conforms' });
    for (const reply of [
      await h.send('clientAdmin', 'PATCH', path(a), { version: 3, title: 'Late' }),
      await h.send('owner', 'POST', `${path(a)}/checklist`, {
        clauseId: c('9001:4.1'),
        question: 'Late',
      }),
      await h.send('owner', 'PATCH', `${path(a)}/checklist/${r.id}`, {
        version: 2,
        auditorNote: 'Late',
      }),
      await h.send('owner', 'POST', `${path(a)}/findings`, { type: 'OFI', description: 'Late' }),
    ]) {
      expect([reply.status, code(reply), details(reply)]).toEqual([
        409,
        'INVALID_TRANSITION',
        { entity: 'internal_audit', from: 'REPORTED', action: 'UPDATE' },
      ]);
    }
  });
});

describe('the internal audit machine', () => {
  it('REPORT needs every clause answered, someone reported to and a date not after today', async () => {
    const a = await started({ clauseIds: [c('9001:4.1'), c('9001:10.1')], reportedToIds: [] });
    const report = (body: Record<string, unknown>) =>
      h.send('owner', 'POST', `${path(a)}/report`, { version: 2, summary: 'Done', ...body });
    const noOne = await report({});
    expect([noOne.status, field(noOne)]).toEqual([400, ['reportedToIds']]);
    const r1 = await row(a);
    await h.ok('owner', 'PATCH', `${path(a)}/checklist/${r1.id}`, {
      version: 1,
      result: 'CONFORMS',
    });
    const unanswered = await report({ reportedToIds: [h.f.people.clientAdmin] });
    expect([unanswered.status, field(unanswered)]).toEqual([400, ['checklist']]);
    const r2 = await row(a, '9001:10.1');
    await h.ok('owner', 'PATCH', `${path(a)}/checklist/${r2.id}`, {
      version: 1,
      result: 'NOT_AUDITED',
      notAuditedReason: 'No improvement records yet',
    });
    const future = await report({
      reportedToIds: [h.f.people.clientAdmin],
      reportedOn: '2026-10-21',
    });
    expect([future.status, field(future)]).toEqual([400, ['reportedOn']]);
    const viewer = await report({ reportedToIds: [h.f.people.viewer] });
    expect([viewer.status, field(viewer)]).toEqual([400, ['reportedToIds']]);
    // The client admin reports as delegate of the lead auditor, on the client's today by default.
    const reported = await h.ok('clientAdmin', 'POST', `${path(a)}/report`, {
      version: 2,
      summary: 'One clause not audited',
      reportedToIds: [h.f.people.clientAdmin],
    });
    expect(reported).toMatchObject({
      state: 'REPORTED',
      reportedOn: '2026-10-20',
      summary: 'One clause not audited',
      reportedToIds: [h.f.people.clientAdmin],
    });
    expect((await audit(a.id)).at(-1)).toMatchObject({
      action: 'TRANSITION',
      after: expect.objectContaining({ action: 'REPORT', state: 'REPORTED', delegated: true }),
    });
  });

  it('START by the lead is not delegated; START by an approver off the team is refused', async () => {
    const a = await plan({ auditorIds: [h.f.people.approverB] });
    expect((await h.send('approver', 'POST', `${path(a)}/start`, { version: 1 })).status).toBe(403);
    const twice = await h.send('owner', 'POST', `${path(a)}/report`, { version: 1, summary: 'x' });
    expect([twice.status, details(twice)]).toEqual([
      409,
      { entity: 'internal_audit', from: 'PLANNED', action: 'REPORT' },
    ]);
    const key = randomUUID();
    const first = await h.send(
      'owner',
      'POST',
      `${path(a)}/start`,
      { version: 1 },
      { 'idempotency-key': key },
    );
    const again = await h.send(
      'owner',
      'POST',
      `${path(a)}/start`,
      { version: 1 },
      { 'idempotency-key': key },
    );
    expect([first.status, again.status, again.body.version]).toEqual([200, 200, 2]);
    expect(first.body.allowedActions).toEqual(['REPORT']);
    const start = (await audit(a.id)).filter((e) => e.action === 'TRANSITION');
    expect(start).toHaveLength(1);
    expect(start[0]!.after).toEqual({ action: 'START', state: 'IN_PROGRESS' });
    // An auditor on the team conducts too.
    expect((await h.ok('approverB', 'GET', path(a))).allowedActions).toEqual(['REPORT']);
  });

  it('CLOSE waits for the NCs its findings raised to leave OPEN; CANCEL needs a reason', async () => {
    const a = await started();
    const r = await row(a);
    const finding = await h.ok('owner', 'POST', `${path(a)}/findings`, {
      type: 'MINOR_NC',
      checklistItemId: r.id,
      description: 'Context not reviewed',
      nonconformity: NC({ ownerId: h.f.people.clientAdmin }),
    });
    await h.ok('owner', 'POST', `${path(a)}/report`, { version: 2, summary: 'One finding' });
    const open = await h.send('owner', 'POST', `${path(a)}/close`, { version: 3 });
    expect([open.status, field(open)]).toEqual([400, ['nonconformities']]);
    await h.ok('clientAdmin', 'POST', `/nonconformities/${finding.nonconformityId}/root-cause`, {
      version: 1,
      containment: 'None needed',
      correction: 'Reviewed',
      rootCauseMethod: 'FIVE_WHYS',
      rootCause: 'No review date set',
      similarOccurrences: 'None',
    });
    const closed = await h.ok('clientAdmin', 'POST', `${path(a)}/close`, { version: 3 });
    expect(closed).toMatchObject({ state: 'CLOSED', allowedActions: [] });
    // A client admin closes in their own right.
    expect((await audit(a.id)).at(-1)!.after).toEqual({ action: 'CLOSE', state: 'CLOSED' });

    const b = await plan();
    const noReason = await h.send('clientAdmin', 'POST', `${path(b)}/cancel`, { version: 1 });
    expect([noReason.status, code(noReason)]).toEqual([422, 'REASON_REQUIRED']);
    expect(
      (await h.send('owner', 'POST', `${path(b)}/cancel`, { version: 1, reason: 'No' })).status,
    ).toBe(403);
    const cancelled = await h.ok('consultant', 'POST', `${path(b)}/cancel`, {
      version: 1,
      reason: 'Merged with the stores audit',
    });
    expect(cancelled).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'Merged with the stores audit',
    });
    expect((await audit(b.id)).at(-1)).toMatchObject({
      reason: 'Merged with the stores audit',
      after: expect.objectContaining({ action: 'CANCEL', delegated: true }),
    });
  });
});

describe('the checklist', () => {
  it('rows are of the audit’s clauses and units, ordered by clause, with the result rules', async () => {
    const a = await plan({
      clauseIds: [c('14001:4.1'), c('9001:10.1'), c('9001:4.1')],
      unitIds: [h.f.unitA],
    });
    const notOfAudit = await h.send('owner', 'POST', `${path(a)}/checklist`, {
      clauseId: c('9001:8.3'),
      question: 'Design?',
    });
    expect([notOfAudit.status, field(notOfAudit)]).toEqual([400, ['clauseId']]);
    const r14 = await row(a, '14001:4.1');
    const r10 = await row(a, '9001:10.1');
    const r4 = await row(a, '9001:4.1');
    const list = await h.ok('owner', 'GET', `${path(a)}/checklist`);
    expect((list.items as { id: string }[]).map((i) => i.id)).toEqual([r4.id, r10.id, r14.id]);
    expect((await h.send('otherOwner', 'GET', `${path(a)}/checklist`)).status).toBe(404);
    expect(
      (
        await h.send('approver', 'POST', `${path(a)}/checklist`, {
          clauseId: c('9001:4.1'),
          question: 'Again?',
        })
      ).status,
    ).toBe(403);

    const at = `${path(a)}/checklist/${r4.id}`;
    const noReason = await h.send('owner', 'PATCH', at, { version: 1, result: 'NOT_AUDITED' });
    expect([noReason.status, field(noReason)]).toEqual([400, ['notAuditedReason']]);
    const notAudited = await h.ok('owner', 'PATCH', at, {
      version: 1,
      result: 'NOT_AUDITED',
      notAuditedReason: 'Records offsite',
    });
    expect(notAudited.notAuditedReason).toBe('Records offsite');
    // Moving away clears the reason.
    const conforms = await h.ok('owner', 'PATCH', at, { version: 2, result: 'CONFORMS' });
    expect([conforms.result, conforms.notAuditedReason]).toEqual(['CONFORMS', null]);
    // A FINDING row links a finding of this audit, not another's.
    const other = await started();
    const elsewhere = await h.ok('owner', 'POST', `${path(other)}/findings`, {
      type: 'OFI',
      description: 'Elsewhere',
    });
    const wrong = await h.send('owner', 'PATCH', at, {
      version: 3,
      result: 'FINDING',
      findingId: elsewhere.id,
    });
    expect([wrong.status, field(wrong)]).toEqual([400, ['findingId']]);
    const badUnit = await h.send('owner', 'PATCH', at, { version: 3, unitId: h.f.unitB });
    expect([badUnit.status, field(badUnit)]).toEqual([400, ['unitId']]);
  });
});

describe('internal findings', () => {
  it('a NC finding raises its nonconformity, marks the row and copies no description', async () => {
    const a = await started({ clauseIds: [c('9001:4.1'), c('14001:4.1')], unitIds: [h.f.unitA] });
    const item = await row(a, '14001:4.1');
    const send = (body: Record<string, unknown>, who: Who = 'owner') =>
      h.send(who, 'POST', `${path(a)}/findings`, {
        type: 'MAJOR_NC',
        checklistItemId: item.id,
        description: 'Aspects register names Asha Verma as the only reviewer',
        nonconformity: NC(),
        ...body,
      });
    const owner = await send({ nonconformity: NC({ ownerId: h.f.people.approverB }) });
    expect([owner.status, field(owner)]).toEqual([400, ['nonconformity', 'ownerId']]);
    const approver = await send({ nonconformity: NC({ approverId: h.f.people.otherOwner }) });
    expect([approver.status, field(approver)]).toEqual([400, ['nonconformity', 'approverId']]);
    const late = await send({ nonconformity: NC({ dueOn: '2026-10-19' }) });
    expect([late.status, field(late)]).toEqual([400, ['nonconformity', 'dueOn']]);
    expect((await send({}, 'approver')).status).toBe(403);

    const finding = await h.ok('owner', 'POST', `${path(a)}/findings`, {
      type: 'MAJOR_NC',
      checklistItemId: item.id,
      description: 'Aspects register names Asha Verma as the only reviewer',
      nonconformity: NC(),
    });
    // The finding takes the row's clause (the row has no unit); the row is marked FINDING.
    expect(finding).toMatchObject({
      internalAuditId: a.id,
      externalAuditId: null,
      type: 'MAJOR_NC',
      clauseIds: [c('14001:4.1')],
      unitId: null,
    });
    const rows = (await h.ok('owner', 'GET', `${path(a)}/checklist`)).items as Record<
      string,
      unknown
    >[];
    expect(rows[0]).toMatchObject({ result: 'FINDING', findingId: finding.id });
    const twice = await send({});
    expect([twice.status, field(twice)]).toEqual([400, ['checklistItemId']]);
    // Its nonconformity sits on the audit's single unit.
    const nc = await h.ok('owner', 'GET', `/nonconformities/${finding.nonconformityId}`);
    expect(nc).toMatchObject({
      source: 'INTERNAL_AUDIT',
      severity: 'MAJOR',
      standards: ['ISO_14001'],
      clauseIds: [c('14001:4.1')],
      unitId: h.f.unitA,
      reportedOn: '2026-10-20',
      state: 'OPEN',
    });
    const raise = await audit(nc.id as string);
    expect(raise[0]).toMatchObject({
      action: 'CREATE',
      after: expect.objectContaining({ action: 'RAISE', auditFindingId: finding.id }),
    });
    const created = await audit(finding.id as string);
    expect(created[0]!.after).toEqual({
      internalAuditId: a.id,
      type: 'MAJOR_NC',
      clauseIds: [c('14001:4.1')],
      unitId: null,
      nonconformityId: nc.id,
    });
    const trail = JSON.stringify([...raise, ...created]);
    expect(trail).not.toContain('Asha Verma');

    // An unlisted finding of no clause takes its NC's standards from the audit's clauses.
    const bare = await h.ok('owner', 'POST', `${path(a)}/findings`, {
      type: 'MINOR_NC',
      description: 'No clause given',
      nonconformity: NC(),
    });
    expect(await h.ok('owner', 'GET', `/nonconformities/${bare.nonconformityId}`)).toMatchObject({
      standards: ['ISO_9001', 'ISO_14001'],
      unitId: h.f.unitA,
    });
    const list = await h.ok('approver', 'GET', `${path(a)}/findings`);
    expect((list.items as { id: string }[]).map((f) => f.id)).toEqual([finding.id, bare.id]);
  });

  it('finding type moves: within a family only, and an NC move follows its nonconformity', async () => {
    const a = await started();
    const ofi = await h.ok('owner', 'POST', `${path(a)}/findings`, {
      type: 'OFI',
      description: 'Labels could be clearer',
    });
    const at = (f: Record<string, unknown>) => `${path(a)}/findings/${f.id}`;
    const toNc = await h.send('owner', 'PATCH', at(ofi), { version: 1, type: 'MINOR_NC' });
    expect([toNc.status, field(toNc)]).toEqual([400, ['type']]);
    await h.ok('clientAdmin', 'POST', '/actions', {
      subject: { type: 'AUDIT_FINDING', id: ofi.id },
      text: 'Reprint the labels',
      ownerId: h.f.people.clientAdmin,
      dueOn: '2026-11-30',
    });
    const good = await h.send('owner', 'PATCH', at(ofi), { version: 1, type: 'GOOD_PRACTICE' });
    expect([good.status, field(good)]).toEqual([400, ['type']]);
    const obs = await h.ok('owner', 'PATCH', at(ofi), {
      version: 1,
      type: 'OBSERVATION',
      description: 'Labels named by Asha Verma',
    });
    expect(obs).toMatchObject({ type: 'OBSERVATION', version: 2 });
    expect((await audit(ofi.id as string)).at(-1)).toMatchObject({
      action: 'UPDATE',
      before: { type: 'OFI', description: '[not recorded]' },
      after: { type: 'OBSERVATION', description: '[not recorded]' },
    });

    const major = await h.ok('owner', 'POST', `${path(a)}/findings`, {
      type: 'MAJOR_NC',
      description: 'No context review',
      nonconformity: NC({ ownerId: h.f.people.clientAdmin }),
    });
    const toOfi = await h.send('owner', 'PATCH', at(major), { version: 1, type: 'OFI' });
    expect([toOfi.status, field(toOfi)]).toEqual([400, ['type']]);
    // The NC's owner never moves the severity.
    const own = await h.send('clientAdmin', 'PATCH', at(major), { version: 1, type: 'MINOR_NC' });
    expect([own.status, code(own)]).toEqual([403, 'FORBIDDEN']);
    const minor = await h.ok('owner', 'PATCH', at(major), { version: 1, type: 'MINOR_NC' });
    expect(minor.type).toBe('MINOR_NC');
    const nc = await h.ok('owner', 'GET', `/nonconformities/${major.nonconformityId}`);
    expect(nc.severity).toBe('MINOR');
    expect((await audit(nc.id as string)).at(-1)).toMatchObject({
      action: 'UPDATE',
      before: { severity: 'MAJOR' },
      after: { severity: 'MINOR' },
    });
    // Past ROOT_CAUSE_FOUND the severity is fixed: 409 on the nonconformity.
    await h.ok('clientAdmin', 'POST', `/nonconformities/${nc.id}/root-cause`, {
      version: nc.version,
      containment: 'None',
      correction: 'Reviewed',
      rootCauseMethod: 'FIVE_WHYS',
      rootCause: 'No date set',
      similarOccurrences: 'None',
    });
    await h.ok('clientAdmin', 'POST', '/actions', {
      subject: { type: 'NONCONFORMITY', id: nc.id },
      text: 'Set a review date',
      ownerId: h.f.people.clientAdmin,
      dueOn: '2026-11-30',
    });
    const now = await h.ok('owner', 'GET', `/nonconformities/${nc.id}`);
    await h.ok('clientAdmin', 'POST', `/nonconformities/${nc.id}/plan-actions`, {
      version: now.version,
      effectivenessDueOn: '2026-12-31',
    });
    const fixed = await h.send('owner', 'PATCH', at(major), { version: 2, type: 'MAJOR_NC' });
    expect([fixed.status, details(fixed)]).toEqual([
      409,
      { entity: 'nonconformity', from: 'ACTIONS_PLANNED', action: 'UPDATE' },
    ]);
  });
});

describe('the internal-audit list', () => {
  it('filters by ids, programme, state, lead, unit, dates and text, in planned-start order', async () => {
    const programmeId = await programme(systemAB);
    const make = (fields: Record<string, unknown>) =>
      h.ok('clientAdmin', 'POST', '/internal-audits', {
        programmeId,
        plannedEnd: '2026-12-31',
        leadAuditorId: h.f.people.clientAdmin,
        ...fields,
      });
    const later = await make({
      title: 'B despatch',
      plannedStart: '2026-12-01',
      unitIds: [h.f.unitB],
    });
    const earlyB = await make({ title: 'B stores', plannedStart: '2026-11-01' });
    const earlyA = await make({
      title: 'A stores',
      plannedStart: '2026-11-01',
      unitIds: [h.f.unitA],
      leadAuditorId: h.f.people.owner,
    });
    const other = await plan();
    const ids = async (who: Who, query: string) =>
      ((await h.ok(who, 'GET', `/internal-audits?${query}`)).items as { id: string }[]).map(
        (a) => a.id,
      );
    expect(await ids('clientAdmin', `programmeId=${programmeId}`)).toEqual([
      earlyA.id,
      earlyB.id,
      later.id,
    ]);
    expect(await ids('clientAdmin', `ids=${later.id},${other.id}`)).toEqual([other.id, later.id]);
    expect(
      await ids('clientAdmin', `ids=${later.id}&programmeId=${programmeId}&state=CANCELLED`),
    ).toEqual([]);
    expect(await ids('owner', `programmeId=${programmeId}&leadAuditorId=me`)).toEqual([earlyA.id]);
    // The system-wide audit covers both units.
    expect(await ids('clientAdmin', `programmeId=${programmeId}&unitId=${h.f.unitB}`)).toEqual([
      earlyB.id,
      later.id,
    ]);
    expect(await ids('clientAdmin', `programmeId=${programmeId}&from=2026-11-15`)).toEqual([
      later.id,
    ]);
    expect(await ids('clientAdmin', `programmeId=${programmeId}&q=despatch`)).toEqual([later.id]);
    expect(await ids('clientAdmin', `managementSystemId=${systemAB}&to=2026-11-01`)).toEqual(
      expect.arrayContaining([earlyA.id, earlyB.id]),
    );
    // The unit A owner sees unit A's and the system-wide audits, not unit B's; the ids filter cannot widen that.
    expect(await ids('owner', `ids=${later.id},${earlyA.id}`)).toEqual([earlyA.id]);
    const page = await h.ok(
      'clientAdmin',
      'GET',
      `/internal-audits?programmeId=${programmeId}&limit=2&count=true`,
    );
    expect([(page.items as unknown[]).length, page.total]).toEqual([2, 3]);
    const next = await h.ok(
      'clientAdmin',
      'GET',
      `/internal-audits?programmeId=${programmeId}&limit=2&cursor=${page.nextCursor}`,
    );
    expect([(next.items as { id: string }[]).map((a) => a.id), next.nextCursor]).toEqual([
      [later.id],
      null,
    ]);
  });
});

describe('files on audits and findings (model §6)', () => {
  it('the audit team writes them until the audit is REPORTED', async () => {
    const a = await started();
    const finding = await h.ok('owner', 'POST', `${path(a)}/findings`, {
      type: 'OFI',
      description: 'Labels could be clearer',
    });
    await attach(h, 'owner', { type: 'internal_audit', id: a.id });
    await attach(h, 'owner', { type: 'audit_finding', id: finding.id as string });
    const ticket = {
      subject: { type: 'internal_audit', id: a.id },
      fileName: 'plan.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
    };
    expect((await h.send('approver', 'POST', '/files/upload-url', ticket)).status).toBe(403);
    expect((await h.send('otherOwner', 'POST', '/files/upload-url', ticket)).status).toBe(404);
    const r = await row(a);
    await h.ok('owner', 'PATCH', `${path(a)}/checklist/${r.id}`, {
      version: 1,
      result: 'CONFORMS',
    });
    await h.ok('owner', 'POST', `${path(a)}/report`, { version: 2, summary: 'Conforms' });
    for (const subject of [
      { type: 'internal_audit', id: a.id },
      { type: 'audit_finding', id: finding.id },
    ]) {
      const locked = await h.send('owner', 'POST', '/files/upload-url', { ...ticket, subject });
      expect([locked.status, details(locked)]).toEqual([
        409,
        { entity: 'internal_audit', from: 'REPORTED', action: 'UPDATE' },
      ]);
    }
    const listed = await h.ok(
      'approver',
      'GET',
      `/files?subjectType=audit_finding&subjectId=${finding.id}`,
    );
    expect((listed.items as unknown[]).length).toBe(1);
  });
});
