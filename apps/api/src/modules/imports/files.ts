import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3SettingsFromEnv } from '../../s3-env.js';

/**
 * Where uploaded registers live until they are parsed. The browser PUTs the workbook straight to storage
 * with a presigned URL (api-conventions.md: file bytes never pass through the API); the API reads it back to
 * preview and parse it. Workbooks hold employee names: never log their bytes, names or the signed URLs.
 */

/** Who started an upload. Signed into the upload, so the uploader cannot change it. */
export interface UploadMeta {
  readonly clientId: string;
  readonly createdById: string;
  readonly fileName: string;
}

export interface PresignedPut {
  readonly url: string;
  /** Send exactly these headers with the PUT; they are part of the signature. */
  readonly headers: Record<string, string>;
}

export interface StoredUpload {
  readonly bytes: Uint8Array;
  readonly meta: UploadMeta;
}

export interface ImportFiles {
  /** A PUT URL for exactly `sizeBytes` bytes at `key`, valid for `expiresInSeconds`. */
  presignPut(input: {
    key: string;
    sizeBytes: number;
    meta: UploadMeta;
    expiresInSeconds: number;
  }): Promise<PresignedPut>;
  /** The uploaded bytes and their metadata, or null when nothing (or nothing readable) was uploaded there. */
  read(key: string, maxBytes: number): Promise<StoredUpload | null>;
}

/** The storage key of a batch's workbook. The firm comes from the session, so no firm can read another's. */
export function uploadKey(firmId: string, batchId: string): string {
  return `imports/${firmId}/${batchId}`;
}

// S3 user metadata is ASCII, so the file name travels URI-encoded.
const META = {
  clientId: 'client-id',
  createdById: 'created-by-id',
  fileName: 'file-name',
} as const;

function metaHeaders(meta: UploadMeta): Record<string, string> {
  return {
    [META.clientId]: meta.clientId,
    [META.createdById]: meta.createdById,
    [META.fileName]: encodeURIComponent(meta.fileName),
  };
}

function metaFrom(stored: Record<string, string> | undefined): UploadMeta | null {
  const clientId = stored?.[META.clientId];
  const createdById = stored?.[META.createdById];
  const fileName = stored?.[META.fileName];
  if (!clientId || !createdById || !fileName) return null;
  try {
    return { clientId, createdById, fileName: decodeURIComponent(fileName) };
  } catch {
    return null;
  }
}

export interface S3ImportFilesOptions {
  readonly client: S3Client;
  readonly bucket: string;
}

/** Imports on S3-compatible storage (SeaweedFS locally, see docker/compose.yaml). */
export function s3ImportFiles({ client, bucket }: S3ImportFilesOptions): ImportFiles {
  return {
    async presignPut({ key, sizeBytes, meta, expiresInSeconds }) {
      const metadata = metaHeaders(meta);
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentLength: sizeBytes,
        Metadata: metadata,
      });
      const headers = Object.fromEntries(
        Object.entries(metadata).map(([name, value]) => [`x-amz-meta-${name}`, value]),
      );
      // Metadata stays in signed headers rather than the query string, so storage keeps it with the object
      // and the uploader cannot change it without breaking the signature.
      const url = await getSignedUrl(client, command, {
        expiresIn: expiresInSeconds,
        unhoistableHeaders: new Set(Object.keys(headers)),
        signableHeaders: new Set(['content-length', ...Object.keys(headers)]),
      });
      return { url, headers };
    },

    async read(key, maxBytes) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const meta = metaFrom(object.Metadata);
        if (!meta || !object.Body || (object.ContentLength ?? 0) > maxBytes) {
          object.Body?.transformToWebStream()
            .cancel()
            .catch(() => undefined);
          return null;
        }
        const bytes = await object.Body.transformToByteArray();
        return bytes.byteLength > maxBytes ? null : { bytes, meta };
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
          return null;
        }
        throw error;
      }
    },
  };
}

/** S3 settings from the environment (`.env.example`). Null when storage is not configured. */
export function s3ImportFilesFromEnv(env: NodeJS.ProcessEnv): ImportFiles | null {
  const settings = s3SettingsFromEnv(env);
  if (!settings) return null;
  const client = new S3Client({
    region: settings.region,
    ...(settings.endpoint ? { endpoint: settings.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  });
  return s3ImportFiles({ client, bucket: settings.bucket });
}

/** In-memory storage for tests: `put` stands in for the browser's PUT. */
export class MemoryImportFiles implements ImportFiles {
  readonly objects = new Map<string, StoredUpload>();
  readonly tickets = new Map<string, { sizeBytes: number; meta: UploadMeta }>();

  async presignPut({ key, sizeBytes, meta }: Parameters<ImportFiles['presignPut']>[0]) {
    this.tickets.set(key, { sizeBytes, meta });
    return {
      url: `https://storage.test/${key}?signature=test`,
      headers: Object.fromEntries(
        Object.entries(metaHeaders(meta)).map(([n, v]) => [`x-amz-meta-${n}`, v]),
      ),
    };
  }

  /** Uploads bytes against an earlier ticket, as the browser would. */
  put(key: string, bytes: Uint8Array): void {
    const ticket = this.tickets.get(key);
    if (!ticket) throw new Error('No upload ticket for that key');
    this.objects.set(key, { bytes, meta: ticket.meta });
  }

  async read(key: string, maxBytes: number): Promise<StoredUpload | null> {
    const stored = this.objects.get(key);
    return stored && stored.bytes.byteLength <= maxBytes ? stored : null;
  }
}
