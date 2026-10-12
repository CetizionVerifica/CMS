import type {
  CommentKind,
  InstanceAction,
  LocalDate,
  ScanStatus,
  SubmissionKind,
  WorkflowState,
} from '@canopy/contracts';
import { compareDates } from '@canopy/engine';
import { ApiError } from '../../auth/index.js';

/**
 * The instance state machine (apps/api/CLAUDE.md, "Instance workflow"). Pure: it reads no clock and no
 * database. The service loads the instance, calls `planTransition`, then writes the patch, the comment and
 * the audit event in one transaction with `WHERE version = expectedVersion`.
 *
 * ```
 * OPEN ──submit──▶ SUBMITTED(COMPLETION) ──approve──▶ APPROVED
 * SUBMITTED ──sendBack──▶ SENT_BACK ──submit──▶ SUBMITTED
 * OPEN|SENT_BACK ──requestNA──▶ SUBMITTED(NA) ──approve──▶ NOT_APPLICABLE
 * APPROVED|NOT_APPLICABLE ──reopen──▶ OPEN
 * ```
 */

/** The instance fields the workflow reads and writes. */
export interface WorkflowFields {
  workflowState: WorkflowState;
  pendingKind: SubmissionKind | null;
  completedOn: LocalDate | null;
  naReason: string | null;
  /** UTC instants. */
  submittedAt: string | null;
  approvedAt: string | null;
}

export interface WorkflowInstance extends WorkflowFields {
  id: string;
  version: number;
  approverId: string;
}

export type TransitionCommand =
  | { action: 'SUBMIT'; completedOn: LocalDate; comment: string }
  | { action: 'REQUEST_NA'; reason: string }
  | { action: 'APPROVE'; comment?: string | undefined }
  | { action: 'SEND_BACK'; reason: string }
  | { action: 'REOPEN'; reason: string };

export type TransitionAction = TransitionCommand['action'];

export interface TransitionInput {
  instance: WorkflowInstance;
  /** The version the caller last read; a mismatch is STALE_VERSION. */
  expectedVersion: number;
  command: TransitionCommand;
  /** The person acting. Who may act is decided by `can()` before this runs. */
  actorId: string;
  /** Today in the client's time zone. */
  asOf: LocalDate;
  /** Now as a UTC instant, for submittedAt and approvedAt. */
  now: string;
  /** Whether the obligation needs evidence before a completion can be submitted. */
  evidenceRequired: boolean;
  /** Scan status of each live (not archived) evidence file on the instance. */
  evidence: readonly ScanStatus[];
}

export interface TransitionPlan {
  /** Every workflow field after the transition. */
  fields: WorkflowFields;
  version: number;
  /** The comment written with the transition. */
  comment: { kind: CommentKind; body: string };
  /** The AuditEvent written with the transition: changed fields only. */
  audit: {
    action: 'TRANSITION';
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    reason: string | null;
  };
}

/** States each transition starts from. */
export const TRANSITION_SOURCES: Readonly<Record<TransitionAction, readonly WorkflowState[]>> = {
  SUBMIT: ['OPEN', 'SENT_BACK'],
  REQUEST_NA: ['OPEN', 'SENT_BACK'],
  APPROVE: ['SUBMITTED'],
  SEND_BACK: ['SUBMITTED'],
  REOPEN: ['APPROVED', 'NOT_APPLICABLE'],
};

/** States in which the instance can still change hands, move its due date or take evidence (ADR 0004). */
export const ACTIVE_STATES: readonly WorkflowState[] = ['OPEN', 'SENT_BACK', 'SUBMITTED'];

/** The comment kind each transition writes. */
const COMMENT_KIND: Readonly<Record<TransitionAction, CommentKind>> = {
  SUBMIT: 'SUBMIT',
  REQUEST_NA: 'NA_REQUEST',
  APPROVE: 'APPROVE',
  SEND_BACK: 'SEND_BACK',
  REOPEN: 'REOPEN',
};

/** Approval comment when the approver gave none; every transition leaves a comment (apps/api/CLAUDE.md). */
const DEFAULT_APPROVE_COMMENT = 'Approved.';

/** Plain words for error messages people read. */
const ACTION_WORDS: Readonly<Record<TransitionAction, string>> = {
  SUBMIT: 'submit',
  REQUEST_NA: 'request not applicable for',
  APPROVE: 'approve',
  SEND_BACK: 'send back',
  REOPEN: 'reopen',
};

const STATE_WORDS: Readonly<Record<WorkflowState, string>> = {
  OPEN: 'open',
  SUBMITTED: 'waiting for approval',
  SENT_BACK: 'sent back',
  APPROVED: 'approved',
  NOT_APPLICABLE: 'not applicable',
};

/** Whether `action` can start from `state`, before any permission or input check. */
export function canTransition(state: WorkflowState, action: TransitionAction): boolean {
  return TRANSITION_SOURCES[action].includes(state);
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === '') throw new ApiError('REASON_REQUIRED');
  return trimmed;
}

/** SUBMIT carries a comment (contracts 1.1.0 SubmitBody); the edge schema rejects a blank one first. */
function requireComment(comment: string): string {
  const trimmed = comment.trim();
  if (trimmed === '') {
    throw new ApiError('VALIDATION', {
      issues: [{ path: ['comment'], message: 'A comment is required.' }],
    });
  }
  return trimmed;
}

function optionalText(text: string | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

/** An obligation that needs evidence takes a completion only with at least one clean file. */
function checkEvidence(required: boolean, evidence: readonly ScanStatus[]): void {
  if (!required || evidence.includes('CLEAN')) return;
  if (evidence.includes('PENDING')) {
    throw new ApiError(
      'EVIDENCE_NOT_READY',
      { scanStatus: 'PENDING' },
      'Evidence is still being scanned. Submit once the scan finishes.',
    );
  }
  throw new ApiError(
    'EVIDENCE_REQUIRED',
    undefined,
    'This obligation needs at least one evidence file.',
  );
}

function nextFields(input: TransitionInput): {
  fields: WorkflowFields;
  comment: string;
  reason: string | null;
} {
  const { instance: i, command: c, asOf, now } = input;
  switch (c.action) {
    case 'SUBMIT': {
      if (compareDates(c.completedOn, asOf) > 0) {
        throw new ApiError(
          'DATE_IN_FUTURE',
          { today: asOf },
          'The completion date cannot be in the future.',
        );
      }
      checkEvidence(input.evidenceRequired, input.evidence);
      const comment = requireComment(c.comment);
      return {
        fields: {
          workflowState: 'SUBMITTED',
          pendingKind: 'COMPLETION',
          completedOn: c.completedOn,
          naReason: null,
          submittedAt: now,
          approvedAt: null,
        },
        comment,
        reason: null,
      };
    }
    case 'REQUEST_NA': {
      const reason = requireReason(c.reason);
      return {
        fields: {
          workflowState: 'SUBMITTED',
          pendingKind: 'NA',
          completedOn: null,
          naReason: reason,
          submittedAt: now,
          approvedAt: null,
        },
        comment: reason,
        reason,
      };
    }
    case 'APPROVE': {
      const comment = optionalText(c.comment);
      const na = i.pendingKind === 'NA';
      return {
        fields: {
          workflowState: na ? 'NOT_APPLICABLE' : 'APPROVED',
          pendingKind: null,
          // NOT_APPLICABLE records the date NA was signed off (ComplianceInstance.completedOn).
          completedOn: na ? asOf : i.completedOn,
          naReason: i.naReason,
          submittedAt: i.submittedAt,
          approvedAt: now,
        },
        comment: comment ?? DEFAULT_APPROVE_COMMENT,
        reason: comment,
      };
    }
    case 'SEND_BACK': {
      const reason = requireReason(c.reason);
      return {
        fields: {
          workflowState: 'SENT_BACK',
          pendingKind: null,
          completedOn: null,
          naReason: null,
          submittedAt: i.submittedAt,
          approvedAt: null,
        },
        comment: reason,
        reason,
      };
    }
    case 'REOPEN': {
      const reason = requireReason(c.reason);
      return {
        fields: {
          workflowState: 'OPEN',
          pendingKind: null,
          completedOn: null,
          naReason: null,
          submittedAt: null,
          approvedAt: null,
        },
        comment: reason,
        reason,
      };
    }
  }
}

const FIELD_NAMES = [
  'workflowState',
  'pendingKind',
  'completedOn',
  'naReason',
  'submittedAt',
  'approvedAt',
] as const satisfies readonly (keyof WorkflowFields)[];

/**
 * Checks a transition and works out everything it writes. Throws an ApiError for a stale version
 * (STALE_VERSION), a move the state machine does not allow (INVALID_TRANSITION), or bad input
 * (REASON_REQUIRED, DATE_IN_FUTURE, EVIDENCE_REQUIRED, EVIDENCE_NOT_READY).
 */
export function planTransition(input: TransitionInput): TransitionPlan {
  const { instance, command } = input;
  if (input.expectedVersion !== instance.version) {
    throw new ApiError(
      'STALE_VERSION',
      { currentVersion: instance.version },
      'This item changed since you opened it. Reload and retry.',
    );
  }
  if (!canTransition(instance.workflowState, command.action)) {
    const action: InstanceAction = command.action;
    throw new ApiError(
      'INVALID_TRANSITION',
      { from: instance.workflowState, action },
      `Cannot ${ACTION_WORDS[command.action]} an item that is ${STATE_WORDS[instance.workflowState]}.`,
    );
  }

  const { fields, comment, reason } = nextFields(input);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const name of FIELD_NAMES) {
    if (instance[name] !== fields[name]) {
      before[name] = instance[name];
      after[name] = fields[name];
    }
  }
  // A client admin approving in the approver's place is audited as a delegate (endpoints.md §4).
  if (
    (command.action === 'APPROVE' || command.action === 'SEND_BACK') &&
    input.actorId !== instance.approverId
  ) {
    after.delegated = true;
  }

  return {
    fields,
    version: instance.version + 1,
    comment: { kind: COMMENT_KIND[command.action], body: comment },
    audit: { action: 'TRANSITION', before, after, reason },
  };
}
