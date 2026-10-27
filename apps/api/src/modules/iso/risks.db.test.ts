import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type Reply, type Who } from './testing/fixture.js';
import { seedObligation, seedOtherClientRisk } from './testing/records.js';

/**
 * The risk register (model §3.5): the kind rules, rating and significance from the engine at write (§1.7, §5.1), the
 * significance override, REVIEW (§5.2), controls in place, unit scope (plan §3.3), the role matrix (plan §3.2), `ids`
 * (contracts 1.8.5) and the audit trail (model §8).
 */

const NOW = new Date('2026-10-20T06:00:00Z');
let h: Harness;
/** Unit A only; unit B only; the whole client. */
let systemA: string;
let systemB: string;
let group: string;
let statute: string;
let activity: string;
let archivedObligation: string;

beforeAll(async () => {
  h = await createHarness('Risk', NOW);
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
  group = await system('Group system', []);
  statute = await seedObligation(h);
  activity = await seedObligation(h, { standard: true });
  archivedObligation = await seedObligation(h, { archived: true });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const code = (reply: Reply) => (reply.body.error as { code?: string } | undefined)?.code;
const field = (reply: Reply) =>
  (reply.body.error as { details?: { issues?: { path: unknown[] }[] } } | undefined)?.details
    ?.issues?.[0]?.path;

/** A record's audit events, oldest first; one request's events share `at`, so they are ordered by content. */
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

const RISK = {
  kind: 'RISK',
  activity: 'Packaging supply',
  description: 'One supplier makes every carton',
  likelihood: 2,
  severity: 3,
};
const ASPECT = {
  kind: 'ASPECT',
  activity: 'Boiler house',
  description: 'Stack emissions',
  impact: 'Air pollution',
  lifeCycleStages: ['PRODUCTION'],
  controlType: 'CONTROL',
  condition: 'NORMAL',
  likelihood: 3,
  severity: 3,
};
const HAZARD = {
  kind: 'HAZARD',
  activity: 'Forklift loading',
  description: 'Forklift strikes a person in the dock',
  impact: 'Crush injury',
  routine: true,
  personsExposed: ['WORKER', 'CONTRACTOR'],
  condition: 'NORMAL',
  likelihood: 2,
  severity: 5,
};

const createRisk = (fields: Record<string, unknown> = {}, who: Who = 'clientAdmin') =>
  h.send(who, 'POST', '/risks', {
    managementSystemId: systemA,
    ownerId: h.f.people.owner,
    ...RISK,
    ...fields,
  });

async function risk(fields: Record<string, unknown> = {}, who: Who = 'clientAdmin') {
  const reply = await createRisk(fields, who);
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return reply.body as { id: string; version: number } & Record<string, unknown>;
}

const listIds = async (query: string, who: Who = 'clientAdmin') => {
  const reply = await h.send(who, 'GET', `/risks?limit=200${query}`);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return (reply.body.items ?? []).map((i) => i.id as string);
};

describe('createIsoRisk', () => {
  it('stores the rating and significance from the engine, audited as CREATE', async () => {
    const item = await risk();
    expect(item).toMatchObject({
      clientId: h.f.clientId,
      managementSystemId: systemA,
      kind: 'RISK',
      unitId: null,
      rating: 6,
      residualRating: null,
      significant: false,
      significantOverride: null,
      significanceReason: null,
      lastReviewedOn: null,
      reviewDueOn: null,
      version: 1,
      reviewStatus: { timing: 'ON_TIME', overdueDays: null },
    });
    const events = await audit(item.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'CREATE',
      after: { kind: 'RISK', rating: 6, significant: false, ownerId: h.f.people.owner },
    });
  });

  it('marks an item significant at the threshold or with a legal link (rule 12, links count)', async () => {
    expect((await risk({ likelihood: 3, severity: 4 })).significant).toBe(true);
    expect((await risk({ likelihood: 2, severity: 5 })).significant).toBe(false);
    expect(await risk({ likelihood: 1, severity: 1, obligationIds: [statute] })).toMatchObject({
      rating: 1,
      significant: true,
      obligationIds: [statute],
    });
    expect(
      await risk({ likelihood: 4, severity: 4, residualLikelihood: 2, residualSeverity: 2 }),
    ).toMatchObject({ rating: 16, residualRating: 4, significant: true });
  });

  it('takes the kind fields of an ASPECT and a HAZARD, and refuses fields of another kind', async () => {
    expect(await risk({ ...ASPECT, unitId: h.f.unitA, climateRelated: true })).toMatchObject({
      kind: 'ASPECT',
      unitId: h.f.unitA,
      lifeCycleStages: ['PRODUCTION'],
      controlType: 'CONTROL',
      routine: null,
      climateRelated: true,
      rating: 9,
    });
    expect(await risk(HAZARD)).toMatchObject({ kind: 'HAZARD', routine: true, rating: 10 });
    const stray = await createRisk({ routine: true });
    expect([stray.status, code(stray), field(stray)]).toEqual([400, 'VALIDATION', ['routine']]);
    const bare = await createRisk({ ...ASPECT, lifeCycleStages: [] });
    expect([bare.status, code(bare)]).toEqual([400, 'VALIDATION']);
  });

  it('checks the unit, the owner and the legal links (400 VALIDATION)', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ unitId: h.f.unitB }, 'unitId'],
      [{ unitId: h.f.unitA, ownerId: h.f.people.approverB }, 'ownerId'],
      [{ obligationIds: [activity] }, 'obligationIds'],
      [{ obligationIds: [archivedObligation] }, 'obligationIds'],
    ];
    for (const [fields, path] of cases) {
      const reply = await createRisk(fields);
      expect([JSON.stringify(fields), reply.status, code(reply), field(reply)]).toEqual([
        JSON.stringify(fields),
        400,
        'VALIDATION',
        [path],
      ]);
    }
    // Firm staff can own an item (the M3 role lookup).
    expect((await createRisk({ ownerId: h.f.people.consultant })).status).toBe(201);
  });

  it('lets FA, CO and CA add items, and an owner only as its owner for their units', async () => {
    for (const who of ['firmAdmin', 'consultant', 'clientAdmin'] as Who[]) {
      expect((await createRisk({}, who)).status).toBe(201);
    }
    expect((await createRisk({}, 'owner')).status).toBe(201);
    expect((await createRisk({ ownerId: h.f.people.clientAdmin }, 'owner')).status).toBe(403);
    for (const who of ['approver', 'viewer'] as Who[]) {
      expect((await createRisk({}, who)).status).toBe(403);
    }
    // Unit B's owner cannot see unit A's system.
    expect((await createRisk({ ownerId: h.f.people.otherOwner }, 'otherOwner')).status).toBe(404);
  });
});

describe('reading and listing risk items', () => {
  it('shows an item in the reader’s units, and to its owner outside them', async () => {
    const item = await risk();
    for (const who of ['owner', 'approver', 'viewer', 'consultant'] as Who[]) {
      expect((await h.send(who, 'GET', `/risks/${item.id}`)).status).toBe(200);
    }
    expect((await h.send('otherOwner', 'GET', `/risks/${item.id}`)).status).toBe(404);
    expect((await h.send('approverB', 'GET', `/risks/${item.id}`)).status).toBe(404);
    const named = await risk({ managementSystemId: systemB, ownerId: h.f.people.owner });
    expect((await h.send('owner', 'GET', `/risks/${named.id}`)).status).toBe(200);
  });

  it('answers 404 for an unknown item, another client’s and an archived one', async () => {
    const other = await seedOtherClientRisk(h);
    expect((await h.send('clientAdmin', 'GET', `/risks/${other.id}`)).status).toBe(404);
    expect(
      (await h.send('clientAdmin', 'GET', '/risks/0190a0b0-0000-7000-8000-000000000000')).status,
    ).toBe(404);
    const item = await risk();
    await h.ok('clientAdmin', 'POST', `/risks/${item.id}/archive`, {
      version: 1,
      reason: 'Duplicate',
    });
    expect((await h.send('clientAdmin', 'GET', `/risks/${item.id}`)).status).toBe(404);
  });

  it('lists live items, highest rating first, stable on the order added', async () => {
    const low = await risk({ managementSystemId: group, likelihood: 1, severity: 2 });
    const high = await risk({ managementSystemId: group, likelihood: 5, severity: 5 });
    const tie = await risk({ managementSystemId: group, likelihood: 1, severity: 2 });
    expect(await listIds(`&managementSystemId=${group}`)).toEqual([high.id, low.id, tie.id]);
  });

  it('applies every filter', async () => {
    const aspect = await risk({
      ...ASPECT,
      managementSystemId: group,
      unitId: h.f.unitB,
      ownerId: h.f.people.otherOwner,
      climateRelated: true,
      activity: 'Kiln exhaust',
    });
    const linked = await risk({
      managementSystemId: group,
      obligationIds: [statute],
      ownerId: h.f.people.clientAdmin,
    });
    const g = `&managementSystemId=${group}`;
    expect(await listIds(`${g}&kind=ASPECT`)).toEqual([aspect.id]);
    expect(await listIds(`${g}&unitId=${h.f.unitB}`)).toEqual([aspect.id]);
    expect(await listIds(`${g}&climateRelated=true`)).toEqual([aspect.id]);
    expect(await listIds(`${g}&significant=true`)).toContain(linked.id);
    expect(await listIds(`${g}&significant=true`)).not.toContain(aspect.id);
    expect(await listIds(`${g}&q=kiln`)).toEqual([aspect.id]);
    expect(await listIds(`${g}&ownerId=me`, 'otherOwner')).toEqual([aspect.id]);
  });

  it('narrows to the ids given within the other filters and the reader’s units, dropping the rest', async () => {
    const mine = await risk({ managementSystemId: systemA, likelihood: 1, severity: 1 });
    const top = await risk({ managementSystemId: systemA, likelihood: 5, severity: 4 });
    const outside = await risk({ managementSystemId: systemB, ownerId: h.f.people.otherOwner });
    const archived = await risk();
    await h.ok('clientAdmin', 'POST', `/risks/${archived.id}/archive`, {
      version: 1,
      reason: 'Duplicate',
    });
    const other = await seedOtherClientRisk(h);
    const ids = [mine.id, outside.id, archived.id, other.id, top.id].join(',');
    // In list order, not the order given; another client's and the archived item drop out with no error.
    expect(await listIds(`&ids=${ids}`)).toEqual([top.id, outside.id, mine.id]);
    // The unit A owner does not reach unit B's item.
    expect(await listIds(`&ids=${ids}`, 'owner')).toEqual([top.id, mine.id]);
    expect(await listIds(`&ids=${ids}&kind=HAZARD`)).toEqual([]);
    expect(await listIds(`&ids=${ids}&includeArchived=true`)).toContain(archived.id);
  });

  it('keeps AP and OW to their units and the items they own (plan §3.3)', async () => {
    const seen = await listIds('', 'otherOwner');
    const inA = await risk({ managementSystemId: systemA });
    expect(await listIds('', 'otherOwner')).toEqual(seen);
    expect(await listIds('', 'owner')).toContain(inA.id);
  });

  it('pages', async () => {
    const first = await h.ok('clientAdmin', 'GET', `/risks?managementSystemId=${group}&limit=2`);
    expect((first.items as unknown[]).length).toBe(2);
    const next = await h.ok(
      'clientAdmin',
      'GET',
      `/risks?managementSystemId=${group}&limit=2&cursor=${first.nextCursor as string}`,
    );
    expect((next.items as { id: string }[]).map((i) => i.id)).not.toContain(
      (first.items as { id: string }[])[0]!.id,
    );
  });
});

describe('updateIsoRisk', () => {
  it('re-rates and recomputes the stored results, audited as UPDATE without a source action', async () => {
    const item = await risk();
    const reply = await h.send('owner', 'PATCH', `/risks/${item.id}`, {
      version: 1,
      likelihood: 4,
      severity: 4,
      residualLikelihood: 2,
      residualSeverity: 3,
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      rating: 16,
      residualRating: 6,
      significant: true,
      version: 2,
    });
    const update = (await audit(item.id)).at(-1)!;
    expect(update).toMatchObject({
      action: 'UPDATE',
      before: { likelihood: 2, severity: 3, rating: 6, significant: false },
      after: { likelihood: 4, severity: 4, rating: 16, residualRating: 6, significant: true },
    });
    expect(update.after).not.toHaveProperty('sourceActionId');
  });

  it('audits a new owner as REASSIGN and a moved review date as DUE_DATE_CHANGE, each with the reason', async () => {
    const item = await risk();
    const missing = await h.send('clientAdmin', 'PATCH', `/risks/${item.id}`, {
      version: 1,
      ownerId: h.f.people.clientAdmin,
    });
    expect([missing.status, code(missing)]).toEqual([422, 'REASON_REQUIRED']);
    await h.ok('clientAdmin', 'PATCH', `/risks/${item.id}`, {
      version: 1,
      ownerId: h.f.people.clientAdmin,
      reviewDueOn: '2027-04-01',
      activity: 'Carton supply',
      reason: 'New buyer',
    });
    const events = (await audit(item.id)).slice(1);
    expect(events.map((e) => [e.action, e.reason]).sort()).toEqual([
      ['DUE_DATE_CHANGE', 'New buyer'],
      ['REASSIGN', 'New buyer'],
      ['UPDATE', null],
    ]);
  });

  it('keeps the kind rules and refuses a stale version', async () => {
    const item = await risk(HAZARD);
    const emptied = await h.send('clientAdmin', 'PATCH', `/risks/${item.id}`, {
      version: 1,
      personsExposed: [],
    });
    expect([emptied.status, code(emptied)]).toEqual([400, 'VALIDATION']);
    await h.ok('clientAdmin', 'PATCH', `/risks/${item.id}`, { version: 1, activity: 'Dock work' });
    const stale = await h.send('clientAdmin', 'PATCH', `/risks/${item.id}`, {
      version: 1,
      activity: 'Late',
    });
    expect([stale.status, code(stale)]).toEqual([409, 'STALE_VERSION']);
  });

  it('lets managers and the owner edit, and no one else; an archived item takes no edits', async () => {
    const item = await risk();
    for (const who of ['approver', 'viewer'] as Who[]) {
      expect(
        (await h.send(who, 'PATCH', `/risks/${item.id}`, { version: 1, activity: 'No' })).status,
      ).toBe(403);
    }
    expect(
      (await h.send('otherOwner', 'PATCH', `/risks/${item.id}`, { version: 1, activity: 'No' }))
        .status,
    ).toBe(404);
    const theirs = await risk({ ownerId: h.f.people.clientAdmin });
    expect(
      (await h.send('owner', 'PATCH', `/risks/${theirs.id}`, { version: 1, activity: 'No' }))
        .status,
    ).toBe(403);
    await h.ok('clientAdmin', 'POST', `/risks/${item.id}/archive`, { version: 1, reason: 'Gone' });
    const locked = await h.send('clientAdmin', 'PATCH', `/risks/${item.id}`, {
      version: 2,
      activity: 'Late',
    });
    expect(locked.status).toBe(404);
    expect((await audit(item.id)).map((e) => e.action)).toEqual(['CREATE', 'ARCHIVE']);
  });
});

describe('reviewIsoRisk', () => {
  it('sets lastReviewedOn and the next review date, nothing else, as a TRANSITION', async () => {
    const item = await risk({ reviewDueOn: '2026-10-25' });
    const reply = await h.send('owner', 'POST', `/risks/${item.id}/review`, {
      version: 1,
      nextReviewDueOn: '2027-10-20',
      note: 'Still one supplier',
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      lastReviewedOn: '2026-10-20',
      reviewDueOn: '2027-10-20',
      rating: 6,
      version: 2,
    });
    expect((await audit(item.id)).at(-1)).toMatchObject({
      action: 'TRANSITION',
      after: { action: 'REVIEW', lastReviewedOn: '2026-10-20', reviewDueOn: '2027-10-20' },
    });
    expect((await audit(item.id)).at(-1)!.after).not.toHaveProperty('delegated');
  });

  it('marks a manager’s review as delegated and needs a later date and a writer', async () => {
    const item = await risk();
    await h.ok('consultant', 'POST', `/risks/${item.id}/review`, {
      version: 1,
      nextReviewDueOn: '2027-01-01',
    });
    expect((await audit(item.id)).at(-1)).toMatchObject({
      action: 'TRANSITION',
      after: { delegated: true },
    });
    const today = await h.send('clientAdmin', 'POST', `/risks/${item.id}/review`, {
      version: 2,
      nextReviewDueOn: '2026-10-20',
    });
    expect([today.status, field(today)]).toEqual([400, ['nextReviewDueOn']]);
    const approver = await h.send('approver', 'POST', `/risks/${item.id}/review`, {
      version: 2,
      nextReviewDueOn: '2027-01-01',
    });
    expect(approver.status).toBe(403);
  });
});

describe('setIsoRiskSignificance', () => {
  it('sets and clears the override with its reason, audited', async () => {
    const item = await risk({ likelihood: 4, severity: 4 });
    const lowered = await h.send('clientAdmin', 'PUT', `/risks/${item.id}/significance`, {
      version: 1,
      significantOverride: false,
      reason: 'Second supplier qualified',
    });
    expect(lowered.body).toMatchObject({
      significant: false,
      significantOverride: false,
      significanceReason: 'Second supplier qualified',
    });
    const cleared = await h.ok('clientAdmin', 'PUT', `/risks/${item.id}/significance`, {
      version: 2,
      significantOverride: null,
      reason: 'Back to the rule',
    });
    expect(cleared).toMatchObject({
      significant: true,
      significantOverride: null,
      significanceReason: null,
    });
    expect((await audit(item.id)).slice(1).map((e) => [e.action, e.reason])).toEqual([
      ['UPDATE', 'Second supplier qualified'],
      ['UPDATE', 'Back to the rule'],
    ]);
  });

  it('is for FA, CO and CA only, with a reason', async () => {
    const item = await risk();
    for (const who of ['owner', 'approver', 'viewer'] as Who[]) {
      const reply = await h.send(who, 'PUT', `/risks/${item.id}/significance`, {
        version: 1,
        significantOverride: true,
        reason: 'No',
      });
      expect([who, reply.status]).toEqual([who, 403]);
    }
    const bare = await h.send('clientAdmin', 'PUT', `/risks/${item.id}/significance`, {
      version: 1,
      significantOverride: true,
    });
    expect([bare.status, code(bare)]).toEqual([422, 'REASON_REQUIRED']);
  });
});

describe('risk controls', () => {
  it('adds, lists, changes and archives controls in place, each audited', async () => {
    const item = await risk();
    const path = `/risks/${item.id}/controls`;
    const control = await h.ok('owner', 'POST', path, { text: 'Two weeks of carton stock' });
    expect(control).toMatchObject({ riskItemId: item.id, hierarchy: null, sourceActionId: null });
    const changed = await h.ok('owner', 'PATCH', `${path}/${control.id}`, {
      version: 1,
      text: 'Three weeks of carton stock',
    });
    expect(changed.text).toBe('Three weeks of carton stock');
    expect(((await h.ok('viewer', 'GET', path)).items as unknown[]).length).toBe(1);
    await h.ok('owner', 'POST', `${path}/${control.id}/archive`, {
      version: 2,
      reason: 'Replaced',
    });
    expect((await h.ok('viewer', 'GET', path)).items).toEqual([]);
    expect((await audit(control.id as string)).map((e) => e.action)).toEqual([
      'CREATE',
      'UPDATE',
      'ARCHIVE',
    ]);
  });

  it('needs a hierarchy on a HAZARD only, and refuses another item’s control', async () => {
    const hazard = await risk(HAZARD);
    const bare = await h.send('clientAdmin', 'POST', `/risks/${hazard.id}/controls`, {
      text: 'Pedestrian lane',
    });
    expect([bare.status, field(bare)]).toEqual([400, ['hierarchy']]);
    const control = await h.ok('clientAdmin', 'POST', `/risks/${hazard.id}/controls`, {
      text: 'Pedestrian lane',
      hierarchy: 'ENGINEERING',
    });
    const other = await risk();
    expect(
      (
        await h.send('clientAdmin', 'PATCH', `/risks/${other.id}/controls/${control.id}`, {
          version: 1,
          text: 'No',
        })
      ).status,
    ).toBe(404);
  });

  it('lets managers and the item owner write, and keeps unit scope', async () => {
    const item = await risk({ ownerId: h.f.people.clientAdmin });
    const path = `/risks/${item.id}/controls`;
    expect((await h.send('owner', 'POST', path, { text: 'No' })).status).toBe(403);
    expect((await h.send('approver', 'POST', path, { text: 'No' })).status).toBe(403);
    expect((await h.send('otherOwner', 'GET', path)).status).toBe(404);
    expect((await h.send('consultant', 'POST', path, { text: 'Yes' })).status).toBe(201);
  });
});
