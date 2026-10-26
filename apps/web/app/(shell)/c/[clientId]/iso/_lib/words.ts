// ISO states and codes in plain words (docs/iso/model.md §4.7): the code in sentence case with a space for each
// underscore, except where §4.7 names other words. Each map is keyed by its contracts enum, since the same code can
// read differently in two enums (APPROVED in ClauseNaState and in RevisionState). Display only: no ISO rule lives here.
import {
  AspectControlType,
  AuditRecommendation,
  CertificationCycleKind,
  CertificationGate,
  ChecklistResult,
  ClauseNaState,
  ClauseStatus,
  ClimateGap,
  ContextItemKind,
  ControlHierarchy,
  DocumentStatus,
  DocumentType,
  ExternalAuditState,
  ExternalAuditType,
  FindingType,
  IncidentOutcome,
  IncidentPersonCategory,
  IncidentType,
  InternalAuditState,
  IsoActionState,
  IsoActionSubjectType,
  IsoStandardCode,
  IsoTiming,
  LifeCycleStage,
  ManagementReviewState,
  ManagementSystemStatus,
  NcDisposition,
  NcSeverity,
  NcSource,
  NcState,
  ObjectiveDirection,
  ObjectiveOutcome,
  OperatingCondition,
  PersonsExposed,
  RevisionState,
  RiskKind,
  RootCauseMethod,
  type IsoStandard,
} from '@canopy/contracts';

/** A code in sentence case, one space per underscore: ROOT_CAUSE_FOUND reads "Root cause found" (model §4.7). */
export function sentence(code: string): string {
  const words = code.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function byRule<const T extends string>(
  values: readonly T[],
  exceptions: Partial<Record<T, string>> = {},
): Readonly<Record<T, string>> {
  return Object.fromEntries(values.map((v) => [v, exceptions[v] ?? sentence(v)])) as Record<
    T,
    string
  >;
}

/** The standards' words when the account's catalogue doesn't name them: its `IsoStandard.title` wins (§4.7). */
const STANDARD_TITLES: Readonly<Record<IsoStandardCode, string>> = {
  ISO_9001: 'ISO 9001',
  ISO_14001: 'ISO 14001',
  ISO_45001: 'ISO 45001',
};

export const WORDS = {
  IsoStandardCode: STANDARD_TITLES,
  ManagementSystemStatus: byRule(ManagementSystemStatus.options),
  ContextItemKind: byRule(ContextItemKind.options),
  ClauseStatus: byRule(ClauseStatus.options),
  ClauseNaState: byRule(ClauseNaState.options, {
    NONE: 'No request',
    REQUESTED: 'Not applicable requested',
    APPROVED: 'Not applicable approved',
    REJECTED: 'Not applicable refused',
  }),
  DocumentType: byRule(DocumentType.options),
  DocumentStatus: byRule(DocumentStatus.options),
  RevisionState: byRule(RevisionState.options),
  RiskKind: byRule(RiskKind.options),
  LifeCycleStage: byRule(LifeCycleStage.options),
  AspectControlType: byRule(AspectControlType.options),
  PersonsExposed: byRule(PersonsExposed.options),
  OperatingCondition: byRule(OperatingCondition.options),
  ControlHierarchy: byRule(ControlHierarchy.options, { PPE: 'PPE' }),
  ObjectiveDirection: byRule(ObjectiveDirection.options),
  ObjectiveOutcome: byRule(ObjectiveOutcome.options),
  InternalAuditState: byRule(InternalAuditState.options),
  ChecklistResult: byRule(ChecklistResult.options),
  ExternalAuditType: byRule(ExternalAuditType.options),
  AuditRecommendation: byRule(AuditRecommendation.options),
  ExternalAuditState: byRule(ExternalAuditState.options),
  FindingType: byRule(FindingType.options, {
    MAJOR_NC: 'Major nonconformity',
    MINOR_NC: 'Minor nonconformity',
    OFI: 'Opportunity for improvement',
  }),
  NcSource: byRule(NcSource.options),
  NcSeverity: byRule(NcSeverity.options),
  RootCauseMethod: byRule(RootCauseMethod.options),
  NcDisposition: byRule(NcDisposition.options),
  NcState: byRule(NcState.options),
  IncidentType: byRule(IncidentType.options),
  IncidentOutcome: byRule(IncidentOutcome.options),
  IncidentPersonCategory: byRule(IncidentPersonCategory.options),
  IsoActionSubjectType: byRule(IsoActionSubjectType.options, {
    NONCONFORMITY: 'Corrective action',
    RISK_ITEM: 'Treatment action',
    OBJECTIVE: 'Objective plan',
    AUDIT_FINDING: 'Improvement action',
    MANAGEMENT_REVIEW: 'Review action',
  }),
  IsoActionState: byRule(IsoActionState.options),
  ManagementReviewState: byRule(ManagementReviewState.options),
  IsoTiming: byRule(IsoTiming.options),
  CertificationGate: byRule(CertificationGate.options),
  CertificationCycleKind: byRule(CertificationCycleKind.options),
  ClimateGap: byRule(ClimateGap.options),
} as const;

export type WordsEnum = keyof typeof WORDS;

/** The words for one value of one enum. */
export function word<E extends WordsEnum>(
  enumName: E,
  value: keyof (typeof WORDS)[E] & string,
): string {
  return (WORDS[enumName] as Record<string, string>)[value] ?? sentence(value);
}

/** A standard by its id, as the account's catalogue names it, falling back to its code's words. */
export function standardTitle(
  standards: readonly Pick<IsoStandard, 'id' | 'code' | 'title'>[],
  id: string,
): string {
  const found = standards.find((s) => s.id === id);
  return found ? found.title || STANDARD_TITLES[found.code] : 'Unknown standard';
}

/** A standard by its code, as the account's catalogue names it. */
export function standardTitleByCode(
  standards: readonly Pick<IsoStandard, 'code' | 'title'>[],
  code: IsoStandardCode,
): string {
  return standards.find((s) => s.code === code)?.title ?? STANDARD_TITLES[code];
}

/** "Overdue 3 days", "Due soon", "On time", "Closed": an ISO due status (M4 `reviewDue`) in words. */
export function timingWords(status: { timing: IsoTiming; overdueDays: number | null }): string {
  if (status.timing === 'OVERDUE' && status.overdueDays !== null) {
    return `Overdue ${status.overdueDays} ${status.overdueDays === 1 ? 'day' : 'days'}`;
  }
  return word('IsoTiming', status.timing);
}
