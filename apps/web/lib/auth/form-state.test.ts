import { LoginBody } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { fieldErrors } from './form-state';

describe('fieldErrors', () => {
  it('keeps the first message per field, replacing the ones given', () => {
    const result = LoginBody.safeParse({ email: 1, password: '' });
    expect(result.success).toBe(false);
    expect(fieldErrors(result.error!, { password: 'Enter your password' })).toEqual({
      email: expect.any(String),
      password: 'Enter your password',
    });
  });
});
