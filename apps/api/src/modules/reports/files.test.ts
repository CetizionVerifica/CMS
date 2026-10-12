import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localTime, pdfSafe } from './certificate-pdf.js';
import { MemoryExportFiles, S3ExportFiles } from './files.js';
import { slug } from './service.js';

const NOW = new Date('2026-10-12T06:00:00Z');
const options = {
  bucket: 'exports',
  region: 'ap-south-1',
  endpoint: 'http://localhost:9000',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
};

afterEach(() => vi.restoreAllMocks());

describe('S3ExportFiles', () => {
  it('presigns a 5-minute download with the file name', async () => {
    const files = new S3ExportFiles(options);
    const signed = await files.signedUrl('exports/a/b/c/report.xlsx', 'report "x".xlsx', NOW);
    const url = new URL(signed.url);
    expect(url.pathname).toBe('/exports/exports/a/b/c/report.xlsx');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="report x.xlsx"',
    );
    expect(signed.expiresAt).toBe('2026-10-12T06:05:00.000Z');
  });

  it('puts the file with its content type', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const files = new S3ExportFiles({ ...options, endpoint: undefined });
    await files.put('k', new Uint8Array([1]), 'application/pdf');
    const command = send.mock.calls[0]![0] as PutObjectCommand;
    expect(command.input).toMatchObject({
      Bucket: 'exports',
      Key: 'k',
      ContentType: 'application/pdf',
    });
  });
});

describe('MemoryExportFiles', () => {
  it('keeps files and returns an unusable placeholder link', async () => {
    const files = new MemoryExportFiles();
    await files.put('a b', new Uint8Array([1]), 'text/plain');
    expect(files.files.get('a b')?.contentType).toBe('text/plain');
    expect((await files.signedUrl('a b', 'x', NOW)).url).toBe('https://files.invalid/a%20b');
  });
});

describe('text helpers', () => {
  it('keeps WinAnsi text and replaces what the standard fonts cannot draw', () => {
    expect(pdfSafe('Café · Belur')).toBe('Café · Belur');
    expect(pdfSafe('कारखाना\tline\nnext')).toBe('??????? line next');
  });

  it('prints an instant as wall-clock time in the client time zone', () => {
    expect(localTime('2026-10-12T18:45:00.000Z', 'Asia/Kolkata')).toBe(
      '2026-10-13 00:15 Asia/Kolkata',
    );
    expect(localTime('2026-10-12T00:30:00.000Z', 'America/New_York')).toBe(
      '2026-10-11 20:30 America/New_York',
    );
  });

  it('makes file-name slugs without personal or unsafe characters', () => {
    expect(slug('Head Office / Unit 2')).toBe('head-office-unit-2');
    expect(slug('कारखाना')).toBe('unit');
  });
});
