import { describe, expect, it } from 'vitest';
import { ipAllowlistFromEnv } from './allowlist.js';

describe('PLATFORM_IP_ALLOWLIST', () => {
  it('lets everyone through when unset or empty', () => {
    expect(ipAllowlistFromEnv(undefined)).toBeNull();
    expect(ipAllowlistFromEnv('  ')).toBeNull();
  });

  it('matches single addresses and CIDRs, IPv4 and IPv6', () => {
    const allowed = ipAllowlistFromEnv('203.0.113.7, 10.20.0.0/16, 2001:db8::/32')!;
    expect(allowed('203.0.113.7')).toBe(true);
    expect(allowed('203.0.113.8')).toBe(false);
    expect(allowed('10.20.255.1')).toBe(true);
    expect(allowed('10.21.0.1')).toBe(false);
    expect(allowed('2001:db8:1::5')).toBe(true);
    expect(allowed('2001:db9::5')).toBe(false);
  });

  it('matches an IPv4 client seen through an IPv6 socket as IPv4', () => {
    const allowed = ipAllowlistFromEnv('10.20.0.0/16')!;
    expect(allowed('::ffff:10.20.3.4')).toBe(true);
    expect(allowed('::ffff:10.21.3.4')).toBe(false);
  });

  it('refuses what is not an address', () => {
    expect(ipAllowlistFromEnv('10.0.0.1')!('not an address')).toBe(false);
  });

  it.each(['10.0.0.0/33', 'office', '10.0.0.0/8/1', '2001:db8::/129', '10.0.0.0/x', ''])(
    'fails the boot on %j',
    (entry) => {
      expect(() => ipAllowlistFromEnv(`10.0.0.1,${entry}`)).toThrow('PLATFORM_IP_ALLOWLIST');
    },
  );
});
