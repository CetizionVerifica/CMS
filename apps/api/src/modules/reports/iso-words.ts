import type {
  ControlHierarchy,
  FindingType,
  IsoStandardCode,
  REVIEW_FIGURE_KEYS,
  ReviewFigureKey,
} from '@canopy/contracts';

/**
 * Words for ISO codes in exports (docs/iso/model.md §4.7): the code in sentence case with a space for each
 * underscore (`ROOT_CAUSE_FOUND` reads "Root cause found"), never the code itself, with the model's exceptions for
 * the enums M10 prints. Each map is keyed by its own enum, so the same code in another enum follows the rule.
 */
export function codeWords(code: string): string {
  const words = code.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `IsoStandard.title` of each standard. */
export const STANDARD_WORDS: Readonly<Record<IsoStandardCode, string>> = {
  ISO_9001: 'ISO 9001',
  ISO_14001: 'ISO 14001',
  ISO_45001: 'ISO 45001',
};

/** The rule, but PPE stays "PPE". */
export function controlHierarchyWords(value: ControlHierarchy): string {
  return value === 'PPE' ? 'PPE' : codeWords(value);
}

/** "Yes", "No", or blank for a value not set. */
export function yesNo(value: boolean | null): string {
  if (value === null) return '';
  return value ? 'Yes' : 'No';
}

/** The model's words for finding types; the others follow the rule. */
export function findingTypeWords(value: FindingType): string {
  if (value === 'MAJOR_NC') return 'Major nonconformity';
  if (value === 'MINOR_NC') return 'Minor nonconformity';
  if (value === 'OFI') return 'Opportunity for improvement';
  return codeWords(value);
}

/** A record's text cut to one line for a reference: at most 80 characters. */
export function shortText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

const findings = (type: FindingType) => `Findings: ${findingTypeWords(type).toLowerCase()}`;

/**
 * Every figure key `REVIEW_FIGURE_KEYS` lists, in words, as the review screen words them (M17). The type asks for each
 * key of each source, so a key the contract adds fails to build until it is worded here.
 */
export const FIGURE_WORDS: {
  [S in keyof typeof REVIEW_FIGURE_KEYS]: Record<ReviewFigureKey<S>, string>;
} = {
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
