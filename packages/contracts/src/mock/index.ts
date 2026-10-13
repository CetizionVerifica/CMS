// @canopy/contracts/mock: the mock API server (MODULES.md M0), for web modules (M11-M13) and their e2e tests.
// Node only. Start it with `pnpm --filter @canopy/contracts mock`, or create one in a test.
export { createMockServer, HANDLERS, MOCK_BASE_PATH, type MockServerOptions } from './server.js';
export { MockStore, type OutboxMessage } from './store.js';
export { MOCK_ENGINE_VERSION, MOCK_FILE_HOST } from './core.js';
export { FIRM_B_AS_OF } from '../fixtures/index.js';
