// @canopy/db: Postgres schema, tenancy and migrations (MODULES.md M3).
// Request code reaches the database only through `Database.withTenant`.
export * as schema from './schema/index.js';
export {
  APP_ROLE,
  MIGRATIONS_FOLDER,
  OPERATOR_ROLE,
  createAdminDatabase,
  createDatabase,
  createOperatorDatabase,
  withSavepoint,
  type AdminDatabase,
  type Database,
  type DatabaseOptions,
  type NewFirm,
  type OperatorDatabase,
  type OperatorTx,
  type Schema,
  type TenantTx,
} from './database.js';
export {
  systemContext,
  tenantFromRequest,
  tenantSettings,
  type TenantContext,
  type TenantSettings,
} from './tenant-context.js';
export * from './repositories/index.js';
export { DbError } from './errors.js';
export {
  LoginCandidate,
  LoginTokenKind,
  LoginTokenLookup,
  SessionLookup,
  SupportTokenLookup,
  TokenHash,
  type AuthLookups,
} from './auth-lookups.js';
export { isUuidV7, uuidv7 } from './uuid.js';
export {
  SEED_FIRMS,
  defineSeedHook,
  findSeedModules,
  loadSeedHooks,
  runSeed,
  type SeedContext,
  type SeedHook,
} from './seed.js';
