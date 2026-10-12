import { describe, expect, it } from 'vitest';
import {
  baseMimeType,
  extensionOf,
  isAllowedType,
  requireAllowedType,
  storageKey,
} from './files.js';
import { attachment } from './storage.js';

describe('evidence file types (api-conventions.md §6)', () => {
  it('accepts each listed extension with its MIME type, in any case and with parameters', () => {
    expect(isAllowedType('Challan.PDF', 'application/pdf')).toBe(true);
    expect(isAllowedType('scan.jpeg', 'image/jpeg')).toBe(true);
    expect(isAllowedType('photo.heic', 'image/heif')).toBe(true);
    expect(isAllowedType('register.csv', 'text/csv; charset=utf-8')).toBe(true);
    expect(isAllowedType('bundle.zip', 'application/x-zip-compressed')).toBe(true);
  });

  it('refuses other extensions, a mismatched type and a name without an extension', () => {
    expect(isAllowedType('tool.exe', 'application/x-msdownload')).toBe(false);
    expect(isAllowedType('report.pdf', 'text/html')).toBe(false);
    expect(isAllowedType('README', 'text/plain')).toBe(false);
    expect(() => requireAllowedType('page.html', 'text/html')).toThrow(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
    expect(() => requireAllowedType('ok.txt', 'text/plain')).not.toThrow();
  });

  it('reads extensions and base MIME types', () => {
    expect(extensionOf('a.b.XLSX')).toBe('xlsx');
    expect(extensionOf('noext')).toBe('');
    expect(baseMimeType(' Text/Plain ; charset=UTF-8')).toBe('text/plain');
  });

  it('keys each upload under its firm, client and instance', () => {
    expect(storageKey({ firmId: 'f', clientId: 'c', instanceId: 'i', uploadId: 'u' })).toBe(
      'evidence/f/c/i/u',
    );
  });

  it('builds a Content-Disposition that cannot break the header', () => {
    expect(attachment('Form 21 "final".pdf')).toBe(
      `attachment; filename="Form 21 _final_.pdf"; filename*=UTF-8''Form%2021%20%22final%22.pdf`,
    );
    expect(attachment('रजिस्टर.pdf')).toMatch(
      /^attachment; filename="_+\.pdf"; filename\*=UTF-8''/,
    );
  });
});
