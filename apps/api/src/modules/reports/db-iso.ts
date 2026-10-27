import type { IsoAction, IsoActionSubjectType } from '@canopy/contracts';
import {
  isoActions,
  isoCatalogue,
  managementSystems,
  MAX_LIMIT,
  nonconformities,
  obligations,
  people,
  riskControls,
  riskItems,
  units,
  type IsoPage,
  type TenantTx,
} from '@canopy/db';
import type {
  IsoNames,
  IsoNcBook,
  IsoNcFilter,
  IsoRiskBook,
  IsoRiskFilter,
} from '../dashboard/ports.js';

/**
 * ISO export reads over M3's repositories (docs/iso/model.md §9): every page of a list, in the caller's tenant
 * transaction, with the requester's unit scope passed to M3, which applies plan §3.3 in SQL. M10 builds no SQL.
 */

/** Every page of a keyset list. */
async function allPages<T>(read: (cursor: string | null) => Promise<IsoPage<T>>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const page: IsoPage<T> = await read(cursor);
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return out;
}

const copy = <T>(list: readonly T[] | undefined) => (list === undefined ? undefined : [...list]);
const scopeOf = (scope: IsoNcFilter['scope']) =>
  scope === null ? undefined : { unitIds: [...scope.unitIds], personId: scope.personId };

/** Rows by id, archived ones included, `MAX_LIMIT` ids a query. */
async function byIds<T extends { id: string }>(
  ids: Iterable<string>,
  read: (ids: string[]) => Promise<{ items: T[] }>,
): Promise<T[]> {
  const wanted = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < wanted.length; i += MAX_LIMIT) {
    out.push(...(await read(wanted.slice(i, i + MAX_LIMIT))).items);
  }
  return out;
}

/** Words for a standard code, as `IsoStandard.title` gives them ("ISO 9001"). */
const standardWords = (code: string) => code.replace('_', ' ');

async function namesOf(
  tx: TenantTx,
  clientId: string,
  ids: { people: Iterable<string>; obligations?: Iterable<string> },
): Promise<IsoNames> {
  const persons = await byIds(ids.people, (list) =>
    people.query(tx, { where: { id: list }, includeArchived: true, limit: MAX_LIMIT }),
  );
  const laws = await byIds(ids.obligations ?? [], (list) =>
    obligations.query(tx, { where: { id: list }, includeArchived: true, limit: MAX_LIMIT }),
  );
  const unitRows = [];
  for (let after: { key: string; id: string } | null = null; ;) {
    const { items } = await units.query(tx, {
      where: { clientId },
      includeArchived: true,
      limit: MAX_LIMIT,
      after,
    });
    unitRows.push(...items);
    if (items.length < MAX_LIMIT) break;
    const last = items.at(-1)!.id;
    after = { key: last, id: last };
  }
  const systems = await allPages((cursor) =>
    managementSystems.list(tx, clientId, { includeArchived: true, limit: MAX_LIMIT, cursor }),
  );
  const standards = new Map(
    (await isoCatalogue.standards(tx)).map((st) => [st.id, standardWords(st.code)]),
  );
  const clauses = await isoCatalogue.clauses(tx);
  return {
    people: new Map(persons.map((p) => [p.id, p.displayName])),
    units: new Map(unitRows.map((u) => [u.id, u.name])),
    systems: new Map(systems.map((m) => [m.id, m.name])),
    clauses: new Map(
      clauses.map((c) => [c.id, `${standards.get(c.standardId) ?? 'ISO'} ${c.number}`]),
    ),
    obligations: new Map(laws.map((o) => [o.id, o.title])),
  };
}

async function actionsOf(
  tx: TenantTx,
  clientId: string,
  type: IsoActionSubjectType,
  subjectIds: ReadonlySet<string>,
): Promise<IsoAction[]> {
  if (subjectIds.size === 0) return [];
  const all = await allPages((cursor) =>
    isoActions.list(tx, clientId, { subjectTypes: [type], limit: MAX_LIMIT, cursor }),
  );
  return all.filter((a) => subjectIds.has(a.subject.id));
}

export async function isoNcBook(
  tx: TenantTx,
  clientId: string,
  filter: IsoNcFilter,
): Promise<IsoNcBook> {
  const items = await allPages((cursor) =>
    nonconformities.list(tx, clientId, {
      managementSystemIds: copy(filter.managementSystemIds),
      unitIds: copy(filter.unitIds),
      state: copy(filter.state),
      source: copy(filter.source),
      severity: copy(filter.severity),
      standards: copy(filter.standards),
      ownerId: filter.ownerId,
      approverId: filter.approverId,
      scope: scopeOf(filter.scope),
      limit: MAX_LIMIT,
      cursor,
    }),
  );
  const actions = await actionsOf(tx, clientId, 'NONCONFORMITY', new Set(items.map((n) => n.id)));
  const names = await namesOf(tx, clientId, {
    people: items.flatMap((n) => [
      n.reportedById,
      n.ownerId,
      n.approverId,
      ...(n.dispositionAuthorisedById === null ? [] : [n.dispositionAuthorisedById]),
    ]),
  });
  return { items, actions, names };
}

export async function isoRiskBook(
  tx: TenantTx,
  clientId: string,
  filter: IsoRiskFilter,
): Promise<IsoRiskBook> {
  const items = await allPages((cursor) =>
    riskItems.list(tx, clientId, {
      managementSystemIds: copy(filter.managementSystemIds),
      unitIds: copy(filter.unitIds),
      kind: copy(filter.kind),
      significant: filter.significant,
      climateRelated: filter.climateRelated,
      ownerId: filter.ownerId,
      includeArchived: filter.includeArchived,
      scope: scopeOf(filter.scope),
      limit: MAX_LIMIT,
      cursor,
    }),
  );
  const controls = [];
  for (const item of items) controls.push(...(await riskControls.forRiskItem(tx, item.id)));
  const actions = await actionsOf(tx, clientId, 'RISK_ITEM', new Set(items.map((r) => r.id)));
  const names = await namesOf(tx, clientId, {
    people: items.map((r) => r.ownerId),
    obligations: items.flatMap((r) => r.obligationIds),
  });
  return { items, controls, actions, names };
}
