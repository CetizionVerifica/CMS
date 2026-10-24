// How the audit trail words a client's audit events. Display only: the events, their order and who may read them come
// from the API (M7). Evidence events name no file, so nothing from evidence reaches the page (root CLAUDE.md rule 6).
import type { AuditEvent } from '@canopy/contracts';

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

// 'account' is listed ahead of contracts 1.5.1, which adds it to EntityType for the entries the platform's changes to an
// account write (ADR M15-0003); naming it here keeps this map complete before and after that bump.
const ENTITY: Record<EntityType | 'account', string> = {
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

/** "Added a department", "Submitted an instance", "Moved the due date of an instance". */
export function summary(event: AuditEvent): string {
  const entity = ENTITY[event.entityType];
  if (event.action === 'TRANSITION') {
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
};

const shown = (value: unknown): string | null => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '—' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
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
  for (const [key, label] of Object.entries(FIELD_LABEL)) {
    if (!(key in before) && !(key in after)) continue;
    const from = shown(before[key]);
    const to = shown(after[key]);
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
