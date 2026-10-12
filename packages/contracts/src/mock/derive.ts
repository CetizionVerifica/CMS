// Status and score rules for test doubles: the mock server and the generator of firm-a.expected.json.
// They follow packages/engine/CLAUDE.md so golden numbers do not come from the engine they test.
// Product code never imports this; it calls the engine.
import { DEFAULT_FIRM_SETTINGS } from '../defaults.js';
import { type Criticality, DerivedStatus, type WorkflowState } from '../enums.js';

export interface ScoredInstance {
  id: string;
  dueDate: string;
  workflowState: WorkflowState;
  completedOn: string | null;
  criticality: Criticality;
}

export interface MockScore {
  asOf: string;
  counts: Record<DerivedStatus, number>;
  due: number;
  weightedNumerator: number;
  weightedDenominator: number;
  score: number | null;
  onTimeRate: number | null;
}

const DAY = 86_400_000;

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

export function deriveStatus(
  i: Omit<ScoredInstance, 'id' | 'criticality'>,
  asOf: string,
  dueSoonDays: number = DEFAULT_FIRM_SETTINGS.dueSoonDays,
): DerivedStatus {
  switch (i.workflowState) {
    case 'APPROVED':
      return i.completedOn! <= i.dueDate ? 'COMPLIED' : 'COMPLIED_LATE';
    case 'NOT_APPLICABLE':
      return 'NOT_APPLICABLE';
    case 'SUBMITTED':
      return 'SUBMITTED';
    default:
      if (asOf > i.dueDate) return 'OVERDUE';
      return daysBetween(asOf, i.dueDate) <= dueSoonDays ? 'DUE_SOON' : 'UPCOMING';
  }
}

const percent = (num: number, den: number) =>
  den === 0 ? null : Math.round((num / den) * 1000) / 10;

export function emptyByStatus<T>(make: () => T): Record<DerivedStatus, T> {
  return Object.fromEntries(DerivedStatus.options.map((s) => [s, make()])) as Record<
    DerivedStatus,
    T
  >;
}

export function statusIds(
  instances: ScoredInstance[],
  asOf: string,
  dueSoonDays?: number,
): Record<DerivedStatus, string[]> {
  const ids = emptyByStatus<string[]>(() => []);
  for (const i of instances) ids[deriveStatus(i, asOf, dueSoonDays)].push(i.id);
  return ids;
}

export function score(
  instances: ScoredInstance[],
  asOf: string,
  settings: {
    criticalityWeights: Record<Criticality, number>;
    dueSoonDays: number;
  } = DEFAULT_FIRM_SETTINGS,
): MockScore {
  const counts = emptyByStatus(() => 0);
  let due = 0;
  let onTime = 0;
  let num = 0;
  let den = 0;
  for (const i of instances) {
    const status = deriveStatus(i, asOf, settings.dueSoonDays);
    counts[status] += 1;
    if (status === 'NOT_APPLICABLE' || i.dueDate > asOf) continue;
    const weight = settings.criticalityWeights[i.criticality];
    due += 1;
    den += weight;
    if (status === 'COMPLIED') {
      onTime += 1;
      num += weight;
    } else if (status === 'COMPLIED_LATE') {
      num += weight / 2;
    }
  }
  return {
    asOf,
    counts,
    due,
    weightedNumerator: num,
    weightedDenominator: den,
    score: percent(num, den),
    onTimeRate: percent(onTime, due),
  };
}
