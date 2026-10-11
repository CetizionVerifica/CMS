import { canopyVitestConfig } from '@canopy/vitest-config';

// MODULES.md M4: 100% branch coverage on status and score. Keep that logic in files whose
// names contain "status" or "score" so these thresholds apply to it.
export default canopyVitestConfig({
  thresholds: {
    lines: 95,
    functions: 95,
    branches: 95,
    statements: 95,
    'src/**/*{status,score}*.ts': { branches: 100, lines: 100, functions: 100, statements: 100 },
  },
});
