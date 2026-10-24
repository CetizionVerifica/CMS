import { describe, expect, it } from 'vitest';

import { connectOrigins, contentSecurityPolicy, newNonce } from './csp';

const directive = (policy: string, name: string) =>
  policy
    .split('; ')
    .find((d) => d.startsWith(`${name} `))
    ?.slice(name.length + 1);

describe('content security policy', () => {
  it('lets only scripts carrying the nonce run, and nothing frame the app', () => {
    const policy = contentSecurityPolicy({ nonce: 'abc123' });
    expect(directive(policy, 'script-src')).toBe("'self' 'nonce-abc123' 'strict-dynamic'");
    expect(directive(policy, 'default-src')).toBe("'self'");
    expect(directive(policy, 'object-src')).toBe("'none'");
    expect(directive(policy, 'frame-ancestors')).toBe("'none'");
    expect(directive(policy, 'form-action')).toBe("'self'");
    expect(directive(policy, 'connect-src')).toBe("'self'");
    expect(policy).not.toContain('unsafe-eval');
  });

  it('allows eval only under next dev', () => {
    expect(directive(contentSecurityPolicy({ nonce: 'n', dev: true }), 'script-src')).toContain(
      "'unsafe-eval'",
    );
  });

  it('adds the storage origin uploads go to', () => {
    const policy = contentSecurityPolicy({
      nonce: 'n',
      connectSrc: ' https://files.example.test  https://other.example.test ',
    });
    expect(directive(policy, 'connect-src')).toBe(
      "'self' https://files.example.test https://other.example.test",
    );
  });

  it('keeps only bare https origins, so a bad value can neither allow http nor add a directive', () => {
    const value =
      'https://files.example.test/ http://files.example.test https://x.test; script-src * ' +
      'https://a.test/path https://user:pw@b.test https://c.test:8443 * javascript:alert(1)';
    expect(connectOrigins(value)).toEqual({
      origins: ['https://files.example.test/', 'https://c.test:8443'],
      rejected: [
        'http://files.example.test',
        'https://x.test;',
        'script-src',
        '*',
        'https://a.test/path',
        'https://user:pw@b.test',
        '*',
        'javascript:alert(1)',
      ],
    });
    const policy = contentSecurityPolicy({ nonce: 'n', connectSrc: value });
    expect(directive(policy, 'connect-src')).toBe(
      "'self' https://files.example.test/ https://c.test:8443",
    );
    expect(policy.match(/script-src/g)).toHaveLength(1);
  });

  it('allows http to a loopback host, as local and CI storage needs, and nowhere else', () => {
    const loopback = 'http://localhost:9000 http://127.0.0.1:9000 http://localhost';
    expect(connectOrigins(loopback)).toEqual({ origins: loopback.split(' '), rejected: [] });
    const other =
      'http://files.example.test:9000 http://127.0.0.2:9000 http://localhost.example.test ' +
      'http://10.0.0.5:9000 http://localhost:9000/path http://[::1]:9000';
    expect(connectOrigins(other)).toEqual({ origins: [], rejected: other.split(' ') });
  });

  it('allows any http storage origin under next dev only', () => {
    expect(connectOrigins('http://storage.local:8333', true).origins).toEqual([
      'http://storage.local:8333',
    ]);
    expect(connectOrigins('http://storage.local:8333').origins).toEqual([]);
    expect(connectOrigins(undefined)).toEqual({ origins: [], rejected: [] });
  });

  it('makes a different 128-bit nonce each time', () => {
    const a = newNonce();
    expect(atob(a)).toHaveLength(16);
    expect(newNonce()).not.toBe(a);
  });
});
