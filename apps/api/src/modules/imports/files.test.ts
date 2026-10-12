import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { MemoryImportFiles, s3ImportFiles, s3ImportFilesFromEnv, uploadKey } from './files.js';

const meta = { clientId: 'c1', createdById: 'p1', fileName: 'Régister 2023.xlsx' };

function client(): S3Client {
  return new S3Client({
    region: 'ap-south-1',
    endpoint: 'http://storage.local:9000',
    forcePathStyle: true,
    credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
  });
}

function body(bytes: Uint8Array) {
  return {
    transformToByteArray: async () => bytes,
    transformToWebStream: () => new ReadableStream(),
  };
}

describe('s3ImportFiles', () => {
  it('signs a 5-minute PUT with the size and metadata as signed headers', async () => {
    const files = s3ImportFiles({ client: client(), bucket: 'imports' });
    const put = await files.presignPut({
      key: uploadKey('f1', 'b1'),
      sizeBytes: 1234,
      meta,
      expiresInSeconds: 300,
    });
    const url = new URL(put.url);
    expect(url.pathname).toBe('/imports/imports/f1/b1');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    const signed = url.searchParams.get('X-Amz-SignedHeaders')?.split(';') ?? [];
    expect(signed).toEqual(
      expect.arrayContaining([
        'content-length',
        'x-amz-meta-client-id',
        'x-amz-meta-created-by-id',
        'x-amz-meta-file-name',
      ]),
    );
    expect(put.headers).toEqual({
      'x-amz-meta-client-id': 'c1',
      'x-amz-meta-created-by-id': 'p1',
      'x-amz-meta-file-name': encodeURIComponent(meta.fileName),
    });
    // Metadata is never in the URL, so it cannot be changed without breaking the signature.
    expect([...url.searchParams.keys()].filter((k) => /^x-amz-meta-/i.test(k))).toEqual([]);
  });

  it('reads an upload with its metadata', async () => {
    const s3 = client();
    const bytes = new Uint8Array([1, 2, 3]);
    const send = vi.spyOn(s3, 'send').mockResolvedValue({
      Body: body(bytes),
      ContentLength: 3,
      Metadata: {
        'client-id': 'c1',
        'created-by-id': 'p1',
        'file-name': encodeURIComponent(meta.fileName),
      },
    } as never);
    const files = s3ImportFiles({ client: s3, bucket: 'imports' });
    expect(await files.read('k', 10)).toEqual({ bytes, meta });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
  });

  it('treats a missing, oversized or unlabelled object as no upload', async () => {
    const s3 = client();
    const files = s3ImportFiles({ client: s3, bucket: 'imports' });
    const send = vi.spyOn(s3, 'send');

    send.mockRejectedValueOnce(
      new NoSuchKey({ message: 'missing', $metadata: { httpStatusCode: 404 } }),
    );
    expect(await files.read('k', 10)).toBeNull();

    const labelled = { 'client-id': 'c1', 'created-by-id': 'p1', 'file-name': 'a.xlsx' };
    send.mockResolvedValueOnce({
      Body: body(new Uint8Array(20)),
      ContentLength: 20,
      Metadata: labelled,
    } as never);
    expect(await files.read('k', 10)).toBeNull();

    // A length header can lie; the bytes are checked too.
    send.mockResolvedValueOnce({ Body: body(new Uint8Array(20)), Metadata: labelled } as never);
    expect(await files.read('k', 10)).toBeNull();

    send.mockResolvedValueOnce({ Body: body(new Uint8Array(1)), Metadata: {} } as never);
    expect(await files.read('k', 10)).toBeNull();

    send.mockResolvedValueOnce({
      Body: body(new Uint8Array(1)),
      Metadata: { ...labelled, 'file-name': '%E0%A4%A' },
    } as never);
    expect(await files.read('k', 10)).toBeNull();

    send.mockRejectedValueOnce(new Error('network down'));
    await expect(files.read('k', 10)).rejects.toThrow('network down');
  });

  it('is configured from the environment when storage settings are present', () => {
    expect(s3ImportFilesFromEnv({})).toBeNull();
    const env = { S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' };
    expect(s3ImportFilesFromEnv(env)).not.toBeNull();
    expect(s3ImportFilesFromEnv({ ...env, S3_ENDPOINT: 'http://localhost:9000' })).not.toBeNull();
  });
});

describe('MemoryImportFiles', () => {
  it('stores only uploads that have a ticket and honours the size limit', async () => {
    const files = new MemoryImportFiles();
    expect(() => files.put('k', new Uint8Array(1))).toThrow();
    await files.presignPut({ key: 'k', sizeBytes: 2, meta, expiresInSeconds: 300 });
    files.put('k', new Uint8Array(2));
    expect(await files.read('k', 1)).toBeNull();
    expect((await files.read('k', 2))?.meta).toEqual(meta);
  });
});
