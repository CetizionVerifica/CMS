import { LocalDate, type AccountStatus } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_DAILY, runAccountDaily, servedFirmIds } from './accounts.js';
import { runConsultantDigest } from './digest.js';
import { runGenerateInstances } from './generate-instances.js';
import { runReminders } from './reminders.js';
import { JOBS } from './runner.js';
import { assignment, harness, person } from './testing/builders.js';
import { memoryClient, memoryFirm, type MemoryFirm } from './testing/memory-store.js';

const STATUSES: AccountStatus[] = [
  'PROVISIONING',
  'TRIAL',
  'ACTIVE',
  'SUSPENDED',
  'PENDING_DELETION',
  'DELETED',
];

function firmIn(status: AccountStatus, trialEndsOn: string | null = null): MemoryFirm {
  return {
    ...memoryFirm(),
    status,
    trialEndsOn: trialEndsOn === null ? null : LocalDate.parse(trialEndsOn),
  };
}

/** A firm with one client and one monthly assignment, so generation has work to do. */
function busyFirm(status: AccountStatus): MemoryFirm {
  const firm = firmIn(status);
  const client = memoryClient('Kestrel Metals Group');
  const owner = person({ clientIds: [client.id] });
  const approver = person({ displayName: 'Vikram Shah', clientIds: [client.id] });
  firm.clients.push(client);
  firm.people.push(owner, approver);
  firm.assignments.push(assignment(client, owner, approver));
  return firm;
}

describe('served accounts', () => {
  it('serves TRIAL and ACTIVE accounts only', async () => {
    const firms = STATUSES.map((status) => firmIn(status));
    const h = harness(firms);
    expect(await servedFirmIds(h.deps, 'job:test')).toEqual([firms[1]!.id, firms[2]!.id]);
  });

  it('generates instances for an active account and none for a suspended one', async () => {
    const active = busyFirm('ACTIVE');
    const suspended = busyFirm('SUSPENDED');
    const h = harness([active, suspended]);
    h.at('2026-10-11T20:00:00Z');
    const report = await runGenerateInstances(h.deps, 'job:test');
    expect(report).toMatchObject({ firms: 1, clients: 1, created: 24 });
    expect(h.store.firms[0]!.instances).toHaveLength(24);
    expect(h.store.firms[1]!.instances).toEqual([]);
    expect(h.store.firms[1]!.audits).toEqual([]);
  });

  it('runs no reminders or digests for an account that is paused, closing or being set up', async () => {
    const h = harness([
      busyFirm('SUSPENDED'),
      busyFirm('PENDING_DELETION'),
      busyFirm('PROVISIONING'),
    ]);
    h.at('2026-10-12T03:00:00Z');
    expect(await runReminders(h.deps, 'job:test')).toMatchObject({ firms: 0, clients: 0 });
    expect(await runConsultantDigest(h.deps, 'job:test')).toMatchObject({ firms: 0 });
    expect(h.mailer.sent).toEqual([]);
  });
});

describe(ACCOUNT_DAILY, () => {
  it('is scheduled nightly at 00:30 India time, before generation, and sends no mail', () => {
    const names = JOBS.map((j) => j.name);
    expect(JOBS.find((j) => j.name === ACCOUNT_DAILY)).toMatchObject({
      cron: '30 0 * * *',
      tz: 'Asia/Kolkata',
      sendsMail: false,
      catchUp: true,
    });
    expect(names.indexOf(ACCOUNT_DAILY)).toBeLessThan(names.indexOf('generate-instances'));
  });

  it('ends a trial whose last day has passed in India time, and keeps one that ends today', async () => {
    const lapsed = firmIn('TRIAL', '2026-10-11');
    const lastDay = firmIn('TRIAL', '2026-10-12');
    const h = harness([lapsed, lastDay]);
    h.at('2026-10-11T19:00:00Z'); // 12 Oct 00:30 IST
    const report = await runAccountDaily(h.deps, 'job:test');
    expect(report).toEqual({ firms: 2, trialsEnded: 1, snapshots: 2 });
    expect(h.store.firms.map((f) => f.status)).toEqual(['SUSPENDED', 'TRIAL']);
  });

  it('records usage for every opened account, on the India date, once a day', async () => {
    const firms = STATUSES.map((status) => firmIn(status));
    const h = harness(firms);
    h.at('2026-10-11T19:00:00Z');
    expect(await runAccountDaily(h.deps, 'job:test')).toEqual({
      firms: 6,
      trialsEnded: 0,
      snapshots: 4,
    });
    expect(await runAccountDaily(h.deps, 'job:test')).toMatchObject({ snapshots: 4 });
    expect(h.store.firms.map((f) => f.snapshots)).toEqual([
      [],
      ['2026-10-12'],
      ['2026-10-12'],
      ['2026-10-12'],
      ['2026-10-12'],
      [],
    ]);
  });

  it('finishes the other accounts when one fails, then fails so pg-boss retries', async () => {
    const broken = firmIn('ACTIVE');
    const fine = firmIn('ACTIVE');
    const h = harness([broken, fine]);
    const withFirm = h.store.withFirm.bind(h.store);
    h.store.withFirm = (firmId, requestId, fn) =>
      firmId === broken.id
        ? Promise.reject(new Error('connection reset'))
        : withFirm(firmId, requestId, fn);
    await expect(runAccountDaily(h.deps, 'job:test')).rejects.toThrow(
      `${ACCOUNT_DAILY}: 1 account(s) failed`,
    );
    expect(h.store.firms[1]!.snapshots).toHaveLength(1);
  });
});
