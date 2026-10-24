import { ApiErrorResponse } from '@canopy/contracts';
import type { OperatorDatabase } from '@canopy/db';
import { describe, expect, it, vi } from 'vitest';
import { SecretBox } from '../auth/index.js';
import { buildServer } from '../server.js';
import { ipAllowlistFromEnv } from './allowlist.js';

const secrets = new SecretBox(Buffer.alloc(32, 9).toString('base64'));

function server(allowlist: string | undefined) {
  const db: OperatorDatabase = {
    withOperator: vi.fn().mockRejectedValue(new Error('no database in this test')),
    close: vi.fn(),
  };
  const app = buildServer({
    platform: {
      db,
      secrets,
      allowlist: ipAllowlistFromEnv(allowlist),
      appUrl: 'https://app.planetpulse.example',
    },
  });
  return { app, db };
}

describe('the operator API scope', () => {
  it('answers 404 outside the allowlist before reading anything', async () => {
    const { app, db } = server('203.0.113.0/24');
    const res = await app.inject({ url: '/api/platform/v1/me', remoteAddress: '198.51.100.1' });
    expect(res.statusCode).toBe(404);
    expect(ApiErrorResponse.parse(res.json()).error.code).toBe('NOT_FOUND');
    expect(db.withOperator).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 401 without the operator cookie before reading anything', async () => {
    const { app, db } = server(undefined);
    const res = await app.inject({ url: '/api/platform/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(db.withOperator).not.toHaveBeenCalled();
    const logout = await app.inject({ method: 'POST', url: '/api/platform/v1/auth/logout' });
    expect(logout.statusCode).toBe(401);
    await app.close();
  });

  it('checks the sign-in body before reading anything', async () => {
    const { app, db } = server(undefined);
    const res = await app.inject({
      method: 'POST',
      url: '/api/platform/v1/auth/login',
      payload: { email: 'not an email' },
    });
    expect(ApiErrorResponse.parse(res.json()).error.code).toBe('VALIDATION');
    expect(db.withOperator).not.toHaveBeenCalled();
    await app.close();
  });
});
