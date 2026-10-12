import { canopyVitestConfig, DEFAULT_THRESHOLDS } from '@canopy/vitest-config';
import { existsSync, readdirSync } from 'node:fs';
import { defineConfig, mergeConfig } from 'vitest/config';

// Each module's service.ts and routes.ts is held to the floor on its own: one threshold glob per file, because a
// glob matching several files pools them (and `perFile` inside a glob entry is ignored). So neither a large,
// well-tested src nor another module's well-tested service can hide untested database code.
const modulesDir = new URL('./src/modules/', import.meta.url);
const perFileThresholds = Object.fromEntries(
  (existsSync(modulesDir) ? readdirSync(modulesDir, { withFileTypes: true }) : [])
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      ['service.ts', 'routes.ts'].map((file) => `src/modules/${entry.name}/${file}`),
    )
    .filter((file) => existsSync(new URL(file, new URL('./', import.meta.url))))
    .map((file) => [file, DEFAULT_THRESHOLDS]),
);

// `pnpm test:db`: tests against a real Postgres 16 (DATABASE_URL), run by the CI `db` job. The unit tests run here
// too, so coverage is measured over all of src, including the service.ts and routes.ts files the unit run leaves out.
export default mergeConfig(
  canopyVitestConfig({
    exclude: ['src/main.ts', 'src/modules/*/testing/**'],
    thresholds: perFileThresholds,
  }),
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  }),
);
