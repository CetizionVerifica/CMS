import {
  DerivedStatus,
  type Breakdown,
  type BreakdownBy,
  type FirmSettings,
  type Id,
  type LocalDate,
  type ScoreInput,
  type ScoreResult,
} from '@canopy/contracts';
import { compareDates } from './dates.js';
import { deriveStatus } from './status.js';
import { ENGINE_VERSION } from './version.js';

/**
 * Compliance score, on-time rate and status counts (packages/engine/CLAUDE.md "Scores and KPIs").
 *
 * Counts cover every item passed in (the caller passes the selected period's instances). The score and on-time rate
 * use only items due on or before `asOf`, excluding NOT_APPLICABLE:
 *   score = (Σ weight on time + 0.5 × Σ weight late) / Σ weight due, as a percentage with one decimal.
 * An empty denominator gives null ("No items due"), never 0 or 100.
 */

/** Percentage rounded half up to one decimal; the epsilon absorbs float noise such as 51.249999…. */
function percent(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 1000 + 1e-9) / 10;
}

function emptyRecord<T>(make: () => T): Record<DerivedStatus, T> {
  return Object.fromEntries(DerivedStatus.options.map((s) => [s, make()])) as Record<
    DerivedStatus,
    T
  >;
}

export function computeScore(
  items: readonly ScoreInput[],
  asOf: LocalDate,
  s: FirmSettings,
): ScoreResult {
  const instanceIds = emptyRecord<Id[]>(() => []);
  let weightDue = 0;
  let weightEarned = 0;
  let dueCount = 0;
  let onTimeCount = 0;
  for (const item of items) {
    const { status } = deriveStatus(item, asOf, s);
    instanceIds[status].push(item.instanceId);
    if (status === 'NOT_APPLICABLE' || compareDates(item.dueDate, asOf) > 0) continue;
    const weight = s.criticalityWeights[item.criticality];
    dueCount += 1;
    weightDue += weight;
    if (status === 'COMPLIED') {
      onTimeCount += 1;
      weightEarned += weight;
    } else if (status === 'COMPLIED_LATE') {
      weightEarned += 0.5 * weight;
    }
  }
  const counts = emptyRecord(() => 0);
  for (const status of DerivedStatus.options) counts[status] = instanceIds[status].length;
  return {
    engineVersion: ENGINE_VERSION,
    asOf,
    score: weightDue > 0 ? percent(weightEarned, weightDue) : null,
    onTimeRate: dueCount > 0 ? percent(onTimeCount, dueCount) : null,
    counts,
    instanceIds,
  };
}

export interface BreakdownItem {
  /** Group key, e.g. a department id or a criticality. */
  key: string;
  /** Display label of the group, e.g. the department name. */
  label: string;
  item: ScoreInput;
}

/** One ScoreResult per group, from the same computeScore, so breakdown numbers equal register filters. */
export function computeBreakdown(
  by: BreakdownBy,
  items: readonly BreakdownItem[],
  asOf: LocalDate,
  s: FirmSettings,
): Breakdown {
  const groups = new Map<string, { label: string; items: ScoreInput[] }>();
  for (const { key, label, item } of items) {
    const group = groups.get(key) ?? { label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const rows = [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label: group.label,
      result: computeScore(group.items, asOf, s),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en') || a.key.localeCompare(b.key, 'en'));
  return { by, rows };
}

export interface Kpi {
  count: number;
  instanceIds: Id[];
}

export interface Kpis {
  /** Not yet done: UPCOMING, DUE_SOON and OVERDUE. */
  open: Kpi;
  overdue: Kpi;
  /** Due within `dueSoonDays` (default 7, "due this week"). */
  dueSoon: Kpi;
  awaitingApproval: Kpi;
}

/** Dashboard KPI tiles from a ScoreResult, each with the ids behind it. */
export function summarizeKpis(result: ScoreResult): Kpis {
  const kpi = (...statuses: DerivedStatus[]): Kpi => {
    const instanceIds = statuses.flatMap((status) => result.instanceIds[status]);
    return { count: instanceIds.length, instanceIds };
  };
  return {
    open: kpi('UPCOMING', 'DUE_SOON', 'OVERDUE'),
    overdue: kpi('OVERDUE'),
    dueSoon: kpi('DUE_SOON'),
    awaitingApproval: kpi('SUBMITTED'),
  };
}
