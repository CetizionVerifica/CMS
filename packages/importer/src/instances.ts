import type { LocalDate, WorkflowState } from '@canopy/contracts';
import type { PlanInstance } from './types.js';

/**
 * Re-importing a register over instances that already exist (packages/importer/CLAUDE.md "Re-import").
 * The register is a snapshot, while the app keeps working on the instances in between, so a planned
 * instance is compared field by field rather than by fingerprint:
 * - Comments are append-only. Incoming comments already on the instance, in order, change nothing;
 *   the others are appended.
 * - An instance someone has submitted or sent back stays where the workflow put it when the register
 *   still says Pending with no Activity Date (the register is older than that step). It is never moved
 *   back to OPEN by an import.
 */

/** A stored instance as the importer compares it. Owner and approver are person `nameNormalized`. */
export interface ExistingInstance {
  workflowState: WorkflowState;
  completedOn: LocalDate | null;
  naReason: string | null;
  owner: string;
  approver: string;
  /** Comment bodies, oldest first. */
  comments: string[];
}

/** What a commit changes on an existing instance. */
export interface InstanceChange {
  /** The new workflow fields, or null when the state stays. */
  state: Pick<PlanInstance, 'workflowState' | 'completedOn' | 'naReason'> | null;
  /** The new owner or approver (`nameNormalized`), or null when unchanged. */
  owner: string | null;
  approver: string | null;
  /** Comments to append, oldest first. */
  newComments: string[];
}

const WORKFLOW_KEEPS: readonly WorkflowState[] = ['SUBMITTED', 'SENT_BACK'];

/** Incoming comments not already on the instance as an in-order subsequence of its comments. */
export function commentsToAppend(incoming: readonly string[], stored: readonly string[]): string[] {
  const missing: string[] = [];
  let next = 0;
  for (const body of incoming) {
    const found = stored.indexOf(body, next);
    if (found === -1) missing.push(body);
    else next = found + 1;
  }
  return missing;
}

/** The change a commit makes to `existing`, or null when the planned instance leaves it unchanged. */
export function instanceChange(
  planned: PlanInstance,
  existing: ExistingInstance,
): InstanceChange | null {
  const keepsWorkflow =
    WORKFLOW_KEEPS.includes(existing.workflowState) &&
    planned.workflowState === 'OPEN' &&
    planned.completedOn === null;
  const stateDiffers =
    planned.workflowState !== existing.workflowState ||
    planned.completedOn !== existing.completedOn ||
    planned.naReason !== existing.naReason;
  const change: InstanceChange = {
    state:
      !keepsWorkflow && stateDiffers
        ? {
            workflowState: planned.workflowState,
            completedOn: planned.completedOn,
            naReason: planned.naReason,
          }
        : null,
    owner: planned.owner === existing.owner ? null : planned.owner,
    approver: planned.approver === existing.approver ? null : planned.approver,
    newComments: commentsToAppend(planned.comments, existing.comments),
  };
  const changes =
    change.state !== null ||
    change.owner !== null ||
    change.approver !== null ||
    change.newComments.length > 0;
  return changes ? change : null;
}

/** The instance as a commit leaves it: new from the plan, or `existing` with `change` applied. */
export function instanceAfterCommit(
  planned: PlanInstance,
  existing: ExistingInstance | undefined,
): ExistingInstance {
  if (!existing) {
    return {
      workflowState: planned.workflowState,
      completedOn: planned.completedOn,
      naReason: planned.naReason,
      owner: planned.owner,
      approver: planned.approver,
      comments: [...planned.comments],
    };
  }
  const change = instanceChange(planned, existing);
  if (!change) return existing;
  return {
    ...existing,
    ...(change.state ?? {}),
    owner: change.owner ?? existing.owner,
    approver: change.approver ?? existing.approver,
    comments: [...existing.comments, ...change.newComments],
  };
}
