import type { Id, Person } from '@canopy/contracts';
import { invalid, notFound, stale } from '../entities/http/errors.js';
import { emit } from '../entities/events.js';
import type { ReassignedInstance, Tx } from '../entities/store.js';
import { auditedUpdate, instantOf } from '../entities/write.js';

/** Audits instance reassignments M6 made and tells M9 (REASSIGN rows and `instance.reassigned` events). */
export async function auditReassigned(
  tx: Tx,
  instances: readonly ReassignedInstance[],
  reason: string | null,
): Promise<void> {
  for (const i of instances) {
    const ownerChanged = i.before.ownerId !== i.after.ownerId;
    const approverChanged = i.before.approverId !== i.after.approverId;
    if (!ownerChanged && !approverChanged) continue;
    await tx.audit({
      clientId: i.clientId,
      action: 'REASSIGN',
      entityType: 'instance',
      entityId: i.id,
      before: {
        ...(ownerChanged ? { ownerId: i.before.ownerId } : {}),
        ...(approverChanged ? { approverId: i.before.approverId } : {}),
      },
      after: {
        ...(ownerChanged ? { ownerId: i.after.ownerId } : {}),
        ...(approverChanged ? { approverId: i.after.approverId } : {}),
      },
      reason,
    });
    await emit(
      tx,
      {
        type: 'instance.reassigned',
        data: {
          instanceId: i.id,
          ownerId: ownerChanged ? { from: i.before.ownerId, to: i.after.ownerId } : null,
          approverId: approverChanged
            ? { from: i.before.approverId, to: i.after.approverId }
            : null,
        },
      },
      { type: 'instance', id: i.id, version: i.version },
      i.clientId,
    );
  }
}

export interface PersonMerge {
  tx: Tx;
  target: Person;
  version: number;
  sourceIds: readonly Id[];
  now: Date;
}

/**
 * Merges duplicate people (often two spellings from an import) into `target`: their assignments, instances and
 * memberships move to the target and they are archived. A source who has signed in (ACTIVE) is never merged away.
 * Each person row is written on its own (one row per statement), which the person update policy requires for
 * client contexts.
 */
export async function replacePersonEverywhere(m: PersonMerge): Promise<Person> {
  const { tx, target } = m;
  if (target.version !== m.version) throw stale(target.version);
  const sourceIds = [...new Set(m.sourceIds)];
  if (sourceIds.includes(target.id)) {
    throw invalid('A person cannot be merged into themselves.', ['body', 'sourceIds']);
  }
  const reason = `Merged into ${target.id}`;
  for (const sourceId of sourceIds) {
    const source = await tx.people.get(sourceId);
    if (!source || source.archivedAt !== null) throw notFound();
    if (source.status === 'ACTIVE') {
      throw invalid('A person who has signed in cannot be merged into another.', [
        'body',
        'sourceIds',
      ]);
    }
    // Archive first: once its rows move to the target, a client context can no longer see the source.
    await auditedUpdate({
      tx,
      repo: tx.people,
      entityType: 'person',
      row: source,
      version: source.version,
      patch: { archivedAt: instantOf(m.now) },
      clientId: null,
      action: 'MERGE_ALIAS',
      reason,
    });
    for (const field of ['defaultOwnerId', 'defaultApproverId'] as const) {
      for (const a of await tx.assignments.findAll({ [field]: sourceId })) {
        await auditedUpdate({
          tx,
          repo: tx.assignments,
          entityType: 'assignment',
          row: a,
          version: a.version,
          patch: { [field]: target.id },
          clientId: a.clientId,
          action: 'MERGE_ALIAS',
          reason,
        });
      }
    }
    await auditReassigned(tx, await tx.instances.replacePerson(sourceId, target.id), reason);
    const targetMemberships = await tx.memberships.findAll({ personId: target.id });
    for (const membership of await tx.memberships.findAll({ personId: sourceId })) {
      const twin = targetMemberships.some(
        (t) => t.role === membership.role && t.clientId === membership.clientId,
      );
      // A role the target already holds in that client is ended; any other moves to the target.
      await auditedUpdate({
        tx,
        repo: tx.memberships,
        entityType: 'membership',
        row: membership,
        version: membership.version,
        patch: twin ? { archivedAt: instantOf(m.now) } : { personId: target.id },
        clientId: membership.clientId,
        action: 'MERGE_ALIAS',
        reason,
      });
    }
  }
  await tx.audit({
    clientId: null,
    action: 'MERGE_ALIAS',
    entityType: 'person',
    entityId: target.id,
    before: null,
    after: { mergedIds: sourceIds },
    reason: null,
  });
  await emit(
    tx,
    { type: 'alias.merged', data: { entityType: 'person', targetId: target.id, sourceIds } },
    { type: 'person', id: target.id, version: target.version },
    null,
  );
  return target;
}
