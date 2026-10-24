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
export { hashPassword, verifyPassword } from './passwords.js';
export { SecretBox } from './secretbox.js';
export { redactUrl } from './tokens.js';
export { sessionOf } from './plugin.js';
export { AuthService, type IssuedSession } from './service.js';
export { registerAuthRoutes, type AuthRoutesOptions } from './routes.js';
export {
  createDbAccountStore,
  type DbAccountStoreOptions,
  type GeneratedRange,
} from './db-store.js';
