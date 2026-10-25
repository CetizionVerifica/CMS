import {
  AspectControlType,
  ChecklistResult,
  ControlHierarchy,
  FindingType,
  IncidentOutcome,
  IncidentPersonCategory,
  IncidentType,
  InternalAuditState,
  IsoActionState,
  LifeCycleStage,
  ManagementReviewState,
  NcDisposition,
  NcSeverity,
  NcSource,
  NcState,
  ObjectiveDirection,
  ObjectiveOutcome,
  OperatingCondition,
  PersonsExposed,
  RiskKind,
  RootCauseMethod,
  AccountKind,
  AccountStatus,
  ActKind,
  Applicability,
  AuditAction,
  AuditActorKind,
  AuditRecommendation,
  CanopyField,
  ClauseNaState,
  ClauseStatus,
  CommentKind,
  ContextItemKind,
  Criticality,
  DocumentStatus,
  DocumentType,
  EntityType,
  ExportKind,
  ExternalAuditState,
  ExternalAuditType,
  ImportBatchStatus,
  ImportIssueType,
  ImportRowOutcome,
  ISO_ENTITY_TYPES,
  ISO_EXPORT_KINDS,
  ISO_NOTIFICATION_KINDS,
  IsoStandardCode,
  IssueDecision,
  IssueSeverity,
  JobStatus,
  Jurisdiction,
  ManagementSystemStatus,
  NotificationKind,
  ObligationDomain,
  OperatorAuditAction,
  PersonStatus,
  ReviewInputKey,
  ReviewInputSource,
  ReviewOutputKey,
  RevisionState,
  Role,
  RuleStatus,
  ScanStatus,
  SubmissionKind,
  SupportAccessLevel,
  TimelineType,
  WorkflowState,
} from '@canopy/contracts';
import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Postgres enum types, built from the M0 contract enums so the database and the API cannot drift.
 * A value added to a contract enum needs a migration (`ALTER TYPE ... ADD VALUE`); `pnpm db:generate` writes it.
 * DerivedStatus is not stored (packages/db/CLAUDE.md rule 7).
 */

type Values<T extends string> = [T, ...T[]];
function values<T extends string>(options: readonly T[]): Values<T> {
  return [...options] as Values<T>;
}

export const roleEnum = pgEnum('role', values(Role.options));
export const personStatusEnum = pgEnum('person_status', values(PersonStatus.options));
export const criticalityEnum = pgEnum('criticality', values(Criticality.options));
export const timelineTypeEnum = pgEnum('timeline_type', values(TimelineType.options));
export const obligationDomainEnum = pgEnum('obligation_domain', values(ObligationDomain.options));
export const jurisdictionEnum = pgEnum('jurisdiction', values(Jurisdiction.options));
export const actKindEnum = pgEnum('act_kind', values(ActKind.options));
export const applicabilityEnum = pgEnum('applicability', values(Applicability.options));
export const workflowStateEnum = pgEnum('workflow_state', values(WorkflowState.options));
export const submissionKindEnum = pgEnum('submission_kind', values(SubmissionKind.options));
export const ruleStatusEnum = pgEnum('rule_status', values(RuleStatus.options));
export const scanStatusEnum = pgEnum('scan_status', values(ScanStatus.options));
export const commentKindEnum = pgEnum('comment_kind', values(CommentKind.options));
export const auditActionEnum = pgEnum('audit_action', values(AuditAction.options));
// OPERATOR and account (operator actions in a customer's audit trail, ADR M15-0001 decision 12) arrive in the
// database before the contracts list them; the Set keeps the order stable once they do (migration 0019).
export const auditActorKindEnum = pgEnum(
  'audit_actor_kind',
  values([...new Set([...AuditActorKind.options, 'OPERATOR'] as const)]),
);
// The ISO add-on's entity types, reminder kinds and export kinds (docs/iso/model.md §7-9) are staged the same way:
// the database stores them (migration 0038) before contracts 1.8.0's ISO_* constants join their enums (ISO-1b).
export const entityTypeEnum = pgEnum(
  'entity_type',
  values([...new Set([...EntityType.options, 'account', ...ISO_ENTITY_TYPES] as const)]),
);
export const importBatchStatusEnum = pgEnum(
  'import_batch_status',
  values(ImportBatchStatus.options),
);
export const importRowOutcomeEnum = pgEnum('import_row_outcome', values(ImportRowOutcome.options));
export const importIssueTypeEnum = pgEnum('import_issue_type', values(ImportIssueType.options));
export const issueSeverityEnum = pgEnum('issue_severity', values(IssueSeverity.options));
export const issueDecisionEnum = pgEnum('issue_decision', values(IssueDecision.options));
export const canopyFieldEnum = pgEnum('canopy_field', values(CanopyField.options));
// APPROVAL_REQUESTED and SENT_BACK (M9 event-driven sends) arrived in the database before contracts 1.4.0 listed
// them; the Set keeps the order stable once it does (migration 0017). TRIAL_ENDING (M9's email to an account's admins
// before its trial ends, ADR M15-0001 decision 4) arrives ahead of its contracts bump the same way (migration 0027),
// as do RENEWAL_DUE (the admins' reminder before the subscription ends) and MFA_ENROLLED (a person's notice that
// MFA was set up on their account, docs/security/review.md F14 mitigation 3) in migration 0032.
export const notificationKindEnum = pgEnum(
  'notification_kind',
  values([
    ...new Set([
      ...NotificationKind.options,
      'APPROVAL_REQUESTED',
      'SENT_BACK',
      'TRIAL_ENDING',
      'RENEWAL_DUE',
      'MFA_ENROLLED',
      ...ISO_NOTIFICATION_KINDS,
    ] as const),
  ]),
);
// CLIENT_ARCHIVE_ZIP (a client's register and evidence, downloadable while an account is PENDING_DELETION, ADR
// M15-0001 decision 4) arrives in the database before the contracts list it, as OPERATOR did above.
export const exportKindEnum = pgEnum(
  'export_kind',
  values([...new Set([...ExportKind.options, 'CLIENT_ARCHIVE_ZIP', ...ISO_EXPORT_KINDS] as const)]),
);
export const jobStatusEnum = pgEnum('job_status', values(JobStatus.options));

// Customer accounts and the platform operator (ADR M15-0001).
export const accountKindEnum = pgEnum('account_kind', values(AccountKind.options));
export const accountStatusEnum = pgEnum('account_status', values(AccountStatus.options));
export const supportAccessLevelEnum = pgEnum(
  'support_access_level',
  values(SupportAccessLevel.options),
);
export const operatorAuditActionEnum = pgEnum(
  'operator_audit_action',
  values(OperatorAuditAction.options),
);

// The ISO add-on (docs/iso/model.md §2-3.9, migration 0040).
export const isoStandardCodeEnum = pgEnum('iso_standard_code', values(IsoStandardCode.options));
export const reviewInputKeyEnum = pgEnum('review_input_key', values(ReviewInputKey.options));
export const reviewOutputKeyEnum = pgEnum('review_output_key', values(ReviewOutputKey.options));
export const reviewInputSourceEnum = pgEnum(
  'review_input_source',
  values(ReviewInputSource.options),
);
export const managementSystemStatusEnum = pgEnum(
  'management_system_status',
  values(ManagementSystemStatus.options),
);
export const contextItemKindEnum = pgEnum('context_item_kind', values(ContextItemKind.options));
export const clauseStatusEnum = pgEnum('clause_status', values(ClauseStatus.options));
export const clauseNaStateEnum = pgEnum('clause_na_state', values(ClauseNaState.options));
export const documentTypeEnum = pgEnum('document_type', values(DocumentType.options));
export const documentStatusEnum = pgEnum('document_status', values(DocumentStatus.options));
export const revisionStateEnum = pgEnum('revision_state', values(RevisionState.options));
export const externalAuditTypeEnum = pgEnum(
  'external_audit_type',
  values(ExternalAuditType.options),
);
export const auditRecommendationEnum = pgEnum(
  'audit_recommendation',
  values(AuditRecommendation.options),
);
export const externalAuditStateEnum = pgEnum(
  'external_audit_state',
  values(ExternalAuditState.options),
);

// The ISO add-on, part 2 (docs/iso/model.md §1.4, §3.5-3.13, migration 0041).
export const aspectControlTypeEnum = pgEnum(
  'aspect_control_type',
  values(AspectControlType.options),
);
export const checklistResultEnum = pgEnum('checklist_result', values(ChecklistResult.options));
export const controlHierarchyEnum = pgEnum('control_hierarchy', values(ControlHierarchy.options));
export const findingTypeEnum = pgEnum('finding_type', values(FindingType.options));
export const incidentOutcomeEnum = pgEnum('incident_outcome', values(IncidentOutcome.options));
export const incidentPersonCategoryEnum = pgEnum(
  'incident_person_category',
  values(IncidentPersonCategory.options),
);
export const incidentTypeEnum = pgEnum('incident_type', values(IncidentType.options));
export const internalAuditStateEnum = pgEnum(
  'internal_audit_state',
  values(InternalAuditState.options),
);
export const isoActionStateEnum = pgEnum('iso_action_state', values(IsoActionState.options));
export const lifeCycleStageEnum = pgEnum('life_cycle_stage', values(LifeCycleStage.options));
export const managementReviewStateEnum = pgEnum(
  'management_review_state',
  values(ManagementReviewState.options),
);
export const ncDispositionEnum = pgEnum('nc_disposition', values(NcDisposition.options));
export const ncSeverityEnum = pgEnum('nc_severity', values(NcSeverity.options));
export const ncSourceEnum = pgEnum('nc_source', values(NcSource.options));
export const ncStateEnum = pgEnum('nc_state', values(NcState.options));
export const objectiveDirectionEnum = pgEnum(
  'objective_direction',
  values(ObjectiveDirection.options),
);
export const objectiveOutcomeEnum = pgEnum('objective_outcome', values(ObjectiveOutcome.options));
export const operatingConditionEnum = pgEnum(
  'operating_condition',
  values(OperatingCondition.options),
);
export const personsExposedEnum = pgEnum('persons_exposed', values(PersonsExposed.options));
export const riskKindEnum = pgEnum('risk_kind', values(RiskKind.options));
export const rootCauseMethodEnum = pgEnum('root_cause_method', values(RootCauseMethod.options));
// Roles on the ISO join tables (model §1.4). The contracts have none: they list each role as its own id list.
export const internalAuditRoleEnum = pgEnum('internal_audit_role', [
  'AUDITOR',
  'AUDITEE',
  'REPORTED_TO',
]);
export const nonconformityRiskRoleEnum = pgEnum('nonconformity_risk_role', ['RELATED', 'UPDATED']);
