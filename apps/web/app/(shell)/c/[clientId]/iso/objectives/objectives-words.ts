// Objectives in words for the client views (model §3.6): where one stands, its latest reading and its reading rule.
// Kept apart from objectives-model.ts because it formats dates with the design system, which only client code loads.
import type { IsoStandard, ObjectiveView, RecurrenceRule } from '@canopy/contracts';
import { formatDate } from '@canopy/ui';

import { nameOf, type PersonOption } from '../_lib/people';
import { standardTitleByCode, word } from '../_lib/words';

/** "380 kWh per tonne". */
export function amount(value: number, unit: string): string {
  return `${value} ${unit}`;
}

/** Where an objective stands, in words: its outcome once closed, else whether its latest reading is on track. */
export function standing(o: ObjectiveView): {
  text: string;
  tone: 'ok' | 'warn' | 'crit' | 'neutral';
} {
  if (o.closedOn !== null && o.outcome) {
    return {
      text: word('ObjectiveOutcome', o.outcome),
      tone: o.outcome === 'ACHIEVED' ? 'ok' : 'crit',
    };
  }
  if (o.progress.onTrack === null) return { text: 'No reading yet', tone: 'neutral' };
  return o.progress.onTrack
    ? { text: 'On track', tone: 'ok' }
    : { text: 'Off track', tone: 'warn' };
}

/** "Latest 405 kWh per tonne (to 30 Sep 2024), 37% of the way". */
export function progressText(o: ObjectiveView): string {
  const p = o.progress;
  if (p.latestValue === null) return 'No reading yet';
  const at = p.latestPeriodEnd ? ` (to ${formatDate(p.latestPeriodEnd)})` : '';
  const pct = p.progressPercent === null ? '' : `, ${Math.round(p.progressPercent)}% of the way`;
  return `Latest ${amount(p.latestValue, o.unitOfMeasure)}${at}${pct}`;
}

export type ObjectiveRow = {
  id: string;
  title: string;
  sub: string;
  target: string;
  progress: string;
  ownerName: string;
  objective: ObjectiveView;
};

export function objectiveRows(
  objectives: readonly ObjectiveView[],
  standards: readonly IsoStandard[],
  people: readonly PersonOption[],
): ObjectiveRow[] {
  return objectives.map((o) => ({
    id: o.id,
    title: o.text,
    sub: o.standards.map((c) => standardTitleByCode(standards, c)).join(', '),
    target: `${word('ObjectiveDirection', o.direction)} to ${amount(o.target, o.unitOfMeasure)} by ${formatDate(o.dueOn)}`,
    progress: progressText(o),
    ownerName: nameOf(people, o.ownerId),
    objective: o,
  }));
}

/** A reading rule in words. */
export function readingRuleText(rule: RecurrenceRule): string {
  switch (rule.kind) {
    case 'MONTHLY':
      return 'Every month';
    case 'QUARTERLY':
      return 'Every quarter';
    case 'HALF_YEARLY':
      return 'Every half year';
    case 'ANNUAL':
      return 'Every year';
    case 'ONGOING_REVIEW':
      return `Every ${rule.every.toLowerCase().replace('_', ' ')}`;
    case 'FIXED_DATES':
      return `On ${rule.dates.length} set ${rule.dates.length === 1 ? 'date' : 'dates'} a year`;
    case 'ONE_TIME':
      return `Once, by ${formatDate(rule.dueDate)}`;
    case 'EVENT_DRIVEN':
      return `Within ${rule.withinDays} days of ${rule.trigger}`;
  }
}
