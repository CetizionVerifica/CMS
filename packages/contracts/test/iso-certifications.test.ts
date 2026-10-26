// The mock's ISO certification area (docs/iso/model.md §3.8, §3.9, §4.4): certificates with their cycle (§5.2),
// external audits and their machine, findings that raise nonconformities, the locks (§6), unit scope (plan §3.3), the
// role matrix (plan §3.2) and the audit trail (model §8).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CertificationView, ExternalAuditView } from '../src/api/iso.js';
import { addDays, daysFrom } from '../src/mock/iso/common.js';
import type { IsoRow } from '../src/mock/store.js';
import { type AuditFinding, Nonconformity } from '../src/schemas/iso.js';
import {
  type App,
  base,
  BENGALURU,
  call,
  CHENNAI,
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
  PUNE,
  seed,
  seedId,
  seedSystem,
  setFeatures,
  standardId,
  TODAY,
} from './iso-harness.js';

type System = IsoRow<'managementSystems'>;
type Certificate = CertificationView;
type Audit = ExternalAuditView;
type Finding = AuditFinding;
type Page<T> = { items: T[]; nextCursor: string | null; total?: number };

let app: App;
/** Northwind, every unit; Northwind, Bengaluru only; Northwind on ISO 9001 at Pune only; Harbour (Chennai). */
let all: System;
let blr: System;
let quality: System;
let harbour: System;

beforeAll(async () => {
  app = await isoApp();
  all = seedSystem(app);
  blr = seedSystem(app, { unitIds: [BENGALURU], standards: ['ISO_9001', 'ISO_14001'] });
  quality = seedSystem(app, { unitIds: [PUNE], standards: ['ISO_9001'] });
  harbour = seedSystem(app, { clientId: HARBOUR, standards: ['ISO_9001'] });
});
afterAll(async () => {
  await app.close();
});

const BODY = 'Example Assurance Body';
const std = (code: 'ISO_9001' | 'ISO_14001' | 'ISO_45001') => standardId(app, code);
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const lastEvent = (id: string) => isoEvents(app, id).at(-1)!;
const params = (row: { id: string; clientId: string }) => ({ clientId: row.clientId, id: row.id });
const ncOf = (finding: Finding) =>
  firmB(app).iso.nonconformities.find((n) => n.id === finding.nonconformityId)!;

// ---------- certificates ----------

function createCert(
  system: System = all,
  body: Record<string, unknown> = {},
  as: string = PERSON.meera,
): Promise<Certificate> {
  return ok<Certificate>(app, 'createIsoCertification', {
    as,
    params: { clientId: system.clientId },
    body: { managementSystemId: system.id, standardId: system.standardIds[0], body: BODY, ...body },
  });
}

const updateCert = (cert: Certificate, body: Record<string, unknown>, as: string = PERSON.meera) =>
  ok<Certificate>(app, 'updateIsoCertification', {
    as,
    params: params(cert),
    body: { version: cert.version, ...body },
  });

const listCerts = (query: Record<string, string>, as: string = PERSON.meera) =>
  ok<Page<Certificate>>(app, 'listIsoCertifications', { as, query });

const ISSUED = { certificateNumber: 'Q-1001', issuedOn: '2022-11-01', expiresOn: '2025-10-31' };

describe('createIsoCertification', () => {
  it('adds a certificate being pursued, with no number, dates or cycle, audited as CREATE', async () => {
    const cert = await createCert();
    expect(cert).toMatchObject({
      clientId: NORTHWIND,
      managementSystemId: all.id,
      standardId: all.standardIds[0],
      body: BODY,
      certificateNumber: null,
      issuedOn: null,
      expiresOn: null,
      scopeText: null,
      unitIds: [],
      version: 1,
      cycle: { certificationId: cert.id, items: [] },
    });
    const events = isoEvents(app, cert.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'CREATE',
      entityType: 'certification',
      actorId: PERSON.meera,
      after: { managementSystemId: all.id, body: BODY, certificateNumber: null, unitIds: [] },
    });
    expect(events[0]!.after).not.toHaveProperty('id');
    expect(events[0]!.after).not.toHaveProperty('version');
  });

  it('adds an issued certificate over units of the system, with its cycle due dates', async () => {
    const cert = await createCert(all, { ...ISSUED, unitIds: [PUNE], scopeText: 'Snack foods' });
    expect(cert).toMatchObject({ ...ISSUED, unitIds: [PUNE], scopeText: 'Snack foods' });
    expect(cert.cycle.items).toEqual([
      {
        kind: 'SURVEILLANCE_1',
        dueOn: '2023-11-01',
        metByAuditId: null,
        metOn: null,
        daysLate: null,
        overdueDays: daysFrom('2023-11-01', TODAY),
      },
      {
        kind: 'SURVEILLANCE_2',
        dueOn: '2024-11-01',
        metByAuditId: null,
        metOn: null,
        daysLate: null,
        overdueDays: 14,
      },
      {
        kind: 'RECERTIFICATION',
        dueOn: '2025-10-31',
        metByAuditId: null,
        metOn: null,
        daysLate: null,
        overdueDays: null,
      },
    ]);
  });

  it('refuses a standard or unit outside the system, half-issued dates and a missing system', async () => {
    const wrongStandard = await fails(
      app,
      'createIsoCertification',
      { body: { managementSystemId: quality.id, standardId: std('ISO_14001'), body: BODY } },
      'VALIDATION',
      400,
    );
    expect(wrongStandard.error.details).toMatchObject({
      issues: [{ path: ['body', 'standardId'] }],
    });
    const wrongUnit = await fails(
      app,
      'createIsoCertification',
      {
        body: {
          managementSystemId: quality.id,
          standardId: std('ISO_9001'),
          body: BODY,
          unitIds: [BENGALURU],
        },
      },
      'VALIDATION',
      400,
    );
    expect(wrongUnit.error.details).toMatchObject({ issues: [{ path: ['body', 'unitIds'] }] });
    await fails(
      app,
      'createIsoCertification',
      {
        body: {
          managementSystemId: all.id,
          standardId: std('ISO_9001'),
          body: BODY,
          issuedOn: TODAY,
        },
      },
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'createIsoCertification',
      { body: { managementSystemId: seedId(), standardId: std('ISO_9001'), body: BODY } },
      'NOT_FOUND',
      404,
    );
    // Another client's system is not found either.
    await fails(
      app,
      'createIsoCertification',
      { body: { managementSystemId: harbour.id, standardId: std('ISO_9001'), body: BODY } },
      'NOT_FOUND',
      404,
    );
  });

  it('is isoCertification.write: FA, CO and CA only, within unit scope', async () => {
    await createCert(all, {}, PERSON.arjun);
    await createCert(all, {}, PERSON.kabir);
    await createCert(harbour, {}, PERSON.leela);
    const body = { managementSystemId: all.id, standardId: std('ISO_9001'), body: BODY };
    for (const as of [PERSON.divya, PERSON.nisha, PERSON.sameer, PERSON.rohan, PERSON.vikram]) {
      await fails(app, 'createIsoCertification', { as, body }, 'FORBIDDEN', 403);
    }
    await fails(app, 'createIsoCertification', { as: PERSON.leela, body }, 'NOT_FOUND', 404);
    const outside = { managementSystemId: blr.id, standardId: std('ISO_9001'), body: BODY };
    await fails(
      app,
      'createIsoCertification',
      { as: PERSON.nisha, body: outside },
      'NOT_FOUND',
      404,
    );
    // Units the writer names count: a Pune-only owner is refused, not hidden, on a Pune certificate.
    await fails(
      app,
      'createIsoCertification',
      { as: PERSON.rohan, body: { ...body, unitIds: [PUNE] } },
      'FORBIDDEN',
      403,
    );
  });
});

describe('updateIsoCertification', () => {
  it('records the certificate issued: number and dates together, audited as UPDATE', async () => {
    const cert = await createCert();
    const issued = await updateCert(cert, ISSUED, PERSON.kabir);
    expect(issued).toMatchObject({ ...ISSUED, version: 2 });
    expect(issued.cycle.items.map((i) => i.dueOn)).toEqual([
      '2023-11-01',
      '2024-11-01',
      '2025-10-31',
    ]);
    expect(lastEvent(cert.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'certification',
      actorId: PERSON.kabir,
      before: { certificateNumber: null, issuedOn: null, expiresOn: null },
      after: ISSUED,
    });
    const renamed = await updateCert(issued, { body: 'Another Body', scopeText: 'All products' });
    expect(renamed).toMatchObject({ body: 'Another Body', scopeText: 'All products', version: 3 });
    expect(lastEvent(cert.id)).toMatchObject({
      before: { body: BODY, scopeText: null },
      after: { body: 'Another Body', scopeText: 'All products' },
    });
  });

  it('checks the issue fields on the merged certificate', async () => {
    const cert = await createCert();
    const request = (body: Record<string, unknown>) => ({
      params: params(cert),
      body: { version: cert.version, ...body },
    });
    const half = await fails(
      app,
      'updateIsoCertification',
      request({ issuedOn: '2024-01-01' }),
      'VALIDATION',
      400,
    );
    expect(half.error.details).toMatchObject({ issues: [{ path: ['body', 'expiresOn'] }] });
    const noNumber = await fails(
      app,
      'updateIsoCertification',
      request({ issuedOn: '2024-01-01', expiresOn: '2026-12-31' }),
      'VALIDATION',
      400,
    );
    expect(noNumber.error.details).toMatchObject({
      issues: [{ path: ['body', 'certificateNumber'] }],
    });
    const backwards = await fails(
      app,
      'updateIsoCertification',
      request({ certificateNumber: 'Q-2', issuedOn: '2024-01-01', expiresOn: '2024-01-01' }),
      'VALIDATION',
      400,
    );
    expect(backwards.error.details).toMatchObject({ issues: [{ path: ['body', 'expiresOn'] }] });
    // Un-issuing clears all three together.
    const issued = await updateCert(cert, ISSUED);
    const cleared = await updateCert(issued, {
      certificateNumber: null,
      issuedOn: null,
      expiresOn: null,
    });
    expect(cleared).toMatchObject({ certificateNumber: null, issuedOn: null, version: 3 });
    expect(cleared.cycle.items).toEqual([]);
  });

  it('moves the certificate over units of its system only', async () => {
    const cert = await createCert();
    const moved = await updateCert(cert, { unitIds: [PUNE, BENGALURU] });
    expect(moved.unitIds).toEqual([PUNE, BENGALURU]);
    expect(lastEvent(cert.id)).toMatchObject({
      before: { unitIds: [] },
      after: { unitIds: [PUNE, BENGALURU] },
    });
    const pune = await createCert(quality);
    const refused = await fails(
      app,
      'updateIsoCertification',
      { params: params(pune), body: { version: 1, unitIds: [BENGALURU] } },
      'VALIDATION',
      400,
    );
    expect(refused.error.details).toMatchObject({ issues: [{ path: ['body', 'unitIds'] }] });
  });

  it('writes nothing when nothing changes, and refuses a stale version', async () => {
    const cert = await createCert();
    const same = await updateCert(cert, { body: BODY });
    expect(same.version).toBe(1);
    expect(isoEvents(app, cert.id)).toHaveLength(1);
    const stale = await fails(
      app,
      'updateIsoCertification',
      { params: params(cert), body: { version: 7, body: 'Late' } },
      'STALE_VERSION',
      409,
    );
    expect(stale.error.details).toEqual({ currentVersion: 1 });
  });

  it('is isoCertification.write within unit scope; another client answers 404', async () => {
    const cert = await createCert(all, { unitIds: [PUNE] });
    for (const as of [PERSON.divya, PERSON.nisha, PERSON.sameer, PERSON.rohan, PERSON.vikram]) {
      await fails(
        app,
        'updateIsoCertification',
        { as, params: params(cert), body: { version: 1, body: 'X' } },
        'FORBIDDEN',
        403,
      );
    }
    const bengaluru = await createCert(all, { unitIds: [BENGALURU] });
    await fails(
      app,
      'updateIsoCertification',
      { as: PERSON.nisha, params: params(bengaluru), body: { version: 1, body: 'X' } },
      'NOT_FOUND',
      404,
    );
    await updateCert(cert, { body: 'By the consultant' }, PERSON.arjun);
    const chennai = await createCert(harbour, {}, PERSON.leela);
    await fails(
      app,
      'updateIsoCertification',
      { params: { clientId: NORTHWIND, id: chennai.id }, body: { version: 1, body: 'X' } },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'updateIsoCertification',
      { as: PERSON.arjun, params: params(chennai), body: { version: 1, body: 'X' } },
      'NOT_FOUND',
      404,
    );
  });
});

describe('listIsoCertifications', () => {
  it('filters by system and standard; soonest expiry first, not issued last; pages', async () => {
    const system = seedSystem(app, { standards: ['ISO_9001', 'ISO_14001'] });
    const pursued = await createCert(system);
    const later = await createCert(system, {
      standardId: std('ISO_14001'),
      certificateNumber: 'E-1',
      issuedOn: '2023-01-01',
      expiresOn: '2026-01-01',
    });
    const sooner = await createCert(system, {
      certificateNumber: 'Q-9',
      issuedOn: '2022-03-02',
      expiresOn: '2025-03-01',
    });
    const page = await listCerts({ managementSystemId: system.id });
    expect(ids(page.items)).toEqual([sooner.id, later.id, pursued.id]);
    expect(page.items[0]!.cycle.items).toHaveLength(3);
    const quality9001 = await listCerts({
      managementSystemId: system.id,
      standardId: std('ISO_9001'),
    });
    expect(ids(quality9001.items)).toEqual([sooner.id, pursued.id]);
    const first = await listCerts({ managementSystemId: system.id, limit: '2', count: 'true' });
    expect(ids(first.items)).toEqual([sooner.id, later.id]);
    expect(first.total).toBe(3);
    const rest = await listCerts({ managementSystemId: system.id, cursor: first.nextCursor! });
    expect(ids(rest.items)).toEqual([pursued.id]);
    expect(rest.nextCursor).toBeNull();
  });

  it('shows AP and OW the certificates over their units; empty units mean the system’s', async () => {
    const pune = await createCert(all, { unitIds: [PUNE] });
    const bengaluru = await createCert(all, { unitIds: [BENGALURU] });
    const wide = await createCert(all);
    const blrOnly = await createCert(blr);
    const query = { managementSystemId: `${all.id},${blr.id}` };
    for (const as of [PERSON.rohan, PERSON.nisha]) {
      const seen = ids((await listCerts(query, as)).items);
      expect(seen).toEqual(expect.arrayContaining([pune.id, wide.id]));
      expect(seen).not.toContain(bengaluru.id);
      expect(seen).not.toContain(blrOnly.id);
    }
    for (const as of [PERSON.vikram, PERSON.sameer, PERSON.divya, PERSON.kabir]) {
      const seen = ids((await listCerts(query, as)).items);
      expect(seen).toEqual(expect.arrayContaining([pune.id, bengaluru.id, wide.id, blrOnly.id]));
    }
  });

  it('lists only the client’s own certificates; a person of another client gets 404', async () => {
    const chennai = await createCert(harbour, {}, PERSON.leela);
    const northwind = ids((await listCerts({})).items);
    expect(northwind).not.toContain(chennai.id);
    const seen = await ok<Page<Certificate>>(app, 'listIsoCertifications', {
      as: PERSON.joseph,
      params: { clientId: HARBOUR },
    });
    expect(ids(seen.items)).toContain(chennai.id);
    await fails(app, 'listIsoCertifications', { as: PERSON.joseph }, 'NOT_FOUND', 404);
  });
});

// ---------- external audits ----------

const VISIT = { type: 'SURVEILLANCE_1', body: BODY, startOn: '2024-11-04', endOn: '2024-11-06' };

function createAudit(
  system: System = all,
  body: Record<string, unknown> = {},
  as: string = PERSON.meera,
): Promise<Audit> {
  return ok<Audit>(app, 'createIsoExternalAudit', {
    as,
    params: { clientId: system.clientId },
    body: {
      managementSystemId: system.id,
      standardIds: [system.standardIds[0]],
      ...VISIT,
      ...body,
    },
  });
}

const getAudit = (audit: { id: string; clientId: string }, as: string = PERSON.meera) =>
  ok<Audit>(app, 'getIsoExternalAudit', { as, params: params(audit) });

const updateAudit = (audit: Audit, body: Record<string, unknown>, as: string = PERSON.meera) =>
  ok<Audit>(app, 'updateIsoExternalAudit', {
    as,
    params: params(audit),
    body: { version: audit.version, ...body },
  });

const listAudits = (query: Record<string, string>, as: string = PERSON.meera) =>
  ok<Page<Audit>>(app, 'listIsoExternalAudits', { as, query });

/** A file on the external audit (the body's report), straight into the store. */
function seedReport(
  audit: { id: string; clientId: string },
  scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED' = 'CLEAN',
  archived = false,
): IsoRow<'files'> {
  return seed(app, 'files', {
    id: seedId(),
    firmId: FIRM_B,
    clientId: audit.clientId,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: archived ? NOW : null,
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    sha256: 'a'.repeat(64),
    scanStatus,
    uploadedById: PERSON.kabir,
    uploadedAt: NOW,
    removeReason: archived ? 'Wrong file' : null,
    clauseAssessmentId: null,
    documentRevisionId: null,
    riskItemId: null,
    objectiveReadingId: null,
    internalAuditId: null,
    auditFindingId: null,
    externalAuditId: audit.id,
    certificationId: null,
    nonconformityId: null,
    isoActionId: null,
    managementReviewId: null,
    storageKey: `evidence/${FIRM_B}/${audit.clientId}/iso/external_audit/${audit.id}/x`,
  });
}

const holdBody = (audit: Audit, body: Record<string, unknown> = {}) => ({
  version: audit.version,
  startOn: audit.startOn,
  endOn: audit.endOn,
  ...body,
});

/** RECORD_HELD with a report on file. */
function hold(audit: Audit, body: Record<string, unknown> = {}, as: string = PERSON.meera) {
  seedReport(audit);
  return ok<Audit>(app, 'recordIsoExternalAuditHeld', {
    as,
    params: params(audit),
    body: holdBody(audit, body),
  });
}

/** A visit planned and recorded HELD. */
async function heldAudit(system: System = all, body: Record<string, unknown> = {}) {
  return hold(await createAudit(system, body));
}

/** An external audit row in any state, straight into the store. */
function seedAudit(
  system: System,
  fields: Partial<IsoRow<'externalAudits'>> = {},
): IsoRow<'externalAudits'> {
  return seed(app, 'externalAudits', {
    ...base(system.clientId),
    managementSystemId: system.id,
    standardIds: [std('ISO_9001')],
    type: 'SURVEILLANCE_1',
    body: BODY,
    leadAuditorName: null,
    startOn: '2024-10-01',
    endOn: '2024-10-02',
    recommendation: null,
    responseDueOn: null,
    state: 'PLANNED',
    cancelReason: null,
    ...fields,
  });
}

describe('createIsoExternalAudit', () => {
  it('plans a visit covering standards of the system, audited as CREATE', async () => {
    const audit = await createAudit(all, {
      standardIds: [std('ISO_9001'), std('ISO_45001')],
      leadAuditorName: 'A. Auditor',
      responseDueOn: '2024-12-06',
    });
    expect(audit).toMatchObject({
      clientId: NORTHWIND,
      managementSystemId: all.id,
      standardIds: [std('ISO_9001'), std('ISO_45001')],
      type: 'SURVEILLANCE_1',
      body: BODY,
      leadAuditorName: 'A. Auditor',
      startOn: '2024-11-04',
      endOn: '2024-11-06',
      recommendation: null,
      responseDueOn: '2024-12-06',
      state: 'PLANNED',
      cancelReason: null,
      version: 1,
      allowedActions: ['RECORD_HELD', 'CANCEL'],
    });
    expect(isoEvents(app, audit.id)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        entityType: 'external_audit',
        after: expect.objectContaining({ state: 'PLANNED', type: 'SURVEILLANCE_1' }),
      }),
    ]);
  });

  it('refuses standards outside the system, a deadline before the visit ends and a missing system', async () => {
    const standard = await fails(
      app,
      'createIsoExternalAudit',
      { body: { managementSystemId: quality.id, standardIds: [std('ISO_14001')], ...VISIT } },
      'VALIDATION',
      400,
    );
    expect(standard.error.details).toMatchObject({ issues: [{ path: ['body', 'standardIds'] }] });
    const deadline = await fails(
      app,
      'createIsoExternalAudit',
      {
        body: {
          managementSystemId: all.id,
          standardIds: [std('ISO_9001')],
          ...VISIT,
          responseDueOn: '2024-11-05',
        },
      },
      'VALIDATION',
      400,
    );
    expect(deadline.error.details).toMatchObject({ issues: [{ path: ['body', 'responseDueOn'] }] });
    await fails(
      app,
      'createIsoExternalAudit',
      {
        body: {
          managementSystemId: all.id,
          standardIds: [std('ISO_9001')],
          ...VISIT,
          endOn: '2024-11-01',
        },
      },
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'createIsoExternalAudit',
      { body: { managementSystemId: seedId(), standardIds: [std('ISO_9001')], ...VISIT } },
      'NOT_FOUND',
      404,
    );
  });

  it('is isoCertification.write: FA, CO and CA only, within unit scope', async () => {
    await createAudit(all, {}, PERSON.arjun);
    await createAudit(all, {}, PERSON.kabir);
    await createAudit(harbour, {}, PERSON.leela);
    const body = { managementSystemId: all.id, standardIds: [std('ISO_9001')], ...VISIT };
    for (const as of [PERSON.divya, PERSON.nisha, PERSON.sameer, PERSON.rohan, PERSON.vikram]) {
      await fails(app, 'createIsoExternalAudit', { as, body }, 'FORBIDDEN', 403);
    }
    const outside = { ...body, managementSystemId: blr.id };
    await fails(
      app,
      'createIsoExternalAudit',
      { as: PERSON.rohan, body: outside },
      'NOT_FOUND',
      404,
    );
    await fails(app, 'createIsoExternalAudit', { as: PERSON.leela, body }, 'NOT_FOUND', 404);
  });
});

describe('getIsoExternalAudit', () => {
  it('every reader within unit scope reads it; only writers are offered actions', async () => {
    const audit = await createAudit();
    for (const as of [PERSON.meera, PERSON.arjun, PERSON.kabir]) {
      expect((await getAudit(audit, as)).allowedActions).toEqual(['RECORD_HELD', 'CANCEL']);
    }
    for (const as of [PERSON.divya, PERSON.nisha, PERSON.sameer, PERSON.rohan, PERSON.vikram]) {
      expect((await getAudit(audit, as)).allowedActions).toEqual([]);
    }
  });

  it('answers 404 out of unit scope, for another client and for a missing audit', async () => {
    const bengaluru = await createAudit(blr);
    await getAudit(bengaluru, PERSON.sameer);
    await fails(
      app,
      'getIsoExternalAudit',
      { as: PERSON.nisha, params: params(bengaluru) },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'getIsoExternalAudit',
      { as: PERSON.rohan, params: params(bengaluru) },
      'NOT_FOUND',
      404,
    );
    const chennai = await createAudit(harbour);
    await fails(
      app,
      'getIsoExternalAudit',
      { params: { clientId: NORTHWIND, id: chennai.id } },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'getIsoExternalAudit',
      { as: PERSON.joseph, params: params(audit404()) },
      'NOT_FOUND',
      404,
    );
    expect((await getAudit(chennai, PERSON.joseph)).id).toBe(chennai.id);
  });
});

/** A Northwind id that names no audit. */
const audit404 = () => ({ id: seedId(), clientId: NORTHWIND });

describe('listIsoExternalAudits', () => {
  it('filters by system, state, type and start date; by start date', async () => {
    const system = seedSystem(app, { standards: ['ISO_9001'] });
    const late = await createAudit(system, { startOn: '2024-11-10', endOn: '2024-11-12' });
    const early = await createAudit(system, {
      type: 'STAGE_1',
      startOn: '2024-09-02',
      endOn: '2024-09-03',
    });
    const held = await heldAudit(system, {
      type: 'STAGE_2',
      startOn: '2024-10-07',
      endOn: '2024-10-09',
    });
    const listed = (query: Record<string, string>) =>
      listAudits({ managementSystemId: system.id, ...query }).then((p) => ids(p.items));
    expect(await listed({})).toEqual([early.id, held.id, late.id]);
    expect(await listed({ state: 'HELD' })).toEqual([held.id]);
    expect(await listed({ state: 'PLANNED,HELD', type: 'STAGE_1,STAGE_2' })).toEqual([
      early.id,
      held.id,
    ]);
    expect(await listed({ from: '2024-10-01' })).toEqual([held.id, late.id]);
    expect(await listed({ to: '2024-10-07' })).toEqual([early.id, held.id]);
    expect(await listed({ from: '2024-10-01', to: '2024-10-31' })).toEqual([held.id]);
    const page = await listAudits({ managementSystemId: system.id, limit: '1', count: 'true' });
    expect(page.total).toBe(3);
    expect(page.items[0]!.allowedActions).toEqual(['RECORD_HELD', 'CANCEL']);
    await fails(
      app,
      'listIsoExternalAudits',
      { query: { from: '2024-10-01', to: '2024-09-01' } },
      'VALIDATION',
      400,
    );
  });

  it('shows AP and OW the visits of systems over their units', async () => {
    const wide = await createAudit(all);
    const bengaluru = await createAudit(blr);
    const query = { managementSystemId: `${all.id},${blr.id}` };
    for (const as of [PERSON.rohan, PERSON.nisha]) {
      const seen = ids((await listAudits(query, as)).items);
      expect(seen).toContain(wide.id);
      expect(seen).not.toContain(bengaluru.id);
    }
    const viewer = ids((await listAudits(query, PERSON.vikram)).items);
    expect(viewer).toEqual(expect.arrayContaining([wide.id, bengaluru.id]));
    expect(
      (await listAudits(query, PERSON.vikram)).items.every((a) => a.allowedActions.length === 0),
    ).toBe(true);
  });
});

describe('updateIsoExternalAudit', () => {
  it('edits fields as UPDATE and the response deadline as DUE_DATE_CHANGE', async () => {
    const audit = await createAudit();
    const edited = await updateAudit(
      audit,
      {
        type: 'SPECIAL',
        leadAuditorName: 'B. Auditor',
        standardIds: [std('ISO_9001'), std('ISO_14001')],
        responseDueOn: '2024-12-31',
        reason: 'The body set its deadline',
      },
      PERSON.kabir,
    );
    expect(edited).toMatchObject({
      type: 'SPECIAL',
      leadAuditorName: 'B. Auditor',
      standardIds: [std('ISO_9001'), std('ISO_14001')],
      responseDueOn: '2024-12-31',
      version: 2,
    });
    const events = isoEvents(app, audit.id).slice(1);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'DUE_DATE_CHANGE',
        before: { responseDueOn: null },
        after: { responseDueOn: '2024-12-31' },
        reason: 'The body set its deadline',
      }),
      expect.objectContaining({
        action: 'UPDATE',
        before: {
          standardIds: [std('ISO_9001')],
          type: 'SURVEILLANCE_1',
          leadAuditorName: null,
        },
        after: {
          standardIds: [std('ISO_9001'), std('ISO_14001')],
          type: 'SPECIAL',
          leadAuditorName: 'B. Auditor',
        },
        reason: null,
      }),
    ]);
    const moved = await updateAudit(edited, { startOn: '2024-11-05' });
    expect(moved.version).toBe(3);
    expect(lastEvent(audit.id)).toMatchObject({
      action: 'UPDATE',
      after: { startOn: '2024-11-05' },
      reason: null,
    });
    const same = await updateAudit(moved, { body: BODY });
    expect(same.version).toBe(3);
  });

  it('checks the merged dates, the standards and when a recommendation may be set', async () => {
    const audit = await createAudit();
    const request = (body: Record<string, unknown>) => ({
      params: params(audit),
      body: { version: audit.version, ...body },
    });
    const ends = await fails(
      app,
      'updateIsoExternalAudit',
      request({ endOn: '2024-11-01' }),
      'VALIDATION',
      400,
    );
    expect(ends.error.details).toMatchObject({ issues: [{ path: ['body', 'endOn'] }] });
    await fails(
      app,
      'updateIsoExternalAudit',
      request({ responseDueOn: '2024-11-05', reason: 'The body asked for it' }),
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'updateIsoExternalAudit',
      request({ standardIds: [seedId()] }),
      'VALIDATION',
      400,
    );
    const early = await fails(
      app,
      'updateIsoExternalAudit',
      request({ recommendation: 'RECOMMENDED' }),
      'VALIDATION',
      400,
    );
    expect(early.error.details).toMatchObject({ issues: [{ path: ['body', 'recommendation'] }] });

    const held = await hold(audit);
    const recommended = await updateAudit(held, { recommendation: 'RECOMMENDED' });
    expect(recommended.recommendation).toBe('RECOMMENDED');
    const future = await fails(
      app,
      'updateIsoExternalAudit',
      { params: params(held), body: { version: recommended.version, endOn: '2024-11-20' } },
      'VALIDATION',
      400,
    );
    expect(future.error.details).toMatchObject({ issues: [{ path: ['body', 'endOn'] }] });
    // A standard one of its findings names a clause of stays.
    await ok(app, 'createIsoExternalFinding', {
      params: params(held),
      body: {
        type: 'OFI',
        description: 'Label stock could be tracked',
        clauseIds: [clause('ISO_9001', '7.1.5')],
      },
    });
    const kept = await fails(
      app,
      'updateIsoExternalAudit',
      {
        params: params(held),
        body: { version: recommended.version, standardIds: [std('ISO_14001')] },
      },
      'VALIDATION',
      400,
    );
    expect(kept.error.details).toMatchObject({ issues: [{ path: ['body', 'standardIds'] }] });
    const widened = await updateAudit(recommended, {
      standardIds: [std('ISO_9001'), std('ISO_45001')],
    });
    expect(widened.standardIds).toHaveLength(2);
  });

  it('needs a reason to move the response deadline, none for the visit dates (decision 51 p)', async () => {
    const audit = await createAudit();
    const version = () => firmB(app).iso.externalAudits.find((a) => a.id === audit.id)!.version;
    const request = (body: Record<string, unknown>) => ({
      as: PERSON.kabir,
      params: params(audit),
      body: { version: version(), ...body },
    });
    // Setting the deadline and clearing it are both due-date changes.
    for (const [from, to] of [
      [null, '2024-12-31'],
      ['2024-12-31', null],
    ] as const) {
      const count = isoEvents(app, audit.id).length;
      await fails(
        app,
        'updateIsoExternalAudit',
        request({ responseDueOn: to }),
        'REASON_REQUIRED',
        422,
      );
      await fails(
        app,
        'updateIsoExternalAudit',
        request({ responseDueOn: to, reason: '  ' }),
        'REASON_REQUIRED',
        422,
      );
      expect(isoEvents(app, audit.id)).toHaveLength(count);
      const reason = to === null ? 'The body withdrew its deadline' : 'The body set its deadline';
      const changed = await ok<Audit>(
        app,
        'updateIsoExternalAudit',
        request({ responseDueOn: to, reason }),
      );
      expect(changed.responseDueOn).toBe(to);
      expect(isoEvents(app, audit.id)).toHaveLength(count + 1);
      expect(lastEvent(audit.id)).toMatchObject({
        action: 'DUE_DATE_CHANGE',
        actorId: PERSON.kabir,
        before: { responseDueOn: from },
        after: { responseDueOn: to },
        reason,
      });
    }
    // The visit's own dates are an UPDATE and need no reason.
    const moved = await ok<Audit>(
      app,
      'updateIsoExternalAudit',
      request({ startOn: '2024-11-05', endOn: '2024-11-07' }),
    );
    expect(moved).toMatchObject({ startOn: '2024-11-05', endOn: '2024-11-07' });
    expect(lastEvent(audit.id)).toMatchObject({
      action: 'UPDATE',
      before: { startOn: '2024-11-04', endOn: '2024-11-06' },
      after: { startOn: '2024-11-05', endOn: '2024-11-07' },
      reason: null,
    });
  });

  it('refuses a stale version, a CLOSED or CANCELLED audit, and readers', async () => {
    const audit = await createAudit();
    await fails(
      app,
      'updateIsoExternalAudit',
      { params: params(audit), body: { version: 9, body: 'X' } },
      'STALE_VERSION',
      409,
    );
    for (const as of [PERSON.divya, PERSON.sameer, PERSON.vikram]) {
      await fails(
        app,
        'updateIsoExternalAudit',
        { as, params: params(audit), body: { version: 1, body: 'X' } },
        'FORBIDDEN',
        403,
      );
    }
    const cancelled = await ok<Audit>(app, 'cancelIsoExternalAudit', {
      params: params(audit),
      body: { version: 1, reason: 'Moved to next quarter' },
    });
    const refused = await fails(
      app,
      'updateIsoExternalAudit',
      { params: params(cancelled), body: { version: cancelled.version, body: 'X' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(refused.error.details).toEqual({
      entity: 'external_audit',
      from: 'CANCELLED',
      action: 'UPDATE',
    });
    const closed = await ok<Audit>(app, 'closeIsoExternalAudit', {
      params: params(await heldAudit()),
      body: { version: 2, recommendation: 'RECOMMENDED' },
    });
    const locked = await fails(
      app,
      'updateIsoExternalAudit',
      { params: params(closed), body: { version: closed.version, body: 'X' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(locked.error.details).toMatchObject({ from: 'CLOSED', action: 'UPDATE' });
  });
});

describe('external audit machine (model §4.4)', () => {
  it('RECORD_HELD needs the report on file and an ended visit; keeps or clears the deadline', async () => {
    const audit = await createAudit(all, { responseDueOn: '2024-12-06' });
    const request = (body: Record<string, unknown> = {}) => ({
      params: params(audit),
      body: holdBody(audit, body),
    });
    const noFile = await fails(app, 'recordIsoExternalAuditHeld', request(), 'VALIDATION', 400);
    expect(noFile.error.details).toMatchObject({ issues: [{ path: ['body', 'file'] }] });
    seedReport(audit, 'INFECTED');
    seedReport(audit, 'FAILED');
    seedReport(audit, 'CLEAN', true);
    await fails(app, 'recordIsoExternalAuditHeld', request(), 'VALIDATION', 400);
    seedReport(audit, 'PENDING');
    const future = await fails(
      app,
      'recordIsoExternalAuditHeld',
      request({ endOn: '2024-11-16' }),
      'VALIDATION',
      400,
    );
    expect(future.error.details).toMatchObject({ issues: [{ path: ['body', 'endOn'] }] });
    await fails(
      app,
      'recordIsoExternalAuditHeld',
      request({ responseDueOn: '2024-11-01' }),
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'recordIsoExternalAuditHeld',
      { params: params(audit), body: holdBody(audit, { version: 5 }) },
      'STALE_VERSION',
      409,
    );
    for (const as of [PERSON.divya, PERSON.sameer, PERSON.vikram]) {
      await fails(app, 'recordIsoExternalAuditHeld', { as, ...request() }, 'FORBIDDEN', 403);
    }
    const held = await ok<Audit>(app, 'recordIsoExternalAuditHeld', {
      as: PERSON.kabir,
      ...request({ startOn: '2024-11-05', endOn: '2024-11-07', recommendation: 'RECOMMENDED' }),
    });
    expect(held).toMatchObject({
      state: 'HELD',
      startOn: '2024-11-05',
      endOn: '2024-11-07',
      recommendation: 'RECOMMENDED',
      responseDueOn: '2024-12-06',
      version: 2,
      allowedActions: ['RECORD_RESPONSE', 'CLOSE'],
    });
    expect(lastEvent(audit.id)).toMatchObject({
      action: 'TRANSITION',
      entityType: 'external_audit',
      actorId: PERSON.kabir,
      before: {
        state: 'PLANNED',
        startOn: '2024-11-04',
        endOn: '2024-11-06',
        recommendation: null,
      },
      after: {
        action: 'RECORD_HELD',
        state: 'HELD',
        startOn: '2024-11-05',
        endOn: '2024-11-07',
        recommendation: 'RECOMMENDED',
      },
    });
    expect(lastEvent(audit.id).after).not.toHaveProperty('delegated');
    const again = await fails(
      app,
      'recordIsoExternalAuditHeld',
      { params: params(held), body: holdBody(held) },
      'INVALID_TRANSITION',
      409,
    );
    expect(again.error.details).toEqual({
      entity: 'external_audit',
      from: 'HELD',
      action: 'RECORD_HELD',
    });

    const cleared = await hold(
      await createAudit(all, { responseDueOn: '2024-12-06' }),
      {
        responseDueOn: null,
      },
      PERSON.meera,
    );
    expect(cleared.responseDueOn).toBeNull();
    expect(lastEvent(cleared.id).after).toMatchObject({
      action: 'RECORD_HELD',
      responseDueOn: null,
      delegated: true,
    });
  });

  it('CANCEL takes a PLANNED visit with a reason; the client admin is not a delegate, others are', async () => {
    const audit = await createAudit();
    await fails(
      app,
      'cancelIsoExternalAudit',
      { params: params(audit), body: { version: 1 } },
      'REASON_REQUIRED',
      422,
    );
    await fails(
      app,
      'cancelIsoExternalAudit',
      { as: PERSON.divya, params: params(audit), body: { version: 1, reason: 'No' } },
      'FORBIDDEN',
      403,
    );
    const cancelled = await ok<Audit>(app, 'cancelIsoExternalAudit', {
      as: PERSON.arjun,
      params: params(audit),
      body: { version: 1, reason: 'The body rescheduled' },
    });
    expect(cancelled).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'The body rescheduled',
      allowedActions: [],
    });
    expect(lastEvent(audit.id)).toMatchObject({
      action: 'TRANSITION',
      reason: 'The body rescheduled',
      before: { state: 'PLANNED', cancelReason: null },
      after: { action: 'CANCEL', state: 'CANCELLED', delegated: true },
    });
    const byAdmin = await createAudit();
    await ok(app, 'cancelIsoExternalAudit', {
      as: PERSON.kabir,
      params: params(byAdmin),
      body: { version: 1, reason: 'Not needed' },
    });
    expect(lastEvent(byAdmin.id).after).not.toHaveProperty('delegated');
    const held = await heldAudit();
    const refused = await fails(
      app,
      'cancelIsoExternalAudit',
      { params: params(held), body: { version: held.version, reason: 'Late' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(refused.error.details).toEqual({
      entity: 'external_audit',
      from: 'HELD',
      action: 'CANCEL',
    });
    await fails(
      app,
      'cancelIsoExternalAudit',
      { params: params(held), body: { version: 1, reason: 'Late' } },
      'STALE_VERSION',
      409,
    );
  });

  it('RECORD_RESPONSE waits until every nonconformity its findings raised has left OPEN', async () => {
    const planned = await createAudit();
    const notHeld = await fails(
      app,
      'recordIsoExternalAuditResponse',
      { params: params(planned), body: { version: 1 } },
      'INVALID_TRANSITION',
      409,
    );
    expect(notHeld.error.details).toMatchObject({ from: 'PLANNED', action: 'RECORD_RESPONSE' });
    const held = await heldAudit();
    const finding = await ok<Finding>(app, 'createIsoExternalFinding', {
      params: params(held),
      body: {
        type: 'MINOR_NC',
        description: 'Two scales were past their calibration date',
        unitId: PUNE,
        nonconformity: { ownerId: PERSON.sameer, approverId: PERSON.divya, dueOn: '2024-12-15' },
      },
    });
    const withNc = await getAudit(held);
    expect(withNc.allowedActions).toEqual(['RECORD_RESPONSE']);
    const open = await fails(
      app,
      'recordIsoExternalAuditResponse',
      { params: params(held), body: { version: held.version } },
      'VALIDATION',
      400,
    );
    expect(open.error.details).toMatchObject({
      issues: [
        {
          path: ['body', 'nonconformities'],
          message: expect.stringContaining(`Nonconformity ${ncOf(finding).number} is still OPEN`),
        },
      ],
    });
    await fails(
      app,
      'recordIsoExternalAuditResponse',
      { as: PERSON.sameer, params: params(held), body: { version: held.version } },
      'FORBIDDEN',
      403,
    );
    Object.assign(ncOf(finding), {
      state: 'ROOT_CAUSE_FOUND',
      containment: 'Scales taken out of use',
      correction: 'Scales recalibrated',
      rootCauseMethod: 'FIVE_WHYS',
      rootCause: 'No reminder for calibration',
      similarOccurrences: 'Checked the other site',
    });
    await fails(
      app,
      'recordIsoExternalAuditResponse',
      { params: params(held), body: { version: 1 } },
      'STALE_VERSION',
      409,
    );
    const responded = await ok<Audit>(app, 'recordIsoExternalAuditResponse', {
      as: PERSON.kabir,
      params: params(held),
      body: { version: held.version },
    });
    expect(responded).toMatchObject({ state: 'RESPONDED', allowedActions: ['CLOSE'] });
    expect(lastEvent(held.id)).toMatchObject({
      action: 'TRANSITION',
      before: { state: 'HELD' },
      after: { action: 'RECORD_RESPONSE', state: 'RESPONDED' },
    });
    // CLOSE from RESPONDED needs the recommendation, here or before.
    const none = await fails(
      app,
      'closeIsoExternalAudit',
      { params: params(responded), body: { version: responded.version } },
      'VALIDATION',
      400,
    );
    expect(none.error.details).toMatchObject({ issues: [{ path: ['body', 'recommendation'] }] });
    const recommended = await updateAudit(responded, {
      recommendation: 'RECOMMENDED_AFTER_CLOSURE',
    });
    const closed = await ok<Audit>(app, 'closeIsoExternalAudit', {
      as: PERSON.kabir,
      params: params(responded),
      body: { version: recommended.version },
    });
    expect(closed).toMatchObject({
      state: 'CLOSED',
      recommendation: 'RECOMMENDED_AFTER_CLOSURE',
      allowedActions: [],
    });
    expect(lastEvent(held.id)).toMatchObject({
      action: 'TRANSITION',
      before: { state: 'RESPONDED' },
      after: { action: 'CLOSE', state: 'CLOSED' },
    });
    const twice = await fails(
      app,
      'closeIsoExternalAudit',
      { params: params(closed), body: { version: closed.version } },
      'INVALID_TRANSITION',
      409,
    );
    expect(twice.error.details).toMatchObject({ from: 'CLOSED', action: 'CLOSE' });
  });

  it('CLOSE goes straight from HELD only when no finding raised a nonconformity', async () => {
    const planned = await createAudit();
    await fails(
      app,
      'closeIsoExternalAudit',
      { params: params(planned), body: { version: 1, recommendation: 'RECOMMENDED' } },
      'INVALID_TRANSITION',
      409,
    );
    const held = await heldAudit();
    await ok(app, 'createIsoExternalFinding', {
      params: params(held),
      body: { type: 'GOOD_PRACTICE', description: 'Clear line clearance records' },
    });
    for (const as of [PERSON.divya, PERSON.rohan, PERSON.vikram]) {
      await fails(
        app,
        'closeIsoExternalAudit',
        {
          as,
          params: params(held),
          body: { version: held.version, recommendation: 'RECOMMENDED' },
        },
        'FORBIDDEN',
        403,
      );
    }
    await fails(
      app,
      'closeIsoExternalAudit',
      { params: params(held), body: { version: 1, recommendation: 'RECOMMENDED' } },
      'STALE_VERSION',
      409,
    );
    const closed = await ok<Audit>(app, 'closeIsoExternalAudit', {
      as: PERSON.meera,
      params: params(held),
      body: { version: held.version, recommendation: 'NOT_RECOMMENDED' },
    });
    expect(closed).toMatchObject({ state: 'CLOSED', recommendation: 'NOT_RECOMMENDED' });
    expect(lastEvent(held.id)).toMatchObject({
      before: { state: 'HELD', recommendation: null },
      after: {
        action: 'CLOSE',
        state: 'CLOSED',
        recommendation: 'NOT_RECOMMENDED',
        delegated: true,
      },
    });

    const raised = await heldAudit();
    await ok(app, 'createIsoExternalFinding', {
      params: params(raised),
      body: {
        type: 'MAJOR_NC',
        description: 'No evaluation of legal requirements',
        nonconformity: { ownerId: PERSON.sameer, approverId: PERSON.divya, dueOn: '2024-12-31' },
      },
    });
    const refused = await fails(
      app,
      'closeIsoExternalAudit',
      { params: params(raised), body: { version: raised.version, recommendation: 'RECOMMENDED' } },
      'VALIDATION',
      400,
    );
    expect(refused.error.details).toMatchObject({
      issues: [{ path: ['body', 'nonconformities'] }],
    });
  });
});

// ---------- findings ----------

const NC = { ownerId: PERSON.sameer, approverId: PERSON.divya, dueOn: '2024-12-15' };

const createFinding = (audit: Audit, body: Record<string, unknown>, as: string = PERSON.meera) =>
  ok<Finding>(app, 'createIsoExternalFinding', {
    as,
    params: params(audit),
    body: { type: 'OBSERVATION', description: 'Training records were incomplete', ...body },
  });

const findingParams = (audit: Audit, finding: Finding) => ({
  ...params(audit),
  findingId: finding.id,
});

const updateFinding = (
  audit: Audit,
  finding: Finding,
  body: Record<string, unknown>,
  as: string = PERSON.meera,
) =>
  ok<Finding>(app, 'updateIsoExternalFinding', {
    as,
    params: findingParams(audit, finding),
    body: { version: finding.version, ...body },
  });

describe('createIsoExternalFinding', () => {
  it('records a finding of a HELD visit only, audited under its own type', async () => {
    const planned = await createAudit();
    const early = await fails(
      app,
      'createIsoExternalFinding',
      { params: params(planned), body: { type: 'OFI', description: 'Too early' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(early.error.details).toEqual({
      entity: 'external_audit',
      from: 'PLANNED',
      action: 'UPDATE',
    });
    const held = await heldAudit();
    const finding = await createFinding(held, {
      clauseIds: [clause('ISO_9001', '7.2')],
      unitId: BENGALURU,
    });
    expect(finding).toMatchObject({
      clientId: NORTHWIND,
      internalAuditId: null,
      externalAuditId: held.id,
      type: 'OBSERVATION',
      clauseIds: [clause('ISO_9001', '7.2')],
      unitId: BENGALURU,
      nonconformityId: null,
      version: 1,
    });
    expect(isoEvents(app, finding.id)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        entityType: 'audit_finding',
        after: expect.objectContaining({ externalAuditId: held.id, type: 'OBSERVATION' }),
      }),
    ]);
  });

  it("reports a finding's nonconformity on the client's day, which it is due no earlier than", async () => {
    // Now is 06:30 UTC on TODAY: 19:30 the day before for a client in Pago Pago (UTC-11).
    const client = firmB(app).data.clients.find((c) => c.id === NORTHWIND)!;
    const zone = client.settings.timeZone;
    client.settings.timeZone = 'Pacific/Pago_Pago';
    try {
      const held = await heldAudit(all, { standardIds: [std('ISO_9001')] });
      const yesterday = addDays(TODAY, -1);
      const raise = (dueOn: string) => ({
        type: 'MINOR_NC',
        description: 'Calibration labels missing',
        clauseIds: [clause('ISO_9001', '7.1.5')],
        unitId: PUNE,
        nonconformity: { ...NC, dueOn },
      });
      const finding = await createFinding(held, raise(yesterday), PERSON.kabir);
      expect(ncOf(finding)).toMatchObject({ reportedOn: yesterday, dueOn: yesterday });
      await fails(
        app,
        'createIsoExternalFinding',
        { as: PERSON.kabir, params: params(held), body: raise(addDays(TODAY, -2)) },
        'VALIDATION',
        400,
      );
    } finally {
      client.settings.timeZone = zone;
    }
  });

  it('raises the nonconformity of a MAJOR_NC: OPEN, EXTERNAL_AUDIT, linked and audited', async () => {
    const held = await heldAudit(all, { standardIds: [std('ISO_9001'), std('ISO_45001')] });
    const before = Math.max(
      0,
      ...firmB(app)
        .iso.nonconformities.filter((n) => n.clientId === NORTHWIND)
        .map((n) => n.number),
    );
    const finding = await createFinding(
      held,
      {
        type: 'MAJOR_NC',
        description: 'Hazards of the new line were not assessed',
        clauseIds: [clause('ISO_45001', '6.1.2')],
        unitId: PUNE,
        nonconformity: { ownerId: PERSON.rohan, approverId: PERSON.nisha, dueOn: TODAY },
      },
      PERSON.kabir,
    );
    const nc = ncOf(finding);
    expect(finding.nonconformityId).toBe(nc.id);
    expect(Nonconformity.safeParse(nc).success).toBe(true);
    expect(nc).toMatchObject({
      clientId: NORTHWIND,
      managementSystemId: all.id,
      number: before + 1,
      source: 'EXTERNAL_AUDIT',
      severity: 'MAJOR',
      standards: ['ISO_45001'],
      clauseIds: [clause('ISO_45001', '6.1.2')],
      unitId: PUNE,
      description: 'Hazards of the new line were not assessed',
      reportedById: PERSON.kabir,
      reportedOn: TODAY,
      ownerId: PERSON.rohan,
      approverId: PERSON.nisha,
      dueOn: TODAY,
      state: 'OPEN',
      incident: null,
      version: 1,
    });
    expect(isoEvents(app, nc.id)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        entityType: 'nonconformity',
        actorId: PERSON.kabir,
        after: expect.objectContaining({
          action: 'RAISE',
          auditFindingId: finding.id,
          source: 'EXTERNAL_AUDIT',
          state: 'OPEN',
        }),
      }),
    ]);
    expect(lastEvent(finding.id).after).toMatchObject({ nonconformityId: nc.id });
    const next = await createFinding(held, { type: 'MINOR_NC', nonconformity: NC });
    expect(ncOf(next).number).toBe(before + 2);
    // No clauses or unit: the audit's standards, and no unit on a system of several units.
    expect(ncOf(next)).toMatchObject({
      severity: 'MINOR',
      standards: ['ISO_9001', 'ISO_45001'],
      clauseIds: [],
      unitId: null,
    });
  });

  it("takes the system's single unit for the nonconformity when the finding names none", async () => {
    const held = await heldAudit(quality);
    const finding = await createFinding(held, {
      type: 'MINOR_NC',
      nonconformity: { ownerId: PERSON.rohan, approverId: PERSON.nisha, dueOn: '2024-12-01' },
    });
    expect(finding.unitId).toBeNull();
    expect(ncOf(finding)).toMatchObject({ unitId: PUNE, standards: ['ISO_9001'] });
    const chennai = await heldAudit(harbour);
    const last = Math.max(
      0,
      ...firmB(app)
        .iso.nonconformities.filter((n) => n.clientId === HARBOUR)
        .map((n) => n.number),
    );
    const harbourFinding = await createFinding(
      chennai,
      {
        type: 'MAJOR_NC',
        nonconformity: { ownerId: PERSON.joseph, approverId: PERSON.priya, dueOn: '2024-12-01' },
      },
      PERSON.leela,
    );
    expect(ncOf(harbourFinding)).toMatchObject({
      clientId: HARBOUR,
      unitId: CHENNAI,
      number: last + 1,
    });
  });

  it('checks the nonconformity body, its people and its due date', async () => {
    const held = await heldAudit();
    const request = (body: Record<string, unknown>) => ({
      params: params(held),
      body: { type: 'MAJOR_NC', description: 'Missing permits', ...body },
    });
    await fails(app, 'createIsoExternalFinding', request({}), 'VALIDATION', 400);
    await fails(
      app,
      'createIsoExternalFinding',
      request({ type: 'OFI', nonconformity: NC }),
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'createIsoExternalFinding',
      request({ nonconformity: { ...NC, approverId: NC.ownerId } }),
      'VALIDATION',
      400,
    );
    const outside = await fails(
      app,
      'createIsoExternalFinding',
      request({ unitId: BENGALURU, nonconformity: { ...NC, ownerId: PERSON.rohan } }),
      'VALIDATION',
      400,
    );
    expect(outside.error.details).toMatchObject({
      issues: [{ path: ['body', 'nonconformity', 'ownerId'] }],
    });
    for (const approverId of [PERSON.vikram, PERSON.gita, PERSON.priya]) {
      const refused = await fails(
        app,
        'createIsoExternalFinding',
        request({ nonconformity: { ...NC, approverId } }),
        'VALIDATION',
        400,
      );
      expect(refused.error.details).toMatchObject({
        issues: [{ path: ['body', 'nonconformity', 'approverId'] }],
      });
    }
    const past = await fails(
      app,
      'createIsoExternalFinding',
      request({ nonconformity: { ...NC, dueOn: '2024-11-14' } }),
      'VALIDATION',
      400,
    );
    expect(past.error.details).toMatchObject({
      issues: [{ path: ['body', 'nonconformity', 'dueOn'] }],
    });
    expect(firmB(app).iso.findings.filter((f) => f.externalAuditId === held.id)).toHaveLength(0);
  });

  it("refuses clauses outside the audit's standards and units outside its system", async () => {
    const held = await heldAudit(quality);
    const request = (body: Record<string, unknown>) => ({
      params: params(held),
      body: { type: 'OFI', description: 'Could improve', ...body },
    });
    for (const clauseIds of [[clause('ISO_14001', '6.1.2')], [seedId()]]) {
      const refused = await fails(
        app,
        'createIsoExternalFinding',
        request({ clauseIds }),
        'VALIDATION',
        400,
      );
      expect(refused.error.details).toMatchObject({ issues: [{ path: ['body', 'clauseIds'] }] });
    }
    const unit = await fails(
      app,
      'createIsoExternalFinding',
      request({ unitId: BENGALURU }),
      'VALIDATION',
      400,
    );
    expect(unit.error.details).toMatchObject({ issues: [{ path: ['body', 'unitId'] }] });
  });

  it('is isoCertification.write within unit scope', async () => {
    const held = await heldAudit();
    const body = { type: 'OFI', description: 'Could improve' };
    for (const as of [PERSON.divya, PERSON.nisha, PERSON.sameer, PERSON.rohan, PERSON.vikram]) {
      await fails(
        app,
        'createIsoExternalFinding',
        { as, params: params(held), body },
        'FORBIDDEN',
        403,
      );
    }
    await createFinding(held, {}, PERSON.arjun);
    const bengaluru = await heldAudit(blr);
    await fails(
      app,
      'createIsoExternalFinding',
      { as: PERSON.nisha, params: params(bengaluru), body },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'createIsoExternalFinding',
      { params: { ...audit404() }, body },
      'NOT_FOUND',
      404,
    );
  });
});

describe('listIsoExternalFindings', () => {
  it("lists the audit's findings in the order recorded, for every reader in scope", async () => {
    const held = await heldAudit();
    const other = await heldAudit();
    const first = await createFinding(held, { type: 'OFI' });
    const second = await createFinding(held, { type: 'MINOR_NC', nonconformity: NC });
    await createFinding(other, {});
    for (const as of [PERSON.meera, PERSON.kabir, PERSON.nisha, PERSON.rohan, PERSON.vikram]) {
      const listed = await ok<{ items: Finding[] }>(app, 'listIsoExternalFindings', {
        as,
        params: params(held),
      });
      expect(ids(listed.items)).toEqual([first.id, second.id]);
    }
    const bengaluru = await heldAudit(blr);
    await fails(
      app,
      'listIsoExternalFindings',
      { as: PERSON.rohan, params: params(bengaluru) },
      'NOT_FOUND',
      404,
    );
    const empty = await ok<{ items: Finding[] }>(app, 'listIsoExternalFindings', {
      params: params(bengaluru),
    });
    expect(empty.items).toEqual([]);
  });
});

describe('updateIsoExternalFinding', () => {
  it('changes a finding while the visit is HELD, audited as UPDATE', async () => {
    const held = await heldAudit();
    const finding = await createFinding(held, {});
    const changed = await updateFinding(
      held,
      finding,
      {
        type: 'OFI',
        clauseIds: [clause('ISO_9001', '7.2')],
        unitId: PUNE,
        description: 'Training records could be kept online',
      },
      PERSON.kabir,
    );
    expect(changed).toMatchObject({
      type: 'OFI',
      clauseIds: [clause('ISO_9001', '7.2')],
      unitId: PUNE,
      version: 2,
    });
    expect(lastEvent(finding.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'audit_finding',
      before: { type: 'OBSERVATION', clauseIds: [], unitId: null },
      after: { type: 'OFI', unitId: PUNE },
    });
    const cleared = await updateFinding(held, changed, { unitId: null });
    expect(cleared.unitId).toBeNull();
  });

  it('keeps a finding within its family; MAJOR_NC and MINOR_NC carry the severity across', async () => {
    const held = await heldAudit();
    const observation = await createFinding(held, {});
    const toNc = await fails(
      app,
      'updateIsoExternalFinding',
      { params: findingParams(held, observation), body: { version: 1, type: 'MAJOR_NC' } },
      'VALIDATION',
      400,
    );
    expect(toNc.error.details).toMatchObject({ issues: [{ path: ['body', 'type'] }] });
    const major = await createFinding(held, { type: 'MAJOR_NC', nonconformity: NC });
    await fails(
      app,
      'updateIsoExternalFinding',
      { params: findingParams(held, major), body: { version: 1, type: 'OBSERVATION' } },
      'VALIDATION',
      400,
    );
    const minor = await updateFinding(held, major, { type: 'MINOR_NC' });
    expect(minor.type).toBe('MINOR_NC');
    const nc = ncOf(minor);
    expect(nc).toMatchObject({ severity: 'MINOR', version: 2 });
    expect(lastEvent(nc.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'nonconformity',
      before: { severity: 'MAJOR' },
      after: { severity: 'MINOR' },
    });
    const raisedMinor = await createFinding(held, { type: 'MINOR_NC', nonconformity: NC });
    const raisedMajor = await updateFinding(held, raisedMinor, { type: 'MAJOR_NC' });
    expect(ncOf(raisedMajor)).toMatchObject({ severity: 'MAJOR', version: 2 });
    // Once the nonconformity is CANCELLED its severity is fixed.
    Object.assign(nc, { state: 'CANCELLED', cancelReason: 'Raised twice' });
    const fixed = await fails(
      app,
      'updateIsoExternalFinding',
      { params: findingParams(held, minor), body: { version: minor.version, type: 'MAJOR_NC' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(fixed.error.details).toEqual({
      entity: 'nonconformity',
      from: 'CANCELLED',
      action: 'UPDATE',
    });
    // Its other fields still change.
    const described = await updateFinding(held, minor, { description: 'Restated' });
    expect(described.description).toBe('Restated');
  });

  it('moves MAJOR_NC and MINOR_NC while the NC is OPEN or ROOT_CAUSE_FOUND, never by its owner', async () => {
    const held = await heldAudit();
    // kabir, the client admin, owns the NC; meera and arjun manage the client too.
    let finding = await createFinding(held, {
      type: 'MINOR_NC',
      nonconformity: { ...NC, ownerId: PERSON.kabir },
    });
    const nc = ncOf(finding);
    const onNc = { clientId: nc.clientId, id: nc.id };
    /** Refuses a type move and changes nothing: no event, the finding and its NC as they were. */
    const refused = async (as: string, type: string, code: string, status: number) => {
      const events = firmB(app).data.auditEvents.length;
      const was = { state: nc.state, severity: nc.severity, version: nc.version };
      const out = await fails(
        app,
        'updateIsoExternalFinding',
        { as, params: findingParams(held, finding), body: { version: finding.version, type } },
        code,
        status,
      );
      expect(firmB(app).data.auditEvents).toHaveLength(events);
      expect(firmB(app).iso.findings.find((f) => f.id === finding.id)).toMatchObject({
        type: finding.type,
        version: finding.version,
      });
      expect(nc).toMatchObject(was);
      return out.error.details;
    };

    // OPEN: the owner is refused though they may write the visit; a consultant moves it and the severity follows.
    expect(await refused(PERSON.kabir, 'MAJOR_NC', 'FORBIDDEN', 403)).toEqual({
      action: 'isoCertification.write',
    });
    finding = await updateFinding(held, finding, { type: 'MAJOR_NC' }, PERSON.arjun);
    expect(finding).toMatchObject({ type: 'MAJOR_NC', version: 2 });
    expect(nc).toMatchObject({ state: 'OPEN', severity: 'MAJOR', version: 2 });
    expect(lastEvent(nc.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'nonconformity',
      actorId: PERSON.arjun,
      before: { severity: 'MINOR' },
      after: { severity: 'MAJOR' },
    });
    // Only the move is closed to the owner: their other edits keep today's rules.
    finding = await updateFinding(
      held,
      finding,
      { clauseIds: [clause('ISO_9001', '7.2')], description: 'Restated by the client' },
      PERSON.kabir,
    );
    expect(finding).toMatchObject({
      type: 'MAJOR_NC',
      clauseIds: [clause('ISO_9001', '7.2')],
      version: 3,
    });
    expect(nc.version).toBe(2);

    // ROOT_CAUSE_FOUND: still open to the move.
    await ok(app, 'addIsoNcRootCause', {
      as: PERSON.kabir,
      params: onNc,
      body: {
        version: nc.version,
        containment: 'Checked the records of every starter this year',
        correction: 'Completed the missing records',
        rootCauseMethod: 'FIVE_WHYS',
        rootCause: 'Records were kept by each supervisor',
        similarOccurrences: 'None at the other units',
      },
    });
    expect(nc).toMatchObject({ state: 'ROOT_CAUSE_FOUND', version: 3 });
    expect(await refused(PERSON.kabir, 'MINOR_NC', 'FORBIDDEN', 403)).toEqual({
      action: 'isoCertification.write',
    });
    finding = await updateFinding(held, finding, { type: 'MINOR_NC' });
    expect(finding).toMatchObject({ type: 'MINOR_NC', version: 4 });
    expect(nc).toMatchObject({ state: 'ROOT_CAUSE_FOUND', severity: 'MINOR', version: 4 });
    expect(lastEvent(nc.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'nonconformity',
      actorId: PERSON.meera,
      before: { severity: 'MAJOR' },
      after: { severity: 'MINOR' },
    });

    // ACTIONS_PLANNED and AWAITING_VERIFICATION: 409 for everyone, and still 403 for the owner.
    const action = seed(app, 'actions', {
      ...base(),
      subject: { type: 'NONCONFORMITY', id: nc.id },
      text: 'Keep training records in one register.',
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
      as: PERSON.kabir,
      params: onNc,
      body: { version: nc.version, effectivenessDueOn: addDays(TODAY, 30) },
    });
    expect(nc).toMatchObject({ state: 'ACTIONS_PLANNED', severity: 'MINOR', version: 5 });
    for (const as of [PERSON.meera, PERSON.arjun]) {
      expect(await refused(as, 'MAJOR_NC', 'INVALID_TRANSITION', 409)).toEqual({
        entity: 'nonconformity',
        from: 'ACTIONS_PLANNED',
        action: 'UPDATE',
      });
    }
    expect(await refused(PERSON.kabir, 'MAJOR_NC', 'FORBIDDEN', 403)).toEqual({
      action: 'isoCertification.write',
    });
    Object.assign(action, { state: 'DONE', doneOn: TODAY });
    await ok(app, 'submitIsoNc', {
      as: PERSON.kabir,
      params: onNc,
      body: {
        version: nc.version,
        riskReview: 'None needed',
        systemChange: 'One training register for the client',
      },
    });
    expect(nc).toMatchObject({ state: 'AWAITING_VERIFICATION', severity: 'MINOR', version: 6 });
    expect(await refused(PERSON.meera, 'MAJOR_NC', 'INVALID_TRANSITION', 409)).toEqual({
      entity: 'nonconformity',
      from: 'AWAITING_VERIFICATION',
      action: 'UPDATE',
    });
    expect(await refused(PERSON.kabir, 'MAJOR_NC', 'FORBIDDEN', 403)).toEqual({
      action: 'isoCertification.write',
    });
    // The finding's other fields still change.
    finding = await updateFinding(held, finding, { description: 'Restated again' }, PERSON.arjun);
    expect(finding).toMatchObject({ type: 'MINOR_NC', version: 5 });
    expect(nc.version).toBe(6);
  });

  it('refuses GOOD_PRACTICE while the finding has live improvement actions', async () => {
    const held = await heldAudit();
    const ofi = await createFinding(held, { type: 'OFI' });
    const action = seed(app, 'actions', {
      ...base(),
      subject: { type: 'AUDIT_FINDING', id: ofi.id },
      text: 'Move training records online',
      resources: null,
      ownerId: PERSON.sameer,
      dueOn: '2024-12-31',
      doneOn: null,
      state: 'OPEN',
      effectivenessNote: null,
      cancelReason: null,
      controlHierarchy: null,
      outputKey: null,
    });
    const refused = await fails(
      app,
      'updateIsoExternalFinding',
      { params: findingParams(held, ofi), body: { version: 1, type: 'GOOD_PRACTICE' } },
      'VALIDATION',
      400,
    );
    expect(refused.error.details).toMatchObject({ issues: [{ path: ['body', 'type'] }] });
    Object.assign(action, { state: 'CANCELLED', cancelReason: 'Not needed' });
    const good = await updateFinding(held, ofi, { type: 'GOOD_PRACTICE' });
    expect(good.type).toBe('GOOD_PRACTICE');
  });

  it('checks clauses, unit and version, and 404s a finding of another audit', async () => {
    const held = await heldAudit(quality);
    const finding = await createFinding(held, {});
    const request = (body: Record<string, unknown>) => ({
      params: findingParams(held, finding),
      body: { version: 1, ...body },
    });
    const clauses = await fails(
      app,
      'updateIsoExternalFinding',
      request({ clauseIds: [clause('ISO_45001', '8.2')] }),
      'VALIDATION',
      400,
    );
    expect(clauses.error.details).toMatchObject({ issues: [{ path: ['body', 'clauseIds'] }] });
    await fails(app, 'updateIsoExternalFinding', request({ unitId: BENGALURU }), 'VALIDATION', 400);
    await fails(
      app,
      'updateIsoExternalFinding',
      request({ version: 4, description: 'X' }),
      'STALE_VERSION',
      409,
    );
    const other = await heldAudit(quality);
    await fails(
      app,
      'updateIsoExternalFinding',
      { params: findingParams(other, finding), body: { version: 1, description: 'X' } },
      'NOT_FOUND',
      404,
    );
    for (const as of [PERSON.nisha, PERSON.rohan, PERSON.vikram]) {
      await fails(
        app,
        'updateIsoExternalFinding',
        { as, ...request({ description: 'X' }) },
        'FORBIDDEN',
        403,
      );
    }
    const bengaluru = await heldAudit(blr);
    const hidden = await createFinding(bengaluru, {});
    await fails(
      app,
      'updateIsoExternalFinding',
      {
        as: PERSON.nisha,
        params: findingParams(bengaluru, hidden),
        body: { version: 1, description: 'X' },
      },
      'NOT_FOUND',
      404,
    );
  });

  it('locks the findings once the visit has moved on (model §6)', async () => {
    const held = await heldAudit();
    const finding = await createFinding(held, { type: 'MINOR_NC', nonconformity: NC });
    Object.assign(ncOf(finding), { state: 'CANCELLED', cancelReason: 'Withdrawn by the body' });
    const responded = await ok<Audit>(app, 'recordIsoExternalAuditResponse', {
      params: params(held),
      body: { version: held.version },
    });
    const edit = await fails(
      app,
      'updateIsoExternalFinding',
      { params: findingParams(held, finding), body: { version: 1, description: 'Late' } },
      'INVALID_TRANSITION',
      409,
    );
    expect(edit.error.details).toEqual({
      entity: 'external_audit',
      from: 'RESPONDED',
      action: 'UPDATE',
    });
    const closed = await ok<Audit>(app, 'closeIsoExternalAudit', {
      params: params(held),
      body: { version: responded.version, recommendation: 'RECOMMENDED' },
    });
    for (const id of ['createIsoExternalFinding', 'updateIsoExternalFinding'] as const) {
      const refused = await fails(
        app,
        id,
        {
          params: findingParams(closed, finding),
          body:
            id === 'createIsoExternalFinding'
              ? { type: 'OFI', description: 'Late' }
              : { version: 1, description: 'Late' },
        },
        'INVALID_TRANSITION',
        409,
      );
      expect(refused.error.details).toMatchObject({ from: 'CLOSED', action: 'UPDATE' });
    }
    // The locked audit's findings are still read.
    const listed = await ok<{ items: Finding[] }>(app, 'listIsoExternalFindings', {
      as: PERSON.vikram,
      params: params(closed),
    });
    expect(ids(listed.items)).toEqual([finding.id]);
  });
});

describe('the finding audit trail', () => {
  it('never copies the description of a finding or its nonconformity (non-negotiable 6)', async () => {
    const held = await heldAudit(all, { standardIds: [std('ISO_45001')] });
    const raisedText = 'A rigger at the Pune store climbed the racking without a harness';
    const editedText = 'Two riggers at the Pune store climbed the racking without harnesses';
    const finding = await createFinding(held, {
      type: 'MAJOR_NC',
      description: raisedText,
      clauseIds: [clause('ISO_45001', '6.1.2')],
      unitId: PUNE,
      nonconformity: { ownerId: PERSON.rohan, approverId: PERSON.nisha, dueOn: TODAY },
    });
    const nc = ncOf(finding);
    expect(nc.description).toBe(raisedText);
    // The RAISE carries what a hand RAISE does, and the finding.
    expect(isoEvents(app, nc.id)[0]!.after).toEqual({
      action: 'RAISE',
      number: nc.number,
      source: 'EXTERNAL_AUDIT',
      severity: 'MAJOR',
      standards: ['ISO_45001'],
      clauseIds: [clause('ISO_45001', '6.1.2')],
      unitId: PUNE,
      sourceInstanceId: null,
      raisedFromRiskItemId: null,
      ownerId: PERSON.rohan,
      approverId: PERSON.nisha,
      dueOn: TODAY,
      state: 'OPEN',
      auditFindingId: finding.id,
    });
    expect(isoEvents(app, finding.id)[0]!.after).toEqual({
      externalAuditId: held.id,
      type: 'MAJOR_NC',
      clauseIds: [clause('ISO_45001', '6.1.2')],
      unitId: PUNE,
      nonconformityId: nc.id,
    });
    const edited = await updateFinding(held, finding, { description: editedText });
    expect(edited).toMatchObject({ description: editedText, version: 2 });
    expect(isoEvents(app, finding.id)).toHaveLength(2);
    expect(lastEvent(finding.id)).toMatchObject({
      action: 'UPDATE',
      entityType: 'audit_finding',
      before: { description: '[not recorded]' },
      after: { description: '[not recorded]' },
    });
    const trail = JSON.stringify(
      firmB(app).data.auditEvents.filter((e) => e.clientId === NORTHWIND),
    );
    expect(trail).not.toContain(raisedText);
    expect(trail).not.toContain(editedText);
  });
});

// ---------- the certification cycle (model §5.2) ----------

describe('certification cycle', () => {
  it('meets each date with the right held visit of the current cycle, on time or late', async () => {
    const system = seedSystem(app, { standards: ['ISO_9001', 'ISO_14001'] });
    const closed = { state: 'CLOSED' as const, recommendation: 'RECOMMENDED' as const };
    // Surveillance 1 of the previous cycle, the one that meets it, and a later one.
    seedAudit(system, { ...closed, startOn: '2022-06-09', endOn: '2022-06-10' });
    const s1 = seedAudit(system, { ...closed, startOn: '2023-10-18', endOn: '2023-10-20' });
    seedAudit(system, { state: 'HELD', startOn: '2023-12-01', endOn: '2023-12-01' });
    // Surveillance 2 visits that do not count: before surveillance 1, another standard, not held, another system.
    const s2 = { type: 'SURVEILLANCE_2' as const };
    seedAudit(system, { ...s2, ...closed, startOn: '2023-10-01', endOn: '2023-10-01' });
    const env = seedAudit(system, {
      ...s2,
      state: 'HELD',
      standardIds: [std('ISO_14001')],
      startOn: '2024-10-14',
      endOn: '2024-10-15',
    });
    seedAudit(system, { ...s2, startOn: '2024-10-24', endOn: '2024-10-25' });
    seedAudit(system, {
      ...s2,
      state: 'CANCELLED',
      cancelReason: 'Rescheduled',
      startOn: '2024-10-26',
      endOn: '2024-10-26',
    });
    seedAudit(quality, { ...s2, state: 'HELD', startOn: '2024-10-20', endOn: '2024-10-20' });

    const quality9001 = await createCert(system, ISSUED);
    expect(quality9001.cycle.items).toEqual([
      {
        kind: 'SURVEILLANCE_1',
        dueOn: '2023-11-01',
        metByAuditId: s1.id,
        metOn: '2023-10-20',
        daysLate: null,
        overdueDays: null,
      },
      {
        kind: 'SURVEILLANCE_2',
        dueOn: '2024-11-01',
        metByAuditId: null,
        metOn: null,
        daysLate: null,
        overdueDays: 14,
      },
      {
        kind: 'RECERTIFICATION',
        dueOn: '2025-10-31',
        metByAuditId: null,
        metOn: null,
        daysLate: null,
        overdueDays: null,
      },
    ]);
    // With surveillance 1 open, surveillance 2 needs only to end after the issue.
    const env14001 = await createCert(system, {
      ...ISSUED,
      standardId: std('ISO_14001'),
      certificateNumber: 'E-1001',
    });
    expect(env14001.cycle.items.map((i) => [i.kind, i.metByAuditId, i.overdueDays])).toEqual([
      ['SURVEILLANCE_1', null, daysFrom('2023-11-01', TODAY)],
      ['SURVEILLANCE_2', env.id, null],
      ['RECERTIFICATION', null, null],
    ]);

    // Surveillance 2 held late through the API meets its date late.
    const late = await heldAudit(system, {
      type: 'SURVEILLANCE_2',
      standardIds: [std('ISO_9001')],
      startOn: '2024-11-08',
      endOn: '2024-11-10',
    });
    const listed = await listCerts({ managementSystemId: system.id, standardId: std('ISO_9001') });
    expect(listed.items[0]!.cycle.items[1]).toEqual({
      kind: 'SURVEILLANCE_2',
      dueOn: '2024-11-01',
      metByAuditId: late.id,
      metOn: '2024-11-10',
      daysLate: 9,
      overdueDays: null,
    });
  });

  it('meets recertification with a RECERTIFICATION visit of the cycle, late after expiry', async () => {
    const system = seedSystem(app, { standards: ['ISO_45001'] });
    const recert = seedAudit(system, {
      type: 'RECERTIFICATION',
      standardIds: [std('ISO_45001')],
      state: 'RESPONDED',
      startOn: '2024-06-08',
      endOn: '2024-06-10',
    });
    const cert = await createCert(system, {
      certificateNumber: 'S-77',
      issuedOn: '2021-06-01',
      expiresOn: '2024-05-31',
    });
    expect(cert.cycle.items).toEqual([
      {
        kind: 'SURVEILLANCE_1',
        dueOn: '2022-06-01',
        metByAuditId: null,
        metOn: null,
        daysLate: null,
        overdueDays: daysFrom('2022-06-01', TODAY),
      },
      {
        kind: 'SURVEILLANCE_2',
        dueOn: '2023-06-01',
        metByAuditId: null,
        metOn: null,
        daysLate: null,
        overdueDays: daysFrom('2023-06-01', TODAY),
      },
      {
        kind: 'RECERTIFICATION',
        dueOn: '2024-05-31',
        metByAuditId: recert.id,
        metOn: '2024-06-10',
        daysLate: 10,
        overdueDays: null,
      },
    ]);
    // A month-end issue date clamps: 29 February plus 12 months is 28 February.
    const leap = await createCert(system, {
      certificateNumber: 'S-78',
      issuedOn: '2024-02-29',
      expiresOn: '2027-02-28',
    });
    expect(leap.cycle.items.map((i) => i.dueOn)).toEqual([
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
    ]);
  });

  it('reads the visits of an archived audit as gone', async () => {
    const system = seedSystem(app, { standards: ['ISO_9001'] });
    seedAudit(system, {
      state: 'HELD',
      startOn: '2023-10-01',
      endOn: '2023-10-02',
      archivedAt: NOW,
    });
    const cert = await createCert(system, ISSUED);
    expect(cert.cycle.items[0]!.metByAuditId).toBeNull();
    // An archived audit answers 404 too.
    const archived = seedAudit(system, { archivedAt: NOW });
    await fails(app, 'getIsoExternalAudit', { params: params(archived) }, 'NOT_FOUND', 404);
    expect(ids((await listAudits({ managementSystemId: system.id })).items)).toEqual([]);
  });
});

describe('the add-on switch (plan §4.4)', () => {
  it('answers 403 FEATURE_NOT_ENABLED on every route of the area while the add-on is off', async () => {
    const audit = await createAudit();
    await setFeatures(app, []);
    try {
      await fails(app, 'listIsoCertifications', {}, 'FEATURE_NOT_ENABLED', 403);
      await fails(
        app,
        'getIsoExternalAudit',
        { params: params(audit) },
        'FEATURE_NOT_ENABLED',
        403,
      );
      await fails(
        app,
        'cancelIsoExternalAudit',
        { params: params(audit), body: { version: 1, reason: 'Off' } },
        'FEATURE_NOT_ENABLED',
        403,
      );
    } finally {
      await setFeatures(app, ['isoManagement']);
    }
    expect((await getAudit(audit)).state).toBe('PLANNED');
    expect((await call(app, 'listIsoCertifications', { as: null })).status).toBe(401);
  });
});
