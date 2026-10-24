import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { CONSUMERS, OutboxEventSchema } from './consumers.js';
import { runConsultantDigest, CONSULTANT_DIGEST } from './digest.js';
import { GENERATE_INSTANCES, runGenerateInstances } from './generate-instances.js';
import { RELAY_OUTBOX, runRelayOutbox } from './outbox-relay.js';
import type { EventBus, JobDeps, JobReport } from './ports.js';
import { REMINDERS, runReminders } from './reminders.js';

export interface JobDefinition {
  name: string;
  /** Cron expression, evaluated in `tz`. */
  cron: string;
  tz: string;
  /** Sends email, so it runs only when a mailer is configured. */
  sendsMail: boolean;
  run(deps: JobDeps, requestId: string): Promise<JobReport>;
}

/**
 * The schedule. Generation runs nightly at 01:00 India time and catches up once after downtime. Reminders and the
 * digest run every 15 minutes in UTC and decide per client whether its local send time has passed, so each client
 * is served in its own time zone; missed slots are skipped because the next run covers them. The outbox relay runs
 * every minute. Without a mailer only generation and the relay run (`sendsMail: false`).
 */
export const JOBS: readonly JobDefinition[] = [
  {
    name: GENERATE_INSTANCES,
    cron: '0 1 * * *',
    tz: 'Asia/Kolkata',
    sendsMail: false,
    run: runGenerateInstances,
  },
  { name: REMINDERS, cron: '*/15 * * * *', tz: 'UTC', sendsMail: true, run: runReminders },
  {
    name: CONSULTANT_DIGEST,
    cron: '*/15 * * * *',
    tz: 'UTC',
    sendsMail: true,
    run: runConsultantDigest,
  },
  { name: RELAY_OUTBOX, cron: '* * * * *', tz: 'UTC', sendsMail: false, run: runRelayOutbox },
];

const RETRIES = { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 30 * 60 };

export interface JobRunnerOptions {
  connectionString: string;
  /** Postgres schema pg-boss owns (default "pgboss"). */
  schema?: string;
  /** Logs counts per run. Never pass names, addresses or message bodies. */
  log?: (line: { job: string; requestId: string; report?: JobReport; error?: string }) => void;
  /**
   * False when no mail transport is configured: the jobs and consumers that send email are not registered, so no
   * send is ever claimed, and events only they consume are marked relayed without a queue. Defaults to true.
   */
  mail?: boolean;
}

export interface JobRunner {
  /** Whether the email jobs and consumers are running (false: no mail transport is configured). */
  mail: boolean;
  /** Runs one job now, outside the schedule (admin trigger, tests). */
  trigger(name: string): Promise<string | null>;
  /** The registered cron schedules, for health checks. */
  schedules(): Promise<{ name: string; cron: string; tz: string }[]>;
  stop(): Promise<void>;
}

/**
 * Starts pg-boss, creates one queue per job with the `stately` policy (at most one queued and one active job, so
 * slow runs never pile up), registers the cron schedules and the workers. Each job id doubles as the request id
 * that correlates its audit rows, events and logs.
 */
export async function startJobRunner(deps: JobDeps, options: JobRunnerOptions): Promise<JobRunner> {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: options.schema ?? 'pgboss',
  });
  const log = options.log ?? (() => {});
  boss.on('error', (error) => log({ job: 'pg-boss', requestId: '-', error: error.message }));
  await boss.start();

  const mail = options.mail ?? true;
  const jobs = JOBS.filter((job) => mail || !job.sendsMail);
  // Without M5's issuer the sign-in link and invite consumers are left off like the mail ones: their events are
  // marked relayed, and no send is claimed that could never carry a token.
  const consumers = CONSUMERS.filter(
    (consumer) =>
      (mail || !consumer.sendsMail) &&
      (deps.issueLoginToken !== undefined || !consumer.needsLoginTokens),
  );
  const consumed = new Set(consumers.map((c) => c.type));
  const bus: EventBus = {
    consumes: (type) => consumed.has(type),
    publish: async (event) => {
      await boss.send(event.type, event, { id: event.id });
    },
  };
  const withBus: JobDeps = { ...deps, bus };

  /** Runs one job, logging counts or the error message (never names, addresses or bodies). */
  const traced = async (job: string, requestId: string, run: () => Promise<JobReport>) => {
    try {
      const report = await run();
      log({ job, requestId, report });
      return report;
    } catch (error) {
      log({ job, requestId, error: error instanceof Error ? error.message : 'unknown error' });
      throw error;
    }
  };

  for (const job of jobs) {
    await boss.createQueue(job.name, { policy: 'stately', ...RETRIES });
    await boss.schedule(job.name, job.cron, null, {
      tz: job.tz,
      missed: job.name === GENERATE_INSTANCES ? 'once' : 'skip',
    });
    await boss.work(job.name, async ([pgJob]) => {
      const requestId = `job:${job.name}:${pgJob?.id ?? randomUUID()}`;
      return traced(job.name, requestId, () => job.run(withBus, requestId));
    });
  }
  // One queue per consumed event type (events.md §1); its job id is the event id.
  for (const consumer of consumers) {
    await boss.createQueue(consumer.type, { policy: 'standard', ...RETRIES });
    await boss.work(consumer.type, async ([pgJob]) => {
      const event = OutboxEventSchema.parse(pgJob?.data);
      const requestId = `job:${consumer.type}:${event.id}`;
      return traced(consumer.type, requestId, () => consumer.handle(withBus, event, requestId));
    });
  }
  return {
    mail,
    trigger: (name) => {
      if (!jobs.some((job) => job.name === name)) {
        throw new RangeError(
          JOBS.some((job) => job.name === name)
            ? `Job not running without a mail transport: ${name}`
            : `Unknown job: ${name}`,
        );
      }
      return boss.send(name, {});
    },
    schedules: async () =>
      (await boss.getSchedules()).map((s) => ({ name: s.name, cron: s.cron, tz: s.timezone })),
    stop: () => boss.stop({ graceful: true }),
  };
}
