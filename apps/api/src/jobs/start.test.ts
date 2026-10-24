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
      loginEmails: deps.issueLoginToken !== undefined,
      scan: deps.scanner !== undefined,
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
const S3 = {
  S3_BUCKET: 'canopy-evidence',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};
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

  it("runs pg-boss as its own login from JOBS_DATABASE_URL, not the API's", async () => {
    await startJobsFromEnv({ JOBS_DATABASE_URL: 'postgres://jobs@db/canopy' }, options);
    expect(started[0]!.options.connectionString).toBe('postgres://jobs@db/canopy');
  });

  it("falls back to the API's connection without JOBS_DATABASE_URL, as in local development", async () => {
    await startJobsFromEnv({ JOBS_DATABASE_URL: '' }, options);
    expect(started[0]!.options.connectionString).toBe('postgres://unused');
  });

  it('leaves the issuer out when the API passes none', async () => {
    await startJobsFromEnv(SMTP, { db: {} as never, connectionString: 'postgres://unused' });
    expect(started[0]!.deps).not.toHaveProperty('issueLoginToken');
    expect(started[0]!.deps).not.toHaveProperty('copyLibrary');
  });

  it("passes M6's library copier through, with or without mail", async () => {
    const copyLibrary = async () => ({ copied: true, categories: 0, acts: 0, obligations: 0 });
    await startJobsFromEnv({}, { ...options, copyLibrary });
    await startJobsFromEnv(SMTP, { ...options, copyLibrary });
    expect(started.map((s) => s.deps.copyLibrary)).toEqual([copyLibrary, copyLibrary]);
  });

  it('leaves the scan off without a scanner', async () => {
    const runner = await startJobsFromEnv(SMTP, options);
    expect(runner.scan).toBe(false);
    expect(started[0]!.deps).not.toHaveProperty('scanner');
    expect(started[0]!.deps).not.toHaveProperty('evidenceObjects');
  });

  it('scans with clamd at CLAMAV_HOST, reading the S3 evidence bucket', async () => {
    const runner = await startJobsFromEnv({ ...S3, CLAMAV_HOST: 'clamav' }, options);
    expect(runner.scan).toBe(true);
    expect(started[0]!.deps.scanner).toBeDefined();
    expect(started[0]!.deps.evidenceObjects).toBeDefined();
  });

  it('scans with a given scanner instead of clamd, also without mail', async () => {
    const scanner = { scan: async () => ({ status: 'CLEAN' as const }) };
    const runner = await startJobsFromEnv(S3, { ...options, scanner });
    expect(runner.mail).toBe(false);
    expect(runner.scan).toBe(true);
    expect(started[0]!.deps.scanner).toBe(scanner);
  });

  it('refuses a scanner without evidence storage', async () => {
    await expect(startJobsFromEnv({ CLAMAV_HOST: 'clamav' }, options)).rejects.toThrow(
      'A virus scanner is set but evidence storage is not',
    );
    expect(started).toHaveLength(0);
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
