import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SIGNED_URL_TTL_SECONDS, type SignedUrl } from '@canopy/contracts';

/**
 * Where finished exports are stored. Keys are made by the API, never by the requester. Signed URLs expire in
 * 5 minutes and are never logged or stored (root CLAUDE.md non-negotiable 6).
 */
export interface ExportFiles {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Stores a file of unknown length as it is produced (the client archive), never holding it all in memory. */
  putStream(key: string, body: AsyncIterable<Uint8Array>, contentType: string): Promise<void>;
  /**
   * The bytes of an evidence file in the same bucket (keys under `evidence/`), or null when it is missing. For the
   * client archive only; never logged.
   */
  open(key: string): Promise<AsyncIterable<Uint8Array> | null>;
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

  async putStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentType: string,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    this.files.set(key, { bytes: Buffer.concat(chunks), contentType });
  }

  async open(key: string): Promise<AsyncIterable<Uint8Array> | null> {
    const file = this.files.get(key);
    if (!file) return null;
    const { bytes } = file;
    return (async function* () {
      yield bytes;
    })();
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

/** S3 multipart parts must be at least 5 MiB except the last; 8 MiB keeps a 100 GB archive under 13,000 parts. */
export const PART_BYTES = 8 * 1024 * 1024;

/** Groups a byte stream into parts of `size` bytes (the last may be shorter). */
export async function* partsOf(
  body: AsyncIterable<Uint8Array>,
  size: number,
): AsyncIterable<Buffer> {
  let pending: Buffer[] = [];
  let length = 0;
  for await (const chunk of body) {
    pending.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    length += chunk.byteLength;
    while (length >= size) {
      const all = Buffer.concat(pending, length);
      yield all.subarray(0, size);
      pending = [all.subarray(size)];
      length -= size;
    }
  }
  if (length > 0) yield Buffer.concat(pending, length);
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

  /** One PUT when the file fits in one part, else a multipart upload that is aborted if anything fails. */
  async putStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentType: string,
  ): Promise<void> {
    const { bucket } = this.options;
    const parts = partsOf(body, PART_BYTES)[Symbol.asyncIterator]();
    const first = await parts.next();
    const second = first.done ? first : await parts.next();
    if (second.done) {
      await this.put(key, first.done ? new Uint8Array() : first.value, contentType);
      return;
    }
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    );
    try {
      const done: { ETag: string | undefined; PartNumber: number }[] = [];
      const upload = async (bytes: Buffer) => {
        const PartNumber = done.length + 1;
        const { ETag } = await this.client.send(
          new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber, Body: bytes }),
        );
        done.push({ ETag, PartNumber });
      };
      await upload(first.value as Buffer);
      await upload(second.value);
      for (let next = await parts.next(); !next.done; next = await parts.next()) {
        await upload(next.value);
      }
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId,
          MultipartUpload: { Parts: done },
        }),
      );
    } catch (error) {
      await this.client
        .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId }))
        .catch(() => undefined);
      throw error;
    }
  }

  async open(key: string): Promise<AsyncIterable<Uint8Array> | null> {
    try {
      const { Body } = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return (Body as AsyncIterable<Uint8Array> | undefined) ?? null;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
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
