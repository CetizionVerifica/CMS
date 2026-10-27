import { createHash } from 'node:crypto';

import { ENDPOINTS, IsoFileSubjectType } from '@canopy/contracts';
import { createDatabase } from '@canopy/db';
import { expect } from '@playwright/test';
import pg from 'pg';

// By path, not through `@canopy/api`: Playwright does not compile TypeScript it reaches through node_modules.
import { ISO_FILE_ENDPOINTS, ISO_SERVED_ENDPOINTS } from '../../apps/api/src/modules/iso/served.js';
import { copyIsoCatalogue } from '../../apps/api/src/modules/library/db-iso-catalogue-copy.js';
import { apiAs, itemsOf, type ApiSession } from './api.js';
import { seeded } from './helpers.js';
import { E2E_DATABASE, FIRM_A, FIRM_B, databaseUrl } from './stack.js';

// Firm A's records of every kind a path can name, the ISO add-on's switch, and the endpoint probes built from them,
// shared by the security checks (04-security.spec.ts) and the ISO off-switch sweep (04b-iso-off-sweep.spec.ts).

export const FY = 'fy=2022-23';
export const PDF = Buffer.from('%PDF-1.4\n% integrated journey evidence\n%%EOF\n');

export type Endpoint = {
  auth: string;
  method: string;
  path: string;
  body?: { parse(v: unknown): unknown } | null;
  /** The add-on an endpoint belongs to; the ISO add-on's endpoints carry it from ISO-1 (ADR M16-0001). */
  feature?: string;
};
export const endpoints = Object.entries(ENDPOINTS as Record<string, Endpoint>);

/**
 * The ISO add-on endpoints M16 serves (ISO-8a, ISO-8b, ISO-8c), with its file routes, which the app serves with its S3
 * evidence storage (ISO-14b); any other add-on endpoint stays on UNMOUNTED until it ships.
 */
export const ISO_SERVED: ReadonlySet<string> = new Set([
  ...ISO_SERVED_ENDPOINTS,
  ...ISO_FILE_ENDPOINTS,
]);

/**
 * Contract endpoints the API does not serve yet, with why. Every check below expects them to answer 404 (no route) and
 * fails once one answers anything else, so it must come off this list the day it ships and be checked like the rest.
 */
export const UNMOUNTED: Record<string, string> = Object.fromEntries(
  endpoints
    .filter(([name, e]) => 'feature' in e && !ISO_SERVED.has(name))
    .map(([name, e]) => [
      name,
      `${String(e.feature)} add-on: not served yet (docs/iso/plan.md ISO-8)`,
    ]),
);

export const PROBE = 'isolation probe';
export const SHA = '0'.repeat(64);

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
export const ASSIGNMENT = (id: Record<string, string>) => ({
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
export const BODIES: Record<string, (ids: Ids) => unknown> = {
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
  removeIsoFile: () => ({ reason: PROBE }),
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
  updateIsoExternalFinding: ({ v }) => ({
    version: v['external-audits/findings'],
    description: PROBE,
  }),
  recordIsoExternalAuditResponse: ({ v }) => ({ version: v['external-audits'] }),
  closeIsoExternalAudit: ({ v }) => ({
    version: v['external-audits'],
    recommendation: 'RECOMMENDED',
  }),
  // ISO-8c part 3: firm A's management review with its input and output rows.
  planIsoManagementReview: ({ id }) => ({
    managementSystemId: id.systems,
    standards: ['ISO_9001'],
    plannedOn: '2099-02-10',
    chairId: id.people,
  }),
  updateIsoManagementReview: ({ v }) => ({ version: v['management-reviews'], minutes: PROBE }),
  replanIsoManagementReview: ({ v }) => ({
    version: v['management-reviews'],
    plannedOn: '2099-02-11',
    reason: PROBE,
  }),
  cancelIsoManagementReview: ({ v }) => ({ version: v['management-reviews'], reason: PROBE }),
  recordIsoManagementReviewHeld: ({ v }) => ({
    version: v['management-reviews'],
    heldOn: '2023-04-10',
  }),
  closeIsoManagementReview: ({ v }) => ({ version: v['management-reviews'] }),
  updateIsoReviewInput: ({ v }) => ({ version: v['management-reviews/inputs'], notes: PROBE }),
  updateIsoReviewOutput: ({ v }) => ({
    version: v['management-reviews/outputs'],
    decision: PROBE,
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
export const sweepable = (name: string, e: Endpoint) =>
  e.auth !== 'public' && (e.path.includes('{') || e.method === 'GET' || name in BODIES);

/** Firm A's ids (and record versions) for every kind of record a path can name, read as firm A's own users. */
export type Ids = { id: Record<string, string>; v: Record<string, number> };

/** Firm A's ids, with the keys of `id` that name its ISO records (as `isoRecordsOf` keys them). */
export async function firmAIds(): Promise<Ids & { isoKeys: string[] }> {
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
    isoKeys: Object.keys(iso),
  };
}

/**
 * Turns the ISO add-on on for both seed firms, as the console's add-on switch does (an account override), and copies the
 * catalogue the way M9's consumer would, so the ISO routes answer past FEATURE_NOT_ENABLED and FEATURE_NOT_READY. Firm B
 * gets it too, so its calls reach the tenant check rather than stopping at the add-on gate. `isoOff` takes the flag
 * back off after this file, so the later journeys run as before; the copied catalogue stays, as it would in an account.
 */
const isoAdded: string[] = [];
export async function isoOn(): Promise<void> {
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

/**
 * Firm A's record keys (as `isoRecordsOf` keys them) for every ISO file subject type, so the file probes name a real
 * record of each: a finding on an internal audit and one on an external audit. `isoRecordsOf` throws on a type with no
 * record, so a new subject type has to be added here.
 */
export const FILE_SUBJECTS: Record<IsoFileSubjectType, readonly string[]> = {
  clause_assessment: ['checklist'],
  document_revision: ['revisions'],
  risk_item: ['risks'],
  objective_reading: ['readings'],
  internal_audit: ['internal-audits'],
  audit_finding: ['internal-audits/findings', 'external-audits/findings'],
  external_audit: ['external-audits'],
  certification: ['certifications'],
  nonconformity: ['nonconformities'],
  iso_action: ['actions'],
  management_review: ['management-reviews'],
};
/** Where `isoRecordsOf` keeps the file firm A uploaded on the record at `key`. */
export const fileKey = (key: string) => `files@${key}`;

/**
 * Uploads a small PDF to an ISO record, the way the screens do (upload URL, PUT to storage, confirm); the file, PENDING
 * until the scan job runs. `api` must be allowed to write the record: the client admin may write every subject type
 * (a nonconformity's files are the client admin's or its owner's, not firm staff's).
 */
export async function isoFileOf(
  api: ApiSession,
  clientId: string,
  subject: { type: IsoFileSubjectType; id: string },
  fileName = 'record.pdf',
): Promise<{ id: string; version: number }> {
  const iso = `/clients/${clientId}/iso`;
  const ticket = await api.post(`${iso}/files/upload-url`, {
    subject,
    fileName,
    mimeType: 'application/pdf',
    sizeBytes: PDF.length,
  });
  expect(ticket.status, `upload URL on ${subject.type}: ${JSON.stringify(ticket.body)}`).toBe(200);
  const { uploadId, url, headers } = ticket.body as {
    uploadId: string;
    url: string;
    headers: Record<string, string>;
  };
  const put = await api.http.put(url, { headers, data: PDF });
  expect(put.status(), `PUT on ${subject.type}`).toBe(200);
  const confirmed = await api.post(`${iso}/files`, {
    subject,
    uploadId,
    fileName,
    sha256: createHash('sha256').update(PDF).digest('hex'),
  });
  expect(confirmed.status, `confirm on ${subject.type}: ${JSON.stringify(confirmed.body)}`).toBe(
    201,
  );
  return { id: (confirmed.body as { id: string }).id, version: 0 };
}

export async function isoOff(): Promise<void> {
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
 * internal audit in progress, its checklist row and a finding, and a management review with its first input and
 * output row.
 * Keyed by the path segment before each id, or by `<parent>/<segment>` where two parents share a segment, as `fill`
 * reads them. The external audit is HELD with an OFI finding of its own: RECORD_HELD needs the body's report file, which
 * is uploaded through the API first (PENDING counts as a report). Then every record `FILE_SUBJECTS` names gets a file
 * of its own, kept under `fileKey(key)`, and `files` is the report, for the probes that name one file. The files are
 * the client admin's uploads, since firm staff may not add files to a nonconformity.
 */
export async function isoRecordsOf(
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
  const plannedVisit = await made('/external-audits', {
    managementSystemId: system.id,
    standardIds: [standard.id],
    type: 'STAGE_1',
    body: 'Northfield Certification',
    startOn: '2023-04-10',
    endOn: '2023-04-11',
  });
  const uploader = await apiAs('clientAdmin');
  const report = await isoFileOf(
    uploader,
    clientId,
    { type: 'external_audit', id: plannedVisit.id },
    'stage-1-report.pdf',
  );
  const visit = await made(
    `/external-audits/${plannedVisit.id}/held`,
    { version: plannedVisit.version, startOn: '2023-04-10', endOn: '2023-04-11' },
    200,
  );
  const review = await made('/management-reviews', {
    managementSystemId: system.id,
    standards: [(standard as Rec & { code: string }).code],
    plannedOn: '2099-02-10',
    chairId: people.owner,
    attendeeIds: [people.approver],
  });
  const records: Record<string, Rec> = {
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
    'management-reviews': review,
    'management-reviews/inputs': await listed(`/management-reviews/${review.id}/inputs`),
    'management-reviews/outputs': await listed(`/management-reviews/${review.id}/outputs`),
    context: await made(`/systems/${system.id}/context`, {
      kind: 'EXTERNAL_ISSUE',
      text: 'Supplier lead times',
    }),
    documents: document,
    revisions: await made(`/documents/${document.id}/revisions`, { revision: 'A' }),
    certifications: certificate,
    'external-audits': visit,
    'external-audits/findings': await made(`/external-audits/${visit.id}/findings`, {
      type: 'OFI',
      description: 'Supplier evaluation records could be clearer',
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
  const files: Record<string, Rec> = { files: report };
  for (const [type, keys] of Object.entries(FILE_SUBJECTS) as [IsoFileSubjectType, string[]][]) {
    for (const key of keys) {
      const record = records[key];
      if (!record) throw new Error(`firm A has no ISO record at ${key} for files on ${type}`);
      files[fileKey(key)] =
        key === 'external-audits'
          ? report
          : await isoFileOf(uploader, clientId, { type, id: record.id });
    }
  }
  await uploader.dispose();
  return { ...records, ...files };
}

/** Uploads a file (a small PDF by default) to an instance as the client admin, the way the drawer does; its evidence id. */
export async function evidenceOf(
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
export function fill(path: string, ids: Record<string, string>): string {
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

export const SAFE_DENIALS = [403, 404];
export const UNKNOWN = '01920000-0000-7000-8000-0000000dead0';
/** Ids no firm has, for every record kind `fill` can name. */
export const NOBODY = new Proxy({} as Record<string, string>, { get: () => UNKNOWN });

/** Endpoints swept from one address: at most two calls each, well under the API's 300 a minute. */
export const SWEEP_CHUNK = 60;

/** One call of the isolation sweep with firm A's ids, and the same call naming ids nobody has (writes only). */
export type Probe = {
  name: string;
  method: string;
  path: string;
  /** Whether BODIES (or FILE_BODIES) builds this write's body; a write with none is sent an empty one. */
  built: boolean;
  /** The body built from firm A's records (undefined for a write the contract gives no body). */
  body?: unknown;
  nobodyPath: string;
  nobodyBody?: unknown;
};

/** ISO file bodies for a subject, from the contract's shapes: an upload of a small PDF, a confirm nobody uploaded. */
export const FILE_BODIES: Record<string, (subject: { type: string; id: string }) => unknown> = {
  isoFileUploadUrl: (subject) => ({
    subject,
    fileName: 'probe.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 10,
  }),
  confirmIsoFile: (subject) => ({ subject, uploadId: UNKNOWN, fileName: 'probe.pdf', sha256: SHA }),
};

/**
 * The sweep's calls for one endpoint. The ISO file routes name their subject in the body or query, or a file in the
 * path, so they get one probe for each record `FILE_SUBJECTS` names, or for each of those records' files; every other
 * endpoint gets one.
 */
export function probesOf(name: string, e: Endpoint, ids: Ids): Probe[] {
  const subjects = (Object.entries(FILE_SUBJECTS) as [string, readonly string[]][]).flatMap(
    ([type, keys]) => keys.map((key) => ({ type, key, id: ids.id[key]! })),
  );
  const fileBody = FILE_BODIES[name];
  if (fileBody) {
    return subjects.map(({ type, id }) => ({
      name: `${name} on ${type}`,
      method: e.method,
      path: fill(e.path, ids.id),
      built: true,
      body: fileBody({ type, id }),
      nobodyPath: fill(e.path, NOBODY),
      nobodyBody: fileBody({ type, id: UNKNOWN }),
    }));
  }
  if (name === 'listIsoFiles') {
    return subjects.map(({ type, id }) => ({
      name: `${name} on ${type}`,
      method: e.method,
      path: `${fill(e.path, ids.id)}?subjectType=${type}&subjectId=${id}`,
      built: false,
      nobodyPath: `${fill(e.path, NOBODY)}?subjectType=${type}&subjectId=${UNKNOWN}`,
    }));
  }
  const build = BODIES[name];
  const probe = (label: string, id: Record<string, string>): Probe => ({
    name: label,
    method: e.method,
    path: fill(e.path, id),
    built: build !== undefined,
    body: build ? build({ id, v: ids.v }) : {},
    nobodyPath: fill(e.path, NOBODY),
    nobodyBody: build ? build({ id: NOBODY, v: ids.v }) : {},
  });
  if (name === 'isoFileDownloadUrl' || name === 'removeIsoFile') {
    return subjects.map(({ type, key }) =>
      probe(`${name} of a file on ${type}`, { ...ids.id, files: ids.id[fileKey(key)]! }),
    );
  }
  return [probe(name, ids.id)];
}

export async function call(api: ApiSession, method: string, path: string, body: unknown = {}) {
  if (method === 'GET') return api.get(path);
  const res = await api.http.fetch(`/api/v1${path}`, {
    method,
    headers: { 'x-csrf-token': api.csrfToken, 'idempotency-key': crypto.randomUUID() },
    ...(body === undefined ? {} : { data: body }),
  });
  return { status: res.status(), body: await res.text() };
}
