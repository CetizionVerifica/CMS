// How the drawer words an instance's history and comments: audit events as Timeline entries, comment kinds as tags.
// Display only; the events themselves come from the API.
import type { AuditEvent, Comment } from '@canopy/contracts';
import { formatDate, type TimelineEvent } from '@canopy/ui';

const WORKFLOW_LABEL: Record<string, { kind: string; summary: string }> = {
  APPROVED: { kind: 'approved', summary: 'approved it' },
  NOT_APPLICABLE: { kind: 'na_approved', summary: 'approved it as not applicable' },
  SENT_BACK: { kind: 'sent_back', summary: 'sent it back' },
};

/** "submitted it", "sent it back", … for a TRANSITION event, from the workflow state it moved to. */
function transition(event: AuditEvent): { kind: string; summary: string } {
  const before = event.before?.workflowState;
  const after = event.after?.workflowState;
  if (after === 'SUBMITTED') {
    return event.after?.pendingKind === 'NA'
      ? { kind: 'na_requested', summary: 'asked to mark it not applicable' }
      : { kind: 'submitted', summary: 'submitted it' };
  }
  if (after === 'OPEN' && (before === 'APPROVED' || before === 'NOT_APPLICABLE')) {
    return { kind: 'reopened', summary: 'reopened it' };
  }
  return (
    (typeof after === 'string' ? WORKFLOW_LABEL[after] : undefined) ?? {
      kind: 'updated',
      summary: 'changed its state',
    }
  );
}

const ACTION_LABEL: Partial<Record<AuditEvent['action'], { kind: string; summary: string }>> = {
  CREATE: { kind: 'created', summary: 'created it' },
  UPDATE: { kind: 'updated', summary: 'updated it' },
  ARCHIVE: { kind: 'archived', summary: 'archived it' },
  RESTORE: { kind: 'restored', summary: 'restored it' },
  REASSIGN: { kind: 'reassigned', summary: 'reassigned it' },
  DUE_DATE_CHANGE: { kind: 'due_date_changed', summary: 'moved the due date' },
  APPLICABILITY_CHANGE: { kind: 'updated', summary: 'changed whether it applies' },
  EVIDENCE_ADD: { kind: 'evidence_added', summary: 'added evidence' },
  EVIDENCE_REMOVE: { kind: 'evidence_removed', summary: 'removed evidence' },
  EVIDENCE_DOWNLOAD: { kind: 'evidence_downloaded', summary: 'downloaded evidence' },
  IMPORT: { kind: 'created', summary: 'imported it' },
};

const asDate = (value: unknown) => (typeof value === 'string' ? formatDate(value) : undefined);

/** The instance's audit events as the Timeline shows them. A person the drawer can't name is "Someone". */
export function timelineEvents(
  events: readonly AuditEvent[],
  names: Readonly<Record<string, string>>,
): TimelineEvent[] {
  return events.map((event) => {
    const label =
      event.action === 'TRANSITION'
        ? transition(event)
        : (ACTION_LABEL[event.action] ?? { kind: 'updated', summary: 'updated it' });
    const detail: NonNullable<TimelineEvent['detail']> = {};
    if (event.reason) detail.reason = event.reason;
    if (event.action === 'DUE_DATE_CHANGE') {
      const from = asDate(event.before?.dueDate);
      const to = asDate(event.after?.dueDate);
      if (from) detail.from = from;
      if (to) detail.to = to;
    }
    return {
      id: event.id,
      at: event.at,
      actor:
        event.actorKind === 'PERSON' && event.actorId
          ? { name: names[event.actorId] ?? 'Someone' }
          : 'system',
      kind: label.kind,
      summary: label.summary,
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    };
  });
}

const COMMENT_LABEL: Record<Comment['kind'], string | null> = {
  NOTE: null,
  SUBMIT: 'Submitted',
  NA_REQUEST: 'Asked for not applicable',
  APPROVE: 'Approved',
  SEND_BACK: 'Sent back',
  REOPEN: 'Reopened',
  IMPORT: 'Imported',
};

/** The tag before a workflow comment ("Sent back"); a plain note has none. */
export function commentLabel(kind: Comment['kind']): string | null {
  return COMMENT_LABEL[kind];
}
