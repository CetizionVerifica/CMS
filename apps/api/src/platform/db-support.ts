import { PLATFORM_ENDPOINTS, SUPPORT_TOKEN_SECONDS } from '@canopy/contracts';
import { platformSupport } from '@canopy/db';
import type { FastifyInstance } from 'fastify';
import { ApiError, hashToken, newToken } from '../auth/index.js';
import { requireAccount } from './db-accounts.js';
import { mountPlatform, type PlatformDeps } from './db-http.js';
import { trail } from './db-trail.js';

/** The customer-app page that exchanges the token; the token rides in the fragment, so no server or referrer logs it. */
export function supportSessionUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}/support/start#token=${token}`;
}

/**
 * Support access from the console (ADR M15-0001 decision 11). The operator sees an account's grants without person
 * ids, and opens the customer app as the support person of a live grant only, with a one-time token valid 60
 * seconds that `POST /auth/support/verify` exchanges for the session. Without a live grant there is no way in.
 */
export function registerSupportRoutes(api: FastifyInstance, deps: PlatformDeps): void {
  const { db } = deps;

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.listAccountSupportGrants,
    async ({ requestId, params, now }) =>
      db.withOperator(requestId, async (tx) => {
        await requireAccount(tx, params.id!);
        return { items: await platformSupport.list(tx, params.id!, now.toISOString()) };
      }),
  );

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.openSupportSession,
    async ({ request, requestId, params, now }) =>
      db.withOperator(requestId, async (tx) => {
        const grant = await platformSupport.get(tx, params.id!, now.toISOString());
        if (!grant) throw new ApiError('NOT_FOUND');
        if (grant.status !== 'ACTIVE') {
          throw new ApiError('ACCESS_EXPIRED', { expiredAt: grant.revokedAt ?? grant.endsAt });
        }
        const token = newToken();
        const expiresAt = new Date(now.getTime() + SUPPORT_TOKEN_SECONDS * 1000).toISOString();
        await platformSupport.issueToken(tx, {
          accountId: grant.accountId,
          grantId: grant.id,
          tokenHash: hashToken(token),
          expiresAt,
        });
        await trail(tx, request, requestId, {
          action: 'SUPPORT_ACCESS_START',
          accountId: grant.accountId,
          before: null,
          after: { grantId: grant.id, level: grant.level, grantEndsAt: grant.endsAt },
        });
        return { url: supportSessionUrl(deps.appUrl, token), expiresAt };
      }),
  );
}
