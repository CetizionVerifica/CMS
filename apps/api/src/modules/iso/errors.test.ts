import {
  EVIDENCE_EXTENSIONS,
  ArchiveBody as ReasonBody,
  IsoFileUploadUrlBody,
} from '@canopy/contracts';
import { ZodError, z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../auth/index.js';
import {
  checkVersion,
  forbidden,
  invalid,
  invalidTransition,
  notFound,
  parseInput,
  stepTo,
} from './errors.js';

function caught(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('Expected an ApiError');
}

const SUBJECT = { type: 'clause_assessment', id: '0190f000-0000-7000-8000-0000000000a1' };

describe('error answers (iso-mock.md "Shared rules")', () => {
  it('builds each answer with its details', () => {
    expect(caught(() => invalid('code', 'Bad'))).toMatchObject({
      code: 'VALIDATION',
      details: { issues: [{ path: ['code'], message: 'Bad' }] },
    });
    expect(caught(() => invalidTransition('external_audit', 'CLOSED', 'UPDATE'))).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { entity: 'external_audit', from: 'CLOSED', action: 'UPDATE' },
    });
    expect(caught(() => forbidden('isoSystem.write'))).toMatchObject({
      code: 'FORBIDDEN',
      details: { action: 'isoSystem.write' },
    });
    expect(caught(() => notFound()).code).toBe('NOT_FOUND');
    expect(caught(() => checkVersion({ version: 3 }, 2))).toMatchObject({
      code: 'STALE_VERSION',
      details: { currentVersion: 3 },
    });
    expect(() => checkVersion({ version: 3 }, 3)).not.toThrow();
  });

  it('turns the engine’s answer into the next state or its refusal', () => {
    expect(stepTo({ ok: true, to: 'HELD' }, 'external_audit', 'PLANNED', 'RECORD_HELD')).toBe(
      'HELD',
    );
    expect(
      caught(() =>
        stepTo(
          { ok: false, error: 'INVALID_TRANSITION' } as never,
          'external_audit',
          'CLOSED',
          'CANCEL',
        ),
      ),
    ).toMatchObject({ code: 'INVALID_TRANSITION', details: { from: 'CLOSED', action: 'CANCEL' } });
    const guard = (g: string, fields: string[]) =>
      ({ ok: false, error: 'GUARD', guard: g, fields }) as never;
    expect(
      caught(() => stepTo(guard('REASON', ['reason']), 'external_audit', 'PLANNED', 'CANCEL')).code,
    ).toBe('REASON_REQUIRED');
    expect(
      caught(() => stepTo(guard('ENDED', ['endOn']), 'external_audit', 'PLANNED', 'RECORD_HELD'))
        .details,
    ).toEqual({ issues: [{ path: ['endOn'], message: 'The visit has not ended yet' }] });
    expect(
      caught(() =>
        stepTo(guard('SOMETHING_NEW', ['x']), 'external_audit', 'PLANNED', 'RECORD_HELD'),
      ).details,
    ).toEqual({ issues: [{ path: ['x'], message: 'This step is not possible yet' }] });
  });

  it('parses input, giving files and reasons their own codes', () => {
    const ok = parseInput(IsoFileUploadUrlBody, {
      subject: SUBJECT,
      fileName: 'record.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
    });
    expect(ok.fileName).toBe('record.pdf');
    expect(
      caught(() =>
        parseInput(IsoFileUploadUrlBody, {
          subject: SUBJECT,
          fileName: 'record.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10 ** 12,
        }),
      ),
    ).toMatchObject({ code: 'FILE_TOO_LARGE', details: { maxBytes: expect.any(Number) } });
    expect(
      caught(() =>
        parseInput(IsoFileUploadUrlBody, {
          subject: SUBJECT,
          fileName: 'run.exe',
          mimeType: 'application/pdf',
          sizeBytes: 10,
        }),
      ),
    ).toMatchObject({ code: 'UNSUPPORTED_FILE', details: { allowed: [...EVIDENCE_EXTENSIONS] } });
    expect(caught(() => parseInput(ReasonBody, { version: 1 })).code).toBe('REASON_REQUIRED');
    expect(caught(() => parseInput(ReasonBody, { version: 1, reason: '' })).code).toBe(
      'REASON_REQUIRED',
    );
    expect(() => parseInput(ReasonBody, { version: 'x', reason: 'Fine' })).toThrow(ZodError);
    // An absent body or query is parsed as empty.
    expect(parseInput(z.strictObject({ a: z.string().optional() }), undefined)).toEqual({});
  });
});
