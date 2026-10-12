import type {
  Comment,
  ComplianceInstance,
  RequestContext,
  Role,
  WorkflowState,
} from '@canopy/contracts';
import { domainEvents, type TenantTx } from '@canopy/db';
import { rolesIn } from './scope.js';
import type { TransitionCommand } from './workflow.js';

/**
 * Outbox events M7 produces (docs/contracts/events.md §3), written in the same transaction as the change
 * and its AuditEvent. Payloads carry ids, enums and dates only, never names, comments or reasons.
 */

export interface InstanceEvent {
  type: string;
  data: Record<string, unknown>;
}

/** The roles that may reopen, most specific first; `byRole` names the one the actor holds. */
const REOPEN_ROLES: readonly Role[] = ['CLIENT_ADMIN', 'CONSULTANT', 'FIRM_ADMIN'];

/** The event for one workflow move, from the instance before and after it. */
export function transitionEvent(
  ctx: RequestContext,
  command: TransitionCommand,
  before: ComplianceInstance,
  after: ComplianceInstance,
): InstanceEvent {
  const instanceId = after.id;
  switch (command.action) {
    case 'SUBMIT':
    case 'REQUEST_NA':
      return {
        type: 'instance.submitted',
        data: {
          instanceId,
          kind: after.pendingKind,
          ownerId: after.ownerId,
          approverId: after.approverId,
          dueDate: after.dueDate,
          completedOn: after.completedOn,
        },
      };
    case 'APPROVE':
      return {
        type: 'instance.approved',
        data: {
          instanceId,
          approverId: ctx.personId,
          resultState: after.workflowState,
          delegated: ctx.personId !== before.approverId,
          completedOn: after.completedOn,
        },
      };
    case 'SEND_BACK':
      return {
        type: 'instance.sent_back',
        data: { instanceId, approverId: ctx.personId, ownerId: after.ownerId },
      };
    case 'REOPEN': {
      const held = rolesIn(ctx, after.clientId);
      const byRole = REOPEN_ROLES.find((role) => held.has(role)) ?? null;
      return {
        type: 'instance.reopened',
        data: { instanceId, previousState: before.workflowState satisfies WorkflowState, byRole },
      };
    }
  }
}

export function commentAddedEvent(comment: Comment): InstanceEvent {
  return {
    type: 'comment.added',
    data: {
      commentId: comment.id,
      instanceId: comment.instanceId,
      kind: comment.kind,
      authorId: comment.authorId,
    },
  };
}

/** Writes `event` to the outbox in the caller's transaction. */
export function emit(
  tx: TenantTx,
  ctx: RequestContext,
  event: InstanceEvent,
  clientId: string,
  aggregate: { type: string; id: string; version: number },
): Promise<void> {
  return domainEvents.enqueue(tx, {
    type: event.type,
    clientId,
    actor: { kind: 'PERSON', personId: ctx.personId },
    requestId: ctx.requestId,
    aggregate: { type: aggregate.type, id: aggregate.id },
    aggregateVersion: aggregate.version,
    data: event.data,
  });
}
