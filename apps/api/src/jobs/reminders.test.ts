import type { LocalDate } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { runReminders } from './reminders.js';
import { APP_URL, assignment, harness, instance, person } from './testing/builders.js';
import { memoryClient, memoryFirm } from './testing/memory-store.js';

// 12 Oct 2026 07:00 IST. Defaults: owners at T-7, T-3, T-0; approvers at +1 and +7.
const SEND_TIME = '2026-10-12T01:30:00Z';

function setup() {
  const firm = memoryFirm();
  const client = memoryClient('Aditya Birla Group');
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
  return { firm, client, owner, approver, a };
}

describe('reminders', () => {
  it('sends nothing before 07:00 IST and sends at 07:00', async () => {
    const { firm, a } = setup();
    firm.instances.push(instance(a, '2026-10-15')); // T-3
    const h = harness([firm]);
    h.at('2026-10-12T01:29:00Z');
    expect(await runReminders(h.deps, 'job:r:1')).toMatchObject({ sent: 0, clientsNotYetDue: 1 });
    expect(h.mailer.sent).toEqual([]);
    h.at(SEND_TIME);
    expect(await runReminders(h.deps, 'job:r:2')).toMatchObject({ sent: 1 });
    expect(h.mailer.sent).toHaveLength(1);
  });

  it('reminds the owner at T-7, T-3 and T-0 and escalates to the approver at +1 and +7', async () => {
    const { firm, a, owner, approver } = setup();
    const due = [
      '2026-10-19',
      '2026-10-15',
      '2026-10-12',
      '2026-10-11',
      '2026-10-05',
      '2026-10-14',
      '2026-10-04',
    ];
    for (const d of due) firm.instances.push(instance(a, d));
    const h = harness([firm]);
    h.at(SEND_TIME);
    await runReminders(h.deps, 'job:r:1');
    const sent = h.mailer.sent.map((m) => `${m.to.email} ${m.subject}`).sort();
    expect(sent).toEqual(
      [
        `${owner.email} Due in 7 days: Deposit TDS for the month`,
        `${owner.email} Due in 3 days: Deposit TDS for the month`,
        `${owner.email} Due today: Deposit TDS for the month`,
        `${approver.email} Not submitted, overdue 1 day: Deposit TDS for the month`,
        `${approver.email} Not submitted, overdue 7 days: Deposit TDS for the month`,
      ].sort(),
    );
    const log = h.store.firms[0]!.sends;
    expect(log).toHaveLength(5);
    expect(
      log.every(
        (s) => s.sendDate === '2026-10-12' && s.sentAt === SEND_TIME && s.failureCode === null,
      ),
    ).toBe(true);
    expect(h.store.firms[0]!.events.filter((e) => e.type === 'notification.sent')).toHaveLength(5);
  });

  it('uses the client local date in Asia/Kolkata, not the UTC date', async () => {
    const { firm, a } = setup();
    firm.instances.push(instance(a, '2026-10-12')); // due "today" in India
    const h = harness([firm]);
    h.at('2026-10-11T18:45:00Z'); // 12 Oct 00:15 IST: today is the 12th, but before the send time
    await runReminders(h.deps, 'job:r:1');
    expect(h.mailer.sent).toEqual([]);
    h.at('2026-10-12T01:30:00Z'); // still 12 Oct in India
    await runReminders(h.deps, 'job:r:2');
    expect(h.mailer.sent.map((m) => m.subject)).toEqual(['Due today: Deposit TDS for the month']);
    expect(h.store.firms[0]!.sends[0]!.sendDate).toBe('2026-10-12');
  });

  it('sends a client in another time zone at its own 07:00', async () => {
    const { firm, a } = setup();
    firm.clients[0]!.settings.timeZone = 'Europe/London';
    firm.instances.push(instance(a, '2026-10-12'));
    const h = harness([firm]);
    h.at(SEND_TIME); // 02:30 in London
    await runReminders(h.deps, 'job:r:1');
    expect(h.mailer.sent).toEqual([]);
    h.at('2026-10-12T06:00:00Z'); // 07:00 BST
    await runReminders(h.deps, 'job:r:2');
    expect(h.mailer.sent).toHaveLength(1);
  });

  it('dedupes: repeated runs the same day send each notification once', async () => {
    const { firm, a } = setup();
    firm.instances.push(instance(a, '2026-10-15'), instance(a, '2026-10-11'));
    const h = harness([firm]);
    h.at(SEND_TIME);
    await runReminders(h.deps, 'job:r:1');
    h.at('2026-10-12T01:45:00Z');
    const second = await runReminders(h.deps, 'job:r:2');
    h.at('2026-10-12T12:00:00Z');
    await runReminders(h.deps, 'job:r:3');
    expect(h.mailer.sent).toHaveLength(2);
    expect(second).toMatchObject({ sent: 0, alreadySent: 2 });
    expect(h.store.firms[0]!.sends).toHaveLength(2);
  });

  it('never reminds for complied or not-applicable instances', async () => {
    const { firm, a, client, owner, approver } = setup();
    firm.instances.push(
      instance(a, '2026-10-15', {
        workflowState: 'APPROVED',
        completedOn: '2026-10-10' as LocalDate,
      }),
      instance(a, '2026-10-11', {
        workflowState: 'APPROVED',
        completedOn: '2026-10-11' as LocalDate,
      }),
      instance(a, '2026-10-12', { workflowState: 'NOT_APPLICABLE' }),
    );
    const na = assignment(client, owner, approver, { applicability: 'NOT_APPLICABLE' });
    firm.assignments.push(na);
    firm.instances.push(instance(na, '2026-10-15'));
    const h = harness([firm]);
    h.at(SEND_TIME);
    await runReminders(h.deps, 'job:r:1');
    expect(h.mailer.sent).toEqual([]);
    expect(h.store.firms[0]!.sends).toEqual([]);
  });

  it('stops owner reminders once submitted but keeps escalating to the approver', async () => {
    const { firm, a, approver } = setup();
    firm.instances.push(
      instance(a, '2026-10-15', { workflowState: 'SUBMITTED', pendingKind: 'COMPLETION' }),
      instance(a, '2026-10-11', { workflowState: 'SUBMITTED', pendingKind: 'COMPLETION' }),
    );
    const h = harness([firm]);
    h.at(SEND_TIME);
    await runReminders(h.deps, 'job:r:1');
    expect(h.mailer.sent.map((m) => [m.to.email, m.subject])).toEqual([
      [approver.email, 'Awaiting your approval, overdue 1 day: Deposit TDS for the month'],
    ]);
  });

  it('tells a sent-back owner to resubmit', async () => {
    const { firm, a } = setup();
    firm.instances.push(instance(a, '2026-10-15', { workflowState: 'SENT_BACK' }));
    const h = harness([firm]);
    h.at(SEND_TIME);
    await runReminders(h.deps, 'job:r:1');
    expect(h.mailer.sent[0]!.text).toContain('was sent back');
  });

  it('links to the instance in the register', async () => {
    const { firm, a, client } = setup();
    const i = instance(a, '2026-10-12');
    firm.instances.push(i);
    const h = harness([firm]);
    h.at(SEND_TIME);
    await runReminders(h.deps, 'job:r:1');
    expect(h.mailer.sent[0]!.text).toContain(`${APP_URL}/c/${client.id}/register?instance=${i.id}`);
    expect(h.mailer.sent[0]!.idempotencyKey).toBe(`OWNER_REMINDER:${i.id}:${a.ownerId}:2026-10-12`);
  });

  it('records, without sending, a reminder for someone with no email or no live membership', async () => {
    const { firm, client, approver } = setup();
    const unclaimed = person({ email: null, status: 'UNCLAIMED', clientIds: [client.id] });
    const revoked = person({ clientIds: [] });
    firm.people.push(unclaimed, revoked);
    const a1 = assignment(client, unclaimed, approver);
    const a2 = assignment(client, revoked, approver);
    firm.assignments.push(a1, a2);
    firm.instances.push(instance(a1, '2026-10-12'), instance(a2, '2026-10-12'));
    const h = harness([firm]);
    h.at(SEND_TIME);
    const report = await runReminders(h.deps, 'job:r:1');
    expect(h.mailer.sent).toEqual([]);
    expect(report).toMatchObject({ failedNO_EMAIL: 1, failedNOT_ACTIVE: 1 });
    expect(h.store.firms[0]!.sends.map((s) => s.failureCode).sort()).toEqual([
      'NOT_ACTIVE',
      'NO_EMAIL',
    ]);
    // A failed send is final for the day.
    await runReminders(h.deps, 'job:r:2');
    expect(h.store.firms[0]!.sends).toHaveLength(2);
  });

  it('treats a recipient the store does not return as unable to receive', async () => {
    const { firm, client, approver } = setup();
    const gone = person();
    const a1 = assignment(client, gone, approver);
    firm.assignments.push(a1);
    firm.instances.push(instance(a1, '2026-10-12'));
    const h = harness([firm]);
    h.at(SEND_TIME);
    await runReminders(h.deps, 'job:r:1');
    expect(h.store.firms[0]!.sends[0]!.failureCode).toBe('NO_EMAIL');
  });

  it('retries after a transport failure and sends once the transport is back', async () => {
    const { firm, a } = setup();
    firm.instances.push(instance(a, '2026-10-15'), instance(a, '2026-10-12'));
    const h = harness([firm]);
    h.at(SEND_TIME);
    h.mailer.failNext(1);
    await expect(runReminders(h.deps, 'job:r:1')).rejects.toThrow('1 send(s) failed');
    expect(h.mailer.sent).toHaveLength(1);
    const pending = h.store.firms[0]!.sends.filter((s) => s.sentAt === null);
    expect(pending).toHaveLength(1);
    await runReminders(h.deps, 'job:r:2');
    expect(h.mailer.sent).toHaveLength(2);
    expect(h.store.firms[0]!.sends.every((s) => s.sentAt !== null)).toBe(true);
  });

  it('keeps going for other clients when one client fails to load', async () => {
    const { firm, a } = setup();
    firm.instances.push(instance(a, '2026-10-12'));
    const broken = memoryClient('Broken');
    broken.settings.timeZone = 'Not/AZone';
    firm.clients.unshift(broken);
    const h = harness([firm]);
    h.at(SEND_TIME);
    await expect(runReminders(h.deps, 'job:r:1')).rejects.toThrow(AggregateError);
    expect(h.mailer.sent).toHaveLength(1);
  });

  it('never sends a reminder to another firm', async () => {
    const one = setup();
    const two = setup();
    one.firm.instances.push(instance(one.a, '2026-10-12'));
    const h = harness([one.firm, two.firm]);
    h.at(SEND_TIME);
    await runReminders(h.deps, 'job:r:1');
    expect(h.mailer.sent.map((m) => m.to.email)).toEqual([one.owner.email]);
    expect(h.store.firms[1]!.sends).toEqual([]);
  });
});
