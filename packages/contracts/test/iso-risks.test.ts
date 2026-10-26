// The mock's ISO risk register and objectives (docs/iso/model.md §3.5, §3.6): risk items and their controls, the stored
// rating and significance (§1.7, §5.1), REVIEW (§5.2), objectives with readings and progress, unit scope (plan §3.3),
// the role matrix (plan §3.2) and the audit trail (model §8).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectiveView, RiskItemView } from '../src/api/iso.js';
import { addDays } from '../src/mock/iso/common.js';
import type { IsoRow } from '../src/mock/store.js';
import {
  type App,
  base,
  BENGALURU,
  call,
  CHENNAI,
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
  seedId,
  seedSystem,
  TODAY,
} from './iso-harness.js';

type Risk = RiskItemView;
type Objective = ObjectiveView;
type Control = IsoRow<'riskControls'>;
type Reading = IsoRow<'readings'>;
type System = IsoRow<'managementSystems'>;

let app: App;
/** Northwind, every unit; Northwind, Bengaluru only; Northwind on ISO 9001 only; Harbour. */
let all: System;
let blr: System;
let quality: System;
let harbour: System;
/** A live statutory obligation, an ISO activity from the catalogue copy, and an archived statutory obligation. */
let statute: string;
let activity: string;
let archivedObligation: string;

beforeAll(async () => {
  app = await isoApp();
  all = seedSystem(app);
  blr = seedSystem(app, { unitIds: [BENGALURU] });
  quality = seedSystem(app, { standards: ['ISO_9001'] });
  harbour = seedSystem(app, { clientId: HARBOUR });
  const data = firmB(app).data;
  const kindOf = (actId: string) => data.acts.find((a) => a.id === actId)?.kind ?? 'STATUTE';
  const live = data.obligations.filter((o) => o.archivedAt === null);
  const law = live.find((o) => kindOf(o.actId) === 'STATUTE')!;
  statute = law.id;
  activity = live.find((o) => kindOf(o.actId) === 'STANDARD')!.id;
  archivedObligation = seedId();
  data.obligations.push({ ...law, id: archivedObligation, archivedAt: law.createdAt });
});
afterAll(async () => {
  await app.close();
});

const lastEvent = (id: string) => isoEvents(app, id).at(-1)!;

// ---------- risk items ----------

const RISK = {
  kind: 'RISK',
  activity: 'Packaging supply',
  description: 'One supplier makes every carton',
  likelihood: 2,
  severity: 3,
  ownerId: PERSON.sameer,
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
  ownerId: PERSON.sameer,
};
const HAZARD = {
  kind: 'HAZARD',
  activity: 'Forklift loading',
  description: 'Forklift strikes a person in the dock',
  impact: 'Crush injury',
  routine: true,
  personsExposed: ['WORKER', 'CONTRACTOR'],
  condition: 'NORMAL',
  assessedWith: 'Two dock workers and the shift lead',
  likelihood: 2,
  severity: 5,
  ownerId: PERSON.sameer,
};

function createRisk(
  system: System = all,
  body: Record<string, unknown> = {},
  as: string = PERSON.meera,
): Promise<Risk> {
  return ok<Risk>(app, 'createIsoRisk', {
    as,
    params: { clientId: system.clientId },
    body: { managementSystemId: system.id, ...RISK, ...body },
  });
}

const riskParams = (item: { id: string; clientId: string }) => ({
  clientId: item.clientId,
  id: item.id,
});

const getRisk = (item: Risk, as: string = PERSON.meera) =>
  ok<Risk>(app, 'getIsoRisk', { as, params: riskParams(item) });

const updateRisk = (item: Risk, body: Record<string, unknown>, as: string = PERSON.meera) =>
  ok<Risk>(app, 'updateIsoRisk', {
    as,
    params: riskParams(item),
    body: { version: item.version, ...body },
  });

const listRisks = (query: Record<string, string>, as: string = PERSON.meera) =>
  ok<{ items: Risk[]; nextCursor: string | null; total?: number }>(app, 'listIsoRisks', {
    as,
    query,
  });

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe('createIsoRisk', () => {
  it('stores the rating and significance with a RISK, audited as CREATE', async () => {
    const item = await createRisk();
    expect(item).toMatchObject({
      clientId: NORTHWIND,
      managementSystemId: all.id,
      kind: 'RISK',
      unitId: null,
      rating: 6,
      residualRating: null,
      significant: false,
      significantOverride: null,
      significanceReason: null,
      obligationIds: [],
      climateRelated: false,
      lastReviewedOn: null,
      reviewDueOn: null,
      version: 1,
      reviewStatus: { timing: 'ON_TIME', overdueDays: null },
    });
    const events = isoEvents(app, item.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'CREATE',
      entityType: 'risk_item',
      actorId: PERSON.meera,
      after: { kind: 'RISK', rating: 6, significant: false, ownerId: PERSON.sameer },
    });
    expect(events[0]!.after).not.toHaveProperty('id');
  });

  it('marks an item significant at the threshold or with a legal link (firm rule 12, links count)', async () => {
    expect((await createRisk(all, { likelihood: 3, severity: 4 })).significant).toBe(true);
    expect((await createRisk(all, { likelihood: 2, severity: 5 })).significant).toBe(false);
    const linked = await createRisk(all, { likelihood: 1, severity: 1, obligationIds: [statute] });
    expect(linked).toMatchObject({ rating: 1, significant: true, obligationIds: [statute] });
    const residual = await createRisk(all, {
      likelihood: 4,
      severity: 4,
      residualLikelihood: 2,
      residualSeverity: 2,
    });
    expect(residual).toMatchObject({ rating: 16, residualRating: 4, significant: true });
  });

  it('takes the kind fields of an ASPECT and a HAZARD', async () => {
    const aspect = await createRisk(all, { ...ASPECT, unitId: PUNE, climateRelated: true });
    expect(aspect).toMatchObject({
      kind: 'ASPECT',
      unitId: PUNE,
      lifeCycleStages: ['PRODUCTION'],
      controlType: 'CONTROL',
      routine: null,
      personsExposed: [],
      climateRelated: true,
      rating: 9,
    });
    const hazard = await createRisk(all, HAZARD);
    expect(hazard).toMatchObject({
      kind: 'HAZARD',
      routine: true,
      personsExposed: ['WORKER', 'CONTRACTOR'],
      condition: 'NORMAL',
      controlType: null,
      rating: 10,
    });
    // The body's kind rules (model §3.5).
    for (const body of [
      { ...ASPECT, lifeCycleStages: [] },
      { ...HAZARD, impact: null },
      { ...RISK, condition: 'NORMAL' },
      { ...RISK, residualLikelihood: 2 },
    ]) {
      await fails(
        app,
        'createIsoRisk',
        { body: { managementSystemId: all.id, ...body } },
        'VALIDATION',
        400,
      );
    }
  });

  it('checks the unit, the owner and the legal links', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ unitId: PUNE, managementSystemId: blr.id }, 'unitId'],
      [{ unitId: CHENNAI }, 'unitId'],
      [{ ownerId: PERSON.gita }, 'ownerId'],
      [{ ownerId: PERSON.joseph }, 'ownerId'],
      [{ ownerId: PERSON.vikram }, 'ownerId'],
      [{ ownerId: PERSON.rohan, unitId: BENGALURU }, 'ownerId'],
      [{ obligationIds: [seedId()] }, 'obligationIds'],
      [{ obligationIds: [activity] }, 'obligationIds'],
      [{ obligationIds: [archivedObligation] }, 'obligationIds'],
    ];
    for (const [extra, path] of cases) {
      const error = await fails(
        app,
        'createIsoRisk',
        { body: { managementSystemId: all.id, ...RISK, ...extra } },
        'VALIDATION',
        400,
      );
      expect(error.error.details).toMatchObject({ issues: [{ path: ['body', path] }] });
    }
  });

  it('lets FA, CO and CA add items, and an owner only as its owner for their units', async () => {
    await createRisk(all, {}, PERSON.arjun);
    await createRisk(all, {}, PERSON.kabir);
    await createRisk(all, {}, PERSON.sameer);
    await createRisk(all, { ownerId: PERSON.rohan, unitId: PUNE }, PERSON.rohan);
    const body = { managementSystemId: all.id, ...RISK, ownerId: PERSON.kabir };
    for (const as of [PERSON.sameer, PERSON.divya, PERSON.nisha, PERSON.vikram]) {
      await fails(app, 'createIsoRisk', { as, body }, 'FORBIDDEN', 403);
    }
    await fails(app, 'createIsoRisk', { as: PERSON.leela, body }, 'NOT_FOUND', 404);
    // Out of rohan's units: Bengaluru, or a system over Bengaluru only.
    const mine = { ...RISK, ownerId: PERSON.rohan };
    await fails(
      app,
      'createIsoRisk',
      { as: PERSON.rohan, body: { managementSystemId: all.id, ...mine, unitId: BENGALURU } },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'createIsoRisk',
      { as: PERSON.rohan, body: { managementSystemId: blr.id, ...mine } },
      'NOT_FOUND',
      404,
    );
    // Another client's system.
    await fails(
      app,
      'createIsoRisk',
      { body: { managementSystemId: harbour.id, ...RISK } },
      'NOT_FOUND',
      404,
    );
  });
});

describe('getIsoRisk', () => {
  it('lets every role read an item in their units, and hides it outside them', async () => {
    const pune = await createRisk(all, { unitId: PUNE });
    const bengaluru = await createRisk(all, { unitId: BENGALURU });
    for (const as of [
      PERSON.meera,
      PERSON.arjun,
      PERSON.kabir,
      PERSON.divya,
      PERSON.nisha,
      PERSON.sameer,
      PERSON.rohan,
      PERSON.vikram,
    ]) {
      expect((await getRisk(pune, as)).id).toBe(pune.id);
    }
    for (const as of [PERSON.nisha, PERSON.rohan, PERSON.leela]) {
      await fails(app, 'getIsoRisk', { as, params: riskParams(bengaluru) }, 'NOT_FOUND', 404);
    }
    expect((await getRisk(bengaluru, PERSON.divya)).id).toBe(bengaluru.id);
  });

  it('shows an item to its owner outside their units (the named-person exception)', async () => {
    // No unit of its own: the item takes its system's units (Bengaluru), and names rohan as owner.
    const named = await createRisk(blr, { ownerId: PERSON.rohan });
    expect((await getRisk(named, PERSON.rohan)).ownerId).toBe(PERSON.rohan);
    await fails(
      app,
      'getIsoRisk',
      { as: PERSON.nisha, params: riskParams(named) },
      'NOT_FOUND',
      404,
    );
  });

  it('answers 404 for an unknown item or another client', async () => {
    const other = await createRisk(harbour, { ownerId: PERSON.joseph });
    await fails(app, 'getIsoRisk', { params: { id: seedId() } }, 'NOT_FOUND', 404);
    await fails(app, 'getIsoRisk', { params: { id: other.id } }, 'NOT_FOUND', 404);
    expect((await getRisk(other, PERSON.leela)).clientId).toBe(HARBOUR);
  });

  it('reports when the review is due soon or overdue (dueSoonDays 7)', async () => {
    const soon = await createRisk(all, { reviewDueOn: addDays(TODAY, 7) });
    expect(soon.reviewStatus).toEqual({ timing: 'DUE_SOON', overdueDays: null });
    const late = await createRisk(all, { reviewDueOn: addDays(TODAY, -3) });
    expect(late.reviewStatus).toEqual({ timing: 'OVERDUE', overdueDays: 3 });
    const later = await createRisk(all, { reviewDueOn: addDays(TODAY, 8) });
    expect(later.reviewStatus).toEqual({ timing: 'ON_TIME', overdueDays: null });
  });
});

describe('listIsoRisks', () => {
  let register: System;
  let low: Risk;
  let high: Risk;
  let aspect: Risk;
  let hazard: Risk;
  let gone: Risk;

  beforeAll(async () => {
    register = seedSystem(app, { name: 'Register list' });
    low = await createRisk(register, {
      likelihood: 1,
      severity: 2,
      ownerId: PERSON.rohan,
      unitId: PUNE,
    });
    high = await createRisk(register, {
      likelihood: 5,
      severity: 5,
      description: 'Cold store fails',
    });
    aspect = await createRisk(register, { ...ASPECT, unitId: BENGALURU, climateRelated: true });
    hazard = await createRisk(register, { ...HAZARD, likelihood: 3, severity: 2, unitId: PUNE });
    gone = await createRisk(register, { likelihood: 4, severity: 4 });
    await ok(app, 'archiveIsoRisk', {
      params: riskParams(gone),
      body: { version: 1, reason: 'Supplier replaced' },
    });
  });

  const of = (query: Record<string, string> = {}, as?: string) =>
    listRisks({ managementSystemId: register.id, ...query }, as).then((p) => ids(p.items));

  it('lists live items, highest rating first', async () => {
    expect(await of()).toEqual([high.id, aspect.id, hazard.id, low.id]);
    expect(await of({ includeArchived: 'true' })).toEqual([
      high.id,
      gone.id,
      aspect.id,
      hazard.id,
      low.id,
    ]);
    const archived = (await listRisks({ managementSystemId: register.id, includeArchived: 'true' }))
      .items[1]!;
    expect(archived.reviewStatus).toEqual({ timing: 'CLOSED', overdueDays: null });
  });

  it('applies every filter', async () => {
    expect(await of({ unitId: PUNE })).toEqual([hazard.id, low.id]);
    expect(await of({ unitId: `${PUNE},${BENGALURU}` })).toEqual([aspect.id, hazard.id, low.id]);
    expect(await of({ kind: 'ASPECT,HAZARD' })).toEqual([aspect.id, hazard.id]);
    expect(await of({ significant: 'true' })).toEqual([high.id]);
    expect(await of({ significant: 'false' })).toEqual([aspect.id, hazard.id, low.id]);
    expect(await of({ climateRelated: 'true' })).toEqual([aspect.id]);
    expect(await of({ climateRelated: 'false' })).toEqual([high.id, hazard.id, low.id]);
    expect(await of({ ownerId: PERSON.rohan })).toEqual([low.id]);
    expect(await of({ ownerId: 'me' }, PERSON.rohan)).toEqual([low.id]);
    expect(await of({ q: 'cold STORE' })).toEqual([high.id]);
    expect(await of({ q: 'pollution' })).toEqual([aspect.id]);
    const other = await listRisks({ managementSystemId: blr.id });
    expect(ids(other.items)).not.toContain(high.id);
  });

  it('narrows to the ids given, in list order, within the other filters and the reader’s units (ISO-1a4)', async () => {
    const other = await createRisk(harbour, { ownerId: PERSON.joseph });
    const named = async (rows: { id: string }[], query = {}, as: string = PERSON.meera) =>
      ids((await listRisks({ ids: ids(rows).join(','), ...query }, as)).items);
    expect(await named([low, hazard, high])).toEqual([high.id, hazard.id, low.id]);
    expect(await named([low, hazard, high], { unitId: PUNE })).toEqual([hazard.id, low.id]);
    expect(await named([other, low])).toEqual([low.id]);
    expect(await named([aspect, low], {}, PERSON.rohan)).toEqual([low.id]);
    expect(await named([low, gone])).toEqual([low.id]);
    expect(await named([low, gone], { includeArchived: 'true' })).toEqual([gone.id, low.id]);
  });

  it('keeps AP and OW to their units and the items they own (plan §3.3)', async () => {
    // The system covers every unit, so items with no unit reach nisha and rohan too.
    expect(await of({}, PERSON.nisha)).toEqual([high.id, hazard.id, low.id]);
    expect(await of({}, PERSON.rohan)).toEqual([high.id, hazard.id, low.id]);
    expect(await of({}, PERSON.divya)).toEqual([high.id, aspect.id, hazard.id, low.id]);
    expect(await of({}, PERSON.vikram)).toEqual([high.id, aspect.id, hazard.id, low.id]);
    await fails(app, 'listIsoRisks', { as: PERSON.leela }, 'NOT_FOUND', 404);
  });

  it('pages', async () => {
    const first = await listRisks({ managementSystemId: register.id, limit: '2', count: 'true' });
    expect(ids(first.items)).toEqual([high.id, aspect.id]);
    expect(first.total).toBe(4);
    const second = await listRisks({
      managementSystemId: register.id,
      limit: '2',
      cursor: first.nextCursor!,
    });
    expect(ids(second.items)).toEqual([hazard.id, low.id]);
    expect(second.nextCursor).toBeNull();
  });
});

describe('updateIsoRisk', () => {
  it('re-rates and recomputes the stored results, audited as UPDATE', async () => {
    const item = await createRisk();
    const rerated = await updateRisk(item, {
      likelihood: 4,
      severity: 4,
      residualLikelihood: 2,
      residualSeverity: 3,
    });
    expect(rerated).toMatchObject({
      rating: 16,
      residualRating: 6,
      significant: true,
      version: 2,
    });
    expect(lastEvent(item.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'risk_item',
      before: { likelihood: 2, severity: 3, rating: 6, significant: false, residualRating: null },
      after: { likelihood: 4, severity: 4, rating: 16, significant: true, residualRating: 6 },
    });
    const cleared = await updateRisk(rerated, { residualLikelihood: null, residualSeverity: null });
    expect(cleared).toMatchObject({ residualRating: null, residualLikelihood: null });
    const linked = await updateRisk(cleared, { likelihood: 1, obligationIds: [statute] });
    expect(linked).toMatchObject({ rating: 4, significant: true });
    const unlinked = await updateRisk(linked, { obligationIds: [] });
    expect(unlinked.significant).toBe(false);
  });

  it('audits a new owner as REASSIGN and a new review date as DUE_DATE_CHANGE', async () => {
    const item = await createRisk();
    const moved = await updateRisk(item, {
      ownerId: PERSON.rohan,
      unitId: PUNE,
      reviewDueOn: addDays(TODAY, 90),
      activity: 'Packaging and labels',
      reason: 'The line moved to Pune',
    });
    expect(moved).toMatchObject({ ownerId: PERSON.rohan, unitId: PUNE, version: 2 });
    const events = isoEvents(app, item.id).slice(1);
    expect(events.map((e) => e.action)).toEqual(['REASSIGN', 'DUE_DATE_CHANGE', 'UPDATE']);
    expect(events[0]).toMatchObject({
      before: { ownerId: PERSON.sameer },
      after: { ownerId: PERSON.rohan },
      reason: 'The line moved to Pune',
    });
    expect(events[1]).toMatchObject({
      before: { reviewDueOn: null },
      after: { reviewDueOn: addDays(TODAY, 90) },
      reason: 'The line moved to Pune',
    });
    expect(events[2]!.after).toEqual({ unitId: PUNE, activity: 'Packaging and labels' });
    expect(events[2]!.reason).toBeNull();
  });

  it('needs a reason for a new owner or a moved review date, and audits it (decision 51 p)', async () => {
    const item = await createRisk(all, { reviewDueOn: addDays(TODAY, 30) });
    // Each reason field, alone, beside a plain field, cleared, or with a blank reason: 422 and nothing written.
    for (const change of [
      { ownerId: PERSON.kabir },
      { reviewDueOn: addDays(TODAY, 60) },
      { reviewDueOn: null },
      { ownerId: PERSON.kabir, severity: 4 },
      { reviewDueOn: addDays(TODAY, 60), reason: '' },
    ]) {
      await fails(
        app,
        'updateIsoRisk',
        { params: riskParams(item), body: { version: item.version, ...change } },
        'REASON_REQUIRED',
        422,
      );
    }
    expect((await getRisk(item)).version).toBe(1);
    expect(isoEvents(app, item.id)).toHaveLength(1);
    // With a reason, each change is 200 and its event carries the reason.
    const owned = await updateRisk(item, {
      ownerId: PERSON.kabir,
      reason: 'Kabir took purchasing',
    });
    expect(owned).toMatchObject({ ownerId: PERSON.kabir, version: 2 });
    expect(lastEvent(item.id)).toMatchObject({
      action: 'REASSIGN',
      before: { ownerId: PERSON.sameer },
      after: { ownerId: PERSON.kabir },
      reason: 'Kabir took purchasing',
    });
    const moved = await updateRisk(owned, {
      reviewDueOn: addDays(TODAY, 60),
      reason: 'Supplier audit moved',
    });
    expect(moved).toMatchObject({ reviewDueOn: addDays(TODAY, 60), version: 3 });
    expect(lastEvent(item.id)).toMatchObject({
      action: 'DUE_DATE_CHANGE',
      before: { reviewDueOn: addDays(TODAY, 30) },
      after: { reviewDueOn: addDays(TODAY, 60) },
      reason: 'Supplier audit moved',
    });
    // A plain field edit needs no reason; its UPDATE has none.
    const rerated = await updateRisk(moved, { activity: 'Packaging and cartons' });
    expect(rerated).toMatchObject({ activity: 'Packaging and cartons', version: 4 });
    expect(lastEvent(item.id)).toMatchObject({
      action: 'UPDATE',
      before: { activity: 'Packaging supply' },
      after: { activity: 'Packaging and cartons' },
      reason: null,
    });
    expect(isoEvents(app, item.id).map((e) => e.action)).toEqual([
      'CREATE',
      'REASSIGN',
      'DUE_DATE_CHANGE',
      'UPDATE',
    ]);
  });

  it('writes nothing when nothing changes', async () => {
    const item = await createRisk();
    const same = await updateRisk(item, { likelihood: item.likelihood });
    expect(same.version).toBe(1);
    expect(isoEvents(app, item.id)).toHaveLength(1);
  });

  it('keeps the kind rules, the unit and the owner (400 VALIDATION)', async () => {
    const aspect = await createRisk(all, ASPECT);
    const hazard = await createRisk(all, HAZARD);
    const risk = await createRisk(blr, { unitId: BENGALURU });
    for (const [item, body, path] of [
      [aspect, { impact: null }, 'impact'],
      [aspect, { lifeCycleStages: [] }, 'lifeCycleStages'],
      [hazard, { personsExposed: [] }, 'personsExposed'],
      [hazard, { routine: null }, 'routine'],
      [risk, { controlType: 'CONTROL' }, 'controlType'],
      [risk, { residualSeverity: 3 }, 'residualSeverity'],
      [risk, { unitId: PUNE }, 'unitId'],
      [aspect, { ownerId: PERSON.joseph, reason: 'Hand over' }, 'ownerId'],
      [aspect, { ownerId: PERSON.rohan, unitId: BENGALURU, reason: 'Hand over' }, 'ownerId'],
      [aspect, { obligationIds: [activity] }, 'obligationIds'],
    ] as const) {
      const error = await fails(
        app,
        'updateIsoRisk',
        { params: riskParams(item), body: { version: item.version, ...body } },
        'VALIDATION',
        400,
      );
      expect(error.error.details).toMatchObject({ issues: [{ path: ['body', path] }] });
    }
    // `kind` never changes.
    await fails(
      app,
      'updateIsoRisk',
      { params: riskParams(risk), body: { version: 1, kind: 'OPPORTUNITY' } },
      'VALIDATION',
      400,
    );
    const moved = await updateRisk(risk, { unitId: null });
    expect(moved.unitId).toBeNull();
  });

  it('refuses a stale version', async () => {
    const item = await createRisk();
    await updateRisk(item, { severity: 4 });
    const error = await fails(
      app,
      'updateIsoRisk',
      { params: riskParams(item), body: { version: 1, severity: 5 } },
      'STALE_VERSION',
      409,
    );
    expect(error.error.details).toEqual({ currentVersion: 2 });
  });

  it('lets managers and the owner edit, and no one else', async () => {
    let item = await createRisk(all, { unitId: PUNE });
    for (const as of [PERSON.arjun, PERSON.kabir, PERSON.sameer]) {
      item = await updateRisk(item, { severity: item.severity === 3 ? 4 : 3 }, as);
    }
    for (const as of [PERSON.rohan, PERSON.nisha, PERSON.divya, PERSON.vikram]) {
      await fails(
        app,
        'updateIsoRisk',
        { as, params: riskParams(item), body: { version: item.version, severity: 1 } },
        'FORBIDDEN',
        403,
      );
    }
    const bengaluru = await createRisk(all, { unitId: BENGALURU });
    await fails(
      app,
      'updateIsoRisk',
      { as: PERSON.rohan, params: riskParams(bengaluru), body: { version: 1, severity: 1 } },
      'NOT_FOUND',
      404,
    );
  });
});

describe('archiveIsoRisk', () => {
  it('archives with its reason; the item then answers 404', async () => {
    const item = await createRisk();
    const archived = await ok<Risk>(app, 'archiveIsoRisk', {
      as: PERSON.sameer,
      params: riskParams(item),
      body: { version: 1, reason: 'Second supplier qualified' },
    });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.reviewStatus.timing).toBe('CLOSED');
    expect(lastEvent(item.id)).toMatchObject({
      action: 'ARCHIVE',
      entityType: 'risk_item',
      reason: 'Second supplier qualified',
      after: { archivedAt: archived.archivedAt },
    });
    await fails(app, 'getIsoRisk', { params: riskParams(item) }, 'NOT_FOUND', 404);
    await fails(
      app,
      'updateIsoRisk',
      { params: riskParams(item), body: { version: 2, severity: 1 } },
      'NOT_FOUND',
      404,
    );
  });

  it('needs a current version, a reason and a writer', async () => {
    const item = await createRisk();
    await fails(
      app,
      'archiveIsoRisk',
      { params: riskParams(item), body: { version: 2, reason: 'Gone' } },
      'STALE_VERSION',
      409,
    );
    await fails(
      app,
      'archiveIsoRisk',
      { params: riskParams(item), body: { version: 1 } },
      'REASON_REQUIRED',
      422,
    );
    for (const as of [PERSON.divya, PERSON.vikram, PERSON.rohan]) {
      await fails(
        app,
        'archiveIsoRisk',
        { as, params: riskParams(item), body: { version: 1, reason: 'Gone' } },
        'FORBIDDEN',
        403,
      );
    }
  });
});

describe('reviewIsoRisk', () => {
  it('sets lastReviewedOn and the next review date, nothing else', async () => {
    const item = await createRisk(all, { reviewDueOn: addDays(TODAY, -1) });
    const next = addDays(TODAY, 180);
    const reviewed = await ok<Risk>(app, 'reviewIsoRisk', {
      as: PERSON.sameer,
      params: riskParams(item),
      body: { version: 1, nextReviewDueOn: next, note: 'Still one supplier' },
    });
    expect(reviewed).toMatchObject({
      lastReviewedOn: TODAY,
      reviewDueOn: next,
      rating: item.rating,
      version: 2,
      reviewStatus: { timing: 'ON_TIME', overdueDays: null },
    });
    const event = lastEvent(item.id);
    expect(event).toMatchObject({
      action: 'TRANSITION',
      entityType: 'risk_item',
      before: { lastReviewedOn: null, reviewDueOn: addDays(TODAY, -1) },
      after: {
        action: 'REVIEW',
        lastReviewedOn: TODAY,
        reviewDueOn: next,
        note: 'Still one supplier',
      },
    });
    expect(event.after).not.toHaveProperty('delegated');
  });

  it('marks a manager’s review as delegated', async () => {
    const item = await createRisk();
    await ok(app, 'reviewIsoRisk', {
      as: PERSON.kabir,
      params: riskParams(item),
      body: { version: 1, nextReviewDueOn: addDays(TODAY, 30) },
    });
    expect(lastEvent(item.id).after).toMatchObject({ action: 'REVIEW', delegated: true });
    expect(lastEvent(item.id).after).not.toHaveProperty('note');
  });

  it('needs a later date, a current version and the owner or a manager', async () => {
    const item = await createRisk();
    const review = (body: Record<string, unknown>, as: string = PERSON.meera) =>
      call(app, 'reviewIsoRisk', { as, params: riskParams(item), body });
    expect((await review({ version: 1, nextReviewDueOn: TODAY })).status).toBe(400);
    expect((await review({ version: 2, nextReviewDueOn: addDays(TODAY, 9) })).status).toBe(409);
    for (const as of [PERSON.divya, PERSON.vikram, PERSON.rohan]) {
      expect((await review({ version: 1, nextReviewDueOn: addDays(TODAY, 9) }, as)).status).toBe(
        403,
      );
    }
  });
});

describe('setIsoRiskSignificance', () => {
  const override = (item: Risk, significantOverride: boolean | null, as: string = PERSON.meera) =>
    ok<Risk>(app, 'setIsoRiskSignificance', {
      as,
      params: riskParams(item),
      body: { version: item.version, significantOverride, reason: 'Panel decision' },
    });

  it('sets and clears the override with its reason, audited', async () => {
    const item = await createRisk();
    const raised = await override(item, true);
    expect(raised).toMatchObject({
      significant: true,
      significantOverride: true,
      significanceReason: 'Panel decision',
      version: 2,
    });
    expect(lastEvent(item.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'risk_item',
      reason: 'Panel decision',
      before: { significantOverride: null, significanceReason: null, significant: false },
      after: { significantOverride: true, significant: true },
    });
    // A re-rating keeps the override.
    const rerated = await updateRisk(raised, { likelihood: 1 });
    expect(rerated).toMatchObject({ rating: 3, significant: true });
    const cleared = await override(rerated, null, PERSON.kabir);
    expect(cleared).toMatchObject({
      significant: false,
      significantOverride: null,
      significanceReason: null,
    });
    expect(lastEvent(item.id).reason).toBe('Panel decision');
    // Clearing again changes nothing and writes nothing.
    const again = await override(cleared, null);
    expect(again.version).toBe(cleared.version);
  });

  it('lowers a high rating when the override says so', async () => {
    const item = await createRisk(all, { likelihood: 5, severity: 5 });
    expect((await override(item, false, PERSON.arjun)).significant).toBe(false);
  });

  it('is for FA, CO and CA only, with a reason and a current version', async () => {
    const item = await createRisk(all, { unitId: BENGALURU });
    const body = { version: 1, significantOverride: true, reason: 'Panel decision' };
    for (const as of [PERSON.sameer, PERSON.divya, PERSON.vikram]) {
      await fails(
        app,
        'setIsoRiskSignificance',
        { as, params: riskParams(item), body },
        'FORBIDDEN',
        403,
      );
    }
    await fails(
      app,
      'setIsoRiskSignificance',
      { as: PERSON.rohan, params: riskParams(item), body },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'setIsoRiskSignificance',
      { params: riskParams(item), body: { version: 1, significantOverride: true } },
      'REASON_REQUIRED',
      422,
    );
    await fails(
      app,
      'setIsoRiskSignificance',
      { params: riskParams(item), body: { ...body, version: 3 } },
      'STALE_VERSION',
      409,
    );
  });
});

// ---------- controls ----------

describe('risk controls', () => {
  const controlParams = (item: Risk, control?: Control) => ({
    ...riskParams(item),
    ...(control === undefined ? {} : { controlId: control.id }),
  });
  const addControl = (item: Risk, body: Record<string, unknown>, as: string = PERSON.meera) =>
    ok<Control>(app, 'createIsoRiskControl', { as, params: controlParams(item), body });
  const controls = (item: Risk, as: string = PERSON.meera) =>
    ok<{ items: Control[] }>(app, 'listIsoRiskControls', { as, params: controlParams(item) });

  it('adds, lists, changes and archives controls in place, each audited', async () => {
    const item = await createRisk(all, { ...HAZARD, unitId: PUNE });
    const guard = await addControl(
      item,
      { text: 'Barrier between dock and walkway', hierarchy: 'ENGINEERING' },
      PERSON.sameer,
    );
    expect(guard).toMatchObject({
      riskItemId: item.id,
      hierarchy: 'ENGINEERING',
      sourceActionId: null,
      version: 1,
    });
    expect(lastEvent(guard.id)).toMatchObject({
      action: 'CREATE',
      entityType: 'risk_control',
      after: { riskItemId: item.id, text: 'Barrier between dock and walkway' },
    });
    const vests = await addControl(item, { text: 'High-visibility vests', hierarchy: 'PPE' });
    expect(ids((await controls(item, PERSON.nisha)).items)).toEqual([guard.id, vests.id]);

    const changed = await ok<Control>(app, 'updateIsoRiskControl', {
      as: PERSON.sameer,
      params: controlParams(item, guard),
      body: { version: 1, text: 'Steel barrier between dock and walkway' },
    });
    expect(changed).toMatchObject({ version: 2, text: 'Steel barrier between dock and walkway' });
    expect(lastEvent(guard.id)).toMatchObject({ action: 'UPDATE', entityType: 'risk_control' });

    const archived = await ok<Control>(app, 'archiveIsoRiskControl', {
      params: controlParams(item, vests),
      body: { version: 1, reason: 'Replaced by the barrier' },
    });
    expect(archived.archivedAt).not.toBeNull();
    expect(lastEvent(vests.id)).toMatchObject({
      action: 'ARCHIVE',
      entityType: 'risk_control',
      reason: 'Replaced by the barrier',
    });
    expect(ids((await controls(item)).items)).toEqual([guard.id]);
    await fails(
      app,
      'updateIsoRiskControl',
      { params: controlParams(item, vests), body: { version: 2, text: 'Back' } },
      'NOT_FOUND',
      404,
    );
  });

  it('needs a hierarchy on a HAZARD only', async () => {
    const hazard = await createRisk(all, HAZARD);
    const risk = await createRisk();
    await fails(
      app,
      'createIsoRiskControl',
      { params: controlParams(hazard), body: { text: 'Training' } },
      'VALIDATION',
      400,
    );
    const training = await addControl(hazard, { text: 'Training', hierarchy: 'ADMINISTRATIVE' });
    await fails(
      app,
      'updateIsoRiskControl',
      { params: controlParams(hazard, training), body: { version: 1, hierarchy: null } },
      'VALIDATION',
      400,
    );
    const plain = await addControl(risk, { text: 'Second supplier approved' });
    expect(plain.hierarchy).toBeNull();
  });

  it('refuses a stale version and another item’s control', async () => {
    const item = await createRisk();
    const other = await createRisk();
    const control = await addControl(item, { text: 'Safety stock of cartons' });
    await fails(
      app,
      'updateIsoRiskControl',
      { params: controlParams(item, control), body: { version: 2, text: 'Stock' } },
      'STALE_VERSION',
      409,
    );
    await fails(
      app,
      'archiveIsoRiskControl',
      { params: controlParams(item, control), body: { version: 2, reason: 'Gone' } },
      'STALE_VERSION',
      409,
    );
    await fails(
      app,
      'updateIsoRiskControl',
      { params: controlParams(other, control), body: { version: 1, text: 'Stock' } },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'archiveIsoRiskControl',
      { params: controlParams(other, control), body: { version: 1, reason: 'Gone' } },
      'NOT_FOUND',
      404,
    );
  });

  it('lets managers and the item owner write, and keeps unit scope', async () => {
    const item = await createRisk(all, { unitId: PUNE });
    const control = await addControl(item, { text: 'Supplier audit' }, PERSON.kabir);
    for (const as of [PERSON.rohan, PERSON.divya, PERSON.nisha, PERSON.vikram]) {
      await fails(
        app,
        'createIsoRiskControl',
        { as, params: controlParams(item), body: { text: 'More' } },
        'FORBIDDEN',
        403,
      );
      await fails(
        app,
        'updateIsoRiskControl',
        { as, params: controlParams(item, control), body: { version: 1, text: 'More' } },
        'FORBIDDEN',
        403,
      );
      await fails(
        app,
        'archiveIsoRiskControl',
        { as, params: controlParams(item, control), body: { version: 1, reason: 'Gone' } },
        'FORBIDDEN',
        403,
      );
    }
    const bengaluru = await createRisk(all, { unitId: BENGALURU });
    await fails(
      app,
      'listIsoRiskControls',
      { as: PERSON.nisha, params: controlParams(bengaluru) },
      'NOT_FOUND',
      404,
    );
    expect((await controls(bengaluru, PERSON.vikram)).items).toEqual([]);
  });
});

// ---------- objectives ----------

const OBJECTIVE = {
  standards: ['ISO_9001'],
  text: 'Raise on-time delivery',
  target: 95,
  unitOfMeasure: '%',
  baseline: 80,
  direction: 'INCREASE',
  readingRule: { kind: 'ONGOING_REVIEW', every: 'MONTH' },
  ownerId: PERSON.sameer,
  dueOn: '2025-03-31',
};

function createObjective(
  system: System = all,
  body: Record<string, unknown> = {},
  as: string = PERSON.meera,
): Promise<Objective> {
  return ok<Objective>(app, 'createIsoObjective', {
    as,
    params: { clientId: system.clientId },
    body: { managementSystemId: system.id, ...OBJECTIVE, ...body },
  });
}

const objParams = (objective: { id: string; clientId: string }, reading?: { id: string }) => ({
  clientId: objective.clientId,
  id: objective.id,
  ...(reading === undefined ? {} : { readingId: reading.id }),
});

const getObjective = (objective: { id: string; clientId: string }, as: string = PERSON.meera) =>
  ok<Objective>(app, 'getIsoObjective', { as, params: objParams(objective) });

const addReading = (
  objective: { id: string; clientId: string },
  body: Record<string, unknown>,
  as: string = PERSON.meera,
) => ok<Reading>(app, 'createIsoReading', { as, params: objParams(objective), body });

const month = (start: string, value: number) => {
  const [y, m] = start.split('-').map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { periodStart: start, periodEnd: end, value };
};

/** An objective written straight into the store, so it can have been set months before today. */
function seedObjective(fields: Partial<IsoRow<'objectives'>> = {}): IsoRow<'objectives'> {
  return seed(app, 'objectives', {
    ...base(),
    createdAt: '2024-04-01T06:30:00Z',
    managementSystemId: all.id,
    standards: ['ISO_9001'],
    text: 'Seeded objective',
    target: 95,
    unitOfMeasure: '%',
    baseline: 80,
    direction: 'INCREASE',
    readingRule: { kind: 'ONGOING_REVIEW', every: 'MONTH' },
    riskItemIds: [],
    ownerId: PERSON.sameer,
    dueOn: '2025-03-31',
    closedOn: null,
    outcome: null,
    ...fields,
  });
}

describe('createIsoObjective', () => {
  it('adds an open objective with empty progress, audited as CREATE', async () => {
    const risk = await createRisk();
    const objective = await createObjective(all, {
      standards: ['ISO_9001', 'ISO_45001'],
      riskItemIds: [risk.id],
    });
    expect(objective).toMatchObject({
      clientId: NORTHWIND,
      managementSystemId: all.id,
      standards: ['ISO_9001', 'ISO_45001'],
      riskItemIds: [risk.id],
      closedOn: null,
      outcome: null,
      version: 1,
      progress: {
        objectiveId: objective.id,
        latestValue: null,
        latestPeriodEnd: null,
        progressPercent: null,
        onTrack: null,
        missedReadings: [],
      },
    });
    expect(isoEvents(app, objective.id)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        entityType: 'objective',
        after: expect.objectContaining({ text: OBJECTIVE.text, riskItemIds: [risk.id] }),
      }),
    ]);
  });

  it('checks the standards, the risk items and the owner', async () => {
    const elsewhere = await createRisk(blr);
    const archived = await createRisk(quality);
    await ok(app, 'archiveIsoRisk', {
      params: riskParams(archived),
      body: { version: 1, reason: 'Gone' },
    });
    for (const [extra, path] of [
      [{ standards: ['ISO_14001'] }, 'standards'],
      [{ riskItemIds: [elsewhere.id] }, 'riskItemIds'],
      [{ riskItemIds: [archived.id] }, 'riskItemIds'],
      [{ ownerId: PERSON.joseph }, 'ownerId'],
      [{ ownerId: PERSON.gita }, 'ownerId'],
    ] as const) {
      const error = await fails(
        app,
        'createIsoObjective',
        { body: { managementSystemId: quality.id, ...OBJECTIVE, ...extra } },
        'VALIDATION',
        400,
      );
      expect(error.error.details).toMatchObject({ issues: [{ path: ['body', path] }] });
    }
  });

  it('keeps the target on the direction’s side of the baseline (400 VALIDATION on target)', async () => {
    const before = firmB(app).iso.objectives.length;
    for (const extra of [
      { direction: 'INCREASE', baseline: 10, target: 5 },
      { direction: 'DECREASE', baseline: 5, target: 10 },
    ]) {
      const error = await fails(
        app,
        'createIsoObjective',
        { body: { managementSystemId: all.id, ...OBJECTIVE, ...extra } },
        'VALIDATION',
        400,
      );
      expect(error.error.details).toMatchObject({ issues: [{ path: ['body', 'target'] }] });
    }
    expect(firmB(app).iso.objectives).toHaveLength(before);
    // A target equal to the baseline is a level to hold; MAINTAIN, or no baseline, takes any target.
    for (const extra of [
      { direction: 'INCREASE', baseline: 95, target: 95 },
      { direction: 'DECREASE', baseline: 0, target: 0 },
      { direction: 'MAINTAIN', baseline: 10, target: 5 },
      { direction: 'INCREASE', baseline: null, target: 5 },
    ]) {
      expect(await createObjective(all, extra)).toMatchObject({ target: extra.target, version: 1 });
    }
  });

  it('lets FA, CO and CA add objectives, and an owner only as its owner', async () => {
    await createObjective(all, {}, PERSON.arjun);
    await createObjective(all, {}, PERSON.kabir);
    await createObjective(all, {}, PERSON.sameer);
    await createObjective(all, { ownerId: PERSON.rohan }, PERSON.rohan);
    const body = { managementSystemId: all.id, ...OBJECTIVE, ownerId: PERSON.kabir };
    for (const as of [PERSON.sameer, PERSON.divya, PERSON.vikram]) {
      await fails(app, 'createIsoObjective', { as, body }, 'FORBIDDEN', 403);
    }
    await fails(app, 'createIsoObjective', { as: PERSON.leela, body }, 'NOT_FOUND', 404);
    await fails(
      app,
      'createIsoObjective',
      { as: PERSON.rohan, body: { ...body, managementSystemId: blr.id, ownerId: PERSON.rohan } },
      'NOT_FOUND',
      404,
    );
  });
});

describe('getIsoObjective and listIsoObjectives', () => {
  let goals: System;
  let early: Objective;
  let late: Objective;
  let safety: Objective;
  let closed: Objective;

  beforeAll(async () => {
    goals = seedSystem(app, { name: 'Objectives list', unitIds: [PUNE] });
    late = await createObjective(goals, { dueOn: '2025-12-31', text: 'Cut energy use' });
    early = await createObjective(goals, { dueOn: '2025-01-31', ownerId: PERSON.rohan });
    safety = await createObjective(goals, {
      standards: ['ISO_45001'],
      dueOn: '2025-06-30',
      direction: 'DECREASE',
      baseline: 12,
      target: 4,
      text: 'Fewer first-aid cases',
    });
    const done = await createObjective(goals, { dueOn: '2025-02-28' });
    closed = await ok<Objective>(app, 'closeIsoObjective', {
      params: objParams(done),
      body: { version: 1, closedOn: TODAY, outcome: 'ACHIEVED' },
    });
  });

  const of = (query: Record<string, string> = {}, as: string = PERSON.meera) =>
    ok<{ items: Objective[] }>(app, 'listIsoObjectives', {
      as,
      query: { managementSystemId: goals.id, ...query },
    }).then((p) => ids(p.items));

  it('lists by due date and applies every filter', async () => {
    expect(await of()).toEqual([early.id, closed.id, safety.id, late.id]);
    expect(await of({ open: 'true' })).toEqual([early.id, safety.id, late.id]);
    expect(await of({ open: 'false' })).toEqual([closed.id]);
    expect(await of({ standard: 'ISO_45001,ISO_14001' })).toEqual([safety.id]);
    expect(await of({ ownerId: PERSON.rohan })).toEqual([early.id]);
    expect(await of({ ownerId: 'me' }, PERSON.rohan)).toEqual([early.id]);
    expect(await of({ q: 'ENERGY' })).toEqual([late.id]);
  });

  it('narrows to the ids given, in list order, within the other filters and the reader’s units (ISO-1a4)', async () => {
    const other = await createObjective(harbour, { ownerId: PERSON.joseph });
    const hidden = await createObjective(blr, { text: 'Office water use' });
    const named = async (rows: { id: string }[], query = {}, as: string = PERSON.meera) =>
      ids(
        (
          await ok<{ items: Objective[] }>(app, 'listIsoObjectives', {
            as,
            query: { ids: ids(rows).join(','), ...query },
          })
        ).items,
      );
    expect(await named([late, closed, early])).toEqual([early.id, closed.id, late.id]);
    expect(await named([late, closed, early], { open: 'true' })).toEqual([early.id, late.id]);
    expect(await named([other, safety])).toEqual([safety.id]);
    expect(await named([hidden, early], {}, PERSON.rohan)).toEqual([early.id]);
  });

  it('keeps AP and OW to their system’s units and the objectives they own', async () => {
    expect(await of({}, PERSON.nisha)).toHaveLength(4);
    const bengaluru = await createObjective(blr, { text: 'Office paper use' });
    const named = await createObjective(blr, { ownerId: PERSON.rohan });
    const listed = await ok<{ items: Objective[] }>(app, 'listIsoObjectives', {
      as: PERSON.rohan,
      query: { managementSystemId: blr.id },
    });
    expect(ids(listed.items)).toContain(named.id);
    expect(ids(listed.items)).not.toContain(bengaluru.id);
    expect((await getObjective(named, PERSON.rohan)).id).toBe(named.id);
    for (const as of [PERSON.rohan, PERSON.nisha, PERSON.leela]) {
      await fails(app, 'getIsoObjective', { as, params: objParams(bengaluru) }, 'NOT_FOUND', 404);
    }
    for (const as of [PERSON.divya, PERSON.vikram, PERSON.arjun, PERSON.kabir, PERSON.sameer]) {
      expect((await getObjective(bengaluru, as)).id).toBe(bengaluru.id);
    }
    await fails(app, 'listIsoObjectives', { as: PERSON.leela }, 'NOT_FOUND', 404);
  });

  it('answers 404 for an unknown objective or another client', async () => {
    const other = await createObjective(harbour, { ownerId: PERSON.joseph });
    await fails(app, 'getIsoObjective', { params: { id: other.id } }, 'NOT_FOUND', 404);
    await fails(app, 'getIsoObjective', { params: { id: seedId() } }, 'NOT_FOUND', 404);
    expect((await getObjective(other, PERSON.leela)).clientId).toBe(HARBOUR);
  });
});

describe('updateIsoObjective', () => {
  const update = (objective: Objective, body: Record<string, unknown>, as: string = PERSON.meera) =>
    ok<Objective>(app, 'updateIsoObjective', {
      as,
      params: objParams(objective),
      body: { version: objective.version, ...body },
    });

  it('audits field edits as UPDATE, a new owner as REASSIGN and a new due date with its reason', async () => {
    const objective = await createObjective();
    const risk = await createRisk();
    const changed = await update(objective, {
      text: 'Raise on-time delivery to key customers',
      riskItemIds: [risk.id],
      standards: ['ISO_9001', 'ISO_14001'],
      ownerId: PERSON.rohan,
      dueOn: '2025-06-30',
      reason: 'Customer asked for a later review',
    });
    expect(changed).toMatchObject({
      version: 2,
      ownerId: PERSON.rohan,
      dueOn: '2025-06-30',
      riskItemIds: [risk.id],
    });
    const events = isoEvents(app, objective.id).slice(1);
    expect(events.map((e) => e.action)).toEqual(['REASSIGN', 'DUE_DATE_CHANGE', 'UPDATE']);
    expect(events[0]).toMatchObject({
      before: { ownerId: PERSON.sameer },
      after: { ownerId: PERSON.rohan },
      reason: 'Customer asked for a later review',
    });
    expect(events[1]).toMatchObject({
      before: { dueOn: OBJECTIVE.dueOn },
      after: { dueOn: '2025-06-30' },
      reason: 'Customer asked for a later review',
    });
    expect(events[2]!.reason).toBeNull();
    const same = await update(changed, { text: changed.text });
    expect(same.version).toBe(2);
  });

  it('needs a reason for a new owner or a moved due date, and audits it (decision 51 p)', async () => {
    const objective = await createObjective();
    // Each reason field, alone, beside a plain field, or with a blank reason: 422 and nothing written.
    for (const change of [
      { ownerId: PERSON.rohan },
      { dueOn: '2025-06-30' },
      { ownerId: PERSON.rohan, target: 97 },
      { dueOn: '2025-06-30', reason: ' ' },
    ]) {
      await fails(
        app,
        'updateIsoObjective',
        { params: objParams(objective), body: { version: objective.version, ...change } },
        'REASON_REQUIRED',
        422,
      );
    }
    expect((await getObjective(objective)).version).toBe(1);
    expect(isoEvents(app, objective.id)).toHaveLength(1);
    // With a reason, each change is 200 and its event carries the reason.
    const owned = await update(objective, { ownerId: PERSON.rohan, reason: 'Rohan runs dispatch' });
    expect(owned).toMatchObject({ ownerId: PERSON.rohan, version: 2 });
    expect(lastEvent(objective.id)).toMatchObject({
      action: 'REASSIGN',
      before: { ownerId: PERSON.sameer },
      after: { ownerId: PERSON.rohan },
      reason: 'Rohan runs dispatch',
    });
    const moved = await update(owned, { dueOn: '2025-06-30', reason: 'Budget year changed' });
    expect(moved).toMatchObject({ dueOn: '2025-06-30', version: 3 });
    expect(lastEvent(objective.id)).toMatchObject({
      action: 'DUE_DATE_CHANGE',
      before: { dueOn: OBJECTIVE.dueOn },
      after: { dueOn: '2025-06-30' },
      reason: 'Budget year changed',
    });
    // A plain field edit needs no reason; its UPDATE has none.
    const raised = await update(moved, { target: 97 });
    expect(raised).toMatchObject({ target: 97, version: 4 });
    expect(lastEvent(objective.id)).toMatchObject({
      action: 'UPDATE',
      before: { target: 95 },
      after: { target: 97 },
      reason: null,
    });
    expect(isoEvents(app, objective.id).map((e) => e.action)).toEqual([
      'CREATE',
      'REASSIGN',
      'DUE_DATE_CHANGE',
      'UPDATE',
    ]);
  });

  it('needs a reason to move dueOn, and checks standards, risk items and the owner', async () => {
    const objective = await createObjective(quality);
    const elsewhere = await createRisk(blr);
    const body = (extra: Record<string, unknown>) => ({
      params: objParams(objective),
      body: { version: 1, ...extra },
    });
    await fails(app, 'updateIsoObjective', body({ dueOn: '2025-09-30' }), 'REASON_REQUIRED', 422);
    await fails(app, 'updateIsoObjective', body({ ownerId: PERSON.rohan }), 'REASON_REQUIRED', 422);
    await fails(app, 'updateIsoObjective', body({ standards: ['ISO_45001'] }), 'VALIDATION', 400);
    await fails(
      app,
      'updateIsoObjective',
      body({ riskItemIds: [elsewhere.id] }),
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'updateIsoObjective',
      body({ ownerId: PERSON.vikram, reason: 'Hand over' }),
      'VALIDATION',
      400,
    );
    await fails(app, 'updateIsoObjective', body({ reason: 'Nothing else' }), 'VALIDATION', 400);
    await fails(
      app,
      'updateIsoObjective',
      { params: objParams(objective), body: { version: 2, text: 'Stale' } },
      'STALE_VERSION',
      409,
    );
  });

  it('keeps the merged target on the direction’s side of the baseline (400 VALIDATION on target)', async () => {
    // INCREASE from 80 to 95: a lower target, a DECREASE or a baseline above 95 each breaks it, alone.
    const objective = await createObjective();
    for (const change of [{ target: 70 }, { direction: 'DECREASE' }, { baseline: 99 }]) {
      const error = await fails(
        app,
        'updateIsoObjective',
        { params: objParams(objective), body: { version: 1, ...change } },
        'VALIDATION',
        400,
      );
      expect(error.error.details).toMatchObject({ issues: [{ path: ['body', 'target'] }] });
    }
    expect((await getObjective(objective)).version).toBe(1);
    expect(isoEvents(app, objective.id)).toHaveLength(1);
    // Changes that keep it: a DECREASE with its new target, MAINTAIN, a cleared baseline, a target equal to it.
    const lowered = await update(objective, { direction: 'DECREASE', target: 60 });
    expect(lowered).toMatchObject({ direction: 'DECREASE', baseline: 80, target: 60, version: 2 });
    await fails(
      app,
      'updateIsoObjective',
      { params: objParams(lowered), body: { version: 2, baseline: 50 } },
      'VALIDATION',
      400,
    );
    const held = await update(lowered, { direction: 'MAINTAIN', baseline: 10 });
    expect(held).toMatchObject({ direction: 'MAINTAIN', baseline: 10, target: 60, version: 3 });
    const unanchored = await update(held, { direction: 'INCREASE', baseline: null });
    expect(unanchored).toMatchObject({ baseline: null, target: 60, version: 4 });
    const level = await update(unanchored, { baseline: 60 });
    expect(level).toMatchObject({ direction: 'INCREASE', baseline: 60, target: 60, version: 5 });
  });

  it('lets managers and the owner edit, and no one else', async () => {
    let objective = await createObjective();
    for (const as of [PERSON.arjun, PERSON.kabir, PERSON.sameer]) {
      objective = await update(objective, { target: objective.target + 1 }, as);
    }
    for (const as of [PERSON.rohan, PERSON.divya, PERSON.nisha, PERSON.vikram]) {
      await fails(
        app,
        'updateIsoObjective',
        { as, params: objParams(objective), body: { version: objective.version, target: 1 } },
        'FORBIDDEN',
        403,
      );
    }
  });
});

describe('closeIsoObjective', () => {
  const close = (objective: Objective, body: Record<string, unknown>, as: string = PERSON.meera) =>
    call(app, 'closeIsoObjective', {
      as,
      params: objParams(objective),
      body: { version: objective.version, closedOn: TODAY, outcome: 'ACHIEVED', ...body },
    });

  it('records the outcome; the objective then takes no edits or readings', async () => {
    const objective = await createObjective();
    const reading = await addReading(objective, month('2024-11-01', 90));
    const closed = await ok<Objective>(app, 'closeIsoObjective', {
      as: PERSON.sameer,
      params: objParams(objective),
      body: { version: 1, closedOn: TODAY, outcome: 'NOT_ACHIEVED' },
    });
    expect(closed).toMatchObject({ closedOn: TODAY, outcome: 'NOT_ACHIEVED', version: 2 });
    const event = lastEvent(objective.id);
    expect(event).toMatchObject({
      action: 'TRANSITION',
      entityType: 'objective',
      before: { closedOn: null, outcome: null },
      after: { action: 'CLOSE', closedOn: TODAY, outcome: 'NOT_ACHIEVED' },
    });
    expect(event.after).not.toHaveProperty('delegated');

    const locked = { entity: 'objective', from: 'CLOSED', action: 'UPDATE' };
    const edit = await fails(
      app,
      'updateIsoObjective',
      { params: objParams(objective), body: { version: 2, text: 'Later' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(edit.error.details).toEqual(locked);
    const add = await fails(
      app,
      'createIsoReading',
      { params: objParams(objective), body: month('2024-10-01', 88) },
      'INVALID_TRANSITION',
      409,
    );
    expect(add.error.details).toEqual(locked);
    const fix = await fails(
      app,
      'updateIsoReading',
      { params: objParams(objective, reading), body: { version: 1, value: 91 } },
      'INVALID_TRANSITION',
      409,
    );
    expect(fix.error.details).toEqual(locked);
    const twice = await close(closed, {});
    expect(twice.status).toBe(409);
    expect(twice.json).toMatchObject({
      error: { details: { entity: 'objective', from: 'CLOSED', action: 'CLOSE' } },
    });
  });

  it('marks a manager’s close as delegated', async () => {
    const objective = await createObjective();
    expect((await close(objective, {}, PERSON.kabir)).status).toBe(200);
    expect(lastEvent(objective.id).after).toMatchObject({ action: 'CLOSE', delegated: true });
  });

  it('needs a date from creation to today, a current version and a writer', async () => {
    const objective = await createObjective();
    expect((await close(objective, { closedOn: addDays(TODAY, 1) })).status).toBe(400);
    expect((await close(objective, { closedOn: addDays(TODAY, -1) })).status).toBe(400);
    expect((await close(objective, { version: 2 })).status).toBe(409);
    expect((await close(objective, { outcome: 'PARTLY' })).status).toBe(400);
    for (const as of [PERSON.rohan, PERSON.divya, PERSON.vikram]) {
      expect((await close(objective, {}, as)).status).toBe(403);
    }
    const seeded = seedObjective();
    const view = await getObjective(seeded);
    const earlier = await ok<Objective>(app, 'closeIsoObjective', {
      params: objParams(view),
      body: { version: 1, closedOn: '2024-04-01', outcome: 'NOT_ACHIEVED' },
    });
    expect(earlier.closedOn).toBe('2024-04-01');
  });
});

// ---------- readings and progress ----------

describe('objective readings', () => {
  it('records, lists by period and corrects readings, each audited', async () => {
    const objective = await createObjective(all, { ownerId: PERSON.rohan });
    const october = await addReading(
      objective,
      { ...month('2024-10-01', 86), note: 'Two late lorries' },
      PERSON.rohan,
    );
    expect(october).toMatchObject({
      objectiveId: objective.id,
      periodStart: '2024-10-01',
      periodEnd: '2024-10-31',
      value: 86,
      note: 'Two late lorries',
      recordedById: PERSON.rohan,
      version: 1,
    });
    expect(lastEvent(october.id)).toMatchObject({
      action: 'CREATE',
      entityType: 'objective_reading',
      after: { objectiveId: objective.id, value: 86, recordedById: PERSON.rohan },
    });
    const september = await addReading(objective, month('2024-09-01', 84), PERSON.kabir);
    const listed = await ok<{ items: Reading[] }>(app, 'listIsoReadings', {
      as: PERSON.nisha,
      params: objParams(objective),
    });
    expect(ids(listed.items)).toEqual([september.id, october.id]);

    const fixed = await ok<Reading>(app, 'updateIsoReading', {
      as: PERSON.rohan,
      params: objParams(objective, october),
      body: { version: 1, value: 87, note: null },
    });
    expect(fixed).toMatchObject({ value: 87, note: null, version: 2, recordedById: PERSON.rohan });
    expect(lastEvent(october.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'objective_reading',
      before: { value: 86, note: 'Two late lorries' },
      after: { value: 87, note: null },
    });
    await fails(
      app,
      'updateIsoReading',
      { params: objParams(objective, october), body: { version: 1, value: 88 } },
      'STALE_VERSION',
      409,
    );
  });

  it('refuses a period not yet started, an overlapping period and a period running backwards', async () => {
    const objective = await createObjective();
    await addReading(objective, month('2024-10-01', 90));
    const future = await fails(
      app,
      'createIsoReading',
      { params: objParams(objective), body: month('2024-12-01', 90) },
      'VALIDATION',
      400,
    );
    expect(future.error.details).toMatchObject({ issues: [{ path: ['body', 'periodStart'] }] });
    const overlap = await fails(
      app,
      'createIsoReading',
      {
        params: objParams(objective),
        body: { periodStart: '2024-10-15', periodEnd: '2024-11-14', value: 91 },
      },
      'VALIDATION',
      400,
    );
    expect(overlap.error.details).toMatchObject({
      issues: [
        { path: ['body', 'periodStart'], message: expect.stringContaining('2024-10-01 to') },
      ],
    });
    await fails(
      app,
      'createIsoReading',
      {
        params: objParams(objective),
        body: { periodStart: '2024-09-30', periodEnd: '2024-09-01', value: 91 },
      },
      'VALIDATION',
      400,
    );
  });

  it('lets managers and the objective owner write, and keeps unit scope', async () => {
    const objective = await createObjective();
    const reading = await addReading(objective, month('2024-10-01', 90), PERSON.sameer);
    await addReading(objective, month('2024-09-01', 89), PERSON.arjun);
    for (const as of [PERSON.rohan, PERSON.divya, PERSON.vikram]) {
      await fails(
        app,
        'createIsoReading',
        { as, params: objParams(objective), body: month('2024-08-01', 80) },
        'FORBIDDEN',
        403,
      );
      await fails(
        app,
        'updateIsoReading',
        { as, params: objParams(objective, reading), body: { version: 1, value: 1 } },
        'FORBIDDEN',
        403,
      );
    }
    const other = await createObjective();
    await fails(
      app,
      'updateIsoReading',
      { params: objParams(other, reading), body: { version: 1, value: 1 } },
      'NOT_FOUND',
      404,
    );
    const bengaluru = await createObjective(blr);
    await fails(
      app,
      'listIsoReadings',
      { as: PERSON.nisha, params: objParams(bengaluru) },
      'NOT_FOUND',
      404,
    );
    expect(
      (
        await ok<{ items: Reading[] }>(app, 'listIsoReadings', {
          as: PERSON.vikram,
          params: objParams(bengaluru),
        })
      ).items,
    ).toEqual([]);
  });
});

describe('objective progress (model §5.1)', () => {
  /** Records one monthly reading per period start given, then reads the objective back. */
  async function withReadings(
    objective: IsoRow<'objectives'>,
    values: Record<string, number>,
  ): Promise<Objective> {
    for (const [start, value] of Object.entries(values)) {
      await addReading(objective, month(start, value));
    }
    return getObjective(objective);
  }

  it('reports the latest value, the way covered, whether it is on track and the missed months', async () => {
    const objective = seedObjective();
    const view = await withReadings(objective, {
      '2024-04-01': 81,
      '2024-05-01': 82,
      '2024-06-01': 84,
      '2024-08-01': 86,
      '2024-09-01': 88,
      '2024-10-01': 90,
    });
    // Baseline 80 to target 95: 90 covers 10 of 15. On 31 Oct the straight line from 80 on 1 Apr to 95 on 31 Mar
    // stands at about 88.8, so 90 is on track. July has no reading; November is not due until 30 Nov.
    expect(view.progress).toEqual({
      objectiveId: objective.id,
      latestValue: 90,
      latestPeriodEnd: '2024-10-31',
      progressPercent: 66.7,
      onTrack: true,
      missedReadings: [{ periodStart: '2024-07-01', periodEnd: '2024-07-31' }],
    });
    const behind = await withReadings(seedObjective(), { '2024-10-01': 85 });
    expect(behind.progress).toMatchObject({ progressPercent: 33.3, onTrack: false });
    expect(behind.progress.missedReadings).toHaveLength(6);
  });

  it('follows the direction, and works without a baseline', async () => {
    const decrease = await withReadings(
      seedObjective({ direction: 'DECREASE', baseline: 20, target: 10 }),
      { '2024-10-01': 12 },
    );
    expect(decrease.progress).toMatchObject({ progressPercent: 80, onTrack: true });
    const worse = await withReadings(
      seedObjective({ direction: 'DECREASE', baseline: 20, target: 10 }),
      { '2024-10-01': 25 },
    );
    expect(worse.progress).toMatchObject({ progressPercent: 0, onTrack: false });
    const unanchored = await withReadings(
      seedObjective({ direction: 'DECREASE', baseline: null, target: 5 }),
      { '2024-10-01': 7 },
    );
    expect(unanchored.progress).toMatchObject({ progressPercent: null, onTrack: false });
    const beyond = await withReadings(seedObjective({ baseline: null, target: 90 }), {
      '2024-10-01': 120,
    });
    expect(beyond.progress).toMatchObject({ progressPercent: null, onTrack: true });
    const past = await withReadings(seedObjective({ baseline: 50, target: 60 }), {
      '2024-10-01': 70,
    });
    expect(past.progress.progressPercent).toBe(100);
  });

  it('holds the target for MAINTAIN, or a target equal to the baseline', async () => {
    const held = await withReadings(
      seedObjective({ direction: 'MAINTAIN', baseline: 0, target: 0, unitOfMeasure: 'spills' }),
      { '2024-10-01': 0 },
    );
    expect(held.progress).toMatchObject({ progressPercent: 100, onTrack: true });
    const broken = await withReadings(
      seedObjective({ direction: 'MAINTAIN', baseline: 0, target: 0 }),
      { '2024-10-01': 1 },
    );
    expect(broken.progress).toMatchObject({ progressPercent: 0, onTrack: false });
    const flat = await withReadings(seedObjective({ baseline: 95, target: 95 }), {
      '2024-10-01': 96,
    });
    expect(flat.progress).toMatchObject({ progressPercent: 100 });
  });

  it('measures against the target once dueOn has passed or falls on the day it was set', async () => {
    const due = await withReadings(seedObjective({ dueOn: '2024-04-01' }), { '2024-04-01': 94 });
    expect(due.progress).toMatchObject({ onTrack: false, missedReadings: [] });
  });

  it('counts no missed readings for an event-driven rule, and stops at the closing date', async () => {
    const event = await getObjective(
      seedObjective({
        readingRule: { kind: 'EVENT_DRIVEN', trigger: 'A complaint', withinDays: 7 },
      }),
    );
    expect(event.progress.missedReadings).toEqual([]);
    const closed = await getObjective(
      seedObjective({ closedOn: '2024-06-15', outcome: 'NOT_ACHIEVED' }),
    );
    expect(closed.progress.missedReadings).toEqual([
      { periodStart: '2024-04-01', periodEnd: '2024-04-30' },
      { periodStart: '2024-05-01', periodEnd: '2024-05-31' },
    ]);
  });

  it('shows progress in lists', async () => {
    const objective = seedObjective({ text: 'Listed progress objective' });
    await addReading(objective, month('2024-10-01', 95));
    const page = await ok<{ items: Objective[] }>(app, 'listIsoObjectives', {
      query: { q: 'Listed progress objective' },
    });
    expect(page.items[0]!.progress).toMatchObject({
      latestValue: 95,
      progressPercent: 100,
      onTrack: true,
    });
  });
});
