import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The committed migrations match the Drizzle schema: `drizzle-kit generate` against a copy of
 * migrations/ writes nothing new. A schema change without its migration fails here.
 */
describe('migrations vs schema', () => {
  it('drizzle-kit generate finds no schema changes', () => {
    const root = resolve(import.meta.dirname, '..');
    const out = mkdtempSync(join(tmpdir(), 'canopy-drift-'));
    cpSync(join(root, 'migrations'), out, { recursive: true });
    const before = readdirSync(out).sort();
    const config = join(mkdtempSync(join(tmpdir(), 'canopy-drift-config-')), 'drizzle.config.json');
    writeFileSync(
      config,
      JSON.stringify({
        dialect: 'postgresql',
        schema: join(root, 'src/schema/index.ts'),
        // drizzle-kit prefixes ./ to `out`, so it must be relative to the working directory.
        out: relative(root, out),
        entities: { roles: false },
      }),
    );
    const run = spawnSync(
      join(root, 'node_modules/.bin/drizzle-kit'),
      ['generate', `--config=${config}`],
      { cwd: root, encoding: 'utf8' },
    );
    expect(run.status).toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain('No schema changes');
    expect(readdirSync(out).sort()).toEqual(before);
  }, 60_000);
});
