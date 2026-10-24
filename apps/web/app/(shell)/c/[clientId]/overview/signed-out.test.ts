// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../../lib/api/client';

const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`redirect ${to}`);
  }),
);
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('../../../../../lib/shell/server', () => ({
  requestPath: async () => '/c/abc/overview?period=FY2024',
}));

const { redirectIfSignedOut } = await import('./signed-out');

const refusal = (status: number, code: ConstructorParameters<typeof ApiError>[1]) =>
  new ApiError(status, code, 'refused', undefined, 'mock');

describe('redirectIfSignedOut', () => {
  it('sends a signed-out request to sign in, coming back to the page', async () => {
    await expect(redirectIfSignedOut(refusal(401, 'UNAUTHENTICATED'))).rejects.toThrow(
      'redirect /login?next=%2Fc%2Fabc%2Foverview%3Fperiod%3DFY2024',
    );
  });

  it('sends a half-finished sign-in to the code step', async () => {
    await expect(redirectIfSignedOut(refusal(401, 'MFA_REQUIRED'))).rejects.toThrow(
      'redirect /login/verify?next=%2Fc%2Fabc%2Foverview%3Fperiod%3DFY2024',
    );
  });

  it('leaves every other error to the page', async () => {
    await expect(redirectIfSignedOut(refusal(403, 'FORBIDDEN'))).resolves.toBeUndefined();
    await expect(redirectIfSignedOut(new Error('boom'))).resolves.toBeUndefined();
    expect(redirect).toHaveBeenCalledTimes(2);
  });
});
