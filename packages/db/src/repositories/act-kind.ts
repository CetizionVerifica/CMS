import { ActKind, Id } from '@canopy/contracts';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { TenantTx } from '../database.js';
import { rethrow, validate } from '../errors.js';
import * as s from '../schema/index.js';

/**
 * Act kinds (docs/iso/plan.md §4.6). Statutory numbers read STATUTE acts only; with the ISO add-on on, the lists take
 * a `source` filter that the API turns into `actKinds`. Undefined reads both kinds; an empty list matches nothing.
 */
export const ActKinds = z.array(ActKind).max(2);
export type ActKinds = z.infer<typeof ActKinds>;

/** An act-kind filter as the read options take it. */
export interface ActKindFilter {
  actKinds?: readonly ActKind[] | undefined;
}

function kindsOf(kinds: readonly ActKind[] | undefined): ActKind[] | undefined {
  return kinds === undefined ? undefined : validate(ActKinds, [...kinds]);
}

const kindList = (kinds: readonly ActKind[]): SQL =>
  sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  );

/** On a query that has `act` itself: its kind is one of `kinds`. */
export function actKindIs(kinds: readonly ActKind[] | undefined): SQL | undefined {
  const k = kindsOf(kinds);
  if (k === undefined) return undefined;
  return k.length === 0 ? sql`false` : sql`${s.act.kind} IN (${kindList(k)})`;
}

/** `column` holds an act id whose act is one of `kinds`. */
export function actIdOfKind(
  column: PgColumn,
  kinds: readonly ActKind[] | undefined,
): SQL | undefined {
  const k = kindsOf(kinds);
  if (k === undefined) return undefined;
  if (k.length === 0) return sql`false`;
  return sql`${column} IN (SELECT ka.id FROM act ka WHERE ka.kind IN (${kindList(k)}))`;
}

/** `column` holds an obligation id whose act is one of `kinds`. */
export function obligationIdOfKind(
  column: PgColumn,
  kinds: readonly ActKind[] | undefined,
): SQL | undefined {
  const k = kindsOf(kinds);
  if (k === undefined) return undefined;
  if (k.length === 0) return sql`false`;
  return sql`${column} IN (SELECT ko.id FROM obligation ko JOIN act ka ON ka.id = ko.act_id WHERE ka.kind IN (${kindList(k)}))`;
}

async function first(rows: Promise<{ kind: ActKind }[]>): Promise<ActKind | null> {
  const [row] = await rows.catch(rethrow);
  return row ? ActKind.parse(row.kind) : null;
}

/** Ids per read in `actKindOf.instances`. */
const KIND_BATCH = 1000;

/**
 * The act kind behind one instance, obligation or assignment, for the add-on's off-switch checks (plan §4.4): an
 * account without the add-on gets 404 on a STANDARD record. Null when the row does not exist or this context cannot
 * see it. Archived rows still answer: the switch applies to them too.
 */
export const actKindOf = {
  instance(tx: TenantTx, instanceId: string): Promise<ActKind | null> {
    const id = validate(Id, instanceId);
    return first(
      tx
        .select({ kind: s.act.kind })
        .from(s.complianceInstance)
        .innerJoin(s.assignment, eq(s.assignment.id, s.complianceInstance.assignmentId))
        .innerJoin(s.obligation, eq(s.obligation.id, s.assignment.obligationId))
        .innerJoin(s.act, eq(s.act.id, s.obligation.actId))
        .where(eq(s.complianceInstance.id, id)),
    );
  },
  /**
   * The act kind of many instances, one read per 1,000 ids (ISO-2j), with `instance`'s joins: archived rows answer,
   * ids this context cannot see (or that do not exist) are left out of the map.
   */
  async instances(tx: TenantTx, instanceIds: readonly string[]): Promise<Map<string, ActKind>> {
    const ids = [...new Set(validate(z.array(Id), [...instanceIds]))];
    const kinds = new Map<string, ActKind>();
    for (let i = 0; i < ids.length; i += KIND_BATCH) {
      const rows = await tx
        .select({ id: s.complianceInstance.id, kind: s.act.kind })
        .from(s.complianceInstance)
        .innerJoin(s.assignment, eq(s.assignment.id, s.complianceInstance.assignmentId))
        .innerJoin(s.obligation, eq(s.obligation.id, s.assignment.obligationId))
        .innerJoin(s.act, eq(s.act.id, s.obligation.actId))
        .where(inArray(s.complianceInstance.id, ids.slice(i, i + KIND_BATCH)))
        .catch(rethrow);
      for (const row of rows) kinds.set(row.id, ActKind.parse(row.kind));
    }
    return kinds;
  },
  obligation(tx: TenantTx, obligationId: string): Promise<ActKind | null> {
    const id = validate(Id, obligationId);
    return first(
      tx
        .select({ kind: s.act.kind })
        .from(s.obligation)
        .innerJoin(s.act, eq(s.act.id, s.obligation.actId))
        .where(eq(s.obligation.id, id)),
    );
  },
  assignment(tx: TenantTx, assignmentId: string): Promise<ActKind | null> {
    const id = validate(Id, assignmentId);
    return first(
      tx
        .select({ kind: s.act.kind })
        .from(s.assignment)
        .innerJoin(s.obligation, eq(s.obligation.id, s.assignment.obligationId))
        .innerJoin(s.act, eq(s.act.id, s.obligation.actId))
        .where(eq(s.assignment.id, id)),
    );
  },
};
