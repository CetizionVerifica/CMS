import { canopyVitestConfig } from '@canopy/vitest-config';

// Pages and layouts are covered by Playwright (e2e/); unit coverage applies to shared logic in lib/.
export default canopyVitestConfig({ include: ['lib/**/*.{ts,tsx}'] });
