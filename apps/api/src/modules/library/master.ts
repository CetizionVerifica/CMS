import type { Act, Category, Obligation } from '@canopy/contracts';
import { MASTER_CONTENT, MASTER_VERSION } from './master-data.js';

/**
 * The master obligation library a new account starts with (ADR M15-0001 decision 8, ADR M6-0001). Rows refer to
 * each other by `key`, which exists only here: each account gets its own copy with its own ids.
 */

type Server = 'id' | 'firmId' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'version';

export type MasterCategory = Omit<Category, Server> & { key: string };
export type MasterAct = Omit<Act, Server> & { key: string };
export type MasterObligation = Omit<
  Obligation,
  Server | 'actId' | 'categoryId' | 'libraryVersion'
> & {
  /** The `key` of an Act in the same library. */
  act: string;
  /** The `key` of a category in the same library. */
  category: string;
};

export interface MasterLibrary {
  /** Copied into each obligation's `libraryVersion`. */
  version: number;
  categories: readonly MasterCategory[];
  acts: readonly MasterAct[];
  obligations: readonly MasterObligation[];
}

/**
 * Version 1 was empty. Version 2 is the statutory content of the sample register (ADR M6-0002): its Acts,
 * categories and obligations as an import into an empty account plans them, with no unit, person or instance.
 * `master-data.ts` is generated; `from-register.test.ts` fails when it drifts from the register.
 */
export const MASTER_LIBRARY: MasterLibrary = { version: MASTER_VERSION, ...MASTER_CONTENT };

/** Throws on a repeated key or a reference to a missing one, so a broken library never half-copies. */
export function checkMasterLibrary(library: MasterLibrary): void {
  const keys = (rows: readonly { key: string }[], what: string) => {
    const seen = new Set<string>();
    for (const { key } of rows) {
      if (seen.has(key)) throw new Error(`Master library: ${what} key "${key}" is repeated`);
      seen.add(key);
    }
    return seen;
  };
  const categories = keys(library.categories, 'category');
  const acts = keys(library.acts, 'Act');
  library.obligations.forEach((o, i) => {
    if (!acts.has(o.act))
      throw new Error(`Master library: obligation ${i} names unknown Act "${o.act}"`);
    if (!categories.has(o.category)) {
      throw new Error(`Master library: obligation ${i} names unknown category "${o.category}"`);
    }
  });
}
