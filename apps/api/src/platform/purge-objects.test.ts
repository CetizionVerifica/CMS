import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { accountPrefixes, createS3AccountObjects } from './purge-objects.js';

const ACCOUNT = '01920000-0000-7000-8000-00000000000b';
const OPTIONS = { region: 'us-east-1', bucket: 'canopy', accessKeyId: 'k', secretAccessKey: 's' };

/** A bucket of keys that answers ListObjectsV2 and DeleteObjects as S3 does, `page` keys at a time. */
function fakeBucket(keys: string[], page = 1000, failOn?: string) {
  const store = new Set(keys);
  const calls: string[] = [];
  const client = {
    send: async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        const { Prefix, Bucket, MaxKeys } = command.input;
        calls.push(`list ${Bucket} ${Prefix} ${MaxKeys}`);
        const found = [...store].filter((k) => k.startsWith(Prefix!)).slice(0, page);
        return { Contents: found.map((Key) => ({ Key })) };
      }
      if (command instanceof DeleteObjectsCommand) {
        const objects = command.input.Delete!.Objects!;
        calls.push(`delete ${objects.length} quiet=${command.input.Delete!.Quiet}`);
        const errors = objects.filter((o) => o.Key === failOn).map((o) => ({ Key: o.Key }));
        for (const o of objects) if (o.Key !== failOn) store.delete(o.Key!);
        return errors.length ? { Errors: errors } : {};
      }
      throw new Error('unexpected command');
    },
  };
  return { store, calls, client: client as never };
}

describe('the account purge’s object storage', () => {
  it('names the evidence, import and export prefixes of one account, each ending in a slash', () => {
    expect(accountPrefixes(ACCOUNT)).toEqual([
      `evidence/${ACCOUNT}/`,
      `imports/${ACCOUNT}/`,
      `exports/${ACCOUNT}/`,
    ]);
  });

  it('deletes every object under the prefix, page by page, and nothing else', async () => {
    const mine = Array.from({ length: 5 }, (_, i) => `evidence/${ACCOUNT}/c/i/${i}`);
    const other = `evidence/01920000-0000-7000-8000-00000000000a/c/i/0`;
    const bucket = fakeBucket([...mine, other], 2);
    const objects = createS3AccountObjects(OPTIONS, bucket.client);
    expect(await objects.deletePrefix(`evidence/${ACCOUNT}/`)).toBe(5);
    expect([...bucket.store]).toEqual([other]);
    expect(bucket.calls).toEqual([
      `list canopy evidence/${ACCOUNT}/ 1000`,
      'delete 2 quiet=true',
      `list canopy evidence/${ACCOUNT}/ 1000`,
      'delete 2 quiet=true',
      `list canopy evidence/${ACCOUNT}/ 1000`,
      'delete 1 quiet=true',
      `list canopy evidence/${ACCOUNT}/ 1000`,
    ]);
    expect(await objects.deletePrefix(`evidence/${ACCOUNT}/`)).toBe(0);
  });

  it('fails without naming a key when an object is not deleted', async () => {
    const key = `exports/${ACCOUNT}/c/j/Kestrel register.xlsx`;
    const bucket = fakeBucket([key], 1000, key);
    const error = await createS3AccountObjects(OPTIONS, bucket.client)
      .deletePrefix(`exports/${ACCOUNT}/`)
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('1 objects not deleted');
    expect((error as Error).message).not.toContain('Kestrel');
  });

  it('builds its own client from the settings', () => {
    expect(
      createS3AccountObjects({ ...OPTIONS, endpoint: 'http://localhost:8333' }),
    ).toHaveProperty('deletePrefix');
  });
});
