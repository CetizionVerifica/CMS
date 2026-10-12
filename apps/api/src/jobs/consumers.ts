import { Id } from '@canopy/contracts';
import { z } from 'zod';
import { generateForScope, type GenerationScope } from './generate-instances.js';
import type { JobDeps, JobReport, OutboxEvent } from './ports.js';

/**
 * The events.md §2 envelope as it arrives from pg-boss. Parsed before use: the payload crossed a queue. Data fields
 * each consumer reads are parsed by its own schema; other fields are kept as they are.
 */
export const OutboxEventSchema = z.object({
  id: Id,
  type: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
  schemaVersion: z.int().min(1),
  occurredAt: z.string(),
  firmId: Id,
  clientId: Id.nullable(),
  actor: z.record(z.string(), z.unknown()),
  requestId: z.string().min(1),
  aggregate: z.object({ type: z.string(), id: Id }),
  aggregateVersion: z.int().min(1),
  data: z.record(z.string(), z.unknown()),
});

export interface Consumer {
  /** The event type, which is also the pg-boss queue name. */
  type: string;
  /** Idempotent: an event can arrive more than once (events.md §1). */
  handle(deps: JobDeps, event: OutboxEvent, requestId: string): Promise<JobReport>;
}

const AssignmentData = z.object({ assignmentId: Id });
const ObligationPushedData = z.object({ obligationId: Id, clientIds: z.array(Id) });
const ImportCommittedData = z.object({ assignmentIds: z.array(Id) });

const inClient = (event: OutboxEvent): GenerationScope['clientIds'] =>
  event.clientId === null ? 'ALL' : [event.clientId];

/** Generates the instances an assignment now needs, as the nightly run would, as soon as it changes. */
const assignmentConsumer = (type: string): Consumer => ({
  type,
  handle: async (deps, event, requestId) =>
    generateForScope(
      deps,
      event.firmId,
      {
        clientIds: inClient(event),
        assignmentIds: [AssignmentData.parse(event.data).assignmentId],
      },
      requestId,
    ),
});

/**
 * Regeneration on change (apps/api/CLAUDE.md Jobs): a new or changed assignment, a new applicability, a library
 * rule pushed to clients and a committed import each get their current and next FY now. Generation only adds
 * missing periods; it never moves or removes an existing instance.
 */
export const CONSUMERS: readonly Consumer[] = [
  assignmentConsumer('assignment.created'),
  assignmentConsumer('assignment.changed'),
  assignmentConsumer('assignment.applicability_changed'),
  {
    type: 'obligation.pushed',
    handle: async (deps, event, requestId) => {
      const data = ObligationPushedData.parse(event.data);
      return generateForScope(
        deps,
        event.firmId,
        { clientIds: data.clientIds, obligationId: data.obligationId },
        requestId,
      );
    },
  },
  {
    type: 'import.committed',
    handle: async (deps, event, requestId) =>
      generateForScope(
        deps,
        event.firmId,
        {
          clientIds: inClient(event),
          assignmentIds: ImportCommittedData.parse(event.data).assignmentIds,
        },
        requestId,
      ),
  },
];
