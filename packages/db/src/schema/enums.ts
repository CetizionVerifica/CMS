import {
  Applicability,
  AuditAction,
  AuditActorKind,
  CanopyField,
  CommentKind,
  Criticality,
  EntityType,
  ExportKind,
  ImportBatchStatus,
  ImportIssueType,
  ImportRowOutcome,
  IssueDecision,
  IssueSeverity,
  JobStatus,
  Jurisdiction,
  NotificationKind,
  ObligationDomain,
  PersonStatus,
  Role,
  RuleStatus,
  ScanStatus,
  SubmissionKind,
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
export const applicabilityEnum = pgEnum('applicability', values(Applicability.options));
export const workflowStateEnum = pgEnum('workflow_state', values(WorkflowState.options));
export const submissionKindEnum = pgEnum('submission_kind', values(SubmissionKind.options));
export const ruleStatusEnum = pgEnum('rule_status', values(RuleStatus.options));
export const scanStatusEnum = pgEnum('scan_status', values(ScanStatus.options));
export const commentKindEnum = pgEnum('comment_kind', values(CommentKind.options));
export const auditActionEnum = pgEnum('audit_action', values(AuditAction.options));
export const auditActorKindEnum = pgEnum('audit_actor_kind', values(AuditActorKind.options));
export const entityTypeEnum = pgEnum('entity_type', values(EntityType.options));
export const importBatchStatusEnum = pgEnum(
  'import_batch_status',
  values(ImportBatchStatus.options),
);
export const importRowOutcomeEnum = pgEnum('import_row_outcome', values(ImportRowOutcome.options));
export const importIssueTypeEnum = pgEnum('import_issue_type', values(ImportIssueType.options));
export const issueSeverityEnum = pgEnum('issue_severity', values(IssueSeverity.options));
export const issueDecisionEnum = pgEnum('issue_decision', values(IssueDecision.options));
export const canopyFieldEnum = pgEnum('canopy_field', values(CanopyField.options));
// APPROVAL_REQUESTED and SENT_BACK (M9 event-driven sends) arrive in the database before contracts 1.4.0
// lists them; the Set keeps the order stable once it does (migration 0017).
export const notificationKindEnum = pgEnum(
  'notification_kind',
  values([...new Set([...NotificationKind.options, 'APPROVAL_REQUESTED', 'SENT_BACK'] as const)]),
);
export const exportKindEnum = pgEnum('export_kind', values(ExportKind.options));
export const jobStatusEnum = pgEnum('job_status', values(JobStatus.options));
