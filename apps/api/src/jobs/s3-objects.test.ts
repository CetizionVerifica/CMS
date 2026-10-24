import { Readable } from 'node:stream';
import { GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
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

  it('throws on any other failure, so the scan is tried again', async () => {
    const unreachable = fakeClient(() => {
      throw new Error('connect ECONNREFUSED');
    });
    await expect(s3EvidenceObjects(SETTINGS, unreachable).open('k')).rejects.toThrow(
      'ECONNREFUSED',
    );
    const empty = fakeClient(() => ({}));
    await expect(s3EvidenceObjects(SETTINGS, empty).open('k')).rejects.toThrow('no stream');
  });

  it('builds its own client for an S3-compatible endpoint', () => {
    expect(() =>
      s3EvidenceObjects({ ...SETTINGS, endpoint: 'http://localhost:8333' }),
    ).not.toThrow();
  });
});
