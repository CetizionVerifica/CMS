import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attach, createHarness, type Harness, type Reply, type Who } from './testing/fixture.js';

/**
 * Controlled documents and their revisions (model §3.4, §4.2): every arrow of the DOCUMENT and DOCUMENT_REVISION
 * machines, maker-checker, the order APPROVE writes in, file locks, and the member who reads only the revision in force.
 */

const NOW = new Date('2026-10-20T06:00:00Z');
let h: Harness;
let systemId: string;

beforeAll(async () => {
  h = await createHarness('Doc', NOW);
  const system = await h.ok('clientAdmin', 'POST', '/systems', {
    name: 'Quality system',
    standardIds: [h.f.std9001],
    unitIds: [h.f.unitA],
  });
  systemId = system.id as string;
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const audit = (entityId: string) =>
  h.testDb.query<{
    action: string;
    after: Record<string, unknown> | null;
    reason: string | null;
    actor_id: string;
  }>(
    'SELECT action, after, reason, actor_id FROM audit_event WHERE entity_id = $1 ORDER BY at, id',
    [entityId],
  );

/** The `details` of an error answer. */
const details = (reply: Reply) => (reply.body.error as { details?: unknown } | undefined)?.details;

let codes = 0;
async function document(fields: Record<string, unknown> = {}, who: Who = 'clientAdmin') {
  codes += 1;
  return h.ok(who, 'POST', '/documents', {
    managementSystemId: systemId,
    code: `QP-${codes}`,
    title: 'Control of purchased goods',
    type: 'PROCEDURE',
    clauseIds: [h.f.clauses['9001:8.3']],
    ownerId: h.f.people.owner,
    approverId: h.f.people.approver,
    ...fields,
  });
}

type Revision = { id: string; version: number; state: string; allowedActions: string[] };

/** A clean file on the revision, as the owner uploads it and M9 scans it. */
async function cleanFile(revisionId: string, who: Who = 'owner') {
  const file = await attach(h, who, { type: 'document_revision', id: revisionId });
  await h.scan(file.id as string, 'CLEAN');
  return file;
}

/** A revision drafted and submitted by `maker`, with a change note and a clean file. */
async function submitted(docId: string, label: string, maker: Who = 'owner') {
  const base = `/documents/${docId}/revisions`;
  const draft = (await h.ok(maker, 'POST', base, {
    revision: label,
    changeNote: 'First issue',
  })) as Revision;
  await cleanFile(draft.id, maker);
  return (await h.ok(maker, 'POST', `${base}/${draft.id}/submit`, { version: 1 })) as Revision;
}

async function inForce(docId: string, label = 'A') {
  const rev = await submitted(docId, label);
  return (await h.ok('approver', 'POST', `/documents/${docId}/revisions/${rev.id}/approve`, {
    version: rev.version,
  })) as Revision;
}

describe('creating and editing documents', () => {
  it('creates a document per role, with the code unique in the client ignoring case', async () => {
    const doc = await document();
    expect(doc).toMatchObject({
      status: 'ACTIVE',
      currentRevisionId: null,
      currentRevision: null,
      openRevisionId: null,
      reviewStatus: { timing: 'ON_TIME', overdueDays: null },
    });
    expect((await audit(doc.id as string)).map((e) => e.action)).toEqual(['CREATE']);

    const dup = await h.send('clientAdmin', 'POST', '/documents', {
      managementSystemId: systemId,
      code: (doc.code as string).toLowerCase(),
      title: 'Again',
      type: 'PROCEDURE',
      ownerId: h.f.people.owner,
      approverId: h.f.people.approver,
    });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({
      error: { code: 'DUPLICATE', details: { field: 'code', existingId: doc.id } },
    });

    // An owner adds a document only as its owner; a viewer never; an owner of another unit cannot see the system.
    expect((await document({}, 'owner')).ownerId).toBe(h.f.people.owner);
    const asOther = await h.send('owner', 'POST', '/documents', {
      managementSystemId: systemId,
      code: 'QP-OTHER',
      title: 'Not mine',
      type: 'PROCEDURE',
      ownerId: h.f.people.otherOwner,
      approverId: h.f.people.approver,
    });
    expect(asOther.status).toBe(403);
    const viewer = await h.send('viewer', 'POST', '/documents', {
      managementSystemId: systemId,
      code: 'QP-VIEW',
      title: 'Read only',
      type: 'PROCEDURE',
      ownerId: h.f.people.owner,
      approverId: h.f.people.approver,
    });
    expect(viewer.status).toBe(403);
    const otherUnit = await h.send('otherOwner', 'POST', '/documents', {
      managementSystemId: systemId,
      code: 'QP-B',
      title: 'Other unit',
      type: 'PROCEDURE',
      ownerId: h.f.people.otherOwner,
      approverId: h.f.people.approver,
    });
    expect(otherUnit.status).toBe(404);
  });

  it('refuses clauses outside the system, type fields of another type, and people outside the client', async () => {
    const clause = await h.send('clientAdmin', 'POST', '/documents', {
      managementSystemId: systemId,
      code: 'QP-14001',
      title: 'Wrong standard',
      type: 'PROCEDURE',
      clauseIds: [h.f.clauses['14001:4.1']],
      ownerId: h.f.people.owner,
      approverId: h.f.people.approver,
    });
    expect(clause.status).toBe(400);
    expect(details(clause)).toMatchObject({ issues: [{ path: ['clauseIds'] }] });
    const issuer = await h.send('clientAdmin', 'POST', '/documents', {
      managementSystemId: systemId,
      code: 'QP-ISS',
      title: 'Issuer',
      type: 'PROCEDURE',
      issuer: 'Standards body',
      ownerId: h.f.people.owner,
      approverId: h.f.people.approver,
    });
    expect(issuer.status).toBe(400);
    const stranger = await h.send('clientAdmin', 'POST', '/documents', {
      managementSystemId: systemId,
      code: 'QP-STR',
      title: 'Stranger',
      type: 'PROCEDURE',
      ownerId: '01920000-0000-7000-8000-0000000000ff',
      approverId: h.f.people.approver,
    });
    expect(stranger.status).toBe(400);
    // ADR M16-0004 §6: a client role cannot see firm staff's memberships, so only firm staff name them.
    const consultant = {
      managementSystemId: systemId,
      title: 'Named consultant',
      type: 'POLICY',
      ownerId: h.f.people.owner,
      approverId: h.f.people.consultant,
    };
    expect(
      (await h.send('clientAdmin', 'POST', '/documents', { ...consultant, code: 'QP-C1' })).status,
    ).toBe(400);
    expect(
      (await h.send('consultant', 'POST', '/documents', { ...consultant, code: 'QP-C2' })).status,
    ).toBe(201);
  });

  it('edits fields with reasons for people and review dates, and refuses type fields of another type', async () => {
    const doc = await document();
    const path = `/documents/${doc.id}`;
    expect((await h.send('owner', 'PATCH', path, { version: 1, title: 'Renamed' })).status).toBe(
      200,
    );
    expect((await h.send('owner', 'PATCH', path, { version: 1, title: 'Stale' })).status).toBe(409);
    expect(
      (await h.send('owner', 'PATCH', path, { version: 2, reviewDueOn: '2027-04-01' })).status,
    ).toBe(422);
    expect(
      (await h.send('owner', 'PATCH', path, { version: 2, retention: '7 years' })).status,
    ).toBe(400);
    const moved = await h.ok('clientAdmin', 'PATCH', path, {
      version: 2,
      reviewDueOn: '2026-10-25',
      approverId: h.f.people.otherAdmin,
      reason: 'Annual review',
    });
    expect(moved).toMatchObject({
      reviewStatus: { timing: 'DUE_SOON' },
      approverId: h.f.people.otherAdmin,
    });
    const events = await audit(doc.id as string);
    expect(events.map((e) => e.action)).toEqual([
      'CREATE',
      'UPDATE',
      'REASSIGN',
      'DUE_DATE_CHANGE',
    ]);
    expect(events.slice(2).map((e) => e.reason)).toEqual(['Annual review', 'Annual review']);
    // The viewer reads but never edits.
    expect((await h.send('viewer', 'PATCH', path, { version: 3, title: 'No' })).status).toBe(403);
  });
});

describe('the revision machine (model §4.2)', () => {
  it('DRAFT_REVISION → SUBMIT → APPROVE with its guards, then the next revision supersedes it', async () => {
    const doc = await document();
    const base = `/documents/${doc.id}/revisions`;
    const draft = (await h.ok('owner', 'POST', base, { revision: 'A' })) as Revision;
    expect(draft).toMatchObject({ state: 'DRAFT', allowedActions: ['SUBMIT'] });
    expect((await h.ok('owner', 'GET', `/documents/${doc.id}`)).allowedActions).toEqual([]);
    // One open revision at a time.
    const second = await h.send('owner', 'POST', base, { revision: 'B' });
    expect(second.status).toBe(409);
    expect(details(second)).toMatchObject({ entity: 'document_revision', from: 'DRAFT' });

    // SUBMIT needs a change note, then exactly one clean file.
    const path = `${base}/${draft.id}`;
    const noNote = await h.send('owner', 'POST', `${path}/submit`, { version: 1 });
    expect(noNote.status).toBe(400);
    expect(details(noNote)).toMatchObject({ issues: [{ path: ['changeNote'] }] });
    await h.ok('owner', 'PATCH', path, { version: 1, changeNote: 'First issue' });
    const noFile = await h.send('owner', 'POST', `${path}/submit`, { version: 2 });
    expect(details(noFile)).toMatchObject({ issues: [{ path: ['file'] }] });
    const file = await attach(h, 'owner', { type: 'document_revision', id: draft.id });
    expect((await h.send('owner', 'POST', `${path}/submit`, { version: 2 })).status).toBe(400);
    await h.scan(file.id as string, 'CLEAN');
    const sent = (await h.ok('owner', 'POST', `${path}/submit`, { version: 2 })) as Revision;
    expect(sent).toMatchObject({ state: 'IN_REVIEW', allowedActions: [] });

    // While in review the file is locked; only the approver acts.
    const locked = await h.send('owner', 'POST', '/files/upload-url', {
      subject: { type: 'document_revision', id: draft.id },
      fileName: 'second.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
    });
    expect(locked.status).toBe(409);
    expect((await h.send('owner', 'POST', `${path}/approve`, { version: 3 })).status).toBe(403);
    const view = (await h.ok('approver', 'GET', base)).items as Revision[];
    expect(view[0]!.allowedActions).toEqual(['APPROVE', 'SEND_BACK']);
    const approved = await h.ok('approver', 'POST', `${path}/approve`, {
      version: 3,
      comment: 'Fine',
    });
    expect(approved).toMatchObject({ state: 'APPROVED', approvedById: h.f.people.approver });
    const now = await h.ok('owner', 'GET', `/documents/${doc.id}`);
    expect(now).toMatchObject({
      currentRevisionId: draft.id,
      currentRevision: 'A',
      allowedActions: ['DRAFT_REVISION'],
    });

    // Revision B replaces A: A becomes SUPERSEDED before B is APPROVED and the document moves to B.
    const b = await submitted(doc.id as string, 'B');
    expect((await h.send('owner', 'POST', base, { revision: 'b' })).status).toBe(409);
    await h.ok('approver', 'POST', `${base}/${b.id}/approve`, { version: b.version });
    const revisions = (await h.ok('viewer', 'GET', base)).items as (Revision & {
      revision: string;
    })[];
    expect(revisions.map((r) => [r.revision, r.state])).toEqual([
      ['B', 'APPROVED'],
      ['A', 'SUPERSEDED'],
    ]);
    const rows = await h.testDb.query<{
      action: string;
      entity_id: string;
      after: Record<string, unknown>;
    }>(
      `SELECT action, entity_id, after FROM audit_event
        WHERE entity_id = ANY($1) AND (action <> 'CREATE') ORDER BY at, id`,
      [[draft.id, b.id, doc.id]],
    );
    const tail = rows.slice(-3).map((r) => [r.entity_id, r.action, r.after.action ?? null]);
    expect(tail).toEqual([
      [draft.id, 'TRANSITION', 'SUPERSEDE'],
      [b.id, 'TRANSITION', 'APPROVE'],
      [doc.id, 'UPDATE', null],
    ]);
    const current = await h.testDb.query<{ state: string }>(
      `SELECT r.state FROM controlled_document d JOIN document_revision r ON r.id = d.current_revision_id
        WHERE d.id = $1`,
      [doc.id],
    );
    expect(current).toEqual([{ state: 'APPROVED' }]);
  });

  it('keeps maker-checker: the preparer or submitter never approves; a client admin approves as delegate', async () => {
    const doc = await document();
    const rev = await submitted(doc.id as string, 'A', 'clientAdmin');
    const path = `/documents/${doc.id}/revisions/${rev.id}`;
    const mine = (await h.ok('clientAdmin', 'GET', `/documents/${doc.id}/revisions`))
      .items as Revision[];
    expect(mine[0]!.allowedActions).toEqual(['SEND_BACK']);
    const refused = await h.send('clientAdmin', 'POST', `${path}/approve`, {
      version: rev.version,
    });
    expect(refused.status).toBe(403);
    await h.ok('otherAdmin', 'POST', `${path}/approve`, { version: rev.version });
    const events = await audit(rev.id);
    expect(events.at(-1)).toMatchObject({
      action: 'TRANSITION',
      actor_id: h.f.people.otherAdmin,
      after: expect.objectContaining({ action: 'APPROVE', delegated: true }),
    });
  });

  it('SEND_BACK needs a reason and returns the revision to DRAFT', async () => {
    const doc = await document();
    const rev = await submitted(doc.id as string, 'A');
    const path = `/documents/${doc.id}/revisions/${rev.id}`;
    expect((await h.send('approver', 'POST', `${path}/send-back`, { version: 2 })).status).toBe(
      422,
    );
    const back = await h.ok('approver', 'POST', `${path}/send-back`, {
      version: 2,
      reason: 'Add the supplier list',
    });
    expect(back).toMatchObject({ state: 'DRAFT', sendBackReason: 'Add the supplier list' });
    const sentBack = (await audit(rev.id)).at(-1)!;
    expect(sentBack).toMatchObject({
      reason: 'Add the supplier list',
      after: { action: 'SEND_BACK' },
    });
    expect(sentBack.after).not.toHaveProperty('delegated');
    // Resubmitted, the reason clears.
    const again = await h.ok('owner', 'POST', `${path}/submit`, { version: 3 });
    expect(again).toMatchObject({ state: 'IN_REVIEW', sendBackReason: null });
    expect((await h.send('approver', 'POST', `${path}/approve`, { version: 3 })).status).toBe(409);
  });

  it('records an EXTERNAL edition with no internal approval; SUBMIT is not its arrow', async () => {
    const doc = await document({
      type: 'EXTERNAL',
      issuer: 'Northwind Standards',
      externalRef: 'NW-17',
      clauseIds: [],
    });
    const base = `/documents/${doc.id}/revisions`;
    const draft = (await h.ok('owner', 'POST', base, { revision: '2024' })) as Revision;
    expect(draft.allowedActions).toEqual(['RECORD_EDITION']);
    expect(
      (await h.send('owner', 'POST', `${base}/${draft.id}/record-edition`, { version: 1 })).status,
    ).toBe(400);
    await cleanFile(draft.id);
    const submit = await h.send('owner', 'POST', `${base}/${draft.id}/submit`, { version: 1 });
    expect(submit.status).toBe(409);
    const recorded = await h.ok('owner', 'POST', `${base}/${draft.id}/record-edition`, {
      version: 1,
    });
    expect(recorded).toMatchObject({ state: 'APPROVED', approvedById: null });
    expect((await h.ok('viewer', 'GET', `/documents/${doc.id}`)).currentRevision).toBe('2024');
  });

  it('answers 404 for another document’s revision and 409 for a stale version', async () => {
    const one = await document();
    const two = await document();
    const rev = (await h.ok('owner', 'POST', `/documents/${one.id}/revisions`, {
      revision: 'A',
      changeNote: 'x',
    })) as Revision;
    expect(
      (
        await h.send('owner', 'PATCH', `/documents/${two.id}/revisions/${rev.id}`, {
          version: 1,
          revision: 'Z',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.send('owner', 'PATCH', `/documents/${one.id}/revisions/${rev.id}`, {
          version: 9,
          revision: 'Z',
        })
      ).status,
    ).toBe(409);
    const label = await h.ok('owner', 'PATCH', `/documents/${one.id}/revisions/${rev.id}`, {
      version: 1,
      revision: 'A1',
    });
    expect(label.revision).toBe('A1');
  });
});

describe('document steps (REVIEW, MAKE_OBSOLETE)', () => {
  it('REVIEW needs a revision in force and a next date after today', async () => {
    const doc = await document();
    const path = `/documents/${doc.id}/review`;
    const early = await h.send('approver', 'POST', path, {
      version: 1,
      note: 'Still fits',
      nextReviewDueOn: '2027-10-20',
    });
    expect(early.status).toBe(400);
    await inForce(doc.id as string);
    const version = (await h.ok('approver', 'GET', `/documents/${doc.id}`)).version as number;
    const today = await h.send('approver', 'POST', path, {
      version,
      note: 'Still fits',
      nextReviewDueOn: '2026-10-20',
    });
    expect(details(today)).toMatchObject({ issues: [{ path: ['nextReviewDueOn'] }] });
    expect(
      (await h.send('owner', 'POST', path, { version, note: 'x', nextReviewDueOn: '2027-10-20' }))
        .status,
    ).toBe(403);
    const reviewed = await h.ok('approver', 'POST', path, {
      version,
      note: 'Still fits',
      nextReviewDueOn: '2027-10-20',
    });
    expect(reviewed).toMatchObject({ lastReviewedOn: '2026-10-20', reviewDueOn: '2027-10-20' });
    expect((await audit(doc.id as string)).at(-1)).toMatchObject({
      action: 'TRANSITION',
      after: expect.objectContaining({ action: 'REVIEW', note: 'Still fits' }),
    });
  });

  it('MAKE_OBSOLETE with a reason locks the document, its revisions and their files', async () => {
    const doc = await document();
    const rev = await inForce(doc.id as string);
    const path = `/documents/${doc.id}`;
    const version = (await h.ok('approver', 'GET', path)).version as number;
    expect((await h.send('approver', 'POST', `${path}/obsolete`, { version })).status).toBe(422);
    const gone = await h.ok('clientAdmin', 'POST', `${path}/obsolete`, {
      version,
      reason: 'Replaced by the group manual',
    });
    expect(gone).toMatchObject({
      status: 'OBSOLETE',
      allowedActions: [],
      reviewStatus: { timing: 'CLOSED' },
    });
    expect((await audit(doc.id as string)).at(-1)).toMatchObject({
      reason: 'Replaced by the group manual',
      after: expect.objectContaining({ action: 'MAKE_OBSOLETE', delegated: true }),
    });
    const edit = await h.send('owner', 'PATCH', path, { version: version + 1, title: 'Late' });
    expect(details(edit)).toMatchObject({
      entity: 'controlled_document',
      from: 'OBSOLETE',
      action: 'UPDATE',
    });
    const draft = await h.send('owner', 'POST', `${path}/revisions`, { revision: 'B' });
    expect(details(draft)).toMatchObject({ entity: 'controlled_document', from: 'OBSOLETE' });
    expect(
      (
        await h.send('approver', 'POST', `${path}/obsolete`, {
          version: version + 1,
          reason: 'Again',
        })
      ).status,
    ).toBe(409);
    // Out of default lists, still readable with its history.
    const listed = (await h.ok('viewer', 'GET', '/documents')).items as { id: string }[];
    expect(listed.map((d) => d.id)).not.toContain(doc.id);
    const obsolete = (await h.ok('viewer', 'GET', '/documents?status=OBSOLETE')).items as {
      id: string;
    }[];
    expect(obsolete.map((d) => d.id)).toContain(doc.id);
    expect(((await h.ok('viewer', 'GET', `${path}/revisions`)).items as Revision[])[0]!.id).toBe(
      rev.id,
    );
  });
});

describe('who reads a document (plan §3.3)', () => {
  it('lets every member read the revision in force, and only that, outside their units', async () => {
    const hidden = await document();
    const shown = await document();
    await inForce(shown.id as string);
    // A draft of the next revision stays out of sight of the unit B owner.
    await h.ok('owner', 'POST', `/documents/${shown.id}/revisions`, { revision: 'B' });

    expect((await h.send('otherOwner', 'GET', `/documents/${hidden.id}`)).status).toBe(404);
    const read = await h.ok('otherOwner', 'GET', `/documents/${shown.id}`);
    expect(read).toMatchObject({ currentRevision: 'A', openRevisionId: null, allowedActions: [] });
    const revisions = (await h.ok('otherOwner', 'GET', `/documents/${shown.id}/revisions`))
      .items as Revision[];
    expect(revisions.map((r) => r.state)).toEqual(['APPROVED']);
    expect(
      (
        await h.send('otherOwner', 'PATCH', `/documents/${shown.id}`, {
          version: read.version,
          title: 'Mine',
        })
      ).status,
    ).toBe(403);
    expect(
      (await h.send('otherOwner', 'POST', `/documents/${shown.id}/revisions`, { revision: 'C' }))
        .status,
    ).toBe(403);

    const page = (await h.ok('otherOwner', 'GET', '/documents?count=true&limit=1')) as {
      items: { id: string }[];
      total: number;
      nextCursor: string | null;
    };
    const seen = [...page.items.map((d) => d.id)];
    let cursor = page.nextCursor;
    while (cursor !== null) {
      const next = (await h.ok(
        'otherOwner',
        'GET',
        `/documents?limit=1&cursor=${cursor}`,
      )) as typeof page;
      seen.push(...next.items.map((d) => d.id));
      cursor = next.nextCursor;
    }
    expect(seen).toContain(shown.id);
    expect(seen).not.toContain(hidden.id);
    expect(page.total).toBe(seen.length);

    // Within scope, the list is the repository's page and filters by `me`.
    const mine = (await h.ok('owner', 'GET', '/documents?ownerId=me&count=true')) as {
      total: number;
    };
    const all = (await h.ok('clientAdmin', 'GET', '/documents?count=true&q=QP')) as {
      total: number;
    };
    expect(mine.total).toBeGreaterThan(0);
    expect(all.total).toBeGreaterThanOrEqual(mine.total);
  });
});
