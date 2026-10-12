import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Where evidence bytes live: an S3-compatible bucket (SeaweedFS locally, docker/compose.yaml). The API never
 * sees the bytes; clients PUT and GET them with 5-minute presigned URLs (api-conventions.md §6). Signed URLs
 * are returned to the caller only, never logged or stored (root CLAUDE.md rule 6).
 */

/** Presigned URLs live this long (api-conventions.md §6). */
export const SIGNED_URL_SECONDS = 5 * 60;

export interface StoredObject {
  sizeBytes: number;
  mimeType: string;
}

export interface EvidenceStorage {
  /** A PUT URL that only accepts exactly this content type and length. */
  presignPut(
    key: string,
    file: { mimeType: string; sizeBytes: number },
  ): Promise<{ url: string; headers: Record<string, string> }>;
  /** What was stored at `key`, or null when nothing was uploaded. */
  head(key: string): Promise<StoredObject | null>;
  /** A GET URL that downloads the object as `fileName`. */
  presignGet(key: string, fileName: string): Promise<string>;
}

export interface S3StorageOptions {
  endpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** `Content-Disposition` with the file name encoded per RFC 6266, so no header injection is possible. */
export function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function createS3Storage(options: S3StorageOptions): EvidenceStorage {
  const client = new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  });
  const Bucket = options.bucket;
  return {
    async presignPut(key, file) {
      const command = new PutObjectCommand({
        Bucket,
        Key: key,
        ContentType: file.mimeType,
        ContentLength: file.sizeBytes,
      });
      const url = await getSignedUrl(client, command, {
        expiresIn: SIGNED_URL_SECONDS,
        signableHeaders: new Set(['content-type', 'content-length']),
      });
      return {
        url,
        headers: { 'Content-Type': file.mimeType, 'Content-Length': String(file.sizeBytes) },
      };
    },
    async head(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return {
          sizeBytes: head.ContentLength ?? 0,
          mimeType: head.ContentType ?? 'application/octet-stream',
        };
      } catch (error) {
        if (error instanceof NotFound) return null;
        throw error;
      }
    },
    presignGet(key, fileName) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseContentDisposition: attachment(fileName),
        }),
        { expiresIn: SIGNED_URL_SECONDS },
      );
    },
  };
}
