import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import type { S3Settings } from '../s3-env.js';
import type { EvidenceObjects } from './ports.js';

/** The part of the S3 client the reader uses; tests pass a fake. */
export type S3Send = Pick<S3Client, 'send'>;

function s3Client(settings: S3Settings): S3Send {
  return new S3Client({
    region: settings.region,
    ...(settings.endpoint ? { endpoint: settings.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  });
}

/** Streams evidence bytes from the evidence bucket (`S3_*`) for the scan job. The key and bytes are never logged. */
export function s3EvidenceObjects(
  settings: S3Settings,
  client: S3Send = s3Client(settings),
): EvidenceObjects {
  return {
    async open(storageKey) {
      try {
        const { Body } = await client.send(
          new GetObjectCommand({ Bucket: settings.bucket, Key: storageKey }),
        );
        if (!Body || !(Symbol.asyncIterator in Body))
          throw new Error('Object storage returned no stream');
        return Body as AsyncIterable<Uint8Array>;
      } catch (error) {
        if (error instanceof NoSuchKey) return null;
        throw error;
      }
    },
  };
}
