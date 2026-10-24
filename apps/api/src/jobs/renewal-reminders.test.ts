import { LocalDate, type AccountStatus } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { RENEWAL_REMINDERS, runRenewalReminders } from './renewal-reminders.js';
import { JOBS } from './runner.js';
import { APP_URL, harness, person } from './testing/builders.js';
import { memoryFirm, type MemoryFirm } from './testing/memory-store.js';

// 1 Mar 2027, 10:00 India time (04:30Z): a subscription whose last day is 31 Mar is 30 days away.
const MORNING = '2027-03-01T04:30:00Z';

function paidFirm(endsOn: string | null, status: AccountStatus = 'ACTIVE'): MemoryFirm {
  const firm = {
    ...memoryFirm(),
    name: 'Kestrel Metals Group',
    status,
    subscriptionEndsOn: endsOn === null ? null : LocalDate.parse(endsOn),
  };
  firm.people.push(
    person({ displayName: 'Kiran Kestrel', email: 'kiran@kestrel.test', firmAdmin: true }),
    person({ displayName: 'Ravi Consultant', email: 'ravi@kestrel.test', consultantFor: [] }),
  );
  return firm;
}

describe(RENEWAL_REMINDERS, () => {
  it('runs daily at 10:00 India time, sends mail and catches up once', () => {
    expect(JOBS.find((j) => j.name === RENEWAL_REMINDERS)).toMatchObject({
      cron: '0 10 * * *',
      tz: 'Asia/Kolkata',
      sendsMail: true,
      catchUp: true,
    });
  });

  it('emails each account admin 30 days before the subscription ends, about the account and no client', async () => {
    const firm = paidFirm('2027-03-31');
    const h = harness([firm]);
    h.at(MORNING);
    expect(await runRenewalReminders(h.deps, 'job:test')).toMatchObject({
      firms: 1,
      admins: 1,
      sent: 1,
    });
    const [email] = h.mailer.sent;
    expect(h.mailer.sent).toHaveLength(1);
    expect(email!.to).toEqual({ name: 'Kiran Kestrel', email: 'kiran@kestrel.test' });
    expect(email!.subject).toBe('Your PlanetPulse Compliance subscription ends in 30 days');
    expect(email!.text).toContain('Kestrel Metals Group ends in 30 days, on 31 Mar 2027');
    expect(email!.text).toContain(`${APP_URL}/account`);
    expect(h.store.firms[0]!.sends).toEqual([
      expect.objectContaining({
        clientId: null,
        instanceId: null,
        kind: 'RENEWAL_DUE',
        sendDate: '2027-03-01',
        recipientId: firm.people[0]!.id,
      }),
    ]);
  });

  it('emails 30 and 7 days before, on the India date, and nothing on the other days', async () => {
    const h = harness([paidFirm('2027-03-31')]);
    for (const [day, expected] of [
      ['2027-02-28T04:30:00Z', 0], // 31 days left
      ['2027-02-28T23:30:00Z', 1], // already 1 Mar in India: 30 days
      ['2027-03-23T04:30:00Z', 0], // 8 days left
      ['2027-03-24T04:30:00Z', 1], // 7 days left
      ['2027-03-30T04:30:00Z', 0], // the day before
      ['2027-03-31T04:30:00Z', 0], // the last day itself
    ] as const) {
      h.at(day);
      h.mailer.sent.length = 0;
      await runRenewalReminders(h.deps, 'job:test');
      expect(h.mailer.sent, day).toHaveLength(expected);
    }
    expect(h.store.firms[0]!.sends.map((s) => s.sendDate)).toEqual(['2027-03-01', '2027-03-24']);
  });

  it('sends once a day however often it runs', async () => {
    const h = harness([paidFirm('2027-03-31')]);
    h.at(MORNING);
    await runRenewalReminders(h.deps, 'job:test');
    h.at('2027-03-01T09:00:00Z');
    expect(await runRenewalReminders(h.deps, 'job:test')).toMatchObject({ alreadySent: 1 });
    expect(h.mailer.sent).toHaveLength(1);
  });

  it('emails only ACTIVE accounts that have a subscription', async () => {
    const firms = [
      ...(['TRIAL', 'SUSPENDED', 'PENDING_DELETION', 'PROVISIONING'] as const).map((status) =>
        paidFirm('2027-03-31', status),
      ),
      paidFirm(null),
    ];
    const h = harness(firms);
    h.at(MORNING);
    expect(await runRenewalReminders(h.deps, 'job:test')).toMatchObject({ firms: 0 });
    expect(h.mailer.sent).toEqual([]);
  });

  it('records an admin who cannot receive mail as failed, and still emails the others', async () => {
    const firm = paidFirm('2027-03-31');
    firm.people.push(
      person({ displayName: 'Lapsed Admin', email: 'lapsed@kestrel.test', firmAdmin: 'expired' }),
      person({ displayName: 'New Admin', email: null, status: 'UNCLAIMED', firmAdmin: true }),
    );
    const h = harness([firm]);
    h.at(MORNING);
    expect(await runRenewalReminders(h.deps, 'job:test')).toMatchObject({
      admins: 3,
      sent: 1,
      failedNOT_ACTIVE: 1,
      failedNO_EMAIL: 1,
    });
  });

  it('keeps going past an account that fails, then fails the run so it is retried', async () => {
    const broken = paidFirm('2027-03-31');
    const fine = paidFirm('2027-03-31');
    const h = harness([broken, fine]);
    const withFirm = h.store.withFirm.bind(h.store);
    h.store.withFirm = (firmId, requestId, fn) =>
      firmId === broken.id
        ? Promise.reject(new Error('connection reset'))
        : withFirm(firmId, requestId, fn);
    h.at(MORNING);
    await expect(runRenewalReminders(h.deps, 'job:test')).rejects.toThrow(
      `${RENEWAL_REMINDERS}: 1 account(s) failed`,
    );
    expect(h.store.firms[1]!.sends).toHaveLength(1);
  });
});
