import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOBS, startJobRunner, type JobRunner } from './runner.js';
import type { EvidenceObjects, Scanner } from './ports.js';
import {
  assignment,
  evidenceFile,
  harness,
  instance,
  person,
  type Harness,
} from './testing/builders.js';
import { memoryClient, memoryFirm, outboxRow } from './testing/memory-store.js';

// pg-boss against a real Postgres 16 (CI `db` job). Skipped when DATABASE_URL is not set (the unit run).
const url = process.env.DATABASE_URL;

/** Every file is clean; storage holds a few bytes at any key. */
const cleanScanner: Scanner = {
  async scan(content) {
    for await (const chunk of content) void chunk;
    return { status: 'CLEAN' };
  },
};
const anyObject: EvidenceObjects = {
  open: async () =>
    (async function* () {
      yield Buffer.from('%PDF-1.7');
    })(),
};

/** The migrations create the job schema; the runner never does, so each test creates its own. */
async function createSchema(schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.end();
}

async function dropSchema(schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
}

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
    const client = memoryClient('Kestrel Metals Group');
    const owner = person({ clientIds: [client.id] });
    const approver = person({ clientIds: [client.id] });
    firm.clients.push(client);
    firm.people.push(owner, approver);
    const a = assignment(client, owner, approver);
    firm.assignments.push(a);
    const i = instance(a, '2026-10-12', { periodStart: '2026-09-01' as never });
    firm.instances.push(i);
    firm.evidence.push(evidenceFile(i));
    h = harness([firm]);
    h.at('2026-10-12T01:30:00Z');
    await createSchema(schema);
    runner = await startJobRunner(
      { ...h.deps, scanner: cleanScanner, evidenceObjects: anyObject },
      {
        connectionString: url!,
        schema,
        log: (line) => logs.push(line),
      },
    );
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

  it('registers every job on its cron schedule and time zone, the relay every minute', async () => {
    const schedules = await runner.schedules();
    expect(schedules.map((s) => [s.name, s.cron, s.tz]).sort()).toEqual(
      JOBS.map((j) => [j.name, j.cron, j.tz]).sort(),
    );
    expect(schedules).toContainEqual({ name: 'relay-outbox', cron: '* * * * *', tz: 'UTC' });
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

  it('relays an outbox event to its queue and the consumer generates that assignment', async () => {
    const firm = h.store.firms[0]!;
    const [owner, approver] = firm.people;
    const added = assignment(firm.clients[0]!, owner!, approver!);
    firm.assignments.push(added);
    const row = outboxRow({
      type: 'assignment.created',
      clientId: firm.clients[0]!.id,
      actor: { kind: 'SYSTEM', job: 'test' },
      requestId: 'req:assignment',
      aggregate: { type: 'assignment', id: added.assignmentId },
      aggregateVersion: 1,
      data: { assignmentId: added.assignmentId },
    });
    firm.events.push(row);

    await runner.trigger('relay-outbox');
    await waitFor(() => logs.some((l) => l.job === 'assignment.created'), 'the consumer');
    const line = logs.find((l) => l.job === 'assignment.created')!;
    expect(line.requestId).toBe(`job:assignment.created:${row.id}`);
    expect(line.report).toMatchObject({ created: 24 });
    const stored = h.store.firms[0]!;
    expect(stored.instances.filter((i) => i.assignmentId === added.assignmentId)).toHaveLength(24);
    expect(stored.events.find((e) => e.id === row.id)!.publishedAt).not.toBeNull();
  });

  it('scans pending evidence when scan-evidence is triggered', async () => {
    expect(runner.scan).toBe(true);
    await runner.trigger('scan-evidence');
    await waitFor(() => logs.some((l) => l.job === 'scan-evidence'), 'the scan');
    expect(logs.find((l) => l.job === 'scan-evidence')!.report).toMatchObject({ clean: 1 });
    expect(h.store.firms[0]!.evidence[0]!.scanStatus).toBe('CLEAN');
  });

  it('refuses an unknown job name', () => {
    expect(() => runner.trigger('drop-tables')).toThrow('Unknown job');
  });
});

describe.skipIf(!url)('job runner without a login token issuer', () => {
  it('relays sign-in link and invite events as done and sends nothing', async () => {
    const schema = `pgboss_notoken_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await createSchema(schema);
    const firm = memoryFirm();
    const h = harness([firm]);
    const logs: { job: string; report?: Record<string, number> }[] = [];
    const runner = await startJobRunner(
      { ...h.deps, issueLoginToken: undefined },
      { connectionString: url!, schema, log: (line) => logs.push(line) },
    );
    try {
      expect(runner.mail).toBe(true);
      expect(runner.loginEmails).toBe(false);
      for (const type of ['auth.magic_link_requested', 'person.invited']) {
        firm.events.push(
          outboxRow({
            type,
            clientId: null,
            actor: { kind: 'SYSTEM', job: 'test' },
            requestId: `req:${type}`,
            aggregate: { type: 'person', id: randomUUID() },
            aggregateVersion: 1,
            data: { personId: randomUUID() },
          }),
        );
      }
      await runner.trigger('relay-outbox');
      const deadline = Date.now() + 20_000;
      while (!logs.some((l) => l.job === 'relay-outbox')) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for the relay');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(logs.find((l) => l.job === 'relay-outbox')!.report).toMatchObject({
        published: 0,
        skipped: 2,
      });
      expect(h.store.firms[0]!.events.every((e) => e.publishedAt !== null)).toBe(true);
      expect(h.mailer.sent).toHaveLength(0);
    } finally {
      await runner.stop();
      const pgClient = new pg.Client({ connectionString: url });
      await pgClient.connect();
      await pgClient.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pgClient.end();
    }
  });
});

describe.skipIf(!url)('job runner without a mail transport', () => {
  it('registers generation and the relay only, and relays an event only an email consumer reads as done', async () => {
    const schema = `pgboss_nomail_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await createSchema(schema);
    const firm = memoryFirm();
    const client = memoryClient('Kestrel Metals Group');
    firm.clients.push(client);
    const h = harness([firm]);
    const logs: { job: string; report?: Record<string, number> }[] = [];
    const runner = await startJobRunner(h.deps, {
      connectionString: url!,
      schema,
      mail: false,
      log: (line) => logs.push(line),
    });
    try {
      expect(runner.mail).toBe(false);
      expect(runner.loginEmails).toBe(false);
      expect((await runner.schedules()).map((s) => s.name).sort()).toEqual(
        JOBS.filter((j) => !j.sendsMail && !j.scansEvidence)
          .map((j) => j.name)
          .sort(),
      );
      expect(() => runner.trigger('reminders')).toThrow(
        'Job not running without a mail transport: reminders',
      );
      expect(runner.scan).toBe(false);
      expect(() => runner.trigger('scan-evidence')).toThrow(
        'Job not running without a virus scanner: scan-evidence',
      );
      const row = outboxRow({
        type: 'instance.submitted',
        clientId: client.id,
        actor: { kind: 'SYSTEM', job: 'test' },
        requestId: 'req:submitted',
        aggregate: { type: 'instance', id: randomUUID() },
        aggregateVersion: 2,
        data: { instanceId: randomUUID() },
      });
      firm.events.push(row);
      await runner.trigger('relay-outbox');
      const deadline = Date.now() + 20_000;
      while (!logs.some((l) => l.job === 'relay-outbox')) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for the relay');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(logs.find((l) => l.job === 'relay-outbox')!.report).toMatchObject({
        published: 0,
        skipped: 1,
      });
      expect(h.store.firms[0]!.events[0]!.publishedAt).not.toBeNull();
      expect(h.mailer.sent).toHaveLength(0);
    } finally {
      await runner.stop();
      const pgClient = new pg.Client({ connectionString: url });
      await pgClient.connect();
      await pgClient.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pgClient.end();
    }
  });
});

describe.skipIf(!url)('jobs booted from the environment', () => {
  it('starts on the Postgres store with the SMTP mailer, registers the schedule, and stops', async () => {
    const { createJobTestDatabase } = await import('./testing/postgres.js');
    const { startFakeSmtp } = await import('./testing/fake-smtp.js');
    const { startJobsFromEnv } = await import('./start.js');
    const t = await createJobTestDatabase(url!);
    const smtp = await startFakeSmtp();
    const schema = `pgboss_env_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await createSchema(schema);
    try {
      const runner = await startJobsFromEnv(
        {
          SMTP_HOST: '127.0.0.1',
          SMTP_PORT: String(smtp.port),
          MAIL_FROM: 'PlanetPulse Compliance <no-reply@planetpulse.example>',
          APP_URL: 'https://app.planetpulse.example',
          // Nothing is scanned here, so neither clamd nor the bucket is contacted.
          CLAMAV_HOST: '127.0.0.1',
          S3_BUCKET: 'canopy-evidence',
          S3_ACCESS_KEY_ID: 'key',
          S3_SECRET_ACCESS_KEY: 'secret',
          // pg-boss's own login; the API's connection below would fail.
          JOBS_DATABASE_URL: url!,
        },
        {
          db: t.db,
          connectionString: 'postgres://nobody@127.0.0.1:1/none',
          schema,
          issueLoginToken: async () => ({ token: 't', expiresAt: new Date().toISOString() }),
        },
      );
      expect(runner).toMatchObject({ mail: true, loginEmails: true, scan: true });
      expect((await runner.schedules()).map((s) => s.name).sort()).toEqual(
        JOBS.map((j) => j.name).sort(),
      );
      await runner.stop();
    } finally {
      await smtp.close();
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
      await t.drop();
    }
  });
});

describe.skipIf(!url)('job runner as its own login, without CREATE on the database', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  // As in a deploy (migration 0023): a NOLOGIN jobs role owns the schema, pg-boss's login is a member that defaults
  // to it, and the tenant login is no member at all.
  const jobsRole = `canopy_jobs_${suffix}`;
  const login = `canopy_jobs_login_${suffix}`;
  const tenant = `canopy_tenant_${suffix}`;
  const owned = `pgboss_owned_${suffix}`;
  const missing = `pgboss_missing_${suffix}`;
  const as = (role: string) => {
    const u = new URL(url!);
    u.username = role;
    u.password = suffix;
    return u.toString();
  };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE ROLE ${jobsRole} NOLOGIN NOSUPERUSER NOCREATEDB`);
    await admin.query(
      `CREATE ROLE ${login} LOGIN PASSWORD '${suffix}' NOSUPERUSER NOCREATEDB IN ROLE ${jobsRole}`,
    );
    await admin.query(`ALTER ROLE ${login} SET role = ${jobsRole}`);
    await admin.query(`CREATE ROLE ${tenant} LOGIN PASSWORD '${suffix}' NOSUPERUSER NOCREATEDB`);
    await admin.query(`CREATE SCHEMA ${owned} AUTHORIZATION ${jobsRole}`);
    await admin.end();
  });

  afterAll(async () => {
    await dropSchema(owned);
    await dropSchema(missing);
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    for (const role of [login, tenant, jobsRole]) await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('starts on the schema the jobs role owns, and its tables belong to that role', async () => {
    const runner = await startJobRunner(harness([memoryFirm()]).deps, {
      connectionString: as(login),
      schema: owned,
    });
    try {
      expect((await runner.schedules()).length).toBeGreaterThan(0);
    } finally {
      await runner.stop();
    }
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const { rows } = await admin.query<{ tableowner: string }>(
      'SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = $1',
      [owned],
    );
    await admin.end();
    expect(rows.map((r) => r.tableowner)).toEqual([jobsRole]);
  });

  it('refuses to start on a missing schema rather than try to create it', async () => {
    await expect(
      startJobRunner(harness([memoryFirm()]).deps, {
        connectionString: as(login),
        schema: missing,
      }),
    ).rejects.toThrow(
      `The job schema "${missing}" does not exist: run the database migrations first`,
    );
  });

  it('refuses to start as the tenant login, at boot and saying what to set', async () => {
    const failure = startJobRunner(harness([memoryFirm()]).deps, {
      connectionString: as(tenant),
      schema: owned,
    });
    await expect(failure).rejects.toThrow(
      `The jobs' database login may not use the job schema "${owned}": set JOBS_DATABASE_URL to a login that is a member of canopy_jobs`,
    );
    await expect(failure).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
