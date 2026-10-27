// Management reviews' URL state, API query, rows and words (packages.md ISO-6c, model §3.13, §4.5). The filters are the
// API's own query names; nothing here filters the rows. Every figure key `reviewInputFigures` emits is worded here
// from `REVIEW_FIGURE_KEYS`, and a figure's value is always the API's: only the ids behind it are cut to what the reader
// may open (plan §3.3), which the words say.
import {
  ManagementReviewState,
  REVIEW_FIGURE_KEYS,
  type FindingType,
  type IsoStandard,
  type IsoStandardCode,
  type ManagementReviewView,
  type ManagementSystem,
  type ReviewClauseRef,
  type ReviewFigure,
  type ReviewFigureKey,
  type ReviewFigureKeyInfo,
  type ReviewInputSource,
} from '@canopy/contracts';
import type { FilterDef } from '@canopy/ui';

import { first, listParam, nameOf, type PersonOption } from '../_lib/people';
import { standardTitle, standardTitleByCode, word, WORDS } from '../_lib/words';

type Search = Record<string, string | string[] | undefined>;

export type ReviewFilters = {
  state: ManagementReviewState[];
  managementSystemId?: string;
};

export function reviewFilters(search: Search, systemIds: readonly string[]): ReviewFilters {
  const system = first(search.managementSystemId);
  return {
    state: listParam(search.state, ManagementReviewState.options) as ManagementReviewState[],
    ...(system && systemIds.includes(system) ? { managementSystemId: system } : {}),
  };
}

export function reviewsQuery(f: ReviewFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (f.state.length) query.state = f.state.join(',');
  if (f.managementSystemId) query.managementSystemId = f.managementSystemId;
  return query;
}

export function reviewFilterDefs(): FilterDef[] {
  return [
    {
      key: 'state',
      label: 'State',
      kind: 'multi',
      order: 'given',
      options: ManagementReviewState.options.map((s) => ({
        value: s,
        label: WORDS.ManagementReviewState[s],
      })),
    },
  ];
}

export function reviewFilterValue(f: ReviewFilters): Record<string, string[]> {
  return { state: f.state };
}

/** A calendar date as "28 Oct 2024", the design system's form, for the server's page header. */
export function dayWords(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${Number(m[3])} ${month[Number(m[2]) - 1]} ${m[1]}`;
}

/** "ISO 9001, ISO 14001": a review's standards as the account's catalogue names them. */
export function standardsWords(
  standards: readonly Pick<IsoStandard, 'code' | 'title'>[],
  codes: readonly IsoStandardCode[],
): string {
  return codes.map((c) => standardTitleByCode(standards, c)).join(', ');
}

/** A system's standards by code and name, in the system's order, for the plan and replan forms. */
export function systemStandardOptions(
  system: Pick<ManagementSystem, 'standardIds'> | undefined,
  standards: readonly Pick<IsoStandard, 'id' | 'code' | 'title'>[],
): { code: IsoStandardCode; title: string }[] {
  return (system?.standardIds ?? []).flatMap((id) => {
    const found = standards.find((x) => x.id === id);
    return found ? [{ code: found.code, title: standardTitle(standards, id) }] : [];
  });
}

/** "Management review of 28 Oct 2024": named by the day it was held, or is planned for. */
export function reviewTitle(review: Pick<ManagementReviewView, 'heldOn' | 'plannedOn'>): string {
  return `Management review of ${dayWords(review.heldOn ?? review.plannedOn)}`;
}

/** "ISO 9001 9.3.2 c1); ISO 14001 9.3 c2)": where an input or output sits in each of the review's standards. */
export function clauseRefWords(
  standards: readonly Pick<IsoStandard, 'code' | 'title'>[],
  refs: readonly ReviewClauseRef[],
): string {
  return refs
    .map(
      (r) =>
        `${standardTitleByCode(standards, r.standard)} ${r.clauseNumber}${r.item ? ` ${r.item})` : ''}`,
    )
    .join('; ');
}

export type ReviewRow = {
  id: string;
  title: string;
  /** "ISO 9001, ISO 14001 · Integrated system" */
  sub: string;
  review: ManagementReviewView;
  chairName: string;
};

export function reviewRows(
  reviews: readonly ManagementReviewView[],
  systems: readonly Pick<ManagementSystem, 'id' | 'name'>[],
  standards: readonly Pick<IsoStandard, 'code' | 'title'>[],
  people: readonly PersonOption[],
): ReviewRow[] {
  return reviews.map((r) => ({
    id: r.id,
    title: reviewTitle(r),
    sub: [
      standardsWords(standards, r.standards),
      systems.length > 1
        ? (systems.find((s) => s.id === r.managementSystemId)?.name ?? 'Unknown system')
        : null,
    ]
      .filter(Boolean)
      .join(' · '),
    review: r,
    chairName: nameOf(people, r.chairId),
  }));
}

/**
 * Held reviews of the system that share a standard with `review` and were held after `heldOn`: their stored figures
 * stay as they are when this one is recorded with an earlier day (model §3.13 item 3).
 */
export function laterHeldReviews(
  review: Pick<ManagementReviewView, 'id' | 'managementSystemId' | 'standards'>,
  others: readonly Pick<
    ManagementReviewView,
    'id' | 'managementSystemId' | 'standards' | 'state' | 'heldOn'
  >[],
  heldOn: string,
): string[] {
  return others
    .filter(
      (o) =>
        o.id !== review.id &&
        o.managementSystemId === review.managementSystemId &&
        (o.state === 'HELD' || o.state === 'CLOSED') &&
        o.heldOn !== null &&
        o.heldOn > heldOn &&
        o.standards.some((s) => review.standards.includes(s)),
    )
    .map((o) => o.heldOn!)
    .sort();
}

type FigureSource = keyof typeof REVIEW_FIGURE_KEYS;

const findings = (type: FindingType) => `Findings: ${word('FindingType', type).toLowerCase()}`;

/**
 * Every figure key `REVIEW_FIGURE_KEYS` lists, in words. The type asks for each key of each source, so a key the
 * contract adds fails to build until it is worded here.
 */
export const FIGURE_WORDS: { [S in FigureSource]: Record<ReviewFigureKey<S>, string> } = {
  PREVIOUS_ACTIONS: {
    actionsOpen: 'Review actions open',
    actionsOverdue: 'Review actions overdue',
    actionsDone: 'Review actions done',
    actionsCancelled: 'Review actions cancelled',
  },
  CONTEXT: {
    issuesAdded: 'Issues added',
    issuesChanged: 'Issues changed',
    interestedPartiesAdded: 'Interested parties added',
    interestedPartiesChanged: 'Interested parties changed',
    contextItemsRemoved: 'Issues and interested parties removed',
    climateDecided: 'Climate change relevance decided',
    climateRelevant: 'Climate change found relevant',
    climateDecidedInPeriod: 'Climate change decided in the period',
  },
  RISKS: {
    itemsAdded: 'Items added',
    itemsRerated: 'Items re-rated',
    significantRisk: 'Significant risks',
    significantOpportunity: 'Significant opportunities',
    significantAspect: 'Significant aspects',
    significantHazard: 'Significant hazards',
    treatmentActionsDone: 'Treatment actions done',
    treatmentActionsOpen: 'Treatment actions open',
  },
  OBJECTIVES: {
    objectivesOpen: 'Objectives open',
    onTrack: 'On track',
    offTrack: 'Off track',
    withoutReading: 'Without a reading',
    achieved: 'Achieved',
    notAchieved: 'Not achieved',
    readingsRecorded: 'Readings recorded',
  },
  NONCONFORMITIES: {
    raised: 'Raised',
    closed: 'Closed',
    raisedMajor: 'Raised, major',
    raisedMinor: 'Raised, minor',
    raisedInternalAudit: 'Raised from internal audits',
    raisedExternalAudit: 'Raised from external audits',
    raisedIncident: 'Raised from incidents',
    raisedNearMiss: 'Raised from near misses',
    raisedComplaint: 'Raised from complaints',
    raisedProcess: 'Raised from processes',
    raisedLegal: 'Raised from legal requirements',
    raisedOther: 'Raised from other sources',
    closedMajor: 'Closed, major',
    closedMinor: 'Closed, minor',
    closedInternalAudit: 'Closed, from internal audits',
    closedExternalAudit: 'Closed, from external audits',
    closedIncident: 'Closed, from incidents',
    closedNearMiss: 'Closed, from near misses',
    closedComplaint: 'Closed, from complaints',
    closedProcess: 'Closed, from processes',
    closedLegal: 'Closed, from legal requirements',
    closedOther: 'Closed, from other sources',
    verifiedNotEffective: 'Times found not effective',
    open: 'Open',
    correctiveActionsOverdue: 'Corrective actions overdue',
  },
  INCIDENTS: {
    incidents: 'Incidents and near misses',
    typeInjury: 'Injuries',
    typeIllHealth: 'Ill health',
    typeDangerousOccurrence: 'Dangerous occurrences',
    typeEnvironmentalRelease: 'Environmental releases',
    typeFire: 'Fires',
    typePropertyDamage: 'Property damage',
    typeNearMiss: 'Near misses',
    outcomeNone: 'Outcome: no harm',
    outcomeFirstAid: 'Outcome: first aid',
    outcomeMedicalTreatment: 'Outcome: medical treatment',
    outcomeRestrictedWork: 'Outcome: restricted work',
    outcomeLostTime: 'Outcome: lost time',
    outcomeFatality: 'Outcome: fatality',
    lostDays: 'Days lost',
  },
  AUDIT_RESULTS: {
    internalAuditsReported: 'Internal audits reported',
    externalAuditsHeld: 'External audits held',
    findingsMajorNc: findings('MAJOR_NC'),
    findingsMinorNc: findings('MINOR_NC'),
    findingsObservation: findings('OBSERVATION'),
    findingsOfi: findings('OFI'),
    findingsGoodPractice: findings('GOOD_PRACTICE'),
  },
  COMPLIANCE_EVALUATION: {
    evaluationsDue: 'Compliance evaluations due',
    evaluationsDone: 'Compliance evaluations done',
    latestEvaluation: 'Latest compliance evaluation',
    statutoryInstancesDue: 'Statutory activities due',
    statutoryScore: 'Statutory compliance score',
  },
};

export type FigureLine = { key: string; label: string; value: string; zero: boolean };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One figure in words. A count of its ids reads "N", or "N (M you can open)" when the reader may open fewer of them; a
 * figure with ids that are not its count (days lost, times found not effective) reads "N (M records you can open)"; a
 * score reads its value alone. A key the contract does not list reads its key, so a stored figure is never hidden.
 */
export function figureLine(source: ReviewInputSource, figure: ReviewFigure): FigureLine {
  const keys = (REVIEW_FIGURE_KEYS as Record<string, Record<string, ReviewFigureKeyInfo>>)[source];
  const info = keys?.[figure.key];
  const label =
    (FIGURE_WORDS as Record<string, Record<string, string>>)[source]?.[figure.key] ?? figure.key;
  const n = figure.value;
  const m = figure.ids.length;
  let value = String(n);
  if (info?.countsIds) {
    if (m < n) value = `${n} (${m} you can open)`;
  } else if (info?.entityType) {
    value = `${n} (${plural(m, 'record', 'records')} you can open)`;
  }
  return { key: figure.key, label, value, zero: n === 0 };
}
