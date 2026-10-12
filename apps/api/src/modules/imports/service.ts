import type { Act, Category, Location, Obligation } from '@canopy/contracts';
import {
  acts,
  categories,
  clients,
  companies,
  departments,
  importBatches,
  importIssues,
  importRows,
  locations,
  mappingTemplates,
  obligations,
  people,
  units,
  type Database,
  type PageRequest,
  type TenantTx,
} from '@canopy/db';
import {
  companyKey,
  EMPTY_STATE,
  fingerprintObligation,
  locationKey,
  obligationRefKey,
  unitKey,
  type ExistingState,
} from '@canopy/importer';
import type { ImportStore, ImportTx, Page } from './store.js';

/**
 * `ImportStore` on the M3 repositories: the import module's only database access, and the only code here that
 * needs Postgres (so `pnpm test:db` counts its coverage). The import steps themselves are in steps.ts.
 */

/** Postgres takes at most 65,535 parameters per statement; a row insert uses about ten per row. */
const INSERT_CHUNK = 1_000;

async function chunked<T, R>(items: readonly T[], write: (chunk: T[]) => Promise<R[]>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += INSERT_CHUNK) {
    out.push(...(await write(items.slice(i, i + INSERT_CHUNK))));
  }
  return out;
}

/** Every page of a keyset-paged list. */
async function all<T>(list: (page: PageRequest) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await list({ limit: 200, cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}

const known = (rows: readonly (Act | Category | { name: string; aliases: string[] })[]) =>
  rows.map((r) => ({ name: r.name, aliases: [...r.aliases] }));

/**
 * The client's existing library, people and places by the importer's natural keys. Assignments and
 * instances come with the commit step; until then a parse treats them as new.
 */
async function existingState(tx: TenantTx, clientId: string): Promise<ExistingState> {
  // One transaction runs one query at a time, so these are sequential.
  const actRows = await all((p) => acts.list(tx, p));
  const categoryRows = await all((p) => categories.list(tx, p));
  const departmentRows = await all((p) => departments.list(tx, clientId, p));
  const personRows = await all((p) => people.list(tx, p));
  const companyRows = await all((p) => companies.list(tx, clientId, p));
  const unitRows = await all((p) => units.list(tx, clientId, p));
  const locationRows = await all((p) => locations.list(tx, p));
  const obligationRows = await all((p) => obligations.list(tx, p));
  const companyName = new Map(companyRows.map((c) => [c.id, c.name]));
  const locationById = new Map<string, Location>(locationRows.map((l) => [l.id, l]));
  const actName = new Map(actRows.map((a) => [a.id, a.name]));
  const categoryName = new Map(categoryRows.map((c) => [c.id, c.name]));

  const obligationState: Record<string, string> = {};
  for (const o of obligationRows) {
    if (o.externalRef === null) continue;
    const key = obligationRefKey(o.externalRef);
    obligationState[key] = fingerprintOf(o, key, actName, categoryName);
  }
  return {
    ...EMPTY_STATE,
    acts: known(actRows),
    categories: known(categoryRows),
    departments: known(departmentRows),
    people: personRows.map((p) => ({
      nameNormalized: p.nameNormalized,
      displayName: p.displayName,
    })),
    companies: companyRows.map((c) => companyKey(c.name)),
    units: unitRows.map((u) => unitKey(nameOf(companyName, u.companyId), u.name)),
    locations: [...new Set(unitRows.map((u) => u.locationId))]
      .map((id) => locationById.get(id))
      .filter((l): l is Location => l !== undefined)
      .map(locationKey),
    obligations: obligationState,
  };
}

/** A referenced row's name; '' when it is archived (archived rows are not listed), so the keys differ. */
function nameOf(names: Map<string, string>, id: string): string {
  return names.get(id) ?? '';
}

function fingerprintOf(
  o: Obligation,
  key: string,
  actName: Map<string, string>,
  categoryName: Map<string, string>,
): string {
  return fingerprintObligation({
    key,
    externalRef: o.externalRef,
    domain: o.domain,
    jurisdiction: o.jurisdiction,
    stateCode: o.stateCode,
    act: nameOf(actName, o.actId),
    category: nameOf(categoryName, o.categoryId),
    title: o.title,
    description: o.description,
    applicabilityText: o.applicabilityText,
    criticality: o.criticality,
    timelineType: o.timelineType,
    inferred: null,
    recurrenceRule: o.recurrenceRule,
    ruleStatus: o.ruleStatus,
    forms: o.forms,
    logSheets: o.logSheets,
  });
}

function importTx(tx: TenantTx): ImportTx {
  return {
    getBatch: (id) => importBatches.get(tx, id),
    createBatch: (input) => importBatches.create(tx, input),
    updateBatch: (id, version, patch) => importBatches.update(tx, id, version, patch),
    listBatches: (clientId, page) =>
      importBatches.list(tx, clientId, { limit: page.limit, cursor: page.cursor ?? null }),

    addRows: (batchId, rows) => chunked(rows, (chunk) => importRows.createMany(tx, batchId, chunk)),
    rows: (batchId, page) => importRows.forBatch(tx, batchId, page),
    async setRow(id, patch) {
      await importRows.setOutcome(tx, id, patch);
    },

    addIssues: (batchId, issues) =>
      chunked(issues, (chunk) => importIssues.createMany(tx, batchId, chunk)),
    issues: (batchId) => importIssues.forBatch(tx, batchId),
    async decideGroup(batchId, groupKey, decision, editedValue) {
      await importIssues.decideGroup(tx, batchId, groupKey, decision, editedValue);
    },
    async removeGroups(batchId, groupKeys) {
      await importIssues.removeGroups(tx, batchId, groupKeys);
    },

    templatesFor: (clientId) => mappingTemplates.forClient(tx, clientId),
    getTemplate: (id) => mappingTemplates.get(tx, id),
    createTemplate: (input) => mappingTemplates.create(tx, input),
    updateTemplate: (id, version, patch) => mappingTemplates.update(tx, id, version, patch),

    async calendar(clientId) {
      const { settings } = await clients.require(tx, clientId);
      return { fyStartMonth: settings.fyStartMonth, holidayPolicy: settings.holidayPolicy };
    },
    existingState: (clientId) => existingState(tx, clientId),
  };
}

export function repositoryStore(db: Database): ImportStore {
  return { transaction: (ctx, fn) => db.withTenant(ctx, (tx) => fn(importTx(tx))) };
}
