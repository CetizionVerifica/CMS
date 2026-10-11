import { describe, expect, it } from 'vitest';

import { AcceptInviteRequest, LoginRequest, MfaVerifyRequest } from './types';

describe('request schemas', () => {
  it('validates login input', () => {
    expect(LoginRequest.safeParse({ email: 'a@b.test', password: 'x' }).success).toBe(true);
    const bad = LoginRequest.safeParse({ email: 'nope', password: '' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.message)).toEqual([
      'Enter a valid email address',
      'Enter your password',
    ]);
  });

  it('needs a 6-digit MFA code', () => {
    expect(MfaVerifyRequest.safeParse({ code: '123456' }).success).toBe(true);
    expect(MfaVerifyRequest.safeParse({ code: '12345a' }).success).toBe(false);
  });

  it('needs matching passwords of 12+ characters on invite', () => {
    const base = { email: 'a@b.test', password: 'long-enough-pw', confirm: 'long-enough-pw' };
    expect(AcceptInviteRequest.safeParse(base).success).toBe(true);
    expect(
      AcceptInviteRequest.safeParse({ ...base, confirm: 'other' }).error?.issues[0]?.path,
    ).toEqual(['confirm']);
    expect(
      AcceptInviteRequest.safeParse({ ...base, password: 'short', confirm: 'short' }).success,
    ).toBe(false);
  });
});
