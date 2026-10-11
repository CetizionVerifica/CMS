import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AdminDatabase, Database } from './database.js';

/**
 * `pnpm db:seed`: creates the two seed firms (packages/db/CLAUDE.md rule 10), then runs the seed hooks
 * other packages register. M8 registers the one that loads the sample register through the importer,
 * so seeds never hand-write instance rows.
 *
 * A package registers a hook by naming a module in its package.json:
 *   "canopy": { "seed": "./src/seed.ts" }
 * whose default export is a SeedHook (use `defineSeedHook`). Hooks run in `order`, then package name.
 */

/** The seed firms. Ids are fixed so seeding is idempotent and tests can name them. */
export const SEED_FIRMS = {
  a: { id: '01920000-0000-7000-8000-00000000a001', name: 'Demo Advisory' },
  b: { id: '01920000-0000-7000-8000-00000000b001', name: 'Second Ledger Consulting' },
} as const;

export interface SeedContext {
  /** Tenant access: hooks write through `db.withTenant(systemContext(firm.id, ...), ...)`. */
  db: Database;
  firms: typeof SEED_FIRMS;
  /** Progress lines. Never log row contents: the sample holds employee names. */
  log: (line: string) => void;
}

export interface SeedHook {
  name: string;
  /** Lower runs first (default 100). */
  order?: number;
  /** Must be idempotent: `pnpm db:seed` may run on a seeded database. */
  run(ctx: SeedContext): Promise<void>;
}

export function defineSeedHook(hook: SeedHook): SeedHook {
  return hook;
}

export async function runSeed(options: {
  admin: AdminDatabase;
  db: Database;
  hooks: readonly SeedHook[];
  log?: (line: string) => void;
}): Promise<void> {
  const log = options.log ?? (() => {});
  for (const firm of Object.values(SEED_FIRMS)) {
    if (await options.admin.firmExists(firm.id)) {
      log(`firm ${firm.name}: exists`);
    } else {
      await options.admin.createFirm(firm);
      log(`firm ${firm.name}: created`);
    }
  }
  const hooks = [...options.hooks].sort(
    (x, y) => (x.order ?? 100) - (y.order ?? 100) || x.name.localeCompare(y.name),
  );
  for (const hook of hooks) {
    log(`hook ${hook.name}: running`);
    await hook.run({ db: options.db, firms: SEED_FIRMS, log });
  }
}

interface PackageJson {
  name?: string;
  canopy?: { seed?: string };
}

/** Finds `canopy.seed` modules in the workspace's apps/* and packages/* package.json files. */
export function findSeedModules(workspaceRoot: string): { packageName: string; path: string }[] {
  const found: { packageName: string; path: string }[] = [];
  for (const group of ['apps', 'packages']) {
    let dirs: string[];
    try {
      dirs = readdirSync(join(workspaceRoot, group));
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const packageDir = join(workspaceRoot, group, dir);
      let pkg: PackageJson;
      try {
        pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PackageJson;
      } catch {
        continue;
      }
      const seed = pkg.canopy?.seed;
      if (seed) found.push({ packageName: pkg.name ?? dir, path: resolve(packageDir, seed) });
    }
  }
  return found.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

/** Imports seed modules; each must default-export a SeedHook. */
export async function loadSeedHooks(
  modules: { packageName: string; path: string }[],
): Promise<SeedHook[]> {
  const hooks: SeedHook[] = [];
  for (const m of modules) {
    const mod = (await import(pathToFileURL(m.path).href)) as { default?: Partial<SeedHook> };
    const hook = mod.default;
    if (!hook || typeof hook.name !== 'string' || typeof hook.run !== 'function') {
      throw new Error(`${m.packageName}: canopy.seed module must default-export a SeedHook`);
    }
    hooks.push(hook as SeedHook);
  }
  return hooks;
}
