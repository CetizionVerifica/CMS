import { describe, expect, it } from 'vitest';

import { parseSetCookie } from './set-cookie';

describe('parseSetCookie', () => {
  it('reads name, value and attributes', () => {
    expect(
      parseSetCookie('pp_session=a%2Eb; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60'),
    ).toEqual({
      name: 'pp_session',
      value: 'a.b',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 60,
    });
  });

  it('defaults Secure as asked and ignores unknown SameSite values', () => {
    expect(parseSetCookie('a=b; SameSite=weird', true)).toEqual({
      name: 'a',
      value: 'b',
      secure: true,
    });
    expect(parseSetCookie('a=b; SameSite=Strict; Domain=x')).toMatchObject({
      sameSite: 'strict',
      secure: false,
    });
  });

  it('skips malformed headers', () => {
    expect(parseSetCookie('')).toBeUndefined();
    expect(parseSetCookie('=b')).toBeUndefined();
    expect(parseSetCookie('novalue')).toBeUndefined();
  });
});
