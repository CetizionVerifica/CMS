// Independent oracle for the expected counts and scores in firm-a.expected.json. It follows the rules in
// packages/engine/CLAUDE.md so the golden numbers do not come from the engine they test. Product code never
// imports this; it calls the engine.
import type { ComplianceInstance, Criticality, DerivedStatus, ExpectedScore } from './types.js';
import { DEFAULT_FIRM_SETTINGS, DerivedStatus as DerivedStatusEnum } from '../../src/index.js';

export type ScoredInstance = Pick<
  ComplianceInstance,
  'id' | 'dueDate' | 'workflowState' | 'completedOn'
> & { criticality: Criticality };

const DAY = 86_400_000;
const days = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY;

export function deriveStatus(i: ScoredInstance, asOf: string): DerivedStatus {
  switch (i.workflowState) {
    case 'APPROVED':
      return i.completedOn! <= i.dueDate ? 'COMPLIED' : 'COMPLIED_LATE';
    case 'NOT_APPLICABLE':
      return 'NOT_APPLICABLE';
    case 'SUBMITTED':
      return 'SUBMITTED';
    default:
      if (asOf > i.dueDate) return 'OVERDUE';
      return days(i.dueDate) - days(asOf) <= DEFAULT_FIRM_SETTINGS.dueSoonDays
        ? 'DUE_SOON'
        : 'UPCOMING';
  }
}

const percent = (num: number, den: number) =>
  den === 0 ? null : Math.round((num / den) * 1000) / 10;

export function emptyByStatus<T>(make: () => T): Record<DerivedStatus, T> {
  return Object.fromEntries(DerivedStatusEnum.options.map((s) => [s, make()])) as Record<
    DerivedStatus,
    T
  >;
}

export function statusIds(
  instances: ScoredInstance[],
  asOf: string,
): Record<DerivedStatus, string[]> {
  const ids = emptyByStatus<string[]>(() => []);
  for (const i of instances) ids[deriveStatus(i, asOf)].push(i.id);
  return ids;
}

export function score(instances: ScoredInstance[], asOf: string): ExpectedScore {
  const weights = DEFAULT_FIRM_SETTINGS.criticalityWeights;
  const counts = emptyByStatus(() => 0);
  let due = 0;
  let onTime = 0;
  let num = 0;
  let den = 0;
  for (const i of instances) {
    const status = deriveStatus(i, asOf);
    counts[status] += 1;
    if (status === 'NOT_APPLICABLE' || i.dueDate > asOf) continue;
    const weight = weights[i.criticality];
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
