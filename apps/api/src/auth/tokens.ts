import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A fresh random token (256 bits, base64url) for session cookies, CSRF, magic links and invites. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The stored form of a token: its SHA-256, lower-case hex (M3's `TokenHash`). Tokens are never stored or logged. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string comparison. */
export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A URL safe to log: invite tokens in the path and `token` query values are replaced. */
export function redactUrl(url: string): string {
  return url
    .replace(/\/invites\/[^/?#]+/g, '/invites/[redacted]')
    .replace(/([?&]token=)[^&#]*/g, '$1[redacted]');
}
