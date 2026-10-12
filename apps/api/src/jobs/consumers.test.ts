import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONSUMERS, OutboxEventSchema } from './consumers.js';
import type { OutboxEvent } from './ports.js';
import { assignment, harness, person } from './testing/builders.js';
import { memoryClient, memoryFirm } from './testing/memory-store.js';

// 12 Oct 2026, 07:00 IST: the current and next FY are Apr 2026 to Mar 2028, 24 monthly periods.
function setup() {
  const firm = memoryFirm();
  const client = memoryClient('Aditya Birla Group');
  const other = memoryClient('Tata Group');
  const owner = person({ clientIds: [client.id, other.id] });
  const approver = person({ clientIds: [client.id, other.id] });
  firm.clients.push(client, other);
  firm.people.push(owner, approver);
  const a = assignment(client, owner, approver);
  const b = assignment(client, owner, approver);
  const c = assignment(other, owner, approver, { obligationId: a.obligationId });
  firm.assignments.push(a, b, c);
  return { firm, client, other, a, b, c, h: harness([firm]) };
}

function envelope(
  firmId: string,
  type: string,
  data: Record<string, unknown>,
  clientId: string | null,
): OutboxEvent {
  return {
    id: randomUUID(),
    type,
    schemaVersion: 1,
    occurredAt: '2026-10-12T01:00:00.000Z',
    firmId,
    clientId,
    actor: { kind: 'PERSON', personId: randomUUID() },
    requestId: 'req:1',
    aggregate: { type: 'assignment', id: randomUUID() },
    aggregateVersion: 1,
    data,
  };
}

const consumer = (type: string) => CONSUMERS.find((c) => c.type === type)!;
const countFor = (h: ReturnType<typeof setup>['h'], assignmentId: string) =>
  h.store.firms[0]!.instances.filter((i) => i.assignmentId === assignmentId).length;

describe('event consumers', () => {
  it.each(['assignment.created', 'assignment.changed', 'assignment.applicability_changed'])(
    '%s generates that assignment only, with audit rows under the event request id',
    async (type) => {
      const { firm, client, a, b, c, h } = setup();
      const event = envelope(firm.id, type, { assignmentId: a.assignmentId }, client.id);
      const report = await consumer(type).handle(h.deps, event, `job:${type}:${event.id}`);
      expect(report).toMatchObject({ clients: 1, created: 24 });
      expect(countFor(h, a.assignmentId)).toBe(24);
      expect(countFor(h, b.assignmentId)).toBe(0);
      expect(countFor(h, c.assignmentId)).toBe(0);
      expect(h.store.firms[0]!.audits.every((e) => e.requestId === `job:${type}:${event.id}`)).toBe(
        true,
      );
    },
  );

  it('is idempotent: the same event handled twice creates nothing the second time', async () => {
    const { firm, client, a, h } = setup();
    const event = envelope(
      firm.id,
      'assignment.created',
      { assignmentId: a.assignmentId },
      client.id,
    );
    await consumer('assignment.created').handle(h.deps, event, 'r1');
    const again = await consumer('assignment.created').handle(h.deps, event, 'r2');
    expect(again).toMatchObject({ created: 0 });
    expect(countFor(h, a.assignmentId)).toBe(24);
  });

  it('generates nothing for an assignment made not applicable', async () => {
    const { firm, client, a, h } = setup();
    h.store.firms[0]!.assignments[0]!.applicability = 'NOT_APPLICABLE';
    const event = envelope(
      firm.id,
      'assignment.applicability_changed',
      { assignmentId: a.assignmentId, from: 'APPLICABLE', to: 'NOT_APPLICABLE' },
      client.id,
    );
    const report = await consumer('assignment.applicability_changed').handle(h.deps, event, 'r1');
    expect(report).toMatchObject({ created: 0, skippedNOT_APPLICABLE: 1 });
  });

  it('looks in every client when the event names none', async () => {
    const { firm, c, h } = setup();
    const event = envelope(firm.id, 'assignment.created', { assignmentId: c.assignmentId }, null);
    const report = await consumer('assignment.created').handle(h.deps, event, 'r1');
    expect(report).toMatchObject({ clients: 2, created: 24 });
    expect(countFor(h, c.assignmentId)).toBe(24);
  });

  it("obligation.pushed regenerates that obligation's assignments in the pushed clients only", async () => {
    const { firm, other, a, b, c, h } = setup();
    const event = envelope(
      firm.id,
      'obligation.pushed',
      { obligationId: a.obligationId, libraryVersion: 2, clientIds: [other.id] },
      null,
    );
    const report = await consumer('obligation.pushed').handle(h.deps, event, 'r1');
    expect(report).toMatchObject({ clients: 1, created: 24 });
    expect(countFor(h, c.assignmentId)).toBe(24);
    expect(countFor(h, a.assignmentId)).toBe(0);
    expect(countFor(h, b.assignmentId)).toBe(0);
  });

  it("import.committed generates the batch's assignments", async () => {
    const { firm, client, a, b, c, h } = setup();
    const event = envelope(
      firm.id,
      'import.committed',
      {
        batchId: randomUUID(),
        created: {},
        updated: {},
        assignmentIds: [a.assignmentId, b.assignmentId],
      },
      client.id,
    );
    const report = await consumer('import.committed').handle(h.deps, event, 'r1');
    expect(report).toMatchObject({ created: 48 });
    expect(countFor(h, c.assignmentId)).toBe(0);
  });

  it('rejects an event whose data lacks the ids it needs', async () => {
    const { firm, client, h } = setup();
    const event = envelope(firm.id, 'assignment.created', { assignmentId: 'not-an-id' }, client.id);
    await expect(consumer('assignment.created').handle(h.deps, event, 'r1')).rejects.toThrow();
  });

  it('parses the envelope pg-boss hands back, and rejects one without a firm', () => {
    const event = envelope(
      randomUUID(),
      'assignment.created',
      { assignmentId: randomUUID() },
      null,
    );
    expect(OutboxEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(() => OutboxEventSchema.parse({ ...event, firmId: undefined })).toThrow();
  });
});
