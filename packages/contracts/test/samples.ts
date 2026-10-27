// Valid sample entities for tests. Each test overrides one field to prove one rule.
export const ID = {
  firm: '0192f0c8-1a2b-7c3d-8e4f-000000000001',
  client: '0192f0c8-1a2b-7c3d-8e4f-000000000002',
  company: '0192f0c8-1a2b-7c3d-8e4f-000000000003',
  unit: '0192f0c8-1a2b-7c3d-8e4f-000000000004',
  location: '0192f0c8-1a2b-7c3d-8e4f-000000000005',
  department: '0192f0c8-1a2b-7c3d-8e4f-000000000006',
  owner: '0192f0c8-1a2b-7c3d-8e4f-000000000007',
  approver: '0192f0c8-1a2b-7c3d-8e4f-000000000008',
  act: '0192f0c8-1a2b-7c3d-8e4f-000000000009',
  category: '0192f0c8-1a2b-7c3d-8e4f-00000000000a',
  obligation: '0192f0c8-1a2b-7c3d-8e4f-00000000000b',
  assignment: '0192f0c8-1a2b-7c3d-8e4f-00000000000c',
  instance: '0192f0c8-1a2b-7c3d-8e4f-00000000000d',
  // Fixture ids are UUIDv5 (fixtures.md).
  v5: '6ba7b810-9dad-51d1-80b4-00c04fd430c8',
};

export const base = {
  id: ID.firm,
  firmId: ID.firm,
  createdAt: '2026-10-11T09:17:43Z',
  updatedAt: '2026-10-11T09:17:43.123Z',
  archivedAt: null,
};

export const versioned = { ...base, version: 1 };

export const person = {
  ...versioned,
  id: ID.owner,
  displayName: 'Ravi Kumar',
  nameNormalized: 'ravi kumar',
  email: null,
  status: 'UNCLAIMED',
};

export const obligation = {
  ...versioned,
  id: ID.obligation,
  externalRef: 'TAX-CL-033-6067-60218',
  domain: 'TAX',
  jurisdiction: 'CENTRAL',
  stateCode: null,
  actId: ID.act,
  categoryId: ID.category,
  title: 'Deposit TDS',
  description: 'Deposit tax deducted at source\nby the 7th of the following month.',
  applicabilityText: null,
  criticality: 'SUPER_CRITICAL',
  timelineType: 'TIME_BASED',
  recurrenceRule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
  ruleStatus: 'CONFIRMED',
  evidenceRequired: false,
  forms: [{ label: 'Challan 281', fileName: 'challan-281.pdf', templateFileId: null }],
  logSheets: [],
  clauseRefs: [],
  libraryVersion: 1,
};

export const instance = {
  ...versioned,
  id: ID.instance,
  clientId: ID.client,
  unitId: ID.unit,
  assignmentId: ID.assignment,
  periodStart: '2022-04-01',
  periodEnd: '2022-04-30',
  dueDate: '2022-05-07',
  workflowState: 'OPEN',
  pendingKind: null,
  completedOn: null,
  naReason: null,
  ownerId: ID.owner,
  approverId: ID.approver,
  submittedAt: null,
  approvedAt: null,
  dueDateOverridden: false,
};

export const instanceRow = {
  id: ID.instance,
  version: 1,
  obligationId: ID.obligation,
  externalRef: 'TAX-CL-033-6067-60218',
  title: 'Deposit TDS',
  timelineType: 'TIME_BASED',
  categoryName: 'Payment',
  actId: ID.act,
  actName: 'Income Tax Act, 1961',
  criticality: 'SUPER_CRITICAL',
  clientId: ID.client,
  companyName: 'Kestrel Aluminium',
  unitId: ID.unit,
  unitName: 'Plant',
  locationLabel: 'India / West Bengal / Kestrelganj',
  departmentId: ID.department,
  departmentName: 'Finance',
  ownerId: ID.owner,
  ownerName: 'Ravi Kumar',
  approverId: ID.approver,
  approverName: 'Anita Rao',
  periodStart: '2022-04-01',
  periodEnd: '2022-04-30',
  dueDate: '2022-05-07',
  completedOn: '2022-05-06',
  workflowState: 'APPROVED',
  pendingKind: null,
  status: 'COMPLIED',
  overdueDays: null,
  evidenceCount: 1,
  commentCount: 2,
  lastComment: 'Paid.',
  formLabels: ['Challan 281'],
  logSheetLabels: [],
};

export const membership = {
  ...versioned,
  personId: ID.owner,
  role: 'OWNER',
  clientId: ID.client,
  consultantClientIds: null,
  unitIds: [ID.unit],
  expiresAt: null,
};

/** A copy of `obj` without `key`. */
export function without<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}
