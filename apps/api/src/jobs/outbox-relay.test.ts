import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RELAY_BATCH, runRelayOutbox } from './outbox-relay.js';
import type { EventBus, OutboxEvent } from './ports.js';
import { harness } from './testing/builders.js';
import { memoryFirm, outboxRow, type MemoryFirm } from './testing/memory-store.js';

function event(firm: MemoryFirm, type: string) {
  const row = outboxRow({
    type,
    clientId: null,
    actor: { kind: 'SYSTEM', job: 'test' },
    requestId: 'req:1',
    aggregate: { type: 'assignment', id: randomUUID() },
    aggregateVersion: 1,
    data: { assignmentId: randomUUID() },
  });
  firm.events.push(row);
  return row;
}

function recordingBus(types: string[], failing = new Set<string>()) {
  const published: OutboxEvent[] = [];
  const bus: EventBus & { published: OutboxEvent[] } = {
    published,
    consumes: (type) => types.includes(type),
    publish: async (e) => {
      if (failing.has(e.id)) throw new Error('queue unavailable');
      published.push(e);
    },
  };
  return bus;
}

describe('relay-outbox', () => {
  it('publishes consumed types with the firm on the envelope, marks the rest published unsent', async () => {
    const firm = memoryFirm();
    const created = event(firm, 'assignment.created');
    const other = event(firm, 'unit.updated');
    const h = harness([firm]);
    const bus = recordingBus(['assignment.created']);

    const report = await runRelayOutbox({ ...h.deps, bus }, 'job:relay-outbox:1');

    expect(report).toEqual({ firms: 1, published: 1, skipped: 1, failed: 0 });
    expect(bus.published).toEqual([
      expect.objectContaining({
        id: created.id,
        type: 'assignment.created',
        firmId: firm.id,
        schemaVersion: 1,
        data: created.data,
      }),
    ]);
    const stored = h.store.firms[0]!.events;
    expect(stored.find((e) => e.id === created.id)!.publishedAt).not.toBeNull();
    expect(stored.find((e) => e.id === other.id)!.publishedAt).not.toBeNull();
  });

  it('publishes nothing twice: a second run finds no unpublished events', async () => {
    const firm = memoryFirm();
    event(firm, 'assignment.created');
    const h = harness([firm]);
    const bus = recordingBus(['assignment.created']);
    await runRelayOutbox({ ...h.deps, bus }, 'job:relay-outbox:1');
    const again = await runRelayOutbox({ ...h.deps, bus }, 'job:relay-outbox:2');
    expect(again).toMatchObject({ published: 0, skipped: 0 });
    expect(bus.published).toHaveLength(1);
  });

  it('leaves a failed event unpublished with its attempt counted, keeps the rest, and fails the run', async () => {
    const firm = memoryFirm();
    const ok = event(firm, 'assignment.created');
    const bad = event(firm, 'assignment.created');
    const h = harness([firm]);
    const bus = recordingBus(['assignment.created'], new Set([bad.id]));

    await expect(runRelayOutbox({ ...h.deps, bus }, 'job:relay-outbox:1')).rejects.toThrow(
      'relay-outbox: 1 event(s) not published',
    );
    const stored = h.store.firms[0]!.events;
    expect(stored.find((e) => e.id === ok.id)!.publishedAt).not.toBeNull();
    expect(stored.find((e) => e.id === bad.id)).toMatchObject({ publishedAt: null, attempts: 1 });

    // The queue is back: the next run publishes the one left over.
    const retry = await runRelayOutbox(
      { ...h.deps, bus: recordingBus(['assignment.created']) },
      'job:relay-outbox:2',
    );
    expect(retry).toMatchObject({ published: 1, failed: 0 });
  });

  it('drains a firm with more than one batch in the same run', async () => {
    const firm = memoryFirm();
    for (let i = 0; i < RELAY_BATCH + 5; i += 1) event(firm, 'assignment.created');
    const h = harness([firm]);
    const bus = recordingBus(['assignment.created']);
    const report = await runRelayOutbox({ ...h.deps, bus }, 'job:relay-outbox:1');
    expect(report.published).toBe(RELAY_BATCH + 5);
    expect(h.store.firms[0]!.events.every((e) => e.publishedAt !== null)).toBe(true);
  });

  it("publishes each firm's events with that firm's id", async () => {
    const a = memoryFirm();
    const b = memoryFirm();
    event(a, 'assignment.created');
    event(b, 'assignment.created');
    const h = harness([a, b]);
    const bus = recordingBus(['assignment.created']);
    await runRelayOutbox({ ...h.deps, bus }, 'job:relay-outbox:1');
    expect(bus.published.map((e) => e.firmId).sort()).toEqual([a.id, b.id].sort());
  });

  it("refuses to run without the runner's event bus", async () => {
    const h = harness([memoryFirm()]);
    await expect(runRelayOutbox(h.deps, 'job:relay-outbox:1')).rejects.toThrow('event bus');
  });
});
