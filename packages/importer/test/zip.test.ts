import { describe, expect, it } from 'vitest';
import { MAX_INFLATED_BYTES, readWorkbook } from '../src/read.js';
import { declaredInflatedSize } from '../src/zip.js';
import { fixturePath } from './helpers.js';
import { readFile } from 'node:fs/promises';

/** A zip holding only a central directory that declares these uncompressed sizes (no file data). */
function centralDirectoryOnly(sizes: number[], options: { badSignature?: boolean } = {}) {
  const name = new TextEncoder().encode('x.xml');
  const headers = sizes.map((size) => {
    const header = new DataView(new ArrayBuffer(46 + name.length));
    header.setUint32(0, options.badSignature ? 0 : 0x02014b50, true);
    header.setUint32(24, size, true);
    header.setUint16(28, name.length, true);
    new Uint8Array(header.buffer).set(name, 46);
    return new Uint8Array(header.buffer);
  });
  const directory = headers.reduce((n, h) => n + h.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(10, sizes.length, true);
  end.setUint32(12, directory, true);
  end.setUint32(16, 0, true);
  const bytes = new Uint8Array(directory + 22);
  let at = 0;
  for (const h of headers) {
    bytes.set(h, at);
    at += h.length;
  }
  bytes.set(new Uint8Array(end.buffer), at);
  return bytes;
}

describe('declaredInflatedSize', () => {
  it('adds up the sizes the central directory declares', async () => {
    expect(declaredInflatedSize(centralDirectoryOnly([10, 20, 30]))).toBe(60);
    const sample = new Uint8Array(await readFile(fixturePath('sample-register-anonymised.xlsx')));
    const size = declaredInflatedSize(sample);
    expect(size).toBeGreaterThan(sample.byteLength);
    expect(size).toBeLessThan(MAX_INFLATED_BYTES);
  });

  it('treats a ZIP64 size as too large and a broken archive as unreadable', () => {
    expect(declaredInflatedSize(centralDirectoryOnly([0xffffffff]))).toBe(Infinity);
    expect(declaredInflatedSize(centralDirectoryOnly([1], { badSignature: true }))).toBeNull();
    expect(declaredInflatedSize(new Uint8Array(100))).toBeNull();
    expect(declaredInflatedSize(new Uint8Array(3))).toBeNull();
  });

  it('makes readWorkbook refuse a workbook that would expand past the limit', async () => {
    const bomb = centralDirectoryOnly([MAX_INFLATED_BYTES, 1]);
    await expect(readWorkbook(bomb, 'bomb.xlsx')).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
  });
});
