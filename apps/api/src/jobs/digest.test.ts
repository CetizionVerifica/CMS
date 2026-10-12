import type { LocalDate } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { runConsultantDigest } from './digest.js';
import { APP_URL, assignment, harness, instance, person } from './testing/builders.js';
import { memoryClient, memoryFirm } from './testing/memory-store.js';

// 12 Oct 2026 is a Monday, the default digest weekday; 07:00 IST is 01:30Z.
const MONDAY_SEND = '2026-10-12T01:30:00Z';

function setup() {
  const firm = memoryFirm();
  const abg = memoryClient('Aditya Birla Group');
  const tata = memoryClient('Tata Group');
  const owner = person({ clientIds: [abg.id, tata.id] });
  const approver = person({ clientIds: [abg.id, tata.id] });
  const consultant = person({
    displayName: 'Meera Iyer',
    email: 'meera@example.com',
    consultantFor: [tata.id, abg.id],
  });
  firm.clients.push(abg, tata);
  firm.people.push(owner, approver, consultant);
  const a = assignment(abg, owner, approver, { criticality: 'HIGH' });
  const t = assignment(tata, owner, approver);
  firm.assignments.push(a, t);
  return { firm, abg, tata, consultant, a, t };
}

describe('consultant-digest', () => {
  it('sends one Monday digest per consultant covering all their clients, with engine scores', async () => {
    const { firm, abg, tata, consultant, a, t } = setup();
    firm.instances.push(
      instance(a, '2026-09-07', {
        workflowState: 'APPROVED',
        completedOn: '2026-09-05' as LocalDate,
      }),
      instance(a, '2026-10-07'), // overdue 5 days
      instance(a, '2026-10-15'), // due soon
      instance(t, '2026-10-07', { workflowState: 'SUBMITTED', pendingKind: 'COMPLETION' }),
    );
    const h = harness([firm]);
    h.at(MONDAY_SEND);
    const report = await runConsultantDigest(h.deps, 'job:d:1');
    expect(report).toMatchObject({ sent: 1, consultants: 1 });
    expect(h.mailer.sent).toHaveLength(1);
    const mail = h.mailer.sent[0]!;
    expect(mail.to).toEqual({ name: 'Meera Iyer', email: 'meera@example.com' });
    expect(mail.subject).toBe('Weekly digest, 12 Oct 2026: 1 overdue');
    // Aditya Birla: 1 on time of 2 due, both HIGH → 50.0%. Tata: 1 due, awaiting approval → 0.0%.
    expect(mail.text).toContain(
      'Aditya Birla Group: score 50.0%, 1 overdue, 1 due soon, 0 awaiting approval.',
    );
    expect(mail.text).toContain(
      'Tata Group: score 0.0%, 0 overdue, 0 due soon, 1 awaiting approval.',
    );
    expect(mail.text.indexOf('Aditya')).toBeLessThan(mail.text.indexOf('Tata'));
    expect(mail.text).toContain(`${APP_URL}/c/${abg.id}/overview`);
    expect(mail.text).toContain('FY 2026-27');
    const log = h.store.firms[0]!.sends;
    expect(log).toEqual([
      expect.objectContaining({
        kind: 'CONSULTANT_DIGEST',
        instanceId: null,
        recipientId: consultant.id,
        clientId: abg.id,
        sendDate: '2026-10-12',
      }),
    ]);
    expect(tata.id).not.toBe(abg.id);
  });

  it('sends once per day however often it runs', async () => {
    const { firm } = setup();
    const h = harness([firm]);
    h.at(MONDAY_SEND);
    await runConsultantDigest(h.deps, 'job:d:1');
    h.at('2026-10-12T09:00:00Z');
    const again = await runConsultantDigest(h.deps, 'job:d:2');
    expect(h.mailer.sent).toHaveLength(1);
    expect(again).toMatchObject({ sent: 0, alreadySent: 1 });
  });

  it('waits for 07:00 IST on the digest day and skips other weekdays', async () => {
    const { firm } = setup();
    const h = harness([firm]);
    h.at('2026-10-12T01:29:00Z');
    await runConsultantDigest(h.deps, 'job:d:1');
    h.at('2026-10-13T01:30:00Z'); // Tuesday
    await runConsultantDigest(h.deps, 'job:d:2');
    expect(h.mailer.sent).toEqual([]);
  });

  it('uses the India date: Sunday 19:00 UTC is already Monday 00:30 IST', async () => {
    const { firm } = setup();
    for (const c of firm.clients) c.settings.reminders.sendAtLocalTime = '00:00';
    const h = harness([firm]);
    h.at('2026-10-11T19:00:00Z');
    await runConsultantDigest(h.deps, 'job:d:1');
    expect(h.mailer.sent).toHaveLength(1);
    expect(h.store.firms[0]!.sends[0]!.sendDate).toBe('2026-10-12');
  });

  it('includes only clients whose digest day it is, once any of them has reached its send time', async () => {
    const { firm, tata } = setup();
    tata.settings.reminders.consultantDigestWeekday = 3; // Wednesday
    firm.clients.find((c) => c.id === tata.id)!.settings.reminders.consultantDigestWeekday = 3;
    const h = harness([firm]);
    h.at(MONDAY_SEND);
    await runConsultantDigest(h.deps, 'job:d:1');
    expect(h.mailer.sent[0]!.text).toContain('Aditya Birla Group');
    expect(h.mailer.sent[0]!.text).not.toContain('Tata Group');
  });

  it('shows "No items due" when nothing is due yet', async () => {
    const { firm } = setup();
    const h = harness([firm]);
    h.at(MONDAY_SEND);
    await runConsultantDigest(h.deps, 'job:d:1');
    expect(h.mailer.sent[0]!.text).toContain('score No items due');
    expect(h.mailer.sent[0]!.subject).toBe('Weekly digest, 12 Oct 2026: 0 overdue');
  });

  it('skips consultants with no client due today and ignores client ids outside the firm', async () => {
    const { firm, consultant } = setup();
    firm.people.find((p) => p.id === consultant.id)!.consultantFor = [
      '00000000-0000-7000-8000-000000000000',
    ];
    const h = harness([firm]);
    h.at(MONDAY_SEND);
    expect(await runConsultantDigest(h.deps, 'job:d:1')).toMatchObject({ consultants: 1, sent: 0 });
    expect(h.store.firms[0]!.sends).toEqual([]);
  });

  it('records a digest for a disabled consultant as failed and sends nothing', async () => {
    const { firm, consultant } = setup();
    firm.people.find((p) => p.id === consultant.id)!.status = 'DISABLED';
    const h = harness([firm]);
    h.at(MONDAY_SEND);
    await runConsultantDigest(h.deps, 'job:d:1');
    expect(h.mailer.sent).toEqual([]);
    expect(h.store.firms[0]!.sends[0]!.failureCode).toBe('NOT_ACTIVE');
  });

  it('puts clients in two time zones into the same Monday digest, each scored at its own date', async () => {
    const { firm, abg, tata, t } = setup();
    tata.settings.timeZone = 'America/New_York';
    // Due 11 Oct: overdue in India (12 Oct), due today in New York (still 11 Oct) and so not overdue there.
    firm.instances.push(instance(t, '2026-10-11'));
    const h = harness([firm]);
    h.at(MONDAY_SEND); // Monday 07:00 IST, Sunday 21:30 in New York
    await runConsultantDigest(h.deps, 'job:d:1');
    expect(h.mailer.sent).toHaveLength(1);
    const text = h.mailer.sent[0]!.text;
    expect(text).toContain('Aditya Birla Group: score No items due');
    expect(text).toContain('Tata Group: score 0.0%, 0 overdue, 1 due soon');
    expect(h.store.firms[0]!.sends[0]).toMatchObject({ clientId: abg.id, sendDate: '2026-10-12' });
    // Monday 07:00 in New York: same India date, already sent, so no second digest without the New York client.
    h.at('2026-10-12T11:00:00Z');
    expect(await runConsultantDigest(h.deps, 'job:d:2')).toMatchObject({ sent: 0, alreadySent: 1 });
    expect(h.mailer.sent).toHaveLength(1);
  });

  it('waits for the earliest send time among the clients due that day, read in India time', async () => {
    const { firm } = setup();
    for (const c of firm.clients) c.settings.reminders.sendAtLocalTime = '09:00';
    firm.clients[1]!.settings.reminders.sendAtLocalTime = '08:00';
    const h = harness([firm]);
    h.at('2026-10-12T02:29:00Z'); // 07:59 IST
    await runConsultantDigest(h.deps, 'job:d:1');
    expect(h.mailer.sent).toEqual([]);
    h.at('2026-10-12T02:30:00Z'); // 08:00 IST
    await runConsultantDigest(h.deps, 'job:d:2');
    expect(h.mailer.sent).toHaveLength(1);
  });

  it('fails the run on a transport error and sends on the retry', async () => {
    const { firm } = setup();
    const h = harness([firm]);
    h.at(MONDAY_SEND);
    h.mailer.failNext(1);
    await expect(runConsultantDigest(h.deps, 'job:d:1')).rejects.toThrow('1 digest(s) failed');
    await runConsultantDigest(h.deps, 'job:d:2');
    expect(h.mailer.sent).toHaveLength(1);
  });
});
