import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerIsoRoutes } from './routes.js';
import { createFakeIsoFiles } from './testing/fake-files.js';
import { attach, createHarness, type Harness, type Who } from './testing/fixture.js';

/**
 * M16's gate (plan §7 item 2), modelled on M7's but on M16's own fixtures: every route M16 registers, reads and file
 * routes included, has one row. Each row asserts the exact AuditEvents and outbox events a successful request writes
 * (ISO records write no outbox events), and that a refused request, by role and with the feature off, writes none.
 * File rows assert the one `IsoFiles` call a success makes and that a refusal makes none; the AuditEvents those calls
 * write are ISO-15's to test. A new ISO route without a row fails the first test.
 */

const NOW = new Date('2026-10-20T06:00:00Z');
const ROOT = '/api/v1/clients/:clientId/iso';
let h: Harness;

beforeAll(async () => {
  h = await createHarness('Gate', NOW);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

interface Request {
  who: Who;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  payload?: object;
}

interface GateCase {
  change: Request;
  /** AuditEvent actions the change writes. */
  audit: string[];
  /** The `IsoFiles` method a successful file request calls once. */
  port?: string;
  /** A request refused by role after the record is loaded, which must write nothing. */
  refused?: Request & { status: number };
}

const get = (who: Who, path: string): Request => ({ who, method: 'GET', path });
const post = (who: Who, path: string, payload: object = {}): Request => ({
  who,
  method: 'POST',
  path,
  payload,
});
const patch = (who: Who, path: string, payload: object): Request => ({
  who,
  method: 'PATCH',
  path,
  payload,
});
const no = <T extends Request>(r: T, status: number) => ({ ...r, status });

// ---------- fresh records, one set per row ----------

async function system(): Promise<string> {
  const s = await h.ok('clientAdmin', 'POST', '/systems', {
    name: `Gate ${Math.random().toString(36).slice(2, 8)}`,
    standardIds: [h.f.std9001],
    unitIds: [h.f.unitA],
  });
  return s.id as string;
}

async function row(number = '10.1') {
  const id = await system();
  const { items } = (await h.ok('clientAdmin', 'GET', `/systems/${id}/checklist`)) as {
    items: { id: string; clauseNumber: string }[];
  };
  const r = items.find((i) => i.clauseNumber === number)!;
  return { systemId: id, rowId: r.id, path: `/systems/${id}/checklist/${r.id}` };
}

/** Clause 8.3, owned by the unit A owner (version 2). */
async function exclusionRow() {
  const r = await row('8.3');
  await h.ok('clientAdmin', 'PATCH', r.path, {
    version: 1,
    ownerId: h.f.people.owner,
    reason: 'Design lead',
  });
  return r;
}

async function naRequested() {
  const r = await exclusionRow();
  await h.ok('owner', 'POST', `${r.path}/na-request`, { version: 2, reason: 'No design work' });
  return r;
}

let codes = 0;
async function document(type = 'PROCEDURE') {
  codes += 1;
  const doc = await h.ok('clientAdmin', 'POST', '/documents', {
    managementSystemId: await system(),
    code: `GATE-${codes}`,
    title: 'Gate document',
    type,
    ownerId: h.f.people.owner,
    approverId: h.f.people.approver,
    ...(type === 'EXTERNAL' ? { issuer: 'Northwind Standards', externalRef: 'NW-1' } : {}),
  });
  return { id: doc.id as string, path: `/documents/${doc.id}` };
}

async function draft(type = 'PROCEDURE') {
  const doc = await document(type);
  const rev = await h.ok('owner', 'POST', `${doc.path}/revisions`, {
    revision: 'A',
    changeNote: 'First issue',
  });
  return { ...doc, revisionId: rev.id as string, revPath: `${doc.path}/revisions/${rev.id}` };
}

async function withCleanFile(type = 'PROCEDURE') {
  const d = await draft(type);
  const file = await attach(h, 'owner', { type: 'document_revision', id: d.revisionId });
  await h.scan(file.id as string, 'CLEAN');
  return d;
}

async function inReview() {
  const d = await withCleanFile();
  await h.ok('owner', 'POST', `${d.revPath}/submit`, { version: 1 });
  return d;
}

async function inForce() {
  const d = await inReview();
  await h.ok('approver', 'POST', `${d.revPath}/approve`, { version: 2 });
  const version = (await h.ok('approver', 'GET', d.path)).version as number;
  return { ...d, version };
}

async function certificate() {
  const cert = await h.ok('clientAdmin', 'POST', '/certifications', {
    managementSystemId: await system(),
    standardId: h.f.std9001,
    body: 'Northwind Certification',
  });
  return `/certifications/${cert.id}`;
}

async function visit(endOn = '2026-10-13') {
  const v = await h.ok('clientAdmin', 'POST', '/external-audits', {
    managementSystemId: await system(),
    standardIds: [h.f.std9001],
    type: 'SURVEILLANCE_1',
    body: 'Northwind Certification',
    startOn: '2026-10-12',
    endOn,
  });
  return { id: v.id as string, path: `/external-audits/${v.id}` };
}

async function held() {
  const v = await visit();
  await attach(h, 'clientAdmin', { type: 'external_audit', id: v.id }, 'report.pdf');
  await h.ok('clientAdmin', 'POST', `${v.path}/held`, {
    version: 1,
    startOn: '2026-10-12',
    endOn: '2026-10-13',
  });
  return v;
}

async function externalFinding() {
  const v = await held();
  const f = await h.ok('clientAdmin', 'POST', `${v.path}/findings`, {
    type: 'OFI',
    description: 'Labels could be clearer',
  });
  return { ...v, findingPath: `${v.path}/findings/${f.id}` };
}

async function programme() {
  const p = await h.ok('clientAdmin', 'POST', '/audit-programmes', {
    managementSystemId: await system(),
    fy: '2026-27',
  });
  return { id: p.id as string, path: `/audit-programmes/${p.id}` };
}

const CLAUSE = () => h.f.clauses['9001:4.1']!;

/** An internal audit of clause 4.1 led by the unit A owner, PLANNED (version 1), IN_PROGRESS (2) or REPORTED (3). */
async function internalAudit(state: 'PLANNED' | 'IN_PROGRESS' | 'REPORTED' = 'PLANNED') {
  const a = await h.ok('clientAdmin', 'POST', '/internal-audits', {
    programmeId: (await programme()).id,
    title: 'Gate audit',
    plannedStart: '2026-10-12',
    plannedEnd: '2026-10-13',
    clauseIds: [CLAUSE()],
    leadAuditorId: h.f.people.owner,
    reportedToIds: [h.f.people.clientAdmin],
  });
  const path = `/internal-audits/${a.id}`;
  if (state !== 'PLANNED') await h.ok('owner', 'POST', `${path}/start`, { version: 1 });
  if (state === 'REPORTED') {
    const item = await h.ok('owner', 'POST', `${path}/checklist`, {
      clauseId: CLAUSE(),
      question: 'Is the context recorded?',
    });
    await h.ok('owner', 'PATCH', `${path}/checklist/${item.id}`, {
      version: 1,
      result: 'CONFORMS',
    });
    await h.ok('owner', 'POST', `${path}/report`, { version: 2, summary: 'Conforms' });
  }
  return { id: a.id as string, path };
}

async function rowFile() {
  const r = await row();
  await h.ok('clientAdmin', 'PATCH', r.path, {
    version: 1,
    ownerId: h.f.people.owner,
    reason: 'Improvement lead',
  });
  const file = await attach(h, 'owner', { type: 'clause_assessment', id: r.rowId });
  return { ...r, fileId: file.id as string };
}

async function riskItem(fields: Record<string, unknown> = {}) {
  const item = await h.ok('clientAdmin', 'POST', '/risks', {
    managementSystemId: await system(),
    kind: 'RISK',
    activity: 'Packaging supply',
    description: 'One supplier makes every carton',
    likelihood: 3,
    severity: 4,
    ownerId: h.f.people.owner,
    ...fields,
  });
  return { id: item.id as string, path: `/risks/${item.id}` };
}

async function control() {
  const item = await riskItem();
  const c = await h.ok('owner', 'POST', `${item.path}/controls`, { text: 'Two weeks of stock' });
  return `${item.path}/controls/${c.id}`;
}

async function objective() {
  const o = await h.ok('clientAdmin', 'POST', '/objectives', {
    managementSystemId: await system(),
    standards: ['ISO_9001'],
    text: 'On-time delivery',
    target: 98,
    unitOfMeasure: '%',
    direction: 'INCREASE',
    readingRule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    ownerId: h.f.people.owner,
    dueOn: '2027-03-31',
  });
  // The row's createdAt is the database's clock; the closing date is checked against the test's day.
  await h.testDb.query('UPDATE objective SET created_at = $2 WHERE id = $1', [
    o.id,
    NOW.toISOString(),
  ]);
  return `/objectives/${o.id}`;
}

async function reading() {
  const path = await objective();
  const r = await h.ok('owner', 'POST', `${path}/readings`, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    value: 95,
  });
  return `${path}/readings/${r.id}`;
}

/** A treatment action on a risk item with a residual rating, owned by the unit A owner. */
async function treatment() {
  const item = await riskItem({ residualLikelihood: 2, residualSeverity: 2 });
  const a = await h.ok('clientAdmin', 'POST', '/actions', {
    subject: { type: 'RISK_ITEM', id: item.id },
    text: 'Qualify a second supplier',
    ownerId: h.f.people.owner,
    dueOn: '2026-11-30',
  });
  return `/actions/${a.id}`;
}

/** A nonconformity on unit A, owned by the unit A owner (version 1). */
async function nc(fields: Record<string, unknown> = {}) {
  const raised = await h.ok('clientAdmin', 'POST', '/nonconformities', {
    managementSystemId: await system(),
    source: 'PROCESS',
    severity: 'MINOR',
    standards: ['ISO_9001'],
    unitId: h.f.unitA,
    description: 'Gate nonconformity',
    ownerId: h.f.people.owner,
    approverId: h.f.people.approver,
    dueOn: '2026-11-30',
    ...fields,
  });
  return `/nonconformities/${raised.id}`;
}

const ROOT_CAUSE = {
  containment: 'Quarantined',
  correction: 'Recalibrated',
  rootCauseMethod: 'FIVE_WHYS',
  rootCause: 'No schedule',
  similarOccurrences: 'None',
};

/** Through ADD_ROOT_CAUSE (version 2). */
async function ncFound() {
  const path = await nc();
  await h.ok('owner', 'POST', `${path}/root-cause`, { version: 1, ...ROOT_CAUSE });
  return path;
}

/** Through PLAN_ACTIONS with its one action done (version 3). */
async function ncPlanned() {
  const path = await ncFound();
  const id = path.split('/').at(-1)!;
  const action = await h.ok('clientAdmin', 'POST', '/actions', {
    subject: { type: 'NONCONFORMITY', id },
    text: 'Calibrate',
    ownerId: h.f.people.owner,
    dueOn: '2026-11-15',
  });
  await h.ok('owner', 'POST', `${path}/plan-actions`, {
    version: 2,
    effectivenessDueOn: '2026-10-20',
  });
  await h.ok('owner', 'POST', `/actions/${action.id}/complete`, {
    version: 1,
    doneOn: '2026-10-20',
  });
  return path;
}

/** Awaiting verification (version 4). */
async function ncSubmitted() {
  const path = await ncPlanned();
  await h.ok('owner', 'POST', `${path}/submit`, {
    version: 3,
    riskReview: 'None',
    systemChange: 'None',
  });
  return path;
}

const fileTicket = (rowId: string) => ({
  subject: { type: 'clause_assessment', id: rowId },
  fileName: 'record.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
});

const GATE: Record<string, () => Promise<GateCase>> = {
  'GET /catalogue/standards': async () => ({
    change: get('viewer', '/catalogue/standards'),
    audit: [],
  }),
  'GET /catalogue/clauses': async () => ({
    change: get('viewer', '/catalogue/clauses'),
    audit: [],
  }),
  'GET /catalogue/review-defs': async () => ({
    change: get('viewer', '/catalogue/review-defs'),
    audit: [],
  }),
  'GET /systems': async () => ({ change: get('owner', '/systems'), audit: [] }),
  'POST /systems': async () => {
    const body = { name: 'New system', standardIds: [h.f.std9001], unitIds: [h.f.unitA] };
    return {
      change: post('clientAdmin', '/systems', body),
      // The system and its three assessable 9001 clauses.
      audit: ['CREATE', 'CREATE', 'CREATE', 'CREATE'],
      refused: no(post('owner', '/systems', body), 403),
    };
  },
  'GET /systems/:id': async () => {
    const id = await system();
    return {
      change: get('owner', `/systems/${id}`),
      audit: [],
      refused: no(get('otherOwner', `/systems/${id}`), 404),
    };
  },
  'PATCH /systems/:id': async () => {
    const id = await system();
    return {
      change: patch('clientAdmin', `/systems/${id}`, { version: 1, name: 'Renamed' }),
      audit: ['UPDATE'],
      refused: no(patch('approver', `/systems/${id}`, { version: 1, name: 'No' }), 403),
    };
  },
  'PUT /systems/:id/climate': async () => {
    const id = await system();
    const body = {
      version: 1,
      climateChangeRelevant: true,
      climateChangeRationale: 'Flood risk at the river site.',
      climateDecidedOn: '2026-10-20',
    };
    return {
      change: { who: 'clientAdmin', method: 'PUT', path: `/systems/${id}/climate`, payload: body },
      audit: ['UPDATE'],
      refused: no(
        { who: 'approver', method: 'PUT', path: `/systems/${id}/climate`, payload: body },
        403,
      ),
    };
  },
  'GET /systems/:id/context': async () => {
    const id = await system();
    return {
      change: get('viewer', `/systems/${id}/context`),
      audit: [],
      refused: no(get('otherOwner', `/systems/${id}/context`), 404),
    };
  },
  'POST /systems/:id/context': async () => {
    const id = await system();
    const body = { kind: 'EXTERNAL_ISSUE', text: 'Monsoon flooding' };
    return {
      change: post('clientAdmin', `/systems/${id}/context`, body),
      audit: ['CREATE'],
      refused: no(post('viewer', `/systems/${id}/context`, body), 403),
    };
  },
  'PATCH /systems/:id/context/:itemId': async () => {
    const id = await system();
    const item = await h.ok('clientAdmin', 'POST', `/systems/${id}/context`, {
      kind: 'INTERNAL_ISSUE',
      text: 'Skills gap',
    });
    const path = `/systems/${id}/context/${item.id}`;
    return {
      change: patch('clientAdmin', path, { version: 1, text: 'Skills gap in welding' }),
      audit: ['UPDATE'],
      refused: no(patch('viewer', path, { version: 1, text: 'No' }), 403),
    };
  },
  'POST /systems/:id/context/:itemId/archive': async () => {
    const id = await system();
    const item = await h.ok('clientAdmin', 'POST', `/systems/${id}/context`, {
      kind: 'INTERNAL_ISSUE',
      text: 'Old issue',
    });
    const path = `/systems/${id}/context/${item.id}/archive`;
    return {
      change: post('clientAdmin', path, { version: 1, reason: 'Resolved' }),
      audit: ['ARCHIVE'],
      refused: no(post('viewer', path, { version: 1, reason: 'No' }), 403),
    };
  },
  'GET /systems/:id/checklist': async () => {
    const id = await system();
    return {
      change: get('owner', `/systems/${id}/checklist`),
      audit: [],
      refused: no(get('otherOwner', `/systems/${id}/checklist`), 404),
    };
  },
  'PATCH /systems/:id/checklist/:rowId': async () => {
    const r = await row();
    return {
      change: patch('clientAdmin', r.path, { version: 1, status: 'PARTIAL' }),
      audit: ['UPDATE'],
      refused: no(patch('viewer', r.path, { version: 1, status: 'PARTIAL' }), 403),
    };
  },
  'POST /systems/:id/checklist/:rowId/na-request': async () => {
    const r = await exclusionRow();
    const body = { version: 2, reason: 'No design work' };
    return {
      change: post('owner', `${r.path}/na-request`, body),
      audit: ['TRANSITION'],
      refused: no(post('approver', `${r.path}/na-request`, body), 403),
    };
  },
  'POST /systems/:id/checklist/:rowId/na-approve': async () => {
    const r = await naRequested();
    return {
      change: post('approver', `${r.path}/na-approve`, { version: 3 }),
      audit: ['TRANSITION'],
      // The requester never decides their own request.
      refused: no(post('owner', `${r.path}/na-approve`, { version: 3 }), 403),
    };
  },
  'POST /systems/:id/checklist/:rowId/na-reject': async () => {
    const r = await naRequested();
    const body = { version: 3, reason: 'We design the moulds' };
    return {
      change: post('approver', `${r.path}/na-reject`, body),
      audit: ['TRANSITION'],
      refused: no(post('viewer', `${r.path}/na-reject`, body), 403),
    };
  },
  'POST /systems/:id/checklist/:rowId/na-withdraw': async () => {
    const r = await naRequested();
    await h.ok('approver', 'POST', `${r.path}/na-approve`, { version: 3 });
    const body = { version: 4, reason: 'Design work starts' };
    return {
      change: post('owner', `${r.path}/na-withdraw`, body),
      audit: ['TRANSITION'],
      refused: no(post('viewer', `${r.path}/na-withdraw`, body), 403),
    };
  },
  'GET /documents': async () => ({ change: get('otherOwner', '/documents'), audit: [] }),
  'POST /documents': async () => {
    codes += 1;
    const body = {
      managementSystemId: await system(),
      code: `GATE-${codes}`,
      title: 'Purchasing',
      type: 'PROCEDURE',
      ownerId: h.f.people.owner,
      approverId: h.f.people.approver,
    };
    return {
      change: post('owner', '/documents', body),
      audit: ['CREATE'],
      refused: no(post('viewer', '/documents', body), 403),
    };
  },
  'GET /documents/:id': async () => {
    const d = await document();
    return {
      change: get('owner', d.path),
      audit: [],
      refused: no(get('otherOwner', d.path), 404),
    };
  },
  'PATCH /documents/:id': async () => {
    const d = await document();
    return {
      change: patch('owner', d.path, { version: 1, title: 'Renamed' }),
      audit: ['UPDATE'],
      refused: no(patch('approver', d.path, { version: 1, title: 'No' }), 403),
    };
  },
  'POST /documents/:id/review': async () => {
    const d = await inForce();
    const body = { version: d.version, note: 'Still fits', nextReviewDueOn: '2027-10-20' };
    return {
      change: post('approver', `${d.path}/review`, body),
      audit: ['TRANSITION'],
      refused: no(post('owner', `${d.path}/review`, body), 403),
    };
  },
  'POST /documents/:id/obsolete': async () => {
    const d = await document();
    const body = { version: 1, reason: 'Replaced' };
    return {
      change: post('approver', `${d.path}/obsolete`, body),
      audit: ['TRANSITION'],
      refused: no(post('owner', `${d.path}/obsolete`, body), 403),
    };
  },
  'GET /documents/:id/revisions': async () => {
    const d = await draft();
    return {
      change: get('owner', `${d.path}/revisions`),
      audit: [],
      refused: no(get('otherOwner', `${d.path}/revisions`), 404),
    };
  },
  'POST /documents/:id/revisions': async () => {
    const d = await document();
    return {
      change: post('owner', `${d.path}/revisions`, { revision: 'A' }),
      audit: ['CREATE'],
      refused: no(post('approver', `${d.path}/revisions`, { revision: 'A' }), 403),
    };
  },
  'PATCH /documents/:id/revisions/:revisionId': async () => {
    const d = await draft();
    return {
      change: patch('owner', d.revPath, { version: 1, changeNote: 'Second thoughts' }),
      audit: ['UPDATE'],
      refused: no(patch('viewer', d.revPath, { version: 1, changeNote: 'No' }), 403),
    };
  },
  'POST /documents/:id/revisions/:revisionId/submit': async () => {
    const d = await withCleanFile();
    return {
      change: post('owner', `${d.revPath}/submit`, { version: 1 }),
      audit: ['TRANSITION'],
      refused: no(post('approver', `${d.revPath}/submit`, { version: 1 }), 403),
    };
  },
  'POST /documents/:id/revisions/:revisionId/approve': async () => {
    const d = await inReview();
    return {
      change: post('approver', `${d.revPath}/approve`, { version: 2 }),
      // The revision in force, then the document's pointer to it.
      audit: ['TRANSITION', 'UPDATE'],
      refused: no(post('owner', `${d.revPath}/approve`, { version: 2 }), 403),
    };
  },
  'POST /documents/:id/revisions/:revisionId/send-back': async () => {
    const d = await inReview();
    const body = { version: 2, reason: 'Add the supplier list' };
    return {
      change: post('approver', `${d.revPath}/send-back`, body),
      audit: ['TRANSITION'],
      refused: no(post('owner', `${d.revPath}/send-back`, body), 403),
    };
  },
  'POST /documents/:id/revisions/:revisionId/record-edition': async () => {
    const d = await withCleanFile('EXTERNAL');
    return {
      change: post('owner', `${d.revPath}/record-edition`, { version: 1 }),
      audit: ['TRANSITION', 'UPDATE'],
      refused: no(post('approver', `${d.revPath}/record-edition`, { version: 1 }), 403),
    };
  },
  'GET /certifications': async () => ({ change: get('owner', '/certifications'), audit: [] }),
  'POST /certifications': async () => {
    const body = {
      managementSystemId: await system(),
      standardId: h.f.std9001,
      body: 'Northwind Certification',
    };
    return {
      change: post('consultant', '/certifications', body),
      audit: ['CREATE'],
      refused: no(post('approver', '/certifications', body), 403),
    };
  },
  'PATCH /certifications/:id': async () => {
    const path = await certificate();
    return {
      change: patch('clientAdmin', path, { version: 1, body: 'Osprey Assurance' }),
      audit: ['UPDATE'],
      refused: no(patch('owner', path, { version: 1, body: 'No' }), 403),
    };
  },
  'GET /external-audits': async () => ({ change: get('owner', '/external-audits'), audit: [] }),
  'POST /external-audits': async () => {
    const body = {
      managementSystemId: await system(),
      standardIds: [h.f.std9001],
      type: 'STAGE_1',
      body: 'Northwind Certification',
      startOn: '2026-11-02',
      endOn: '2026-11-03',
    };
    return {
      change: post('clientAdmin', '/external-audits', body),
      audit: ['CREATE'],
      refused: no(post('owner', '/external-audits', body), 403),
    };
  },
  'GET /external-audits/:id': async () => {
    const v = await visit();
    return {
      change: get('owner', v.path),
      audit: [],
      refused: no(get('otherOwner', v.path), 404),
    };
  },
  'PATCH /external-audits/:id': async () => {
    const v = await visit();
    return {
      change: patch('clientAdmin', v.path, { version: 1, leadAuditorName: 'R. Northwind' }),
      audit: ['UPDATE'],
      refused: no(patch('approver', v.path, { version: 1, leadAuditorName: 'No' }), 403),
    };
  },
  'POST /external-audits/:id/held': async () => {
    const v = await visit();
    await attach(h, 'clientAdmin', { type: 'external_audit', id: v.id }, 'report.pdf');
    const body = { version: 1, startOn: '2026-10-12', endOn: '2026-10-13' };
    return {
      change: post('clientAdmin', `${v.path}/held`, body),
      audit: ['TRANSITION'],
      refused: no(post('owner', `${v.path}/held`, body), 403),
    };
  },
  'POST /external-audits/:id/cancel': async () => {
    const v = await visit();
    const body = { version: 1, reason: 'Moved to next year' };
    return {
      change: post('clientAdmin', `${v.path}/cancel`, body),
      audit: ['TRANSITION'],
      refused: no(post('owner', `${v.path}/cancel`, body), 403),
    };
  },
  'POST /external-audits/:id/response': async () => {
    const v = await held();
    return {
      change: post('clientAdmin', `${v.path}/response`, { version: 2 }),
      audit: ['TRANSITION'],
      refused: no(post('owner', `${v.path}/response`, { version: 2 }), 403),
    };
  },
  'POST /external-audits/:id/close': async () => {
    const v = await held();
    const body = { version: 2, recommendation: 'RECOMMENDED' };
    return {
      change: post('clientAdmin', `${v.path}/close`, body),
      audit: ['TRANSITION'],
      refused: no(post('owner', `${v.path}/close`, body), 403),
    };
  },
  'GET /external-audits/:id/findings': async () => {
    const v = await externalFinding();
    return {
      change: get('owner', `${v.path}/findings`),
      audit: [],
      refused: no(get('otherOwner', `${v.path}/findings`), 404),
    };
  },
  'POST /external-audits/:id/findings': async () => {
    const v = await held();
    const body = {
      type: 'MINOR_NC',
      clauseIds: [CLAUSE()],
      description: 'Labels faded',
      nonconformity: {
        ownerId: h.f.people.owner,
        approverId: h.f.people.approver,
        dueOn: '2026-11-30',
      },
    };
    return {
      // The nonconformity's RAISE, then the finding.
      change: post('clientAdmin', `${v.path}/findings`, body),
      audit: ['CREATE', 'CREATE'],
      refused: no(post('owner', `${v.path}/findings`, body), 403),
    };
  },
  'PATCH /external-audits/:id/findings/:findingId': async () => {
    const v = await externalFinding();
    return {
      change: patch('clientAdmin', v.findingPath, { version: 1, type: 'OBSERVATION' }),
      audit: ['UPDATE'],
      refused: no(patch('owner', v.findingPath, { version: 1, type: 'OBSERVATION' }), 403),
    };
  },
  'GET /audit-programmes': async () => {
    await programme();
    return { change: get('owner', '/audit-programmes'), audit: [] };
  },
  'POST /audit-programmes': async () => {
    const body = { managementSystemId: await system(), fy: '2026-27' };
    return {
      change: post('clientAdmin', '/audit-programmes', body),
      audit: ['CREATE'],
      refused: no(post('owner', '/audit-programmes', body), 403),
    };
  },
  'PATCH /audit-programmes/:id': async () => {
    const p = await programme();
    return {
      change: patch('clientAdmin', p.path, { version: 1, notes: 'Two audits a year' }),
      audit: ['UPDATE'],
      refused: no(patch('owner', p.path, { version: 1, notes: 'No' }), 403),
    };
  },
  'GET /internal-audits': async () => {
    await internalAudit();
    return { change: get('owner', '/internal-audits'), audit: [] };
  },
  'POST /internal-audits': async () => {
    const body = {
      programmeId: (await programme()).id,
      title: 'Gate audit',
      plannedStart: '2026-11-10',
      plannedEnd: '2026-11-11',
      leadAuditorId: h.f.people.owner,
    };
    return {
      change: post('clientAdmin', '/internal-audits', body),
      audit: ['CREATE'],
      refused: no(post('owner', '/internal-audits', body), 403),
    };
  },
  'GET /internal-audits/:id': async () => {
    const a = await internalAudit();
    return {
      change: get('owner', a.path),
      audit: [],
      refused: no(get('otherOwner', a.path), 404),
    };
  },
  'PATCH /internal-audits/:id': async () => {
    const a = await internalAudit();
    return {
      change: patch('clientAdmin', a.path, { version: 1, title: 'Gate audit, stores' }),
      audit: ['UPDATE'],
      // The lead auditor conducts the audit but does not plan it.
      refused: no(patch('owner', a.path, { version: 1, title: 'No' }), 403),
    };
  },
  'POST /internal-audits/:id/start': async () => {
    const a = await internalAudit();
    return {
      change: post('owner', `${a.path}/start`, { version: 1 }),
      audit: ['TRANSITION'],
      refused: no(post('approver', `${a.path}/start`, { version: 1 }), 403),
    };
  },
  'POST /internal-audits/:id/report': async () => {
    const a = await internalAudit('IN_PROGRESS');
    const item = await h.ok('owner', 'POST', `${a.path}/checklist`, {
      clauseId: CLAUSE(),
      question: 'Is the context recorded?',
    });
    await h.ok('owner', 'PATCH', `${a.path}/checklist/${item.id}`, {
      version: 1,
      result: 'CONFORMS',
    });
    const body = { version: 2, summary: 'Conforms' };
    return {
      change: post('owner', `${a.path}/report`, body),
      audit: ['TRANSITION'],
      refused: no(post('approver', `${a.path}/report`, body), 403),
    };
  },
  'POST /internal-audits/:id/close': async () => {
    const a = await internalAudit('REPORTED');
    return {
      change: post('owner', `${a.path}/close`, { version: 3 }),
      audit: ['TRANSITION'],
      refused: no(post('approver', `${a.path}/close`, { version: 3 }), 403),
    };
  },
  'POST /internal-audits/:id/cancel': async () => {
    const a = await internalAudit();
    const body = { version: 1, reason: 'Moved to next quarter' };
    return {
      change: post('clientAdmin', `${a.path}/cancel`, body),
      audit: ['TRANSITION'],
      refused: no(post('owner', `${a.path}/cancel`, body), 403),
    };
  },
  'GET /internal-audits/:id/checklist': async () => {
    const a = await internalAudit();
    return {
      change: get('owner', `${a.path}/checklist`),
      audit: [],
      refused: no(get('otherOwner', `${a.path}/checklist`), 404),
    };
  },
  'POST /internal-audits/:id/checklist': async () => {
    const a = await internalAudit();
    const body = { clauseId: CLAUSE(), question: 'Is the context recorded?' };
    return {
      change: post('owner', `${a.path}/checklist`, body),
      audit: ['CREATE'],
      refused: no(post('approver', `${a.path}/checklist`, body), 403),
    };
  },
  'PATCH /internal-audits/:id/checklist/:itemId': async () => {
    const a = await internalAudit();
    const item = await h.ok('owner', 'POST', `${a.path}/checklist`, {
      clauseId: CLAUSE(),
      question: 'Is the context recorded?',
    });
    const path = `${a.path}/checklist/${item.id}`;
    return {
      change: patch('owner', path, { version: 1, result: 'CONFORMS' }),
      audit: ['UPDATE'],
      refused: no(patch('approver', path, { version: 1, result: 'CONFORMS' }), 403),
    };
  },
  'GET /internal-audits/:id/findings': async () => {
    const a = await internalAudit();
    return {
      change: get('owner', `${a.path}/findings`),
      audit: [],
      refused: no(get('otherOwner', `${a.path}/findings`), 404),
    };
  },
  'POST /internal-audits/:id/findings': async () => {
    const a = await internalAudit('IN_PROGRESS');
    const body = {
      type: 'MINOR_NC',
      clauseIds: [CLAUSE()],
      description: 'Labels faded',
      nonconformity: {
        ownerId: h.f.people.clientAdmin,
        approverId: h.f.people.approver,
        dueOn: '2026-11-30',
      },
    };
    return {
      // The nonconformity's RAISE, then the finding.
      change: post('owner', `${a.path}/findings`, body),
      audit: ['CREATE', 'CREATE'],
      refused: no(post('approver', `${a.path}/findings`, body), 403),
    };
  },
  'PATCH /internal-audits/:id/findings/:findingId': async () => {
    const a = await internalAudit('IN_PROGRESS');
    const f = await h.ok('owner', 'POST', `${a.path}/findings`, {
      type: 'OFI',
      description: 'Labels could be clearer',
    });
    const path = `${a.path}/findings/${f.id}`;
    return {
      change: patch('owner', path, { version: 1, type: 'OBSERVATION' }),
      audit: ['UPDATE'],
      refused: no(patch('approver', path, { version: 1, type: 'OBSERVATION' }), 403),
    };
  },
  'GET /risks': async () => ({ change: get('owner', '/risks'), audit: [] }),
  'POST /risks': async () => {
    const body = {
      managementSystemId: await system(),
      kind: 'OPPORTUNITY',
      activity: 'Scrap recovery',
      description: 'Remelt our own offcuts',
      likelihood: 3,
      severity: 2,
      ownerId: h.f.people.owner,
    };
    return {
      change: post('clientAdmin', '/risks', body),
      audit: ['CREATE'],
      refused: no(post('viewer', '/risks', body), 403),
    };
  },
  'GET /risks/:id': async () => {
    const item = await riskItem();
    return {
      change: get('owner', item.path),
      audit: [],
      refused: no(get('otherOwner', item.path), 404),
    };
  },
  'PATCH /risks/:id': async () => {
    const item = await riskItem();
    return {
      change: patch('owner', item.path, { version: 1, likelihood: 4 }),
      audit: ['UPDATE'],
      refused: no(patch('approver', item.path, { version: 1, likelihood: 4 }), 403),
    };
  },
  'POST /risks/:id/archive': async () => {
    const item = await riskItem();
    const body = { version: 1, reason: 'Duplicate' };
    return {
      change: post('clientAdmin', `${item.path}/archive`, body),
      audit: ['ARCHIVE'],
      refused: no(post('viewer', `${item.path}/archive`, body), 403),
    };
  },
  'POST /risks/:id/review': async () => {
    const item = await riskItem();
    const body = { version: 1, nextReviewDueOn: '2027-10-20' };
    return {
      change: post('owner', `${item.path}/review`, body),
      audit: ['TRANSITION'],
      refused: no(post('approver', `${item.path}/review`, body), 403),
    };
  },
  'PUT /risks/:id/significance': async () => {
    const item = await riskItem();
    const body = { version: 1, significantOverride: false, reason: 'Second supplier found' };
    const path = `${item.path}/significance`;
    return {
      change: { who: 'clientAdmin', method: 'PUT', path, payload: body },
      audit: ['UPDATE'],
      refused: no({ who: 'owner', method: 'PUT', path, payload: body }, 403),
    };
  },
  'GET /risks/:id/controls': async () => {
    const item = await riskItem();
    return {
      change: get('viewer', `${item.path}/controls`),
      audit: [],
      refused: no(get('otherOwner', `${item.path}/controls`), 404),
    };
  },
  'POST /risks/:id/controls': async () => {
    const item = await riskItem();
    const body = { text: 'Two weeks of stock' };
    return {
      change: post('owner', `${item.path}/controls`, body),
      audit: ['CREATE'],
      refused: no(post('approver', `${item.path}/controls`, body), 403),
    };
  },
  'PATCH /risks/:id/controls/:controlId': async () => {
    const path = await control();
    return {
      change: patch('owner', path, { version: 1, text: 'Three weeks of stock' }),
      audit: ['UPDATE'],
      refused: no(patch('viewer', path, { version: 1, text: 'No' }), 403),
    };
  },
  'POST /risks/:id/controls/:controlId/archive': async () => {
    const path = await control();
    const body = { version: 1, reason: 'Replaced' };
    return {
      change: post('owner', `${path}/archive`, body),
      audit: ['ARCHIVE'],
      refused: no(post('approver', `${path}/archive`, body), 403),
    };
  },
  'GET /objectives': async () => ({ change: get('owner', '/objectives'), audit: [] }),
  'POST /objectives': async () => {
    const body = {
      managementSystemId: await system(),
      standards: ['ISO_9001'],
      text: 'On-time delivery',
      target: 98,
      unitOfMeasure: '%',
      direction: 'INCREASE',
      readingRule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
      ownerId: h.f.people.owner,
      dueOn: '2027-03-31',
    };
    return {
      change: post('owner', '/objectives', body),
      audit: ['CREATE'],
      refused: no(post('approver', '/objectives', body), 403),
    };
  },
  'GET /objectives/:id': async () => {
    const path = await objective();
    return { change: get('viewer', path), audit: [], refused: no(get('otherOwner', path), 404) };
  },
  'PATCH /objectives/:id': async () => {
    const path = await objective();
    return {
      change: patch('owner', path, { version: 1, target: 99 }),
      audit: ['UPDATE'],
      refused: no(patch('viewer', path, { version: 1, target: 99 }), 403),
    };
  },
  'POST /objectives/:id/close': async () => {
    const path = await objective();
    const body = { version: 1, closedOn: '2026-10-20', outcome: 'ACHIEVED' };
    return {
      change: post('owner', `${path}/close`, body),
      audit: ['TRANSITION'],
      refused: no(post('approver', `${path}/close`, body), 403),
    };
  },
  'GET /objectives/:id/readings': async () => {
    const path = await objective();
    return {
      change: get('viewer', `${path}/readings`),
      audit: [],
      refused: no(get('otherOwner', `${path}/readings`), 404),
    };
  },
  'POST /objectives/:id/readings': async () => {
    const path = await objective();
    const body = { periodStart: '2026-09-01', periodEnd: '2026-09-30', value: 95 };
    return {
      change: post('owner', `${path}/readings`, body),
      audit: ['CREATE'],
      refused: no(post('viewer', `${path}/readings`, body), 403),
    };
  },
  'PATCH /objectives/:id/readings/:readingId': async () => {
    const path = await reading();
    return {
      change: patch('owner', path, { version: 1, value: 96 }),
      audit: ['UPDATE'],
      refused: no(patch('approver', path, { version: 1, value: 96 }), 403),
    };
  },
  'GET /actions': async () => ({ change: get('owner', '/actions'), audit: [] }),
  'POST /actions': async () => {
    const item = await riskItem();
    const body = {
      subject: { type: 'RISK_ITEM', id: item.id },
      text: 'Qualify a second supplier',
      ownerId: h.f.people.owner,
      dueOn: '2026-11-30',
    };
    return {
      change: post('owner', '/actions', body),
      audit: ['CREATE'],
      refused: no(post('approver', '/actions', body), 403),
    };
  },
  'GET /actions/:id': async () => {
    const path = await treatment();
    return { change: get('owner', path), audit: [], refused: no(get('otherOwner', path), 404) };
  },
  'PATCH /actions/:id': async () => {
    const path = await treatment();
    return {
      change: patch('owner', path, { version: 1, text: 'Qualify two suppliers' }),
      audit: ['UPDATE'],
      refused: no(patch('viewer', path, { version: 1, text: 'No' }), 403),
    };
  },
  'POST /actions/:id/complete': async () => {
    const path = await treatment();
    const body = { version: 1, doneOn: '2026-10-20' };
    return {
      change: post('owner', `${path}/complete`, body),
      // The step, then the control it puts in place, the review date, and the residual rating cleared (model §3.5).
      audit: ['TRANSITION', 'CREATE', 'DUE_DATE_CHANGE', 'UPDATE'],
      refused: no(post('approver', `${path}/complete`, body), 403),
    };
  },
  'POST /actions/:id/cancel': async () => {
    const path = await treatment();
    const body = { version: 1, reason: 'Duplicate' };
    return {
      change: post('clientAdmin', `${path}/cancel`, body),
      audit: ['TRANSITION'],
      refused: no(post('owner', `${path}/cancel`, body), 403),
    };
  },
  'POST /actions/:id/reopen': async () => {
    const path = await treatment();
    await h.ok('owner', 'POST', `${path}/complete`, { version: 1, doneOn: '2026-10-20' });
    const body = { version: 2, reason: 'Supplier failed its audit' };
    return {
      change: post('clientAdmin', `${path}/reopen`, body),
      audit: ['TRANSITION'],
      refused: no(post('consultant', `${path}/reopen`, body), 403),
    };
  },
  'GET /nonconformities': async () => {
    await nc();
    return { change: get('viewer', '/nonconformities'), audit: [] };
  },
  'POST /nonconformities': async () => {
    const body = {
      managementSystemId: await system(),
      source: 'PROCESS',
      severity: 'MINOR',
      standards: ['ISO_9001'],
      unitId: h.f.unitA,
      description: 'Gate nonconformity',
      ownerId: h.f.people.owner,
      approverId: h.f.people.approver,
      dueOn: '2026-11-30',
    };
    return {
      change: post('owner', '/nonconformities', body),
      audit: ['CREATE'],
      refused: no(post('viewer', '/nonconformities', body), 403),
    };
  },
  'GET /nonconformities/:id': async () => {
    const path = await nc();
    return { change: get('owner', path), audit: [], refused: no(get('otherOwner', path), 404) };
  },
  'PATCH /nonconformities/:id': async () => {
    const path = await nc();
    return {
      change: patch('owner', path, { version: 1, rootCause: 'No schedule' }),
      audit: ['UPDATE'],
      refused: no(patch('consultant', path, { version: 1, rootCause: 'No' }), 403),
    };
  },
  'POST /nonconformities/:id/reassign': async () => {
    const path = await nc();
    const body = {
      version: 1,
      ownerId: h.f.people.clientAdmin,
      dueOn: '2026-12-31',
      reason: 'Leave',
    };
    return {
      change: post('consultant', `${path}/reassign`, body),
      audit: ['REASSIGN', 'DUE_DATE_CHANGE'],
      refused: no(post('owner', `${path}/reassign`, body), 403),
    };
  },
  'POST /nonconformities/:id/root-cause': async () => {
    const path = await nc();
    const body = { version: 1, ...ROOT_CAUSE };
    return {
      change: post('owner', `${path}/root-cause`, body),
      audit: ['TRANSITION'],
      refused: no(post('approver', `${path}/root-cause`, body), 403),
    };
  },
  'POST /nonconformities/:id/plan-actions': async () => {
    const path = await ncFound();
    const id = path.split('/').at(-1)!;
    await h.ok('clientAdmin', 'POST', '/actions', {
      subject: { type: 'NONCONFORMITY', id },
      text: 'Calibrate',
      ownerId: h.f.people.owner,
      dueOn: '2026-11-15',
    });
    const body = { version: 2, effectivenessDueOn: '2026-12-01' };
    return {
      change: post('owner', `${path}/plan-actions`, body),
      audit: ['TRANSITION'],
      refused: no(post('firmAdmin', `${path}/plan-actions`, body), 403),
    };
  },
  'POST /nonconformities/:id/submit-no-action': async () => {
    const path = await ncFound();
    const body = {
      version: 2,
      noActionReason: 'One-off',
      riskReview: 'None',
      systemChange: 'None',
    };
    return {
      change: post('owner', `${path}/submit-no-action`, body),
      audit: ['TRANSITION'],
      refused: no(post('approver', `${path}/submit-no-action`, body), 403),
    };
  },
  'POST /nonconformities/:id/submit': async () => {
    const path = await ncPlanned();
    const body = { version: 3, riskReview: 'None', systemChange: 'None' };
    return {
      change: post('owner', `${path}/submit`, body),
      audit: ['TRANSITION'],
      refused: no(post('consultant', `${path}/submit`, body), 403),
    };
  },
  'POST /nonconformities/:id/verify-effective': async () => {
    const path = await ncSubmitted();
    const body = { version: 4, effectivenessNote: 'No repeat' };
    return {
      change: post('approver', `${path}/verify-effective`, body),
      audit: ['TRANSITION'],
      refused: no(post('owner', `${path}/verify-effective`, body), 403),
    };
  },
  'POST /nonconformities/:id/verify-not-effective': async () => {
    const path = await ncSubmitted();
    const body = { version: 4, reason: 'Drifted again', backTo: 'OPEN' };
    return {
      change: post('approver', `${path}/verify-not-effective`, body),
      audit: ['TRANSITION'],
      refused: no(post('firmAdmin', `${path}/verify-not-effective`, body), 403),
    };
  },
  'POST /nonconformities/:id/cancel': async () => {
    const path = await nc();
    const body = { version: 1, reason: 'Raised twice' };
    return {
      change: post('approver', `${path}/cancel`, body),
      audit: ['TRANSITION'],
      refused: no(post('owner', `${path}/cancel`, body), 403),
    };
  },
  'POST /nonconformities/:id/reopen': async () => {
    const path = await ncSubmitted();
    await h.ok('approver', 'POST', `${path}/verify-effective`, {
      version: 4,
      effectivenessNote: 'Held',
    });
    const body = { version: 5, reason: 'Repeat found', backTo: 'OPEN' };
    return {
      change: post('clientAdmin', `${path}/reopen`, body),
      audit: ['TRANSITION'],
      refused: no(post('approver', `${path}/reopen`, body), 403),
    };
  },
  'POST /files/upload-url': async () => {
    const r = await rowFile();
    return {
      change: post('owner', '/files/upload-url', fileTicket(r.rowId)),
      audit: [],
      port: 'uploadUrl',
      refused: no(post('viewer', '/files/upload-url', fileTicket(r.rowId)), 403),
    };
  },
  'POST /files': async () => {
    const r = await rowFile();
    const ticket = await h.ok('owner', 'POST', '/files/upload-url', fileTicket(r.rowId));
    const body = {
      subject: { type: 'clause_assessment', id: r.rowId },
      uploadId: ticket.uploadId,
      fileName: 'record.pdf',
      sha256: 'c'.repeat(64),
    };
    return {
      change: post('owner', '/files', body),
      audit: [],
      port: 'confirm',
      refused: no(post('otherOwner', '/files', body), 404),
    };
  },
  'GET /files': async () => {
    const r = await rowFile();
    const path = `/files?subjectType=clause_assessment&subjectId=${r.rowId}`;
    return {
      change: get('viewer', path),
      audit: [],
      port: 'list',
      refused: no(get('otherOwner', path), 404),
    };
  },
  'GET /files/:id/download-url': async () => {
    const r = await rowFile();
    await h.scan(r.fileId, 'CLEAN');
    return {
      change: get('owner', `/files/${r.fileId}/download-url`),
      audit: [],
      port: 'downloadUrl',
      refused: no(get('otherOwner', `/files/${r.fileId}/download-url`), 404),
    };
  },
  'POST /files/:id/remove': async () => {
    const r = await rowFile();
    const body = { reason: 'Wrong year' };
    return {
      change: post('owner', `/files/${r.fileId}/remove`, body),
      audit: [],
      port: 'remove',
      refused: no(post('viewer', `/files/${r.fileId}/remove`, body), 403),
    };
  },
};

/** What a request added to the firm's audit trail and outbox, as sorted kinds, and the port calls it made. */
async function writtenBy(request: Request) {
  const before = await h.testDb.written(h.f.firmId);
  h.files.calls.length = 0;
  const res = await h.send(request.who, request.method, request.path, request.payload);
  const after = await h.testDb.written(h.f.firmId);
  const added = (was: Map<string, string>, now: Map<string, string>) =>
    [...now]
      .filter(([id]) => !was.has(id))
      .map(([, kind]) => kind)
      .sort();
  return {
    status: res.status,
    body: res.body,
    audit: added(before.audit, after.audit),
    outbox: added(before.outbox, after.outbox),
    port: h.files.calls.map((c) => c.method),
  };
}

/** Runs `fn` with the add-on switched off for the fixture account, then on again. */
async function featureOff<T>(fn: () => Promise<T>): Promise<T> {
  const account = h.auth.store.accounts.get(h.f.firmId)!;
  h.auth.store.accounts.set(h.f.firmId, {
    ...account,
    entitlements: { ...account.entitlements, features: [] },
  });
  try {
    return await fn();
  } finally {
    h.auth.store.accounts.set(h.f.firmId, account);
  }
}

describe('every M16 route writes exactly its AuditEvents and outbox events', () => {
  it('has a row for every route M16 registers', async () => {
    const seen: string[] = [];
    const probe = Fastify();
    probe.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) {
        if (method !== 'HEAD') seen.push(`${method} ${route.url.replace(ROOT, '')}`);
      }
    });
    // Registration only: no handler runs, so the database is never touched.
    probe.register(
      async (api) => {
        registerIsoRoutes(api, { db: h.testDb.db, files: createFakeIsoFiles(h.f.clientId) });
      },
      { prefix: '/api/v1' },
    );
    await probe.ready();
    expect(seen.sort()).toEqual(Object.keys(GATE).sort());
    await probe.close();
  });

  it.each(Object.entries(GATE))('%s', async (_route, setup) => {
    const gate = await setup();
    const change = await writtenBy(gate.change);
    expect([change.status, change.body]).toEqual([expect.any(Number), change.body]);
    expect(change.status).toBeLessThan(300);
    expect(change.audit).toEqual([...gate.audit].sort());
    expect(change.outbox).toEqual([]);
    expect(change.port).toEqual(gate.port === undefined ? [] : [gate.port]);

    // With the add-on off, the same request is refused before anything runs.
    const off = await featureOff(() => writtenBy(gate.change));
    expect(off.status).toBe(403);
    expect((off.body.error as { code: string }).code).toBe('FEATURE_NOT_ENABLED');
    expect([off.audit, off.outbox, off.port]).toEqual([[], [], []]);

    if (gate.refused !== undefined) {
      const fresh = await setup();
      const refusal = fresh.refused!;
      const refused = await writtenBy(refusal);
      expect(refused.status).toBe(refusal.status);
      expect([refused.audit, refused.outbox, refused.port]).toEqual([[], [], []]);
    }
  });
});
