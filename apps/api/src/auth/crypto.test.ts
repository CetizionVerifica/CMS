import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';
import { SecretBox } from './secretbox.js';
import {
  base32Decode,
  base32Encode,
  hotp,
  newTotpSecret,
  otpauthUri,
  totpStep,
  verifyTotp,
} from './totp.js';

describe('passwords', () => {
  it('hashes with a fresh salt and verifies', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterz', a)).toBe(false);
  });

  it('never matches malformed or out-of-range stored values', async () => {
    expect(await verifyPassword('x', 'plain')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1073741824$8$1$abc$def')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$16384$8$1$abc$short')).toBe(false);
    expect(await verifyAgainstDummy('anything at all')).toBe(false);
  });
});

describe('totp', () => {
  // RFC 6238 appendix B (SHA-1), last 6 digits.
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the RFC vector at T=%i', (seconds, code) => {
    expect(hotp(base32Decode(rfcSecret), totpStep(new Date(seconds * 1000)))).toBe(code);
    expect(verifyTotp(rfcSecret, code, new Date(seconds * 1000))).toBe(Math.floor(seconds / 30));
  });

  it('accepts one step of drift either side and nothing further', () => {
    const now = new Date(1234567890 * 1000);
    const step = totpStep(now);
    const key = base32Decode(rfcSecret);
    expect(verifyTotp(rfcSecret, hotp(key, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(rfcSecret, hotp(key, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(rfcSecret, hotp(key, step + 2), now)).toBeNull();
    expect(verifyTotp(rfcSecret, '12345', now)).toBeNull();
  });

  it('round-trips base32 and rejects other characters', () => {
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(base32Encode(Buffer.from('a'))).toBe('ME');
    expect(base32Decode('me======').toString()).toBe('a');
    expect(() => base32Decode('1')).toThrow(RangeError);
  });

  it('builds an otpauth URI with the product name as issuer', () => {
    const uri = otpauthUri('ABC', 'a@example.com');
    expect(uri).toMatch(/^otpauth:\/\/totp\/PlanetPulse%20Compliance%3Aa%40example\.com\?/);
    expect(uri).toContain('issuer=PlanetPulse+Compliance');
    expect(uri).not.toMatch(/canopy/i);
  });
});

describe('SecretBox', () => {
  const key = Buffer.alloc(32, 7).toString('base64');

  it('seals and opens, and refuses tampering or a wrong key', () => {
    const box = new SecretBox(key);
    const sealed = box.seal('JBSWY3DPEHPK3PXP');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.open(sealed)).toBe('JBSWY3DPEHPK3PXP');
    const parts = sealed.split('.');
    const flipped = [...parts.slice(0, 3), parts[3]!.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))];
    expect(() => box.open(flipped.join('.'))).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 8).toString('base64')).open(sealed)).toThrow();
    expect(() => box.open('v2.a.b.c')).toThrow(/Not a sealed secret/);
  });

  it('needs a 32-byte key', () => {
    expect(() => new SecretBox(Buffer.alloc(16).toString('base64'))).toThrow(RangeError);
  });
});
