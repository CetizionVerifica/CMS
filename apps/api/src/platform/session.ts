/**
 * Operator session rules (ADR M15-0001 decision 9). Pure, so the timing is unit tested with explicit instants; the
 * database store keeps the rows.
 */

/** The operator's cookie. Never the customer `sid`, and sent only to the operator API. */
export const OPERATOR_COOKIE = 'op_sid';
export const OPERATOR_COOKIE_PATH = '/api/platform';
export const OPERATOR_PREFIX = '/api/platform/v1';
export const CSRF_HEADER = 'x-csrf-token';

export const SESSION_HOURS = 8;
export const IDLE_MINUTES = 30;

/** What sign-in may try per client IP per minute, on top of the API-wide limit. */
export const LOGIN_LIMIT = { max: 5, timeWindow: '1 minute' } as const;

export interface SessionTimes {
  lastSeenAt: string;
  expiresAt: string;
}

/** When a new session ends at the latest. */
export function sessionExpiry(now: Date): string {
  return new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString();
}

/** When the session ends if nothing happens: 30 minutes after it was last used, never after its expiry. */
export function idleExpiry(session: SessionTimes): string {
  const idle = Date.parse(session.lastSeenAt) + IDLE_MINUTES * 60_000;
  return new Date(Math.min(idle, Date.parse(session.expiresAt))).toISOString();
}

/** False once the session is past its expiry or has been idle for 30 minutes. */
export function isOpen(session: SessionTimes, now: Date): boolean {
  return now.getTime() < Date.parse(idleExpiry(session));
}
