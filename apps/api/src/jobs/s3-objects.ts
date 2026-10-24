import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import type { S3Settings } from '../s3-env.js';
import {
  ScanInterruptedError,
  ScanServiceError,
  ScanTimeoutError,
  type EvidenceObjects,
} from './ports.js';

/** The part of the S3 client the reader uses; tests pass a fake. */
export type S3Send = Pick<S3Client, 'send'>;

/** A connection that does not open in this long, or a socket idle this long mid-transfer, fails the read. */
export const S3_CONNECT_MS = 10_000;
export const S3_IDLE_MS = 60_000;

function s3Client(settings: S3Settings): S3Send {
  return new S3Client({
    region: settings.region,
    ...(settings.endpoint ? { endpoint: settings.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    requestHandler: { connectionTimeout: S3_CONNECT_MS, requestTimeout: S3_IDLE_MS },
  });
}

/** Errors that say storage or its credentials are broken for every file, not this one. */
const SERVICE_ERRORS = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'InvalidToken',
  'NoSuchBucket',
]);

function sorted(error: unknown, signal: AbortSignal | undefined): Error {
  if (signal?.aborted) return new ScanTimeoutError('The read was stopped at its deadline');
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  const name = error instanceof Error ? error.name : '';
  // No status: the request never got an answer (network, DNS, a timeout).
  if (status === undefined || status >= 500 || status === 401 || SERVICE_ERRORS.has(name)) {
    return new ScanServiceError('Object storage could not be read');
  }
  // Another 4xx (403 on one object, say) is about the file: counted against it.
  return new Error('Object storage refused the file');
}

/** An error mid-transfer is counted against the file and stops the run (`ScanInterruptedError`). */
async function* guarded(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of body) yield chunk;
  } catch {
    throw signal?.aborted
      ? new ScanTimeoutError('The read was stopped at its deadline')
      : new ScanInterruptedError('Object storage stopped sending the file');
  }
}

/**
 * Streams evidence bytes from the evidence bucket (`S3_*`) for the scan job. The key and bytes are never logged, and
 * the errors it throws never quote the SDK's message, which can name the key.
 */
export function s3EvidenceObjects(
  settings: S3Settings,
  client: S3Send = s3Client(settings),
): EvidenceObjects {
  return {
    async open(storageKey, signal) {
      let body: unknown;
      try {
        ({ Body: body } = await client.send(
          new GetObjectCommand({ Bucket: settings.bucket, Key: storageKey }),
          { ...(signal && { abortSignal: signal }) },
        ));
      } catch (error) {
        if (error instanceof NoSuchKey) return null;
        throw sorted(error, signal);
      }
      if (!body || typeof body !== 'object' || !(Symbol.asyncIterator in body)) {
        throw new ScanServiceError('Object storage returned no stream');
      }
      return guarded(body as AsyncIterable<Uint8Array>, signal);
    },
  };
}
