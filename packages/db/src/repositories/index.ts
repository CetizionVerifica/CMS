/** Typed repository functions per aggregate: the only database access other modules use (MODULES.md M3). */
export {
  AuditQuery,
  auditEvents,
  assignments,
  comments,
  evidence,
  EvidenceVaultFilter,
  instances,
  REGISTER_READ_LIMIT,
  RegisterFilter,
} from './work.js';
export type { InstanceExportDetail, NewAuditEvent, RegisterRow } from './work.js';
export { acts, categories, obligations } from './library.js';
export {
  clients,
  companies,
  departments,
  firms,
  locations,
  memberships,
  people,
  units,
} from './tenancy.js';
export { importBatches, importIssues, importRows, mappingTemplates } from './imports.js';
export type { NewImportBatch, NewImportIssue, NewImportRow } from './imports.js';
export {
  domainEvents,
  exportJobs,
  IdempotencyRecord,
  idempotencyKeys,
  NewDomainEvent,
  notificationSends,
  NotificationSend,
  SendFailureCode,
} from './ops.js';
export type { ClaimResult, IsoSendKey, OutboxEvent } from './ops.js';
export { jobs } from './jobs.js';
export type {
  ClientRef,
  ConsultantRef,
  DateRange,
  ExistingInstanceKey,
  GenerationTarget,
  NewGeneratedInstance,
  Recipient,
  ReminderCandidate,
} from './jobs.js';
export { MAX_LIMIT, type NewEntity, type Page, type PageRequest } from './crud.js';
export {
  credentials,
  Grant,
  invites,
  Lockout,
  loginTokens,
  MfaRecord,
  NewInvite,
  NewLoginToken,
  NewSession,
  SessionMethod,
  sessions,
} from './auth.js';
export type { Credential, Invite, PersonChange, StoredSession } from './auth.js';
export {
  account,
  AccountChange,
  AccountEvent,
  accountIdsWithStatus,
  AccountRecord,
  AccountUsage,
  IssueSupportToken,
  NewAccount,
  platformAccounts,
  platformSupport,
  SUPPORT_PERSON,
  SupportGrantRequest,
  supportGrants,
} from './accounts.js';
export {
  accountJobs,
  accountOverrides,
  NewOperator,
  NewOperatorAuditEvent,
  NewOperatorSession,
  NewSubscription,
  operatorAudit,
  OperatorAuditFilter,
  operators,
  operatorSessions,
  ownerInvites,
  PlanChange,
  plans,
  subscriptions,
  usageSnapshots,
} from './platform.js';
export type { OperatorLogin, OperatorSession, Renewal } from './platform.js';
export {
  certifications,
  CertificationFilter,
  ChecklistFilter,
  clauseAssessments,
  ContextItemFilter,
  contextItems,
  controlledDocuments,
  DocumentFilter,
  documentRevisions,
  ExternalAuditFilter,
  externalAudits,
  isoCatalogue,
  IsoClauseFilter,
  isoFiles,
  isoFileSubject,
  isoFileView,
  ManagementSystemFilter,
  managementSystems,
  NewIsoFile,
  UnitScope,
} from './iso.js';
export type { ClauseAssessmentRow, IsoPage } from './iso.js';
