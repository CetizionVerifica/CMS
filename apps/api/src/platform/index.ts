import type { OperatorDatabase } from '@canopy/db';
import type { FastifyInstance } from 'fastify';
import { ApiError, type SecretBox } from '../auth/index.js';
import type { IpAllowlist } from './allowlist.js';
import { registerAccountRoutes } from './db-accounts.js';
import { registerBillingRoutes } from './db-billing.js';
import { registerOperatorAuth } from './db-auth.js';
import { registerLifecycleRoutes } from './db-lifecycle.js';
import { registerSupportRoutes } from './db-support.js';
import type { PlatformDeps } from './db-http.js';
import { OperatorIdempotency } from './idempotency.js';
import { OPERATOR_PREFIX } from './session.js';

export { ipAllowlistFromEnv, type IpAllowlist } from './allowlist.js';
export { addOperator, type AddedOperator } from './db-operators.js';
export { registerCustomerAccountRoutes, type CustomerAccountDeps } from './db-customer.js';
export { OPERATOR_COOKIE, OPERATOR_PREFIX } from './session.js';

export interface PlatformOptions {
  /** The console's own login (`OPERATOR_DATABASE_URL`), a member of `canopy_operator` only (ADR M3-0002). */
  readonly db: OperatorDatabase;
  /** M5's secret box (`AUTH_SECRET_KEY`): opens the operators' sealed TOTP secrets. */
  readonly secrets: SecretBox;
  readonly clock?: () => Date;
  /** `PLATFORM_IP_ALLOWLIST`; other addresses get 404 on every operator route. Null lets every address through. */
  readonly allowlist?: IpAllowlist | null;
  /** `Secure` on the `op_sid` cookie. Default: on unless NODE_ENV is development or test. */
  readonly secureCookies?: boolean;
  /** The customer app's origin (`APP_URL`), where support-session links open. */
  readonly appUrl: string;
}

/**
 * The operator API under `/api/platform/v1` (ADR M15-0001 decision 9), mounted by the server only when
 * `PLATFORM_ENABLED=true`. It runs in its own scope, on its own database login and session, and reads no tenant data.
 */
export function registerPlatform(app: FastifyInstance, options: PlatformOptions): void {
  const deps: PlatformDeps = {
    db: options.db,
    secrets: options.secrets,
    clock: options.clock ?? (() => new Date()),
    secure: options.secureCookies ?? !['development', 'test'].includes(process.env.NODE_ENV ?? ''),
    appUrl: options.appUrl,
  };
  const allowlist = options.allowlist ?? null;
  const idempotency = new OperatorIdempotency();
  void app.register(
    async (api) => {
      if (allowlist) {
        // Before anything else in the scope, so an address outside the list learns nothing, not even that the
        // operator API exists.
        api.addHook('onRequest', async (request) => {
          if (!allowlist(request.ip)) throw new ApiError('NOT_FOUND');
        });
      }
      registerOperatorAuth(api, deps);
      registerAccountRoutes(api, deps, idempotency);
      registerLifecycleRoutes(api, deps);
      registerBillingRoutes(api, deps, idempotency);
      registerSupportRoutes(api, deps);
    },
    { prefix: OPERATOR_PREFIX },
  );
}
