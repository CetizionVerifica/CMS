import { ErrorCode } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError, errorEnvelope } from './errors.js';

describe('ApiError', () => {
  it('uses the default message for a known code', () => {
    const error = new ApiError('NOT_FOUND');
    expect(error.message).toBe('Not found.');
    expect(error.statusCode).toBe(404);
  });

  it('has a message of its own for every contract code', () => {
    for (const code of ErrorCode.options) {
      expect(new ApiError(code).message, code).not.toBe(
        code === 'INTERNAL' ? '' : 'Something went wrong.',
      );
    }
  });

  it('has the account messages people see when paused or at a plan limit', () => {
    expect(new ApiError('ACCOUNT_SUSPENDED').message).toBe(
      'Your account is paused. Contact PlanetPulse.',
    );
    expect(new ApiError('PLAN_LIMIT_REACHED').message).toBe(
      'Your plan limit is reached. Contact PlanetPulse to upgrade.',
    );
  });

  it('says when an add-on is not turned on for the account', () => {
    // FEATURE_NOT_ENABLED arrives with contracts 1.7.0; until then it is not an ErrorCode here.
    expect(new ApiError('FEATURE_NOT_ENABLED' as ErrorCode).message).toBe(
      "This feature isn't turned on for your account. Contact PlanetPulse to add it.",
    );
  });

  it('falls back to a generic message for a code added to the contract later', () => {
    // A newer @canopy/contracts can add a code (and its HTTP status) before this map gives it a message.
    const code = 'NEW_CODE' as ErrorCode;
    const error = new ApiError(code);
    expect(error.message).toBe('Something went wrong.');
    expect(errorEnvelope(error, 'req-1').error.message).toBe('Something went wrong.');
  });
});
