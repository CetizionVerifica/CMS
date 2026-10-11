import { canopyVitestConfig } from '@canopy/vitest-config';

// main.ts only boots the server; behaviour lives in server.ts and modules, which are covered.
export default canopyVitestConfig({ exclude: ['src/main.ts'] });
