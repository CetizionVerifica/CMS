import { canopyVitestConfig, DEFAULT_THRESHOLDS } from '@canopy/vitest-config';
import { existsSync, readdirSync } from 'node:fs';
import { sep } from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';

// Database-only code is held to the floor file by file: each module's service.ts and routes.ts, and every `db-*.ts`
// under src. One threshold glob per file, because a glob matching several files pools them (and `perFile` inside a
// glob entry is ignored). So neither a large, well-tested src nor another well-tested file can hide untested code.
const src = new URL('./src/', import.meta.url);
const moduleFiles = (
  existsSync(new URL('modules/', src))
    ? readdirSync(new URL('modules/', src), { withFileTypes: true })
    : []
)
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => ['service.ts', 'routes.ts'].map((file) => `modules/${entry.name}/${file}`));
const dbFiles = (existsSync(src) ? readdirSync(src, { recursive: true }) : [])
  .map((file) => String(file).split(sep).join('/'))
  .filter((file) => /(^|\/)db-[^/]*\.ts$/.test(file) && !file.endsWith('.test.ts'));
const perFileThresholds = Object.fromEntries(
  [...moduleFiles, ...dbFiles]
    .filter((file) => existsSync(new URL(file, src)))
    .map((file) => [`src/${file}`, DEFAULT_THRESHOLDS]),
);

// `pnpm test:db`: tests against a real Postgres 16 (DATABASE_URL), run by the CI `db` job. The unit tests run here
// too, so coverage is measured over all of src, including the files the unit run leaves out.
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
