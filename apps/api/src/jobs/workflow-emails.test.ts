import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONSUMERS } from './consumers.js';
import type { OutboxEvent } from './ports.js';
import { runReminders } from './reminders.js';
import { assignment, harness, instance, person } from './testing/builders.js';
import { memoryClient, memoryFirm } from './testing/memory-store.js';

// 12 Oct 2026, 07:00 IST. The instance is due 15 Oct 2026, three days away.
function setup(state: 'SUBMITTED' | 'SENT_BACK' = 'SUBMITTED') {
  const firm = memoryFirm();
  const client = memoryClient('Kestrel Metals Group');
  const owner = person({
    displayName: 'Asha Rao',
    email: 'asha@example.com',
    clientIds: [client.id],
  });
  const approver = person({
    displayName: 'Vikram Shah',
    email: 'vikram@example.com',
    clientIds: [client.id],
  });
  firm.clients.push(client);
  firm.people.push(owner, approver);
  const a = assignment(client, owner, approver);
  firm.assignments.push(a);
  const i = instance(a, '2026-10-15', {
    workflowState: state,
    pendingKind: state === 'SUBMITTED' ? 'COMPLETION' : null,
  });
  firm.instances.push(i);
  const h = harness([firm]);
  h.at('2026-10-12T01:30:00.000Z');
  return { firm, client, owner, approver, a, i, h };
}

function event(
  w: ReturnType<typeof setup>,
  type: 'instance.submitted' | 'instance.sent_back',
  actor: Record<string, unknown> = {
    kind: 'PERSON',
    personId: type === 'instance.submitted' ? w.owner.id : w.approver.id,
  },
): OutboxEvent {
  return {
    id: randomUUID(),
    type,
    schemaVersion: 1,
    occurredAt: '2026-10-12T01:29:00.000Z',
    firmId: w.firm.id,
    clientId: w.client.id,
    actor,
    requestId: 'req:1',
    aggregate: { type: 'compliance_instance', id: w.i.id },
    aggregateVersion: w.h.store.firms[0]!.instances[0]?.version ?? 1,
    data:
      type === 'instance.submitted'
        ? {
            instanceId: w.i.id,
            kind: 'COMPLETION',
            ownerId: w.owner.id,
            approverId: w.approver.id,
            dueDate: '2026-10-15',
            completedOn: '2026-10-11',
          }
        : { instanceId: w.i.id, approverId: w.approver.id, ownerId: w.owner.id },
  };
}

const consumer = (type: string) => CONSUMERS.find((c) => c.type === type)!;
const handle = (w: ReturnType<typeof setup>, e: OutboxEvent) =>
  consumer(e.type).handle(w.h.deps, e, `job:${e.type}:${e.id}`);

describe('approval request on instance.submitted', () => {
  it('emails the approver once, naming who submitted, keyed on the event', async () => {
    const w = setup();
    const e = event(w, 'instance.submitted');
    expect(await handle(w, e)).toEqual({ sent: 1 });

    expect(w.h.mailer.sent).toHaveLength(1);
    const [email] = w.h.mailer.sent;
    expect(email!.to).toEqual({ name: 'Vikram Shah', email: 'vikram@example.com' });
    expect(email!.subject).toBe('Awaiting your approval: Deposit TDS for the month');
    expect(email!.text).toContain('Asha Rao submitted this obligation for Kestrel Metals Group.');
    expect(email!.text).toContain('(Due in 3 days)');
    expect(email!.text).toContain(`/c/${w.client.id}/register?instance=${w.i.id}`);
    expect(email!.idempotencyKey).toBe(`event:${e.id}:${w.approver.id}`);

    const firm = w.h.store.firms[0]!;
    expect(firm.sends).toEqual([
      expect.objectContaining({
        kind: 'APPROVAL_REQUESTED',
        instanceId: w.i.id,
        recipientId: w.approver.id,
        sendDate: '2026-10-12',
        eventId: e.id,
        sentAt: '2026-10-12T01:30:00.000Z',
      }),
    ]);
    expect(firm.events).toEqual([
      expect.objectContaining({
        type: 'notification.sent',
        actor: { kind: 'SYSTEM', job: 'instance.submitted' },
        requestId: `job:instance.submitted:${e.id}`,
        aggregate: { type: 'notification_send', id: firm.sends[0]!.id },
        data: {
          kind: 'APPROVAL_REQUESTED',
          recipientId: w.approver.id,
          instanceId: w.i.id,
          sendDate: '2026-10-12',
          sourceEventId: e.id,
        },
      }),
    ]);
  });

  it('words a not-applicable request as one', async () => {
    const w = setup();
    w.h.store.firms[0]!.instances[0]!.pendingKind = 'NA';
    await handle(w, event(w, 'instance.submitted'));
    expect(w.h.mailer.sent[0]!.subject).toBe('Not applicable request: Deposit TDS for the month');
  });

  it('sends nothing the second time the same event arrives', async () => {
    const w = setup();
    const e = event(w, 'instance.submitted');
    await handle(w, e);
    expect(await handle(w, e)).toEqual({ sent: 0, alreadySent: 1 });
    expect(w.h.mailer.sent).toHaveLength(1);
  });

  it('sends nothing once the instance is approved, archived or gone', async () => {
    const w = setup();
    const firm = w.h.store.firms[0]!;
    firm.instances[0]!.workflowState = 'APPROVED';
    expect(await handle(w, event(w, 'instance.submitted'))).toEqual({ sent: 0, skippedStale: 1 });
    firm.instances[0]!.workflowState = 'SUBMITTED';
    firm.instances[0]!.archived = true;
    expect(await handle(w, event(w, 'instance.submitted'))).toEqual({ sent: 0, skippedStale: 1 });
    firm.instances.length = 0;
    expect(await handle(w, event(w, 'instance.submitted'))).toEqual({ sent: 0, skippedStale: 1 });
    expect(w.h.mailer.sent).toHaveLength(0);
    expect(firm.sends).toHaveLength(0);
  });

  it('sends nothing for an instance whose client is archived', async () => {
    const w = setup();
    w.h.store.firms[0]!.clients.length = 0;
    expect(await handle(w, event(w, 'instance.submitted'))).toEqual({ sent: 0, skippedStale: 1 });
  });

  it('emails the approver the instance names when the event was raised', async () => {
    // The submission itself can carry a new approver (a delegated approval); the email follows the instance.
    const w = setup();
    const next = person({
      displayName: 'Meera Iyer',
      email: 'meera@example.com',
      clientIds: [w.client.id],
    });
    const firm = w.h.store.firms[0]!;
    firm.people.push(next);
    firm.instances[0]!.approverId = next.id;
    await handle(w, event(w, 'instance.submitted'));
    expect(w.h.mailer.sent.map((m) => m.to.email)).toEqual(['meera@example.com']);
  });

  it('sends nothing when the instance was reassigned after the event; the daily escalation covers it', async () => {
    const w = setup();
    const e = event(w, 'instance.submitted');
    w.h.store.firms[0]!.instances[0]!.version += 1;
    expect(await handle(w, e)).toEqual({ sent: 0, skippedStale: 1 });
  });

  it('falls back to the owner when the event names no person, and to "The owner" when no name is found', async () => {
    const w = setup();
    await handle(w, event(w, 'instance.submitted', { kind: 'SYSTEM', job: 'import' }));
    expect(w.h.mailer.sent[0]!.text).toContain('Asha Rao submitted');
    await handle(w, event(w, 'instance.submitted', { kind: 'PERSON', personId: randomUUID() }));
    expect(w.h.mailer.sent[1]!.text).toContain('The owner submitted');
  });

  it('logs NO_EMAIL for an approver without an address and sends nothing', async () => {
    const w = setup();
    w.h.store.firms[0]!.people.find((p) => p.id === w.approver.id)!.email = null;
    expect(await handle(w, event(w, 'instance.submitted'))).toEqual({ sent: 0, failedNO_EMAIL: 1 });
    expect(w.h.mailer.sent).toHaveLength(0);
    expect(w.h.store.firms[0]!.sends[0]).toMatchObject({ failureCode: 'NO_EMAIL' });
  });

  it('logs NO_EMAIL for an approver who no longer exists', async () => {
    const w = setup();
    const firm = w.h.store.firms[0]!;
    firm.people = firm.people.filter((p) => p.id !== w.approver.id);
    expect(await handle(w, event(w, 'instance.submitted'))).toEqual({ sent: 0, failedNO_EMAIL: 1 });
  });

  it('fails on a transport error, leaves the send pending, and sends once on the retry', async () => {
    const w = setup();
    const e = event(w, 'instance.submitted');
    w.h.mailer.failNext(1);
    await expect(handle(w, e)).rejects.toThrow('SMTP unavailable');
    expect(w.h.store.firms[0]!.sends[0]).toMatchObject({ sentAt: null, failureCode: null });
    expect(await handle(w, e)).toEqual({ sent: 1 });
    expect(w.h.mailer.sent).toHaveLength(1);
  });

  it('dates the send in the client time zone: 01:30 IST on 12 Oct is 20:00 UTC on 11 Oct', async () => {
    const w = setup();
    w.h.at('2026-10-11T20:00:00.000Z');
    await handle(w, event(w, 'instance.submitted'));
    expect(w.h.store.firms[0]!.sends[0]!.sendDate).toBe('2026-10-12');
    expect(w.h.mailer.sent[0]!.text).toContain('(Due in 3 days)');
  });

  it('rejects an event without an instance id', async () => {
    const w = setup();
    await expect(handle(w, { ...event(w, 'instance.submitted'), data: {} })).rejects.toThrow();
  });
});

describe('send-back email on instance.sent_back', () => {
  it('emails the owner, naming the approver', async () => {
    const w = setup('SENT_BACK');
    await handle(w, event(w, 'instance.sent_back'));
    const [email] = w.h.mailer.sent;
    expect(email!.to.email).toBe('asha@example.com');
    expect(email!.subject).toBe('Sent back: Deposit TDS for the month');
    expect(email!.text).toContain(
      'Vikram Shah sent back your submission for Kestrel Metals Group.',
    );
    expect(w.h.store.firms[0]!.sends[0]).toMatchObject({
      kind: 'SENT_BACK',
      recipientId: w.owner.id,
    });
  });

  it('sends a second send-back on the same day: it is a new event', async () => {
    const w = setup('SENT_BACK');
    await handle(w, event(w, 'instance.sent_back'));
    // Resubmitted, then sent back again: two more versions.
    w.h.store.firms[0]!.instances[0]!.version += 2;
    await handle(w, event(w, 'instance.sent_back'));
    expect(w.h.mailer.sent).toHaveLength(2);
    expect(w.h.store.firms[0]!.sends).toHaveLength(2);
  });

  it('names "The approver" when the approver has no name on file', async () => {
    const w = setup('SENT_BACK');
    await handle(w, event(w, 'instance.sent_back', { kind: 'SYSTEM', job: 'x' }));
    expect(w.h.mailer.sent[0]!.text).toContain('Vikram Shah sent back');
    w.h.store.firms[0]!.people.find((p) => p.id === w.approver.id)!.displayName = '';
    await handle(w, event(w, 'instance.sent_back'));
    expect(w.h.mailer.sent[1]!.text).toContain('The approver sent back');
  });

  it('sends nothing for a send-back the instance has moved past: resubmitted and sent back again', async () => {
    const w = setup('SENT_BACK');
    const first = event(w, 'instance.sent_back');
    // The owner resubmits and the approver sends it back again before the first event is handled.
    w.h.store.firms[0]!.instances[0]!.version += 2;
    const second = event(w, 'instance.sent_back');
    expect(await handle(w, first)).toEqual({ sent: 0, skippedStale: 1 });
    expect(await handle(w, second)).toEqual({ sent: 1 });
    expect(w.h.mailer.sent).toHaveLength(1);
  });

  it('sends nothing once the owner has resubmitted', async () => {
    const w = setup('SUBMITTED');
    expect(await handle(w, event(w, 'instance.sent_back'))).toEqual({ sent: 0, skippedStale: 1 });
  });

  it("is a separate send from that day's scheduled reminder, and leaves the reminder to send", async () => {
    // Due today (12 Oct) and sent back: the owner reminder and the send-back email are both due.
    const w = setup('SENT_BACK');
    w.h.store.firms[0]!.instances[0]!.dueDate = '2026-10-12' as never;
    await handle(w, event(w, 'instance.sent_back'));
    const report = await runReminders(w.h.deps, 'job:reminders:1');
    expect(report.sent).toBeGreaterThanOrEqual(1);
    const kinds = w.h.store.firms[0]!.sends.map((s) => s.kind).sort();
    expect(kinds).toContain('SENT_BACK');
    expect(kinds).toContain('OWNER_REMINDER');
  });
});
