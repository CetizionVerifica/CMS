// The mock's ISO document control (docs/iso/model.md §3.4, §4.2): documents, revisions, the maker-checker rule, unit
// scope with the revision-in-force exception (plan §3.3) and the audit trail (model §8).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentView, RevisionView } from '../src/api/iso.js';
import { addDays } from '../src/mock/iso/common.js';
import type { IsoRow } from '../src/mock/store.js';
import {
  type App,
  base,
  BENGALURU,
  call,
  clause,
  fails,
  FIRM_B,
  firmB,
  HARBOUR,
  isoApp,
  isoEvents,
  NORTHWIND,
  NOW,
  ok,
  PERSON,
  seed,
  seedId,
  seedSystem,
  TODAY,
} from './iso-harness.js';

let app: App;
/** Northwind, every unit; Northwind, Bengaluru only; Harbour; Northwind on ISO 9001 only. */
let all: IsoRow<'managementSystems'>;
let blr: IsoRow<'managementSystems'>;
let harbour: IsoRow<'managementSystems'>;
let quality: IsoRow<'managementSystems'>;

beforeAll(async () => {
  app = await isoApp();
  all = seedSystem(app);
  blr = seedSystem(app, { unitIds: [BENGALURU] });
  harbour = seedSystem(app, { clientId: HARBOUR });
  quality = seedSystem(app, { standards: ['ISO_9001'] });
});
afterAll(async () => {
  await app.close();
});

let n = 0;
const nextCode = () => `TST-${(++n).toString().padStart(3, '0')}`;

type Doc = DocumentView;
type Rev = RevisionView;

async function createDoc(
  system: IsoRow<'managementSystems'> = all,
  body: Record<string, unknown> = {},
  as: string = PERSON.meera,
): Promise<Doc> {
  return ok<Doc>(app, 'createIsoDocument', {
    as,
    params: { clientId: system.clientId },
    body: {
      managementSystemId: system.id,
      code: nextCode(),
      title: 'Quality policy',
      type: 'POLICY',
      ownerId: PERSON.sameer,
      approverId: PERSON.divya,
      ...body,
    },
  });
}

const getDoc = (doc: Doc, as: string = PERSON.meera) =>
  ok<Doc>(app, 'getIsoDocument', { as, params: { clientId: doc.clientId, id: doc.id } });

const revParams = (doc: Doc, rev?: Rev) => ({
  clientId: doc.clientId,
  id: doc.id,
  ...(rev === undefined ? {} : { revisionId: rev.id }),
});

const draft = (doc: Doc, revision: string, as: string = PERSON.sameer, changeNote = 'New issue') =>
  ok<Rev>(app, 'draftIsoRevision', {
    as,
    params: revParams(doc),
    body: { revision, changeNote },
  });

const submit = (doc: Doc, rev: Rev, as: string = PERSON.sameer) =>
  ok<Rev>(app, 'submitIsoRevision', {
    as,
    params: revParams(doc, rev),
    body: { version: rev.version },
  });

const approve = (doc: Doc, rev: Rev, as: string = PERSON.divya) =>
  ok<Rev>(app, 'approveIsoRevision', {
    as,
    params: revParams(doc, rev),
    body: { version: rev.version },
  });

const revisions = (doc: Doc, as: string = PERSON.meera) =>
  ok<{ items: Rev[] }>(app, 'listIsoRevisions', { as, params: revParams(doc) });

/** A file on a revision, written straight into the store as the file routes would leave it. */
function seedFile(
  rev: Rev,
  options: { scanStatus?: 'PENDING' | 'CLEAN' | 'INFECTED'; archived?: boolean } = {},
) {
  const archived = options.archived === true;
  return seed(app, 'files', {
    id: seedId(),
    firmId: FIRM_B,
    clientId: rev.clientId,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: archived ? NOW : null,
    fileName: 'procedure.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    sha256: 'a'.repeat(64),
    scanStatus: options.scanStatus ?? 'CLEAN',
    uploadedById: PERSON.sameer,
    uploadedAt: NOW,
    removeReason: archived ? 'Wrong file' : null,
    clauseAssessmentId: null,
    documentRevisionId: rev.id,
    riskItemId: null,
    objectiveReadingId: null,
    internalAuditId: null,
    auditFindingId: null,
    externalAuditId: null,
    certificationId: null,
    nonconformityId: null,
    isoActionId: null,
    managementReviewId: null,
    storageKey: `evidence/${FIRM_B}/${rev.clientId}/iso/document_revision/${rev.id}/upload`,
  });
}

/** A document whose revision `label` its owner drafted and submitted with a clean file, and divya approved. */
async function approvedDoc(
  system: IsoRow<'managementSystems'> = all,
  body: Record<string, unknown> = {},
): Promise<{ doc: Doc; rev: Rev }> {
  const doc = await createDoc(system, body);
  const drafted = await draft(doc, 'A');
  seedFile(drafted);
  const rev = await approve(doc, await submit(doc, drafted));
  return { doc: await getDoc(doc), rev };
}

const lastEvent = (id: string) => isoEvents(app, id).at(-1)!;

describe('createIsoDocument', () => {
  it('adds an ACTIVE document with no revision, audited as CREATE', async () => {
    const doc = await createDoc(all, {
      clauseIds: [clause('ISO_9001', '5.2')],
      reviewDueOn: addDays(TODAY, 300),
    });
    expect(doc).toMatchObject({
      clientId: NORTHWIND,
      managementSystemId: all.id,
      status: 'ACTIVE',
      currentRevisionId: null,
      currentRevision: null,
      openRevisionId: null,
      lastReviewedOn: null,
      version: 1,
      reviewStatus: { timing: 'ON_TIME', overdueDays: null },
      allowedActions: ['DRAFT_REVISION'],
    });
    const events = isoEvents(app, doc.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'CREATE',
      entityType: 'controlled_document',
      actorId: PERSON.meera,
      after: { code: doc.code, ownerId: PERSON.sameer, approverId: PERSON.divya },
    });
  });

  it('lets FA, CO and CA add documents, and an owner only as its owner', async () => {
    await createDoc(all, {}, PERSON.arjun);
    await createDoc(all, {}, PERSON.kabir);
    const own = await createDoc(all, {}, PERSON.sameer);
    expect(own.allowedActions).toEqual(['DRAFT_REVISION']);
    const body = {
      managementSystemId: all.id,
      code: nextCode(),
      title: 'Procedure',
      type: 'PROCEDURE',
      ownerId: PERSON.kabir,
      approverId: PERSON.divya,
    };
    await fails(app, 'createIsoDocument', { as: PERSON.sameer, body }, 'FORBIDDEN', 403);
    await fails(app, 'createIsoDocument', { as: PERSON.divya, body }, 'FORBIDDEN', 403);
    await fails(app, 'createIsoDocument', { as: PERSON.vikram, body }, 'FORBIDDEN', 403);
    await fails(app, 'createIsoDocument', { as: PERSON.leela, body }, 'NOT_FOUND', 404);
  });

  it('needs the creator to see the management system (plan §3.3)', async () => {
    const body = {
      code: nextCode(),
      title: 'Site procedure',
      type: 'PROCEDURE',
      ownerId: PERSON.rohan,
      approverId: PERSON.nisha,
    };
    await fails(
      app,
      'createIsoDocument',
      { as: PERSON.rohan, body: { ...body, managementSystemId: blr.id } },
      'NOT_FOUND',
      404,
    );
    await createDoc(all, { ...body }, PERSON.rohan);
    await fails(
      app,
      'createIsoDocument',
      { body: { ...body, code: nextCode(), managementSystemId: harbour.id } },
      'NOT_FOUND',
      404,
    );
  });

  it('checks people, clauses and type fields', async () => {
    const body = (extra: Record<string, unknown>) => ({
      managementSystemId: quality.id,
      code: nextCode(),
      title: 'Form',
      type: 'FORM',
      ownerId: PERSON.sameer,
      approverId: PERSON.divya,
      ...extra,
    });
    for (const extra of [
      { ownerId: PERSON.gita },
      { ownerId: PERSON.joseph },
      { approverId: PERSON.vikram },
      { clauseIds: [clause('ISO_14001', '6.1.2')] },
      { retention: 'Kept for ever', type: 'POLICY' },
      { issuer: 'Standards body' },
    ]) {
      await fails(app, 'createIsoDocument', { body: body(extra) }, 'VALIDATION', 400);
    }
    const form = await createDoc(quality, {
      type: 'FORM',
      retention: 'Three years in the plant office, then shredded.',
      clauseIds: [clause('ISO_9001', '7.5.3')],
    });
    expect(form.retention).toContain('Three years');
  });

  it('keeps codes unique per client, whatever their case', async () => {
    const first = await createDoc(all, { code: 'QP-UNIQUE' });
    const clash = await fails(
      app,
      'createIsoDocument',
      {
        body: {
          managementSystemId: blr.id,
          code: 'qp-unique',
          title: 'Another',
          type: 'PROCEDURE',
          ownerId: PERSON.sameer,
          approverId: PERSON.divya,
        },
      },
      'DUPLICATE',
      409,
    );
    expect(clash.error.details).toEqual({ field: 'code', existingId: first.id });
    // Another client may use the same code.
    await createDoc(harbour, {
      code: 'QP-UNIQUE',
      ownerId: PERSON.joseph,
      approverId: PERSON.priya,
    });
  });
});

describe('getIsoDocument and unit scope', () => {
  it('answers every reader in scope, and 404 for another client or a missing id', async () => {
    const doc = await createDoc();
    for (const as of [
      PERSON.meera,
      PERSON.arjun,
      PERSON.kabir,
      PERSON.nisha,
      PERSON.divya,
      PERSON.rohan,
      PERSON.sameer,
      PERSON.vikram,
    ]) {
      const view = await getDoc(doc, as);
      expect(view.id).toBe(doc.id);
    }
    expect((await getDoc(doc, PERSON.vikram)).allowedActions).toEqual([]);
    expect((await getDoc(doc, PERSON.divya)).allowedActions).toEqual(['MAKE_OBSOLETE']);
    await fails(
      app,
      'getIsoDocument',
      { as: PERSON.leela, params: { id: doc.id } },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'getIsoDocument',
      { params: { clientId: HARBOUR, id: doc.id } },
      'NOT_FOUND',
      404,
    );
    await fails(app, 'getIsoDocument', { params: { id: seedId() } }, 'NOT_FOUND', 404);
  });

  it('hides a Bengaluru-only document from Pune people unless it names them', async () => {
    const doc = await createDoc(blr);
    for (const as of [PERSON.nisha, PERSON.rohan]) {
      await fails(app, 'getIsoDocument', { as, params: { id: doc.id } }, 'NOT_FOUND', 404);
      await fails(app, 'listIsoRevisions', { as, params: { id: doc.id } }, 'NOT_FOUND', 404);
    }
    const named = await createDoc(blr, { ownerId: PERSON.rohan, approverId: PERSON.nisha });
    expect((await getDoc(named, PERSON.rohan)).allowedActions).toEqual(['DRAFT_REVISION']);
    expect((await getDoc(named, PERSON.nisha)).allowedActions).toEqual(['MAKE_OBSOLETE']);
  });

  it('lets every member read a document in force and its current revision only', async () => {
    const { doc, rev } = await approvedDoc(blr);
    const next = await draft(doc, 'B');
    const asRohan = await getDoc(doc, PERSON.rohan);
    expect(asRohan).toMatchObject({
      currentRevision: 'A',
      openRevisionId: null,
      allowedActions: [],
    });
    expect((await getDoc(doc)).openRevisionId).toBe(next.id);
    const listed = await revisions(doc, PERSON.rohan);
    expect(listed.items.map((r) => r.id)).toEqual([rev.id]);
    expect((await revisions(doc)).items.map((r) => r.id)).toEqual([next.id, rev.id]);
    const page = await ok<{ items: Doc[] }>(app, 'listIsoDocuments', {
      as: PERSON.nisha,
      query: { managementSystemId: blr.id },
    });
    expect(page.items.map((d) => d.id)).toContain(doc.id);
    // Reading through the exception gives no right to change it: 403, not 404.
    await fails(
      app,
      'updateIsoDocument',
      { as: PERSON.rohan, params: { id: doc.id }, body: { version: doc.version, title: 'X' } },
      'FORBIDDEN',
      403,
    );
    await fails(
      app,
      'reviewIsoDocument',
      {
        as: PERSON.nisha,
        params: { id: doc.id },
        body: { version: doc.version, note: 'Fine', nextReviewDueOn: addDays(TODAY, 90) },
      },
      'FORBIDDEN',
      403,
    );
    // An obsolete document is no longer in force.
    await ok(app, 'obsoleteIsoDocument', {
      as: PERSON.divya,
      params: { id: doc.id },
      body: { version: doc.version, reason: 'Withdrawn' },
    });
    await fails(
      app,
      'getIsoDocument',
      { as: PERSON.rohan, params: { id: doc.id } },
      'NOT_FOUND',
      404,
    );
  });
});

describe('listIsoDocuments', () => {
  let docs: Doc[];
  let system: IsoRow<'managementSystems'>;

  beforeAll(async () => {
    system = seedSystem(app, { standards: ['ISO_9001', 'ISO_14001'] });
    docs = [
      await createDoc(system, {
        code: 'L-03',
        title: 'Environmental policy',
        clauseIds: [clause('ISO_14001', '5.2')],
        reviewDueOn: addDays(TODAY, -3),
      }),
      await createDoc(system, {
        code: 'L-01',
        title: 'Calibration procedure',
        type: 'PROCEDURE',
        ownerId: PERSON.rohan,
        approverId: PERSON.nisha,
        reviewDueOn: TODAY,
      }),
      await createDoc(system, {
        code: 'L-02',
        title: 'Supplier standard',
        type: 'EXTERNAL',
        issuer: 'Packaging Council',
        externalRef: 'PC-114',
      }),
    ];
    const obsolete = await createDoc(system, { code: 'L-04', title: 'Old manual', type: 'MANUAL' });
    await ok(app, 'obsoleteIsoDocument', {
      as: PERSON.divya,
      params: { id: obsolete.id },
      body: { version: obsolete.version, reason: 'Replaced' },
    });
    docs.push(obsolete);
  });

  const list = (query: Record<string, string>, as: string = PERSON.meera) =>
    ok<{ items: Doc[]; nextCursor: string | null; total?: number }>(app, 'listIsoDocuments', {
      as,
      query: { managementSystemId: system.id, ...query },
    });
  const codes = async (query: Record<string, string>, as?: string) =>
    (await list(query, as)).items.map((d) => d.code);

  it('lists ACTIVE documents by code, with their review timing', async () => {
    const page = await list({});
    expect(page.items.map((d) => d.code)).toEqual(['L-01', 'L-02', 'L-03']);
    expect(page.items[0]!.reviewStatus).toEqual({ timing: 'DUE_SOON', overdueDays: null });
    expect(page.items[2]!.reviewStatus).toEqual({ timing: 'OVERDUE', overdueDays: 3 });
    expect(page.items[1]!.reviewStatus).toEqual({ timing: 'ON_TIME', overdueDays: null });
  });

  it('applies every filter', async () => {
    expect(await codes({ status: 'OBSOLETE' })).toEqual(['L-04']);
    expect(await codes({ status: 'ACTIVE,OBSOLETE' })).toEqual(['L-01', 'L-02', 'L-03', 'L-04']);
    expect((await list({ status: 'OBSOLETE' })).items[0]!.reviewStatus.timing).toBe('CLOSED');
    expect(await codes({ type: 'EXTERNAL,PROCEDURE' })).toEqual(['L-01', 'L-02']);
    expect(await codes({ ownerId: 'me' }, PERSON.rohan)).toEqual(['L-01']);
    expect(await codes({ ownerId: PERSON.sameer })).toEqual(['L-02', 'L-03']);
    expect(await codes({ approverId: 'me' }, PERSON.nisha)).toEqual(['L-01']);
    expect(await codes({ clauseId: clause('ISO_14001', '5.2') })).toEqual(['L-03']);
    expect(await codes({ q: 'pc-114' })).toEqual(['L-02']);
    expect(await codes({ q: 'policy' })).toEqual(['L-03']);
    const both = await list({ managementSystemId: `${system.id},${quality.id}`, q: 'L-0' });
    expect(both.items).toHaveLength(3);
  });

  it('pages with a cursor and a count', async () => {
    const first = await list({ limit: '2', count: 'true' });
    expect(first.items.map((d) => d.code)).toEqual(['L-01', 'L-02']);
    expect(first.total).toBe(3);
    const second = await list({ limit: '2', cursor: first.nextCursor! });
    expect(second.items.map((d) => d.code)).toEqual(['L-03']);
    expect(second.nextCursor).toBeNull();
  });

  it('keeps AP and OW to their units and the documents naming them', async () => {
    const scoped = seedSystem(app, { unitIds: [BENGALURU] });
    const hidden = await createDoc(scoped, { code: 'L-10' });
    const named = await createDoc(scoped, { code: 'L-11', approverId: PERSON.nisha });
    const ids = async (as: string) =>
      (
        await ok<{ items: Doc[] }>(app, 'listIsoDocuments', {
          as,
          query: { managementSystemId: scoped.id },
        })
      ).items.map((d) => d.id);
    expect(await ids(PERSON.rohan)).toEqual([]);
    expect(await ids(PERSON.nisha)).toEqual([named.id]);
    expect(await ids(PERSON.vikram)).toEqual([hidden.id, named.id]);
    expect(await ids(PERSON.sameer)).toEqual([hidden.id, named.id]);
    await fails(app, 'listIsoDocuments', { as: PERSON.leela }, 'NOT_FOUND', 404);
  });
});

describe('updateIsoDocument', () => {
  it('edits fields, audits people and review-date changes apart, and bumps the version once', async () => {
    const doc = await createDoc(all, { type: 'FORM' });
    const updated = await ok<Doc>(app, 'updateIsoDocument', {
      as: PERSON.sameer,
      params: { id: doc.id },
      body: {
        version: doc.version,
        title: 'Batch record form',
        retention: 'Five years',
        approverId: PERSON.kabir,
        reviewDueOn: addDays(TODAY, 30),
        clauseIds: [clause('ISO_9001', '7.5.3')],
        reason: 'Kabir signs off forms now',
      },
    });
    expect(updated).toMatchObject({
      version: doc.version + 1,
      title: 'Batch record form',
      approverId: PERSON.kabir,
    });
    const events = isoEvents(app, doc.id).slice(1);
    expect(events.map((e) => e.action)).toEqual(['REASSIGN', 'DUE_DATE_CHANGE', 'UPDATE']);
    expect(events[0]).toMatchObject({
      before: { approverId: PERSON.divya },
      after: { approverId: PERSON.kabir },
      reason: 'Kabir signs off forms now',
    });
    expect(events[1]).toMatchObject({
      before: { reviewDueOn: null },
      after: { reviewDueOn: addDays(TODAY, 30) },
      reason: 'Kabir signs off forms now',
    });
    expect(events[2]!.after).toEqual({
      title: 'Batch record form',
      clauseIds: [clause('ISO_9001', '7.5.3')],
      retention: 'Five years',
    });
    expect(events[2]!.reason).toBeNull();
    // Nothing changed: no write, same version.
    const same = await ok<Doc>(app, 'updateIsoDocument', {
      params: { id: doc.id },
      body: { version: updated.version, title: 'Batch record form' },
    });
    expect(same.version).toBe(updated.version);
    expect(isoEvents(app, doc.id)).toHaveLength(4);
    // The owner hands the document over; clearing the review date is allowed.
    const handed = await ok<Doc>(app, 'updateIsoDocument', {
      as: PERSON.kabir,
      params: { id: doc.id },
      body: {
        version: same.version,
        ownerId: PERSON.rohan,
        reviewDueOn: null,
        retention: null,
        reason: 'Rohan runs the Pune line',
      },
    });
    expect(handed).toMatchObject({ ownerId: PERSON.rohan, reviewDueOn: null, retention: null });
    expect(isoEvents(app, doc.id).slice(4)).toEqual([
      expect.objectContaining({
        action: 'REASSIGN',
        after: { ownerId: PERSON.rohan },
        reason: 'Rohan runs the Pune line',
      }),
      expect.objectContaining({
        action: 'DUE_DATE_CHANGE',
        after: { reviewDueOn: null },
        reason: 'Rohan runs the Pune line',
      }),
      expect.objectContaining({ action: 'UPDATE', after: { retention: null }, reason: null }),
    ]);
  });

  it('refuses other people, stale versions, wrong fields and obsolete documents', async () => {
    const doc = await createDoc();
    const body = { version: doc.version, title: 'Changed' };
    for (const as of [PERSON.rohan, PERSON.divya, PERSON.nisha, PERSON.vikram]) {
      await fails(app, 'updateIsoDocument', { as, params: { id: doc.id }, body }, 'FORBIDDEN', 403);
    }
    await fails(
      app,
      'updateIsoDocument',
      { params: { id: doc.id }, body: { ...body, version: doc.version + 1 } },
      'STALE_VERSION',
      409,
    );
    for (const extra of [
      { retention: 'Kept' },
      { issuer: 'Body' },
      { externalRef: 'REF-1' },
      { ownerId: PERSON.gita, reason: 'Hand over' },
      { approverId: PERSON.joseph, reason: 'Hand over' },
      { clauseIds: [seedId()] },
    ]) {
      await fails(
        app,
        'updateIsoDocument',
        { params: { id: doc.id }, body: { version: doc.version, ...extra } },
        'VALIDATION',
        400,
      );
    }
    await fails(
      app,
      'updateIsoDocument',
      { params: { id: doc.id }, body: { version: doc.version } },
      'VALIDATION',
      400,
    );
    const external = await createDoc(all, { type: 'EXTERNAL' });
    const set = await ok<Doc>(app, 'updateIsoDocument', {
      params: { id: external.id },
      body: { version: external.version, issuer: 'Standards body', externalRef: 'SB-9' },
    });
    expect(set).toMatchObject({ issuer: 'Standards body', externalRef: 'SB-9' });
    const obsolete = await ok<Doc>(app, 'obsoleteIsoDocument', {
      as: PERSON.divya,
      params: { id: doc.id },
      body: { version: doc.version, reason: 'Withdrawn' },
    });
    const refused = await fails(
      app,
      'updateIsoDocument',
      { params: { id: doc.id }, body: { ...body, version: obsolete.version } },
      'INVALID_TRANSITION',
      409,
    );
    expect(refused.error.details).toEqual({
      entity: 'controlled_document',
      from: 'OBSOLETE',
      action: 'UPDATE',
    });
  });

  it('needs a reason for a new owner or approver or a moved review date, and audits it (decision 51 p)', async () => {
    const doc = await createDoc(all, { reviewDueOn: addDays(TODAY, 30) });
    const update = (body: Record<string, unknown>) => ({ params: { id: doc.id }, body });
    // Each reason field, alone, beside a plain field, cleared, or with a blank reason: 422 and nothing written.
    for (const change of [
      { ownerId: PERSON.rohan },
      { approverId: PERSON.kabir },
      { reviewDueOn: addDays(TODAY, 60) },
      { reviewDueOn: null },
      { ownerId: PERSON.rohan, title: 'Moved on' },
      { approverId: PERSON.kabir, reason: '   ' },
    ]) {
      await fails(
        app,
        'updateIsoDocument',
        update({ version: doc.version, ...change }),
        'REASON_REQUIRED',
        422,
      );
    }
    expect((await getDoc(doc)).version).toBe(doc.version);
    expect(isoEvents(app, doc.id)).toHaveLength(1);
    // With a reason, each change is 200 and its event carries the reason.
    let current = doc;
    for (const [change, action, before, reason] of [
      [{ ownerId: PERSON.rohan }, 'REASSIGN', { ownerId: PERSON.sameer }, 'Rohan runs Pune'],
      [{ approverId: PERSON.kabir }, 'REASSIGN', { approverId: PERSON.divya }, 'Divya is away'],
      [
        { reviewDueOn: addDays(TODAY, 60) },
        'DUE_DATE_CHANGE',
        { reviewDueOn: addDays(TODAY, 30) },
        'Audit moved',
      ],
    ] as const) {
      current = await ok<Doc>(app, 'updateIsoDocument', {
        params: { id: doc.id },
        body: { version: current.version, ...change, reason },
      });
      expect(current).toMatchObject(change);
      expect(lastEvent(doc.id)).toMatchObject({ action, before, after: change, reason });
    }
    // A plain field edit needs no reason; its UPDATE has none.
    current = await ok<Doc>(app, 'updateIsoDocument', {
      params: { id: doc.id },
      body: { version: current.version, title: 'Quality policy, issue 2' },
    });
    expect(current).toMatchObject({ title: 'Quality policy, issue 2', version: doc.version + 4 });
    expect(lastEvent(doc.id)).toMatchObject({
      action: 'UPDATE',
      before: { title: 'Quality policy' },
      after: { title: 'Quality policy, issue 2' },
      reason: null,
    });
    expect(isoEvents(app, doc.id).map((e) => e.action)).toEqual([
      'CREATE',
      'REASSIGN',
      'REASSIGN',
      'DUE_DATE_CHANGE',
      'UPDATE',
    ]);
  });
});

describe('reviewIsoDocument', () => {
  it('needs an approved revision', async () => {
    const doc = await createDoc();
    await fails(
      app,
      'reviewIsoDocument',
      {
        as: PERSON.divya,
        params: { id: doc.id },
        body: { version: doc.version, note: 'Fine', nextReviewDueOn: addDays(TODAY, 365) },
      },
      'VALIDATION',
      400,
    );
  });

  it('records the review and the next date; a client admin reviews as delegate', async () => {
    const { doc } = await approvedDoc(all, { reviewDueOn: addDays(TODAY, -10) });
    expect(doc.reviewStatus).toEqual({ timing: 'OVERDUE', overdueDays: 10 });
    expect(doc.allowedActions).toEqual(['DRAFT_REVISION']);
    expect((await getDoc(doc, PERSON.divya)).allowedActions).toEqual(['REVIEW', 'MAKE_OBSOLETE']);
    expect((await getDoc(doc, PERSON.kabir)).allowedActions).toEqual([
      'DRAFT_REVISION',
      'REVIEW',
      'MAKE_OBSOLETE',
    ]);
    const next = addDays(TODAY, 365);
    const body = { version: doc.version, note: 'Still fits the business', nextReviewDueOn: next };
    for (const as of [PERSON.meera, PERSON.arjun, PERSON.nisha, PERSON.sameer, PERSON.vikram]) {
      await fails(app, 'reviewIsoDocument', { as, params: { id: doc.id }, body }, 'FORBIDDEN', 403);
    }
    await fails(
      app,
      'reviewIsoDocument',
      { as: PERSON.divya, params: { id: doc.id }, body: { ...body, nextReviewDueOn: TODAY } },
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'reviewIsoDocument',
      { as: PERSON.divya, params: { id: doc.id }, body: { ...body, version: doc.version + 1 } },
      'STALE_VERSION',
      409,
    );
    const reviewed = await ok<Doc>(app, 'reviewIsoDocument', {
      as: PERSON.divya,
      params: { id: doc.id },
      body,
    });
    expect(reviewed).toMatchObject({
      lastReviewedOn: TODAY,
      reviewDueOn: next,
      currentRevision: 'A',
      version: doc.version + 1,
      reviewStatus: { timing: 'ON_TIME', overdueDays: null },
    });
    expect(lastEvent(doc.id)).toMatchObject({
      action: 'TRANSITION',
      entityType: 'controlled_document',
      actorId: PERSON.divya,
      before: { lastReviewedOn: null, reviewDueOn: addDays(TODAY, -10) },
      after: { action: 'REVIEW', lastReviewedOn: TODAY, note: 'Still fits the business' },
    });
    expect(lastEvent(doc.id).after).not.toHaveProperty('delegated');
    await ok(app, 'reviewIsoDocument', {
      as: PERSON.kabir,
      params: { id: doc.id },
      body: { ...body, version: reviewed.version },
    });
    expect(lastEvent(doc.id).after).toMatchObject({ delegated: true });
  });
});

describe('obsoleteIsoDocument', () => {
  it('makes an ACTIVE document OBSOLETE with a reason, once', async () => {
    const { doc } = await approvedDoc();
    await fails(
      app,
      'obsoleteIsoDocument',
      { as: PERSON.divya, params: { id: doc.id }, body: { version: doc.version } },
      'REASON_REQUIRED',
      422,
    );
    for (const as of [PERSON.meera, PERSON.sameer, PERSON.nisha]) {
      await fails(
        app,
        'obsoleteIsoDocument',
        { as, params: { id: doc.id }, body: { version: doc.version, reason: 'Old' } },
        'FORBIDDEN',
        403,
      );
    }
    const obsolete = await ok<Doc>(app, 'obsoleteIsoDocument', {
      as: PERSON.kabir,
      params: { id: doc.id },
      body: { version: doc.version, reason: 'Merged into the manual' },
    });
    expect(obsolete).toMatchObject({
      status: 'OBSOLETE',
      currentRevision: 'A',
      allowedActions: [],
      reviewStatus: { timing: 'CLOSED', overdueDays: null },
    });
    expect(lastEvent(doc.id)).toMatchObject({
      action: 'TRANSITION',
      before: { status: 'ACTIVE' },
      after: { action: 'MAKE_OBSOLETE', status: 'OBSOLETE', delegated: true },
      reason: 'Merged into the manual',
    });
    const again = await fails(
      app,
      'obsoleteIsoDocument',
      {
        as: PERSON.divya,
        params: { id: doc.id },
        body: { version: obsolete.version, reason: 'Old' },
      },
      'INVALID_TRANSITION',
      409,
    );
    expect(again.error.details).toEqual({
      entity: 'controlled_document',
      from: 'OBSOLETE',
      action: 'MAKE_OBSOLETE',
    });
    await fails(
      app,
      'reviewIsoDocument',
      {
        as: PERSON.divya,
        params: { id: doc.id },
        body: { version: obsolete.version, note: 'x', nextReviewDueOn: addDays(TODAY, 9) },
      },
      'INVALID_TRANSITION',
      409,
    );
    // The history stays readable.
    expect((await revisions(doc, PERSON.vikram)).items).toHaveLength(1);
  });
});

describe('revisions', () => {
  it('drafts, edits, submits, sends back and approves a revision', async () => {
    const doc = await createDoc();
    const drafted = await draft(doc, 'A', PERSON.sameer, 'First issue');
    expect(drafted).toMatchObject({
      documentId: doc.id,
      revision: 'A',
      state: 'DRAFT',
      preparedById: PERSON.sameer,
      approvedById: null,
      approvedAt: null,
      sendBackReason: null,
      allowedActions: ['SUBMIT'],
    });
    expect(lastEvent(drafted.id)).toMatchObject({
      action: 'CREATE',
      entityType: 'document_revision',
      after: { action: 'DRAFT_REVISION', documentId: doc.id, state: 'DRAFT' },
    });
    expect(lastEvent(drafted.id).after).not.toHaveProperty('delegated');
    expect(await getDoc(doc)).toMatchObject({ openRevisionId: drafted.id, allowedActions: [] });
    const asOwner = (await revisions(doc, PERSON.sameer)).items[0]!;
    expect(asOwner.allowedActions).toEqual(['SUBMIT']);

    const edited = await ok<Rev>(app, 'updateIsoRevision', {
      as: PERSON.sameer,
      params: revParams(doc, drafted),
      body: { version: drafted.version, revision: '1.0', changeNote: null },
    });
    expect(edited).toMatchObject({ revision: '1.0', changeNote: null, version: 2 });
    expect(lastEvent(drafted.id)).toMatchObject({
      action: 'UPDATE',
      before: { revision: 'A', changeNote: 'First issue' },
      after: { revision: '1.0', changeNote: null },
    });

    // SUBMIT needs a change note and exactly one clean file.
    const submitBody = { version: edited.version };
    const params = revParams(doc, drafted);
    await fails(
      app,
      'submitIsoRevision',
      { as: PERSON.sameer, params, body: submitBody },
      'VALIDATION',
      400,
    );
    const noted = await ok<Rev>(app, 'updateIsoRevision', {
      as: PERSON.sameer,
      params,
      body: { version: edited.version, changeNote: 'First controlled issue' },
    });
    const body = { version: noted.version };
    const noFile = await fails(
      app,
      'submitIsoRevision',
      { as: PERSON.sameer, params, body },
      'VALIDATION',
      400,
    );
    expect(noFile.error.details).toEqual({
      issues: [{ path: ['body', 'file'], message: "Upload the revision's file first" }],
    });
    seedFile(drafted, { archived: true });
    const pending = seedFile(drafted, { scanStatus: 'PENDING' });
    await fails(app, 'submitIsoRevision', { as: PERSON.sameer, params, body }, 'VALIDATION', 400);
    seedFile(drafted);
    await fails(app, 'submitIsoRevision', { as: PERSON.sameer, params, body }, 'VALIDATION', 400);
    pending.archivedAt = NOW;
    pending.removeReason = 'Replaced';
    for (const as of [PERSON.rohan, PERSON.divya, PERSON.vikram]) {
      await fails(app, 'submitIsoRevision', { as, params, body }, 'FORBIDDEN', 403);
    }
    await fails(
      app,
      'submitIsoRevision',
      { as: PERSON.sameer, params, body: { version: noted.version + 1 } },
      'STALE_VERSION',
      409,
    );
    const submitted = await ok<Rev>(app, 'submitIsoRevision', { as: PERSON.sameer, params, body });
    expect(submitted).toMatchObject({ state: 'IN_REVIEW', allowedActions: [] });
    expect(lastEvent(drafted.id)).toMatchObject({
      action: 'TRANSITION',
      before: { state: 'DRAFT', sendBackReason: null },
      after: { action: 'SUBMIT', state: 'IN_REVIEW', sendBackReason: null },
    });
    await fails(
      app,
      'submitIsoRevision',
      { as: PERSON.sameer, params, body: { version: submitted.version } },
      'INVALID_TRANSITION',
      409,
    );
    await fails(
      app,
      'updateIsoRevision',
      { as: PERSON.sameer, params, body: { version: submitted.version, revision: 'B' } },
      'INVALID_TRANSITION',
      409,
    );
    expect((await revisions(doc, PERSON.divya)).items[0]!.allowedActions).toEqual([
      'APPROVE',
      'SEND_BACK',
    ]);

    // SEND_BACK needs a reason, which SUBMIT clears.
    await fails(
      app,
      'sendBackIsoRevision',
      { as: PERSON.divya, params, body: { version: submitted.version } },
      'REASON_REQUIRED',
      422,
    );
    for (const as of [PERSON.meera, PERSON.sameer, PERSON.nisha]) {
      await fails(
        app,
        'sendBackIsoRevision',
        { as, params, body: { version: submitted.version, reason: 'No' } },
        'FORBIDDEN',
        403,
      );
    }
    const sentBack = await ok<Rev>(app, 'sendBackIsoRevision', {
      as: PERSON.divya,
      params,
      body: { version: submitted.version, reason: 'Add the scope section' },
    });
    expect(sentBack).toMatchObject({ state: 'DRAFT', sendBackReason: 'Add the scope section' });
    expect(lastEvent(drafted.id)).toMatchObject({
      after: { action: 'SEND_BACK', state: 'DRAFT' },
      reason: 'Add the scope section',
    });
    await fails(
      app,
      'sendBackIsoRevision',
      { as: PERSON.divya, params, body: { version: sentBack.version, reason: 'Again' } },
      'INVALID_TRANSITION',
      409,
    );
    await fails(
      app,
      'approveIsoRevision',
      { as: PERSON.divya, params, body: { version: sentBack.version } },
      'INVALID_TRANSITION',
      409,
    );
    const resubmitted = await submit(doc, sentBack);
    expect(resubmitted.sendBackReason).toBeNull();

    for (const as of [PERSON.meera, PERSON.arjun, PERSON.sameer, PERSON.nisha, PERSON.vikram]) {
      await fails(
        app,
        'approveIsoRevision',
        { as, params, body: { version: resubmitted.version } },
        'FORBIDDEN',
        403,
      );
    }
    await fails(
      app,
      'approveIsoRevision',
      { as: PERSON.divya, params, body: { version: 1 } },
      'STALE_VERSION',
      409,
    );
    const approved = await ok<Rev>(app, 'approveIsoRevision', {
      as: PERSON.divya,
      params,
      body: { version: resubmitted.version, comment: 'Approved for issue' },
    });
    expect(approved).toMatchObject({
      state: 'APPROVED',
      approvedById: PERSON.divya,
      approvedAt: NOW,
      allowedActions: [],
    });
    expect(lastEvent(drafted.id)).toMatchObject({
      after: { action: 'APPROVE', state: 'APPROVED', note: 'Approved for issue' },
    });
    expect(lastEvent(drafted.id).after).not.toHaveProperty('delegated');
    const inForce = await getDoc(doc);
    expect(inForce).toMatchObject({
      currentRevisionId: drafted.id,
      currentRevision: '1.0',
      openRevisionId: null,
      version: doc.version + 1,
    });
    expect(lastEvent(doc.id)).toMatchObject({
      action: 'UPDATE',
      before: { currentRevisionId: null },
      after: { currentRevisionId: drafted.id },
    });
  });

  it('supersedes the revision in force when the next is approved, keeping the history newest first', async () => {
    const { doc, rev: a } = await approvedDoc();
    const b = await draft(doc, 'B');
    seedFile(b);
    const bIn = await approve(doc, await submit(doc, b), PERSON.kabir);
    expect(bIn).toMatchObject({ state: 'APPROVED', approvedById: PERSON.kabir });
    expect(lastEvent(b.id).after).toMatchObject({ action: 'APPROVE', delegated: true });
    const history = (await revisions(doc, PERSON.vikram)).items;
    expect(history.map((r) => [r.revision, r.state])).toEqual([
      ['B', 'APPROVED'],
      ['A', 'SUPERSEDED'],
    ]);
    expect(history[1]!.approvedById).toBe(PERSON.divya);
    expect(lastEvent(a.id)).toMatchObject({
      action: 'TRANSITION',
      before: { state: 'APPROVED' },
      after: { action: 'SUPERSEDE', state: 'SUPERSEDED', supersededById: b.id },
    });
    expect(await getDoc(doc)).toMatchObject({ currentRevisionId: b.id, currentRevision: 'B' });
    await fails(
      app,
      'updateIsoRevision',
      { params: revParams(doc, a), body: { version: history[1]!.version, revision: 'Z' } },
      'INVALID_TRANSITION',
      409,
    );
  });

  it('lists a stored history newest first, whatever order it was written in', async () => {
    const doc = await createDoc();
    const row = (revision: string, createdAt: string, state: 'SUPERSEDED' | 'APPROVED' | 'DRAFT') =>
      seed(app, 'revisions', {
        ...base(),
        createdAt,
        updatedAt: createdAt,
        documentId: doc.id,
        revision,
        changeNote: `Issue ${revision}`,
        state,
        preparedById: PERSON.sameer,
        approvedById: state === 'DRAFT' ? null : PERSON.divya,
        approvedAt: state === 'DRAFT' ? null : createdAt,
        sendBackReason: null,
      });
    const a = row('A', '2025-01-10T06:30:00Z', 'SUPERSEDED');
    const c = row('C', '2026-06-01T06:30:00Z', 'DRAFT');
    const b = row('B', '2025-06-01T06:30:00Z', 'APPROVED');
    firmB(app).iso.documents.find((d) => d.id === doc.id)!.currentRevisionId = b.id;
    expect((await revisions(doc)).items.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(await getDoc(doc)).toMatchObject({ currentRevision: 'B', openRevisionId: c.id });
  });

  it('opens one revision at a time, with labels unique to the document', async () => {
    const { doc } = await approvedDoc();
    const dup = await fails(
      app,
      'draftIsoRevision',
      { as: PERSON.sameer, params: revParams(doc), body: { revision: 'a' } },
      'DUPLICATE',
      409,
    );
    expect(dup.error.details).toMatchObject({ field: 'revision' });
    for (const as of [PERSON.rohan, PERSON.divya, PERSON.vikram]) {
      await fails(
        app,
        'draftIsoRevision',
        { as, params: revParams(doc), body: { revision: 'B' } },
        'FORBIDDEN',
        403,
      );
    }
    const b = await ok<Rev>(app, 'draftIsoRevision', {
      as: PERSON.kabir,
      params: revParams(doc),
      body: { revision: 'B' },
    });
    expect(b).toMatchObject({ changeNote: null, preparedById: PERSON.kabir });
    expect(lastEvent(b.id).after).toMatchObject({ delegated: true });
    const open = await fails(
      app,
      'draftIsoRevision',
      { as: PERSON.sameer, params: revParams(doc), body: { revision: 'C' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(open.error.details).toEqual({
      entity: 'document_revision',
      from: 'DRAFT',
      action: 'DRAFT_REVISION',
    });
    const c = await createDoc();
    const cA = await draft(c, 'A');
    await fails(
      app,
      'updateIsoRevision',
      { params: revParams(doc, b), body: { version: b.version, revision: 'A' } },
      'DUPLICATE',
      409,
    );
    // A revision is reached only through its own document.
    await fails(
      app,
      'updateIsoRevision',
      { params: revParams(doc, cA), body: { version: cA.version, revision: 'X' } },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'updateIsoRevision',
      { params: revParams(doc, b), body: { version: b.version + 1, revision: 'B2' } },
      'STALE_VERSION',
      409,
    );
    await fails(
      app,
      'updateIsoRevision',
      { as: PERSON.rohan, params: revParams(doc, b), body: { version: b.version, revision: 'B2' } },
      'FORBIDDEN',
      403,
    );
  });

  it('never lets whoever prepared or submitted a revision approve it (maker-checker)', async () => {
    // A client admin who drafts and submits as delegate cannot approve; the approver can.
    const doc = await createDoc();
    const drafted = await draft(doc, 'A', PERSON.kabir);
    seedFile(drafted);
    const submitted = await submit(doc, drafted, PERSON.kabir);
    expect(lastEvent(drafted.id).after).toMatchObject({ action: 'SUBMIT', delegated: true });
    expect((await revisions(doc, PERSON.kabir)).items[0]!.allowedActions).toEqual(['SEND_BACK']);
    const refused = await fails(
      app,
      'approveIsoRevision',
      { as: PERSON.kabir, params: revParams(doc, drafted), body: { version: submitted.version } },
      'FORBIDDEN',
      403,
    );
    expect(refused.error.details).toEqual({ action: 'isoDocument.approve' });
    await approve(doc, submitted);

    // A client admin who submitted once, before a send-back, is still a maker.
    const other = await createDoc();
    const first = await draft(other, 'A');
    seedFile(first);
    const sent = await ok<Rev>(app, 'sendBackIsoRevision', {
      as: PERSON.divya,
      params: revParams(other, first),
      body: { version: (await submit(other, first, PERSON.kabir)).version, reason: 'Fix it' },
    });
    const again = await submit(other, sent);
    await fails(
      app,
      'approveIsoRevision',
      { as: PERSON.kabir, params: revParams(other, first), body: { version: again.version } },
      'FORBIDDEN',
      403,
    );

    // The approver named on a document cannot approve a revision they prepared.
    const own = await createDoc(all, { ownerId: PERSON.kabir, approverId: PERSON.kabir });
    const mine = await draft(own, 'A', PERSON.kabir);
    seedFile(mine);
    const mineIn = await submit(own, mine, PERSON.kabir);
    await fails(
      app,
      'approveIsoRevision',
      { as: PERSON.kabir, params: revParams(own, mine), body: { version: mineIn.version } },
      'FORBIDDEN',
      403,
    );
  });

  it('refuses SUBMIT, APPROVE and SEND_BACK on an EXTERNAL document, and RECORD_EDITION on others', async () => {
    const internal = await createDoc();
    const rev = await draft(internal, 'A');
    seedFile(rev);
    await fails(
      app,
      'recordIsoEdition',
      { as: PERSON.sameer, params: revParams(internal, rev), body: { version: rev.version } },
      'INVALID_TRANSITION',
      409,
    );
    const external = await createDoc(all, {
      type: 'EXTERNAL',
      issuer: 'Food Safety Authority',
      externalRef: 'FSA-2024-11',
    });
    const edition = await draft(external, '2024');
    expect(edition.allowedActions).toEqual(['RECORD_EDITION']);
    seedFile(edition);
    const refused = await fails(
      app,
      'submitIsoRevision',
      { as: PERSON.sameer, params: revParams(external, edition), body: { version: 1 } },
      'INVALID_TRANSITION',
      409,
    );
    expect(refused.error.details).toEqual({
      entity: 'document_revision',
      from: 'DRAFT',
      action: 'SUBMIT',
    });
    // An IN_REVIEW revision on an EXTERNAL document cannot exist through the routes; force one to check the guards.
    const row = firmB(app).iso.revisions.find((r) => r.id === edition.id)!;
    row.state = 'IN_REVIEW';
    expect((await revisions(external, PERSON.divya)).items[0]!.allowedActions).toEqual([]);
    for (const [id, body] of [
      ['approveIsoRevision', { version: row.version }],
      ['sendBackIsoRevision', { version: row.version, reason: 'x' }],
    ] as const) {
      await fails(
        app,
        id,
        { as: PERSON.divya, params: revParams(external, edition), body },
        'INVALID_TRANSITION',
        409,
      );
    }
    row.state = 'DRAFT';
  });

  it('records editions of an EXTERNAL document without internal approval', async () => {
    const doc = await createDoc(all, { type: 'EXTERNAL', ownerId: PERSON.rohan });
    const first = await draft(doc, '2023', PERSON.rohan);
    const params = revParams(doc, first);
    const body = { version: first.version };
    const noIssuer = await fails(
      app,
      'recordIsoEdition',
      { as: PERSON.rohan, params, body },
      'VALIDATION',
      400,
    );
    expect(noIssuer.error.details).toMatchObject({ issues: [{ path: ['body', 'issuer'] }] });
    const withIssuer = await ok<Doc>(app, 'updateIsoDocument', {
      as: PERSON.rohan,
      params: { id: doc.id },
      body: { version: doc.version, issuer: 'Boiler Inspectorate' },
    });
    const noRef = await fails(
      app,
      'recordIsoEdition',
      { as: PERSON.rohan, params, body },
      'VALIDATION',
      400,
    );
    expect(noRef.error.details).toMatchObject({ issues: [{ path: ['body', 'externalRef'] }] });
    await ok(app, 'updateIsoDocument', {
      as: PERSON.rohan,
      params: { id: doc.id },
      body: { version: withIssuer.version, externalRef: 'BI-77' },
    });
    await fails(app, 'recordIsoEdition', { as: PERSON.rohan, params, body }, 'VALIDATION', 400);
    seedFile(first, { scanStatus: 'INFECTED' });
    await fails(app, 'recordIsoEdition', { as: PERSON.rohan, params, body }, 'VALIDATION', 400);
    firmB(app).iso.files.find((f) => f.documentRevisionId === first.id)!.scanStatus = 'CLEAN';
    for (const as of [PERSON.sameer, PERSON.divya, PERSON.vikram]) {
      await fails(app, 'recordIsoEdition', { as, params, body }, 'FORBIDDEN', 403);
    }
    await fails(
      app,
      'recordIsoEdition',
      { as: PERSON.rohan, params, body: { version: 9 } },
      'STALE_VERSION',
      409,
    );
    const recorded = await ok<Rev>(app, 'recordIsoEdition', { as: PERSON.rohan, params, body });
    expect(recorded).toMatchObject({
      state: 'APPROVED',
      approvedById: null,
      approvedAt: NOW,
      preparedById: PERSON.rohan,
    });
    expect(lastEvent(first.id)).toMatchObject({
      after: { action: 'RECORD_EDITION', state: 'APPROVED', approvedById: null },
    });
    expect(lastEvent(first.id).after).not.toHaveProperty('delegated');
    await fails(
      app,
      'recordIsoEdition',
      { as: PERSON.rohan, params, body: { version: recorded.version } },
      'INVALID_TRANSITION',
      409,
    );
    // The next edition, recorded by a manager as delegate, supersedes the first.
    const second = await draft(doc, '2025', PERSON.meera);
    seedFile(second);
    await ok(app, 'recordIsoEdition', {
      params: revParams(doc, second),
      body: { version: second.version },
    });
    expect(lastEvent(second.id).after).toMatchObject({ delegated: true });
    expect((await revisions(doc)).items.map((r) => r.state)).toEqual(['APPROVED', 'SUPERSEDED']);
    expect(await getDoc(doc)).toMatchObject({
      currentRevision: '2025',
      currentRevisionId: second.id,
    });
  });

  it('locks every revision step once the document is OBSOLETE', async () => {
    const doc = await createDoc();
    const drafted = await draft(doc, 'A');
    seedFile(drafted);
    const submitted = await submit(doc, drafted);
    const obsolete = await ok<Doc>(app, 'obsoleteIsoDocument', {
      as: PERSON.divya,
      params: { id: doc.id },
      body: { version: doc.version, reason: 'Not needed' },
    });
    expect(obsolete.openRevisionId).toBe(drafted.id);
    expect((await revisions(doc, PERSON.divya)).items[0]!.allowedActions).toEqual([]);
    const params = revParams(doc, drafted);
    const version = submitted.version;
    const cases = [
      ['approveIsoRevision', PERSON.divya, { version }, 'APPROVE'],
      ['sendBackIsoRevision', PERSON.divya, { version, reason: 'x' }, 'SEND_BACK'],
      ['submitIsoRevision', PERSON.sameer, { version }, 'SUBMIT'],
      ['recordIsoEdition', PERSON.sameer, { version }, 'RECORD_EDITION'],
      ['updateIsoRevision', PERSON.sameer, { version, revision: 'B' }, 'UPDATE'],
    ] as const;
    for (const [id, as, body, action] of cases) {
      const refused = await fails(app, id, { as, params, body }, 'INVALID_TRANSITION', 409);
      expect(refused.error.details).toEqual({
        entity: 'controlled_document',
        from: 'OBSOLETE',
        action,
      });
    }
    const drafting = await fails(
      app,
      'draftIsoRevision',
      { as: PERSON.sameer, params: revParams(doc), body: { revision: 'B' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(drafting.error.details).toMatchObject({
      entity: 'controlled_document',
      action: 'UPDATE',
    });
  });

  it('works in a client with its own people (Harbour)', async () => {
    const doc = await createDoc(
      harbour,
      { ownerId: PERSON.joseph, approverId: PERSON.priya, type: 'WORK_INSTRUCTION' },
      PERSON.leela,
    );
    const drafted = await ok<Rev>(app, 'draftIsoRevision', {
      as: PERSON.joseph,
      params: revParams(doc),
      body: { revision: '1', changeNote: 'Till close-down steps' },
    });
    seedFile(drafted);
    const submitted = await ok<Rev>(app, 'submitIsoRevision', {
      as: PERSON.joseph,
      params: revParams(doc, drafted),
      body: { version: drafted.version },
    });
    await fails(
      app,
      'approveIsoRevision',
      { as: PERSON.divya, params: revParams(doc, drafted), body: { version: submitted.version } },
      'NOT_FOUND',
      404,
    );
    const approved = await ok<Rev>(app, 'approveIsoRevision', {
      as: PERSON.priya,
      params: revParams(doc, drafted),
      body: { version: submitted.version },
    });
    expect(approved.approvedById).toBe(PERSON.priya);
    await fails(
      app,
      'listIsoRevisions',
      { as: PERSON.arjun, params: revParams(doc) },
      'NOT_FOUND',
      404,
    );
    const status = await call(app, 'getIsoDocument', {
      as: PERSON.leela,
      params: { clientId: HARBOUR, id: doc.id },
    });
    expect(status.status).toBe(200);
  });
});
