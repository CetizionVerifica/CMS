import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobDeps } from './ports.js';
import type { JobRunner, JobRunnerOptions } from './runner.js';

const started: { deps: JobDeps; options: JobRunnerOptions }[] = [];
const close = vi.fn();
let failStart = false;

vi.mock('./runner.js', () => ({
  startJobRunner: async (deps: JobDeps, options: JobRunnerOptions): Promise<JobRunner> => {
    if (failStart) throw new Error('pg-boss did not start');
    started.push({ deps, options });
    return {
      mail: options.mail ?? true,
      trigger: async () => null,
      schedules: async () => [],
      stop: async () => {},
    };
  },
}));
vi.mock('./smtp-mailer.js', async (actual) => ({
  ...(await actual<typeof import('./smtp-mailer.js')>()),
  smtpMailer: () => ({ send: async () => {}, close }),
}));

const { startJobsFromEnv } = await import('./start.js');
const issueLoginToken = async () => ({ token: 't', expiresAt: '2026-10-13T10:00:00.000Z' });
const options = { db: {} as never, connectionString: 'postgres://unused', issueLoginToken };
const SMTP = {
  SMTP_HOST: 'smtp.example.com',
  MAIL_FROM: 'PlanetPulse Compliance <no-reply@planetpulse.example>',
  APP_URL: 'https://app.planetpulse.example',
};

describe('startJobsFromEnv', () => {
  afterEach(() => {
    started.length = 0;
    close.mockClear();
    failStart = false;
  });

  it('without an SMTP server, starts the jobs that send nothing, with a mailer that refuses', async () => {
    const runner = await startJobsFromEnv({}, options);
    expect(runner.mail).toBe(false);
    expect(started).toHaveLength(1);
    expect(started[0]!.options.mail).toBe(false);
    await expect(started[0]!.deps.mailer.send({} as never)).rejects.toThrow(
      'No mail transport is configured',
    );
  });

  it('with an SMTP server, starts every job and closes the transport on stop', async () => {
    const runner = await startJobsFromEnv(SMTP, options);
    expect(runner.mail).toBe(true);
    expect(started[0]!.options.mail).toBe(true);
    expect(started[0]!.deps.appUrl).toBe('https://app.planetpulse.example');
    expect(started[0]!.deps.issueLoginToken).toBe(issueLoginToken);
    expect(close).not.toHaveBeenCalled();
    await runner.stop();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the transport when the runner fails to start', async () => {
    failStart = true;
    await expect(startJobsFromEnv(SMTP, options)).rejects.toThrow('pg-boss did not start');
    expect(close).toHaveBeenCalledOnce();
  });

  it('defaults to the system clock', async () => {
    await startJobsFromEnv({}, options);
    expect(Date.parse(started[0]!.deps.clock())).not.toBeNaN();
  });
});
