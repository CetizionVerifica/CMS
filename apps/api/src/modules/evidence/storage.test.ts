import { describe, expect, it } from 'vitest';
import { createS3Storage, SIGNED_URL_SECONDS } from './storage.js';

/** Signing needs no network, so the URLs can be checked offline. */
const storage = createS3Storage({
  endpoint: 'http://localhost:9000',
  region: 'ap-south-1',
  bucket: 'canopy-evidence',
  accessKeyId: 'test',
  secretAccessKey: 'test-secret',
});

describe('S3 evidence storage', () => {
  it('signs a 5-minute PUT that binds the content type and length', async () => {
    const put = await storage.presignPut('evidence/f/c/i/u', {
      mimeType: 'application/pdf',
      sizeBytes: 4096,
    });
    const url = new URL(put.url);
    expect(url.pathname).toBe('/canopy-evidence/evidence/f/c/i/u');
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(SIGNED_URL_SECONDS));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(put.headers).toEqual({ 'Content-Type': 'application/pdf', 'Content-Length': '4096' });
    // No checksum of an empty body is signed in, which S3 would hold the uploaded file to.
    expect([...url.searchParams.keys()].filter((k) => /checksum/i.test(k))).toEqual([]);
  });

  it('signs a 5-minute GET that downloads under the original file name', async () => {
    const url = new URL(await storage.presignGet('evidence/f/c/i/u', 'Form 21.pdf'));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="Form 21.pdf"; filename*=UTF-8''Form%2021.pdf`,
    );
  });
});
