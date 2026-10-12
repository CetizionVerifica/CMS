import type { Id } from '@canopy/contracts';
import { invalid, notFound } from './http/errors.js';
import { emit } from './events.js';
import type { Repo, Tx } from './store.js';
import { auditedUpdate, instantOf } from './write.js';

type Aliased = {
  id: Id;
  version: number;
  name: string;
  aliases: string[];
  archivedAt: string | null;
};

export interface MergeInput<T extends Aliased> {
  tx: Tx;
  repo: Repo<T>;
  entityType: 'act' | 'category' | 'department';
  target: T;
  version: number;
  sourceIds: readonly Id[];
  clientId: Id | null;
  now: Date;
  /** False when a source belongs to another scope (a department of another client). */
  sameScope?: (source: T) => boolean;
  /** Re-points rows that reference the source (obligations, assignments) to the target. */
  moveReferences: (sourceId: Id, targetId: Id) => Promise<void>;
}

/** Adds names to a list of aliases, case-insensitively, leaving out the record's own name. */
export function withAliases(
  name: string,
  aliases: readonly string[],
  add: readonly string[],
): string[] {
  const seen = new Set([name.toLowerCase()]);
  const result: string[] = [];
  for (const alias of [...aliases, ...add]) {
    const key = alias.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(alias);
    }
  }
  return result;
}

/**
 * Merges records into `target`: their names and aliases become the target's aliases, references move to the target,
 * and the sources are archived. Every row changed is audited as MERGE_ALIAS; one `alias.merged` event is emitted.
 */
export async function mergeInto<T extends Aliased>(m: MergeInput<T>): Promise<T> {
  const sourceIds = [...new Set(m.sourceIds)];
  if (sourceIds.includes(m.target.id)) {
    throw invalid('A record cannot be merged into itself.', ['body', 'sourceIds']);
  }
  const sources: T[] = [];
  for (const id of sourceIds) {
    const source = await m.repo.get(id);
    if (!source || source.archivedAt !== null || (m.sameScope && !m.sameScope(source))) {
      throw notFound();
    }
    sources.push(source);
  }
  const archivedAt = instantOf(m.now);
  for (const source of sources) {
    await m.moveReferences(source.id, m.target.id);
    await auditedUpdate({
      tx: m.tx,
      repo: m.repo,
      entityType: m.entityType,
      row: source,
      version: source.version,
      patch: { archivedAt } as Parameters<Repo<T>['update']>[2],
      clientId: m.clientId,
      action: 'MERGE_ALIAS',
      reason: `Merged into ${m.target.id}`,
    });
  }
  const aliases = withAliases(
    m.target.name,
    m.target.aliases,
    sources.flatMap((s) => [s.name, ...s.aliases]),
  );
  const merged = await auditedUpdate({
    tx: m.tx,
    repo: m.repo,
    entityType: m.entityType,
    row: m.target,
    version: m.version,
    patch: { aliases } as Parameters<Repo<T>['update']>[2],
    clientId: m.clientId,
    action: 'MERGE_ALIAS',
  });
  await emit(
    m.tx,
    {
      type: 'alias.merged',
      data: { entityType: m.entityType, targetId: m.target.id, sourceIds },
    },
    { type: m.entityType, id: merged.id, version: merged.version },
    m.clientId,
  );
  return merged;
}
