import type { Id } from '@canopy/contracts';
import type { Tx } from './store.js';

/** Outbox events M6 produces (docs/contracts/events.md §3). Payloads carry ids and enums only, never names. */
export type M6Event =
  | { type: 'client.created' | 'client.updated'; data: { clientId: Id; changed: string[] } }
  | {
      type: 'unit.created' | 'unit.updated' | 'unit.archived';
      data: { unitId: Id; companyId: Id; locationId: Id };
    }
  | {
      type: 'obligation.created' | 'obligation.updated';
      data: { obligationId: Id; libraryVersion: number; changed: string[] };
    }
  | {
      type: 'obligation.pushed';
      data: { obligationId: Id; libraryVersion: number; clientIds: Id[] };
    }
  | {
      type: 'assignment.created';
      data: {
        assignmentId: Id;
        obligationId: Id;
        unitId: Id;
        departmentId: Id;
        defaultOwnerId: Id;
        defaultApproverId: Id;
        applicability: string;
      };
    }
  | {
      type: 'assignment.changed';
      data: { assignmentId: Id; changed: string[]; appliedToOpen: boolean };
    }
  | {
      type: 'assignment.applicability_changed';
      data: { assignmentId: Id; from: string; to: string };
    }
  | { type: 'assignment.archived'; data: { assignmentId: Id } }
  | {
      type: 'alias.merged';
      data: {
        entityType: 'act' | 'category' | 'department' | 'person';
        targetId: Id;
        sourceIds: Id[];
      };
    }
  | {
      type: 'membership.changed';
      data: {
        membershipId: Id;
        personId: Id;
        role: string;
        clientId: Id | null;
        change: 'GRANTED' | 'UPDATED' | 'REVOKED';
      };
    }
  | {
      type: 'instance.reassigned';
      data: {
        instanceId: Id;
        ownerId: { from: Id | null; to: Id } | null;
        approverId: { from: Id | null; to: Id } | null;
      };
    };

export function emit(
  tx: Tx,
  event: M6Event,
  aggregate: { type: string; id: Id; version: number },
  clientId: Id | null,
): Promise<void> {
  return tx.emit({
    type: event.type,
    clientId,
    aggregate: { type: aggregate.type, id: aggregate.id },
    aggregateVersion: aggregate.version,
    data: event.data,
  });
}
