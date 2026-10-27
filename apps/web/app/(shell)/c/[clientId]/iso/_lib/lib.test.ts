import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../../../lib/api/client';
import { failureMessage } from './outcome';
import {
  clientDate,
  clientTime,
  clientToday,
  first,
  hrefWith,
  instantAt,
  listParam,
  nameOf,
  namesOf,
} from './people';
import { BEING_SET_UP, refusalFor } from './refusal';
import { sha256Hex, storageHasNoHost, uploadIsoFile, type IsoUploadCalls } from './upload';

const err = (code: ConstructorParameters<typeof ApiError>[1]) => new ApiError(400, code, 'x');

describe('refusalFor', () => {
  it('words the refusals a page shows, and nothing else', () => {
    expect(refusalFor(err('FEATURE_NOT_READY'))).toBe('notReady');
    expect(refusalFor(err('FEATURE_NOT_ENABLED'))).toBe('notEnabled');
    expect(refusalFor(err('FORBIDDEN'))).toBe('noPermission');
    expect(refusalFor(err('ACCESS_EXPIRED'))).toBe('noPermission');
    expect(refusalFor(err('NOT_FOUND'))).toBe('notFound');
    expect(refusalFor(err('VALIDATION'))).toBeUndefined();
    expect(refusalFor(new Error('boom'))).toBeUndefined();
  });
});

describe('failureMessage', () => {
  it('says what happened for each code, keyed by code', () => {
    expect(failureMessage('STALE_VERSION')).toMatch(/Someone else changed this/);
    expect(failureMessage('INVALID_TRANSITION')).toMatch(/moved on/);
    expect(failureMessage('REASON_REQUIRED')).toBe('Give a reason for this change.');
    expect(failureMessage('DUPLICATE')).toMatch(/already in use/);
    expect(failureMessage('NOT_FOUND')).toMatch(/removed/);
    expect(failureMessage('FORBIDDEN')).toMatch(/can’t do this/);
    expect(failureMessage('ACCESS_EXPIRED')).toMatch(/can’t do this/);
    expect(failureMessage('FEATURE_NOT_READY')).toBe(BEING_SET_UP);
    expect(failureMessage('FEATURE_NOT_ENABLED')).toMatch(/not turned on/);
    expect(failureMessage('VALIDATION', 'code is taken')).toBe(
      'This can’t be saved yet: code is taken',
    );
    expect(failureMessage('VALIDATION')).toBe('Check the form and try again.');
    expect(failureMessage('UNKNOWN')).toMatch(/Something went wrong/);
  });
});

describe('people and URL helpers', () => {
  const people = [
    { id: 'a', name: 'Nisha Patil' },
    { id: 'b', name: 'Rohan Joshi' },
  ];
  it('names people, never by id', () => {
    expect(nameOf(people, 'a')).toBe('Nisha Patil');
    expect(nameOf(people, 'zz')).toBe('Someone');
    expect(nameOf(people, null)).toBe('Nobody yet');
    expect(namesOf(people, ['a', 'b'])).toBe('Nisha Patil, Rohan Joshi');
    expect(namesOf(people, [])).toBe('None');
  });
  it("gives today's date where the client is", () => {
    const late = new Date('2024-11-15T20:00:00Z');
    expect(clientToday('Asia/Kolkata', late)).toBe('2024-11-16');
    expect(clientToday('UTC', late)).toBe('2024-11-15');
    expect(clientDate('2026-10-26T20:00:00Z', 'Asia/Kolkata')).toBe('2026-10-27');
    expect(clientDate('2026-10-26T20:00:00Z', 'UTC')).toBe('2026-10-26');
    expect(clientTime('2026-10-26T20:00:00Z', 'Asia/Kolkata')).toBe('01:30');
    // A client-local date and time back to the instant, across a daylight-saving change too.
    expect(instantAt('2026-10-27', '01:30', 'Asia/Kolkata')).toBe('2026-10-26T20:00:00Z');
    expect(instantAt('2024-11-14', '09:05', 'UTC')).toBe('2024-11-14T09:05:00Z');
    expect(instantAt('2026-03-29', '12:00', 'Europe/London')).toBe('2026-03-29T11:00:00Z');
    expect(instantAt('2026-03-28', '12:00', 'Europe/London')).toBe('2026-03-28T12:00:00Z');
    expect(instantAt('2026-10-27', '25:00', 'UTC')).toBeNull();
    expect(instantAt('27 Oct', '10:00', 'UTC')).toBeNull();
  });
  it('builds hrefs and reads search params', () => {
    expect(hrefWith('/x', { a: '1', b: undefined, c: '' })).toBe('/x?a=1');
    expect(hrefWith('/x', {})).toBe('/x');
    expect(first(['a', 'b'])).toBe('a');
    expect(first('a')).toBe('a');
    expect(first(undefined)).toBeUndefined();
    expect(listParam('A,B,,C', ['A', 'C'])).toEqual(['A', 'C']);
    expect(listParam('A,B')).toEqual(['A', 'B']);
    expect(listParam(undefined)).toEqual([]);
  });
});

describe('uploadIsoFile', () => {
  const subject = {
    type: 'clause_assessment' as const,
    id: '00000000-0000-5000-8000-000000000001',
  };
  const file = new File(['hello'], 'proof.pdf', { type: 'application/pdf' });
  const ticket = (url: string) => ({
    ok: true as const,
    data: { uploadId: 'u1', url, headers: { 'x-a': '1' }, expiresAt: '2024-11-15T00:05:00Z' },
  });
  const confirmed = { ok: true as const, data: { id: 'f1' } };

  it('hashes the bytes the way the confirm step checks them', async () => {
    expect(await sha256Hex(new TextEncoder().encode('hello').buffer as ArrayBuffer)).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('skips the PUT for storage with no host, and confirms with the hash', async () => {
    expect(storageHasNoHost('https://storage.invalid/x')).toBe(true);
    const calls = {
      ticket: vi.fn(async () => ticket('https://storage.invalid/put')),
      confirm: vi.fn(async () => confirmed),
    } as unknown as IsoUploadCalls;
    const put = vi.fn();
    expect(await uploadIsoFile(file, subject, calls, put)).toBe(confirmed);
    expect(put).not.toHaveBeenCalled();
    expect(calls.ticket).toHaveBeenCalledWith({
      subject,
      fileName: 'proof.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 5,
    });
    expect(calls.confirm).toHaveBeenCalledWith({
      subject,
      uploadId: 'u1',
      fileName: 'proof.pdf',
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
  });

  it('PUTs to real storage, and stops when the ticket or the PUT fails', async () => {
    const calls = {
      ticket: vi.fn(async () => ticket('https://storage.example.com/put')),
      confirm: vi.fn(async () => confirmed),
    } as unknown as IsoUploadCalls;
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    await uploadIsoFile(new File(['x'], 'a'), subject, calls, put);
    expect(put).toHaveBeenCalledWith(
      'https://storage.example.com/put',
      { 'x-a': '1' },
      expect.any(File),
    );
    expect(vi.mocked(calls.ticket).mock.calls[0]![0]).toMatchObject({
      mimeType: 'application/octet-stream',
    });

    const failing = vi.fn(async () => new Response(null, { status: 500 }));
    expect(await uploadIsoFile(file, subject, calls, failing)).toEqual({
      ok: false,
      code: 'UNKNOWN',
      message: 'The file didn’t upload. Try again.',
    });
    const thrown = vi.fn(async () => {
      throw new Error('offline');
    });
    expect((await uploadIsoFile(file, subject, calls, thrown)).ok).toBe(false);

    const refused = { ok: false as const, code: 'FORBIDDEN' as const, message: 'no' };
    const noTicket = { ...calls, ticket: vi.fn(async () => refused) } as unknown as IsoUploadCalls;
    expect(await uploadIsoFile(file, subject, noTicket, put)).toBe(refused);
  });
});
