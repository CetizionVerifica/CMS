import { createHmac, randomBytes } from 'node:crypto';

/**
 * TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30-second steps) for MFA. Built on node:crypto; no dependency.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new RangeError('Not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 encoded. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The time step a moment falls in. */
export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / STEP_SECONDS);
}

/** The code for a time step (RFC 4226 HOTP with the step as counter). */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Checks a code against the current step and one step either side (clock drift). Returns the matched step,
 * or null. Callers reject a step at or before the last one used, so a code cannot be replayed.
 */
export function verifyTotp(secret: string, code: string, now: Date): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const current = totpStep(now);
  for (const step of [current - 1, current, current + 1]) {
    if (hotp(key, step) === code) return step;
  }
  return null;
}

/** The `otpauth://` URI an authenticator app scans. The issuer is the client-facing product name. */
export function otpauthUri(secret: string, account: string): string {
  const issuer = 'PlanetPulse Compliance';
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
