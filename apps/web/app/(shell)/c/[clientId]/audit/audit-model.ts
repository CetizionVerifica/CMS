// How the audit trail words a client's audit events. Display only: the events, their order and who may read them come
// from the API (M7). Evidence events name no file, so nothing from evidence reaches the page (root CLAUDE.md rule 6).
import {
  ChecklistResult,
  ClauseStatus,
  DocumentStatus,
  ExternalAuditState,
  InternalAuditState,
  IsoActionState,
  ManagementReviewState,
  ManagementSystemStatus,
  NcSeverity,
  NcState,
  PersonStatus,
  RevisionState,
  type AuditEvent,
  type ClauseNaAction,
  type DocumentAction,
  type ExternalAuditAction,
  type InternalAuditAction,
  type IsoActionAction,
  type IsoEntityType,
  type ManagementReviewAction,
  type NcAction,
  type RevisionAction,
  type WorkflowState,
} from '@canopy/contracts';

export type AuditAction = AuditEvent['action'];
export type EntityType = AuditEvent['entityType'];

/** The filter's choices, in the order a reader looks for them, with the actions each one asks the API for. */
export const ACTION_FILTERS: { value: string; label: string; actions: AuditAction[] }[] = [
  { value: 'workflow', label: 'Submissions and approvals', actions: ['TRANSITION'] },
  {
    value: 'dates',
    label: 'Due dates and applicability',
    actions: ['DUE_DATE_CHANGE', 'APPLICABILITY_CHANGE'],
  },
  { value: 'reassign', label: 'Reassignments', actions: ['REASSIGN'] },
  {
    value: 'evidence',
    label: 'Evidence',
    actions: ['EVIDENCE_ADD', 'EVIDENCE_REMOVE', 'EVIDENCE_DOWNLOAD'],
  },
  {
    value: 'setup',
    label: 'Setup changes',
    actions: ['CREATE', 'UPDATE', 'ARCHIVE', 'RESTORE', 'MERGE_ALIAS'],
  },
  { value: 'access', label: 'Access and roles', actions: ['MEMBERSHIP_CHANGE', 'LOGIN'] },
  { value: 'imports', label: 'Imports and exports', actions: ['IMPORT', 'EXPORT'] },
];

/** The URL's `kind` values (comma-separated) as the API's `action` list; unknown values are dropped. */
export function kindsFrom(param: string | null): { kinds: string[]; actions: AuditAction[] } {
  const kinds = (param ?? '').split(',').filter((k) => ACTION_FILTERS.some((f) => f.value === k));
  const actions = ACTION_FILTERS.filter((f) => kinds.includes(f.value)).flatMap((f) => f.actions);
  return { kinds, actions };
}

// The ISO add-on's types are staged outside EntityType until contracts ISO-1b joins them (docs/iso/model.md §8);
// keying them here keeps this map complete before and after that bump.
export const ENTITY: Record<EntityType | IsoEntityType, string> = {
  client: 'the client',
  company: 'a company',
  unit: 'a unit',
  location: 'a location',
  department: 'a department',
  person: 'a person',
  membership: 'a role',
  act: 'an Act',
  category: 'a category',
  obligation: 'an obligation',
  assignment: 'an assignment',
  instance: 'an instance',
  evidence: 'evidence',
  import_batch: 'an import',
  export: 'an export',
  account: 'the account',
  management_system: 'a management system',
  certification: 'a certificate',
  external_audit: 'an external audit',
  context_item: 'a context item',
  clause_assessment: 'a clause on the checklist',
  controlled_document: 'a controlled document',
  document_revision: 'a document revision',
  risk_item: 'a risk register entry',
  risk_control: 'a risk control',
  objective: 'an objective',
  objective_reading: 'an objective reading',
  audit_programme: 'an audit programme',
  internal_audit: 'an internal audit',
  audit_checklist_item: 'an audit checklist row',
  audit_finding: 'an audit finding',
  nonconformity: 'a nonconformity',
  iso_action: 'an ISO action',
  management_review: 'a management review',
};

const VERB: Record<AuditAction, string> = {
  CREATE: 'Added',
  UPDATE: 'Changed',
  ARCHIVE: 'Archived',
  RESTORE: 'Restored',
  TRANSITION: 'Moved',
  REASSIGN: 'Reassigned',
  DUE_DATE_CHANGE: 'Moved the due date of',
  APPLICABILITY_CHANGE: 'Changed whether it applies:',
  EVIDENCE_ADD: 'Added evidence to',
  EVIDENCE_REMOVE: 'Removed evidence from',
  EVIDENCE_DOWNLOAD: 'Downloaded evidence from',
  IMPORT: 'Imported',
  MERGE_ALIAS: 'Merged duplicates into',
  MEMBERSHIP_CHANGE: 'Changed',
  LOGIN: 'Signed in to',
  EXPORT: 'Exported',
};

const WORKFLOW: Record<string, string> = {
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  NOT_APPLICABLE: 'Approved as not applicable',
  SENT_BACK: 'Sent back',
  OPEN: 'Reopened',
};

type IsoStep =
  | ClauseNaAction
  | DocumentAction
  | RevisionAction
  | InternalAuditAction
  | ExternalAuditAction
  | NcAction
  | IsoActionAction
  | ManagementReviewAction;

/** An ISO record's step (`after.action` on its TRANSITION), as the verb ahead of the record's words. */
const ISO_STEP: Record<IsoStep, string> = {
  REQUEST_NA: 'Asked to mark as not applicable:',
  APPROVE_NA: 'Approved as not applicable:',
  REJECT_NA: 'Refused not applicable for',
  WITHDRAW_NA: 'Withdrew not applicable for',
  REVIEW: 'Reviewed',
  MAKE_OBSOLETE: 'Made obsolete:',
  DRAFT_REVISION: 'Drafted',
  SUBMIT: 'Submitted',
  APPROVE: 'Approved',
  SEND_BACK: 'Sent back',
  RECORD_EDITION: 'Recorded the edition of',
  START: 'Started',
  CANCEL: 'Cancelled',
  REPORT: 'Reported',
  CLOSE: 'Closed',
  RECORD_HELD: 'Recorded as held:',
  RECORD_RESPONSE: 'Recorded the response to',
  RAISE: 'Raised',
  ADD_ROOT_CAUSE: 'Added the root cause of',
  PLAN_ACTIONS: 'Planned actions for',
  SUBMIT_NO_ACTION: 'Submitted with no action needed:',
  VERIFY_EFFECTIVE: 'Verified as effective:',
  VERIFY_NOT_EFFECTIVE: 'Found not effective:',
  REOPEN: 'Reopened',
  COMPLETE: 'Completed',
  PLAN: 'Planned',
};

const isIsoStep = (value: string): value is IsoStep => Object.hasOwn(ISO_STEP, value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/** The record's own name when the event carries one ("Legal", "Pune Plant"). Evidence never shows its file name. */
export function recordName(event: AuditEvent): string | null {
  if (event.entityType === 'evidence') return null;
  return (
    text(event.after?.name) ??
    text(event.before?.name) ??
    text(event.after?.title) ??
    text(event.before?.title) ??
    null
  );
}

/**
 * "Added a department", "Submitted an instance", "Closed a nonconformity". A step a client admin or manager took in
 * someone else's place (`after.delegated`) says so.
 */
export function summary(event: AuditEvent): string {
  const words = wording(event);
  return event.after?.delegated === true ? `${words} (as delegate)` : words;
}

function wording(event: AuditEvent): string {
  const entity = ENTITY[event.entityType];
  if (event.action === 'TRANSITION') {
    const step = text(event.after?.action);
    if (step && isIsoStep(step)) return `${ISO_STEP[step]} ${entity}`;
    const state = text(event.after?.workflowState);
    const pendingNa = event.after?.pendingKind === 'NA';
    const verb =
      state === 'SUBMITTED' && pendingNa
        ? 'Asked to mark as not applicable:'
        : ((state && WORKFLOW[state]) ?? 'Moved');
    return `${verb} ${entity}`;
  }
  if (event.action === 'APPLICABILITY_CHANGE') return `Changed whether ${entity} applies`;
  if (event.action === 'IMPORT' && event.entityType === 'import_batch')
    return 'Committed an import';
  if (event.action === 'EXPORT' && event.entityType === 'export') return 'Started an export';
  return `${VERB[event.action]} ${entity}`;
}

/** Fields whose change the trail spells out, with the words it uses for them. Other fields are counted only. */
const FIELD_LABEL: Record<string, string> = {
  name: 'Name',
  title: 'Title',
  email: 'Email',
  dueDate: 'Due date',
  status: 'Status',
  workflowState: 'State',
  aliases: 'Other spellings',
  rows: 'Rows',
  // ISO records (docs/iso/model.md §3). Their long texts are not spelled out, and incident details never reach events.
  state: 'State',
  revision: 'Revision',
  severity: 'Severity',
  significant: 'Significant',
  climateRelated: 'Climate related',
  result: 'Result',
  dueOn: 'Due date',
  plannedOn: 'Planned for',
  plannedStart: 'Planned start',
  plannedEnd: 'Planned end',
  startOn: 'Start',
  endOn: 'End',
  heldOn: 'Held on',
  reportedOn: 'Reported on',
  reviewedOn: 'Reviewed on',
  lastReviewedOn: 'Last reviewed',
  reviewDueOn: 'Next review',
  responseDueOn: 'Response due',
  effectivenessDueOn: 'Effectiveness check due',
  doneOn: 'Done on',
  closedOn: 'Closed on',
  issuedOn: 'Issued on',
  expiresOn: 'Expires on',
  climateDecidedOn: 'Climate decision on',
};

/** A code in sentence case, one space per underscore: ROOT_CAUSE_FOUND reads "Root cause found" (model §4.7). */
const sentence = (code: string): string => {
  const words = code.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** One word map per contracts enum, every value by the §4.7 rule (none of these enums has an exception). */
const byRule = <T extends string>(values: readonly T[]): Record<T, string> =>
  Object.fromEntries(values.map((value) => [value, sentence(value)])) as Record<T, string>;

/** An instance's stored state in the status-language words (packages/ui/spec/status-language.md). */
const INSTANCE_STATE: Record<WorkflowState, string> = {
  OPEN: 'Open',
  SUBMITTED: 'Awaiting approval',
  SENT_BACK: 'Sent back',
  APPROVED: 'Approved',
  NOT_APPLICABLE: 'Not applicable',
};

/**
 * The words for a coded field, by the record's entity type and the field, since `state` and `status` name different
 * enums on different records. A risk item's `severity` is a number, so only a nonconformity's has words. Fields
 * without a map show their value as it is.
 */
export const VALUE_WORDS: Partial<
  Record<EntityType | IsoEntityType, Record<string, Readonly<Record<string, string>>>>
> = {
  instance: { workflowState: INSTANCE_STATE },
  person: { status: byRule(PersonStatus.options) },
  management_system: { status: byRule(ManagementSystemStatus.options) },
  clause_assessment: { status: byRule(ClauseStatus.options) },
  controlled_document: { status: byRule(DocumentStatus.options) },
  document_revision: { state: byRule(RevisionState.options) },
  internal_audit: { state: byRule(InternalAuditState.options) },
  audit_checklist_item: { result: byRule(ChecklistResult.options) },
  external_audit: { state: byRule(ExternalAuditState.options) },
  nonconformity: { state: byRule(NcState.options), severity: byRule(NcSeverity.options) },
  iso_action: { state: byRule(IsoActionState.options) },
  management_review: { state: byRule(ManagementReviewState.options) },
};

const shown = (value: unknown): string | null => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '—' : value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value.length === 0 ? '—' : value.join(', ');
  }
  return null;
};

/** "Name: Legal → Legal and Secretarial"; evidence and nested values are left out. */
export function changes(event: AuditEvent): string[] {
  if (event.entityType === 'evidence' || event.action.startsWith('EVIDENCE')) return [];
  const before = event.before ?? {};
  const after = event.after ?? {};
  const lines: string[] = [];
  const words = VALUE_WORDS[event.entityType];
  const worded = (key: string, value: unknown): unknown => {
    const map = words?.[key];
    return map && typeof value === 'string' && Object.hasOwn(map, value) ? map[value] : value;
  };
  for (const [key, label] of Object.entries(FIELD_LABEL)) {
    if (!(key in before) && !(key in after)) continue;
    const from = shown(worded(key, before[key]));
    const to = shown(worded(key, after[key]));
    if (from === null || to === null || from === to) continue;
    lines.push(event.before ? `${label}: ${from} → ${to}` : `${label}: ${to}`);
  }
  return lines;
}

export type AuditRow = {
  id: string;
  at: string;
  who: string;
  what: string;
  record: string;
  details: string[];
  reason: string | null;
};

/** One row per event, in the API's order (newest first). A person the page can't name is "Someone". */
export function auditRows(
  events: readonly AuditEvent[],
  names: Readonly<Record<string, string>>,
): AuditRow[] {
  return events.map((event) => ({
    id: event.id,
    at: event.at,
    who:
      event.actorKind === 'SYSTEM'
        ? 'System'
        : event.actorKind === 'IMPORT'
          ? 'Import'
          : ((event.actorId && names[event.actorId]) ?? 'Someone'),
    what: summary(event),
    record: recordName(event) ?? '—',
    details: changes(event),
    reason: event.reason,
  }));
}
