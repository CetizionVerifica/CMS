import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOBS, startJobRunner, type JobRunner } from './runner.js';
import { assignment, harness, instance, person, type Harness } from './testing/builders.js';
import { memoryClient, memoryFirm } from './testing/memory-store.js';

// pg-boss against a real Postgres 16 (CI `db` job). Skipped when DATABASE_URL is not set (the unit run).
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('job runner on pg-boss', () => {
  const schema = `pgboss_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let runner: JobRunner;
  let h: Harness;
  const logs: {
    job: string;
    requestId: string;
    report?: Record<string, number>;
    error?: string;
  }[] = [];

  beforeAll(async () => {
    const firm = memoryFirm();
    const client = memoryClient('Aditya Birla Group');
    const owner = person({ clientIds: [client.id] });
    const approver = person({ clientIds: [client.id] });
    firm.clients.push(client);
    firm.people.push(owner, approver);
    const a = assignment(client, owner, approver);
    firm.assignments.push(a);
    firm.instances.push(instance(a, '2026-10-12', { periodStart: '2026-09-01' as never }));
    h = harness([firm]);
    h.at('2026-10-12T01:30:00Z');
    runner = await startJobRunner(h.deps, {
      connectionString: url!,
      schema,
      log: (line) => logs.push(line),
    });
  });

  afterAll(async () => {
    await runner?.stop();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  async function waitFor(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('registers every job on its cron schedule and time zone', async () => {
    const schedules = await runner.schedules();
    expect(schedules.map((s) => [s.name, s.cron, s.tz]).sort()).toEqual(
      JOBS.map((j) => [j.name, j.cron, j.tz]).sort(),
    );
  });

  it('runs generate-instances when triggered, with the job id as the request id', async () => {
    const id = await runner.trigger('generate-instances');
    expect(id).toBeTruthy();
    await waitFor(() => logs.some((l) => l.job === 'generate-instances'), 'generate-instances');
    const line = logs.find((l) => l.job === 'generate-instances')!;
    expect(line.requestId).toBe(`job:generate-instances:${id}`);
    expect(line.report).toMatchObject({ created: 23 });
    expect(h.store.firms[0]!.audits.every((e) => e.requestId === line.requestId)).toBe(true);
  });

  it('runs reminders and logs counts only', async () => {
    await runner.trigger('reminders');
    await waitFor(() => logs.some((l) => l.job === 'reminders'), 'reminders');
    expect(h.mailer.sent).toHaveLength(1);
    const line = JSON.stringify(logs.find((l) => l.job === 'reminders'));
    expect(line).not.toContain('@');
    expect(line).not.toContain('Asha');
  });

  it('logs a failed run with a message that carries no personal data', async () => {
    h.mailer.failNext(1);
    h.at('2026-10-15T01:30:00Z'); // the 12th's instance is now overdue 3 days: no planned send; add a T-0
    h.store.firms[0]!.instances.push(
      instance(h.store.firms[0]!.assignments[0]!, '2026-10-15', {
        periodStart: '2026-09-15' as never,
      }),
    );
    await runner.trigger('reminders');
    await waitFor(
      () => logs.some((l) => l.job === 'reminders' && l.error),
      'a failed reminders run',
    );
    expect(logs.find((l) => l.error)!.error).toBe('reminders: 1 send(s) failed');
  });

  it('refuses an unknown job name', () => {
    expect(() => runner.trigger('drop-tables')).toThrow('Unknown job');
  });
});
