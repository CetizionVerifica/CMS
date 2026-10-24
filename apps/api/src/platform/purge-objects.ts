import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

/** Where an account's files live in the shared bucket: evidence (M7), imports (M8) and exports (M10). */
export const accountPrefixes = (accountId: string): string[] => [
  `evidence/${accountId}/`,
  `imports/${accountId}/`,
  `exports/${accountId}/`,
];

/** Deletes every object under a prefix and says how many went. Keys never leave it: they carry file names. */
export interface AccountObjects {
  deletePrefix(prefix: string): Promise<number>;
}

export interface S3AccountObjectsOptions {
  endpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The two calls the purge makes; tests pass a fake. */
type S3Send = Pick<S3Client, 'send'>;

/** S3's DeleteObjects takes at most 1,000 keys, as many as one ListObjectsV2 page returns. */
export function createS3AccountObjects(
  options: S3AccountObjectsOptions,
  client: S3Send = new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  }),
): AccountObjects {
  const Bucket = options.bucket;
  return {
    async deletePrefix(prefix) {
      let deleted = 0;
      // Each page is listed after the previous one is deleted, so no continuation token is needed.
      for (;;) {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, MaxKeys: 1000 }),
        );
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (keys.length === 0) return deleted;
        const result = await client.send(
          new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys, Quiet: true } }),
        );
        // A failed key is not named in the error: it carries the account's file names.
        if (result.Errors?.length) throw new Error(`${result.Errors.length} objects not deleted`);
        deleted += keys.length;
      }
    },
  };
}
