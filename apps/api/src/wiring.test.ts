import { describe, expect, it, vi } from 'vitest';

const copyMasterLibrary = vi.fn();
vi.mock('./modules/library/db-library-copy.js', () => ({ copyMasterLibrary }));
const copyIsoCatalogue = vi.fn();
vi.mock('./modules/library/db-iso-catalogue-copy.js', () => ({ copyIsoCatalogue }));
import { AuthService } from './auth/index.js';
import { PostgresReportsStore } from './modules/dashboard/db-store.js';
import { S3ExportFiles } from './modules/reports/files.js';
const { jobsFromEnv, wiringFromEnv } = await import('./wiring.js');

const KEY = Buffer.alloc(32, 7).toString('base64');
const DB = { DATABASE_URL: 'postgres://app@localhost:5432/canopy', AUTH_SECRET_KEY: KEY };
const S3 = { S3_BUCKET: 'imports', S3_ACCESS_KEY_ID: 'key', S3_SECRET_ACCESS_KEY: 'secret' };

describe('wiringFromEnv', () => {
  it('mounts nothing that needs a database without DATABASE_URL', () => {
    const wiring = wiringFromEnv({ ...S3 }, vi.fn());
    expect(wiring).toEqual({ options: {} });
  });

  it('mounts M6 and M7 on one database, and not M8 without upload storage', async () => {
    const { options, database } = wiringFromEnv({ ...DB }, vi.fn());
    expect(database).toBeDefined();
    expect(options.database).toBe(database);
    expect(options.libraryAndEntities?.store).toBeDefined();
    expect(options.reports?.store).toBeInstanceOf(PostgresReportsStore);
    expect(options.reports?.files).toBeUndefined();
    expect(options.imports).toBeUndefined();
    expect(options.evidenceStorage).toBeUndefined();
    await database?.close();
  });

  it('serves sign-in from the database store, sealing MFA secrets with AUTH_SECRET_KEY', async () => {
    const { options, database, auth } = wiringFromEnv({ ...DB }, vi.fn());
    expect(options.accountStore).toBeDefined();
    expect(options.authSecretKey).toBe(KEY);
    expect(auth).toBeInstanceOf(AuthService);
    await database?.close();
  });

  it('mounts the operator API on its own login only with PLATFORM_ENABLED=true', async () => {
    const off = wiringFromEnv({ ...DB, PLATFORM_ENABLED: 'false' }, vi.fn());
    expect(off.options.platform).toBeUndefined();
    expect(off.operatorDatabase).toBeUndefined();
    await off.database?.close();
    const env = {
      ...DB,
      PLATFORM_ENABLED: 'true',
      OPERATOR_DATABASE_URL: 'postgres://console@localhost:5432/canopy',
      PLATFORM_IP_ALLOWLIST: '203.0.113.0/24',
      APP_URL: 'https://app.planetpulse.example/',
    };
    const on = wiringFromEnv(env, vi.fn());
    expect(on.options.platform?.db).toBe(on.operatorDatabase);
    expect(on.options.platform?.appUrl).toBe('https://app.planetpulse.example');
    expect(on.options.platform?.secrets).toBeDefined();
    expect(on.options.platform?.allowlist?.('203.0.113.4')).toBe(true);
    expect(on.options.platform?.allowlist?.('198.51.100.4')).toBe(false);
    await on.database?.close();
    await on.operatorDatabase?.close();
  });

  it('refuses a half-set or reused operator login, a missing APP_URL, and a PLATFORM_ENABLED that is not a boolean', () => {
    expect(() => wiringFromEnv({ ...DB, PLATFORM_ENABLED: 'true' }, vi.fn())).toThrow(
      /OPERATOR_DATABASE_URL is required/,
    );
    expect(() =>
      wiringFromEnv(
        { ...DB, PLATFORM_ENABLED: 'true', OPERATOR_DATABASE_URL: DB.DATABASE_URL },
        vi.fn(),
      ),
    ).toThrow(/its own login/);
    // The same user spelled differently (another host, an encoded name) is still the app's login.
    for (const OPERATOR_DATABASE_URL of [
      'postgres://app:other@127.0.0.1:5432/canopy',
      'postgresql://%61pp@db.internal/canopy?sslmode=require',
    ]) {
      expect(() =>
        wiringFromEnv({ ...DB, PLATFORM_ENABLED: 'true', OPERATOR_DATABASE_URL }, vi.fn()),
      ).toThrow(/its own login/);
    }
    expect(() => wiringFromEnv({ ...DB, PLATFORM_ENABLED: 'yes' }, vi.fn())).toThrow(
      /PLATFORM_ENABLED must be/,
    );
    expect(() =>
      wiringFromEnv(
        {
          ...DB,
          PLATFORM_ENABLED: 'true',
          OPERATOR_DATABASE_URL: 'postgres://console@localhost:5432/canopy',
          PLATFORM_IP_ALLOWLIST: 'office',
        },
        vi.fn(),
      ),
    ).toThrow(/PLATFORM_IP_ALLOWLIST/);
    for (const APP_URL of [undefined, 'app.planetpulse.example', 'ftp://app.planetpulse.example']) {
      expect(() =>
        wiringFromEnv(
          {
            ...DB,
            PLATFORM_ENABLED: 'true',
            OPERATOR_DATABASE_URL: 'postgres://console@localhost:5432/canopy',
            ...(APP_URL === undefined ? {} : { APP_URL }),
          },
          vi.fn(),
        ),
      ).toThrow(/APP_URL is required/);
    }
  });

  it('refuses the operator API in production without PLATFORM_IP_ALLOWLIST', async () => {
    const env = {
      ...DB,
      NODE_ENV: 'production',
      PLATFORM_ENABLED: 'true',
      OPERATOR_DATABASE_URL: 'postgres://console@localhost:5432/canopy',
      APP_URL: 'https://app.planetpulse.example',
    };
    for (const PLATFORM_IP_ALLOWLIST of [undefined, ' ']) {
      expect(() =>
        wiringFromEnv(
          { ...env, ...(PLATFORM_IP_ALLOWLIST === undefined ? {} : { PLATFORM_IP_ALLOWLIST }) },
          vi.fn(),
        ),
      ).toThrow(/PLATFORM_IP_ALLOWLIST is required/);
    }
    // Support session tokens go to APP_URL, so production refuses a plain-http one.
    expect(() =>
      wiringFromEnv(
        {
          ...env,
          PLATFORM_IP_ALLOWLIST: '203.0.113.0/24',
          APP_URL: 'http://app.planetpulse.example',
        },
        vi.fn(),
      ),
    ).toThrow(/APP_URL must use https in production/);
    const allowed = wiringFromEnv({ ...env, PLATFORM_IP_ALLOWLIST: '203.0.113.0/24' }, vi.fn());
    expect(allowed.options.platform?.allowlist?.('203.0.113.4')).toBe(true);
    await allowed.database?.close();
    await allowed.operatorDatabase?.close();
  });

  it('refuses to start with a database but no usable AUTH_SECRET_KEY', () => {
    const noKey = { DATABASE_URL: DB.DATABASE_URL };
    expect(() => wiringFromEnv(noKey, vi.fn())).toThrow(/AUTH_SECRET_KEY is required/);
    expect(() => wiringFromEnv({ ...noKey, AUTH_SECRET_KEY: '' }, vi.fn())).toThrow(
      /AUTH_SECRET_KEY is required/,
    );
    expect(() =>
      wiringFromEnv({ ...DB, AUTH_SECRET_KEY: Buffer.alloc(16).toString('base64') }, vi.fn()),
    ).toThrow(/32 bytes/);
  });

  it('mounts M7 evidence, M8 and M10 export files when S3 object storage is configured', async () => {
    const { options, database } = wiringFromEnv({ ...DB, ...S3 }, vi.fn());
    expect(options.evidenceStorage).toBeDefined();
    expect(options.reports?.files).toBeInstanceOf(S3ExportFiles);
    expect(options.imports?.files).toBeDefined();
    expect(options.imports?.store).toBeDefined();
    expect(typeof options.imports?.inferRule).toBe('function');
    await database?.close();
  });

  it('logs a failed background parse with the batch id and error class only', async () => {
    const log = vi.fn();
    const { options, database } = wiringFromEnv({ ...DB, ...S3 }, log);
    options.imports?.onBackgroundError?.(
      new TypeError('cell B7 "Ravi Kumar" is not a date'),
      'batch-1',
    );
    options.imports?.onBackgroundError?.('not an error', 'batch-2');
    expect(log.mock.calls).toEqual([
      [{ batchId: 'batch-1', error: 'TypeError' }, 'import parse failed'],
      [{ batchId: 'batch-2', error: 'unknown' }, 'import parse failed'],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('Ravi');
    await database?.close();
  });
});

describe('jobsFromEnv', () => {
  const runner = (mail: boolean, loginEmails = mail, scan = true) => ({
    trigger: vi.fn(),
    schedules: vi.fn(),
    stop: vi.fn(),
    mail,
    loginEmails,
    scan,
  });

  it('starts nothing and says nothing without a database', async () => {
    const start = vi.fn();
    const warn = vi.fn();
    expect(await jobsFromEnv({ ...DB }, undefined, { warn, start })).toBeNull();
    const { database } = wiringFromEnv({ ...DB }, vi.fn());
    expect(await jobsFromEnv({}, database, { warn, start })).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    await database?.close();
  });

  it('boots the jobs on the API database and connection string, with the job log', async () => {
    const { database } = wiringFromEnv({ ...DB }, vi.fn());
    const mailing = runner(true);
    const start = vi.fn().mockResolvedValue(mailing);
    const warn = vi.fn();
    const log = vi.fn();
    const issued = { token: 'raw-token', expiresAt: '2026-10-24T06:15:00.000Z' };
    const auth = { issueLoginToken: vi.fn().mockResolvedValue(issued) };
    const env = { ...DB, SMTP_URL: 'smtp://mail.example:587' };
    expect(await jobsFromEnv(env, database, { warn, log, auth, start })).toBe(mailing);
    expect(start).toHaveBeenCalledWith(env, {
      db: database,
      connectionString: DB.DATABASE_URL,
      log,
      issueLoginToken: expect.any(Function),
      copyLibrary: expect.any(Function),
      copyIsoCatalogue: expect.any(Function),
    });
    expect(warn).not.toHaveBeenCalled();
    // The jobs get M5's issuer, so sign-in link and invite emails carry a fresh token.
    const input = {
      firmId: 'firm-1',
      personId: 'person-1',
      kind: 'INVITE' as const,
      inviteId: 'invite-1',
    };
    await expect(start.mock.calls[0]![1].issueLoginToken(input)).resolves.toEqual(issued);
    expect(auth.issueLoginToken).toHaveBeenCalledWith(input);
    // And M6's copier on the same database, for a new account's master library.
    const report = { copied: true, categories: 0, acts: 0, obligations: 0 };
    copyMasterLibrary.mockResolvedValueOnce(report);
    await expect(start.mock.calls[0]![1].copyLibrary('account-1', 'run-1')).resolves.toBe(report);
    expect(copyMasterLibrary).toHaveBeenCalledWith(database, 'account-1', 'run-1');
    // And M6's ISO catalogue copier, for an account whose ISO add-on comes on.
    const iso = { copied: true };
    copyIsoCatalogue.mockResolvedValueOnce(iso);
    await expect(start.mock.calls[0]![1].copyIsoCatalogue('account-2', 'run-2')).resolves.toBe(iso);
    expect(copyIsoCatalogue).toHaveBeenCalledWith(database, 'account-2', 'run-2');
    await database?.close();
  });

  it('adds the operators’ renewals digest only when the operator API has its database', async () => {
    const start = vi.fn().mockResolvedValue(runner(true));
    const warn = vi.fn();
    const off = wiringFromEnv({ ...DB }, vi.fn());
    await jobsFromEnv({ ...DB }, off.database, { warn, start });
    expect(start.mock.calls[0]![1]).not.toHaveProperty('extraJobs');
    const env = {
      ...DB,
      PLATFORM_ENABLED: 'true',
      OPERATOR_DATABASE_URL: 'postgres://console@localhost:5432/canopy',
      APP_URL: 'https://app.planetpulse.example/',
    };
    const on = wiringFromEnv(env, vi.fn());
    await jobsFromEnv(env, on.database, {
      warn,
      start,
      ...(on.operatorDatabase && { operatorDatabase: on.operatorDatabase }),
    });
    expect(start.mock.calls[1]![1].extraJobs).toEqual([
      expect.objectContaining({ name: 'operator-digest', sendsMail: true }),
    ]);
    // Without object storage the purge stays off, and says so: files must not outlive their rows.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('account purge not started'));
    await Promise.all([off.database?.close(), on.database?.close(), on.operatorDatabase?.close()]);
  });

  it('adds the account purge only with the operator database and object storage', async () => {
    const start = vi.fn().mockResolvedValue(runner(true));
    const warn = vi.fn();
    const storage = {
      S3_BUCKET: 'canopy',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
    };
    const storageOnly = wiringFromEnv({ ...DB, ...storage }, vi.fn());
    await jobsFromEnv({ ...DB, ...storage }, storageOnly.database, { warn, start });
    expect(start.mock.calls[0]![1]).not.toHaveProperty('extraJobs');
    const env = {
      ...DB,
      ...storage,
      PLATFORM_ENABLED: 'true',
      OPERATOR_DATABASE_URL: 'postgres://console@localhost:5432/canopy',
      APP_URL: 'https://app.planetpulse.example/',
    };
    const on = wiringFromEnv(env, vi.fn());
    await jobsFromEnv(env, on.database, {
      warn,
      start,
      ...(on.operatorDatabase && { operatorDatabase: on.operatorDatabase }),
    });
    expect(start.mock.calls[1]![1].extraJobs).toEqual([
      expect.objectContaining({ name: 'operator-digest', sendsMail: true }),
      expect.objectContaining({ name: 'account-purge', sendsMail: false, catchUp: true }),
    ]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('account purge'));
    await Promise.all([
      storageOnly.database?.close(),
      on.database?.close(),
      on.operatorDatabase?.close(),
    ]);
  });

  it('warns when mail runs but nothing can issue sign-in tokens', async () => {
    const { database } = wiringFromEnv({ ...DB }, vi.fn());
    const start = vi.fn().mockResolvedValue(runner(true, false));
    const warn = vi.fn();
    await jobsFromEnv({ ...DB, SMTP_URL: 'smtp://mail.example:587' }, database, { warn, start });
    expect(start.mock.calls[0]![1]).not.toHaveProperty('issueLoginToken');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/sign-in link and invite emails not sent/);
    await database?.close();
  });

  it('warns when no virus scanner is configured, since evidence then stays unavailable', async () => {
    const { database } = wiringFromEnv({ ...DB }, vi.fn());
    const start = vi.fn().mockResolvedValue(runner(true, true, false));
    const warn = vi.fn();
    const auth = { issueLoginToken: vi.fn() };
    await jobsFromEnv({ ...DB, SMTP_URL: 'smtp://mail.example:587' }, database, {
      warn,
      auth,
      start,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/evidence scan not started/);
    await database?.close();
  });

  it('still starts the jobs without SMTP, and warns without any setting value', async () => {
    const { database } = wiringFromEnv({ ...DB }, vi.fn());
    const silent = runner(false);
    const start = vi.fn().mockResolvedValue(silent);
    const warn = vi.fn();
    expect(await jobsFromEnv({ ...DB }, database, { warn, start })).toBe(silent);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/email jobs not started/);
    expect(warn.mock.calls[0]![0]).not.toContain(DB.DATABASE_URL);
    await database?.close();
  });

  it('fails the boot on half-set mail settings', async () => {
    const { database } = wiringFromEnv({ ...DB }, vi.fn());
    await expect(
      jobsFromEnv({ ...DB, SMTP_HOST: 'mail.example' }, database, { warn: vi.fn() }),
    ).rejects.toThrow(/Mail settings invalid/);
    await database?.close();
  });
});
