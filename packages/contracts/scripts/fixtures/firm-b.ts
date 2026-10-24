// Firm B: invented data for isolation tests and the states the sample lacks (docs/contracts/fixtures.md §6).
// Every name here is made up. Periods and due dates are written out by this script; they are fixture data,
// not the engine's recurrence logic.
import { createHash } from 'node:crypto';
import type {
  Act,
  Assignment,
  AuditEvent,
  Category,
  Comment,
  ComplianceInstance,
  Criticality,
  Department,
  Evidence,
  FixtureSet,
  Membership,
  Obligation,
  ObligationDomain,
  Person,
  RecurrenceRule,
  ScanStatus,
  TimelineType,
} from './types.js';
import {
  DEFAULT_ACCOUNT,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_FIRM_SETTINGS,
} from '../../src/index.js';
import { fixtureId } from '../../src/fixtures/index.js';
import { addDays, type Period, periodsIn } from '../../src/mock/periods.js';

const CREATED_AT = '2023-03-15T05:30:00Z';
/** Instances due before this date are approved; later ones are open, apart from the showcase cases. */
const SETTLED_BEFORE = '2024-10-01';

const k = (key: string) => `firm-b:${key}`;
const firmId = fixtureId('firm-b');
const base = (key: string) => ({
  id: fixtureId(k(key)),
  firmId,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  archivedAt: null,
});
const versioned = (key: string) => ({ ...base(key), version: 1 });

// ---------- tenancy ----------

const northwindSettings = DEFAULT_CLIENT_SETTINGS;
const clients = [
  { ...versioned('client:northwind'), name: 'Northwind Foods Group', settings: northwindSettings },
  {
    ...versioned('client:harbour'),
    name: 'Harbour Retail Group',
    settings: { ...DEFAULT_CLIENT_SETTINGS, fyStartMonth: 1 },
  },
];
const [northwind, harbour] = clients as [(typeof clients)[0], (typeof clients)[0]];
const companies = [
  { ...versioned('company:northwind'), clientId: northwind.id, name: 'Northwind Foods Pvt Ltd' },
  { ...versioned('company:harbour'), clientId: harbour.id, name: 'Harbour Retail Pvt Ltd' },
];
const locations = [
  ['pune', 'Maharashtra', 'MH', 'Pune'],
  ['bengaluru', 'Karnataka', 'KA', 'Bengaluru'],
  ['chennai', 'Tamil Nadu', 'TN', 'Chennai'],
].map(([key, state, stateCode, city]) => ({
  ...base(`location:${key}`),
  country: 'India',
  countryCode: 'IN',
  state: state!,
  stateCode: stateCode!,
  city: city!,
}));
const units = [
  ['pune', 'Pune Plant', northwind, companies[0]!],
  ['bengaluru', 'Bengaluru Office', northwind, companies[0]!],
  ['chennai', 'Chennai Store', harbour, companies[1]!],
].map(([key, name, client, company]) => ({
  ...versioned(`unit:${key as string}`),
  clientId: (client as typeof northwind).id,
  companyId: (company as (typeof companies)[0]).id,
  name: name as string,
  locationId: fixtureId(k(`location:${key as string}`)),
}));
const [pune, bengaluru, chennai] = units as [
  (typeof units)[0],
  (typeof units)[0],
  (typeof units)[0],
];

const departments: Department[] = [
  ['finance', 'Finance', northwind, []],
  ['hr', 'Human Resources', northwind, ['HR']],
  ['safety', 'Safety', northwind, []],
  ['operations', 'Operations', harbour, []],
].map(([key, name, client, aliases]) => ({
  ...versioned(`department:${key as string}`),
  clientId: (client as typeof northwind).id,
  name: name as string,
  aliases: aliases as string[],
}));
const dept = (key: string) => fixtureId(k(`department:${key}`));

// ---------- people ----------

const personRows: [string, string, string | null, Person['status']][] = [
  ['meera', 'Meera Kulkarni', 'meera.kulkarni@second-ledger.example', 'ACTIVE'],
  ['arjun', 'Arjun Rao', 'arjun.rao@second-ledger.example', 'ACTIVE'],
  ['leela', 'Leela Iyer', 'leela.iyer@second-ledger.example', 'ACTIVE'],
  ['kabir', 'Kabir Shah', 'kabir.shah@northwind.example', 'ACTIVE'],
  ['nisha', 'Nisha Patil', 'nisha.patil@northwind.example', 'ACTIVE'],
  ['rohan', 'Rohan Joshi', 'rohan.joshi@northwind.example', 'ACTIVE'],
  ['divya', 'Divya Hegde', 'divya.hegde@northwind.example', 'ACTIVE'],
  ['sameer', 'Sameer Gowda', 'sameer.gowda@northwind.example', 'ACTIVE'],
  ['ishaan', 'Ishaan Verma', 'ishaan.verma@northwind.example', 'INVITED'],
  ['gita', 'Gita Das', 'gita.das@northwind.example', 'DISABLED'],
  ['farhan', 'Farhan Ali', null, 'UNCLAIMED'],
  ['tara', 'Tara Menon', 'tara.menon@northwind.example', 'ACTIVE'],
  ['vikram', 'Vikram Bose', 'vikram.bose@northwind.example', 'ACTIVE'],
  ['priya', 'Priya Nair', 'priya.nair@harbour.example', 'ACTIVE'],
  ['joseph', 'Joseph Thomas', 'joseph.thomas@harbour.example', 'ACTIVE'],
];
const people: Person[] = personRows.map(([key, displayName, email, status]) => ({
  ...versioned(`person:${key}`),
  displayName,
  nameNormalized: displayName.toLowerCase(),
  email,
  status,
}));
const who = (key: string) => fixtureId(k(`person:${key}`));

const membershipRows: [
  string,
  Membership['role'],
  typeof northwind | null,
  string[] | null,
  string | null,
][] = [
  ['meera', 'FIRM_ADMIN', null, null, null],
  ['arjun', 'CONSULTANT', null, null, null],
  ['leela', 'CONSULTANT', null, null, null],
  ['kabir', 'CLIENT_ADMIN', northwind, null, null],
  ['nisha', 'APPROVER', northwind, [pune.id], null],
  ['rohan', 'OWNER', northwind, [pune.id], null],
  ['divya', 'APPROVER', northwind, null, null],
  ['sameer', 'OWNER', northwind, null, null],
  ['ishaan', 'OWNER', northwind, [bengaluru.id], null],
  ['gita', 'OWNER', northwind, [pune.id], null],
  ['farhan', 'OWNER', northwind, [pune.id], null],
  ['tara', 'VIEWER', northwind, null, '2024-06-30T18:30:00Z'],
  ['vikram', 'VIEWER', northwind, null, '2027-03-31T18:30:00Z'],
  ['priya', 'APPROVER', harbour, null, null],
  ['joseph', 'OWNER', harbour, null, null],
];
const consultantClients: Record<string, string[]> = {
  arjun: [northwind.id],
  leela: [harbour.id],
};
const memberships: Membership[] = membershipRows.map(([key, role, client, unitIds, expiresAt]) => ({
  ...versioned(`membership:${key}:${role}`),
  personId: who(key),
  role,
  clientId: client?.id ?? null,
  consultantClientIds: consultantClients[key] ?? null,
  unitIds,
  expiresAt,
}));

// ---------- library ----------

const actRows: [string, string, string | null, string | null][] = [
  ['income-tax', 'Income Tax Act, 1961', 'Income Tax Act', null],
  ['epf', "Employees' Provident Funds and Miscellaneous Provisions Act, 1952", 'EPF Act', null],
  ['factories', 'Factories Act, 1948', null, null],
  [
    'mh-shops',
    'Maharashtra Shops and Establishments (Regulation of Employment and Conditions of Service) Act, 2017',
    'MH Shops Act',
    'MH',
  ],
  ['ka-shops', 'Karnataka Shops and Commercial Establishments Act, 1961', 'KA Shops Act', 'KA'],
  ['tn-shops', 'Tamil Nadu Shops and Establishments Act, 1947', 'TN Shops Act', 'TN'],
  [
    'employment-exchanges',
    'Employment Exchanges (Compulsory Notification of Vacancies) Act, 1959',
    null,
    null,
  ],
];
const acts: Act[] = actRows.map(([key, name, shortName, stateCode]) => ({
  ...versioned(`act:${key}`),
  name,
  shortName,
  jurisdiction: stateCode === null ? 'CENTRAL' : 'STATE',
  stateCode,
  aliases: [],
}));
const categoryRows = [
  ['filings', 'Filings / Returns'],
  ['payments', 'Statutory Payments'],
  ['records', 'Registers and Records'],
  ['licences', 'Licence / Registration'],
  ['reviews', 'Internal Review'],
];
const categories: Category[] = categoryRows.map(([key, name]) => ({
  ...versioned(`category:${key}`),
  name: name!,
  aliases: [],
}));

interface ObligationSpec {
  code: string;
  domain: ObligationDomain;
  act: string;
  category: string;
  title: string;
  criticality: Criticality;
  timeline: TimelineType;
  rule: RecurrenceRule;
  evidenceRequired?: boolean;
  /** Where it applies: [unit, department key, owner, approver]. */
  at: [typeof pune, string, string, string][];
  /** EVENT_DRIVEN only: event dates per unit index. */
  events?: string[];
}

const PUNE = (department: string): [typeof pune, string, string, string] => [
  pune,
  department,
  'rohan',
  'nisha',
];
const BLR = (department: string): [typeof pune, string, string, string] => [
  bengaluru,
  department,
  'sameer',
  'divya',
];

const specs: ObligationSpec[] = [
  {
    code: 'SLC-TAX-001',
    domain: 'TAX',
    act: 'income-tax',
    category: 'payments',
    title: 'Deposit tax deducted at source',
    criticality: 'CRITICAL',
    timeline: 'TIME_BASED',
    rule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
    evidenceRequired: true,
    at: [PUNE('finance')],
  },
  {
    code: 'SLC-EHS-002',
    domain: 'EHS',
    act: 'factories',
    category: 'records',
    title: 'Close the monthly register of adult workers',
    criticality: 'MEDIUM',
    timeline: 'TIME_BASED',
    rule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    at: [PUNE('safety')],
  },
  {
    code: 'SLC-TAX-003',
    domain: 'TAX',
    act: 'income-tax',
    category: 'filings',
    title: 'File the quarterly TDS statement',
    criticality: 'HIGH',
    timeline: 'TIME_BASED',
    rule: { kind: 'QUARTERLY', anchor: 'AFTER_PERIOD_END', days: 31 },
    at: [PUNE('finance')],
  },
  {
    code: 'SLC-HRS-004',
    domain: 'HRS',
    act: 'epf',
    category: 'records',
    title: 'Reconcile provident fund contributions for the quarter',
    criticality: 'HIGH',
    timeline: 'TIME_BASED',
    rule: { kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 0 },
    at: [BLR('hr')],
  },
  {
    code: 'SLC-EHS-005',
    domain: 'EHS',
    act: 'factories',
    category: 'filings',
    title: 'Submit the half-yearly factory return',
    criticality: 'HIGH',
    timeline: 'TIME_BASED',
    rule: { kind: 'HALF_YEARLY', anchor: 'AFTER_PERIOD_END', days: 30 },
    at: [PUNE('safety')],
  },
  {
    code: 'SLC-EHS-006',
    domain: 'EHS',
    act: 'factories',
    category: 'filings',
    title: 'Submit the annual factory return',
    criticality: 'SUPER_CRITICAL',
    timeline: 'TIME_BASED',
    rule: { kind: 'ANNUAL', month: 2, day: 1 },
    at: [PUNE('safety')],
  },
  {
    code: 'SLC-HRS-007',
    domain: 'HRS',
    act: 'mh-shops',
    category: 'licences',
    title: 'Renew the establishment registration',
    criticality: 'CRITICAL',
    timeline: 'TIME_BASED',
    rule: { kind: 'ANNUAL', month: 12, day: 31 },
    at: [PUNE('hr')],
  },
  {
    code: 'SLC-HRS-008',
    domain: 'HRS',
    act: 'employment-exchanges',
    category: 'filings',
    title: 'File the quarterly employment return (ER-I)',
    criticality: 'LOW',
    timeline: 'TIME_BASED',
    rule: {
      kind: 'FIXED_DATES',
      dates: [
        { month: 4, day: 30 },
        { month: 7, day: 30 },
        { month: 10, day: 30 },
        { month: 1, day: 30 },
      ],
    },
    at: [BLR('hr')],
  },
  {
    code: 'SLC-HRS-009',
    domain: 'HRS',
    act: 'ka-shops',
    category: 'filings',
    title: 'Display the half-yearly statement of holidays',
    criticality: 'LOW',
    timeline: 'TIME_BASED',
    rule: {
      kind: 'FIXED_DATES',
      dates: [
        { month: 1, day: 15 },
        { month: 7, day: 15 },
      ],
    },
    at: [BLR('hr')],
  },
  {
    code: 'SLC-EHS-010',
    domain: 'EHS',
    act: 'factories',
    category: 'reviews',
    title: 'Hold the quarterly safety committee meeting',
    criticality: 'HIGH',
    timeline: 'ONGOING',
    rule: { kind: 'ONGOING_REVIEW', every: 'QUARTER' },
    at: [PUNE('safety')],
  },
  {
    code: 'SLC-HRS-011',
    domain: 'HRS',
    act: 'ka-shops',
    category: 'reviews',
    title: 'Review the leave and working hours policy',
    criticality: 'MEDIUM',
    timeline: 'ONGOING',
    rule: { kind: 'ONGOING_REVIEW', every: 'YEAR' },
    at: [BLR('hr')],
  },
  {
    code: 'SLC-EHS-012',
    domain: 'EHS',
    act: 'factories',
    category: 'filings',
    title: 'Report a reportable accident to the inspector',
    criticality: 'SUPER_CRITICAL',
    timeline: 'TIME_BASED',
    rule: { kind: 'EVENT_DRIVEN', trigger: 'Reportable accident', withinDays: 2 },
    at: [PUNE('safety')],
    events: ['2024-02-27', '2024-08-19'],
  },
  {
    code: 'SLC-HRS-013',
    domain: 'HRS',
    act: 'mh-shops',
    category: 'records',
    title: 'Record a newly engaged contractor in the register',
    criticality: 'MEDIUM',
    timeline: 'TIME_BASED',
    rule: { kind: 'EVENT_DRIVEN', trigger: 'Contractor engaged', withinDays: 30 },
    at: [PUNE('hr')],
    events: ['2023-11-02', '2024-10-20'],
  },
  {
    code: 'SLC-HRS-014',
    domain: 'HRS',
    act: 'ka-shops',
    category: 'licences',
    title: 'Register the new office under the Shops Act',
    criticality: 'CRITICAL',
    timeline: 'TIME_BASED',
    rule: { kind: 'ONE_TIME', dueDate: '2023-09-30' },
    at: [BLR('hr')],
  },
  {
    code: 'SLC-HRS-015',
    domain: 'HRS',
    act: 'tn-shops',
    category: 'reviews',
    title: 'Review store opening hours against the Shops Act',
    criticality: 'LOW',
    timeline: 'ONGOING',
    rule: { kind: 'ONGOING_REVIEW', every: 'QUARTER' },
    at: [[chennai, 'operations', 'joseph', 'priya']],
  },
];

// ---------- build ----------

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const at = (date: string, time = '10:00:00') => `${date}T${time}Z`;

export function buildFirmB(): FixtureSet {
  const obligations: Obligation[] = [];
  const assignments: Assignment[] = [];
  const instances: ComplianceInstance[] = [];
  const byKey = new Map<string, ComplianceInstance>();

  for (const spec of specs) {
    const act = acts.find((a) => a.id === fixtureId(k(`act:${spec.act}`)))!;
    const obligation: Obligation = {
      ...versioned(`obligation:${spec.code}`),
      externalRef: spec.code,
      domain: spec.domain,
      jurisdiction: act.jurisdiction,
      stateCode: act.stateCode,
      actId: act.id,
      categoryId: fixtureId(k(`category:${spec.category}`)),
      title: spec.title,
      description: `${spec.title}, as required by the ${act.shortName ?? act.name}.`,
      applicabilityText: null,
      criticality: spec.criticality,
      timelineType: spec.timeline,
      recurrenceRule: spec.rule,
      ruleStatus: 'CONFIRMED',
      evidenceRequired: spec.evidenceRequired ?? false,
      forms: [],
      logSheets: [],
      libraryVersion: 1,
    };
    obligations.push(obligation);

    for (const [unit, department, owner, approver] of spec.at) {
      const assignment: Assignment = {
        ...versioned(`assignment:${spec.code}:${unit.name}`),
        clientId: unit.clientId,
        unitId: unit.id,
        obligationId: obligation.id,
        departmentId: dept(department),
        defaultOwnerId: who(owner),
        defaultApproverId: who(approver),
        applicability: 'APPLICABLE',
        naReason: null,
        activeFrom: '2023-04-01',
        activeTo: null,
      };
      assignments.push(assignment);

      const fyStart = unit === chennai ? { year: 2024, month: 1 } : { year: 2023, month: 4 };
      const periods: Period[] =
        spec.rule.kind === 'EVENT_DRIVEN'
          ? (spec.events ?? []).map((event) => ({
              periodStart: event,
              periodEnd: event,
              dueDate: addDays(event, (spec.rule as { withinDays: number }).withinDays),
            }))
          : [
              ...periodsIn(spec.rule, fyStart.year, fyStart.month),
              ...(unit === chennai ? [] : periodsIn(spec.rule, 2024, 4)),
            ];
      periods.forEach((period, index) => {
        const settled = period.dueDate < SETTLED_BEFORE;
        const late = settled && (index + spec.code.length) % 6 === 0;
        const completedOn = settled ? addDays(period.dueDate, late ? 4 : -2) : null;
        const instance: ComplianceInstance = {
          ...versioned(`instance:${spec.code}:${unit.name}:${period.periodStart}`),
          clientId: unit.clientId,
          unitId: unit.id,
          assignmentId: assignment.id,
          ...period,
          workflowState: settled ? 'APPROVED' : 'OPEN',
          pendingKind: null,
          completedOn,
          naReason: null,
          ownerId: who(owner),
          approverId: who(approver),
          submittedAt: completedOn === null ? null : at(completedOn, '09:00:00'),
          approvedAt: completedOn === null ? null : at(addDays(completedOn, 1)),
          dueDateOverridden: false,
        };
        instances.push(instance);
        byKey.set(`${spec.code}:${period.dueDate}`, instance);
      });
    }
  }

  // Assignments that produce no instances: one not applicable, one still to assess.
  const tdsQuarterly = obligations.find((o) => o.externalRef === 'SLC-TAX-003')!;
  const tdsMonthly = obligations.find((o) => o.externalRef === 'SLC-TAX-001')!;
  assignments.push(
    {
      ...versioned(`assignment:SLC-TAX-003:${bengaluru.name}`),
      clientId: northwind.id,
      unitId: bengaluru.id,
      obligationId: tdsQuarterly.id,
      departmentId: dept('finance'),
      defaultOwnerId: who('sameer'),
      defaultApproverId: who('divya'),
      applicability: 'NOT_APPLICABLE',
      naReason: 'TDS for the office is filed from Pune under one TAN.',
      activeFrom: '2023-04-01',
      activeTo: null,
    },
    {
      ...versioned(`assignment:SLC-TAX-001:${bengaluru.name}`),
      clientId: northwind.id,
      unitId: bengaluru.id,
      obligationId: tdsMonthly.id,
      departmentId: dept('finance'),
      defaultOwnerId: who('ishaan'),
      defaultApproverId: who('divya'),
      applicability: 'TO_ASSESS',
      naReason: null,
      activeFrom: '2024-04-01',
      activeTo: null,
    },
  );

  const comments: Comment[] = [];
  const evidence: Evidence[] = [];
  const auditEvents: AuditEvent[] = [];
  const instance = (code: string, dueDate: string) => {
    const found = byKey.get(`${code}:${dueDate}`);
    if (found === undefined) throw new Error(`No firm B instance ${code} due ${dueDate}`);
    return found;
  };
  const comment = (
    i: ComplianceInstance,
    n: number,
    kind: Comment['kind'],
    authorId: string,
    body: string,
    when: string,
  ) =>
    comments.push({
      ...base(`comment:${i.id}:${n}`),
      createdAt: when,
      updatedAt: when,
      instanceId: i.id,
      clientId: i.clientId,
      authorId,
      kind,
      body,
    });
  const audit = (
    i: ComplianceInstance,
    n: number,
    action: AuditEvent['action'],
    actorId: string,
    when: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    reason: string | null = null,
    entity: { type: AuditEvent['entityType']; id: string } = { type: 'instance', id: i.id },
  ) =>
    auditEvents.push({
      id: fixtureId(k(`audit:${i.id}:${n}`)),
      firmId,
      clientId: i.clientId,
      at: when,
      requestId: `fixture-${i.id.slice(0, 8)}-${n}`,
      actorId,
      actorKind: 'PERSON',
      action,
      entityType: entity.type,
      entityId: entity.id,
      before,
      after,
      reason,
    });
  const addEvidence = (
    i: ComplianceInstance,
    n: number,
    fileName: string,
    scanStatus: ScanStatus,
    when: string,
  ) => {
    const id = fixtureId(k(`evidence:${i.id}:${n}`));
    evidence.push({
      id,
      firmId,
      createdAt: when,
      updatedAt: when,
      archivedAt: null,
      instanceId: i.id,
      clientId: i.clientId,
      fileName,
      mimeType: fileName.endsWith('.pdf') ? 'application/pdf' : 'image/png',
      sizeBytes: 48_000 + n * 1_000,
      sha256: sha256(`${id}:${fileName}`),
      scanStatus,
      uploadedById: i.ownerId,
      storageKey: `${firmId}/${i.clientId}/${i.id}/${id}`,
    });
    // Evidence file names can name people, so the audit trail records only ids.
    audit(i, 100 + n, 'EVIDENCE_ADD', i.ownerId, when, null, { instanceId: i.id }, null, {
      type: 'evidence',
      id,
    });
  };

  // Every approved TDS deposit carries clean evidence, since the obligation requires it.
  for (const i of instances) {
    if (i.assignmentId === assignments[0]!.id && i.workflowState === 'APPROVED') {
      addEvidence(
        i,
        1,
        `tds-challan-${i.periodStart.slice(0, 7)}.pdf`,
        'CLEAN',
        at(i.completedOn!, '08:30:00'),
      );
    }
  }

  // Submitted for completion, evidence still being scanned.
  const submitted = instance('SLC-TAX-001', '2024-11-07');
  Object.assign(submitted, {
    workflowState: 'SUBMITTED',
    pendingKind: 'COMPLETION',
    completedOn: '2024-11-06',
    submittedAt: at('2024-11-06', '11:00:00'),
    version: 2,
  });
  addEvidence(submitted, 1, 'tds-challan-2024-10.pdf', 'PENDING', at('2024-11-06', '10:55:00'));
  comment(
    submitted,
    1,
    'SUBMIT',
    who('rohan'),
    'Challan paid; receipt attached.',
    at('2024-11-06', '11:00:00'),
  );
  audit(
    submitted,
    1,
    'TRANSITION',
    who('rohan'),
    at('2024-11-06', '11:00:00'),
    { workflowState: 'OPEN' },
    { workflowState: 'SUBMITTED', pendingKind: 'COMPLETION', completedOn: '2024-11-06' },
  );

  // Submitted as not applicable, after the due date.
  const naRequest = instance('SLC-HRS-004', '2024-09-30');
  Object.assign(naRequest, {
    workflowState: 'SUBMITTED',
    pendingKind: 'NA',
    completedOn: null,
    naReason: 'No employees were on the provident fund payroll this quarter.',
    submittedAt: at('2024-10-03'),
    approvedAt: null,
    version: 2,
  });
  comment(
    naRequest,
    1,
    'NA_REQUEST',
    who('sameer'),
    'No employees were on the provident fund payroll this quarter.',
    at('2024-10-03'),
  );
  audit(
    naRequest,
    1,
    'TRANSITION',
    who('sameer'),
    at('2024-10-03'),
    { workflowState: 'OPEN' },
    { workflowState: 'SUBMITTED', pendingKind: 'NA' },
  );

  // Sent back with an infected upload.
  const sentBack = instance('SLC-EHS-010', '2024-09-30');
  Object.assign(sentBack, {
    workflowState: 'SENT_BACK',
    completedOn: null,
    submittedAt: null,
    approvedAt: null,
    version: 3,
  });
  addEvidence(sentBack, 1, 'safety-minutes-q2.png', 'INFECTED', at('2024-09-29', '16:00:00'));
  comment(sentBack, 1, 'SUBMIT', who('rohan'), 'Minutes attached.', at('2024-09-29', '16:05:00'));
  comment(
    sentBack,
    2,
    'SEND_BACK',
    who('nisha'),
    'The upload failed the virus scan. Please attach the signed minutes again.',
    at('2024-09-30', '09:30:00'),
  );
  audit(
    sentBack,
    1,
    'TRANSITION',
    who('rohan'),
    at('2024-09-29', '16:05:00'),
    { workflowState: 'OPEN' },
    { workflowState: 'SUBMITTED', pendingKind: 'COMPLETION', completedOn: '2024-09-29' },
  );
  audit(
    sentBack,
    2,
    'TRANSITION',
    who('nisha'),
    at('2024-09-30', '09:30:00'),
    { workflowState: 'SUBMITTED', pendingKind: 'COMPLETION', completedOn: '2024-09-29' },
    { workflowState: 'SENT_BACK', pendingKind: null, completedOn: null },
    'The upload failed the virus scan.',
  );

  // Approved as not applicable.
  const notApplicable = instance('SLC-HRS-009', '2024-07-15');
  Object.assign(notApplicable, {
    workflowState: 'NOT_APPLICABLE',
    completedOn: '2024-07-10',
    naReason: 'The office was closed for renovation for the whole half-year.',
    submittedAt: at('2024-07-10'),
    approvedAt: at('2024-07-11'),
  });
  comment(
    notApplicable,
    1,
    'NA_REQUEST',
    who('sameer'),
    'The office was closed for renovation for the whole half-year.',
    at('2024-07-10'),
  );
  comment(notApplicable, 2, 'APPROVE', who('divya'), 'Agreed.', at('2024-07-11'));

  // Approved, then reopened: open again and now overdue.
  const reopened = instance('SLC-TAX-003', '2024-07-31');
  Object.assign(reopened, {
    workflowState: 'OPEN',
    completedOn: null,
    submittedAt: null,
    approvedAt: null,
    version: 4,
  });
  addEvidence(reopened, 1, 'tds-statement-q1.pdf', 'FAILED', at('2024-07-29', '12:00:00'));
  comment(reopened, 1, 'SUBMIT', who('rohan'), 'Statement filed.', at('2024-07-29', '12:05:00'));
  comment(reopened, 2, 'APPROVE', who('nisha'), 'Approved.', at('2024-07-30'));
  comment(
    reopened,
    3,
    'REOPEN',
    who('arjun'),
    'The acknowledgement shows a short deduction; a correction statement is needed.',
    at('2024-08-20'),
  );
  comment(reopened, 4, 'NOTE', who('rohan'), 'Correction statement in progress.', at('2024-08-22'));
  audit(
    reopened,
    1,
    'TRANSITION',
    who('rohan'),
    at('2024-07-29', '12:05:00'),
    { workflowState: 'OPEN' },
    { workflowState: 'SUBMITTED', pendingKind: 'COMPLETION', completedOn: '2024-07-29' },
  );
  audit(
    reopened,
    2,
    'TRANSITION',
    who('nisha'),
    at('2024-07-30'),
    { workflowState: 'SUBMITTED', pendingKind: 'COMPLETION' },
    { workflowState: 'APPROVED', pendingKind: null },
  );
  audit(
    reopened,
    3,
    'TRANSITION',
    who('arjun'),
    at('2024-08-20'),
    { workflowState: 'APPROVED', completedOn: '2024-07-29' },
    { workflowState: 'OPEN', completedOn: null },
    'The acknowledgement shows a short deduction.',
  );

  // Due date moved by a person.
  const moved = instance('SLC-EHS-005', '2024-10-30');
  Object.assign(moved, { dueDate: '2024-11-29', dueDateOverridden: true, version: 2 });
  audit(
    moved,
    1,
    'DUE_DATE_CHANGE',
    who('arjun'),
    at('2024-10-15'),
    { dueDate: '2024-10-30' },
    { dueDate: '2024-11-29' },
    'Inspector granted an extension by letter.',
  );

  // Reassigned to a person who has not claimed an account.
  const reassigned = instance('SLC-EHS-006', '2025-02-01');
  Object.assign(reassigned, { ownerId: who('farhan'), version: 2 });
  audit(
    reassigned,
    1,
    'REASSIGN',
    who('kabir'),
    at('2024-10-01'),
    { ownerId: who('rohan') },
    { ownerId: who('farhan') },
  );

  return {
    source: 'Synthetic firm B (docs/contracts/fixtures.md §6)',
    firm: {
      ...versioned('firm'),
      id: firmId,
      name: 'Second Ledger Consulting',
      settings: DEFAULT_FIRM_SETTINGS,
      ...DEFAULT_ACCOUNT,
    },
    clients,
    companies,
    locations,
    units,
    departments,
    people,
    memberships,
    acts,
    categories,
    obligations,
    assignments,
    instances,
    evidence,
    comments,
    auditEvents,
  };
}
