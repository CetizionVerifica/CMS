import { describe, expect, it } from 'vitest';
import {
  Act,
  Assignment,
  AuditEvent,
  Category,
  Client,
  Comment,
  Company,
  ComplianceInstance,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_FIRM_SETTINGS,
  Department,
  Evidence,
  EvidenceView,
  Firm,
  InstanceDetail,
  InstanceRow,
  InstanceStatusInput,
  Location,
  MAX_EVIDENCE_BYTES,
  Membership,
  Obligation,
  Person,
  TemplateRef,
  Unit,
} from '../src/index.js';
import {
  base,
  ID,
  instance,
  instanceRow,
  membership,
  obligation,
  person,
  versioned,
  without,
} from './samples.js';

function messages(result: {
  success: boolean;
  error?: { issues: { message: string }[] };
}): string[] {
  return result.error?.issues.map((i) => i.message) ?? [];
}

describe('firm and client', () => {
  it('accept the default settings', () => {
    expect(
      Firm.safeParse({ ...versioned, name: 'Cetizion Verifica', settings: DEFAULT_FIRM_SETTINGS })
        .success,
    ).toBe(true);
    expect(
      Client.safeParse({
        ...versioned,
        name: 'Aditya Birla Group',
        settings: DEFAULT_CLIENT_SETTINGS,
      }).success,
    ).toBe(true);
  });
  it('require a weight for every criticality and MFA for firm roles', () => {
    const weights = without(DEFAULT_FIRM_SETTINGS.criticalityWeights, 'LOW');
    expect(
      Firm.safeParse({
        ...versioned,
        name: 'F',
        settings: { ...DEFAULT_FIRM_SETTINGS, criticalityWeights: weights },
      }).success,
    ).toBe(false);
    expect(
      Firm.safeParse({
        ...versioned,
        name: 'F',
        settings: { ...DEFAULT_FIRM_SETTINGS, mfaRequiredForFirmRoles: false },
      }).success,
    ).toBe(false);
  });
  it('reject weights that are all zero', () => {
    const zero = { SUPER_CRITICAL: 0, CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    const settings = { ...DEFAULT_FIRM_SETTINGS, criticalityWeights: zero };
    expect(Firm.safeParse({ ...versioned, name: 'F', settings }).success).toBe(false);
    const oneWeight = { ...zero, SUPER_CRITICAL: 1 };
    expect(
      Firm.safeParse({
        ...versioned,
        name: 'F',
        settings: { ...settings, criticalityWeights: oneWeight },
      }).success,
    ).toBe(true);
  });
  it('reject a bad FY start month, time zone or digest weekday', () => {
    const bad = [
      { ...DEFAULT_CLIENT_SETTINGS, fyStartMonth: 13 },
      { ...DEFAULT_CLIENT_SETTINGS, timeZone: 'India/Kolkata' },
      {
        ...DEFAULT_CLIENT_SETTINGS,
        reminders: { ...DEFAULT_CLIENT_SETTINGS.reminders, consultantDigestWeekday: 0 },
      },
    ];
    for (const settings of bad)
      expect(Client.safeParse({ ...versioned, name: 'C', settings }).success).toBe(false);
  });
  it('reject unknown keys and a firmId that is not a UUID', () => {
    expect(
      Company.safeParse({ ...versioned, clientId: ID.client, name: 'Hindalco', extra: 1 }).success,
    ).toBe(false);
    expect(
      Company.safeParse({ ...versioned, firmId: 'firm-a', clientId: ID.client, name: 'Hindalco' })
        .success,
    ).toBe(false);
  });
});

describe('entities', () => {
  it('parse company, location, unit and department', () => {
    expect(Company.safeParse({ ...versioned, clientId: ID.client, name: 'Hindalco' }).success).toBe(
      true,
    );
    expect(
      Location.safeParse({
        ...base,
        country: 'India',
        countryCode: 'IN',
        state: 'West Bengal',
        stateCode: 'WB',
        city: 'Belur',
      }).success,
    ).toBe(true);
    expect(
      Unit.safeParse({
        ...versioned,
        clientId: ID.client,
        companyId: ID.company,
        name: 'Plant',
        locationId: ID.location,
      }).success,
    ).toBe(true);
    expect(
      Department.safeParse({
        ...versioned,
        clientId: ID.client,
        name: 'Human Resources',
        aliases: ['HR'],
      }).success,
    ).toBe(true);
  });
  it('reject an empty name', () => {
    expect(
      Department.safeParse({ ...versioned, clientId: ID.client, name: '  ', aliases: [] }).success,
    ).toBe(false);
  });
});

describe('Person', () => {
  it('accepts an unclaimed imported person and an active one', () => {
    expect(Person.safeParse(person).success).toBe(true);
    expect(
      Person.safeParse({ ...person, status: 'ACTIVE', email: 'ravi@example.com' }).success,
    ).toBe(true);
    expect(Person.safeParse({ ...person, status: 'DISABLED' }).success).toBe(true);
  });
  it('requires a lower-case, collapsed nameNormalized', () => {
    expect(messages(Person.safeParse({ ...person, nameNormalized: 'Ravi Kumar' }))).toContain(
      'Must be lower-case with whitespace collapsed',
    );
    expect(Person.safeParse({ ...person, nameNormalized: 'ravi  kumar' }).success).toBe(false);
    expect(Person.safeParse({ ...person, nameNormalized: 'ravi\tkumar' }).success).toBe(false);
    expect(Person.safeParse({ ...person, nameNormalized: 'ravi\nkumar' }).success).toBe(false);
  });
  it('ties email to status', () => {
    expect(Person.safeParse({ ...person, email: 'ravi@example.com' }).success).toBe(false);
    expect(Person.safeParse({ ...person, status: 'INVITED' }).success).toBe(false);
    expect(Person.safeParse({ ...person, status: 'ACTIVE', email: 'not-an-email' }).success).toBe(
      false,
    );
  });
});

describe('Membership', () => {
  it('accepts each role in its valid shape', () => {
    const valid = [
      membership,
      { ...membership, unitIds: null },
      { ...membership, role: 'APPROVER' },
      { ...membership, role: 'CLIENT_ADMIN', unitIds: null },
      { ...membership, role: 'VIEWER', unitIds: null, expiresAt: '2026-12-31T00:00:00Z' },
      { ...membership, role: 'FIRM_ADMIN', clientId: null, unitIds: null },
      {
        ...membership,
        role: 'CONSULTANT',
        clientId: null,
        unitIds: null,
        consultantClientIds: [ID.client],
      },
    ];
    for (const m of valid) expect(Membership.safeParse(m).success, m.role).toBe(true);
  });
  it.each([
    ['firm role with a client', { role: 'FIRM_ADMIN', unitIds: null }],
    ['client role without a client', { clientId: null }],
    ['consultant without client list', { role: 'CONSULTANT', clientId: null, unitIds: null }],
    ['client list on a non-consultant', { consultantClientIds: [ID.client] }],
    ['unit scope on a client admin', { role: 'CLIENT_ADMIN' }],
    ['viewer without expiry', { role: 'VIEWER', unitIds: null }],
    ['empty unit scope', { unitIds: [] }],
  ])('rejects %s', (_name, override) => {
    expect(Membership.safeParse({ ...membership, ...override }).success).toBe(false);
  });
});

describe('library', () => {
  it('parses an Act and enforces jurisdiction and state code together', () => {
    const act = {
      ...versioned,
      name: 'West Bengal Shops and Establishments Act, 1963',
      shortName: null,
      jurisdiction: 'STATE',
      stateCode: 'WB',
      aliases: [],
    };
    expect(Act.safeParse(act).success).toBe(true);
    expect(Act.safeParse({ ...act, stateCode: null }).success).toBe(false);
    expect(Act.safeParse({ ...act, jurisdiction: 'CENTRAL' }).success).toBe(false);
    expect(
      Category.safeParse({ ...versioned, name: 'Payment', aliases: ['Payments'] }).success,
    ).toBe(true);
  });
  it('parses an obligation', () => {
    expect(Obligation.safeParse(obligation).success).toBe(true);
    expect(
      Obligation.safeParse({ ...obligation, externalRef: null, domain: 'OTHER' }).success,
    ).toBe(true);
  });
  it('rejects an obligation with a state code under CENTRAL or a bad rule', () => {
    expect(Obligation.safeParse({ ...obligation, stateCode: 'WB' }).success).toBe(false);
    expect(
      Obligation.safeParse({ ...obligation, recurrenceRule: { kind: 'WEEKLY' } }).success,
    ).toBe(false);
    expect(Obligation.safeParse({ ...obligation, criticality: 'High' }).success).toBe(false);
  });
  it('allows a template file only with a file name', () => {
    expect(
      TemplateRef.safeParse({ label: 'Form A', fileName: null, templateFileId: null }).success,
    ).toBe(true);
    expect(
      TemplateRef.safeParse({ label: 'Form A', fileName: 'a.pdf', templateFileId: ID.v5 }).success,
    ).toBe(true);
    expect(
      TemplateRef.safeParse({ label: 'Form A', fileName: null, templateFileId: ID.v5 }).success,
    ).toBe(false);
  });
});

describe('Assignment', () => {
  const assignment = {
    ...versioned,
    clientId: ID.client,
    unitId: ID.unit,
    obligationId: ID.obligation,
    departmentId: ID.department,
    defaultOwnerId: ID.owner,
    defaultApproverId: ID.approver,
    applicability: 'APPLICABLE',
    naReason: null,
    activeFrom: '2022-04-01',
    activeTo: null,
  };
  it('accepts an open-ended and a bounded assignment', () => {
    expect(Assignment.safeParse(assignment).success).toBe(true);
    expect(Assignment.safeParse({ ...assignment, activeTo: '2022-04-01' }).success).toBe(true);
  });
  it('needs a reason for NOT_APPLICABLE and a sane active range', () => {
    expect(Assignment.safeParse({ ...assignment, applicability: 'NOT_APPLICABLE' }).success).toBe(
      false,
    );
    expect(
      Assignment.safeParse({
        ...assignment,
        applicability: 'NOT_APPLICABLE',
        naReason: 'No boilers on site',
      }).success,
    ).toBe(true);
    expect(Assignment.safeParse({ ...assignment, activeTo: '2022-03-31' }).success).toBe(false);
  });
});

describe('ComplianceInstance', () => {
  it.each([
    ['open', {}],
    ['sent back', { workflowState: 'SENT_BACK' }],
    [
      'submitted for completion',
      { workflowState: 'SUBMITTED', pendingKind: 'COMPLETION', completedOn: '2022-05-06' },
    ],
    ['submitted as NA', { workflowState: 'SUBMITTED', pendingKind: 'NA', naReason: 'Plant shut' }],
    ['approved late', { workflowState: 'APPROVED', completedOn: '2022-05-09' }],
    [
      'not applicable',
      { workflowState: 'NOT_APPLICABLE', completedOn: '2022-05-01', naReason: 'Plant shut' },
    ],
    ['single-day period', { periodEnd: '2022-04-01' }],
  ])('accepts %s', (_name, override) => {
    expect(ComplianceInstance.safeParse({ ...instance, ...override }).success).toBe(true);
  });
  it.each([
    ['period ending before it starts', { periodEnd: '2022-03-31' }],
    ['submitted without pendingKind', { workflowState: 'SUBMITTED', completedOn: '2022-05-06' }],
    ['pendingKind while open', { pendingKind: 'COMPLETION' }],
    [
      'submitted completion without a date',
      { workflowState: 'SUBMITTED', pendingKind: 'COMPLETION' },
    ],
    ['approved without completedOn', { workflowState: 'APPROVED' }],
    ['NA request without reason', { workflowState: 'SUBMITTED', pendingKind: 'NA' }],
    [
      'not applicable without reason',
      { workflowState: 'NOT_APPLICABLE', completedOn: '2022-05-01' },
    ],
    ['due date that is not a date', { dueDate: '2022-02-30' }],
    ['due date with a time', { dueDate: '2022-05-07T00:00:00Z' }],
  ])('rejects %s', (_name, override) => {
    expect(ComplianceInstance.safeParse({ ...instance, ...override }).success).toBe(false);
  });
  it('exposes the status input the engine reads', () => {
    expect(
      InstanceStatusInput.safeParse({
        workflowState: 'OPEN',
        pendingKind: null,
        dueDate: '2023-03-31',
        completedOn: null,
      }).success,
    ).toBe(true);
  });
});

describe('register rows', () => {
  it('parse a row and a detail', () => {
    expect(InstanceRow.safeParse(instanceRow).success).toBe(true);
    const detail = {
      ...instanceRow,
      description: 'Deposit TDS.',
      applicabilityText: null,
      naReason: null,
      forms: [{ label: 'Challan 281', fileName: null, templateFileId: null }],
      logSheets: [],
      evidenceRequired: true,
      allowedActions: ['COMMENT', 'REOPEN'],
    };
    expect(InstanceDetail.safeParse(detail).success).toBe(true);
    expect(InstanceDetail.safeParse({ ...detail, allowedActions: ['DELETE'] }).success).toBe(false);
  });
  it('tie overdueDays to the OVERDUE status', () => {
    expect(
      InstanceRow.safeParse({ ...instanceRow, status: 'OVERDUE', overdueDays: 3 }).success,
    ).toBe(true);
    expect(
      InstanceRow.safeParse({ ...instanceRow, status: 'OVERDUE', overdueDays: null }).success,
    ).toBe(false);
    expect(
      InstanceRow.safeParse({ ...instanceRow, status: 'COMPLIED', overdueDays: 3 }).success,
    ).toBe(false);
  });
  it('reject zero overdue days and unknown statuses', () => {
    expect(
      InstanceRow.safeParse({ ...instanceRow, status: 'OVERDUE', overdueDays: 0 }).success,
    ).toBe(false);
    expect(InstanceRow.safeParse({ ...instanceRow, status: 'LATE' }).success).toBe(false);
  });
});

describe('evidence, comments and audit', () => {
  const evidence = {
    ...base,
    instanceId: ID.instance,
    clientId: ID.client,
    fileName: 'challan.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    sha256: 'b'.repeat(64),
    storageKey: 'firm/client/evidence/abc',
    scanStatus: 'PENDING',
    uploadedById: ID.owner,
  };
  it('keeps storageKey out of the view', () => {
    expect(Evidence.safeParse(evidence).success).toBe(true);
    expect(EvidenceView.safeParse(evidence).success).toBe(false);
    const view = without(evidence, 'storageKey');
    expect(EvidenceView.safeParse(view).success).toBe(true);
  });
  it('caps evidence at 25 MB', () => {
    expect(Evidence.safeParse({ ...evidence, sizeBytes: MAX_EVIDENCE_BYTES }).success).toBe(true);
    expect(Evidence.safeParse({ ...evidence, sizeBytes: MAX_EVIDENCE_BYTES + 1 }).success).toBe(
      false,
    );
    expect(Evidence.safeParse({ ...evidence, sizeBytes: 0 }).success).toBe(false);
  });
  it('parses import comments with no author', () => {
    expect(
      Comment.safeParse({
        ...base,
        instanceId: ID.instance,
        clientId: ID.client,
        authorId: null,
        kind: 'IMPORT',
        body: 'Imported.',
      }).success,
    ).toBe(true);
  });
  const audit = {
    id: ID.v5,
    firmId: ID.firm,
    clientId: ID.client,
    at: '2026-10-11T09:17:43Z',
    requestId: 'req-1',
    actorId: ID.owner,
    actorKind: 'PERSON',
    action: 'TRANSITION',
    entityType: 'instance',
    entityId: ID.instance,
    before: { workflowState: 'OPEN' },
    after: { workflowState: 'SUBMITTED' },
    reason: null,
  };
  it('parses an audit event and has no version or archive fields', () => {
    expect(AuditEvent.safeParse(audit).success).toBe(true);
    expect(AuditEvent.safeParse({ ...audit, version: 1 }).success).toBe(false);
    expect(AuditEvent.safeParse({ ...audit, archivedAt: null }).success).toBe(false);
  });
  it('needs an actor for PERSON events but not for SYSTEM or IMPORT', () => {
    expect(AuditEvent.safeParse({ ...audit, actorId: null }).success).toBe(false);
    expect(
      AuditEvent.safeParse({ ...audit, actorId: null, actorKind: 'IMPORT', action: 'IMPORT' })
        .success,
    ).toBe(true);
  });
});
