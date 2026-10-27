import { createHash } from 'node:crypto';

import { ENDPOINTS } from '@canopy/contracts';
import { createDatabase, systemContext, tenantSettings } from '@canopy/db';
import { expect, request, test } from '@playwright/test';
import pg from 'pg';

// By path, not through `@canopy/api`: Playwright does not compile TypeScript it reaches through node_modules.
import { ISO_SERVED_ENDPOINTS } from '../../apps/api/src/modules/iso/served.js';
import { copyIsoCatalogue } from '../../apps/api/src/modules/library/db-iso-catalogue-copy.js';
import { anonymousApi, apiAs, itemsOf, type ApiSession } from './api.js';
import { seeded } from './helpers.js';
import {
  API_URL,
  APP_LOGIN,
  APP_PASSWORD,
  E2E_DATABASE,
  FIRM_A,
  FIRM_B,
  PASSWORD,
  ACCOUNTS,
  EICAR,
  databaseUrl,
  storageStateOf,
} from './stack.js';

// Security review checks (docs/security/review.md) against the running API and database: tenant isolation for every
// endpoint, sessions and CSRF, evidence upload and download rules, and RLS for the app's own database login.
const FY = 'fy=2022-23';
const PDF = Buffer.from('%PDF-1.4\n% integrated journey evidence\n%%EOF\n');

type Endpoint = {
  auth: string;
  method: string;
  path: string;
  body?: { parse(v: unknown): unknown } | null;
  /** The add-on an endpoint belongs to; the ISO add-on's endpoints carry it from ISO-1 (ADR M16-0001). */
  feature?: string;
};
const endpoints = Object.entries(ENDPOINTS as Record<string, Endpoint>);

/** The ISO add-on endpoints M16 serves so far (ISO-8a, ISO-8b, ISO-8c parts 1 and 2); the rest of the add-on stays on UNMOUNTED until it ships. */
const ISO_SERVED: ReadonlySet<string> = new Set(ISO_SERVED_ENDPOINTS);

/**
 * Contract endpoints the API does not serve yet, with why. Every check below expects them to answer 404 (no route) and
 * fails once one answers anything else, so it must come off this list the day it ships and be checked like the rest.
 */
const UNMOUNTED: Record<string, string> = Object.fromEntries(
  endpoints
    .filter(([name, e]) => 'feature' in e && !ISO_SERVED.has(name))
    .map(([name, e]) => [
      name,
      `${String(e.feature)} add-on: M16 mounts its remaining routes in ISO-8c (docs/iso/plan.md ISO-8)`,
    ]),
);

/**
 * Endpoints the isolation sweep does not call with firm A's ids, with why. The sweep fails on any endpoint that is in
 * neither the sweep nor this list, so a new endpoint has to be placed in one or the other.
 */
const NOT_SWEPT: Record<string, string> = {
  login: 'public, names no record',
  requestMagicLink: 'public, names no record',
  verifyMagicLink: 'public, takes a secret token, not an id',
  getInvite: 'public, takes a secret token, not an id',
  acceptInvite: 'public, takes a secret token, not an id',
  enrollInviteMfa: 'public, takes a secret token, not an id',
  verifySupportSession: 'public, takes a secret token, not an id',
  logout: 'acts on the caller’s own session',
  enrollMfa: 'acts on the caller’s own session',
  verifyMfa: 'acts on the caller’s own session',
  createClient: 'creates in the caller’s own firm; names no record',
  createLocation: 'creates in the caller’s own firm; names no record',
  createAct: 'creates in the caller’s own firm; names no record',
  createCategory: 'creates in the caller’s own firm; names no record',
  createObligation: 'creates in the caller’s own firm; names no record',
  previewRule: 'computes due dates from the body; reads no record',
  createSupportGrant: 'creates in the caller’s own account; names no record',
  ...UNMOUNTED,
};

const PROBE = 'isolation probe';
const SHA = '0'.repeat(64);

const SETTINGS = {
  fyStartMonth: 4,
  timeZone: 'Asia/Kolkata',
  holidayPolicy: 'NONE',
  reminders: {
    ownerDaysBefore: [7],
    approverDaysAfter: [2],
    sendAtLocalTime: '09:00',
    consultantDigestWeekday: 1,
  },
};
/** An assignment of firm A's obligation to its unit, department, owner and approver. */
const ASSIGNMENT = (id: Record<string, string>) => ({
  unitId: id.units,
  obligationId: id.obligations,
  departmentId: id.departments,
  defaultOwnerId: id.people,
  defaultApproverId: id.otherPerson,
  activeFrom: '2023-04-01',
  activeTo: null,
});

/**
 * Valid bodies for every signed-in write that names a record in its path or body, built from firm A's own records and
 * versions, so a write that got past the tenant check would be applied, not refused for its body. Each one is checked
 * against the contract's schema first. A write with no body schema gets none.
 */
const BODIES: Record<string, (ids: Ids) => unknown> = {
  submitInstance: ({ v }) => ({ version: v.instances, completedOn: '2023-03-31', comment: PROBE }),
  requestNa: ({ v }) => ({ version: v.instances, reason: PROBE }),
  approveInstance: ({ v }) => ({ version: v.instances }),
  sendBackInstance: ({ v }) => ({ version: v.instances, reason: PROBE }),
  reopenInstance: ({ v }) => ({ version: v.instances, reason: PROBE }),
  updateInstance: ({ v }) => ({ version: v.instances, dueDate: '2023-03-31', reason: PROBE }),
  bulkApprove: ({ id, v }) => ({ items: [{ id: id.instances, version: v.instances }] }),
  createComment: () => ({ body: PROBE }),
  evidenceUploadUrl: () => ({ fileName: 'probe.pdf', mimeType: 'application/pdf', sizeBytes: 10 }),
  confirmEvidence: () => ({ uploadId: UNKNOWN, fileName: 'probe.pdf', sha256: SHA }),
  removeEvidence: () => ({ reason: PROBE }),
  createExport: () => ({ kind: 'REGISTER_XLSX', filters: '' }),
  createImport: () => ({ fileName: 'probe.xlsx', sizeBytes: 10 }),
  updateClient: ({ v }) => ({ version: v.clientId, name: 'Probe Group' }),
  archiveClient: ({ v }) => ({ version: v.clientId, reason: PROBE }),
  restoreClient: ({ v }) => ({ version: v.clientId }),
  archiveCompany: ({ v }) => ({ version: v.companies, reason: PROBE }),
  archiveUnit: ({ v }) => ({ version: v.units, reason: PROBE }),
  archiveAssignment: ({ v }) => ({ version: v.assignments, reason: PROBE }),
  archiveMembership: ({ v }) => ({ version: v.memberships, reason: PROBE }),
  archiveObligation: ({ v }) => ({ version: v.obligations, reason: PROBE }),
  updatePerson: ({ v }) => ({ version: v.people, displayName: 'Probe Person' }),
  // Writes that change no compliance state but name a record in the path (and often another in the body).
  putClientSettings: ({ v }) => ({ version: v.clientId, settings: SETTINGS }),
  createCompany: () => ({ name: 'Probe Company' }),
  updateCompany: ({ v }) => ({ version: v.companies, name: 'Probe Company' }),
  createUnit: ({ id }) => ({
    companyId: id.companies,
    name: 'Probe Unit',
    locationId: id.locations,
  }),
  updateUnit: ({ v }) => ({ version: v.units, name: 'Probe Unit' }),
  createDepartment: () => ({ name: 'Probe Department', aliases: [] }),
  updateDepartment: ({ v }) => ({ version: v.departments, name: 'Probe Department' }),
  mergeDepartments: ({ id, v }) => ({ version: v.departments, sourceIds: [id.otherDepartment] }),
  createClientPerson: () => ({ displayName: 'Probe Person', email: null, role: 'OWNER' }),
  mergePeople: ({ id, v }) => ({ version: v.people, sourceIds: [id.otherPerson] }),
  createMembership: ({ id }) => ({
    role: 'VIEWER',
    clientId: id.clientId,
    consultantClientIds: null,
    unitIds: null,
    expiresAt: '2099-12-31T00:00:00Z',
  }),
  updateMembership: ({ v }) => ({ version: v.memberships, expiresAt: '2099-12-31T00:00:00Z' }),
  updateAct: ({ v }) => ({ version: v.acts, aliases: [PROBE] }),
  mergeActs: ({ id, v }) => ({ version: v.acts, sourceIds: [id.otherAct] }),
  updateCategory: ({ v }) => ({ version: v.categories, aliases: [PROBE] }),
  mergeCategories: ({ id, v }) => ({ version: v.categories, sourceIds: [id.otherCategory] }),
  updateObligation: ({ v }) => ({ version: v.obligations, title: 'Probe obligation' }),
  pushObligation: ({ id }) => ({ clientIds: [id.clientId] }),
  createAssignment: ({ id }) => ASSIGNMENT(id),
  bulkCreateAssignments: ({ id }) => ({ items: [ASSIGNMENT(id)] }),
  updateAssignment: ({ id, v }) => ({ version: v.assignments, defaultOwnerId: id.people }),
  setAssignmentApplicability: ({ v }) => ({
    version: v.assignments,
    applicability: 'NOT_APPLICABLE',
    reason: PROBE,
  }),
  importUploaded: () => ({ sha256: SHA }),
  putImportMapping: () => ({
    sheetName: 'Register',
    mapping: [{ sourceHeader: 'Title', field: 'title' }],
  }),
  decideImportIssue: () => ({ decision: 'ACCEPTED' }),
  createMappingTemplate: () => ({
    name: 'Probe layout',
    mapping: [{ sourceHeader: 'Title', field: 'title' }],
    scope: 'CLIENT',
  }),
  updateMappingTemplate: ({ v }) => ({ version: v['mapping-templates'], name: 'Probe layout' }),
  parseImport: () => undefined,
  dryRunImport: () => undefined,
  commitImport: () => undefined,
  revokeInvite: () => undefined,
  cancelImport: () => undefined,
  // The ISO add-on (ISO-8a): firm A's system, checklist row, context item, document and revision, certificate,
  // and external audit, with firm A's standard, unit and people in the body where the write names them.
  createIsoSystem: ({ id }) => ({ name: 'Probe system', standardIds: [id.standards] }),
  updateIsoSystem: ({ v }) => ({ version: v.systems, name: 'Probe system' }),
  setIsoClimateDecision: ({ v }) => ({
    version: v.systems,
    climateChangeRelevant: false,
    climateChangeRationale: PROBE,
    climateDecidedOn: '2023-04-01',
  }),
  createIsoContextItem: () => ({ kind: 'INTERNAL_ISSUE', text: PROBE }),
  updateIsoContextItem: ({ v }) => ({ version: v.context, text: PROBE }),
  archiveIsoContextItem: ({ v }) => ({ version: v.context, reason: PROBE }),
  updateIsoChecklistRow: ({ v }) => ({ version: v.checklist, status: 'PARTIAL' }),
  requestIsoClauseNa: ({ v }) => ({ version: v.checklist, reason: PROBE }),
  approveIsoClauseNa: ({ v }) => ({ version: v.checklist }),
  rejectIsoClauseNa: ({ v }) => ({ version: v.checklist, reason: PROBE }),
  withdrawIsoClauseNa: ({ v }) => ({ version: v.checklist, reason: PROBE }),
  createIsoDocument: ({ id }) => ({
    managementSystemId: id.systems,
    code: 'PROBE-1',
    title: 'Probe procedure',
    type: 'PROCEDURE',
    ownerId: id.people,
    approverId: id.otherPerson,
  }),
  updateIsoDocument: ({ v }) => ({ version: v.documents, title: 'Probe procedure' }),
  reviewIsoDocument: ({ v }) => ({
    version: v.documents,
    note: PROBE,
    nextReviewDueOn: '2099-03-31',
  }),
  obsoleteIsoDocument: ({ v }) => ({ version: v.documents, reason: PROBE }),
  draftIsoRevision: () => ({ revision: 'P1' }),
  updateIsoRevision: ({ v }) => ({ version: v.revisions, revision: 'P1' }),
  submitIsoRevision: ({ v }) => ({ version: v.revisions }),
  approveIsoRevision: ({ v }) => ({ version: v.revisions }),
  sendBackIsoRevision: ({ v }) => ({ version: v.revisions, reason: PROBE }),
  recordIsoEdition: ({ v }) => ({ version: v.revisions }),
  createIsoCertification: ({ id }) => ({
    managementSystemId: id.systems,
    standardId: id.standards,
    body: 'Probe Certification Body',
  }),
  updateIsoCertification: ({ v }) => ({
    version: v.certifications,
    body: 'Probe Certification Body',
  }),
  createIsoExternalAudit: ({ id }) => ({
    managementSystemId: id.systems,
    standardIds: [id.standards],
    type: 'STAGE_1',
    body: 'Probe Certification Body',
    startOn: '2099-01-10',
    endOn: '2099-01-11',
  }),
  updateIsoExternalAudit: ({ v }) => ({
    version: v['external-audits'],
    body: 'Probe Certification Body',
  }),
  recordIsoExternalAuditHeld: ({ v }) => ({
    version: v['external-audits'],
    startOn: '2099-01-10',
    endOn: '2099-01-11',
  }),
  cancelIsoExternalAudit: ({ v }) => ({ version: v['external-audits'], reason: PROBE }),
  // ISO-8b: firm A's risk item and its control, objective and its reading, and an action on the risk item.
  createIsoRisk: ({ id }) => ({
    managementSystemId: id.systems,
    kind: 'RISK',
    activity: 'Probe activity',
    description: PROBE,
    likelihood: 2,
    severity: 2,
    ownerId: id.people,
  }),
  updateIsoRisk: ({ v }) => ({ version: v.risks, activity: 'Probe activity' }),
  archiveIsoRisk: ({ v }) => ({ version: v.risks, reason: PROBE }),
  reviewIsoRisk: ({ v }) => ({ version: v.risks, nextReviewDueOn: '2099-03-31' }),
  setIsoRiskSignificance: ({ v }) => ({
    version: v.risks,
    significantOverride: null,
    reason: PROBE,
  }),
  createIsoRiskControl: () => ({ text: PROBE }),
  updateIsoRiskControl: ({ v }) => ({ version: v.controls, text: PROBE }),
  archiveIsoRiskControl: ({ v }) => ({ version: v.controls, reason: PROBE }),
  createIsoObjective: ({ id }) => ({
    managementSystemId: id.systems,
    standards: ['ISO_9001'],
    text: PROBE,
    target: 1,
    unitOfMeasure: 'count',
    direction: 'MAINTAIN',
    readingRule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    ownerId: id.people,
    dueOn: '2099-03-31',
  }),
  updateIsoObjective: ({ v }) => ({ version: v.objectives, text: PROBE }),
  closeIsoObjective: ({ v }) => ({
    version: v.objectives,
    closedOn: '2023-04-01',
    outcome: 'ACHIEVED',
  }),
  createIsoReading: () => ({ periodStart: '2023-04-01', periodEnd: '2023-04-30', value: 1 }),
  updateIsoReading: ({ v }) => ({ version: v.readings, value: 1 }),
  createIsoAction: ({ id }) => ({
    subject: { type: 'RISK_ITEM', id: id.risks },
    text: PROBE,
    ownerId: id.people,
    dueOn: '2099-03-31',
  }),
  updateIsoAction: ({ v }) => ({ version: v.actions, text: PROBE }),
  completeIsoAction: ({ v }) => ({ version: v.actions, doneOn: '2023-04-01' }),
  cancelIsoAction: ({ v }) => ({ version: v.actions, reason: PROBE }),
  reopenIsoAction: ({ v }) => ({ version: v.actions, reason: PROBE }),
  raiseIsoNonconformity: ({ id }) => ({
    managementSystemId: id.systems,
    source: 'PROCESS',
    severity: 'MINOR',
    standards: ['ISO_9001'],
    description: PROBE,
    ownerId: id.people,
    approverId: id.otherPerson,
    dueOn: '2099-03-31',
  }),
  updateIsoNonconformity: ({ v }) => ({ version: v.nonconformities, rootCause: PROBE }),
  reassignIsoNonconformity: ({ v }) => ({
    version: v.nonconformities,
    dueOn: '2099-04-30',
    reason: PROBE,
  }),
  addIsoNcRootCause: ({ v }) => ({ version: v.nonconformities, rootCause: PROBE }),
  planIsoNcActions: ({ v }) => ({ version: v.nonconformities, effectivenessDueOn: '2099-03-31' }),
  submitIsoNcNoAction: ({ v }) => ({
    version: v.nonconformities,
    noActionReason: PROBE,
    riskReview: PROBE,
    systemChange: PROBE,
  }),
  submitIsoNc: ({ v }) => ({ version: v.nonconformities }),
  verifyIsoNcEffective: ({ v }) => ({ version: v.nonconformities, effectivenessNote: PROBE }),
  verifyIsoNcNotEffective: ({ v }) => ({
    version: v.nonconformities,
    reason: PROBE,
    backTo: 'OPEN',
  }),
  cancelIsoNc: ({ v }) => ({ version: v.nonconformities, reason: PROBE }),
  reopenIsoNc: ({ v }) => ({ version: v.nonconformities, reason: PROBE, backTo: 'OPEN' }),
  // ISO-8c part 2: firm A's audit programme, its internal audit with a checklist row and a finding.
  createIsoAuditProgramme: ({ id }) => ({ managementSystemId: id.systems, fy: '2097-98' }),
  updateIsoAuditProgramme: ({ v }) => ({ version: v['audit-programmes'], notes: PROBE }),
  createIsoInternalAudit: ({ id }) => ({
    programmeId: id['audit-programmes'],
    title: PROBE,
    plannedStart: '2099-02-01',
    plannedEnd: '2099-02-02',
    leadAuditorId: id.people,
  }),
  updateIsoInternalAudit: ({ v }) => ({ version: v['internal-audits'], title: PROBE }),
  startIsoInternalAudit: ({ v }) => ({ version: v['internal-audits'] }),
  reportIsoInternalAudit: ({ v }) => ({ version: v['internal-audits'], summary: PROBE }),
  closeIsoInternalAudit: ({ v }) => ({ version: v['internal-audits'] }),
  cancelIsoInternalAudit: ({ v }) => ({ version: v['internal-audits'], reason: PROBE }),
  createIsoAuditChecklistItem: ({ id }) => ({ clauseId: id.clauses, question: PROBE }),
  updateIsoAuditChecklistItem: ({ v }) => ({
    version: v['internal-audits/checklist'],
    auditorNote: PROBE,
  }),
  createIsoInternalFinding: () => ({ type: 'OFI', description: PROBE }),
  updateIsoInternalFinding: ({ v }) => ({
    version: v['internal-audits/findings'],
    description: PROBE,
  }),
  createIsoExternalFinding: () => ({ type: 'OFI', description: PROBE }),
  updateIsoExternalFinding: ({ v }) => ({ version: v.findings, description: PROBE }),
  recordIsoExternalAuditResponse: ({ v }) => ({ version: v['external-audits'] }),
  closeIsoExternalAudit: ({ v }) => ({
    version: v['external-audits'],
    recommendation: 'RECOMMENDED',
  }),
  // Names firm A's person and client in the body rather than the path.
  createInvite: ({ id }) => ({
    personId: id.people,
    email: 'probe@kestrel.test',
    role: 'VIEWER',
    clientId: id.clientId,
    consultantClientIds: null,
    unitIds: null,
    expiresAt: '2099-12-31T00:00:00Z',
  }),
};

/**
 * The sweep calls every signed-in endpoint that names a record in its path or (BODIES) its body, and reads every
 * firm-wide list.
 */
const sweepable = (name: string, e: Endpoint) =>
  e.auth !== 'public' && (e.path.includes('{') || e.method === 'GET' || name in BODIES);

/** Firm A's ids (and record versions) for every kind of record a path can name, read as firm A's own users. */
type Ids = { id: Record<string, string>; v: Record<string, number> };

async function firmAIds(): Promise<Ids> {
  const { clients, people } = seeded();
  const admin = await apiAs('consultant');
  const get = async (path: string) => {
    const res = await admin.get(path);
    expect(res.status, path).toBe(200);
    return res.body;
  };
  const instance = itemsOf(
    await get(`/clients/${clients.kestrel}/instances?${FY}&workflowState=OPEN&limit=1`),
  )[0]!;
  const detail = (await get(`/instances/${instance.id}`)) as { obligationId: string };
  type Rec = { id: string; version: number };
  /** Firm A's `n`th record at `path` (from 0). */
  const nth = async (path: string, n: number) => {
    const item = ((await get(path)) as { items: Rec[] }).items[n];
    if (!item) throw new Error(`firm A has no record ${n} at ${path}`);
    return item;
  };
  const first = (path: string) => nth(path, 0);
  const exportJob = await admin.post(`/clients/${clients.kestrel}/exports`, {
    kind: 'REGISTER_XLSX',
    filters: FY,
  });
  const invite = await admin.post('/invites', {
    displayName: 'Invited Viewer',
    // firmAIds runs once per test, and an email names one person in a firm.
    email: `invited-${crypto.randomUUID().slice(0, 8)}@kestrel.test`,
    role: 'VIEWER',
    clientId: clients.kestrel,
    consultantClientIds: null,
    unitIds: null,
    expiresAt: '2099-12-31T00:00:00Z',
  });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  const batch = (await first(`/clients/${clients.kestrel}/imports`)) as Rec & { mapping: unknown };
  const template = await admin.post(`/clients/${clients.kestrel}/mapping-templates`, {
    name: `Kestrel register layout ${crypto.randomUUID().slice(0, 8)}`,
    mapping: batch.mapping,
    scope: 'CLIENT',
  });
  expect(template.status, JSON.stringify(template.body)).toBe(201);
  const unit = (await first(`/clients/${clients.kestrel}/units`)) as Rec & { locationId: string };
  const iso = await isoRecordsOf(admin, clients.kestrel, {
    owner: people.owner,
    approver: people.approver,
  });
  // A support grant only the account admin can make, so firm B's revoke has a real grant of firm A's to aim at.
  const accountAdmin = await apiAs('firmAdmin');
  const grant = await accountAdmin.post('/account/support-grants', { level: 'READ_ONLY', days: 1 });
  expect(grant.status, JSON.stringify(grant.body)).toBe(201);
  await accountAdmin.dispose();
  const records: Record<string, Rec> = {
    clientId: (await get(`/clients/${clients.kestrel}`)) as Rec,
    instances: instance,
    exports: exportJob.body as Rec,
    invites: invite.body as Rec,
    imports: batch,
    'mapping-templates': template.body as Rec,
    companies: await first(`/clients/${clients.kestrel}/companies`),
    units: unit,
    locations: { id: unit.locationId, version: 1 },
    departments: await first(`/clients/${clients.kestrel}/departments`),
    otherDepartment: await nth(`/clients/${clients.kestrel}/departments`, 1),
    assignments: await first(`/clients/${clients.kestrel}/assignments`),
    people: (
      (await get(`/clients/${clients.kestrel}/people?limit=100`)) as { items: Rec[] }
    ).items.find((p) => p.id === people.owner)!,
    otherPerson: { id: people.approver, version: 1 },
    memberships: await first(`/people/${people.owner}/memberships`),
    acts: await first('/library/acts'),
    otherAct: await nth('/library/acts', 1),
    obligations: (await get(`/library/obligations/${detail.obligationId}`)) as Rec,
    categories: await first('/library/categories'),
    otherCategory: await nth('/library/categories', 1),
    evidence: { id: await evidenceOf(instance.id), version: 1 },
    'support-grants': grant.body as Rec,
    ...iso,
  };
  await admin.dispose();
  return {
    id: Object.fromEntries(Object.entries(records).map(([k, r]) => [k, r.id])),
    v: Object.fromEntries(Object.entries(records).map(([k, r]) => [k, r.version])),
  };
}

/**
 * Turns the ISO add-on on for both seed firms, as the console's add-on switch does (an account override), and copies the
 * catalogue the way M9's consumer would, so the ISO routes answer past FEATURE_NOT_ENABLED and FEATURE_NOT_READY. Firm B
 * gets it too, so its calls reach the tenant check rather than stopping at the add-on gate. `isoOff` takes the flag
 * back off after this file, so the later journeys run as before; the copied catalogue stays, as it would in an account.
 */
const isoAdded: string[] = [];
async function isoOn(): Promise<void> {
  const ownerUrl = databaseUrl(process.env.DATABASE_URL!, E2E_DATABASE);
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  for (const firmId of [FIRM_A, FIRM_B]) {
    if (isoAdded.includes(firmId)) continue;
    const added = await owner.query(
      `INSERT INTO platform.account_override (account_id, features) VALUES ($1, ARRAY['isoManagement'])
       ON CONFLICT (account_id) DO NOTHING`,
      [firmId],
    );
    if (added.rowCount !== 1) throw new Error(`firm ${firmId} already has an account override`);
    isoAdded.push(firmId);
  }
  await owner.end();
  const db = createDatabase({ connectionString: ownerUrl, max: 1, privilegedLogin: 'allow' });
  for (const firmId of [FIRM_A, FIRM_B]) await copyIsoCatalogue(db, firmId, 'e2e-iso');
  await db.close();
}

async function isoOff(): Promise<void> {
  if (isoAdded.length === 0) return;
  const owner = new pg.Client({
    connectionString: databaseUrl(process.env.DATABASE_URL!, E2E_DATABASE),
  });
  await owner.connect();
  await owner.query(`DELETE FROM platform.account_override WHERE account_id = ANY($1::uuid[])`, [
    isoAdded.splice(0),
  ]);
  await owner.end();
}

/**
 * Firm A's ISO records, made through the API as its consultant: a management system on the catalogue's first standard,
 * its first checklist row, a context item, a document and its draft revision, a certificate, an external audit, a risk
 * item with a control and an action, an objective with a reading, a nonconformity, and an audit programme with an
 * internal audit in progress, its checklist row and a finding (the file routes stay unmounted until ISO-15).
 * Keyed by the path segment before each id, or by `<parent>/<segment>` where two parents share a segment, as `fill`
 * reads them. An external finding needs a HELD visit, which needs the body's report file, so the external finding
 * routes name firm A's internal finding (`findings`), still a record of firm A.
 */
async function isoRecordsOf(
  admin: ApiSession,
  clientId: string,
  people: { owner: string; approver: string },
): Promise<Record<string, { id: string; version: number }>> {
  await isoOn();
  type Rec = { id: string; version: number };
  const iso = `/clients/${clientId}/iso`;
  const made = async (path: string, body: unknown, status = 201) => {
    const res = await admin.post(`${iso}${path}`, body);
    expect(res.status, `POST ${path}: ${JSON.stringify(res.body)}`).toBe(status);
    return res.body as Rec;
  };
  const listed = async (path: string) => {
    const res = await admin.get(`${iso}${path}`);
    expect(res.status, `GET ${path}: ${JSON.stringify(res.body)}`).toBe(200);
    const item = itemsOf(res.body)[0] as Rec | undefined;
    if (!item) throw new Error(`firm A has no ISO record at ${path}`);
    return item;
  };
  const suffix = crypto.randomUUID().slice(0, 8);
  const standard = await listed('/catalogue/standards');
  const system = await made('/systems', {
    name: `Quality system ${suffix}`,
    standardIds: [standard.id],
  });
  const document = await made('/documents', {
    managementSystemId: system.id,
    code: `QP-${suffix}`,
    title: 'Control of documented information',
    type: 'PROCEDURE',
    ownerId: people.owner,
    approverId: people.approver,
  });
  const certificate = await made('/certifications', {
    managementSystemId: system.id,
    standardId: standard.id,
    body: 'Northfield Certification',
  });
  const risk = await made('/risks', {
    managementSystemId: system.id,
    kind: 'RISK',
    activity: 'Packaging supply',
    description: 'One supplier makes every carton',
    likelihood: 2,
    severity: 3,
    ownerId: people.owner,
  });
  const objective = await made('/objectives', {
    managementSystemId: system.id,
    standards: [(standard as Rec & { code: string }).code],
    text: 'On-time delivery',
    target: 98,
    unitOfMeasure: '%',
    direction: 'INCREASE',
    readingRule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    ownerId: people.owner,
    dueOn: '2099-03-31',
  });
  const row = (await listed(`/systems/${system.id}/checklist`)) as Rec & { clauseId: string };
  const programme = await made('/audit-programmes', {
    managementSystemId: system.id,
    fy: '2098-99',
  });
  const planned = await made('/internal-audits', {
    programmeId: programme.id,
    title: 'Document control audit',
    plannedStart: '2099-01-20',
    plannedEnd: '2099-01-21',
    clauseIds: [row.clauseId],
    leadAuditorId: people.owner,
  });
  const audit = await made(
    `/internal-audits/${planned.id}/start`,
    { version: planned.version },
    200,
  );
  const finding = await made(`/internal-audits/${audit.id}/findings`, {
    type: 'OFI',
    description: 'Revision history could be clearer',
  });
  return {
    standards: standard,
    systems: system,
    checklist: row,
    clauses: { id: row.clauseId, version: 0 },
    'audit-programmes': programme,
    'internal-audits': audit,
    'internal-audits/checklist': await made(`/internal-audits/${audit.id}/checklist`, {
      clauseId: row.clauseId,
      question: 'Is every procedure under revision control?',
    }),
    'internal-audits/findings': finding,
    findings: finding,
    context: await made(`/systems/${system.id}/context`, {
      kind: 'EXTERNAL_ISSUE',
      text: 'Supplier lead times',
    }),
    documents: document,
    revisions: await made(`/documents/${document.id}/revisions`, { revision: 'A' }),
    certifications: certificate,
    'external-audits': await made('/external-audits', {
      managementSystemId: system.id,
      standardIds: [standard.id],
      type: 'STAGE_1',
      body: 'Northfield Certification',
      startOn: '2099-01-10',
      endOn: '2099-01-11',
    }),
    risks: risk,
    controls: await made(`/risks/${risk.id}/controls`, { text: 'Two weeks of carton stock' }),
    actions: await made('/actions', {
      subject: { type: 'RISK_ITEM', id: risk.id },
      text: 'Qualify a second carton supplier',
      ownerId: people.owner,
      dueOn: '2099-03-31',
    }),
    objectives: objective,
    readings: await made(`/objectives/${objective.id}/readings`, {
      periodStart: '2023-04-01',
      periodEnd: '2023-04-30',
      value: 95,
    }),
    nonconformities: await made('/nonconformities', {
      managementSystemId: system.id,
      source: 'PROCESS',
      severity: 'MINOR',
      standards: [(standard as Rec & { code: string }).code],
      description: 'Calibration record missing',
      ownerId: people.owner,
      approverId: people.approver,
      dueOn: '2099-03-31',
    }),
  };
}

test.afterAll(isoOff);

/** Uploads a file (a small PDF by default) to an instance as the client admin, the way the drawer does; its evidence id. */
async function evidenceOf(
  instanceId: string,
  fileName = 'challan.pdf',
  data = PDF,
): Promise<string> {
  const admin = await apiAs('clientAdmin');
  const ticket = await admin.post(`/instances/${instanceId}/evidence/upload-url`, {
    fileName,
    mimeType: 'application/pdf',
    sizeBytes: data.length,
  });
  expect(ticket.status, JSON.stringify(ticket.body)).toBe(200);
  const { uploadId, url, headers } = ticket.body as {
    uploadId: string;
    url: string;
    headers: Record<string, string>;
  };
  const put = await admin.http.put(url, { headers, data });
  expect(put.status()).toBe(200);
  const confirmed = await admin.post(`/instances/${instanceId}/evidence`, {
    uploadId,
    fileName,
    sha256: createHash('sha256').update(data).digest('hex'),
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
  await admin.dispose();
  return (confirmed.body as { id: string }).id;
}

/**
 * The path with every parameter filled from `ids`: by `<parent>/<segment>` (the record segment before the previous
 * parameter, then the one before this), else by the segment before it. Throws on a kind it has no id for.
 */
function fill(path: string, ids: Record<string, string>): string {
  const parts = path.split('/');
  let parent = '';
  return parts
    .map((part, i) => {
      const param = /^\{(\w+)\}$/.exec(part)?.[1];
      if (param === undefined) return part;
      const segment = parts[i - 1]!;
      if (param === 'groupKey') return 'RULE_LOW_CONFIDENCE-0';
      const id =
        param === 'clientId' ? ids.clientId : (ids[`${parent}/${segment}`] ?? ids[segment]);
      if (!id) throw new Error(`no id for {${param}} in ${path}: add the record kind to firmAIds`);
      parent = segment;
      return id;
    })
    .join('/');
}

const SAFE_DENIALS = [403, 404];
const UNKNOWN = '01920000-0000-7000-8000-0000000dead0';
/** Ids no firm has, for every record kind `fill` can name. */
const NOBODY = new Proxy({} as Record<string, string>, { get: () => UNKNOWN });

/** Endpoints swept from one address: at most two calls each, well under the API's 300 a minute. */
const SWEEP_CHUNK = 60;

async function call(api: ApiSession, method: string, path: string, body: unknown = {}) {
  if (method === 'GET') return api.get(path);
  const res = await api.http.fetch(`/api/v1${path}`, {
    method,
    headers: { 'x-csrf-token': api.csrfToken, 'idempotency-key': crypto.randomUUID() },
    ...(body === undefined ? {} : { data: body }),
  });
  return { status: res.status(), body: await res.text() };
}

test.describe('tenant isolation', () => {
  test('every endpoint is either swept or listed with a reason', () => {
    for (const name of [...Object.keys(UNMOUNTED), ...Object.keys(BODIES)])
      expect(ENDPOINTS, name).toHaveProperty(name);
    for (const [name, e] of endpoints) {
      expect(
        sweepable(name, e) !== name in NOT_SWEPT || name in UNMOUNTED,
        `${name} (${e.method} ${e.path}): sweep it, or list it in NOT_SWEPT with a reason`,
      ).toBe(true);
    }
  });

  test('firm B’s admins reach none of firm A’s records through any endpoint', async () => {
    const ids = await firmAIds();
    const kestrelNames = ['Kestrel', 'Person Mike', 'challan.pdf'];
    const swept = endpoints.filter(([name, e]) => sweepable(name, e) && !(name in UNMOUNTED));
    for (const key of ['ospreyFirmAdmin', 'ospreyAdmin'] as const) {
      // Up to two calls an endpoint: a fresh address every SWEEP_CHUNK endpoints keeps each under the API's per-IP
      // limit (300 a minute), which 05-shell-load.spec.ts checks on its own.
      let api = await apiAs(key, 1);
      for (const [index, [name, e]] of swept.entries()) {
        if (index > 0 && index % SWEEP_CHUNK === 0) {
          await api.dispose();
          api = await apiAs(key, 1 + index / SWEEP_CHUNK);
        }
        let res: { status: number; body: unknown };
        let label: string;
        if (e.method === 'GET' && !e.path.includes('{')) {
          // A firm-wide list holds firm B's records only.
          res = await api.get(e.path);
          label = `${key} GET ${e.path} (${name}) -> ${res.status}`;
          expect([200, 403], label).toContain(res.status);
        } else if (e.method === 'GET') {
          const path = fill(e.path, ids.id);
          res = await api.get(path);
          label = `${key} GET ${path} (${name}) -> ${res.status}`;
          // A record in another firm is never shown: not found, or forbidden for the role.
          expect(SAFE_DENIALS, label).toContain(res.status);
        } else {
          const path = fill(e.path, ids.id);
          const build = BODIES[name];
          const body = build ? build(ids) : {};
          const nobodyBody = build ? build({ id: NOBODY, v: ids.v }) : {};
          if (build && body !== undefined) e.body!.parse(body);
          res = await call(api, e.method, path, body);
          label = `${key} ${e.method} ${path} (${name}) -> ${res.status}`;
          // Never changed, and no existence oracle: firm A's id gets the same answer as an id nobody has. With a
          // valid body that answer is a denial; an empty body may fail validation first, the same way for both.
          if (build) expect(SAFE_DENIALS, label).toContain(res.status);
          else expect(res.status, label).toBeGreaterThanOrEqual(400);
          const nobody = await call(api, e.method, fill(e.path, NOBODY), nobodyBody);
          expect(res.status, `${label}; unknown id -> ${nobody.status}`).toBe(nobody.status);
        }
        const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        for (const word of kestrelNames) expect(text, `${label} leaks ${word}`).not.toContain(word);
      }
      await api.dispose();
    }
  });

  test('the app’s database login sees only the tenant it is set to (RLS)', async () => {
    const base = process.env.DATABASE_URL!;
    const client = new pg.Client({
      connectionString: databaseUrl(base, E2E_DATABASE, [APP_LOGIN, APP_PASSWORD]),
    });
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    // pg-boss's rows carry every firm's ids and have no RLS, so from migration 0023 (ADR M3-0004) the tenant login
    // cannot reach them at all.
    const jobsRole = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'canopy_jobs'`);
    if (jobsRole.rowCount) {
      await expect(client.query('SELECT count(*) FROM pgboss.job')).rejects.toMatchObject({
        code: '42501',
      });
    }
    /** Rows of `table` belonging to `owner`, as seen in a transaction set to `as` (or to no tenant). */
    const rowsOf = async (as: string | null, table: string, owner: string) => {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE canopy_app');
      if (as) {
        // Exactly what withTenant sets for a firm-wide system context.
        for (const [name, value] of Object.entries(tenantSettings(systemContext(as, 'e2e-rls')))) {
          await client.query('SELECT set_config($1, $2, true)', [name, value]);
        }
      }
      // No error is swallowed: a policy that refused instead of filtering would fail the test, not count as 0.
      try {
        const res = await client.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'firm' ? 'id' : 'firm_id'} = $1`,
          [owner],
        );
        return res.rows[0].n as number;
      } finally {
        await client.query('ROLLBACK');
      }
    };
    const tables = [
      'firm',
      'client',
      'person',
      'membership',
      'compliance_instance',
      'assignment',
      'obligation',
      'evidence',
      'comment',
      'audit_event',
      'import_batch',
      'export_job',
      'auth_session',
    ];
    for (const table of tables) {
      expect(await rowsOf(FIRM_A, table, FIRM_A), `${table}: firm A sees its rows`).toBeGreaterThan(
        0,
      );
      expect(await rowsOf(FIRM_B, table, FIRM_A), `${table}: firm B sees firm A's`).toBe(0);
      expect(await rowsOf(null, table, FIRM_A), `${table}: no tenant sees firm A's`).toBe(0);
    }
    await client.end();
  });
});

test.describe('sessions', () => {
  test('every signed-in endpoint refuses a request with no session', async () => {
    const ids = await firmAIds();
    const anon = await anonymousApi();
    for (const [name, e] of endpoints) {
      const path = fill(e.path, name in UNMOUNTED ? NOBODY : ids.id);
      const res = await call(anon, e.method, path);
      const label = `${e.method} ${path} (${name}) -> ${res.status}`;
      if (name in UNMOUNTED) {
        // Not served yet: no route at all. Anything else means it shipped; take it off UNMOUNTED.
        expect(res.status, `${label}: now served, remove it from UNMOUNTED`).toBe(404);
      } else if (e.auth !== 'public') {
        // GETs: 401. Writes: 403 (no session means no CSRF match) or 401.
        expect([401, 403], label).toContain(res.status);
      }
    }
    await anon.dispose();
  });

  test('a write without the CSRF token is refused', async () => {
    const { clients } = seeded();
    const admin = await apiAs('clientAdmin');
    const res = await admin.http.post(`/api/v1/clients/${clients.kestrel}/exports`, {
      data: { kind: 'REGISTER_XLSX', filters: FY },
    });
    expect(res.status()).toBe(403);
    await admin.dispose();
  });

  test('the session cookie is HttpOnly, Secure and SameSite=Lax, and sign-out ends it on the server', async () => {
    const { cookies } = JSON.parse(
      await import('node:fs').then((fs) => fs.readFileSync(storageStateOf('viewer'), 'utf8')),
    ) as { cookies: { name: string; httpOnly: boolean; secure: boolean; sameSite: string }[] };
    expect(cookies.find((c) => c.name === 'sid')).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });

    // A fresh session for the viewer, then sign out and replay its cookie.
    const http = await request.newContext({ baseURL: API_URL });
    const login = await http.post('/api/v1/auth/login', {
      data: { email: ACCOUNTS.viewer.email, password: PASSWORD },
    });
    expect(login.status()).toBe(200);
    const sid = login
      .headersArray()
      .find((h) => /^set-cookie$/i.test(h.name) && h.value.startsWith('sid='));
    const cookie = sid!.value.split(';')[0]!;
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    expect((await http.get('/api/v1/me', { headers: { cookie } })).status()).toBe(200);
    const out = await http.post('/api/v1/auth/logout', {
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(out.status()).toBe(204);
    expect((await http.get('/api/v1/me', { headers: { cookie } })).status()).toBe(401);
    // A wrong password says nothing about whether the email exists.
    const wrong = await http.post('/api/v1/auth/login', {
      data: { email: ACCOUNTS.viewer.email, password: 'not the password' },
    });
    const nobody = await http.post('/api/v1/auth/login', {
      data: { email: 'nobody@kestrel.test', password: 'not the password' },
    });
    expect(wrong.status()).toBe(401);
    expect(nobody.status()).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: { code: (await nobody.json()).error.code } });
    await http.dispose();
  });
});

test.describe('evidence files', () => {
  test('only accepted types get an upload link, and the link binds the declared type and size', async () => {
    const { clients } = seeded();
    const admin = await apiAs('clientAdmin');
    const instance = itemsOf(
      (await admin.get(`/clients/${clients.kestrel}/instances?${FY}&workflowState=OPEN&limit=1`))
        .body,
    )[0]!;
    for (const [fileName, mimeType] of [
      ['payload.html', 'text/html'],
      ['payload.svg', 'image/svg+xml'],
      ['tool.exe', 'application/octet-stream'],
      ['scan.pdf', 'text/html'],
    ]) {
      const res = await admin.post(`/instances/${instance.id}/evidence/upload-url`, {
        fileName,
        mimeType,
        sizeBytes: 10,
      });
      expect(res.status, fileName).toBe(400);
    }
    const tooBig = await admin.post(`/instances/${instance.id}/evidence/upload-url`, {
      fileName: 'big.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 25 * 1024 * 1024 + 1,
    });
    expect(tooBig.status).toBe(400);

    const ticket = (
      await admin.post(`/instances/${instance.id}/evidence/upload-url`, {
        fileName: 'challan.pdf',
        mimeType: 'application/pdf',
        sizeBytes: PDF.length,
      })
    ).body as { url: string; headers: Record<string, string> };
    expect(new URL(ticket.url).searchParams.get('X-Amz-Expires')).toBe('300');
    // Another content type than the one signed is refused by storage.
    const swapped = await admin.http.put(ticket.url, {
      headers: { ...ticket.headers, 'Content-Type': 'text/html' },
      data: PDF,
    });
    expect(swapped.status()).toBe(403);
    await admin.dispose();
  });

  test('a file is handed out only once the scan finds it clean, and the vault is per client', async () => {
    test.setTimeout(180_000);
    const { clients } = seeded();
    const admin = await apiAs('clientAdmin');
    const open = itemsOf(
      (await admin.get(`/clients/${clients.kestrel}/instances?${FY}&workflowState=OPEN&limit=1`))
        .body,
    )[0]!;
    const clean = await evidenceOf(open.id, 'challan.pdf');
    // EICAR's test string in a file with an accepted name and type: only the scan can catch it.
    const flagged = await evidenceOf(open.id, 'form-5a.pdf', Buffer.from(EICAR));
    // The scan job runs once a minute (M9), so a file just recorded is still PENDING and is not handed out.
    const early = await admin.get(`/evidence/${flagged}/download-url`);
    expect(early).toMatchObject({ status: 422, body: { error: { code: 'EVIDENCE_NOT_READY' } } });

    type File = { id: string; scanStatus: string };
    const statusOf = async () => {
      const vault = await admin.get(`/clients/${clients.kestrel}/evidence?limit=200`);
      expect(vault.status).toBe(200);
      // The vault never returns the storage key.
      expect(JSON.stringify(vault.body)).not.toContain('storageKey');
      const files = itemsOf(vault.body) as unknown as File[];
      return Object.fromEntries(files.map((f) => [f.id, f.scanStatus]));
    };
    await expect
      .poll(
        async () => {
          const status = await statusOf();
          return [status[clean], status[flagged]];
        },
        { timeout: 150_000, intervals: [5_000] },
      )
      .toEqual(['CLEAN', 'INFECTED']);

    const refused = await admin.get(`/evidence/${flagged}/download-url`);
    expect(refused).toMatchObject({ status: 422, body: { error: { code: 'EVIDENCE_NOT_READY' } } });
    const link = await admin.get(`/evidence/${clean}/download-url`);
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const { url } = link.body as { url: string };
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('300');
    const download = await admin.http.get(url);
    expect(download.status()).toBe(200);
    expect(Buffer.from(await download.body()).equals(PDF)).toBe(true);

    // The scan's verdicts and the download are on the instance's audit trail.
    const trail = await admin.get(`/instances/${open.id}/audit?limit=50`);
    expect(trail.status, JSON.stringify(trail.body)).toBe(200);
    const events = (
      trail.body as { items: { action: string; after: Record<string, unknown> | null }[] }
    ).items;
    for (const [evidenceId, scanStatus] of [
      [clean, 'CLEAN'],
      [flagged, 'INFECTED'],
    ])
      expect(events, `${scanStatus} verdict audited`).toContainEqual(
        expect.objectContaining({
          action: 'UPDATE',
          after: expect.objectContaining({ evidenceId, scanStatus }),
        }),
      );
    expect(events).toContainEqual(
      expect.objectContaining({ action: 'EVIDENCE_DOWNLOAD', after: { evidenceId: clean } }),
    );

    // Firm B's admin sees none of it.
    const osprey = await apiAs('ospreyAdmin');
    expect(SAFE_DENIALS).toContain(
      (await osprey.get(`/clients/${clients.kestrel}/evidence`)).status,
    );
    expect(SAFE_DENIALS).toContain((await osprey.get(`/evidence/${clean}/download-url`)).status);
    await osprey.dispose();
    await admin.dispose();
  });
});
