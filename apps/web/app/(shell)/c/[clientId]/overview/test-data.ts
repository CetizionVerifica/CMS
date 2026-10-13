// Builders for the overview's unit tests: contract-shaped API responses with only the fields a test cares about set.
import {
  DerivedStatus,
  LocalDate,
  type Breakdown,
  type BreakdownBy,
  type ClientOverview,
  type InstanceRow,
  type ScoreResult,
} from '@canopy/contracts';

export const CLIENT = '00000000-0000-5000-8000-000000000101';
export const id = (n: number) => `00000000-0000-5000-8000-${n.toString(16).padStart(12, '0')}`;

let next = 0x5000;

export function result(
  counts: Partial<Record<DerivedStatus, number>> = {},
  score: number | null = null,
  onTimeRate: number | null = null,
): ScoreResult {
  const full = Object.fromEntries(
    DerivedStatus.options.map((s) => [s, counts[s] ?? 0]),
  ) as ScoreResult['counts'];
  const instanceIds = Object.fromEntries(
    DerivedStatus.options.map((s) => [s, Array.from({ length: full[s] }, () => id(next++))]),
  ) as ScoreResult['instanceIds'];
  return {
    engineVersion: 'test',
    asOf: LocalDate.parse('2023-03-15'),
    score,
    onTimeRate,
    counts: full,
    instanceIds,
  };
}

export function breakdown(
  by: BreakdownBy,
  rows: { key: string; label: string; result: ScoreResult }[],
): Breakdown {
  return { by, rows };
}

export function instance(n: number, overrides: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: id(0x7000 + n),
    version: 1,
    obligationId: id(0x8000 + n),
    externalRef: `HR-${n}`,
    title: `Obligation ${n}`,
    timelineType: 'TIME_BASED',
    categoryName: 'Labour',
    actId: id(0x9000),
    actName: 'Factories Act, 1948',
    criticality: 'HIGH',
    clientId: CLIENT,
    companyName: 'Demo Metals',
    unitId: id(0xa000),
    unitName: 'Plant 1',
    locationLabel: 'India / West Bengal / Belur',
    departmentId: id(0xb000),
    departmentName: 'EHS',
    ownerId: id(0xc000),
    ownerName: 'Owner 01',
    approverId: id(0xd000),
    approverName: 'Approver 01',
    periodStart: LocalDate.parse('2023-03-01'),
    periodEnd: LocalDate.parse('2023-03-31'),
    dueDate: LocalDate.parse('2023-03-20'),
    completedOn: null,
    workflowState: 'OPEN',
    pendingKind: null,
    status: 'DUE_SOON',
    overdueDays: null,
    evidenceCount: 0,
    commentCount: 0,
    lastComment: null,
    formLabels: [],
    logSheetLabels: [],
    ...overrides,
  };
}

export function overview(
  r: ScoreResult,
  upcoming: InstanceRow[] = [],
  myTasks: InstanceRow[] = [],
): ClientOverview {
  return { result: r, upcoming, myTasks };
}
