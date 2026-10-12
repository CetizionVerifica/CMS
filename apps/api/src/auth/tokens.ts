import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A fresh random token (256 bits, base64url) for session cookies, CSRF, magic links and invites. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The stored form of a token: its SHA-256. Tokens themselves are never stored or logged. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** Constant-time string comparison. */
export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
