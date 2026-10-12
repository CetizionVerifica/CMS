/** Typed repository functions per aggregate: the only database access other modules use (MODULES.md M3). */
export { auditEvents, assignments, comments, evidence, instances, RegisterFilter } from './work.js';
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
  NewDomainEvent,
  notificationSends,
  NotificationSend,
  SendFailureCode,
} from './ops.js';
export type { ClaimResult, OutboxEvent } from './ops.js';
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
