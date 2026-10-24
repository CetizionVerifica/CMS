// M5 public surface: the only auth file other modules import (apps/api/src/auth/CLAUDE.md).
export { ApiError, errorEnvelope } from './errors.js';
export { loggableError, type LoggedError } from './log-error.js';
export {
  POLICY,
  can,
  canGrantRole,
  isFirmRole,
  ruleFor,
  type Grant,
  type PolicyRule,
} from './policy.js';
export {
  activeMemberships,
  buildRequestContext,
  visibleClientIds,
  type AuthStore,
  type Principal,
  type SessionRecord,
} from './context.js';
export {
  CSRF_HEADER,
  ROUTE_AUTH,
  SESSION_COOKIE,
  authorize,
  registerAuth,
  requireClient,
  type AuthOptions,
  type RouteAuth,
} from './plugin.js';
export * from './accounts.js';
export { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';
export { SecretBox } from './secretbox.js';
export { hashToken, newToken, redactUrl, sameToken } from './tokens.js';
// The operator console (M15) signs in with the same scrypt, TOTP and secret box (ADR M15-0001 decision 9).
export { newTotpSecret, otpauthUri, verifyTotp } from './totp.js';
export { isSupportSession, sessionOf } from './plugin.js';
export { AuthService, type IssuedSession } from './service.js';
export { registerAuthRoutes, type AuthRoutesOptions } from './routes.js';
export {
  createDbAccountStore,
  type DbAccountStoreOptions,
  type GeneratedRange,
} from './db-store.js';
