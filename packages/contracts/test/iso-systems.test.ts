// ISO mock, systems area: catalogue reads, management systems, context items, the clause checklist with its N/A
// machine (docs/iso/model.md §3.1-3.3, §4.6) and the overview (§5.1-5.2), per the plan §3.2 roles and §3.3 unit scope.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IsoStandardCode } from '../src/enums.js';
import type { ClauseAssessmentView, IsoOverview, IsoSystemOverview } from '../src/api/iso.js';
import type { IsoRow } from '../src/mock/store.js';
import {
  type App,
  base,
  BENGALURU,
  CHENNAI,
  clause,
  fails,
  firmB,
  HARBOUR,
  isoApp,
  isoEvents,
  NORTHWIND,
  ok,
  PERSON,
  PUNE,
  seed,
  seedSystem,
  standardId,
  TODAY,
} from './iso-harness.js';

type System = IsoRow<'managementSystems'>;
type Row = IsoRow<'clauseAssessments'>;
type View = ClauseAssessmentView;
type Overview = IsoSystemOverview;

let app: App;
beforeAll(async () => {
  app = await isoApp();
});
afterAll(async () => {
  await app.close();
});

const ALL: IsoStandardCode[] = ['ISO_9001', 'ISO_14001', 'ISO_45001'];
const firm = () => firmB(app);
const assessable = (code: IsoStandardCode) =>
  firm().isoCatalogue.clauses.filter((c) => c.assessable && c.standardId === standardId(app, code));
const rowsOf = (systemId: string) =>
  firm().iso.clauseAssessments.filter((r) => r.managementSystemId === systemId);
const rowOf = (systemId: string, code: IsoStandardCode, number: string): Row =>
  rowsOf(systemId).find((r) => r.clauseId === clause(code, number))!;
const rowParams = (row: Row) => ({ id: row.managementSystemId, rowId: row.id });
const lastEvent = (id: string) => isoEvents(app, id).at(-1)!;

// ---------- catalogue ----------

describe('catalogue reads', () => {
  it('lists the standards in code order for every role', async () => {
    for (const as of [PERSON.meera, PERSON.vikram, PERSON.rohan, PERSON.nisha]) {
      const { items } = await ok<{ items: { code: string }[] }>(app, 'listIsoStandards', { as });
      expect(items.map((s) => s.code)).toEqual(ALL);
    }
  });

  it('lists clauses by standard and number, with filters', async () => {
    const all = await ok<{ items: { number: string; standardId: string }[] }>(
      app,
      'listIsoClauses',
      { as: PERSON.vikram },
    );
    expect(all.items).toHaveLength(firm().isoCatalogue.clauses.length);
    const s9001 = standardId(app, 'ISO_9001');
    const s14001 = standardId(app, 'ISO_14001');
    expect(all.items[0]!.standardId).toBe(s9001);
    expect(all.items.at(-1)!.standardId).toBe(standardId(app, 'ISO_45001'));

    const some = await ok<{ items: { number: string; assessable: boolean; standardId: string }[] }>(
      app,
      'listIsoClauses',
      { as: PERSON.rohan, query: { standardId: s9001, assessable: 'true' } },
    );
    expect(some.items).toHaveLength(assessable('ISO_9001').length);
    expect(some.items.every((c) => c.assessable && c.standardId === s9001)).toBe(true);
    const numbers = some.items.map((c) => c.number);
    expect(numbers.indexOf('4.1')).toBe(0);
    expect(numbers.indexOf('7.1.5.1')).toBeLessThan(numbers.indexOf('7.1.5.2'));
    expect(numbers.indexOf('9.3.3')).toBeLessThan(numbers.indexOf('10.1'));

    const headings = await ok<{ items: { assessable: boolean; standardId: string }[] }>(
      app,
      'listIsoClauses',
      { query: { standardId: `${s9001},${s14001}`, assessable: 'false' } },
    );
    expect(headings.items.length).toBeGreaterThan(0);
    expect(headings.items.every((c) => !c.assessable)).toBe(true);
  });

  it('lists review definitions, optionally for some standards', async () => {
    const all = await ok<{ inputs: unknown[]; outputs: unknown[] }>(app, 'listIsoReviewDefs', {
      as: PERSON.sameer,
    });
    expect(all.inputs).toHaveLength(firm().isoCatalogue.reviewInputDefs.length);
    expect(all.outputs).toHaveLength(firm().isoCatalogue.reviewOutputDefs.length);
    const s14001 = standardId(app, 'ISO_14001');
    const some = await ok<{
      inputs: { standardId: string; clauseNumber: string; item: string | null }[];
      outputs: { standardId: string }[];
    }>(app, 'listIsoReviewDefs', { query: { standardId: s14001 } });
    expect(some.inputs.length).toBeGreaterThan(0);
    expect([...some.inputs, ...some.outputs].every((d) => d.standardId === s14001)).toBe(true);
    const items = some.inputs.map((d) => d.item ?? '');
    expect(items).toEqual([...items].sort());
  });

  it('answers 404 outside the actor’s clients and 403 without the add-on', async () => {
    await fails(app, 'listIsoStandards', { as: PERSON.leela }, 'NOT_FOUND', 404);
    await fails(
      app,
      'listIsoClauses',
      { headers: { 'x-mock-features': '' } },
      'FEATURE_NOT_ENABLED',
      403,
    );
  });
});

// ---------- management systems ----------

describe('management systems', () => {
  it('creates a system with one NOT_STARTED row per assessable clause, audited', async () => {
    const s9001 = standardId(app, 'ISO_9001');
    const s14001 = standardId(app, 'ISO_14001');
    const system = await ok<System>(app, 'createIsoSystem', {
      as: PERSON.kabir,
      body: { name: 'Quality and environment', standardIds: [s9001, s14001], unitIds: [PUNE] },
    });
    expect(system).toMatchObject({
      clientId: NORTHWIND,
      status: 'PLANNING',
      reviewIntervalMonths: 12,
      scopeStatement: null,
      unitIds: [PUNE],
      climateChangeRelevant: null,
      climateChangeRationale: null,
      climateDecidedOn: null,
      version: 1,
    });
    const rows = rowsOf(system.id);
    expect(rows).toHaveLength(assessable('ISO_9001').length + assessable('ISO_14001').length);
    expect(rows.every((r) => r.status === 'NOT_STARTED' && r.naState === 'NONE')).toBe(true);
    expect(isoEvents(app, system.id)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        entityType: 'management_system',
        actorId: PERSON.kabir,
        after: expect.objectContaining({ name: 'Quality and environment', unitIds: [PUNE] }),
      }),
    ]);
    for (const row of rows) {
      expect(isoEvents(app, row.id)).toEqual([
        expect.objectContaining({ action: 'CREATE', entityType: 'clause_assessment' }),
      ]);
    }
  });

  it('lets only account admins, consultants and client admins create', async () => {
    const body = { name: 'Safety', standardIds: [standardId(app, 'ISO_45001')] };
    await ok(app, 'createIsoSystem', { as: PERSON.meera, body });
    await ok(app, 'createIsoSystem', { as: PERSON.arjun, body });
    for (const as of [PERSON.divya, PERSON.sameer, PERSON.vikram]) {
      await fails(app, 'createIsoSystem', { as, body }, 'FORBIDDEN', 403);
    }
    await fails(app, 'createIsoSystem', { as: PERSON.leela, body }, 'NOT_FOUND', 404);
  });

  it('refuses unknown standards, two editions of one standard and other clients’ units', async () => {
    const s9001 = standardId(app, 'ISO_9001');
    const error = await fails(
      app,
      'createIsoSystem',
      { body: { name: 'Bad', standardIds: [base().id] } },
      'VALIDATION',
      400,
    );
    expect(JSON.stringify(error)).toContain('standardIds');
    const edition = { ...firm().isoCatalogue.standards[0]!, id: base().id, edition: '2026' };
    firm().isoCatalogue.standards.push(edition);
    try {
      await fails(
        app,
        'createIsoSystem',
        { body: { name: 'Bad', standardIds: [s9001, edition.id] } },
        'VALIDATION',
        400,
      );
    } finally {
      firm().isoCatalogue.standards.pop();
    }
    await fails(
      app,
      'createIsoSystem',
      { body: { name: 'Bad', standardIds: [s9001], unitIds: [CHENNAI] } },
      'VALIDATION',
      400,
    );
  });

  it('lists the systems over the actor’s units, with filters and pages', async () => {
    const pune = seedSystem(app, { unitIds: [PUNE], name: 'Aa list Pune' });
    const bengaluru = seedSystem(app, { unitIds: [BENGALURU], name: 'Aa list Bengaluru' });
    const everywhere = seedSystem(app, { name: 'Aa list everywhere' });
    firm().iso.managementSystems.find((s) => s.id === everywhere.id)!.status = 'CERTIFIED';
    const ids = async (as: string, query: Record<string, string> = {}) =>
      (
        await ok<{ items: System[] }>(app, 'listIsoSystems', {
          as,
          query: { limit: '200', ...query },
        })
      ).items.map((s) => s.id);
    for (const as of [PERSON.meera, PERSON.sameer, PERSON.divya, PERSON.vikram]) {
      expect(await ids(as)).toEqual(expect.arrayContaining([pune.id, bengaluru.id, everywhere.id]));
    }
    for (const as of [PERSON.rohan, PERSON.nisha]) {
      const seen = await ids(as);
      expect(seen).toEqual(expect.arrayContaining([pune.id, everywhere.id]));
      expect(seen).not.toContain(bengaluru.id);
    }
    expect(await ids(PERSON.meera, { status: 'CERTIFIED' })).toContain(everywhere.id);
    expect(await ids(PERSON.meera, { status: 'CERTIFIED' })).not.toContain(pune.id);
    expect(await ids(PERSON.meera, { q: 'aa list b' })).toEqual([bengaluru.id]);
    const first = await ok<{ items: System[]; nextCursor: string | null; total: number }>(
      app,
      'listIsoSystems',
      { query: { limit: '1', count: 'true', q: 'aa list' } },
    );
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(3);
    expect(first.nextCursor).not.toBeNull();
    const harbour = await ok<{ items: System[] }>(app, 'listIsoSystems', {
      as: PERSON.leela,
      params: { clientId: HARBOUR },
    });
    expect(harbour.items.every((s) => s.clientId === HARBOUR)).toBe(true);
  });

  it('reads one system within unit scope', async () => {
    const bengaluru = seedSystem(app, { unitIds: [BENGALURU] });
    expect(
      (await ok<System>(app, 'getIsoSystem', { as: PERSON.vikram, params: { id: bengaluru.id } }))
        .id,
    ).toBe(bengaluru.id);
    await ok(app, 'getIsoSystem', { as: PERSON.sameer, params: { id: bengaluru.id } });
    for (const as of [PERSON.rohan, PERSON.nisha]) {
      await fails(app, 'getIsoSystem', { as, params: { id: bengaluru.id } }, 'NOT_FOUND', 404);
    }
    const harbour = seedSystem(app, { clientId: HARBOUR, standards: ['ISO_9001'] });
    await fails(app, 'getIsoSystem', { params: { id: harbour.id } }, 'NOT_FOUND', 404);
    await ok(app, 'getIsoSystem', {
      as: PERSON.joseph,
      params: { clientId: HARBOUR, id: harbour.id },
    });
  });

  it('changes fields, audits a status change as a transition and adds standards with their rows', async () => {
    const system = seedSystem(app, { standards: ['ISO_9001'] });
    const before = rowsOf(system.id).length;
    let updated = await ok<System>(app, 'updateIsoSystem', {
      as: PERSON.arjun,
      params: { id: system.id },
      body: {
        version: 1,
        name: 'Integrated system',
        scopeStatement: 'Food production at Pune.',
        unitIds: [PUNE],
        status: 'CERTIFIED',
        reviewIntervalMonths: 6,
      },
    });
    expect(updated).toMatchObject({
      version: 2,
      name: 'Integrated system',
      scopeStatement: 'Food production at Pune.',
      unitIds: [PUNE],
      status: 'CERTIFIED',
      reviewIntervalMonths: 6,
    });
    const events = isoEvents(app, system.id);
    expect(events.map((e) => e.action)).toEqual(['UPDATE', 'TRANSITION']);
    expect(events[0]!.after).toEqual({
      name: 'Integrated system',
      scopeStatement: 'Food production at Pune.',
      unitIds: [PUNE],
      reviewIntervalMonths: 6,
    });
    expect(events[1]).toMatchObject({
      entityType: 'management_system',
      before: { status: 'IMPLEMENTING' },
      after: { status: 'CERTIFIED' },
    });

    const s9001 = standardId(app, 'ISO_9001');
    const s45001 = standardId(app, 'ISO_45001');
    updated = await ok<System>(app, 'updateIsoSystem', {
      as: PERSON.kabir,
      params: { id: system.id },
      body: { version: 2, standardIds: [s45001, s9001] },
    });
    expect(updated.standardIds).toEqual([s9001, s45001]);
    expect(rowsOf(system.id)).toHaveLength(before + assessable('ISO_45001').length);
    expect(lastEvent(system.id)).toMatchObject({
      action: 'UPDATE',
      before: { standardIds: [s9001] },
      after: { standardIds: [s9001, s45001] },
    });

    // The same values again change nothing and write nothing.
    const count = isoEvents(app, system.id).length;
    const same = await ok<System>(app, 'updateIsoSystem', {
      params: { id: system.id },
      body: { version: 3, name: 'Integrated system' },
    });
    expect(same.version).toBe(3);
    expect(isoEvents(app, system.id)).toHaveLength(count);
  });

  it('refuses a dropped standard, foreign units, a stale version and non-managers', async () => {
    const system = seedSystem(app, { standards: ['ISO_9001', 'ISO_14001'] });
    const params = { id: system.id };
    await fails(
      app,
      'updateIsoSystem',
      { params, body: { version: 1, standardIds: [standardId(app, 'ISO_9001')] } },
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'updateIsoSystem',
      { params, body: { version: 1, unitIds: [CHENNAI] } },
      'VALIDATION',
      400,
    );
    const stale = await fails(
      app,
      'updateIsoSystem',
      { params, body: { version: 7, name: 'Late' } },
      'STALE_VERSION',
      409,
    );
    expect(stale.error.details).toEqual({ currentVersion: 1 });
    for (const as of [PERSON.divya, PERSON.sameer, PERSON.vikram]) {
      await fails(
        app,
        'updateIsoSystem',
        { as, params, body: { version: 1, name: 'No' } },
        'FORBIDDEN',
        403,
      );
    }
    expect(isoEvents(app, system.id)).toEqual([]);
  });

  it('records the climate decision, lets it change but never return to undecided', async () => {
    const system = seedSystem(app);
    const params = { id: system.id };
    const decided = await ok<System>(app, 'setIsoClimateDecision', {
      as: PERSON.kabir,
      params,
      body: {
        version: 1,
        climateChangeRelevant: true,
        climateChangeRationale: 'Heat waves affect the cold chain.',
        climateDecidedOn: TODAY,
      },
    });
    expect(decided).toMatchObject({
      version: 2,
      climateChangeRelevant: true,
      climateChangeRationale: 'Heat waves affect the cold chain.',
      climateDecidedOn: TODAY,
    });
    expect(lastEvent(system.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'management_system',
      before: { climateChangeRelevant: null, climateChangeRationale: null, climateDecidedOn: null },
      after: { climateChangeRelevant: true, climateDecidedOn: TODAY },
    });
    const changed = await ok<System>(app, 'setIsoClimateDecision', {
      as: PERSON.meera,
      params,
      body: {
        version: 2,
        climateChangeRelevant: false,
        climateChangeRationale: 'Reviewed: no material exposure.',
        climateDecidedOn: '2024-11-14',
      },
    });
    expect(changed.climateChangeRelevant).toBe(false);
    expect(lastEvent(system.id)).toMatchObject({
      before: { climateChangeRelevant: true },
      after: { climateChangeRelevant: false, climateDecidedOn: '2024-11-14' },
    });
    const back = {
      version: 3,
      climateChangeRelevant: null,
      climateChangeRationale: 'Undo',
      climateDecidedOn: TODAY,
    };
    await fails(app, 'setIsoClimateDecision', { params, body: back }, 'VALIDATION', 400);
    const valid = {
      version: 3,
      climateChangeRelevant: true,
      climateChangeRationale: 'Again.',
      climateDecidedOn: '2024-11-16',
    };
    await fails(app, 'setIsoClimateDecision', { params, body: valid }, 'VALIDATION', 400);
    await fails(
      app,
      'setIsoClimateDecision',
      { params, body: { ...valid, climateDecidedOn: TODAY, version: 1 } },
      'STALE_VERSION',
      409,
    );
    await fails(
      app,
      'setIsoClimateDecision',
      { as: PERSON.divya, params, body: { ...valid, climateDecidedOn: TODAY } },
      'FORBIDDEN',
      403,
    );
  });
});

// ---------- context items ----------

describe('context items', () => {
  it('adds, lists, changes and archives issues and interested parties', async () => {
    const system = seedSystem(app, { unitIds: [BENGALURU] });
    const params = { id: system.id };
    const party = await ok<IsoRow<'contextItems'>>(app, 'createIsoContextItem', {
      as: PERSON.kabir,
      params,
      body: {
        kind: 'INTERESTED_PARTY',
        text: 'Local residents',
        needs: 'Low noise at night',
        climateRelated: true,
      },
    });
    expect(party).toMatchObject({
      managementSystemId: system.id,
      needs: 'Low noise at night',
      climateRelated: true,
      reviewedOn: null,
      version: 1,
    });
    expect(isoEvents(app, party.id)).toEqual([
      expect.objectContaining({ action: 'CREATE', entityType: 'context_item' }),
    ]);
    const issue = await ok<IsoRow<'contextItems'>>(app, 'createIsoContextItem', {
      as: PERSON.arjun,
      params,
      body: { kind: 'EXTERNAL_ISSUE', text: 'Monsoon flooding', reviewedOn: TODAY },
    });
    const internal = await ok<IsoRow<'contextItems'>>(app, 'createIsoContextItem', {
      params,
      body: { kind: 'INTERNAL_ISSUE', text: 'Ageing boilers' },
    });
    await fails(
      app,
      'createIsoContextItem',
      { params, body: { kind: 'INTERNAL_ISSUE', text: 'x', needs: 'y' } },
      'VALIDATION',
      400,
    );
    for (const as of [PERSON.divya, PERSON.sameer, PERSON.vikram]) {
      await fails(
        app,
        'createIsoContextItem',
        { as, params, body: { kind: 'INTERNAL_ISSUE', text: 'x' } },
        'FORBIDDEN',
        403,
      );
    }

    const list = async (query: Record<string, string> = {}, as: string = PERSON.vikram) =>
      (
        await ok<{ items: IsoRow<'contextItems'>[] }>(app, 'listIsoContextItems', {
          as,
          params,
          query,
        })
      ).items.map((c) => c.id);
    expect(await list()).toEqual([internal.id, issue.id, party.id]);
    expect(await list({ kind: 'EXTERNAL_ISSUE,INTERESTED_PARTY' })).toEqual([issue.id, party.id]);
    expect(await list({ climateRelated: 'true' })).toEqual([party.id]);
    expect(await list({}, PERSON.sameer)).toHaveLength(3);
    await fails(app, 'listIsoContextItems', { as: PERSON.rohan, params }, 'NOT_FOUND', 404);

    const itemParams = { id: system.id, itemId: issue.id };
    const changed = await ok<IsoRow<'contextItems'>>(app, 'updateIsoContextItem', {
      as: PERSON.kabir,
      params: itemParams,
      body: { version: 1, text: 'Monsoon flooding of the access road', climateRelated: true },
    });
    expect(changed).toMatchObject({ version: 2, climateRelated: true });
    expect(lastEvent(issue.id)).toMatchObject({
      action: 'UPDATE',
      before: { text: 'Monsoon flooding', climateRelated: false },
      after: { text: 'Monsoon flooding of the access road', climateRelated: true },
    });
    await fails(
      app,
      'updateIsoContextItem',
      { params: itemParams, body: { version: 2, needs: 'Not for an issue' } },
      'VALIDATION',
      400,
    );
    await ok(app, 'updateIsoContextItem', {
      params: { id: system.id, itemId: party.id },
      body: { version: 1, needs: null },
    });
    await fails(
      app,
      'updateIsoContextItem',
      { params: itemParams, body: { version: 1, text: 'Stale' } },
      'STALE_VERSION',
      409,
    );
    await fails(
      app,
      'updateIsoContextItem',
      { as: PERSON.sameer, params: itemParams, body: { version: 2, text: 'No' } },
      'FORBIDDEN',
      403,
    );
    const other = seedSystem(app);
    await fails(
      app,
      'updateIsoContextItem',
      { params: { id: other.id, itemId: issue.id }, body: { version: 2, text: 'Elsewhere' } },
      'NOT_FOUND',
      404,
    );

    await fails(
      app,
      'archiveIsoContextItem',
      { params: itemParams, body: { version: 2 } },
      'REASON_REQUIRED',
      422,
    );
    await fails(
      app,
      'archiveIsoContextItem',
      { as: PERSON.vikram, params: itemParams, body: { version: 2, reason: 'Gone' } },
      'FORBIDDEN',
      403,
    );
    const archived = await ok<IsoRow<'contextItems'>>(app, 'archiveIsoContextItem', {
      as: PERSON.kabir,
      params: itemParams,
      body: { version: 2, reason: 'Road rebuilt' },
    });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.version).toBe(3);
    expect(lastEvent(issue.id)).toMatchObject({ action: 'ARCHIVE', reason: 'Road rebuilt' });
    expect(await list()).toEqual([internal.id, party.id]);
    expect(await list({ includeArchived: 'true' })).toEqual([internal.id, issue.id, party.id]);
    await fails(
      app,
      'updateIsoContextItem',
      { params: itemParams, body: { version: 3, text: 'Archived' } },
      'NOT_FOUND',
      404,
    );
  });
});

// ---------- checklist ----------

describe('clause checklist', () => {
  it('lists rows by standard and clause number, with clause fields and filters', async () => {
    const system = seedSystem(app);
    const row = rowOf(system.id, 'ISO_14001', '6.1.2');
    row.status = 'PARTIAL';
    row.ownerId = PERSON.sameer;
    const { items } = await ok<{ items: View[] }>(app, 'listIsoChecklist', {
      as: PERSON.vikram,
      params: { id: system.id },
    });
    expect(items).toHaveLength(rowsOf(system.id).length);
    expect(items[0]).toMatchObject({
      standardId: standardId(app, 'ISO_9001'),
      clauseNumber: '4.1',
      exclusionAllowed: false,
      allowedActions: [],
    });
    expect(items.at(-1)!.standardId).toBe(standardId(app, 'ISO_45001'));
    const view = items.find((v) => v.id === row.id)!;
    expect(view).toMatchObject({ clauseNumber: '6.1.2', status: 'PARTIAL' });
    expect(view.clauseTitle.length).toBeGreaterThan(0);

    const ids = async (query: Record<string, string>, as: string = PERSON.meera) =>
      (
        await ok<{ items: View[] }>(app, 'listIsoChecklist', {
          as,
          params: { id: system.id },
          query,
        })
      ).items.map((v) => v.id);
    expect(await ids({ standardId: standardId(app, 'ISO_14001'), status: 'PARTIAL' })).toEqual([
      row.id,
    ]);
    expect(await ids({ ownerId: 'me' }, PERSON.sameer)).toEqual([row.id]);
    expect(await ids({ ownerId: PERSON.sameer })).toEqual([row.id]);
    expect(await ids({ naState: 'REQUESTED' })).toEqual([]);
    expect(await ids({ standardId: standardId(app, 'ISO_45001') })).toHaveLength(
      assessable('ISO_45001').length,
    );
  });

  it('shows a row outside the actor’s units only to its owner', async () => {
    const system = seedSystem(app, { unitIds: [BENGALURU], standards: ['ISO_14001'] });
    await fails(
      app,
      'listIsoChecklist',
      { as: PERSON.rohan, params: { id: system.id } },
      'NOT_FOUND',
      404,
    );
    const row = rowOf(system.id, 'ISO_14001', '8.2');
    row.ownerId = PERSON.rohan;
    const { items } = await ok<{ items: View[] }>(app, 'listIsoChecklist', {
      as: PERSON.rohan,
      params: { id: system.id },
    });
    expect(items.map((v) => v.id)).toEqual([row.id]);
    const updated = await ok<View>(app, 'updateIsoChecklistRow', {
      as: PERSON.rohan,
      params: rowParams(row),
      body: { version: 1, notes: 'Drill held.' },
    });
    expect(updated.notes).toBe('Drill held.');
    await fails(
      app,
      'updateIsoChecklistRow',
      {
        as: PERSON.nisha,
        params: rowParams(rowOf(system.id, 'ISO_14001', '8.1')),
        body: { version: 1, notes: 'x' },
      },
      'NOT_FOUND',
      404,
    );
  });

  it('lets managers and the row owner write status, notes and review date', async () => {
    const system = seedSystem(app);
    const row = rowOf(system.id, 'ISO_9001', '7.2');
    row.ownerId = PERSON.sameer;
    const params = rowParams(row);
    const view = await ok<View>(app, 'updateIsoChecklistRow', {
      as: PERSON.sameer,
      params,
      body: { version: 1, status: 'PARTIAL', notes: 'Matrix drafted.', lastReviewedOn: TODAY },
    });
    expect(view).toMatchObject({
      version: 2,
      status: 'PARTIAL',
      notes: 'Matrix drafted.',
      lastReviewedOn: TODAY,
    });
    expect(lastEvent(row.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'clause_assessment',
      before: { status: 'NOT_STARTED', notes: null, lastReviewedOn: null },
      after: { status: 'PARTIAL', notes: 'Matrix drafted.', lastReviewedOn: TODAY },
    });
    await ok(app, 'updateIsoChecklistRow', {
      as: PERSON.arjun,
      params,
      body: { version: 2, status: 'IMPLEMENTED' },
    });
    for (const as of [PERSON.rohan, PERSON.divya, PERSON.vikram]) {
      await fails(
        app,
        'updateIsoChecklistRow',
        { as, params, body: { version: 3, notes: 'No' } },
        'FORBIDDEN',
        403,
      );
    }
    await fails(
      app,
      'updateIsoChecklistRow',
      { params, body: { version: 2, notes: 'Stale' } },
      'STALE_VERSION',
      409,
    );
    await fails(
      app,
      'updateIsoChecklistRow',
      { params, body: { version: 3, status: 'NOT_APPLICABLE' } },
      'VALIDATION',
      400,
    );
    const other = seedSystem(app);
    await fails(
      app,
      'updateIsoChecklistRow',
      { params: { id: other.id, rowId: row.id }, body: { version: 3, notes: 'x' } },
      'NOT_FOUND',
      404,
    );
  });

  it('reassigns a row only by a manager, to a person of the client', async () => {
    const system = seedSystem(app);
    const row = rowOf(system.id, 'ISO_45001', '5.4');
    const params = rowParams(row);
    const view = await ok<View>(app, 'updateIsoChecklistRow', {
      as: PERSON.kabir,
      params,
      body: { version: 1, ownerId: PERSON.sameer, notes: 'Committee minutes' },
    });
    expect(view.ownerId).toBe(PERSON.sameer);
    expect(isoEvents(app, row.id).slice(-2)).toEqual([
      expect.objectContaining({ action: 'UPDATE', after: { notes: 'Committee minutes' } }),
      expect.objectContaining({
        action: 'REASSIGN',
        before: { ownerId: null },
        after: { ownerId: PERSON.sameer },
      }),
    ]);
    await fails(
      app,
      'updateIsoChecklistRow',
      { as: PERSON.sameer, params, body: { version: 2, ownerId: PERSON.rohan } },
      'FORBIDDEN',
      403,
    );
    // The owner may send their own id back unchanged.
    await ok(app, 'updateIsoChecklistRow', {
      as: PERSON.sameer,
      params,
      body: { version: 2, ownerId: PERSON.sameer, notes: 'Minutes filed' },
    });
    for (const person of [PERSON.priya, PERSON.gita, PERSON.vikram]) {
      await fails(
        app,
        'updateIsoChecklistRow',
        { params, body: { version: 3, ownerId: person } },
        'VALIDATION',
        400,
      );
    }
    const cleared = await ok<View>(app, 'updateIsoChecklistRow', {
      params,
      body: { version: 3, ownerId: null },
    });
    expect(cleared.ownerId).toBeNull();
  });

  it('keeps clause 4.1 from IMPLEMENTED until the climate decision', async () => {
    const system = seedSystem(app, { standards: ['ISO_14001', 'ISO_45001'] });
    for (const code of ['ISO_14001', 'ISO_45001'] as const) {
      const row = rowOf(system.id, code, '4.1');
      const error = await fails(
        app,
        'updateIsoChecklistRow',
        { params: rowParams(row), body: { version: 1, status: 'IMPLEMENTED' } },
        'VALIDATION',
        400,
      );
      expect(error.error.details).toEqual({
        issues: [{ path: ['body', 'status'], message: expect.stringContaining('climate') }],
      });
      await ok(app, 'updateIsoChecklistRow', {
        params: rowParams(row),
        body: { version: 1, status: 'PARTIAL' },
      });
    }
    await ok(app, 'updateIsoChecklistRow', {
      params: rowParams(rowOf(system.id, 'ISO_14001', '4.2')),
      body: { version: 1, status: 'IMPLEMENTED' },
    });
    await ok(app, 'setIsoClimateDecision', {
      params: { id: system.id },
      body: {
        version: 1,
        climateChangeRelevant: false,
        climateChangeRationale: 'No exposure found.',
        climateDecidedOn: TODAY,
      },
    });
    const done = await ok<View>(app, 'updateIsoChecklistRow', {
      params: rowParams(rowOf(system.id, 'ISO_14001', '4.1')),
      body: { version: 2, status: 'IMPLEMENTED' },
    });
    expect(done.status).toBe('IMPLEMENTED');
  });
});

describe('clause N/A (model §4.6)', () => {
  const naBody = (version: number, reason = 'We do no design work.') => ({ version, reason });

  it('requests, rejects, requests again, approves and withdraws, audited each time', async () => {
    const system = seedSystem(app);
    const row = rowOf(system.id, 'ISO_9001', '8.3.1');
    row.ownerId = PERSON.sameer;
    row.status = 'PARTIAL';
    const params = rowParams(row);

    const owner = (
      await ok<{ items: View[] }>(app, 'listIsoChecklist', {
        as: PERSON.sameer,
        params: { id: system.id },
        query: { ownerId: 'me' },
      })
    ).items[0]!;
    expect(owner.allowedActions).toEqual(['REQUEST_NA']);
    expect(owner.exclusionAllowed).toBe(true);

    let view = await ok<View>(app, 'requestIsoClauseNa', {
      as: PERSON.sameer,
      params,
      body: naBody(1),
    });
    expect(view).toMatchObject({
      version: 2,
      status: 'NOT_APPLICABLE',
      naState: 'REQUESTED',
      statusBeforeNa: 'PARTIAL',
      justification: 'We do no design work.',
      naRequestedById: PERSON.sameer,
      allowedActions: [],
    });
    expect(lastEvent(row.id)).toMatchObject({
      action: 'TRANSITION',
      entityType: 'clause_assessment',
      before: { status: 'PARTIAL', naState: 'NONE', statusBeforeNa: null },
      after: { status: 'NOT_APPLICABLE', naState: 'REQUESTED', statusBeforeNa: 'PARTIAL' },
      reason: 'We do no design work.',
    });
    expect(lastEvent(row.id).after).not.toHaveProperty('delegated');

    // While requested: no direct status write, no second request.
    await fails(
      app,
      'updateIsoChecklistRow',
      { params, body: { version: 2, status: 'IMPLEMENTED' } },
      'VALIDATION',
      400,
    );
    await ok(app, 'updateIsoChecklistRow', {
      as: PERSON.sameer,
      params,
      body: { version: 2, notes: 'Waiting for a decision' },
    });
    const twice = await fails(
      app,
      'requestIsoClauseNa',
      { as: PERSON.sameer, params, body: naBody(3) },
      'INVALID_TRANSITION',
      409,
    );
    expect(twice.error.details).toEqual({
      entity: 'clause_assessment',
      from: 'REQUESTED',
      action: 'REQUEST_NA',
    });
    const approver = (
      await ok<{ items: View[] }>(app, 'listIsoChecklist', {
        as: PERSON.divya,
        params: { id: system.id },
        query: { naState: 'REQUESTED' },
      })
    ).items;
    expect(approver.map((v) => v.allowedActions)).toEqual([['APPROVE_NA', 'REJECT_NA']]);

    await fails(
      app,
      'rejectIsoClauseNa',
      { as: PERSON.divya, params, body: { version: 3 } },
      'REASON_REQUIRED',
      422,
    );
    view = await ok<View>(app, 'rejectIsoClauseNa', {
      as: PERSON.divya,
      params,
      body: { version: 3, reason: 'Recipes are designed here.' },
    });
    expect(view).toMatchObject({
      status: 'PARTIAL',
      naState: 'REJECTED',
      statusBeforeNa: null,
      naDecidedById: PERSON.divya,
      naDecidedAt: expect.any(String),
    });
    expect(lastEvent(row.id)).toMatchObject({
      action: 'TRANSITION',
      after: { naState: 'REJECTED', status: 'PARTIAL' },
      reason: 'Recipes are designed here.',
    });
    await ok(app, 'updateIsoChecklistRow', {
      as: PERSON.sameer,
      params,
      body: { version: 4, status: 'IMPLEMENTED' },
    });

    view = await ok<View>(app, 'requestIsoClauseNa', {
      as: PERSON.sameer,
      params,
      body: naBody(5, 'Design moved to the parent company.'),
    });
    expect(view).toMatchObject({
      naState: 'REQUESTED',
      statusBeforeNa: 'IMPLEMENTED',
      naDecidedById: null,
      naDecidedAt: null,
    });
    view = await ok<View>(app, 'approveIsoClauseNa', {
      as: PERSON.divya,
      params,
      body: { version: 6, comment: 'Agreed.' },
    });
    expect(view).toMatchObject({
      status: 'NOT_APPLICABLE',
      naState: 'APPROVED',
      naDecidedById: PERSON.divya,
    });
    expect(lastEvent(row.id)).toMatchObject({
      before: { naState: 'REQUESTED' },
      after: { naState: 'APPROVED', naDecidedById: PERSON.divya },
      reason: 'Agreed.',
    });
    expect(lastEvent(row.id).after).not.toHaveProperty('delegated');
    await fails(
      app,
      'approveIsoClauseNa',
      { as: PERSON.divya, params, body: { version: 7 } },
      'INVALID_TRANSITION',
      409,
    );
    await fails(
      app,
      'updateIsoChecklistRow',
      { params, body: { version: 7, status: 'NOT_STARTED' } },
      'VALIDATION',
      400,
    );

    const approved = (
      await ok<{ items: View[] }>(app, 'listIsoChecklist', {
        as: PERSON.sameer,
        params: { id: system.id },
        query: { naState: 'APPROVED' },
      })
    ).items[0]!;
    expect(approved.allowedActions).toEqual(['WITHDRAW_NA']);
    await fails(
      app,
      'withdrawIsoClauseNa',
      { as: PERSON.vikram, params, body: naBody(7) },
      'FORBIDDEN',
      403,
    );
    view = await ok<View>(app, 'withdrawIsoClauseNa', {
      as: PERSON.sameer,
      params,
      body: naBody(7, 'Design work starts at Pune.'),
    });
    expect(view).toMatchObject({
      status: 'NOT_STARTED',
      naState: 'NONE',
      statusBeforeNa: null,
      justification: null,
      naRequestedById: null,
      naDecidedById: null,
      naDecidedAt: null,
      allowedActions: ['REQUEST_NA'],
    });
    expect(lastEvent(row.id)).toMatchObject({
      action: 'TRANSITION',
      after: { naState: 'NONE', status: 'NOT_STARTED' },
      reason: 'Design work starts at Pune.',
    });
    await fails(
      app,
      'withdrawIsoClauseNa',
      { as: PERSON.sameer, params, body: naBody(8) },
      'INVALID_TRANSITION',
      409,
    );
    const transitions = isoEvents(app, row.id).filter((e) => e.action === 'TRANSITION');
    expect(transitions).toHaveLength(5);
  });

  it('allows N/A only where the clause allows exclusion', async () => {
    const system = seedSystem(app);
    for (const [code, number] of [
      ['ISO_9001', '4.1'],
      ['ISO_9001', '8.2.1'],
      ['ISO_14001', '8.2'],
      ['ISO_45001', '8.1.4.2'],
    ] as const) {
      const row = rowOf(system.id, code, number);
      await fails(
        app,
        'requestIsoClauseNa',
        { params: rowParams(row), body: naBody(1) },
        'VALIDATION',
        400,
      );
      expect(isoEvents(app, row.id)).toEqual([]);
    }
    const row = rowOf(system.id, 'ISO_9001', '8.5.5');
    await fails(
      app,
      'requestIsoClauseNa',
      { params: rowParams(row), body: { version: 1 } },
      'REASON_REQUIRED',
      422,
    );
    await fails(
      app,
      'requestIsoClauseNa',
      { params: rowParams(row), body: naBody(2) },
      'STALE_VERSION',
      409,
    );
  });

  it('applies the role matrix and maker-checker to every step', async () => {
    const system = seedSystem(app, { unitIds: [BENGALURU] });
    const row = rowOf(system.id, 'ISO_9001', '7.1.5.2');
    row.ownerId = PERSON.sameer;
    const params = rowParams(row);
    for (const as of [PERSON.divya, PERSON.vikram]) {
      await fails(app, 'requestIsoClauseNa', { as, params, body: naBody(1) }, 'FORBIDDEN', 403);
    }
    await fails(
      app,
      'requestIsoClauseNa',
      { as: PERSON.rohan, params, body: naBody(1) },
      'NOT_FOUND',
      404,
    );
    // A client admin takes the owner's step as delegate.
    await ok(app, 'requestIsoClauseNa', { as: PERSON.kabir, params, body: naBody(1) });
    expect(lastEvent(row.id).after).toMatchObject({ naState: 'REQUESTED', delegated: true });
    const kabirView = (
      await ok<{ items: View[] }>(app, 'listIsoChecklist', {
        as: PERSON.kabir,
        params: { id: system.id },
        query: { naState: 'REQUESTED' },
      })
    ).items[0]!;
    expect(kabirView.allowedActions).toEqual([]);
    const denied = await fails(
      app,
      'approveIsoClauseNa',
      { as: PERSON.kabir, params, body: { version: 2 } },
      'FORBIDDEN',
      403,
    );
    expect(denied.error.details).toEqual({ action: 'isoChecklist.decideNa' });
    await fails(
      app,
      'rejectIsoClauseNa',
      { as: PERSON.kabir, params, body: { version: 2, reason: 'No' } },
      'FORBIDDEN',
      403,
    );
    for (const as of [PERSON.meera, PERSON.arjun, PERSON.sameer, PERSON.vikram]) {
      await fails(
        app,
        'approveIsoClauseNa',
        { as, params, body: { version: 2 } },
        'FORBIDDEN',
        403,
      );
    }
    // nisha approves Pune only; this system covers Bengaluru.
    await fails(
      app,
      'approveIsoClauseNa',
      { as: PERSON.nisha, params, body: { version: 2 } },
      'NOT_FOUND',
      404,
    );
    await ok(app, 'approveIsoClauseNa', { as: PERSON.divya, params, body: { version: 2 } });

    // An account admin requests on a row with no owner (delegated); the client admin decides as delegate approver.
    const other = rowOf(system.id, 'ISO_9001', '8.3.4');
    await ok(app, 'requestIsoClauseNa', {
      as: PERSON.meera,
      params: rowParams(other),
      body: naBody(1),
    });
    expect(lastEvent(other.id).after).toMatchObject({ delegated: true });
    const decided = await ok<View>(app, 'rejectIsoClauseNa', {
      as: PERSON.kabir,
      params: rowParams(other),
      body: { version: 2, reason: 'Needs evidence' },
    });
    expect(decided).toMatchObject({ naState: 'REJECTED', status: 'NOT_STARTED' });
    expect(lastEvent(other.id).after).toMatchObject({ naState: 'REJECTED', delegated: true });
    // A non-owner OW of the units may not request; the owner may, without delegation.
    const pune = seedSystem(app, { unitIds: [PUNE], standards: ['ISO_9001'] });
    const puneRow = rowOf(pune.id, 'ISO_9001', '8.5.3');
    await fails(
      app,
      'requestIsoClauseNa',
      { as: PERSON.rohan, params: rowParams(puneRow), body: naBody(1) },
      'FORBIDDEN',
      403,
    );
    puneRow.ownerId = PERSON.rohan;
    await ok(app, 'requestIsoClauseNa', {
      as: PERSON.rohan,
      params: rowParams(puneRow),
      body: naBody(1),
    });
    await ok(app, 'approveIsoClauseNa', {
      as: PERSON.nisha,
      params: rowParams(puneRow),
      body: { version: 2 },
    });
    expect(lastEvent(puneRow.id).after).not.toHaveProperty('delegated');
    await ok(app, 'withdrawIsoClauseNa', {
      as: PERSON.kabir,
      params: rowParams(puneRow),
      body: naBody(3, 'Applies again'),
    });
    expect(lastEvent(puneRow.id).after).toMatchObject({ naState: 'NONE', delegated: true });
  });
});

// ---------- overview ----------

const S = (code: IsoStandardCode) => standardId(app, code);

function context(systemId: string, climateRelated: boolean) {
  return seed(app, 'contextItems', {
    ...base(),
    managementSystemId: systemId,
    kind: 'EXTERNAL_ISSUE',
    text: 'Heat waves',
    needs: null,
    climateRelated,
    reviewedOn: null,
  });
}

function risk(
  systemId: string,
  kind: 'RISK' | 'OPPORTUNITY' | 'ASPECT' | 'HAZARD',
  fields: Partial<IsoRow<'riskItems'>> = {},
) {
  const aspect = kind === 'ASPECT';
  const hazard = kind === 'HAZARD';
  return seed(app, 'riskItems', {
    ...base(),
    managementSystemId: systemId,
    kind,
    unitId: null,
    activity: 'Production',
    description: `${kind} item`,
    impact: aspect || hazard ? 'Harm' : null,
    lifeCycleStages: aspect ? ['PRODUCTION'] : [],
    controlType: aspect ? 'CONTROL' : null,
    routine: hazard ? true : null,
    personsExposed: hazard ? ['WORKER'] : [],
    condition: aspect || hazard ? 'NORMAL' : null,
    assessedWith: null,
    likelihood: 2,
    severity: 3,
    residualLikelihood: null,
    residualSeverity: null,
    rating: 6,
    residualRating: null,
    significant: false,
    significantOverride: null,
    significanceReason: null,
    obligationIds: [],
    climateRelated: false,
    ownerId: PERSON.sameer,
    reviewDueOn: null,
    lastReviewedOn: null,
    ...fields,
  });
}

function objective(systemId: string, fields: Partial<IsoRow<'objectives'>>) {
  return seed(app, 'objectives', {
    ...base(),
    createdAt: '2024-04-01T06:30:00Z',
    managementSystemId: systemId,
    standards: ['ISO_9001'],
    text: 'Objective',
    target: 90,
    unitOfMeasure: '%',
    baseline: 50,
    direction: 'INCREASE',
    readingRule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    riskItemIds: [],
    ownerId: PERSON.sameer,
    dueOn: '2025-03-31',
    closedOn: null,
    outcome: null,
    ...fields,
  });
}

function reading(objectiveId: string, value: number, periodEnd = '2024-10-31') {
  return seed(app, 'readings', {
    ...base(),
    objectiveId,
    periodStart: `${periodEnd.slice(0, 7)}-01`,
    periodEnd,
    value,
    note: null,
    recordedById: PERSON.sameer,
  });
}

function action(
  type: 'NONCONFORMITY' | 'RISK_ITEM' | 'OBJECTIVE' | 'AUDIT_FINDING' | 'MANAGEMENT_REVIEW',
  subjectId: string,
  fields: Partial<IsoRow<'actions'>> = {},
) {
  return seed(app, 'actions', {
    ...base(),
    subject: { type, id: subjectId },
    text: 'Do it',
    resources: null,
    ownerId: PERSON.sameer,
    dueOn: '2024-12-31',
    doneOn: null,
    state: 'OPEN',
    effectivenessNote: null,
    cancelReason: null,
    controlHierarchy: null,
    outputKey: null,
    ...fields,
  });
}

function nc(systemId: string, fields: Partial<IsoRow<'nonconformities'>> = {}) {
  return seed(app, 'nonconformities', {
    ...base(),
    managementSystemId: systemId,
    number: 900 + firm().iso.nonconformities.length,
    source: 'PROCESS',
    sourceInstanceId: null,
    raisedFromRiskItemId: null,
    severity: 'MINOR',
    standards: ['ISO_9001'],
    clauseIds: [],
    unitId: PUNE,
    description: 'Label printed wrong',
    reportedById: PERSON.sameer,
    reportedOn: '2024-10-01',
    containment: null,
    correction: null,
    disposition: null,
    dispositionAuthorisedById: null,
    rootCauseMethod: null,
    rootCause: null,
    similarOccurrences: null,
    relatedRiskItemIds: [],
    updatedRiskItemIds: [],
    riskReview: null,
    systemChange: null,
    changedDocumentIds: [],
    noActionReason: null,
    ownerId: PERSON.rohan,
    approverId: PERSON.nisha,
    dueOn: '2024-12-31',
    effectivenessDueOn: null,
    effectivenessNote: null,
    effective: null,
    closedOn: null,
    cancelReason: null,
    state: 'OPEN',
    incident: null,
    ...fields,
  });
}

const worked = {
  containment: 'Held stock',
  correction: 'Reprinted',
  rootCauseMethod: 'FIVE_WHYS' as const,
  rootCause: 'Template',
  similarOccurrences: 'None',
  riskReview: 'None needed',
  systemChange: 'None needed',
};

function incident(
  type: 'INJURY' | 'NEAR_MISS',
  occurredAt: string,
  investigatorIds: string[] = [],
): IsoRow<'nonconformities'>['incident'] {
  return {
    occurredAt,
    location: 'Packing hall',
    type,
    outcome: type === 'NEAR_MISS' ? 'NONE' : 'FIRST_AID',
    personCategory: type === 'NEAR_MISS' ? null : 'EMPLOYEE',
    lostDays: null,
    reportable: false,
    statutoryInstanceId: null,
    investigatorIds,
    workerParticipation: true,
  };
}

function audit(programmeId: string, fields: Partial<IsoRow<'internalAudits'>> = {}) {
  return seed(app, 'internalAudits', {
    ...base(),
    programmeId,
    title: 'Audit',
    plannedStart: '2024-10-01',
    plannedEnd: '2024-10-02',
    clauseIds: [],
    unitIds: [],
    leadAuditorId: PERSON.sameer,
    auditorIds: [],
    auditeeIds: [],
    reportedToIds: [],
    independenceNote: null,
    state: 'PLANNED',
    summary: null,
    reportedOn: null,
    cancelReason: null,
    ...fields,
  });
}

const reported = (reportedOn: string) => ({
  state: 'REPORTED' as const,
  summary: 'Fine',
  reportedOn,
  reportedToIds: [PERSON.kabir],
});

function checked(
  internalAuditId: string,
  clauseId: string,
  fields: Partial<IsoRow<'auditChecklistItems'>> = {},
) {
  return seed(app, 'auditChecklistItems', {
    ...base(),
    internalAuditId,
    clauseId,
    unitId: null,
    question: 'Is it done?',
    auditorNote: null,
    result: 'CONFORMS',
    findingId: null,
    notAuditedReason: null,
    ...fields,
  });
}

function finding(fields: Partial<IsoRow<'findings'>>) {
  return seed(app, 'findings', {
    ...base(),
    internalAuditId: null,
    externalAuditId: null,
    type: 'OBSERVATION',
    clauseIds: [],
    unitId: null,
    description: 'Labels faded',
    nonconformityId: null,
    ...fields,
  });
}

function programme(systemId: string, fy: string) {
  return seed(app, 'auditProgrammes', { ...base(), managementSystemId: systemId, fy, notes: null });
}

function review(
  systemId: string,
  standards: IsoStandardCode[],
  heldOn: string,
  unnoted: string[] = [],
) {
  const r = seed(app, 'managementReviews', {
    ...base(),
    managementSystemId: systemId,
    standards,
    plannedOn: heldOn,
    heldOn,
    chairId: PERSON.kabir,
    attendeeIds: [],
    minutes: null,
    state: 'HELD',
    cancelReason: null,
  });
  const ids = standards.map(S);
  const seen = new Set<string>();
  for (const def of firm().isoCatalogue.reviewInputDefs) {
    if (!ids.includes(def.standardId) || seen.has(def.key)) continue;
    seen.add(def.key);
    seed(app, 'reviewInputs', {
      ...base(),
      managementReviewId: r.id,
      inputDefId: def.id,
      notes: unnoted.includes(def.key) ? null : 'Discussed.',
    });
  }
  return r;
}

function policy(systemId: string, codes: IsoStandardCode[]) {
  const doc = seed(app, 'documents', {
    ...base(),
    managementSystemId: systemId,
    code: `POL-${firm().iso.documents.length + 1}`,
    title: 'Policy',
    type: 'POLICY',
    clauseIds: codes.map((c) => clause(c, c === 'ISO_9001' ? '5.2.1' : '5.2')),
    status: 'ACTIVE',
    currentRevisionId: base().id,
    ownerId: PERSON.sameer,
    approverId: PERSON.divya,
    reviewDueOn: null,
    lastReviewedOn: null,
    retention: null,
    issuer: null,
    externalRef: null,
  });
  return doc;
}

function cert(systemId: string, code: IsoStandardCode, fields: Partial<IsoRow<'certifications'>>) {
  return seed(app, 'certifications', {
    ...base(),
    managementSystemId: systemId,
    standardId: S(code),
    body: 'Fictional Certification Body',
    certificateNumber: null,
    issuedOn: null,
    expiresOn: null,
    scopeText: null,
    unitIds: [],
    ...fields,
  });
}

function external(
  systemId: string,
  codes: IsoStandardCode[],
  type: IsoRow<'externalAudits'>['type'],
  endOn: string,
) {
  return seed(app, 'externalAudits', {
    ...base(),
    managementSystemId: systemId,
    standardIds: codes.map(S),
    type,
    body: 'Fictional Certification Body',
    leadAuditorName: null,
    startOn: endOn,
    endOn,
    recommendation: null,
    responseDueOn: null,
    state: 'HELD',
    cancelReason: null,
  });
}

async function overview(as: string, systemId: string, query: Record<string, string> = {}) {
  const result = await ok<IsoOverview>(app, 'getIsoOverview', {
    as,
    query: { managementSystemId: systemId, ...query },
  });
  return result.systems[0]!;
}

const gates = (o: Overview, code: IsoStandardCode) =>
  Object.fromEntries(
    o.certificationReadiness.standards
      .find((s) => s.standardId === S(code))!
      .gates.map((g) => [g.gate, g.missing]),
  );

describe('ISO overview', () => {
  let system: System;
  const r: Record<string, { id: string }> = {};

  beforeAll(() => {
    system = seedSystem(app, {
      unitIds: [PUNE, BENGALURU],
      climateChangeRelevant: true,
      name: 'Overview system',
    });
    firm().iso.managementSystems.find((s) => s.id === system.id)!.scopeStatement =
      'Food production at Pune and Bengaluru.';
    const sid = system.id;

    // Checklist: one each of implemented, partial, approved N/A and requested N/A in ISO 9001.
    Object.assign(rowOf(sid, 'ISO_9001', '4.1'), { status: 'IMPLEMENTED' });
    Object.assign(rowOf(sid, 'ISO_9001', '4.2'), { status: 'PARTIAL' });
    Object.assign(rowOf(sid, 'ISO_9001', '8.3.1'), {
      status: 'NOT_APPLICABLE',
      naState: 'APPROVED',
      statusBeforeNa: 'NOT_STARTED',
      justification: 'No design',
      naRequestedById: PERSON.sameer,
      naDecidedById: PERSON.divya,
      naDecidedAt: '2024-11-01T06:30:00Z',
    });
    Object.assign(rowOf(sid, 'ISO_9001', '8.3.2'), {
      status: 'NOT_APPLICABLE',
      naState: 'REQUESTED',
      statusBeforeNa: 'NOT_STARTED',
      justification: 'No design',
      naRequestedById: PERSON.sameer,
    });

    context(sid, true);
    r.r1 = risk(sid, 'RISK', { significant: true, rating: 16, reviewDueOn: '2024-11-01' });
    r.r2 = risk(sid, 'ASPECT', { unitId: PUNE, ownerId: PERSON.rohan, reviewDueOn: '2025-01-01' });
    r.r3 = risk(sid, 'HAZARD', { unitId: BENGALURU, significant: true, climateRelated: true });

    r.o1 = objective(sid, {});
    reading(r.o1.id, 60);
    reading(r.o1.id, 55, '2024-09-30');
    r.o2 = objective(sid, {
      standards: ['ISO_14001'],
      direction: 'DECREASE',
      baseline: 100,
      target: 80,
    });
    reading(r.o2.id, 70);
    reading(r.o2.id, 99, '2024-12-31'); // after as-of: not read
    r.o3 = objective(sid, { standards: ['ISO_45001'], direction: 'MAINTAIN', target: 0 });
    r.o4 = objective(sid, { closedOn: '2024-09-30', outcome: 'ACHIEVED' });
    r.o5 = objective(sid, { direction: 'MAINTAIN', target: 100, baseline: null });
    reading(r.o5.id, 90);
    r.o6 = objective(sid, { standards: ['ISO_45001'], direction: 'MAINTAIN', target: 0 });
    reading(r.o6.id, 0);

    r.a1 = action('OBJECTIVE', r.o1.id, { dueOn: '2024-11-10' });
    r.a2 = action('OBJECTIVE', r.o5.id, { state: 'DONE', doneOn: '2024-10-01' });
    r.a3 = action('OBJECTIVE', r.o3.id, { state: 'CANCELLED', cancelReason: 'Dropped' });
    r.a6 = action('OBJECTIVE', r.o6.id);
    // No baseline: the line starts at the first reading; due before it was set: the target is expected now.
    r.o7 = objective(sid, { baseline: null, target: 10, dueOn: '2024-03-31' });
    reading(r.o7.id, 5, '2024-08-31');
    reading(r.o7.id, 12);
    action('OBJECTIVE', r.o7.id, { state: 'DONE', doneOn: '2024-10-01' });

    r.n1 = nc(sid, { dueOn: '2024-11-01' });
    r.n2 = nc(sid, {
      ...worked,
      unitId: BENGALURU,
      ownerId: PERSON.sameer,
      approverId: PERSON.divya,
      state: 'AWAITING_VERIFICATION',
      effectivenessDueOn: '2024-11-10',
    });
    r.n3 = nc(sid, {
      ...worked,
      state: 'CLOSED',
      closedOn: '2024-10-20',
      effective: true,
      effectivenessNote: 'Held',
    });
    r.n4 = nc(sid, {
      source: 'INCIDENT',
      standards: ['ISO_45001'],
      dueOn: '2024-12-15',
      incident: incident('INJURY', '2024-08-10T04:00:00Z'),
    });
    // 20:00 UTC on 31 March is 1 April in Kolkata: in FY 2024-25.
    r.n5 = nc(sid, {
      ...worked,
      source: 'NEAR_MISS',
      standards: ['ISO_45001'],
      unitId: BENGALURU,
      ownerId: PERSON.sameer,
      approverId: PERSON.divya,
      state: 'ROOT_CAUSE_FOUND',
      incident: incident('NEAR_MISS', '2024-03-31T20:00:00Z', [PERSON.nisha]),
    });
    r.n6 = nc(sid, {
      source: 'INCIDENT',
      standards: ['ISO_45001'],
      state: 'CANCELLED',
      cancelReason: 'Duplicate',
      incident: incident('INJURY', '2024-09-01T04:00:00Z'),
    });
    r.n7 = nc(sid, {
      source: 'INCIDENT',
      standards: ['ISO_45001'],
      reportedOn: '2024-03-31',
      incident: incident('INJURY', '2024-03-31T10:00:00Z'),
    });

    r.a4 = action('NONCONFORMITY', r.n1.id, { ownerId: PERSON.rohan });
    r.a5 = action('RISK_ITEM', r.r3.id, { dueOn: '2024-11-01', controlHierarchy: 'ENGINEERING' });
    action('RISK_ITEM', base().id); // a subject that is not in the system: not counted

    r.d1 = policy(sid, ['ISO_9001', 'ISO_14001']);
    r.d2 = seed(app, 'documents', {
      ...base(),
      managementSystemId: sid,
      code: 'QP-01',
      title: 'Procedure',
      type: 'PROCEDURE',
      clauseIds: [],
      status: 'ACTIVE',
      currentRevisionId: null,
      ownerId: PERSON.sameer,
      approverId: PERSON.divya,
      reviewDueOn: '2024-10-01',
      lastReviewedOn: null,
      retention: null,
      issuer: null,
      externalRef: null,
    });
    seed(app, 'revisions', {
      ...base(),
      documentId: r.d2.id,
      revision: 'A',
      changeNote: 'First issue',
      state: 'IN_REVIEW',
      preparedById: PERSON.sameer,
      approvedById: null,
      approvedAt: null,
      sendBackReason: null,
    });
    seed(app, 'documents', {
      ...base(),
      managementSystemId: sid,
      code: 'QP-02',
      title: 'Old procedure',
      type: 'PROCEDURE',
      clauseIds: [],
      status: 'OBSOLETE',
      currentRevisionId: null,
      ownerId: PERSON.sameer,
      approverId: PERSON.divya,
      reviewDueOn: '2024-01-01',
      lastReviewedOn: null,
      retention: null,
      issuer: null,
      externalRef: null,
    });

    const current = programme(sid, '2024-25');
    r.A1 = audit(current.id, { ...reported('2024-10-15'), unitIds: [PUNE] });
    checked(r.A1.id, clause('ISO_9001', '4.1'));
    checked(r.A1.id, clause('ISO_9001', '4.2'), { unitId: BENGALURU });
    checked(r.A1.id, clause('ISO_9001', '5.1.1'), {
      result: 'NOT_AUDITED',
      notAuditedReason: 'No time',
    });
    for (const c of assessable('ISO_45001')) checked(r.A1.id, c.id);
    r.A2 = audit(current.id, { unitIds: [BENGALURU] });
    r.F1 = finding({ internalAuditId: r.A2.id });
    r.a7 = action('AUDIT_FINDING', r.F1.id);
    r.A3 = audit(current.id, { state: 'CANCELLED', cancelReason: 'Merged' });
    const previous = programme(sid, '2023-24');
    r.A4 = audit(previous.id, { ...reported('2024-02-01'), unitIds: [PUNE] });
    checked(r.A4.id, clause('ISO_14001', '4.1'));
    r.A5 = audit(previous.id, { ...reported('2023-11-15'), unitIds: [PUNE] });
    checked(r.A5.id, clause('ISO_14001', '4.2'));

    review(sid, ['ISO_9001', 'ISO_14001'], '2024-09-30', ['SIGNIFICANT_ASPECTS']);
    review(sid, ['ISO_9001'], '2024-03-31', ['PREVIOUS_ACTIONS']);

    r.C1 = cert(sid, 'ISO_9001', {
      certificateNumber: 'Q-1',
      issuedOn: '2022-01-10',
      expiresOn: '2025-01-09',
    });
    const visit = external(sid, ['ISO_9001', 'ISO_14001'], 'SURVEILLANCE_1', '2023-01-05');
    external(sid, ['ISO_9001'], 'SURVEILLANCE_1', '2023-03-01');
    r.F2 = finding({ externalAuditId: visit.id, type: 'OFI' });
    r.a8 = action('AUDIT_FINDING', r.F2.id);
    r.C2 = cert(sid, 'ISO_14001', {
      certificateNumber: 'E-1',
      issuedOn: '2024-03-01',
      expiresOn: '2027-02-28',
    });
    cert(sid, 'ISO_45001', {});
    r.C4 = cert(sid, 'ISO_45001', {
      certificateNumber: 'S-1',
      issuedOn: '2024-06-01',
      expiresOn: '2025-01-31',
      unitIds: [BENGALURU],
    });
  });

  it('scores clause readiness per standard and overall', async () => {
    const o = await overview(PERSON.meera, system.id);
    expect(o).toMatchObject({ managementSystemId: system.id, name: 'Overview system' });
    expect(o.standardIds).toEqual(ALL.map(S));
    const q = o.clauseReadiness.byStandard[0]!;
    expect(q.standardId).toBe(S('ISO_9001'));
    expect(q.implemented).toEqual([clause('ISO_9001', '4.1')]);
    expect(q.partial).toEqual([clause('ISO_9001', '4.2')]);
    expect(q.excluded).toEqual([clause('ISO_9001', '8.3.1')]);
    expect(q.naPending).toEqual([clause('ISO_9001', '8.3.2')]);
    const counted = assessable('ISO_9001').length - 1;
    expect(q.notStarted).toHaveLength(counted - 3);
    expect(q.score).toBe(Math.round((1.5 / counted) * 1000) / 10);
    const total = ALL.reduce((n, c) => n + assessable(c).length, 0) - 1;
    expect(o.clauseReadiness.overall.score).toBe(Math.round((1.5 / total) * 1000) / 10);
    expect(o.clauseReadiness.byStandard[2]!.score).toBe(0);
  });

  it('checks the certification gates from the records', async () => {
    const o = await overview(PERSON.meera, system.id);
    const q = gates(o, 'ISO_9001');
    expect(q.INTERNAL_AUDIT).toContain('5.1.1');
    expect(q.INTERNAL_AUDIT).not.toContain('4.1');
    expect(q.INTERNAL_AUDIT).not.toContain('4.2');
    expect(q.INTERNAL_AUDIT).not.toContain('8.3.1');
    expect(q.INTERNAL_AUDIT).not.toContain(PUNE);
    expect(q.MANAGEMENT_REVIEW).toEqual([]);
    expect(q.SCOPE).toEqual([]);
    expect(q.POLICY).toEqual([]);
    expect(q.OBJECTIVES).toEqual([]);
    expect(q.RISKS).toEqual([]);
    const e = gates(o, 'ISO_14001');
    expect(e.INTERNAL_AUDIT).not.toContain('4.1'); // reported 2024-02-01: within 12 months
    expect(e.INTERNAL_AUDIT).toContain('4.2'); // reported 2023-11-15: 12 months before as-of
    expect(e.MANAGEMENT_REVIEW).toEqual(['SIGNIFICANT_ASPECTS']);
    expect(e.OBJECTIVES).toEqual([r.o2!.id]);
    expect(e.RISKS).toEqual([]);
    const s = gates(o, 'ISO_45001');
    expect(s.INTERNAL_AUDIT).toEqual([]);
    expect(s.MANAGEMENT_REVIEW).toHaveLength(1);
    expect(s.POLICY).toEqual(['5.2']);
    expect(s.OBJECTIVES).toEqual([r.o3!.id]);
    expect(s.RISKS).toEqual([]);
    expect(o.certificationReadiness.standards.every((st) => !st.ready)).toBe(true);
    expect(o.climateGaps).toEqual([]);
  });

  it('counts records with the ids behind each number', async () => {
    const o = await overview(PERSON.meera, system.id);
    const ids = (c: { ids: string[] }) => [...c.ids].sort();
    const sorted = (...keys: string[]) => keys.map((k) => r[k]!.id).sort();
    expect(ids(o.nonconformities.open)).toEqual(sorted('n1', 'n2', 'n4', 'n5', 'n7'));
    expect(o.nonconformities.overdue.ids).toEqual([r.n1!.id]);
    expect(o.nonconformities.awaitingVerification.ids).toEqual([r.n2!.id]);
    expect(o.nonconformities.effectivenessOverdue.ids).toEqual([r.n2!.id]);
    expect(ids(o.actions.open)).toEqual(sorted('a1', 'a4', 'a5', 'a6', 'a7', 'a8'));
    expect(ids(o.actions.overdue)).toEqual(sorted('a1', 'a5'));
    expect(o.documents.inReview.ids).toEqual([r.d2!.id]);
    expect(o.documents.reviewOverdue.ids).toEqual([r.d2!.id]);
    expect(ids(o.risks.significant)).toEqual(sorted('r1', 'r3'));
    expect(o.risks.reviewOverdue.ids).toEqual([r.r1!.id]);
    expect(ids(o.objectives.open)).toEqual(sorted('o1', 'o2', 'o3', 'o5', 'o6', 'o7'));
    expect(ids(o.objectives.offTrack)).toEqual(sorted('o1', 'o5'));
    expect(o.auditProgramme).toMatchObject({ fy: '2024-25', uncoveredUnitIds: [] });
    expect(o.auditProgramme!.uncoveredClauseIds).toContain(clause('ISO_9001', '5.1.1'));
    expect(o.auditProgramme!.uncoveredClauseIds).not.toContain(clause('ISO_9001', '4.1'));
    expect(o.auditProgramme!.uncoveredClauseIds).not.toContain(clause('ISO_9001', '8.3.1'));
    expect(o.auditProgramme!.uncoveredClauseIds).toContain(clause('ISO_14001', '4.1'));
    expect(ids(o.auditProgramme!.planned)).toEqual(sorted('A1', 'A2'));
    expect(o.auditProgramme!.reported.ids).toEqual([r.A1!.id]);
    expect(o.auditProgramme!.cancelled.ids).toEqual([r.A3!.id]);
    expect(o.managementReview.items).toEqual([
      {
        standard: 'ISO_9001',
        lastHeldOn: '2024-09-30',
        nextDueOn: '2025-09-30',
        timing: 'ON_TIME',
        overdueDays: null,
      },
      expect.objectContaining({ standard: 'ISO_14001', lastHeldOn: '2024-09-30' }),
      {
        standard: 'ISO_45001',
        lastHeldOn: null,
        nextDueOn: '2025-11-15',
        timing: 'ON_TIME',
        overdueDays: null,
      },
    ]);
    expect(ids(o.certificates.expiringSoon)).toEqual(sorted('C1', 'C4'));
    expect(o.certificates.cycleOverdue.ids).toEqual([r.C1!.id]);
    expect(o.incidents).toMatchObject({ from: '2024-04-01', to: '2025-03-31' });
    expect(ids(o.incidents.total)).toEqual(sorted('n4', 'n5'));
    const byType = Object.fromEntries(o.incidents.byType.map((t) => [t.type, t.ids]));
    expect(byType).toMatchObject({ INJURY: [r.n4!.id], NEAR_MISS: [r.n5!.id], FIRE: [] });
    const byOutcome = Object.fromEntries(o.incidents.byOutcome.map((t) => [t.outcome, t.ids]));
    expect(byOutcome).toMatchObject({ FIRST_AID: [r.n4!.id], NONE: [r.n5!.id] });
  });

  it('counts only what an approver or owner of one unit may see', async () => {
    const o = await overview(PERSON.nisha, system.id);
    const ids = (c: { ids: string[] }) => [...c.ids].sort();
    const sorted = (...keys: string[]) => keys.map((k) => r[k]!.id).sort();
    // n5 is at Bengaluru but names nisha as investigator.
    expect(ids(o.nonconformities.open)).toEqual(sorted('n1', 'n4', 'n5', 'n7'));
    expect(o.nonconformities.awaitingVerification.ids).toEqual([]);
    expect(ids(o.actions.open)).toEqual(sorted('a1', 'a4', 'a6', 'a8'));
    expect(o.risks.significant.ids).toEqual([r.r1!.id]);
    expect(ids(o.auditProgramme!.planned)).toEqual([r.A1!.id]);
    expect(o.auditProgramme!.cancelled.ids).toEqual([r.A3!.id]);
    expect(o.certificates.expiringSoon.ids).toEqual([r.C1!.id]);
    expect(ids(o.incidents.total)).toEqual(sorted('n4', 'n5'));
    const rohan = await overview(PERSON.rohan, system.id);
    expect(ids(rohan.nonconformities.open)).toEqual(sorted('n1', 'n4', 'n7'));
    expect(ids(rohan.risks.significant)).toEqual([r.r1!.id]);

    const bengaluru = seedSystem(app, { unitIds: [BENGALURU] });
    const none = await ok<IsoOverview>(app, 'getIsoOverview', {
      as: PERSON.rohan,
      query: { managementSystemId: bengaluru.id },
    });
    expect(none.systems).toEqual([]);
  });

  it('takes an as-of date from firm roles and viewers only, and filters by system', async () => {
    const o = await overview(PERSON.vikram, system.id, { asOf: '2024-06-30' });
    expect(o.nonconformities.overdue.ids).toEqual([]);
    expect(o.certificates.expiringSoon.ids).toEqual([]);
    const later = await overview(PERSON.arjun, system.id, { asOf: '2025-01-15' });
    expect(later.incidents).toMatchObject({ from: '2024-04-01', to: '2025-03-31' });
    expect(later.auditProgramme!.fy).toBe('2024-25');
    expect(later.certificates.expiringSoon.ids).toEqual([r.C4!.id]);
    const result = await ok<IsoOverview>(app, 'getIsoOverview', {
      as: PERSON.meera,
      query: { asOf: '2024-06-30', managementSystemId: system.id },
    });
    expect(result.asOf).toBe('2024-06-30');
    await fails(
      app,
      'getIsoOverview',
      { as: PERSON.rohan, query: { asOf: '2024-06-30' } },
      'FORBIDDEN',
      403,
    );
    const other = seedSystem(app, { name: 'Overview other' });
    const both = await ok<IsoOverview>(app, 'getIsoOverview', {
      query: { managementSystemId: `${system.id},${other.id}` },
    });
    expect(both.systems.map((s) => s.managementSystemId)).toEqual([other.id, system.id]);
    const all = await ok<IsoOverview>(app, 'getIsoOverview', { as: PERSON.kabir });
    expect(all.asOf).toBe(TODAY);
    expect(all.systems.map((s) => s.managementSystemId)).toEqual(
      expect.arrayContaining([system.id, other.id]),
    );
    const harbour = await ok<IsoOverview>(app, 'getIsoOverview', {
      as: PERSON.joseph,
      params: { clientId: HARBOUR },
      query: { managementSystemId: system.id },
    });
    expect(harbour.systems).toEqual([]);
  });

  it('reports climate gaps, review due dates and missing gates for thin systems', async () => {
    const undecided = seedSystem(app, { standards: ['ISO_9001'] });
    const relevant = seedSystem(app, { standards: ['ISO_14001'], climateChangeRelevant: true });
    const notRelevant = seedSystem(app, { standards: ['ISO_45001'], climateChangeRelevant: false });
    const thin = await overview(PERSON.meera, undecided.id);
    expect(thin.climateGaps).toEqual(['UNDECIDED']);
    expect(gates(thin, 'ISO_9001')).toMatchObject({
      SCOPE: ['scopeStatement', 'unitIds'],
      POLICY: ['5.2'],
      OBJECTIVES: [expect.any(String)],
      RISKS: ['RISK', 'OPPORTUNITY'],
      MANAGEMENT_REVIEW: [expect.any(String)],
    });
    expect(thin.auditProgramme).toBeNull();
    expect(thin.incidents.total).toEqual({ count: 0, ids: [] });
    expect((await overview(PERSON.meera, relevant.id)).climateGaps).toEqual([
      'RELEVANT_NO_RISK',
      'RELEVANT_NO_ISSUE',
    ]);
    context(relevant.id, false);
    risk(relevant.id, 'ASPECT', { climateRelated: true });
    expect((await overview(PERSON.meera, relevant.id)).climateGaps).toEqual(['RELEVANT_NO_ISSUE']);
    expect(gates(await overview(PERSON.meera, relevant.id), 'ISO_14001').RISKS).toEqual([]);
    expect((await overview(PERSON.meera, notRelevant.id)).climateGaps).toEqual([]);
    expect(gates(await overview(PERSON.meera, notRelevant.id), 'ISO_45001').RISKS).toEqual([
      'HAZARD',
    ]);

    // A clause with no checklist row counts as not started.
    const row = rowOf(undecided.id, 'ISO_9001', '10.3');
    firm().iso.clauseAssessments.splice(firm().iso.clauseAssessments.indexOf(row), 1);
    expect(
      (await overview(PERSON.meera, undecided.id)).clauseReadiness.overall.notStarted,
    ).toContain(clause('ISO_9001', '10.3'));

    // Review due: from creation without a review, overdue and due soon.
    const old = seedSystem(app, { standards: ['ISO_9001'] });
    firm().iso.managementSystems.find((s) => s.id === old.id)!.createdAt = '2023-06-01T06:30:00Z';
    const soon = seedSystem(app, { standards: ['ISO_9001'] });
    firm().iso.managementSystems.find((s) => s.id === soon.id)!.createdAt = '2023-11-20T06:30:00Z';
    expect((await overview(PERSON.meera, old.id)).managementReview.items).toEqual([
      {
        standard: 'ISO_9001',
        lastHeldOn: null,
        nextDueOn: '2024-06-01',
        timing: 'OVERDUE',
        overdueDays: 167,
      },
    ]);
    expect((await overview(PERSON.meera, soon.id)).managementReview.items[0]).toMatchObject({
      nextDueOn: '2024-11-20',
      timing: 'DUE_SOON',
    });
  });

  it('marks a standard ready when every gate is met', async () => {
    const ready = seedSystem(app, {
      standards: ['ISO_14001'],
      unitIds: [PUNE],
      climateChangeRelevant: false,
    });
    const sid = ready.id;
    firm().iso.managementSystems.find((s) => s.id === sid)!.scopeStatement = 'Pune plant.';
    const p = programme(sid, '2024-25');
    const a = audit(p.id, { ...reported('2024-11-01'), unitIds: [PUNE] });
    for (const c of assessable('ISO_14001')) checked(a.id, c.id);
    review(sid, ['ISO_14001'], '2024-10-30');
    policy(sid, ['ISO_14001']);
    const o = objective(sid, { standards: ['ISO_14001'] });
    action('OBJECTIVE', o.id);
    risk(sid, 'ASPECT');
    const result = await overview(PERSON.meera, sid);
    expect(result.certificationReadiness.standards).toEqual([
      expect.objectContaining({ standardId: S('ISO_14001'), ready: true }),
    ]);
    expect(result.auditProgramme).toMatchObject({ uncoveredClauseIds: [], uncoveredUnitIds: [] });
  });
});
