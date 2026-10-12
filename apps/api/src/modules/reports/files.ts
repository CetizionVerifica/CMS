import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SIGNED_URL_TTL_SECONDS, type SignedUrl } from '@canopy/contracts';

/**
 * Where finished exports are stored. Keys are made by the API, never by the requester. Signed URLs expire in
 * 5 minutes and are never logged or stored (root CLAUDE.md non-negotiable 6).
 */
export interface ExportFiles {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** A presigned GET that downloads the file as `fileName`. */
  signedUrl(key: string, fileName: string, now: Date): Promise<SignedUrl>;
}

function expiresAt(now: Date): string {
  return new Date(now.getTime() + SIGNED_URL_TTL_SECONDS * 1000).toISOString();
}

/** In-memory files for tests and local runs without object storage. */
export class MemoryExportFiles implements ExportFiles {
  readonly files = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.files.set(key, { bytes, contentType });
  }

  async signedUrl(key: string, _fileName: string, now: Date): Promise<SignedUrl> {
    return { url: `https://files.invalid/${encodeURIComponent(key)}`, expiresAt: expiresAt(now) };
  }
}

export interface S3ExportFilesOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** S3-compatible storage (SeaweedFS locally, S3 in production). */
export class S3ExportFiles implements ExportFiles {
  private readonly client: S3Client;

  constructor(private readonly options: S3ExportFilesOptions) {
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint === undefined
        ? {}
        : { endpoint: options.endpoint, forcePathStyle: true }),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }

  async signedUrl(key: string, fileName: string, now: Date): Promise<SignedUrl> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${fileName.replace(/["\\]/g, '')}"`,
      }),
      { expiresIn: SIGNED_URL_TTL_SECONDS, signingDate: now },
    );
    return { url, expiresAt: expiresAt(now) };
  }
}
