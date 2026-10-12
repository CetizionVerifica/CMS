import {
  InstanceAction,
  WorkflowState,
  type Action,
  type Can,
  type RequestContext,
  type Resource,
} from '@canopy/contracts';
import { ACTIVE_STATES, TRANSITION_SOURCES } from './workflow.js';

/** The `can()` action behind each instance action (docs/contracts/endpoints.md §4). */
export const INSTANCE_ACTION_POLICY: Readonly<Record<InstanceAction, Action>> = {
  SUBMIT: 'instance.submit',
  REQUEST_NA: 'instance.submit',
  APPROVE: 'instance.approve',
  SEND_BACK: 'instance.approve',
  REOPEN: 'instance.reopen',
  REASSIGN: 'instance.reassign',
  CHANGE_DUE_DATE: 'instance.due_date',
  COMMENT: 'comment.write',
  UPLOAD_EVIDENCE: 'evidence.write',
};

/** States in which each action is offered, before permissions. */
export const ACTION_STATES: Readonly<Record<InstanceAction, readonly WorkflowState[]>> = {
  ...TRANSITION_SOURCES,
  REASSIGN: ACTIVE_STATES,
  CHANGE_DUE_DATE: ACTIVE_STATES,
  UPLOAD_EVIDENCE: ACTIVE_STATES,
  COMMENT: WorkflowState.options,
};

/** What `allowedActions` reads from an instance. */
export interface ActionTarget {
  workflowState: WorkflowState;
  clientId: string;
  unitId: string;
  ownerId: string;
  approverId: string;
}

/** The `can()` resource for an instance; owner and approver drive the "own" cells of the role matrix. */
export function instanceResource(i: ActionTarget): Resource {
  return {
    type: 'instance',
    clientId: i.clientId,
    unitId: i.unitId,
    ownerId: i.ownerId,
    approverId: i.approverId,
  };
}

/**
 * InstanceDetail.allowedActions: the actions the state machine allows now and `can()` allows this person.
 * Listed in contract order. The UI shows only these; every route still checks both again.
 */
export function allowedActions(i: ActionTarget, ctx: RequestContext, can: Can): InstanceAction[] {
  const resource = instanceResource(i);
  return InstanceAction.options.filter(
    (action) =>
      ACTION_STATES[action].includes(i.workflowState) &&
      can(ctx, INSTANCE_ACTION_POLICY[action], resource),
  );
}
