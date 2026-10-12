import type { ErrorCode } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError, errorEnvelope } from './errors.js';

describe('ApiError', () => {
  it('uses the default message for a known code', () => {
    const error = new ApiError('NOT_FOUND');
    expect(error.message).toBe('Not found.');
    expect(error.statusCode).toBe(404);
  });

  it('falls back to a generic message for a code added to the contract later', () => {
    // A newer @canopy/contracts can add a code (and its HTTP status) before this map gives it a message.
    const code = 'NEW_CODE' as ErrorCode;
    const error = new ApiError(code);
    expect(error.message).toBe('Something went wrong.');
    expect(errorEnvelope(error, 'req-1').error.message).toBe('Something went wrong.');
  });
});
