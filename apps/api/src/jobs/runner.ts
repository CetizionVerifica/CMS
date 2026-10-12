import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { runConsultantDigest, CONSULTANT_DIGEST } from './digest.js';
import { GENERATE_INSTANCES, runGenerateInstances } from './generate-instances.js';
import type { JobDeps, JobReport } from './ports.js';
import { REMINDERS, runReminders } from './reminders.js';

export interface JobDefinition {
  name: string;
  /** Cron expression, evaluated in `tz`. */
  cron: string;
  tz: string;
  run(deps: JobDeps, requestId: string): Promise<JobReport>;
}

/**
 * The schedule. Generation runs nightly at 01:00 India time and catches up once after downtime. Reminders and the
 * digest run every 15 minutes in UTC and decide per client whether its local send time has passed, so each client
 * is served in its own time zone; missed slots are skipped because the next run covers them.
 */
export const JOBS: readonly JobDefinition[] = [
  { name: GENERATE_INSTANCES, cron: '0 1 * * *', tz: 'Asia/Kolkata', run: runGenerateInstances },
  { name: REMINDERS, cron: '*/15 * * * *', tz: 'UTC', run: runReminders },
  { name: CONSULTANT_DIGEST, cron: '*/15 * * * *', tz: 'UTC', run: runConsultantDigest },
];

export interface JobRunnerOptions {
  connectionString: string;
  /** Postgres schema pg-boss owns (default "pgboss"). */
  schema?: string;
  /** Logs counts per run. Never pass names, addresses or message bodies. */
  log?: (line: { job: string; requestId: string; report?: JobReport; error?: string }) => void;
}

export interface JobRunner {
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
  for (const job of JOBS) {
    await boss.createQueue(job.name, {
      policy: 'stately',
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 30 * 60,
    });
    await boss.schedule(job.name, job.cron, null, {
      tz: job.tz,
      missed: job.name === GENERATE_INSTANCES ? 'once' : 'skip',
    });
    await boss.work(job.name, async ([pgJob]) => {
      const requestId = `job:${job.name}:${pgJob?.id ?? randomUUID()}`;
      try {
        const report = await job.run(deps, requestId);
        log({ job: job.name, requestId, report });
        return report;
      } catch (error) {
        log({
          job: job.name,
          requestId,
          error: error instanceof Error ? error.message : 'unknown error',
        });
        throw error;
      }
    });
  }
  return {
    trigger: (name) => {
      if (!JOBS.some((job) => job.name === name)) throw new RangeError(`Unknown job: ${name}`);
      return boss.send(name, {});
    },
    schedules: async () =>
      (await boss.getSchedules()).map((s) => ({ name: s.name, cron: s.cron, tz: s.timezone })),
    stop: () => boss.stop({ graceful: true }),
  };
}
