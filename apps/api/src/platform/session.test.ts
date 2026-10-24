import { describe, expect, it } from 'vitest';
import { idleExpiry, isOpen, sessionExpiry } from './session.js';

const signedIn = new Date('2026-10-24T03:30:00.000Z');

describe('operator sessions', () => {
  it('last 8 hours from sign-in', () => {
    expect(sessionExpiry(signedIn)).toBe('2026-10-24T11:30:00.000Z');
  });

  it('end after 30 minutes idle', () => {
    const session = { lastSeenAt: '2026-10-24T04:00:00.000Z', expiresAt: sessionExpiry(signedIn) };
    expect(idleExpiry(session)).toBe('2026-10-24T04:30:00.000Z');
    expect(isOpen(session, new Date('2026-10-24T04:29:59.999Z'))).toBe(true);
    expect(isOpen(session, new Date('2026-10-24T04:30:00.000Z'))).toBe(false);
  });

  it('never outlive their expiry, however recently used', () => {
    const session = { lastSeenAt: '2026-10-24T11:20:00.000Z', expiresAt: sessionExpiry(signedIn) };
    expect(idleExpiry(session)).toBe('2026-10-24T11:30:00.000Z');
    expect(isOpen(session, new Date('2026-10-24T11:29:00.000Z'))).toBe(true);
    expect(isOpen(session, new Date('2026-10-24T11:30:00.000Z'))).toBe(false);
  });
});
