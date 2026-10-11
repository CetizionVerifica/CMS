import { describe, expect, it } from 'vitest';

import { LoginRequest } from '../api/types';
import { fieldErrors } from './form-state';

describe('fieldErrors', () => {
  it('keeps the first message per field', () => {
    const result = LoginRequest.safeParse({ email: 1, password: '' });
    expect(result.success).toBe(false);
    expect(fieldErrors(result.error!)).toEqual({
      email: expect.any(String),
      password: 'Enter your password',
    });
  });
});
