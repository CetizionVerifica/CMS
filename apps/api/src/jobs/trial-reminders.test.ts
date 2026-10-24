import { LocalDate, type AccountStatus } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { JOBS } from './runner.js';
import { APP_URL, harness, person } from './testing/builders.js';
import { memoryFirm, type MemoryFirm } from './testing/memory-store.js';
import { runTrialReminders, TRIAL_REMINDERS } from './trial-reminders.js';

// 16 Nov 2026, 10:00 India time (04:30Z): a trial whose last day is 23 Nov is 7 days away.
const MORNING = '2026-11-16T04:30:00Z';

function trialFirm(trialEndsOn: string, status: AccountStatus = 'TRIAL'): MemoryFirm {
  const firm = {
    ...memoryFirm(),
    name: 'Kestrel Metals Group',
    status,
    trialEndsOn: LocalDate.parse(trialEndsOn),
  };
  firm.people.push(
    person({ displayName: 'Kiran Kestrel', email: 'kiran@kestrel.test', firmAdmin: true }),
    person({ displayName: 'Ravi Consultant', email: 'ravi@kestrel.test', consultantFor: [] }),
  );
  return firm;
}

describe(TRIAL_REMINDERS, () => {
  it('runs daily at 10:00 India time, sends mail and catches up once', () => {
    expect(JOBS.find((j) => j.name === TRIAL_REMINDERS)).toMatchObject({
      cron: '0 10 * * *',
      tz: 'Asia/Kolkata',
      sendsMail: true,
      catchUp: true,
    });
  });

  it('emails each account admin 7 days before the trial ends, about the account and no client', async () => {
    const firm = trialFirm('2026-11-23');
    const h = harness([firm]);
    h.at(MORNING);
    expect(await runTrialReminders(h.deps, 'job:test')).toMatchObject({
      firms: 1,
      admins: 1,
      sent: 1,
    });
    expect(h.mailer.sent).toHaveLength(1);
    const [email] = h.mailer.sent;
    expect(email!.to).toEqual({ name: 'Kiran Kestrel', email: 'kiran@kestrel.test' });
    expect(email!.subject).toBe('Your PlanetPulse Compliance trial ends in 7 days');
    expect(email!.text).toContain('Kestrel Metals Group ends in 7 days, on 23 Nov 2026');
    expect(email!.text).toContain(`${APP_URL}/account`);
    expect(h.store.firms[0]!.sends).toEqual([
      expect.objectContaining({
        clientId: null,
        instanceId: null,
        kind: 'TRIAL_ENDING',
        sendDate: '2026-11-16',
        recipientId: firm.people[0]!.id,
      }),
    ]);
    expect(h.store.firms[0]!.events.map((e) => e.type)).toEqual(['notification.sent']);
  });

  it('says "tomorrow" the day before, and sends nothing on the other days', async () => {
    const firm = trialFirm('2026-11-23');
    const h = harness([firm]);
    for (const [day, expected] of [
      ['2026-11-15T04:30:00Z', 0], // 8 days left
      ['2026-11-17T04:30:00Z', 0], // 6 days left
      ['2026-11-22T04:30:00Z', 1], // the day before
      ['2026-11-23T04:30:00Z', 0], // the last day itself
    ] as const) {
      h.at(day);
      h.mailer.sent.length = 0;
      await runTrialReminders(h.deps, 'job:test');
      expect(h.mailer.sent, day).toHaveLength(expected);
    }
    expect(h.store.firms[0]!.sends.map((s) => s.sendDate)).toEqual(['2026-11-22']);
  });

  it('uses the India date: 23:30Z on the 15th is already the 16th there', async () => {
    const firm = trialFirm('2026-11-23');
    const h = harness([firm]);
    h.at('2026-11-15T23:30:00Z');
    await runTrialReminders(h.deps, 'job:test');
    expect(h.store.firms[0]!.sends.map((s) => s.sendDate)).toEqual(['2026-11-16']);
  });

  it('sends once a day however often it runs', async () => {
    const firm = trialFirm('2026-11-23');
    const h = harness([firm]);
    h.at(MORNING);
    await runTrialReminders(h.deps, 'job:test');
    h.at('2026-11-16T09:00:00Z');
    expect(await runTrialReminders(h.deps, 'job:test')).toMatchObject({ alreadySent: 1 });
    expect(h.mailer.sent).toHaveLength(1);
  });

  it('emails only accounts in TRIAL', async () => {
    const firms = (['ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'PROVISIONING'] as const).map(
      (status) => trialFirm('2026-11-23', status),
    );
    const h = harness(firms);
    h.at(MORNING);
    expect(await runTrialReminders(h.deps, 'job:test')).toMatchObject({ firms: 0 });
    expect(h.mailer.sent).toEqual([]);
  });

  it('records an admin who cannot receive mail as failed, and still emails the others', async () => {
    const firm = trialFirm('2026-11-23');
    firm.people.push(
      person({ displayName: 'Lapsed Admin', email: 'lapsed@kestrel.test', firmAdmin: 'expired' }),
      person({ displayName: 'New Admin', email: null, status: 'UNCLAIMED', firmAdmin: true }),
    );
    const h = harness([firm]);
    h.at(MORNING);
    expect(await runTrialReminders(h.deps, 'job:test')).toMatchObject({
      admins: 3,
      sent: 1,
      failedNOT_ACTIVE: 1,
      failedNO_EMAIL: 1,
    });
    expect(h.mailer.sent.map((e) => e.to.email)).toEqual(['kiran@kestrel.test']);
  });

  it('keeps going past an account that fails, then fails the run so it is retried', async () => {
    const broken = trialFirm('2026-11-23');
    const fine = trialFirm('2026-11-23');
    const h = harness([broken, fine]);
    const withFirm = h.store.withFirm.bind(h.store);
    h.store.withFirm = (firmId, requestId, fn) =>
      firmId === broken.id
        ? Promise.reject(new Error('connection reset'))
        : withFirm(firmId, requestId, fn);
    h.at(MORNING);
    await expect(runTrialReminders(h.deps, 'job:test')).rejects.toThrow(
      `${TRIAL_REMINDERS}: 1 account(s) failed`,
    );
    expect(h.store.firms[1]!.sends).toHaveLength(1);
  });
});
