// The mock's ISO internal audits (docs/iso/model.md §3.7, §3.9, §4.3, §5.1, §6): audit programmes with their coverage,
// internal audits and their machine, checklists, findings that raise nonconformities, unit scope (plan §3.3), the
// role matrix (plan §3.2) and the audit trail (model §8).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditProgrammeView, InternalAuditView } from '../src/api/iso.js';
import { fixtureId } from '../src/fixtures/index.js';
import { addDays } from '../src/mock/iso/common.js';
import type { IsoRow } from '../src/mock/store.js';
import { type AuditChecklistItem, type AuditFinding, Nonconformity } from '../src/schemas/iso.js';
import {
  type App,
  base,
  BENGALURU,
  call,
  called,
  CHENNAI,
  clause,
  fails,
  firmB,
  HARBOUR,
  type Id,
  isoApp,
  isoEvents,
  NORTHWIND,
  NOW,
  ok,
  PERSON,
  PUNE,
  seed,
  seedSystem,
  TODAY,
} from './iso-harness.js';

type Prog = AuditProgrammeView;
type Audit = InternalAuditView;
type Item = AuditChecklistItem;
type Finding = AuditFinding;
type System = IsoRow<'managementSystems'>;

const FY = '2024-25';
const C = (number: string) => clause('ISO_9001', number);
const ISHAAN = fixtureId('firm-b:person:ishaan'); // OWNER, Northwind Bengaluru only

let app: App;
/** Northwind on ISO 9001 over Pune and Bengaluru, with a 2024-25 programme. */
let sys: System;
let programme: Prog;

beforeAll(async () => {
  app = await isoApp();
  sys = seedSystem(app, { standards: ['ISO_9001'], unitIds: [PUNE, BENGALURU] });
  programme = await createProgramme(sys);
});
afterAll(async () => {
  await app.close();
});

// ---------- helpers ----------

function createProgramme(system: System, fy = FY, as: string = PERSON.meera): Promise<Prog> {
  return ok<Prog>(app, 'createIsoAuditProgramme', {
    as,
    params: { clientId: system.clientId },
    body: { managementSystemId: system.id, fy },
  });
}

/** An audit of the Pune plant on clauses 4.1 and 7.2: sameer leads, rohan audits, nisha is audited, kabir hears. */
const auditBody = (prog: Prog, body: Record<string, unknown> = {}) => ({
  programmeId: prog.id,
  title: 'Pune plant audit',
  plannedStart: addDays(TODAY, 7),
  plannedEnd: addDays(TODAY, 8),
  clauseIds: [C('4.1'), C('7.2')],
  unitIds: [PUNE],
  leadAuditorId: PERSON.sameer,
  auditorIds: [PERSON.rohan],
  auditeeIds: [PERSON.nisha],
  reportedToIds: [PERSON.kabir],
  ...body,
});

const createAudit = (
  prog: Prog = programme,
  body: Record<string, unknown> = {},
  as: string = PERSON.meera,
) =>
  ok<Audit>(app, 'createIsoInternalAudit', {
    as,
    params: { clientId: prog.clientId },
    body: auditBody(prog, body),
  });

const at = (a: { clientId: string; id: string }, extra: Record<string, string> = {}) => ({
  clientId: a.clientId,
  id: a.id,
  ...extra,
});

const getAudit = (a: Audit, as: string = PERSON.meera) =>
  ok<Audit>(app, 'getIsoInternalAudit', { as, params: at(a) });

const step = (
  id: 'startIsoInternalAudit' | 'closeIsoInternalAudit',
  a: Audit,
  as: string = PERSON.sameer,
) => ok<Audit>(app, id, { as, params: at(a), body: { version: a.version } });
const start = (a: Audit, as?: string) => step('startIsoInternalAudit', a, as);
const close = (a: Audit, as?: string) => step('closeIsoInternalAudit', a, as);

const report = (a: Audit, body: Record<string, unknown> = {}, as: string = PERSON.sameer) =>
  ok<Audit>(app, 'reportIsoInternalAudit', {
    as,
    params: at(a),
    body: { version: a.version, summary: 'The plant follows its procedures.', ...body },
  });

const cancel = (a: Audit, as: string = PERSON.kabir) =>
  ok<Audit>(app, 'cancelIsoInternalAudit', {
    as,
    params: at(a),
    body: { version: a.version, reason: 'Moved to next quarter' },
  });

const addRow = (
  a: Audit,
  clauseId: string,
  body: Record<string, unknown> = {},
  as: string = PERSON.sameer,
) =>
  ok<Item>(app, 'createIsoAuditChecklistItem', {
    as,
    params: at(a),
    body: { clauseId, question: 'Is it in place?', ...body },
  });

const answer = (a: Audit, item: Item, body: Record<string, unknown>, as: string = PERSON.sameer) =>
  ok<Item>(app, 'updateIsoAuditChecklistItem', {
    as,
    params: at(a, { itemId: item.id }),
    body: { version: item.version, ...body },
  });

const checklist = (a: Audit, as: string = PERSON.meera) =>
  ok<{ items: Item[] }>(app, 'listIsoAuditChecklist', { as, params: at(a) });

const addFinding = (a: Audit, body: Record<string, unknown> = {}, as: string = PERSON.sameer) =>
  ok<Finding>(app, 'createIsoInternalFinding', {
    as,
    params: at(a),
    body: { type: 'OBSERVATION', description: 'Training records are kept on paper.', ...body },
  });

const findings = (a: Audit, as: string = PERSON.meera) =>
  ok<{ items: Finding[] }>(app, 'listIsoInternalFindings', { as, params: at(a) });

const NC_BODY = { ownerId: PERSON.sameer, approverId: PERSON.divya, dueOn: addDays(TODAY, 30) };

/** An audit started by its lead, with a CONFORMS row for each of its clauses. */
async function answered(prog: Prog = programme, body: Record<string, unknown> = {}) {
  const a = await start(await createAudit(prog, body));
  for (const clauseId of a.clauseIds) {
    await answer(a, await addRow(a, clauseId), { result: 'CONFORMS' });
  }
  return getAudit(a);
}

const reported = async (prog?: Prog, body?: Record<string, unknown>) =>
  report(await answered(prog, body));

const ncOf = (finding: Finding) =>
  firmB(app).iso.nonconformities.find((n) => n.id === finding.nonconformityId)!;

const lastEvent = (id: string) => isoEvents(app, id).at(-1)!;

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

// ---------- programmes ----------

describe('audit programmes', () => {
  it('creates one programme per system and FY, with its coverage, and audits it', async () => {
    const system = seedSystem(app, { standards: ['ISO_9001'] });
    const created = await createProgramme(system, FY, PERSON.kabir);
    expect(created).toMatchObject({ managementSystemId: system.id, fy: FY, notes: null });
    expect(created.coverage.fy).toBe(FY);
    expect(isoEvents(app, created.id)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        entityType: 'audit_programme',
        actorId: PERSON.kabir,
        after: { managementSystemId: system.id, fy: FY, notes: null },
      }),
    ]);
    const clash = await fails(
      app,
      'createIsoAuditProgramme',
      { params: { clientId: NORTHWIND }, body: { managementSystemId: system.id, fy: FY } },
      'DUPLICATE',
      409,
    );
    expect(clash.error.details).toEqual({ field: 'fy', existingId: created.id });
    // Another FY of the same system is another programme.
    await createProgramme(system, '2025-26', PERSON.arjun);
  });

  it('lets FA, CO and CA create programmes, nobody else, and only for a system of the client', async () => {
    const system = seedSystem(app, { standards: ['ISO_9001'] });
    for (const as of [PERSON.divya, PERSON.sameer, PERSON.vikram]) {
      await fails(
        app,
        'createIsoAuditProgramme',
        { as, params: { clientId: NORTHWIND }, body: { managementSystemId: system.id, fy: FY } },
        'FORBIDDEN',
        403,
      );
    }
    const harbour = seedSystem(app, { clientId: HARBOUR, standards: ['ISO_9001'] });
    await fails(
      app,
      'createIsoAuditProgramme',
      { params: { clientId: NORTHWIND }, body: { managementSystemId: harbour.id, fy: FY } },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'createIsoAuditProgramme',
      {
        as: PERSON.arjun,
        params: { clientId: HARBOUR },
        body: { managementSystemId: harbour.id, fy: FY },
      },
      'NOT_FOUND',
      404,
    );
    await createProgramme(harbour, FY, PERSON.leela);
  });

  it("changes a programme's notes, audited, with the version check", async () => {
    const prog = await createProgramme(seedSystem(app, { standards: ['ISO_9001'] }));
    const update = (as: string, version: number, notes: string | null) =>
      call(app, 'updateIsoAuditProgramme', {
        as,
        params: at(prog),
        body: { version, notes },
      });
    const changed = await ok<Prog>(app, 'updateIsoAuditProgramme', {
      as: PERSON.kabir,
      params: at(prog),
      body: { version: 1, notes: 'Two audits a year per plant.' },
    });
    expect(changed).toMatchObject({ version: 2, notes: 'Two audits a year per plant.' });
    expect(lastEvent(prog.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'audit_programme',
      before: { notes: null },
      after: { notes: 'Two audits a year per plant.' },
    });
    expect((await update(PERSON.meera, 1, 'Stale')).status).toBe(409);
    // The same notes again change nothing.
    const same = await ok<Prog>(app, 'updateIsoAuditProgramme', {
      params: at(prog),
      body: { version: 2, notes: 'Two audits a year per plant.' },
    });
    expect(same.version).toBe(2);
    expect(isoEvents(app, prog.id)).toHaveLength(2);
    for (const as of [PERSON.divya, PERSON.sameer, PERSON.vikram]) {
      expect((await update(as, 2, null)).status).toBe(403);
    }
    await fails(
      app,
      'updateIsoAuditProgramme',
      { params: { clientId: HARBOUR, id: prog.id }, body: { version: 2, notes: null } },
      'NOT_FOUND',
      404,
    );
  });

  it('lists programmes newest FY first, by filter, within unit scope', async () => {
    const blr = seedSystem(app, { standards: ['ISO_9001'], unitIds: [BENGALURU] });
    const older = await createProgramme(blr, '2023-24');
    const newer = await createProgramme(blr, FY);
    const list = (as: string, query: Record<string, string> = {}) =>
      ok<{ items: Prog[]; nextCursor: string | null; total?: number }>(
        app,
        'listIsoAuditProgrammes',
        { as, query: { managementSystemId: blr.id, ...query } },
      );
    expect(ids((await list(PERSON.meera)).items)).toEqual([newer.id, older.id]);
    expect(ids((await list(PERSON.meera, { fy: '2023-24' })).items)).toEqual([older.id]);
    for (const as of [PERSON.sameer, PERSON.divya, PERSON.vikram, ISHAAN]) {
      expect((await list(as)).items).toHaveLength(2);
    }
    // A Bengaluru-only system's programmes are outside the Pune-only approver's and owner's units.
    for (const as of [PERSON.nisha, PERSON.rohan]) expect((await list(as)).items).toEqual([]);
    const paged = await list(PERSON.meera, { limit: '1', count: 'true' });
    expect(paged).toMatchObject({ total: 2, items: [{ id: newer.id }] });
    expect(paged.nextCursor).not.toBeNull();
    const all = await ok<{ items: Prog[] }>(app, 'listIsoAuditProgrammes', {
      query: { fy: FY },
    });
    expect(ids(all.items)).toEqual(expect.arrayContaining([programme.id, newer.id]));
  });
});

// ---------- coverage ----------

describe('audit programme coverage', () => {
  it('counts clauses and units covered by reported audits, and the audits by state', async () => {
    const cov = seedSystem(app, { standards: ['ISO_9001'], unitIds: [PUNE, BENGALURU] });
    const prog = await createProgramme(cov);
    const coverage = async (as: string = PERSON.meera) =>
      (
        await ok<{ items: Prog[] }>(app, 'listIsoAuditProgrammes', {
          as,
          query: { managementSystemId: cov.id },
        })
      ).items[0]!.coverage;
    const assessable = firmB(app).isoCatalogue.clauses.filter(
      (c) => c.assessable && c.standardId === cov.standardIds[0],
    );
    const first = await coverage();
    expect(first.uncoveredClauseIds).toHaveLength(assessable.length);
    expect(first.uncoveredClauseIds.slice(0, 3)).toEqual([C('4.1'), C('4.2'), C('4.3')]);
    expect(first.uncoveredUnitIds).toEqual([PUNE, BENGALURU]);
    expect(first.planned).toEqual({ count: 0, ids: [] });

    // An approved N/A on a clause that allows exclusion needs no coverage.
    const row = firmB(app).iso.clauseAssessments.find(
      (r) => r.managementSystemId === cov.id && r.clauseId === C('8.3.1'),
    )!;
    Object.assign(row, {
      status: 'NOT_APPLICABLE',
      justification: 'No design work.',
      naState: 'APPROVED',
      statusBeforeNa: 'NOT_STARTED',
      naRequestedById: PERSON.sameer,
      naDecidedById: PERSON.divya,
      naDecidedAt: '2024-11-01T06:30:00Z',
    });
    expect((await coverage()).uncoveredClauseIds).not.toContain(C('8.3.1'));

    // A: Pune, rows on 4.1 (CONFORMS, no unit), 4.2 (FINDING) and 4.3 (NOT_AUDITED, covers nothing).
    const a = await start(
      await createAudit(prog, { clauseIds: [C('4.1'), C('4.2'), C('4.3')], unitIds: [PUNE] }),
    );
    await answer(a, await addRow(a, C('4.1')), { result: 'CONFORMS' });
    await addFinding(a, { checklistItemId: (await addRow(a, C('4.2'))).id });
    await answer(a, await addRow(a, C('4.3')), {
      result: 'NOT_AUDITED',
      notAuditedReason: 'Line stopped',
    });
    // Not reported yet: nothing is covered.
    expect((await coverage()).uncoveredClauseIds).toContain(C('4.1'));
    const aDone = await report(await getAudit(a));
    let now = await coverage();
    expect(now.uncoveredClauseIds).not.toContain(C('4.1'));
    expect(now.uncoveredClauseIds).not.toContain(C('4.2'));
    expect(now.uncoveredClauseIds).toContain(C('4.3'));
    expect(now.uncoveredUnitIds).toEqual([BENGALURU]);

    // D: no units of its own, so its unit-less row covers its clause but no unit.
    const d = await reported(prog, { clauseIds: [C('4.4.1')], unitIds: [] });
    now = await coverage();
    expect(now.uncoveredClauseIds).not.toContain(C('4.4.1'));
    expect(now.uncoveredUnitIds).toEqual([BENGALURU]);

    // B: Bengaluru only, naming neither nisha nor rohan; its row names the unit.
    const b = await start(
      await createAudit(prog, {
        title: 'Bengaluru office audit',
        clauseIds: [C('4.4.2')],
        unitIds: [BENGALURU],
        auditorIds: [],
        auditeeIds: [PERSON.divya],
      }),
    );
    await answer(b, await addRow(b, C('4.4.2'), { unitId: BENGALURU }), { result: 'CONFORMS' });
    expect((await coverage()).uncoveredUnitIds).toEqual([BENGALURU]);
    const bDone = await report(await getAudit(b));
    now = await coverage();
    expect(now.uncoveredUnitIds).toEqual([]);
    expect(now.uncoveredClauseIds).not.toContain(C('4.4.2'));

    // C: cancelled.
    const c = await cancel(await createAudit(prog, { clauseIds: [] }));
    now = await coverage();
    expect(now.planned.ids.sort()).toEqual([aDone.id, d.id, bDone.id].sort());
    expect(now.reported.ids.sort()).toEqual([aDone.id, d.id, bDone.id].sort());
    expect(now.cancelled).toEqual({ count: 1, ids: [c.id] });

    // The counts are of the audits the actor sees: B is outside nisha's units and does not name her.
    const nisha = await coverage(PERSON.nisha);
    expect(nisha.planned.ids).not.toContain(bDone.id);
    expect(nisha.planned.ids).toContain(aDone.id);
    expect(nisha.uncoveredUnitIds).toEqual([]);
  });
});

// ---------- planning ----------

describe('planning an internal audit', () => {
  it('plans an audit in a programme, audited with its plan', async () => {
    const a = await createAudit(programme, {}, PERSON.kabir);
    expect(a).toMatchObject({
      programmeId: programme.id,
      managementSystemId: sys.id,
      state: 'PLANNED',
      summary: null,
      reportedOn: null,
      cancelReason: null,
      independenceNote: null,
      version: 1,
      allowedActions: ['START', 'CANCEL'],
    });
    expect(isoEvents(app, a.id)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        entityType: 'internal_audit',
        actorId: PERSON.kabir,
        after: expect.objectContaining({
          programmeId: programme.id,
          leadAuditorId: PERSON.sameer,
          auditorIds: [PERSON.rohan],
          state: 'PLANNED',
        }),
      }),
    ]);
    await createAudit(programme, {}, PERSON.arjun);
    for (const as of [PERSON.divya, PERSON.nisha, PERSON.sameer, PERSON.vikram]) {
      await fails(
        app,
        'createIsoInternalAudit',
        { as, params: { clientId: NORTHWIND }, body: auditBody(programme) },
        'FORBIDDEN',
        403,
      );
    }
  });

  it('needs an independence note when an auditor is also an auditee, and records it', async () => {
    const body = auditBody(programme, { auditeeIds: [PERSON.rohan] });
    const refused = await fails(
      app,
      'createIsoInternalAudit',
      { params: { clientId: NORTHWIND }, body },
      'VALIDATION',
      400,
    );
    expect(JSON.stringify(refused.error.details)).toContain('independenceNote');
    const note = 'Rohan audits the stores, which he does not run.';
    const a = await createAudit(programme, { auditeeIds: [PERSON.rohan], independenceNote: note });
    expect(a.independenceNote).toBe(note);
    expect(isoEvents(app, a.id)[0]!.after).toMatchObject({ independenceNote: note });
  });

  it('refuses a plan that names wrong units, clauses, people or programme', async () => {
    const refuse = (body: Record<string, unknown>, code = 'VALIDATION', status = 400) =>
      fails(
        app,
        'createIsoInternalAudit',
        { params: { clientId: NORTHWIND }, body: auditBody(programme, body) },
        code,
        status,
      );
    await refuse({ auditorIds: [PERSON.sameer] });
    await refuse({ plannedEnd: addDays(TODAY, 6) });
    await refuse({ unitIds: [CHENNAI] });
    await refuse({ clauseIds: [clause('ISO_14001', '6.1.2')] });
    await refuse({ auditeeIds: [PERSON.joseph] });
    await refuse({ auditorIds: [PERSON.vikram] });
    await refuse({ reportedToIds: [PERSON.gita] });
    await refuse({ leadAuditorId: PERSON.priya });
    await refuse({ programmeId: '00000000-0000-4000-8000-ffffffffffff' }, 'NOT_FOUND', 404);
    const harbourProg = await createProgramme(
      seedSystem(app, { clientId: HARBOUR, standards: ['ISO_9001'] }),
      '2023-24',
    );
    await refuse({ programmeId: harbourProg.id }, 'NOT_FOUND', 404);
  });

  it('shows each reader the actions they may take, within unit scope', async () => {
    const a = await createAudit();
    const actions = async (as: string) => (await getAudit(a, as)).allowedActions;
    expect(await actions(PERSON.meera)).toEqual(['START', 'CANCEL']);
    expect(await actions(PERSON.sameer)).toEqual(['START']);
    expect(await actions(PERSON.rohan)).toEqual(['START']);
    expect(await actions(PERSON.nisha)).toEqual([]);
    expect(await actions(PERSON.divya)).toEqual([]);
    expect(await actions(PERSON.vikram)).toEqual([]);

    const blr = await createAudit(programme, {
      unitIds: [BENGALURU],
      leadAuditorId: PERSON.divya,
      auditorIds: [],
      auditeeIds: [],
    });
    expect((await getAudit(blr, PERSON.divya)).allowedActions).toEqual(['START']);
    await getAudit(blr, ISHAAN);
    for (const as of [PERSON.nisha, PERSON.rohan]) {
      await fails(app, 'getIsoInternalAudit', { as, params: at(blr) }, 'NOT_FOUND', 404);
    }
    // Named on it, nisha sees it after all.
    const named = await createAudit(programme, {
      unitIds: [BENGALURU],
      auditorIds: [],
      auditeeIds: [],
      reportedToIds: [PERSON.nisha],
    });
    expect((await getAudit(named, PERSON.nisha)).id).toBe(named.id);
    await fails(
      app,
      'getIsoInternalAudit',
      { params: { clientId: HARBOUR, id: a.id } },
      'NOT_FOUND',
      404,
    );
  });

  it('edits a PLANNED or IN_PROGRESS audit, auditing dates, lead and lists apart', async () => {
    const a = await createAudit();
    const edit = (body: Record<string, unknown>, as: string = PERSON.kabir, version?: number) =>
      call(app, 'updateIsoInternalAudit', {
        as,
        params: at(a),
        body: {
          version: version ?? firmB(app).iso.internalAudits.find((r) => r.id === a.id)!.version,
          ...body,
        },
      });
    const moved = await ok<Audit>(app, 'updateIsoInternalAudit', {
      as: PERSON.kabir,
      params: at(a),
      body: {
        version: 1,
        plannedStart: addDays(TODAY, 10),
        plannedEnd: addDays(TODAY, 11),
        title: 'Pune plant audit, second visit',
        reason: 'The plant asked for a later date',
      },
    });
    expect(moved).toMatchObject({ version: 2, plannedStart: addDays(TODAY, 10) });
    const [dates, fields] = isoEvents(app, a.id).slice(-2);
    expect(dates).toMatchObject({
      action: 'DUE_DATE_CHANGE',
      before: { plannedStart: addDays(TODAY, 7), plannedEnd: addDays(TODAY, 8) },
      after: { plannedStart: addDays(TODAY, 10), plannedEnd: addDays(TODAY, 11) },
      reason: 'The plant asked for a later date',
    });
    expect(fields).toMatchObject({
      action: 'UPDATE',
      after: { title: 'Pune plant audit, second visit' },
      reason: null,
    });

    // Moving a date needs a reason.
    expect((await edit({ plannedEnd: addDays(TODAY, 12) })).status).toBe(422);

    // A new lead is a reassignment, with its reason; the lists are an UPDATE on the audit.
    const relead = await edit({
      leadAuditorId: PERSON.divya,
      auditeeIds: [PERSON.sameer],
      reason: 'Sameer is now audited',
    });
    expect(relead.status).toBe(200);
    const [lead, lists] = isoEvents(app, a.id).slice(-2);
    expect(lead).toMatchObject({
      action: 'REASSIGN',
      before: { leadAuditorId: PERSON.sameer },
      after: { leadAuditorId: PERSON.divya },
      reason: 'Sameer is now audited',
    });
    expect(lists).toMatchObject({
      action: 'UPDATE',
      after: { auditeeIds: [PERSON.sameer] },
      reason: null,
    });

    // Nothing changed: no event, no new version.
    const count = isoEvents(app, a.id).length;
    const same = await edit({ title: 'Pune plant audit, second visit' });
    expect(same.json).toMatchObject({ version: 3 });
    expect(isoEvents(app, a.id)).toHaveLength(count);

    // The merged plan keeps the stored rules.
    expect((await edit({ auditeeIds: [PERSON.rohan] })).status).toBe(400);
    expect((await edit({ auditorIds: [PERSON.divya] })).status).toBe(400);
    expect((await edit({ plannedEnd: addDays(TODAY, 9), reason: 'Shorter visit' })).status).toBe(
      400,
    );
    expect((await edit({ unitIds: [CHENNAI] })).status).toBe(400);
    expect((await edit({ clauseIds: [clause('ISO_45001', '5.4')] })).status).toBe(400);
    expect((await edit({ reportedToIds: [PERSON.joseph] })).status).toBe(400);
    const noted = await edit({
      auditeeIds: [PERSON.rohan],
      independenceNote: 'Rohan audits another line.',
    });
    expect(noted.status).toBe(200);
    expect((await edit({ independenceNote: null })).status).toBe(400);
    expect((await edit({ title: 'Stale' }, PERSON.kabir, 1)).status).toBe(409);
    for (const as of [PERSON.sameer, PERSON.divya, PERSON.vikram]) {
      expect((await edit({ title: 'Not mine' }, as)).status).toBe(403);
    }
    expect(
      (await edit({ clauseIds: [C('4.1')], unitIds: [PUNE, BENGALURU] }, PERSON.meera)).status,
    ).toBe(200);
  });

  it('needs a reason to move a planned date or change the lead, and records it (decision 51 p)', async () => {
    const a = await createAudit();
    const version = () => firmB(app).iso.internalAudits.find((r) => r.id === a.id)!.version;
    const changes: [Record<string, unknown>, 'DUE_DATE_CHANGE' | 'REASSIGN'][] = [
      [{ plannedStart: addDays(TODAY, 6) }, 'DUE_DATE_CHANGE'],
      [{ plannedEnd: addDays(TODAY, 9) }, 'DUE_DATE_CHANGE'],
      [{ leadAuditorId: PERSON.divya }, 'REASSIGN'],
    ];
    for (const [change, action] of changes) {
      const count = isoEvents(app, a.id).length;
      for (const reason of [undefined, '   ']) {
        await fails(
          app,
          'updateIsoInternalAudit',
          {
            as: PERSON.kabir,
            params: at(a),
            body: { version: version(), ...change, ...(reason === undefined ? {} : { reason }) },
          },
          'REASON_REQUIRED',
          422,
        );
      }
      // Refused: nothing changed and nothing was audited.
      expect(isoEvents(app, a.id)).toHaveLength(count);
      const reason = `Agreed with the plant: ${Object.keys(change)[0]}`;
      await ok<Audit>(app, 'updateIsoInternalAudit', {
        as: PERSON.kabir,
        params: at(a),
        body: { version: version(), ...change, reason },
      });
      expect(isoEvents(app, a.id)).toHaveLength(count + 1);
      expect(lastEvent(a.id)).toMatchObject({ action, after: change, reason });
    }
    // Other fields need none, and their UPDATE carries none even when one is sent.
    await ok<Audit>(app, 'updateIsoInternalAudit', {
      as: PERSON.kabir,
      params: at(a),
      body: { version: version(), title: 'Pune plant audit, renamed' },
    });
    expect(lastEvent(a.id)).toMatchObject({ action: 'UPDATE', reason: null });
    await ok<Audit>(app, 'updateIsoInternalAudit', {
      as: PERSON.kabir,
      params: at(a),
      body: { version: version(), reportedToIds: [PERSON.divya], reason: 'Divya chairs reviews' },
    });
    expect(lastEvent(a.id)).toMatchObject({
      action: 'UPDATE',
      after: { reportedToIds: [PERSON.divya] },
      reason: null,
    });
  });

  it('allows edits while IN_PROGRESS and locks them once REPORTED', async () => {
    const a = await answered(programme, { unitIds: [PUNE, BENGALURU] });
    const row = (await checklist(a)).items[0]!;
    const narrowed = await answer(a, row, { unitId: BENGALURU });
    // The audit cannot drop a unit a row or finding is on.
    const stranded = await fails(
      app,
      'updateIsoInternalAudit',
      { params: at(a), body: { version: a.version, unitIds: [PUNE] } },
      'VALIDATION',
      400,
    );
    expect(stranded.error.details).toMatchObject({ issues: [{ path: ['body', 'unitIds'] }] });
    await answer(a, narrowed, { unitId: null });
    const edited = await ok<Audit>(app, 'updateIsoInternalAudit', {
      params: at(a),
      body: { version: a.version, reportedToIds: [PERSON.kabir, PERSON.divya], unitIds: [PUNE] },
    });
    expect(edited).toMatchObject({ state: 'IN_PROGRESS', unitIds: [PUNE] });
    const done = await report(edited);
    const refused = await fails(
      app,
      'updateIsoInternalAudit',
      { params: at(done), body: { version: done.version, title: 'Too late' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(refused.error.details).toEqual({
      entity: 'internal_audit',
      from: 'REPORTED',
      action: 'UPDATE',
    });
  });
});

// ---------- the machine ----------

describe('the internal audit machine', () => {
  it('STARTs by the lead, or by an auditor or manager as delegate', async () => {
    const byLead = await start(await createAudit());
    expect(byLead).toMatchObject({ state: 'IN_PROGRESS', version: 2, allowedActions: ['REPORT'] });
    expect(lastEvent(byLead.id)).toMatchObject({
      action: 'TRANSITION',
      entityType: 'internal_audit',
      before: { state: 'PLANNED' },
      after: { action: 'START', state: 'IN_PROGRESS' },
      reason: null,
    });
    expect(lastEvent(byLead.id).after).not.toHaveProperty('delegated');
    for (const as of [PERSON.rohan, PERSON.kabir, PERSON.arjun]) {
      const a = await start(await createAudit(), as);
      expect(lastEvent(a.id).after).toMatchObject({ action: 'START', delegated: true });
    }
    const refused = await fails(
      app,
      'startIsoInternalAudit',
      { as: PERSON.sameer, params: at(byLead), body: { version: byLead.version } },
      'INVALID_TRANSITION',
      409,
    );
    expect(refused.error.details).toEqual({
      entity: 'internal_audit',
      from: 'IN_PROGRESS',
      action: 'START',
    });
  });

  it('refuses START to people not leading or auditing it, out of scope, or on a stale version', async () => {
    const a = await createAudit();
    for (const as of [PERSON.nisha, PERSON.divya, PERSON.vikram]) {
      await fails(
        app,
        'startIsoInternalAudit',
        { as, params: at(a), body: { version: 1 } },
        'FORBIDDEN',
        403,
      );
    }
    const blr = await createAudit(programme, {
      unitIds: [BENGALURU],
      auditorIds: [],
      auditeeIds: [],
    });
    await fails(
      app,
      'startIsoInternalAudit',
      { as: PERSON.rohan, params: at(blr), body: { version: 1 } },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'startIsoInternalAudit',
      { params: at(a), body: { version: 2 } },
      'STALE_VERSION',
      409,
    );
  });

  it('REPORTs with a summary, people reported to and an answered row for every clause', async () => {
    const a = await start(await createAudit(programme, { reportedToIds: [] }));
    const refuse = async (body: Record<string, unknown>, as: string = PERSON.sameer) => {
      const current = await getAudit(a);
      return fails(
        app,
        'reportIsoInternalAudit',
        { as, params: at(a), body: { version: current.version, summary: 'Done.', ...body } },
        'VALIDATION',
        400,
      );
    };
    expect(JSON.stringify((await refuse({ reportedToIds: [PERSON.kabir] })).error)).toContain(
      '4.1, 7.2',
    );
    const first = await addRow(a, C('4.1'));
    await answer(a, await addRow(a, C('7.2')), {
      result: 'NOT_AUDITED',
      notAuditedReason: 'No training this quarter',
    });
    // 4.1 has a row, but not an answered one.
    expect(JSON.stringify((await refuse({ reportedToIds: [PERSON.kabir] })).error)).toContain(
      'clause 4.1',
    );
    await answer(a, first, { result: 'CONFORMS' });
    await refuse({});
    await refuse({ reportedToIds: [PERSON.vikram] });
    await refuse({ reportedToIds: [PERSON.kabir], reportedOn: addDays(TODAY, 1) });
    for (const as of [PERSON.divya, PERSON.nisha, PERSON.vikram]) {
      await fails(
        app,
        'reportIsoInternalAudit',
        { as, params: at(a), body: { version: 4, summary: 'Done.' } },
        'FORBIDDEN',
        403,
      );
    }
    const current = await getAudit(a);
    const done = await report(current, {
      reportedToIds: [PERSON.kabir, PERSON.divya],
      reportedOn: addDays(TODAY, -1),
    });
    expect(done).toMatchObject({
      state: 'REPORTED',
      summary: 'The plant follows its procedures.',
      reportedOn: addDays(TODAY, -1),
      reportedToIds: [PERSON.kabir, PERSON.divya],
      allowedActions: ['CLOSE'],
    });
    expect(lastEvent(a.id)).toMatchObject({
      action: 'TRANSITION',
      before: { state: 'IN_PROGRESS', summary: null, reportedOn: null, reportedToIds: [] },
      after: { action: 'REPORT', state: 'REPORTED', reportedOn: addDays(TODAY, -1) },
    });
    const again = await fails(
      app,
      'reportIsoInternalAudit',
      { params: at(done), body: { version: done.version, summary: 'Again.' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(again.error.details).toMatchObject({ from: 'REPORTED', action: 'REPORT' });
  });

  it('REPORTs on today by default, keeping the people it names, and marks a manager as delegate', async () => {
    const a = await answered();
    const done = await report(a, {}, PERSON.meera);
    expect(done).toMatchObject({ reportedOn: TODAY, reportedToIds: [PERSON.kabir] });
    expect(lastEvent(a.id).after).toMatchObject({ action: 'REPORT', delegated: true });
    expect(lastEvent(a.id).after).not.toHaveProperty('reportedToIds');
    await fails(
      app,
      'reportIsoInternalAudit',
      {
        params: at(await createAudit()),
        body: { version: 1, summary: 'Not started.' },
      },
      'INVALID_TRANSITION',
      409,
    );
  });

  it('CLOSEs a REPORTED audit once every nonconformity it raised has left OPEN', async () => {
    const a = await answered();
    const finding = await addFinding(a, { type: 'MINOR_NC', nonconformity: NC_BODY });
    const done = await report(await getAudit(a));
    const refused = await fails(
      app,
      'closeIsoInternalAudit',
      { as: PERSON.sameer, params: at(done), body: { version: done.version } },
      'VALIDATION',
      400,
    );
    expect(refused.error.details).toMatchObject({
      issues: [{ path: ['body', 'nonconformities'] }],
    });
    Object.assign(ncOf(finding), { state: 'CANCELLED', cancelReason: 'Raised twice' });
    const closed = await close(done);
    expect(closed).toMatchObject({ state: 'CLOSED', allowedActions: [] });
    expect(lastEvent(a.id)).toMatchObject({
      action: 'TRANSITION',
      before: { state: 'REPORTED' },
      after: { action: 'CLOSE', state: 'CLOSED' },
    });
    expect(lastEvent(a.id).after).not.toHaveProperty('delegated');
    await fails(
      app,
      'closeIsoInternalAudit',
      { params: at(closed), body: { version: closed.version } },
      'INVALID_TRANSITION',
      409,
    );
    const inProgress = await start(await createAudit());
    await fails(
      app,
      'closeIsoInternalAudit',
      { params: at(inProgress), body: { version: inProgress.version } },
      'INVALID_TRANSITION',
      409,
    );
  });

  it('lets the client admin CLOSE in their own right, and auditors and other managers as delegates', async () => {
    const byAdmin = await close(await reported(), PERSON.kabir);
    expect(lastEvent(byAdmin.id).after).not.toHaveProperty('delegated');
    for (const as of [PERSON.meera, PERSON.rohan]) {
      const a = await close(await reported(), as);
      expect(lastEvent(a.id).after).toMatchObject({ action: 'CLOSE', delegated: true });
    }
    const a = await reported();
    for (const as of [PERSON.nisha, PERSON.vikram]) {
      await fails(
        app,
        'closeIsoInternalAudit',
        { as, params: at(a), body: { version: a.version } },
        'FORBIDDEN',
        403,
      );
    }
  });

  it('CANCELs a PLANNED audit with a reason, by managers only', async () => {
    const byAdmin = await cancel(await createAudit());
    expect(byAdmin).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'Moved to next quarter',
      allowedActions: [],
    });
    expect(lastEvent(byAdmin.id)).toMatchObject({
      action: 'TRANSITION',
      before: { state: 'PLANNED', cancelReason: null },
      after: { action: 'CANCEL', state: 'CANCELLED' },
      reason: 'Moved to next quarter',
    });
    expect(lastEvent(byAdmin.id).after).not.toHaveProperty('delegated');
    const byConsultant = await cancel(await createAudit(), PERSON.arjun);
    expect(lastEvent(byConsultant.id).after).toMatchObject({ delegated: true });
    const a = await createAudit();
    await fails(
      app,
      'cancelIsoInternalAudit',
      { params: at(a), body: { version: 1 } },
      'REASON_REQUIRED',
      422,
    );
    for (const as of [PERSON.sameer, PERSON.rohan, PERSON.divya, PERSON.vikram]) {
      await fails(
        app,
        'cancelIsoInternalAudit',
        { as, params: at(a), body: { version: 1, reason: 'No' } },
        'FORBIDDEN',
        403,
      );
    }
    const started = await start(a);
    const refused = await fails(
      app,
      'cancelIsoInternalAudit',
      { params: at(started), body: { version: started.version, reason: 'Too late' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(refused.error.details).toMatchObject({ from: 'IN_PROGRESS', action: 'CANCEL' });
  });
});

// ---------- checklist ----------

describe('the audit checklist', () => {
  it("adds rows for the audit's clauses and units while PLANNED or IN_PROGRESS", async () => {
    const a = await createAudit(programme, { unitIds: [PUNE, BENGALURU] });
    const row = await addRow(a, C('7.2'), { unitId: BENGALURU }, PERSON.rohan);
    expect(row).toMatchObject({
      internalAuditId: a.id,
      clauseId: C('7.2'),
      unitId: BENGALURU,
      result: null,
      findingId: null,
      notAuditedReason: null,
      auditorNote: null,
      version: 1,
    });
    expect(isoEvents(app, row.id)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        entityType: 'audit_checklist_item',
        actorId: PERSON.rohan,
        after: expect.objectContaining({ internalAuditId: a.id, clauseId: C('7.2') }),
      }),
    ]);
    await addRow(a, C('4.1'), {}, PERSON.kabir);
    expect((await checklist(a)).items.map((i) => i.clauseId)).toEqual([C('4.1'), C('7.2')]);
    const refuse = (body: Record<string, unknown>, as: string = PERSON.sameer) =>
      call(app, 'createIsoAuditChecklistItem', {
        as,
        params: at(a),
        body: { clauseId: C('4.1'), question: 'Is it in place?', ...body },
      });
    expect((await refuse({ clauseId: C('8.1') })).status).toBe(400);
    expect((await refuse({ unitId: CHENNAI })).status).toBe(400);
    for (const as of [PERSON.nisha, PERSON.divya, PERSON.vikram]) {
      expect((await refuse({}, as)).status).toBe(403);
    }
    const done = await reported();
    const locked = await fails(
      app,
      'createIsoAuditChecklistItem',
      { params: at(done), body: { clauseId: C('4.1'), question: 'Late?' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(locked.error.details).toEqual({
      entity: 'internal_audit',
      from: 'REPORTED',
      action: 'UPDATE',
    });
  });

  it('lists the checklist to whoever reads the audit, within unit scope', async () => {
    const blr = await createAudit(programme, {
      unitIds: [BENGALURU],
      auditorIds: [],
      auditeeIds: [],
      clauseIds: [C('7.2')],
    });
    await addRow(blr, C('7.2'));
    for (const as of [PERSON.vikram, PERSON.divya, ISHAAN, PERSON.kabir]) {
      expect((await checklist(blr, as)).items).toHaveLength(1);
    }
    for (const as of [PERSON.nisha, PERSON.rohan]) {
      await fails(app, 'listIsoAuditChecklist', { as, params: at(blr) }, 'NOT_FOUND', 404);
      await fails(app, 'listIsoInternalFindings', { as, params: at(blr) }, 'NOT_FOUND', 404);
    }
  });

  it('answers rows: CONFORMS, NOT_AUDITED with its reason, FINDING with a finding of the audit', async () => {
    const a = await start(await createAudit(programme, { unitIds: [PUNE, BENGALURU] }));
    let row = await addRow(a, C('7.2'));
    row = await answer(a, row, { result: 'CONFORMS', auditorNote: 'Records seen.' }, PERSON.rohan);
    expect(row).toMatchObject({ result: 'CONFORMS', auditorNote: 'Records seen.', version: 2 });
    expect(lastEvent(row.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'audit_checklist_item',
      before: { result: null, auditorNote: null },
      after: { result: 'CONFORMS', auditorNote: 'Records seen.' },
    });
    const refuse = (body: Record<string, unknown>, version = row.version) =>
      call(app, 'updateIsoAuditChecklistItem', {
        as: PERSON.sameer,
        params: at(a, { itemId: row.id }),
        body: { version, ...body },
      });
    expect((await refuse({ result: 'NOT_AUDITED' })).status).toBe(400);
    expect((await refuse({ result: 'FINDING' })).status).toBe(400);
    expect((await refuse({ notAuditedReason: 'Closed' })).status).toBe(400);
    row = await answer(a, row, { result: 'NOT_AUDITED', notAuditedReason: 'Records offsite' });
    expect(row).toMatchObject({ result: 'NOT_AUDITED', notAuditedReason: 'Records offsite' });
    expect((await refuse({ notAuditedReason: null })).status).toBe(400);
    // Moving away from NOT_AUDITED clears its reason.
    row = await answer(a, row, { result: 'CONFORMS' });
    expect(row.notAuditedReason).toBeNull();

    const finding = await addFinding(a);
    const other = await addFinding(await answered());
    expect((await refuse({ result: 'FINDING', findingId: other.id })).status).toBe(400);
    expect((await refuse({ findingId: finding.id })).status).toBe(400);
    row = await answer(a, row, { result: 'FINDING', findingId: finding.id });
    expect(row).toMatchObject({ result: 'FINDING', findingId: finding.id });
    expect((await refuse({ findingId: null })).status).toBe(400);
    expect((await refuse({ unitId: CHENNAI })).status).toBe(400);
    row = await answer(a, row, { unitId: BENGALURU, question: 'Are training records kept?' });
    // Clearing the result clears the link.
    row = await answer(a, row, { result: null });
    expect(row).toMatchObject({ result: null, findingId: null, unitId: BENGALURU });
    expect((await refuse({ result: 'CONFORMS' }, 1)).status).toBe(409);
    for (const as of [PERSON.nisha, PERSON.divya, PERSON.vikram]) {
      const denied = await call(app, 'updateIsoAuditChecklistItem', {
        as,
        params: at(a, { itemId: row.id }),
        body: { version: row.version, result: 'CONFORMS' },
      });
      expect(denied.status).toBe(403);
    }
    // A row of another audit is not found under this one.
    const elsewhere = (await checklist(await answered())).items[0]!;
    await fails(
      app,
      'updateIsoAuditChecklistItem',
      { params: at(a, { itemId: elsewhere.id }), body: { version: 1, result: 'CONFORMS' } },
      'NOT_FOUND',
      404,
    );
  });

  it('locks the rows of a REPORTED, CLOSED or CANCELLED audit', async () => {
    const done = await reported();
    const row = (await checklist(done)).items[0]!;
    const locked = await fails(
      app,
      'updateIsoAuditChecklistItem',
      {
        params: at(done, { itemId: row.id }),
        body: { version: row.version, auditorNote: 'Late note' },
      },
      'INVALID_TRANSITION',
      409,
    );
    expect(locked.error.details).toMatchObject({ entity: 'internal_audit', from: 'REPORTED' });
    const closed = await close(done);
    const stillLocked = await fails(
      app,
      'createIsoAuditChecklistItem',
      { params: at(closed), body: { clauseId: C('4.1'), question: 'After closing?' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(stillLocked.error.details).toMatchObject({ from: 'CLOSED', action: 'UPDATE' });
    const cancelled = await createAudit();
    const planned = await addRow(cancelled, C('4.1'));
    await cancel(await getAudit(cancelled));
    await fails(
      app,
      'updateIsoAuditChecklistItem',
      { params: at(cancelled, { itemId: planned.id }), body: { version: 1, result: 'CONFORMS' } },
      'INVALID_TRANSITION',
      409,
    );
  });
});

// ---------- findings ----------

describe('internal audit findings', () => {
  it('records findings only while the audit is IN_PROGRESS', async () => {
    const a = await createAudit();
    const refused = await fails(
      app,
      'createIsoInternalFinding',
      { params: at(a), body: { type: 'OFI', description: 'Too early.' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(refused.error.details).toEqual({
      entity: 'internal_audit',
      from: 'PLANNED',
      action: 'UPDATE',
    });
    const done = await reported();
    await fails(
      app,
      'createIsoInternalFinding',
      { params: at(done), body: { type: 'OFI', description: 'Too late.' } },
      'INVALID_TRANSITION',
      409,
    );
  });

  it('records an observation, audited, and lists findings in the order recorded', async () => {
    const a = await start(await createAudit());
    const first = await addFinding(a, { clauseIds: [C('7.2')], unitId: PUNE }, PERSON.rohan);
    expect(first).toMatchObject({
      internalAuditId: a.id,
      externalAuditId: null,
      type: 'OBSERVATION',
      clauseIds: [C('7.2')],
      unitId: PUNE,
      nonconformityId: null,
      version: 1,
    });
    expect(isoEvents(app, first.id)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        entityType: 'audit_finding',
        actorId: PERSON.rohan,
        after: expect.objectContaining({ internalAuditId: a.id, type: 'OBSERVATION' }),
      }),
    ]);
    const second = await addFinding(a, { type: 'GOOD_PRACTICE' }, PERSON.kabir);
    for (const as of [PERSON.meera, PERSON.nisha, PERSON.vikram, PERSON.divya]) {
      expect(ids((await findings(a, as)).items)).toEqual([first.id, second.id]);
    }
    for (const as of [PERSON.nisha, PERSON.divya, PERSON.vikram]) {
      await fails(
        app,
        'createIsoInternalFinding',
        { as, params: at(a), body: { type: 'OFI', description: 'Not mine to record.' } },
        'FORBIDDEN',
        403,
      );
    }
    const refuse = (body: Record<string, unknown>) =>
      call(app, 'createIsoInternalFinding', {
        params: at(a),
        body: { type: 'OFI', description: 'Something.', ...body },
      });
    expect((await refuse({ clauseIds: [clause('ISO_14001', '6.1.2')] })).status).toBe(400);
    expect((await refuse({ unitId: BENGALURU })).status).toBe(400);
    expect((await refuse({ nonconformity: NC_BODY })).status).toBe(400);
    expect((await refuse({ type: 'MAJOR_NC' })).status).toBe(400);
  });

  it("reports a finding's nonconformity on the client's day, which it is due no earlier than", async () => {
    // Now is 06:30 UTC on TODAY: 19:30 the day before for a client in Pago Pago (UTC-11).
    const client = firmB(app).data.clients.find((c) => c.id === NORTHWIND)!;
    const zone = client.settings.timeZone;
    client.settings.timeZone = 'Pacific/Pago_Pago';
    try {
      const a = await start(await createAudit());
      const yesterday = addDays(TODAY, -1);
      const raise = (dueOn: string) => ({
        type: 'MINOR_NC',
        clauseIds: [C('7.2')],
        nonconformity: { ...NC_BODY, dueOn },
      });
      const minor = await addFinding(a, raise(yesterday));
      expect(ncOf(minor)).toMatchObject({ reportedOn: yesterday, dueOn: yesterday });
      await fails(
        app,
        'createIsoInternalFinding',
        {
          as: PERSON.sameer,
          params: at(a),
          body: { description: 'Late', ...raise(addDays(TODAY, -2)) },
        },
        'VALIDATION',
        400,
      );
    } finally {
      client.settings.timeZone = zone;
    }
  });

  it('raises a nonconformity from a MAJOR_NC or MINOR_NC finding in the same step', async () => {
    const a = await start(await createAudit());
    const major = await addFinding(a, {
      type: 'MAJOR_NC',
      clauseIds: [C('7.2')],
      description: 'No training records for new starters.',
      nonconformity: NC_BODY,
    });
    const nc = ncOf(major);
    expect(Nonconformity.safeParse(nc).success).toBe(true);
    expect(nc).toMatchObject({
      managementSystemId: sys.id,
      source: 'INTERNAL_AUDIT',
      severity: 'MAJOR',
      state: 'OPEN',
      standards: ['ISO_9001'],
      clauseIds: [C('7.2')],
      // The finding names no unit, so the NC takes the audit's single unit.
      unitId: PUNE,
      description: 'No training records for new starters.',
      reportedById: PERSON.sameer,
      reportedOn: TODAY,
      ownerId: PERSON.sameer,
      approverId: PERSON.divya,
      dueOn: addDays(TODAY, 30),
      incident: null,
    });
    expect(major.nonconformityId).toBe(nc.id);
    expect(isoEvents(app, nc.id)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        entityType: 'nonconformity',
        after: expect.objectContaining({
          action: 'RAISE',
          source: 'INTERNAL_AUDIT',
          severity: 'MAJOR',
          auditFindingId: major.id,
        }),
      }),
    ]);
    const minor = await addFinding(a, { type: 'MINOR_NC', nonconformity: NC_BODY });
    expect(ncOf(minor)).toMatchObject({ severity: 'MINOR', number: nc.number + 1, clauseIds: [] });

    const refuse = (nonconformity: Record<string, unknown>, unitId: string | null = null) =>
      fails(
        app,
        'createIsoInternalFinding',
        {
          params: at(a),
          body: {
            type: 'MINOR_NC',
            description: 'Refused.',
            unitId,
            nonconformity: { ...NC_BODY, ...nonconformity },
          },
        },
        'VALIDATION',
        400,
      );
    const outsider = await refuse({ ownerId: PERSON.joseph });
    expect(outsider.error.details).toEqual({
      issues: [
        {
          path: ['body', 'nonconformity', 'ownerId'],
          message: 'Not an owner of this client and unit',
        },
      ],
    });
    await refuse({ approverId: PERSON.vikram });
    await refuse({ approverId: PERSON.sameer });
    // The owner works it and the approver verifies it (plan §3.2 isoNc.work, isoNc.verify).
    await refuse({ ownerId: PERSON.divya });
    await refuse({ approverId: PERSON.rohan });
    await refuse({ ownerId: PERSON.meera });
    const byAdmin = await addFinding(a, {
      type: 'MINOR_NC',
      nonconformity: { ...NC_BODY, ownerId: PERSON.kabir, approverId: PERSON.nisha },
    });
    expect(ncOf(byAdmin)).toMatchObject({ ownerId: PERSON.kabir, approverId: PERSON.nisha });
    const late = await refuse({ dueOn: addDays(TODAY, -1) });
    expect(late.error.details).toMatchObject({
      issues: [{ path: ['body', 'nonconformity', 'dueOn'] }],
    });
  });

  it('checks the NC people against the unit of a finding on a multi-unit audit', async () => {
    const a = await start(await createAudit(programme, { unitIds: [PUNE, BENGALURU] }));
    const raise = (unitId: string | null, ownerId: string) =>
      call(app, 'createIsoInternalFinding', {
        params: at(a),
        body: {
          type: 'MINOR_NC',
          description: 'Spill kit missing.',
          unitId,
          nonconformity: { ...NC_BODY, ownerId },
        },
      });
    expect((await raise(BENGALURU, PERSON.rohan)).status).toBe(400);
    const ok1 = await raise(BENGALURU, ISHAAN);
    expect(ok1.status).toBe(201);
    const unitless = await raise(null, PERSON.rohan);
    expect(unitless.status).toBe(201);
    expect(ncOf(unitless.json as Finding).unitId).toBeNull();
  });

  it('records a finding against a checklist row, marking the row FINDING', async () => {
    const a = await start(await createAudit(programme, { unitIds: [PUNE, BENGALURU] }));
    const row = await answer(a, await addRow(a, C('7.2'), { unitId: BENGALURU }), {
      result: 'NOT_AUDITED',
      notAuditedReason: 'Pending',
    });
    const finding = await addFinding(a, { type: 'OFI', checklistItemId: row.id });
    expect(finding).toMatchObject({ clauseIds: [C('7.2')], unitId: BENGALURU });
    const marked = (await checklist(a)).items.find((i) => i.id === row.id)!;
    expect(marked).toMatchObject({
      result: 'FINDING',
      findingId: finding.id,
      notAuditedReason: null,
      version: row.version + 1,
    });
    expect(lastEvent(row.id)).toMatchObject({
      action: 'UPDATE',
      after: { result: 'FINDING', findingId: finding.id, notAuditedReason: null },
    });
    const twice = await fails(
      app,
      'createIsoInternalFinding',
      { params: at(a), body: { type: 'OFI', description: 'Again.', checklistItemId: row.id } },
      'VALIDATION',
      400,
    );
    expect(JSON.stringify(twice)).toContain('already links');
    const elsewhere = (await checklist(await answered())).items[0]!;
    await fails(
      app,
      'createIsoInternalFinding',
      {
        params: at(a),
        body: { type: 'OFI', description: 'Wrong row.', checklistItemId: elsewhere.id },
      },
      'VALIDATION',
      400,
    );
    // A finding's own clauses and unit win over the row's.
    const own = await addFinding(a, {
      checklistItemId: (await addRow(a, C('4.1'))).id,
      clauseIds: [C('7.2')],
      unitId: PUNE,
    });
    expect(own).toMatchObject({ clauseIds: [C('7.2')], unitId: PUNE });
  });

  it("raises a Harbour nonconformity on the client's only unit, from a clean slate", async () => {
    const harbour = seedSystem(app, { clientId: HARBOUR, standards: ['ISO_9001', 'ISO_14001'] });
    const prog = await createProgramme(harbour, FY, PERSON.leela);
    const a = await start(
      await ok<Audit>(app, 'createIsoInternalAudit', {
        as: PERSON.leela,
        params: { clientId: HARBOUR },
        body: {
          programmeId: prog.id,
          title: 'Chennai store audit',
          plannedStart: TODAY,
          plannedEnd: TODAY,
          clauseIds: [clause('ISO_14001', '8.2')],
          leadAuditorId: PERSON.joseph,
          auditeeIds: [PERSON.priya],
          reportedToIds: [PERSON.priya],
        },
      }),
      PERSON.joseph,
    );
    expect(a.managementSystemId).toBe(harbour.id);
    const finding = await addFinding(
      a,
      {
        type: 'MAJOR_NC',
        nonconformity: { ownerId: PERSON.joseph, approverId: PERSON.priya, dueOn: TODAY },
      },
      PERSON.joseph,
    );
    expect(ncOf(finding)).toMatchObject({
      clientId: HARBOUR,
      unitId: CHENNAI,
      // No clauses on the finding: the audit's clauses decide the standards.
      standards: ['ISO_14001'],
    });
    await fails(
      app,
      'listIsoInternalFindings',
      { as: PERSON.arjun, params: at(a) },
      'NOT_FOUND',
      404,
    );
  });

  it('changes a finding while IN_PROGRESS within its type family; the NC severity follows', async () => {
    const a = await start(await createAudit(programme, { unitIds: [PUNE, BENGALURU] }));
    let obs = await addFinding(a);
    const edit = (f: Finding, body: Record<string, unknown>, version = f.version) =>
      call(app, 'updateIsoInternalFinding', {
        as: PERSON.rohan,
        params: at(a, { findingId: f.id }),
        body: { version, ...body },
      });
    obs = await ok<Finding>(app, 'updateIsoInternalFinding', {
      as: PERSON.rohan,
      params: at(a, { findingId: obs.id }),
      body: { version: 1, type: 'OFI', description: 'Records could be digital.' },
    });
    expect(obs).toMatchObject({ type: 'OFI', version: 2 });
    expect(lastEvent(obs.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'audit_finding',
      before: { type: 'OBSERVATION', description: '[not recorded]' },
      after: { type: 'OFI', description: '[not recorded]' },
    });
    expect((await edit(obs, { type: 'MAJOR_NC' })).status).toBe(400);
    expect((await edit(obs, { clauseIds: [clause('ISO_45001', '5.4')] })).status).toBe(400);
    expect((await edit(obs, { unitId: CHENNAI })).status).toBe(400);
    expect((await edit(obs, { description: 'Stale.' }, 1)).status).toBe(409);
    const moved = await edit(obs, { clauseIds: [C('4.1')], unitId: BENGALURU });
    expect(moved.json).toMatchObject({ clauseIds: [C('4.1')], unitId: BENGALURU });
    obs = moved.json as Finding;

    // No GOOD_PRACTICE while it has live actions; a cancelled action does not count.
    const action = seed(app, 'actions', {
      ...base(),
      subject: { type: 'AUDIT_FINDING', id: obs.id },
      text: 'Scan the training records.',
      resources: null,
      ownerId: PERSON.sameer,
      dueOn: addDays(TODAY, 14),
      doneOn: null,
      state: 'OPEN',
      effectivenessNote: null,
      cancelReason: null,
      controlHierarchy: null,
      outputKey: null,
    });
    expect((await edit(obs, { type: 'GOOD_PRACTICE' })).status).toBe(400);
    Object.assign(action, { state: 'CANCELLED', cancelReason: 'Not needed' });
    obs = (await edit(obs, { type: 'GOOD_PRACTICE' })).json as Finding;
    expect(obs.type).toBe('GOOD_PRACTICE');

    const major = await addFinding(a, { type: 'MAJOR_NC', nonconformity: NC_BODY });
    const nc = ncOf(major);
    expect((await edit(major, { type: 'OBSERVATION' })).status).toBe(400);
    const minor = await edit(major, { type: 'MINOR_NC' });
    expect(minor.json).toMatchObject({ type: 'MINOR_NC', nonconformityId: nc.id });
    expect(nc).toMatchObject({ severity: 'MINOR', version: 2 });
    expect(lastEvent(nc.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'nonconformity',
      before: { severity: 'MAJOR' },
      after: { severity: 'MINOR' },
    });
    Object.assign(nc, { state: 'CANCELLED', cancelReason: 'Raised twice' });
    const closedNc = await fails(
      app,
      'updateIsoInternalFinding',
      {
        params: at(a, { findingId: major.id }),
        body: { version: (minor.json as Finding).version, type: 'MAJOR_NC' },
      },
      'INVALID_TRANSITION',
      409,
    );
    expect(closedNc.error.details).toEqual({
      entity: 'nonconformity',
      from: 'CANCELLED',
      action: 'UPDATE',
    });
    // Its other fields still change.
    expect(
      (await edit(minor.json as Finding, { description: 'Records missing for two starters.' }))
        .status,
    ).toBe(200);
    for (const as of [PERSON.nisha, PERSON.divya, PERSON.vikram]) {
      const denied = await call(app, 'updateIsoInternalFinding', {
        as,
        params: at(a, { findingId: obs.id }),
        body: { version: obs.version, description: 'Not mine.' },
      });
      expect(denied.status).toBe(403);
    }
  });

  it('moves MAJOR_NC and MINOR_NC while the NC is OPEN or ROOT_CAUSE_FOUND, never by its owner', async () => {
    const a = await start(await createAudit());
    // sameer leads the audit and owns the NC (NC_BODY); rohan audits.
    let finding = await addFinding(a, { type: 'MAJOR_NC', nonconformity: NC_BODY });
    const nc = ncOf(finding);
    const onNc = { clientId: nc.clientId, id: nc.id };
    const edit = (as: string, body: Record<string, unknown>) => ({
      as,
      params: at(a, { findingId: finding.id }),
      body: { version: finding.version, ...body },
    });
    /** Refuses a type move and changes nothing: no event, the finding and its NC as they were. */
    const refused = async (as: string, type: string, code: string, status: number) => {
      const events = firmB(app).data.auditEvents.length;
      const was = { state: nc.state, severity: nc.severity, version: nc.version };
      const out = await fails(app, 'updateIsoInternalFinding', edit(as, { type }), code, status);
      expect(firmB(app).data.auditEvents).toHaveLength(events);
      expect(firmB(app).iso.findings.find((f) => f.id === finding.id)).toMatchObject({
        type: finding.type,
        version: finding.version,
      });
      expect(nc).toMatchObject(was);
      return out.error.details;
    };
    const update = (as: string, body: Record<string, unknown>) =>
      ok<Finding>(app, 'updateIsoInternalFinding', edit(as, body));

    // OPEN: the owner is refused though they lead the audit; an auditor moves it and the severity follows.
    expect(await refused(PERSON.sameer, 'MINOR_NC', 'FORBIDDEN', 403)).toEqual({
      action: 'isoAudit.conduct',
    });
    finding = await update(PERSON.rohan, { type: 'MINOR_NC' });
    expect(finding).toMatchObject({ type: 'MINOR_NC', version: 2 });
    expect(nc).toMatchObject({ state: 'OPEN', severity: 'MINOR', version: 2 });
    expect(lastEvent(nc.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'nonconformity',
      actorId: PERSON.rohan,
      before: { severity: 'MAJOR' },
      after: { severity: 'MINOR' },
    });
    // Only the move is closed to the owner: their other edits keep today's rules.
    finding = await update(PERSON.sameer, {
      clauseIds: [C('7.2')],
      description: 'No induction records for two starters.',
    });
    expect(finding).toMatchObject({ type: 'MINOR_NC', clauseIds: [C('7.2')], version: 3 });
    expect(nc.version).toBe(2);

    // ROOT_CAUSE_FOUND: still open to the move.
    await ok(app, 'addIsoNcRootCause', {
      as: PERSON.sameer,
      params: onNc,
      body: {
        version: nc.version,
        containment: 'Paused new starters on the line',
        correction: 'Inducted the two starters',
        rootCauseMethod: 'FIVE_WHYS',
        rootCause: 'The induction checklist has no records step',
        similarOccurrences: 'None at Bengaluru',
      },
    });
    expect(nc).toMatchObject({ state: 'ROOT_CAUSE_FOUND', version: 3 });
    expect(await refused(PERSON.sameer, 'MAJOR_NC', 'FORBIDDEN', 403)).toEqual({
      action: 'isoAudit.conduct',
    });
    finding = await update(PERSON.meera, { type: 'MAJOR_NC' });
    expect(finding).toMatchObject({ type: 'MAJOR_NC', version: 4 });
    expect(nc).toMatchObject({ state: 'ROOT_CAUSE_FOUND', severity: 'MAJOR', version: 4 });
    expect(lastEvent(nc.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'nonconformity',
      actorId: PERSON.meera,
      before: { severity: 'MINOR' },
      after: { severity: 'MAJOR' },
    });

    // ACTIONS_PLANNED and AWAITING_VERIFICATION: 409 for everyone, and still 403 for the owner.
    const action = seed(app, 'actions', {
      ...base(),
      subject: { type: 'NONCONFORMITY', id: nc.id },
      text: 'Add a records step to the induction checklist.',
      resources: null,
      ownerId: PERSON.sameer,
      dueOn: addDays(TODAY, 14),
      doneOn: null,
      state: 'OPEN',
      effectivenessNote: null,
      cancelReason: null,
      controlHierarchy: null,
      outputKey: null,
    });
    await ok(app, 'planIsoNcActions', {
      as: PERSON.sameer,
      params: onNc,
      body: { version: nc.version, effectivenessDueOn: addDays(TODAY, 30) },
    });
    expect(nc).toMatchObject({ state: 'ACTIONS_PLANNED', severity: 'MAJOR', version: 5 });
    for (const as of [PERSON.rohan, PERSON.meera, PERSON.kabir]) {
      expect(await refused(as, 'MINOR_NC', 'INVALID_TRANSITION', 409)).toEqual({
        entity: 'nonconformity',
        from: 'ACTIONS_PLANNED',
        action: 'UPDATE',
      });
    }
    expect(await refused(PERSON.sameer, 'MINOR_NC', 'FORBIDDEN', 403)).toEqual({
      action: 'isoAudit.conduct',
    });
    Object.assign(action, { state: 'DONE', doneOn: TODAY });
    await ok(app, 'submitIsoNc', {
      as: PERSON.sameer,
      params: onNc,
      body: {
        version: nc.version,
        riskReview: 'None needed',
        systemChange: 'Induction checklist updated',
      },
    });
    expect(nc).toMatchObject({ state: 'AWAITING_VERIFICATION', severity: 'MAJOR', version: 6 });
    expect(await refused(PERSON.rohan, 'MINOR_NC', 'INVALID_TRANSITION', 409)).toEqual({
      entity: 'nonconformity',
      from: 'AWAITING_VERIFICATION',
      action: 'UPDATE',
    });
    expect(await refused(PERSON.sameer, 'MINOR_NC', 'FORBIDDEN', 403)).toEqual({
      action: 'isoAudit.conduct',
    });
    // The finding's other fields still change.
    finding = await update(PERSON.rohan, { description: 'No induction records for new starters.' });
    expect(finding).toMatchObject({ type: 'MAJOR_NC', version: 5 });
    expect(nc.version).toBe(6);
  });

  it('locks findings once the audit is REPORTED, and finds them only under their audit', async () => {
    const a = await answered();
    const finding = await addFinding(a);
    const done = await report(await getAudit(a));
    const locked = await fails(
      app,
      'updateIsoInternalFinding',
      {
        params: at(done, { findingId: finding.id }),
        body: { version: finding.version, description: 'Late.' },
      },
      'INVALID_TRANSITION',
      409,
    );
    expect(locked.error.details).toEqual({
      entity: 'internal_audit',
      from: 'REPORTED',
      action: 'UPDATE',
    });
    const other = await start(await createAudit());
    await fails(
      app,
      'updateIsoInternalFinding',
      {
        params: at(other, { findingId: finding.id }),
        body: { version: finding.version, description: 'Elsewhere.' },
      },
      'NOT_FOUND',
      404,
    );
  });

  it('never copies a finding description into the audit trail (non-negotiable 6)', async () => {
    const a = await start(await createAudit());
    const raisedText = 'A fitter on the night shift worked at height without a harness.';
    const editedText = 'Two fitters on the night shift worked at height without harnesses.';
    const major = await addFinding(a, {
      type: 'MAJOR_NC',
      description: raisedText,
      nonconformity: NC_BODY,
    });
    const nc = ncOf(major);
    const edited = await ok<Finding>(app, 'updateIsoInternalFinding', {
      params: at(a, { findingId: major.id }),
      body: { version: major.version, description: editedText },
    });
    expect(edited).toMatchObject({ description: editedText, version: 2 });
    expect(nc.description).toBe(raisedText);
    expect(isoEvents(app, major.id)).toHaveLength(2);
    expect(lastEvent(major.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'audit_finding',
      before: { description: '[not recorded]' },
      after: { description: '[not recorded]' },
    });
    expect(isoEvents(app, nc.id)[0]!.after).not.toHaveProperty('description');
    const trail = JSON.stringify(
      firmB(app).data.auditEvents.filter((e) => e.clientId === NORTHWIND),
    );
    expect(trail).not.toContain(raisedText);
    expect(trail).not.toContain(editedText);
  });
});

// ---------- the list ----------

describe('listing internal audits', () => {
  it('lists by planned start, with every filter, within unit scope', async () => {
    const system = seedSystem(app, { standards: ['ISO_9001'], unitIds: [PUNE, BENGALURU] });
    const prog = await createProgramme(system);
    const pune = await createAudit(prog, {
      title: 'Pune plant audit',
      plannedStart: addDays(TODAY, 10),
      plannedEnd: addDays(TODAY, 10),
    });
    const blr = await createAudit(prog, {
      title: 'Bengaluru office audit',
      plannedStart: addDays(TODAY, 5),
      plannedEnd: addDays(TODAY, 5),
      unitIds: [BENGALURU],
      leadAuditorId: PERSON.divya,
      auditorIds: [],
      auditeeIds: [],
    });
    const everywhere = await cancel(
      await createAudit(prog, {
        title: 'Whole system audit',
        plannedStart: addDays(TODAY, 20),
        plannedEnd: addDays(TODAY, 21),
        unitIds: [],
        leadAuditorId: PERSON.rohan,
        auditorIds: [],
        auditeeIds: [],
      }),
    );
    const list = async (query: Record<string, string> = {}, as: string = PERSON.meera) =>
      ids(
        (
          await ok<{ items: Audit[] }>(app, 'listIsoInternalAudits', {
            as,
            query: { programmeId: prog.id, ...query },
          })
        ).items,
      );
    expect(await list()).toEqual([blr.id, pune.id, everywhere.id]);
    expect(await list({ state: 'CANCELLED' })).toEqual([everywhere.id]);
    expect(await list({ state: 'PLANNED,IN_PROGRESS' })).toEqual([blr.id, pune.id]);
    // An audit with no units of its own covers its system's units.
    expect(await list({ unitId: BENGALURU })).toEqual([blr.id, everywhere.id]);
    expect(await list({ leadAuditorId: 'me' }, PERSON.divya)).toEqual([blr.id]);
    expect(await list({ leadAuditorId: PERSON.sameer })).toEqual([pune.id]);
    expect(await list({ from: addDays(TODAY, 6), to: addDays(TODAY, 15) })).toEqual([pune.id]);
    expect(await list({ q: 'bengaluru' })).toEqual([blr.id]);
    expect(await list({ managementSystemId: sys.id })).toEqual([]);
    expect(await list({ managementSystemId: system.id })).toHaveLength(3);
    // Pune-only nisha and rohan do not see the Bengaluru audit that names neither.
    expect(await list({}, PERSON.nisha)).toEqual([pune.id, everywhere.id]);
    expect(await list({}, PERSON.rohan)).toEqual([pune.id, everywhere.id]);
    expect(await list({}, ISHAAN)).toEqual([blr.id, everywhere.id]);
    const paged = await ok<{ items: Audit[]; nextCursor: string | null }>(
      app,
      'listIsoInternalAudits',
      { query: { programmeId: prog.id, limit: '2' } },
    );
    expect(ids(paged.items)).toEqual([blr.id, pune.id]);
    expect(paged.nextCursor).not.toBeNull();
    const views = await ok<{ items: Audit[] }>(app, 'listIsoInternalAudits', {
      as: PERSON.sameer,
      query: { programmeId: prog.id },
    });
    expect(views.items.map((a) => a.allowedActions)).toEqual([[], ['START'], []]);
    expect(views.items.every((a) => a.managementSystemId === system.id)).toBe(true);
  });

  it('narrows to the ids given, in list order, within the other filters and the reader’s units (ISO-1a4)', async () => {
    const system = seedSystem(app, { standards: ['ISO_9001'], unitIds: [PUNE, BENGALURU] });
    const prog = await createProgramme(system);
    const days = (n: number) => ({
      plannedStart: addDays(TODAY, n),
      plannedEnd: addDays(TODAY, n),
    });
    const later = await createAudit(prog, { title: 'Later audit', ...days(30) });
    const sooner = await createAudit(prog, { title: 'Sooner audit', ...days(3) });
    const blr = await createAudit(prog, {
      title: 'Bengaluru audit',
      unitIds: [BENGALURU],
      leadAuditorId: PERSON.divya,
      auditorIds: [],
      auditeeIds: [],
    });
    const gone = await createAudit(prog, { title: 'Archived audit' });
    firmB(app).iso.internalAudits.find((a) => a.id === gone.id)!.archivedAt = NOW;
    const harbour = await createProgramme(
      seedSystem(app, { clientId: HARBOUR, standards: ['ISO_9001'] }),
    );
    const other = await createAudit(harbour, {
      unitIds: [],
      leadAuditorId: PERSON.joseph,
      auditorIds: [],
      auditeeIds: [],
      reportedToIds: [PERSON.priya],
    });
    const named = async (rows: { id: string }[], query = {}, as: string = PERSON.meera) =>
      ids(
        (
          await ok<{ items: Audit[] }>(app, 'listIsoInternalAudits', {
            as,
            query: { ids: ids(rows).join(','), ...query },
          })
        ).items,
      );
    expect(await named([later, blr, sooner])).toEqual([sooner.id, blr.id, later.id]);
    expect(await named([later, blr, sooner], { unitId: BENGALURU })).toEqual([blr.id]);
    expect(await named([other, gone, sooner])).toEqual([sooner.id]);
    expect(await named([blr, sooner], {}, PERSON.nisha)).toEqual([sooner.id]);
  });
});

describe('coverage of the audits area', () => {
  it('calls every endpoint of the area', () => {
    const area: Id[] = [
      'listIsoAuditProgrammes',
      'createIsoAuditProgramme',
      'updateIsoAuditProgramme',
      'listIsoInternalAudits',
      'createIsoInternalAudit',
      'getIsoInternalAudit',
      'updateIsoInternalAudit',
      'startIsoInternalAudit',
      'reportIsoInternalAudit',
      'closeIsoInternalAudit',
      'cancelIsoInternalAudit',
      'listIsoAuditChecklist',
      'createIsoAuditChecklistItem',
      'updateIsoAuditChecklistItem',
      'listIsoInternalFindings',
      'createIsoInternalFinding',
      'updateIsoInternalFinding',
    ];
    expect(area.filter((id) => !called.has(id))).toEqual([]);
  });
});
