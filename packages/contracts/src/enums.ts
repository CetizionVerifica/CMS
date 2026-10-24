import { z } from 'zod';

/**
 * Enums (docs/contracts/domain-model.md §2). Each enum is a Zod schema plus a type of the same name;
 * `.options` lists the values in contract order. Clients must tolerate values added later (api-conventions.md §7).
 */

export const Role = z.enum([
  'FIRM_ADMIN',
  'CONSULTANT',
  'CLIENT_ADMIN',
  'APPROVER',
  'OWNER',
  'VIEWER',
]);
export type Role = z.infer<typeof Role>;

/** Roles held at firm level (no clientId on the membership). */
export const FIRM_ROLES = ['FIRM_ADMIN', 'CONSULTANT'] as const satisfies readonly Role[];
/** Roles held within one client (membership carries clientId). */
export const CLIENT_ROLES = [
  'CLIENT_ADMIN',
  'APPROVER',
  'OWNER',
  'VIEWER',
] as const satisfies readonly Role[];

export const PersonStatus = z.enum(['UNCLAIMED', 'INVITED', 'ACTIVE', 'DISABLED']);
export type PersonStatus = z.infer<typeof PersonStatus>;

export const Criticality = z.enum(['SUPER_CRITICAL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
export type Criticality = z.infer<typeof Criticality>;

export const TimelineType = z.enum(['TIME_BASED', 'ONGOING']);
export type TimelineType = z.infer<typeof TimelineType>;

export const ObligationDomain = z.enum(['HRS', 'EHS', 'TAX', 'IT', 'INT', 'ENG', 'ENV', 'OTHER']);
export type ObligationDomain = z.infer<typeof ObligationDomain>;

export const Jurisdiction = z.enum(['CENTRAL', 'STATE']);
export type Jurisdiction = z.infer<typeof Jurisdiction>;

export const Applicability = z.enum(['APPLICABLE', 'NOT_APPLICABLE', 'TO_ASSESS']);
export type Applicability = z.infer<typeof Applicability>;

/** Stored on the instance. */
export const WorkflowState = z.enum([
  'OPEN',
  'SUBMITTED',
  'SENT_BACK',
  'APPROVED',
  'NOT_APPLICABLE',
]);
export type WorkflowState = z.infer<typeof WorkflowState>;

/** What a SUBMITTED instance is waiting to be approved as. */
export const SubmissionKind = z.enum(['COMPLETION', 'NA']);
export type SubmissionKind = z.infer<typeof SubmissionKind>;

/** Computed by engine.deriveStatus; never stored as truth. */
export const DerivedStatus = z.enum([
  'UPCOMING',
  'DUE_SOON',
  'OVERDUE',
  'SUBMITTED',
  'COMPLIED',
  'COMPLIED_LATE',
  'NOT_APPLICABLE',
]);
export type DerivedStatus = z.infer<typeof DerivedStatus>;

/** Recurrence rule confidence: import infers, a consultant confirms. */
export const RuleStatus = z.enum(['CONFIRMED', 'TO_REVIEW']);
export type RuleStatus = z.infer<typeof RuleStatus>;

/** Evidence is downloadable only when CLEAN. */
export const ScanStatus = z.enum(['PENDING', 'CLEAN', 'INFECTED', 'FAILED']);
export type ScanStatus = z.infer<typeof ScanStatus>;

export const CommentKind = z.enum([
  'NOTE',
  'SUBMIT',
  'NA_REQUEST',
  'APPROVE',
  'SEND_BACK',
  'REOPEN',
  'IMPORT',
]);
export type CommentKind = z.infer<typeof CommentKind>;

export const AuditAction = z.enum([
  'CREATE',
  'UPDATE',
  'ARCHIVE',
  'RESTORE',
  'TRANSITION',
  'REASSIGN',
  'DUE_DATE_CHANGE',
  'APPLICABILITY_CHANGE',
  'EVIDENCE_ADD',
  'EVIDENCE_REMOVE',
  'EVIDENCE_DOWNLOAD',
  'IMPORT',
  'MERGE_ALIAS',
  'MEMBERSHIP_CHANGE',
  'LOGIN',
  'EXPORT',
]);
export type AuditAction = z.infer<typeof AuditAction>;

/** `OPERATOR`: PlanetPulse acting on the account from the console (ADR M15-0001 decision 12); its actor id is null. */
export const AuditActorKind = z.enum(['PERSON', 'SYSTEM', 'IMPORT', 'OPERATOR']);
export type AuditActorKind = z.infer<typeof AuditActorKind>;

/** Entity types named in audit events and in `can()` resources. */
export const EntityType = z.enum([
  'client',
  'company',
  'unit',
  'location',
  'department',
  'person',
  'membership',
  'act',
  'category',
  'obligation',
  'assignment',
  'instance',
  'evidence',
  'import_batch',
  'export',
  /** The account (firm) itself, in the entries the operator's changes write. */
  'account',
]);
export type EntityType = z.infer<typeof EntityType>;

export const HolidayPolicy = z.enum(['NONE', 'NEXT_WORKING_DAY', 'PREVIOUS_WORKING_DAY']);
export type HolidayPolicy = z.infer<typeof HolidayPolicy>;

/** Linear import lifecycle (domain-model.md §6). */
export const ImportBatchStatus = z.enum([
  'UPLOADED',
  'MAPPED',
  'PARSED',
  'REVIEWED',
  'DRY_RUN_READY',
  'COMMITTING',
  'COMMITTED',
  'FAILED',
  'CANCELLED',
]);
export type ImportBatchStatus = z.infer<typeof ImportBatchStatus>;

export const ImportRowOutcome = z.enum([
  'PENDING',
  'CREATE',
  'UPDATE',
  'UNCHANGED',
  'SKIPPED',
  'ERROR',
]);
export type ImportRowOutcome = z.infer<typeof ImportRowOutcome>;

export const ImportIssueType = z.enum([
  'PERSON_CASE_MERGE',
  'PERSON_NEAR_MATCH',
  'ENUM_NORMALISED',
  'UNKNOWN_ENUM',
  'ALIAS_DEPARTMENT',
  'ALIAS_CATEGORY',
  'ALIAS_ACT',
  'NULL_PLACEHOLDER',
  'COMPLIED_WITHOUT_DATE',
  'DUPLICATE_PERIOD',
  'CONFLICTING_OBLIGATION_VALUE',
  'RULE_LOW_CONFIDENCE',
  'FILE_NOT_ATTACHED',
  'UNPARSED_EXTERNAL_REF',
  'INVALID_DATE',
  'MISSING_REQUIRED',
]);
export type ImportIssueType = z.infer<typeof ImportIssueType>;

/** ERROR blocks the row; WARNING needs a decision; INFO is shown only. */
export const IssueSeverity = z.enum(['INFO', 'WARNING', 'ERROR']);
export type IssueSeverity = z.infer<typeof IssueSeverity>;

/** Severity of each import issue type (domain-model.md §6 table). */
export const IMPORT_ISSUE_SEVERITY = {
  PERSON_CASE_MERGE: 'INFO',
  PERSON_NEAR_MATCH: 'WARNING',
  ENUM_NORMALISED: 'INFO',
  UNKNOWN_ENUM: 'ERROR',
  ALIAS_DEPARTMENT: 'WARNING',
  ALIAS_CATEGORY: 'WARNING',
  ALIAS_ACT: 'WARNING',
  NULL_PLACEHOLDER: 'INFO',
  COMPLIED_WITHOUT_DATE: 'WARNING',
  DUPLICATE_PERIOD: 'WARNING',
  CONFLICTING_OBLIGATION_VALUE: 'INFO',
  RULE_LOW_CONFIDENCE: 'WARNING',
  FILE_NOT_ATTACHED: 'INFO',
  UNPARSED_EXTERNAL_REF: 'INFO',
  INVALID_DATE: 'ERROR',
  MISSING_REQUIRED: 'ERROR',
} as const satisfies Record<ImportIssueType, IssueSeverity>;

export const IssueDecision = z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'EDITED']);
export type IssueDecision = z.infer<typeof IssueDecision>;

export const NotificationKind = z.enum([
  'OWNER_REMINDER',
  'APPROVER_ESCALATION',
  'CONSULTANT_DIGEST',
  'INVITE',
  'MAGIC_LINK',
  'EXPORT_READY',
  /** To the approver, on `instance.submitted`. Event-driven: dedupes on the source event id (events.md §4 rule 4). */
  'APPROVAL_REQUESTED',
  /** To the owner, on `instance.sent_back`. Event-driven: dedupes on the source event id. */
  'SENT_BACK',
  /**
   * To each account admin of a TRIAL account, 7 days and 1 day before its trial ends (ADR M15-0001, order of work step 6: M9's reminders).
   * Scheduled, with no instance: dedupes on recipient, kind and send date, as `CONSULTANT_DIGEST` does.
   */
  'TRIAL_ENDING',
  /**
   * To each account admin of an ACTIVE account, 30 days and 7 days before its latest paid subscription ends (ADR
   * M15-0001, order of work step 6: M9's reminders). Scheduled, with no instance: dedupes as `TRIAL_ENDING` does.
   */
  'RENEWAL_DUE',
  /**
   * To a person, when MFA is set up on their account (docs/security/review.md F14, mitigation 3), on
   * `person.mfa_enrolled`. Event-driven: dedupes on the source event id, as `MAGIC_LINK` does.
   */
  'MFA_ENROLLED',
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const ExportKind = z.enum([
  'REGISTER_XLSX',
  'CERTIFICATE_PDF',
  'ACT_REPORT_XLSX',
  'DEPARTMENT_REPORT_XLSX',
  'OVERDUE_REPORT_XLSX',
  /**
   * One client's whole register (every FY, re-importable) and its evidence files in a zip, for account admins (FA)
   * only. With the other export routes it stays reachable while the account is PENDING_DELETION (ADR M15-0001
   * decision 4).
   */
  'CLIENT_ARCHIVE_ZIP',
]);
export type ExportKind = z.infer<typeof ExportKind>;

/** Status of export and import jobs. */
export const JobStatus = z.enum(['QUEUED', 'RUNNING', 'DONE', 'FAILED']);
export type JobStatus = z.infer<typeof JobStatus>;

/** Actions the API may offer on an instance; the UI shows only those in `allowedActions`. */
export const InstanceAction = z.enum([
  'SUBMIT',
  'REQUEST_NA',
  'APPROVE',
  'SEND_BACK',
  'REOPEN',
  'REASSIGN',
  'CHANGE_DUE_DATE',
  'COMMENT',
  'UPLOAD_EVIDENCE',
]);
export type InstanceAction = z.infer<typeof InstanceAction>;

/**
 * States in which REASSIGN, CHANGE_DUE_DATE and UPLOAD_EVIDENCE are offered (ADR 0004 §7). A complied or NA instance is
 * reopened first, so its on-time result cannot change silently. Otherwise `409 INVALID_TRANSITION`.
 */
export const INSTANCE_EDIT_STATES = [
  'OPEN',
  'SENT_BACK',
  'SUBMITTED',
] as const satisfies readonly WorkflowState[];

/** Fields an import column can map to (domain-model.md §6). */
export const CanopyField = z.enum([
  'externalRef',
  'title',
  'timelineType',
  'description',
  'category',
  'applicabilityText',
  'act',
  'completedOn',
  'status',
  'dueDate',
  'forms',
  'logSheets',
  'organizationPath',
  'locationPath',
  'owner',
  'ownerComment',
  'approver',
  'department',
  'criticality',
]);
export type CanopyField = z.infer<typeof CanopyField>;

export const BreakdownBy = z.enum(['department', 'act', 'criticality', 'unit', 'owner']);
export type BreakdownBy = z.infer<typeof BreakdownBy>;

/** Customer accounts (ADR M15-0001). An account is a firm. */
export const AccountKind = z.enum(['ENTERPRISE', 'CONSULTANCY']);
export type AccountKind = z.infer<typeof AccountKind>;

export const AccountStatus = z.enum([
  'PROVISIONING',
  'TRIAL',
  'ACTIVE',
  'SUSPENDED',
  'PENDING_DELETION',
  'DELETED',
]);
export type AccountStatus = z.infer<typeof AccountStatus>;

/** Statuses in which everyone in the account can work and jobs run. */
export const WORKING_ACCOUNT_STATUSES = [
  'TRIAL',
  'ACTIVE',
] as const satisfies readonly AccountStatus[];

/**
 * Statuses in which only account admins may sign in, to read `/me` and download the account export (the plan's
 * default: a SUSPENDED account signs nobody in). ADR M15-0001 decision 4.
 */
export const EXPORT_ACCOUNT_STATUSES = [
  'PENDING_DELETION',
] as const satisfies readonly AccountStatus[];

/**
 * Every allowed account status move (ADR M15-0001 decision 3). Only `ACTIVE` and `SUSPENDED` accounts can be put up for
 * deletion, so `PENDING_DELETION` → `ACTIVE | SUSPENDED` is a cancelled deletion returning to the status it left.
 * Extending a trial changes `trialEndsOn`, not the status (`POST /accounts/{id}/trial`, TRIAL accounts only). Anything
 * else is 409 INVALID_TRANSITION.
 */
export const ACCOUNT_TRANSITIONS = {
  PROVISIONING: ['TRIAL', 'ACTIVE'],
  TRIAL: ['ACTIVE', 'SUSPENDED'],
  ACTIVE: ['SUSPENDED', 'PENDING_DELETION'],
  SUSPENDED: ['ACTIVE', 'PENDING_DELETION'],
  PENDING_DELETION: ['ACTIVE', 'SUSPENDED', 'DELETED'],
  DELETED: [],
} as const satisfies Record<AccountStatus, readonly AccountStatus[]>;

/** True when an account may move from `from` to `to`. */
export function canMoveAccount(from: AccountStatus, to: AccountStatus): boolean {
  return (ACCOUNT_TRANSITIONS[from] as readonly AccountStatus[]).includes(to);
}

/** Plan limits counted by `entitlements()` (ADR M15-0001 decision 5). */
export const PlanLimitKey = z.enum(['companies', 'units', 'users', 'storageBytes']);
export type PlanLimitKey = z.infer<typeof PlanLimitKey>;

/** How much of an account PlanetPulse support may reach under a grant (ADR M15-0001 decision 11). */
export const SupportAccessLevel = z.enum(['READ_ONLY', 'ADMIN']);
export type SupportAccessLevel = z.infer<typeof SupportAccessLevel>;

export const SupportGrantStatus = z.enum(['ACTIVE', 'EXPIRED', 'REVOKED']);
export type SupportGrantStatus = z.infer<typeof SupportGrantStatus>;

/** Operator audit actions (ADR M15-0001 decision 12). */
export const OperatorAuditAction = z.enum([
  'OPERATOR_LOGIN',
  'ACCOUNT_CREATE',
  'OWNER_INVITE_SEND',
  'ACCOUNT_ACTIVATE',
  'ACCOUNT_SUSPEND',
  'ACCOUNT_RESUME',
  'TRIAL_CONVERT',
  'TRIAL_EXTEND',
  'ACCOUNT_UPDATE',
  'PLAN_CHANGE',
  'OVERRIDE_CHANGE',
  'SUBSCRIPTION_RECORD',
  'ACCOUNT_DELETE_REQUEST',
  'ACCOUNT_DELETE_CANCEL',
  'ACCOUNT_PURGE',
  'SUPPORT_ACCESS_START',
  'SUPPORT_ACCESS_END',
]);
export type OperatorAuditAction = z.infer<typeof OperatorAuditAction>;
