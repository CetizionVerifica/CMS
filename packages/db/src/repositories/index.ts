/** Typed repository functions per aggregate: the only database access other modules use (MODULES.md M3). */
export { auditEvents, assignments, comments, evidence, instances, RegisterFilter } from './work.js';
export type { NewAuditEvent, RegisterRow } from './work.js';
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
export type { NewImportIssue, NewImportRow } from './imports.js';
export {
  domainEvents,
  exportJobs,
  NewDomainEvent,
  notificationSends,
  NotificationSend,
} from './ops.js';
export type { OutboxEvent } from './ops.js';
export { MAX_LIMIT, type NewEntity, type Page, type PageRequest } from './crud.js';
