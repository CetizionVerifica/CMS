// Register rows for tests: valid contract InstanceRows with pseudonymous names (fixtures.md §5).
import type { InstanceRow } from '@canopy/contracts';

export const CLIENT_ID = '00000000-0000-5000-8000-000000000101';
export const PERSON_ID = '00000000-0000-5000-8000-000000000201';

const uid = (n: number) => `00000000-0000-5000-8000-${n.toString(16).padStart(12, '0')}`;

const CRITICALITY = ['SUPER_CRITICAL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const DEPARTMENTS = ['HR', 'EHS', 'Finance', 'Legal'];

export function makeRow(i: number, overrides: Partial<InstanceRow> = {}): InstanceRow {
  const day = String((i % 28) + 1).padStart(2, '0');
  return {
    id: uid(0x100000 + i),
    version: 1,
    obligationId: uid(0x200000 + i),
    externalRef: `TAX-CL-${String(i).padStart(4, '0')}`,
    title: `Obligation ${i}`,
    timelineType: 'TIME_BASED',
    categoryName: 'Tax',
    actId: uid(0x300000 + (i % 5)),
    actName: `Act ${i % 5}`,
    criticality: CRITICALITY[i % CRITICALITY.length]!,
    clientId: CLIENT_ID,
    companyName: 'Demo Metals Ltd',
    unitId: uid(0x400001),
    unitName: 'Plant 01',
    locationLabel: 'India / West Bengal / Plant 01',
    departmentId: uid(0x500000 + (i % DEPARTMENTS.length)),
    departmentName: DEPARTMENTS[i % DEPARTMENTS.length]!,
    ownerId: uid(0x600001),
    ownerName: 'Owner 01',
    approverId: uid(0x600002),
    approverName: 'Approver 01',
    periodStart: '2023-03-01' as InstanceRow['periodStart'],
    periodEnd: '2023-03-31' as InstanceRow['periodEnd'],
    dueDate: `2023-03-${day}` as InstanceRow['dueDate'],
    completedOn: null,
    workflowState: 'OPEN',
    pendingKind: null,
    status: 'UPCOMING',
    overdueDays: null,
    evidenceCount: 0,
    commentCount: 0,
    lastComment: null,
    formLabels: [],
    logSheetLabels: [],
    ...overrides,
  };
}

export function makeRows(count: number): InstanceRow[] {
  return Array.from({ length: count }, (_, i) => makeRow(i));
}
