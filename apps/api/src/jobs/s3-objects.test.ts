import { Readable } from 'node:stream';
import { GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { ScanServiceError, ScanTimeoutError } from './ports.js';
import { s3EvidenceObjects, type S3Send } from './s3-objects.js';

const SETTINGS = {
  bucket: 'canopy-evidence',
  region: 'ap-south-1',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
};

function fakeClient(
  answer: (command: GetObjectCommand) => unknown,
): S3Send & { sent: GetObjectCommand[] } {
  const sent: GetObjectCommand[] = [];
  return {
    sent,
    send: (async (command: GetObjectCommand) => {
      sent.push(command);
      return answer(command);
    }) as S3Send['send'],
  };
}

describe('s3EvidenceObjects', () => {
  it('streams the object at the key from the evidence bucket', async () => {
    const client = fakeClient(() => ({
      Body: Readable.from([Buffer.from('%PDF'), Buffer.from('-1.7')]),
    }));
    const content = await s3EvidenceObjects(SETTINGS, client).open('firm/client/instance/upload');
    let text = '';
    for await (const chunk of content!) text += Buffer.from(chunk).toString();
    expect(text).toBe('%PDF-1.7');
    expect(client.sent[0]!.input).toEqual({
      Bucket: 'canopy-evidence',
      Key: 'firm/client/instance/upload',
    });
  });

  it('answers null when nothing is stored at the key', async () => {
    const client = fakeClient(() => {
      throw new NoSuchKey({ message: 'missing', $metadata: {} });
    });
    await expect(s3EvidenceObjects(SETTINGS, client).open('k')).resolves.toBeNull();
  });

  it('reports storage that cannot be reached as a service error, which stops the run', async () => {
    const unreachable = fakeClient(() => {
      throw new Error('connect ECONNREFUSED');
    });
    const failure = s3EvidenceObjects(SETTINGS, unreachable).open('k');
    await expect(failure).rejects.toBeInstanceOf(ScanServiceError);
    await expect(failure).rejects.toThrow('Object storage could not be read');
    const down = fakeClient(() => {
      throw Object.assign(new Error('down'), { $metadata: { httpStatusCode: 503 } });
    });
    await expect(s3EvidenceObjects(SETTINGS, down).open('k')).rejects.toBeInstanceOf(
      ScanServiceError,
    );
    const badKey = fakeClient(() => {
      throw Object.assign(new Error('bad key'), {
        name: 'InvalidAccessKeyId',
        $metadata: { httpStatusCode: 403 },
      });
    });
    await expect(s3EvidenceObjects(SETTINGS, badKey).open('k')).rejects.toBeInstanceOf(
      ScanServiceError,
    );
    const empty = fakeClient(() => ({}));
    const noStream = s3EvidenceObjects(SETTINGS, empty).open('k');
    await expect(noStream).rejects.toBeInstanceOf(ScanServiceError);
    await expect(noStream).rejects.toThrow('no stream');
  });

  it('counts a refusal of one object against the file, without quoting the SDK', async () => {
    const refused = fakeClient(() => {
      throw Object.assign(new Error('Access Denied for firm/client/instance/upload'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      });
    });
    const failure = s3EvidenceObjects(SETTINGS, refused).open('firm/client/instance/upload');
    await expect(failure).rejects.toThrow('Object storage refused the file');
    await expect(failure).rejects.not.toBeInstanceOf(ScanServiceError);
    await expect(failure).rejects.not.toThrow('firm/client');
  });

  it('passes the deadline to the request and reports it as a timeout once passed', async () => {
    const deadline = new AbortController();
    const seen: unknown[] = [];
    const client: S3Send = {
      send: (async (_command: GetObjectCommand, options?: { abortSignal?: AbortSignal }) => {
        seen.push(options?.abortSignal);
        deadline.abort();
        throw new Error('aborted');
      }) as S3Send['send'],
    };
    const failure = s3EvidenceObjects(SETTINGS, client).open('k', deadline.signal);
    await expect(failure).rejects.toBeInstanceOf(ScanTimeoutError);
    expect(seen).toEqual([deadline.signal]);
  });

  it('reports a body that breaks mid-transfer as a service error, or a timeout past the deadline', async () => {
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('%PDF');
      throw new Error('socket hang up on firm/client/instance/upload');
    }
    const read = async (signal?: AbortSignal) => {
      const content = await s3EvidenceObjects(
        SETTINGS,
        fakeClient(() => ({ Body: broken() })),
      ).open('k', signal);
      for await (const chunk of content!) void chunk;
    };
    await expect(read()).rejects.toBeInstanceOf(ScanServiceError);
    await expect(read()).rejects.toThrow('Object storage stopped sending the file');
    const stopped = new AbortController();
    stopped.abort();
    await expect(read(stopped.signal)).rejects.toBeInstanceOf(ScanTimeoutError);
  });

  it('builds its own client for an S3-compatible endpoint', () => {
    expect(() =>
      s3EvidenceObjects({ ...SETTINGS, endpoint: 'http://localhost:8333' }),
    ).not.toThrow();
  });
});
