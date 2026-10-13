import { describe, expect, it, vi } from 'vitest';
import { wiringFromEnv } from './wiring.js';

const DB = { DATABASE_URL: 'postgres://app@localhost:5432/canopy' };
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
    expect(options.imports).toBeUndefined();
    await database?.close();
  });

  it('mounts M8 when S3 upload storage is configured', async () => {
    const { options, database } = wiringFromEnv({ ...DB, ...S3 }, vi.fn());
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
