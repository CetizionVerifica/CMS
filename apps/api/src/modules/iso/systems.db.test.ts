import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type Who } from './testing/fixture.js';

/**
 * Catalogue reads, management systems, the climate decision, context items and the clause checklist with its N/A
 * machine (model §3.1-3.3, §4.6; plan §3.2-3.3, §7 item 7), per role, with the audit events each change writes.
 */

const NOW = new Date('2026-10-20T06:00:00Z');
let h: Harness;

beforeAll(async () => {
  h = await createHarness('Sys', NOW);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const audit = (entityId: string) =>
  h.testDb.query<{
    action: string;
    before: unknown;
    after: Record<string, unknown> | null;
    reason: string | null;
    actor_id: string;
  }>(
    'SELECT action, before, after, reason, actor_id FROM audit_event WHERE entity_id = $1 ORDER BY at, id',
    [entityId],
  );

async function system(units: string[] = [], standards = [h.f.std9001]) {
  return h.ok('clientAdmin', 'POST', '/systems', {
    name: `System ${Math.random().toString(36).slice(2, 8)}`,
    standardIds: standards,
    unitIds: units,
  });
}

async function checklist(who: Who, systemId: string, q = '') {
  const reply = await h.send(who, 'GET', `/systems/${systemId}/checklist${q}`);
  return reply;
}

async function rowOf(systemId: string, number: string, std = '9001') {
  const { items } = (await h.ok('clientAdmin', 'GET', `/systems/${systemId}/checklist`)) as {
    items: { id: string; clauseNumber: string; standardId: string; version: number }[];
  };
  const standardId = std === '9001' ? h.f.std9001 : h.f.std14001;
  return items.find((r) => r.clauseNumber === number && r.standardId === standardId)!;
}

describe('catalogue reads', () => {
  it('lists standards, clauses and review definitions for every member', async () => {
    for (const who of ['viewer', 'owner', 'firmAdmin'] as Who[]) {
      const standards = await h.send(who, 'GET', '/catalogue/standards');
      expect(standards.status).toBe(200);
      expect(standards.body.items!.map((s) => s.code)).toEqual(['ISO_9001', 'ISO_14001']);
    }
    const clauses = await h.ok(
      'viewer',
      'GET',
      `/catalogue/clauses?standardId=${h.f.std9001}&assessable=true`,
    );
    expect((clauses.items as { number: string }[]).map((c) => c.number)).toEqual([
      '4.1',
      '8.3',
      '10.1',
    ]);
    const all = await h.ok('viewer', 'GET', '/catalogue/clauses');
    expect((all.items as unknown[]).length).toBe(6);
    const defs = (await h.ok('owner', 'GET', '/catalogue/review-defs')) as {
      inputs: { standardId: string }[];
      outputs: unknown[];
    };
    expect(defs.inputs.map((d) => d.standardId)).toEqual([h.f.std9001, h.f.std14001]);
    expect(defs.outputs).toHaveLength(1);
    const only = (await h.ok(
      'owner',
      'GET',
      `/catalogue/review-defs?standardId=${h.f.std14001}`,
    )) as {
      inputs: unknown[];
      outputs: unknown[];
    };
    expect([only.inputs.length, only.outputs.length]).toEqual([1, 0]);
  });
});

describe('management systems', () => {
  it('creates a system with a NOT_STARTED row per assessable clause, each audited', async () => {
    const created = await system([h.f.unitA], [h.f.std9001, h.f.std14001]);
    expect(created).toMatchObject({
      status: 'PLANNING',
      reviewIntervalMonths: 12,
      unitIds: [h.f.unitA],
    });
    const { items } = (await h.ok('clientAdmin', 'GET', `/systems/${created.id}/checklist`)) as {
      items: { clauseNumber: string; status: string; id: string }[];
    };
    expect(items.map((r) => r.clauseNumber)).toEqual(['4.1', '8.3', '10.1', '4.1', '6.1.2']);
    expect(new Set(items.map((r) => r.status))).toEqual(new Set(['NOT_STARTED']));
    expect((await audit(created.id as string)).map((e) => e.action)).toEqual(['CREATE']);
    expect((await audit(items[0]!.id)).map((e) => e.action)).toEqual(['CREATE']);
  });

  it('refuses a writer below client admin, unknown standards, two editions and foreign units', async () => {
    for (const who of ['approver', 'owner', 'viewer'] as Who[]) {
      const reply = await h.send(who, 'POST', '/systems', {
        name: 'Theirs',
        standardIds: [h.f.std9001],
      });
      expect(reply.status).toBe(403);
    }
    const bad = await h.send('consultant', 'POST', '/systems', {
      name: 'Unknown',
      standardIds: ['01920000-0000-7000-8000-0000000000ff'],
    });
    expect([bad.status, bad.body]).toMatchObject([
      400,
      { error: { details: { issues: [{ path: ['standardIds'] }] } } },
    ]);
    const unit = await h.send('firmAdmin', 'POST', '/systems', {
      name: 'Foreign unit',
      standardIds: [h.f.std9001],
      unitIds: ['01920000-0000-7000-8000-0000000000fe'],
    });
    expect(unit.status).toBe(400);
  });

  it('lists by name with unit scope, and reads one in scope only', async () => {
    const a = await system([h.f.unitA]);
    const b = await system([h.f.unitB]);
    const all = await system([]);
    const ids = async (who: Who) =>
      ((await h.ok(who, 'GET', '/systems?limit=200')).items as { id: string }[]).map((s) => s.id);
    expect(await ids('owner')).toEqual(expect.arrayContaining([a.id, all.id]));
    expect(await ids('owner')).not.toContain(b.id);
    expect(await ids('viewer')).toEqual(expect.arrayContaining([a.id, b.id, all.id]));
    expect((await h.send('owner', 'GET', `/systems/${b.id}`)).status).toBe(404);
    expect((await h.send('otherOwner', 'GET', `/systems/${b.id}`)).status).toBe(200);
    expect(
      (await h.send('owner', 'GET', `/systems/01920000-0000-7000-8000-0000000000aa`)).status,
    ).toBe(404);
    const counted = await h.ok(
      'clientAdmin',
      'GET',
      `/systems?count=true&status=PLANNING&q=System`,
    );
    expect(counted.total).toBeGreaterThanOrEqual(3);
    const page = await h.ok('clientAdmin', 'GET', '/systems?limit=1');
    expect(page.nextCursor).not.toBeNull();
    const next = await h.ok(
      'clientAdmin',
      'GET',
      `/systems?limit=1&cursor=${page.nextCursor as string}`,
    );
    expect((next.items as { id: string }[])[0]!.id).not.toBe(
      (page.items as { id: string }[])[0]!.id,
    );
  });

  it('updates fields, adds a standard with its rows, never drops one', async () => {
    const s = await system([h.f.unitA]);
    const renamed = await h.ok('clientAdmin', 'PATCH', `/systems/${s.id}`, {
      version: s.version,
      name: 'Riverbend quality system',
      status: 'IMPLEMENTING',
    });
    expect(renamed).toMatchObject({ name: 'Riverbend quality system', version: 2 });
    const stale = await h.send('clientAdmin', 'PATCH', `/systems/${s.id}`, {
      version: 1,
      name: 'Stale',
    });
    expect(stale.status).toBe(409);
    const dropped = await h.send('clientAdmin', 'PATCH', `/systems/${s.id}`, {
      version: 2,
      standardIds: [h.f.std14001],
    });
    expect([dropped.status, dropped.body]).toMatchObject([
      400,
      { error: { details: { issues: [{ path: ['standardIds'] }] } } },
    ]);
    const grown = await h.ok('clientAdmin', 'PATCH', `/systems/${s.id}`, {
      version: 2,
      standardIds: [h.f.std14001, h.f.std9001],
      unitIds: [h.f.unitA, h.f.unitB],
    });
    expect(grown.standardIds).toEqual([h.f.std9001, h.f.std14001]);
    const rows = (await h.ok('clientAdmin', 'GET', `/systems/${s.id}/checklist`))
      .items as unknown[];
    expect(rows).toHaveLength(5);
    // Nothing changes: no write, no event, no version bump.
    const same = await h.ok('clientAdmin', 'PATCH', `/systems/${s.id}`, {
      version: grown.version,
      name: grown.name,
    });
    expect(same.version).toBe(grown.version);
    expect((await audit(s.id as string)).map((e) => e.action)).toEqual([
      'CREATE',
      'UPDATE',
      'UPDATE',
    ]);
    expect(
      (await h.send('owner', 'PATCH', `/systems/${s.id}`, { version: 3, name: 'Mine' })).status,
    ).toBe(403);
    expect(
      (
        await h.send('clientAdmin', 'PATCH', `/systems/${s.id}`, {
          version: 3,
          unitIds: ['01920000-0000-7000-8000-0000000000fe'],
        })
      ).status,
    ).toBe(400);
  });

  it('records the climate decision, audited, never back to undecided, not dated after today', async () => {
    const s = await system();
    const future = await h.send('clientAdmin', 'PUT', `/systems/${s.id}/climate`, {
      version: 1,
      climateChangeRelevant: true,
      climateChangeRationale: 'Flood risk at the river site.',
      climateDecidedOn: '2026-10-21',
    });
    expect([future.status, future.body]).toMatchObject([
      400,
      { error: { details: { issues: [{ path: ['climateDecidedOn'] }] } } },
    ]);
    const decided = await h.ok('clientAdmin', 'PUT', `/systems/${s.id}/climate`, {
      version: 1,
      climateChangeRelevant: true,
      climateChangeRationale: 'Flood risk at the river site.',
      climateDecidedOn: '2026-10-20',
    });
    expect(decided).toMatchObject({ climateChangeRelevant: true, version: 2 });
    const changed = await h.ok('consultant', 'PUT', `/systems/${s.id}/climate`, {
      version: 2,
      climateChangeRelevant: false,
      climateChangeRationale: 'Moved off the river.',
      climateDecidedOn: '2026-10-20',
    });
    expect(changed.climateChangeRelevant).toBe(false);
    const undecided = await h.send('clientAdmin', 'PUT', `/systems/${s.id}/climate`, {
      version: 3,
      climateChangeRelevant: null,
      climateChangeRationale: null,
      climateDecidedOn: null,
    });
    expect(undecided.status).toBe(400);
    const events = await audit(s.id as string);
    expect(events.map((e) => e.action)).toEqual(['CREATE', 'UPDATE', 'UPDATE']);
    expect(events[2]!.after).toEqual({
      climateChangeRelevant: false,
      climateChangeRationale: 'Moved off the river.',
    });
    expect(
      (
        await h.send('approver', 'PUT', `/systems/${s.id}/climate`, {
          version: 3,
          climateChangeRelevant: true,
          climateChangeRationale: 'x',
          climateDecidedOn: '2026-10-20',
        })
      ).status,
    ).toBe(403);
  });
});

describe('context items', () => {
  it('adds, lists by kind, edits and archives with a reason', async () => {
    const s = await system([h.f.unitA]);
    const base = `/systems/${s.id}/context`;
    const party = await h.ok('clientAdmin', 'POST', base, {
      kind: 'INTERESTED_PARTY',
      text: 'Riverbend residents',
      needs: 'Quiet nights',
    });
    const issue = await h.ok('clientAdmin', 'POST', base, {
      kind: 'INTERNAL_ISSUE',
      text: 'Ageing furnace',
      climateRelated: true,
    });
    expect(
      (await h.send('clientAdmin', 'POST', base, { kind: 'EXTERNAL_ISSUE', text: 'x', needs: 'y' }))
        .status,
    ).toBe(400);
    const listed = await h.ok('owner', 'GET', base);
    expect((listed.items as { id: string }[]).map((i) => i.id)).toEqual([issue.id, party.id]);
    const climate = await h.ok('viewer', 'GET', `${base}?climateRelated=true&kind=INTERNAL_ISSUE`);
    expect((climate.items as unknown[]).length).toBe(1);
    expect((await h.send('otherOwner', 'GET', base)).status).toBe(404);
    expect(
      (await h.send('clientAdmin', 'PATCH', `${base}/${issue.id}`, { version: 1, needs: 'None' }))
        .status,
    ).toBe(400);
    const edited = await h.ok('clientAdmin', 'PATCH', `${base}/${issue.id}`, {
      version: 1,
      text: 'Ageing furnace 2',
    });
    expect(edited.version).toBe(2);
    expect(
      (await h.send('owner', 'PATCH', `${base}/${issue.id}`, { version: 2, text: 'Mine' })).status,
    ).toBe(403);
    const missingReason = await h.send('clientAdmin', 'POST', `${base}/${issue.id}/archive`, {
      version: 2,
    });
    expect(missingReason.status).toBe(422);
    const archived = await h.ok('clientAdmin', 'POST', `${base}/${issue.id}/archive`, {
      version: 2,
      reason: 'Furnace replaced',
    });
    expect(archived.archivedAt).not.toBeNull();
    expect(
      (await h.send('clientAdmin', 'PATCH', `${base}/${issue.id}`, { version: 3, text: 'Gone' }))
        .status,
    ).toBe(404);
    expect(
      (
        await h.send('clientAdmin', 'POST', `${base}/${issue.id}/archive`, {
          version: 3,
          reason: 'Again',
        })
      ).status,
    ).toBe(404);
    const withArchived = await h.ok('clientAdmin', 'GET', `${base}?includeArchived=true`);
    expect((withArchived.items as unknown[]).length).toBe(2);
    const events = await audit(issue.id as string);
    expect(events.map((e) => [e.action, e.reason])).toEqual([
      ['CREATE', null],
      ['UPDATE', null],
      ['ARCHIVE', 'Furnace replaced'],
    ]);
  });
});

describe('clause checklist', () => {
  it('edits a row: status, notes, owner with a reason (managers only), the climate rule for 4.1', async () => {
    const s = await system([h.f.unitA]);
    const row = await rowOf(s.id as string, '4.1');
    const path = `/systems/${s.id}/checklist/${row.id}`;
    const implemented = await h.send('clientAdmin', 'PATCH', path, {
      version: 1,
      status: 'IMPLEMENTED',
    });
    expect([implemented.status, implemented.body]).toMatchObject([
      400,
      { error: { details: { issues: [{ path: ['status'] }] } } },
    ]);
    expect(
      (await h.send('clientAdmin', 'PATCH', path, { version: 1, ownerId: h.f.people.owner }))
        .status,
    ).toBe(422);
    expect(
      (
        await h.send('clientAdmin', 'PATCH', path, {
          version: 1,
          ownerId: h.f.people.viewer,
          reason: 'Viewer',
        })
      ).status,
    ).toBe(400);
    const assigned = await h.ok('clientAdmin', 'PATCH', path, {
      version: 1,
      ownerId: h.f.people.owner,
      notes: 'Context register drafted',
      reason: 'Plant lead',
    });
    expect(assigned).toMatchObject({ ownerId: h.f.people.owner, version: 2 });
    const events = await audit(row.id);
    expect(events.slice(1).map((e) => [e.action, e.reason])).toEqual([
      ['UPDATE', null],
      ['REASSIGN', 'Plant lead'],
    ]);
    // The owner works their own row but never reassigns it.
    const partial = await h.ok('owner', 'PATCH', path, { version: 2, status: 'PARTIAL' });
    expect(partial.status).toBe('PARTIAL');
    expect(
      (
        await h.send('owner', 'PATCH', path, {
          version: 3,
          ownerId: h.f.people.otherOwner,
          reason: 'Swap',
        })
      ).status,
    ).toBe(403);
    expect(
      (await h.send('otherOwner', 'PATCH', path, { version: 3, notes: 'Not mine' })).status,
    ).toBe(404);
    expect((await h.send('viewer', 'PATCH', path, { version: 3, notes: 'Viewer' })).status).toBe(
      403,
    );
    expect((await h.send('owner', 'PATCH', path, { version: 2, notes: 'Stale' })).status).toBe(409);
    await h.ok('clientAdmin', 'PUT', `/systems/${s.id}/climate`, {
      version: 1,
      climateChangeRelevant: false,
      climateChangeRationale: 'No exposure found.',
      climateDecidedOn: '2026-10-01',
    });
    const done = await h.ok('owner', 'PATCH', path, { version: 3, status: 'IMPLEMENTED' });
    expect(done.status).toBe('IMPLEMENTED');
    const cleared = await h.ok('clientAdmin', 'PATCH', path, {
      version: 4,
      ownerId: null,
      reason: 'Left',
    });
    expect(cleared.ownerId).toBeNull();
    expect(
      (
        await h.send(
          'owner',
          'PATCH',
          `/systems/${s.id}/checklist/01920000-0000-7000-8000-0000000000aa`,
          { version: 1, notes: 'x' },
        )
      ).status,
    ).toBe(404);
  });

  it('lists with filters; an owner named outside the units sees just their rows; out of scope is 404', async () => {
    const s = await system([h.f.unitB]);
    expect((await checklist('owner', s.id as string)).status).toBe(404);
    const row = await rowOf(s.id as string, '10.1');
    await h.ok('clientAdmin', 'PATCH', `/systems/${s.id}/checklist/${row.id}`, {
      version: 1,
      ownerId: h.f.people.owner,
      reason: 'Corporate lead',
    });
    const mine = await checklist('owner', s.id as string, '?ownerId=me');
    expect((mine.body.items as { id: string }[]).map((r) => r.id)).toEqual([row.id]);
    const theirs = await checklist('owner', s.id as string);
    expect((theirs.body.items as unknown[]).length).toBe(1);
    const filtered = await checklist(
      'viewer',
      s.id as string,
      `?standardId=${h.f.std9001}&status=NOT_STARTED&naState=NONE`,
    );
    expect((filtered.body.items as unknown[]).length).toBe(3);
    expect((await checklist('viewer', '01920000-0000-7000-8000-0000000000aa')).status).toBe(404);
  });
});

describe('the clause N/A machine (model §4.6)', () => {
  async function exclusionRow() {
    const s = await system([h.f.unitA]);
    const row = await rowOf(s.id as string, '8.3');
    await h.ok('clientAdmin', 'PATCH', `/systems/${s.id}/checklist/${row.id}`, {
      version: 1,
      ownerId: h.f.people.owner,
      status: 'PARTIAL',
      reason: 'Design lead',
    });
    return { s, row, path: `/systems/${s.id}/checklist/${row.id}` };
  }

  it('REQUEST_NA → APPROVE_NA → WITHDRAW_NA, with allowedActions and the maker-checker rule', async () => {
    const { row, path } = await exclusionRow();
    const before = (await h.ok('owner', 'GET', path.replace(`/${row.id}`, ''))).items as {
      id: string;
      allowedActions: string[];
    }[];
    expect(before.find((r) => r.id === row.id)!.allowedActions).toEqual(['REQUEST_NA']);
    expect((await h.send('owner', 'POST', `${path}/na-request`, { version: 2 })).status).toBe(422);
    const requested = await h.ok('owner', 'POST', `${path}/na-request`, {
      version: 2,
      reason: 'We do no design work',
    });
    expect(requested).toMatchObject({
      status: 'NOT_APPLICABLE',
      naState: 'REQUESTED',
      statusBeforeNa: 'PARTIAL',
      justification: 'We do no design work',
      allowedActions: [],
    });
    // The requester's own decision is refused; a status edit while REQUESTED is refused.
    expect((await h.send('owner', 'POST', `${path}/na-approve`, { version: 3 })).status).toBe(403);
    expect((await h.send('owner', 'PATCH', path, { version: 3, status: 'PARTIAL' })).status).toBe(
      400,
    );
    expect((await h.send('consultant', 'POST', `${path}/na-approve`, { version: 3 })).status).toBe(
      403,
    );
    expect((await h.send('approverB', 'POST', `${path}/na-approve`, { version: 3 })).status).toBe(
      404,
    );
    expect(
      (await h.send('approver', 'POST', `${path}/na-withdraw`, { version: 3, reason: 'x' })).status,
    ).toBe(403);
    expect(
      (await h.send('clientAdmin', 'POST', `${path}/na-withdraw`, { version: 3, reason: 'x' }))
        .status,
    ).toBe(409);
    const asApprover = (await h.ok('approver', 'GET', path.replace(`/${row.id}`, ''))).items as {
      id: string;
      allowedActions: string[];
    }[];
    expect(asApprover.find((r) => r.id === row.id)!.allowedActions).toEqual([
      'APPROVE_NA',
      'REJECT_NA',
    ]);
    const approved = await h.ok('approver', 'POST', `${path}/na-approve`, {
      version: 3,
      comment: 'Agreed',
    });
    expect(approved).toMatchObject({ naState: 'APPROVED', naDecidedById: h.f.people.approver });
    expect((await h.send('approver', 'POST', `${path}/na-approve`, { version: 4 })).status).toBe(
      409,
    );
    const withdrawn = await h.ok('clientAdmin', 'POST', `${path}/na-withdraw`, {
      version: 4,
      reason: 'Design starts next year',
    });
    expect(withdrawn).toMatchObject({
      naState: 'NONE',
      status: 'NOT_STARTED',
      justification: null,
    });
    const events = await audit(row.id);
    expect(
      events
        .filter((e) => e.action === 'TRANSITION')
        .map((e) => [e.after!.action, e.after!.delegated ?? false, e.reason]),
    ).toEqual([
      ['REQUEST_NA', false, 'We do no design work'],
      ['APPROVE_NA', false, 'Agreed'],
      ['WITHDRAW_NA', true, 'Design starts next year'],
    ]);
  });

  it('REJECT_NA restores the earlier status; a client admin decides as delegate', async () => {
    const { row, path } = await exclusionRow();
    await h.ok('clientAdmin', 'POST', `${path}/na-request`, {
      version: 2,
      reason: 'Asked for the owner',
    });
    expect(
      (await h.send('clientAdmin', 'POST', `${path}/na-reject`, { version: 3, reason: 'Mine' }))
        .status,
    ).toBe(403);
    expect((await h.send('otherAdmin', 'POST', `${path}/na-reject`, { version: 3 })).status).toBe(
      422,
    );
    const rejected = await h.ok('otherAdmin', 'POST', `${path}/na-reject`, {
      version: 3,
      reason: 'Design happens',
    });
    expect(rejected).toMatchObject({
      naState: 'REJECTED',
      status: 'PARTIAL',
      statusBeforeNa: null,
    });
    const again = await h.ok('owner', 'POST', `${path}/na-request`, {
      version: 4,
      reason: 'Second try',
    });
    expect(again.naState).toBe('REQUESTED');
    const transitions = (await audit(row.id)).filter((e) => e.action === 'TRANSITION');
    expect(transitions.map((e) => [e.after!.action, e.after!.delegated ?? false])).toEqual([
      ['REQUEST_NA', true],
      ['REJECT_NA', true],
      ['REQUEST_NA', false],
    ]);
  });

  it('refuses REQUEST_NA on a clause that does not allow exclusion', async () => {
    const s = await system([h.f.unitA]);
    const row = await rowOf(s.id as string, '10.1');
    const reply = await h.send(
      'clientAdmin',
      'POST',
      `/systems/${s.id}/checklist/${row.id}/na-request`,
      {
        version: 1,
        reason: 'Not ours',
      },
    );
    expect([reply.status, reply.body]).toMatchObject([
      400,
      { error: { details: { issues: [{ path: ['status'] }] } } },
    ]);
    expect(
      (
        await h.send('clientAdmin', 'POST', `/systems/${s.id}/checklist/${row.id}/na-request`, {
          version: 9,
          reason: 'x',
        })
      ).status,
    ).toBe(409);
  });

  it('honours Idempotency-Key on an N/A step', async () => {
    const { path } = await exclusionRow();
    const key = { 'idempotency-key': '0190f000-0000-7000-8000-00000000c0de' };
    const first = await h.send(
      'owner',
      'POST',
      `${path}/na-request`,
      { version: 2, reason: 'Once' },
      key,
    );
    const again = await h.send(
      'owner',
      'POST',
      `${path}/na-request`,
      { version: 2, reason: 'Once' },
      key,
    );
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.body).toEqual(first.body);
    const other = await h.send(
      'owner',
      'POST',
      `${path}/na-request`,
      { version: 2, reason: 'Other' },
      key,
    );
    expect(other.status).toBe(400);
  });
});
