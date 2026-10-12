import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AdminDatabase, Database } from '../src/database.js';
import {
  defineSeedHook,
  findSeedModules,
  loadSeedHooks,
  runSeed,
  SEED_FIRMS,
  type SeedHook,
} from '../src/seed.js';

const root = mkdtempSync(join(tmpdir(), 'canopy-seed-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function writePackage(group: string, dir: string, pkg: object, files: Record<string, string> = {}) {
  const packageDir = join(root, group, dir);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(pkg));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(packageDir, name), body);
}

/** An admin database that remembers which firms exist; the seed only needs these two calls. */
function fakeAdmin(existing: string[] = []) {
  const firms = new Set(existing);
  const created: string[] = [];
  const admin = {
    firmExists: async (id: string) => firms.has(id),
    createFirm: async ({ id }: { id: string }) => {
      firms.add(id);
      created.push(id);
      return id;
    },
  } as unknown as AdminDatabase;
  return { admin, created };
}

const db = {} as Database;

describe('runSeed', () => {
  it('creates the two seed firms once, then runs hooks in order', async () => {
    const { admin, created } = fakeAdmin([SEED_FIRMS.b.id]);
    const ran: string[] = [];
    const hook = (name: string, order?: number): SeedHook =>
      defineSeedHook({
        name,
        order,
        run: async (ctx) => {
          expect(ctx.db).toBe(db);
          expect(ctx.firms).toBe(SEED_FIRMS);
          ran.push(name);
        },
      });
    const lines: string[] = [];
    await runSeed({
      admin,
      db,
      hooks: [hook('b-late', 200), hook('b-default'), hook('a-default'), hook('first', 1)],
      log: (line) => lines.push(line),
    });
    expect(created).toEqual([SEED_FIRMS.a.id]);
    expect(ran).toEqual(['first', 'a-default', 'b-default', 'b-late']);
    expect(lines).toContain('firm Demo Advisory: created');
    expect(lines).toContain('firm Second Ledger Consulting: exists');

    // A second run creates nothing and logs nowhere by default.
    await runSeed({ admin, db, hooks: [] });
    expect(created).toEqual([SEED_FIRMS.a.id]);
  });
});

describe('seed modules', () => {
  writePackage(
    'packages',
    'importer',
    { name: '@canopy/importer', canopy: { seed: './seed.mjs' } },
    { 'seed.mjs': "export default { name: 'sample register', run: async () => {} };" },
  );
  writePackage(
    'apps',
    'broken',
    { name: '@canopy/broken', canopy: { seed: './seed.mjs' } },
    { 'seed.mjs': 'export default { name: 42 };' },
  );
  writePackage('packages', 'ui', { name: '@canopy/ui' });
  writePackage('packages', 'unnamed', { canopy: { seed: './seed.mjs' } });
  mkdirSync(join(root, 'packages', 'no-package-json'), { recursive: true });

  it('finds canopy.seed entries in apps and packages, sorted by package name', () => {
    const found = findSeedModules(root);
    expect(found.map((m) => m.packageName)).toEqual([
      '@canopy/broken',
      '@canopy/importer',
      'unnamed',
    ]);
    expect(found[1]!.path).toBe(join(root, 'packages', 'importer', 'seed.mjs'));
  });

  it('skips a workspace group that does not exist', () => {
    const empty = mkdtempSync(join(tmpdir(), 'canopy-seed-empty-'));
    try {
      expect(findSeedModules(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('loads hooks and rejects a module that is not a SeedHook', async () => {
    const [broken, importer] = findSeedModules(root);
    const hooks = await loadSeedHooks([importer!]);
    expect(hooks.map((h) => h.name)).toEqual(['sample register']);
    await expect(loadSeedHooks([broken!])).rejects.toThrow(
      '@canopy/broken: canopy.seed module must default-export a SeedHook',
    );
  });
});
