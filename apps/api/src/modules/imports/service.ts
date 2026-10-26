import type {
  Act,
  Assignment,
  AuditAction,
  Category,
  Company,
  Department,
  EntityType,
  Location,
  Obligation,
  Person,
  Unit,
} from '@canopy/contracts';
import {
  account,
  acts,
  assignments,
  auditEvents,
  categories,
  clients,
  comments,
  companies,
  departments,
  importBatches,
  importIssues,
  importRows,
  instances,
  locations,
  mappingTemplates,
  obligations,
  people,
  units,
  type Database,
  type PageRequest,
  type RegisterRow,
  type TenantTx,
} from '@canopy/db';
import { addDays, generateInstances, type Calendar } from '@canopy/engine';
import {
  companyKey,
  fingerprintAssignment,
  fingerprintObligation,
  locationKey,
  obligationRefKey,
  obligationTitleKey,
  unitKey,
  type ExistingInstance,
  type ExistingState,
  type PlanInstance,
  type PlanObligation,
} from '@canopy/importer';
import type { CommitRequest, CommitResult, ImportStore, ImportTx, Page } from './store.js';

/**
 * `ImportStore` on the M3 repositories: the import module's only database access, and the only code here that
 * needs Postgres (so `pnpm test:db` counts its coverage). The import steps themselves are in steps.ts.
 */

/** Postgres takes at most 65,535 parameters per statement; a row insert uses about ten per row. */
const INSERT_CHUNK = 1_000;
/** `instances.exportDetails` takes at most 10,000 ids. */
const DETAIL_CHUNK = 10_000;

async function chunked<T, R>(
  items: readonly T[],
  write: (chunk: T[]) => Promise<R[]>,
  size = INSERT_CHUNK,
) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await write(items.slice(i, i + size))));
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

const known = (rows: readonly (Act | Category | Department)[]) =>
  rows.map((r) => ({ name: r.name, aliases: [...r.aliases] }));

interface StoredInstance {
  row: RegisterRow;
  state: ExistingInstance;
}

/**
 * What the client already holds, by the importer's natural keys, with the stored rows behind each key so a
 * commit can link to them. Archived rows are not listed, so a re-import creates them again.
 */
interface ClientState {
  state: ExistingState;
  acts: Map<string, Act>;
  categories: Map<string, Category>;
  departments: Map<string, Department>;
  people: Map<string, Person>;
  companies: Map<string, Company>;
  locations: Map<string, Location>;
  units: Map<string, Unit>;
  obligations: Map<string, Obligation>;
  assignments: Map<string, Assignment>;
  instances: Map<string, StoredInstance>;
}

/** A referenced row's name; '' when it is archived (archived rows are not listed), so the keys differ. */
function nameOf(names: Map<string, string>, id: string): string {
  return names.get(id) ?? '';
}

function byName<T extends { name: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((r) => [r.name, r]));
}

async function loadClient(tx: TenantTx, clientId: string): Promise<ClientState> {
  // One transaction runs one query at a time, so these are sequential.
  // An import matches and creates STATUTE acts only (docs/iso/catalogue.md §2): STANDARD acts, and the obligations
  // under them, are left out of what it knows, so a register Act named like an ISO standard gets a STATUTE act.
  const listedActs = await all((p) => acts.list(tx, p));
  const standardActIds = new Set(listedActs.filter((a) => a.kind === 'STANDARD').map((a) => a.id));
  const actRows = listedActs.filter((a) => !standardActIds.has(a.id));
  const categoryRows = await all((p) => categories.list(tx, p));
  const departmentRows = await all((p) => departments.list(tx, clientId, p));
  const personRows = await all((p) => people.list(tx, p));
  const companyRows = await all((p) => companies.list(tx, clientId, p));
  const unitRows = await all((p) => units.list(tx, clientId, p));
  const locationRows = await all((p) => locations.list(tx, p));
  const obligationRows = (await all((p) => obligations.list(tx, p))).filter(
    (o) => !standardActIds.has(o.actId),
  );
  const assignmentRows = await assignments.findAll(tx, { clientId });
  const instanceRows = await all((p) => instances.register(tx, clientId, {}, p));

  const companyName = new Map(companyRows.map((c) => [c.id, c.name]));
  const locationById = new Map(locationRows.map((l) => [l.id, l]));
  const actName = new Map(actRows.map((a) => [a.id, a.name]));
  const categoryName = new Map(categoryRows.map((c) => [c.id, c.name]));
  const departmentName = new Map(departmentRows.map((d) => [d.id, d.name]));
  const personNorm = new Map(personRows.map((p) => [p.id, p.nameNormalized]));
  const unitKeyOf = new Map(
    unitRows.map((u) => [u.id, unitKey(nameOf(companyName, u.companyId), u.name)]),
  );
  const obligationById = new Map(obligationRows.map((o) => [o.id, o]));

  const result: ClientState = {
    state: {
      acts: known(actRows),
      categories: known(categoryRows),
      departments: known(departmentRows),
      people: personRows.map((p) => ({
        nameNormalized: p.nameNormalized,
        displayName: p.displayName,
      })),
      companies: companyRows.map((c) => companyKey(c.name)),
      units: [...unitKeyOf.values()],
      locations: [...new Set(unitRows.map((u) => u.locationId))]
        .map((id) => locationById.get(id))
        .filter((l): l is Location => l !== undefined)
        .map(locationKey),
      obligations: {},
      assignments: {},
      instances: {},
    },
    acts: byName(actRows),
    categories: byName(categoryRows),
    departments: byName(departmentRows),
    // A name is not unique; the first (oldest) person with it is the one an import links to.
    people: new Map([...personRows].reverse().map((p) => [p.nameNormalized, p])),
    companies: new Map(companyRows.map((c) => [companyKey(c.name), c])),
    locations: new Map(locationRows.map((l) => [locationKey(l), l])),
    units: new Map(unitRows.map((u) => [unitKeyOf.get(u.id)!, u])),
    obligations: new Map(),
    assignments: new Map(),
    instances: new Map(),
  };

  const addObligation = (o: Obligation, key: string) => {
    result.obligations.set(key, o);
    result.state.obligations[key] = fingerprintOf(o, key, actName, categoryName);
  };
  for (const o of obligationRows) {
    if (o.externalRef !== null) addObligation(o, obligationRefKey(o.externalRef));
  }

  // Assignments, and obligations without a source ID, are keyed per unit.
  const assignmentKeyOf = new Map<string, string>();
  // (unit, obligation, department) is unique among non-archived assignments.
  const assignmentIdOf = new Map(
    assignmentRows.map((a) => [`${a.unitId}|${a.obligationId}|${a.departmentId}`, a.id]),
  );
  for (const a of assignmentRows) {
    const obligation = obligationById.get(a.obligationId);
    const unit = unitKeyOf.get(a.unitId);
    if (!obligation || unit === undefined) continue;
    let obligationKey: string;
    if (obligation.externalRef === null) {
      obligationKey = obligationTitleKey(nameOf(actName, obligation.actId), obligation.title, unit);
      addObligation(obligation, obligationKey);
    } else {
      obligationKey = obligationRefKey(obligation.externalRef);
    }
    const department = nameOf(departmentName, a.departmentId);
    const key = `${unit}|${obligationKey}|${department}`;
    assignmentKeyOf.set(a.id, key);
    result.assignments.set(key, a);
    result.state.assignments[key] = fingerprintAssignment({
      key,
      unitKey: unit,
      obligationKey,
      department,
      defaultOwner: nameOf(personNorm, a.defaultOwnerId),
      defaultApprover: nameOf(personNorm, a.defaultApproverId),
      firstDueDate: a.activeFrom,
    });
  }

  const keyed: { key: string; row: RegisterRow }[] = [];
  for (const row of instanceRows) {
    const assignmentKey = assignmentKeyOf.get(
      assignmentIdOf.get(`${row.unitId}|${row.obligationId}|${row.departmentId}`) ?? '',
    );
    if (assignmentKey !== undefined) keyed.push({ key: `${assignmentKey}|${row.dueDate}`, row });
  }
  const naReason = new Map<string, string | null>();
  for (const detail of await chunked(
    keyed.map((k) => k.row.id),
    (ids) => instances.exportDetails(tx, ids),
    DETAIL_CHUNK,
  )) {
    naReason.set(detail.instanceId, detail.naReason);
  }
  for (const { key, row } of keyed) {
    const bodies =
      row.commentCount > 0
        ? (await comments.forInstance(tx, row.id)).map((c) => c.body)
        : ([] as string[]);
    const state: ExistingInstance = {
      workflowState: row.workflowState,
      completedOn: row.completedOn,
      naReason: naReason.get(row.id) ?? null,
      owner: nameOf(personNorm, row.ownerId),
      approver: nameOf(personNorm, row.approverId),
      comments: bodies,
    };
    result.instances.set(key, { row, state });
    result.state.instances[key] = state;
  }
  return result;
}

function fingerprintOf(
  o: Obligation,
  key: string,
  actName: Map<string, string>,
  categoryName: Map<string, string>,
): string {
  return fingerprintObligation(obligationShape(o, key, actName, categoryName));
}

function obligationShape(
  o: Obligation,
  key: string,
  actName: Map<string, string>,
  categoryName: Map<string, string>,
): PlanObligation {
  return {
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
  };
}

// ---------- commit ----------

/** Audit events for one commit: every row the import writes, as IMPORT by the committing person. */
class ImportAudit {
  constructor(
    private readonly tx: TenantTx,
    private readonly request: CommitRequest,
  ) {}

  async record(
    entityType: EntityType,
    entityId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    action: AuditAction = 'IMPORT',
  ): Promise<void> {
    await auditEvents.append(this.tx, {
      clientId: this.request.clientId,
      requestId: this.request.requestId,
      actorId: this.request.actorId,
      actorKind: 'PERSON',
      action,
      entityType,
      entityId,
      before,
      after: { ...after, importBatchId: this.request.batchId },
      reason: null,
    });
  }
}

/** Fields of `after` that differ from `before`, as audit before/after pairs. */
function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const was: Record<string, unknown> = {};
  const now: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(after)) {
    if (JSON.stringify(before[field]) !== JSON.stringify(value)) {
      was[field] = before[field];
      now[field] = value;
    }
  }
  return Object.keys(now).length > 0 ? { was, now } : null;
}

/** Accepted aliases on a library row: the ones the plan adds that are not stored yet. */
function newAliases(stored: readonly string[], planned: readonly string[]): string[] | null {
  const added = planned.filter((a) => !stored.includes(a));
  return added.length > 0 ? [...stored, ...added] : null;
}

/**
 * The period of each planned instance: the engine's period whose due date is the instance's (so the nightly
 * generator, idempotent on period start, sees the same period). Otherwise, or when that period start is
 * taken on the assignment, a period ending on the due date that starts on the latest free day up to it.
 */
function periodsFor(
  rule: Obligation['recurrenceRule'],
  planned: readonly PlanInstance[],
  taken: Set<string>,
  cal: Calendar,
): Map<string, { periodStart: string; periodEnd: string }> {
  // `planned` is never empty: commitPlan groups instances by assignment.
  const dates = planned.map((i) => i.dueDate).sort();
  const generated = generateInstances(rule, { from: dates[0]!, to: dates.at(-1)! }, cal);
  const byDue = new Map(generated.map((p) => [p.dueDate, p]));
  const out = new Map<string, { periodStart: string; periodEnd: string }>();
  // Engine periods first, so a fallback never takes the start an engine period needs, whatever the row order.
  const rest: PlanInstance[] = [];
  for (const instance of planned) {
    const period = byDue.get(instance.dueDate);
    if (!period || taken.has(period.periodStart)) {
      rest.push(instance);
      continue;
    }
    taken.add(period.periodStart);
    out.set(instance.key, { periodStart: period.periodStart, periodEnd: period.periodEnd });
  }
  // The rest end on their due date and start on the latest free day up to it, since a period start is unique
  // per assignment (compliance_instance_assignment_period_key).
  for (const instance of rest) {
    let periodStart = instance.dueDate;
    while (taken.has(periodStart)) periodStart = addDays(periodStart, -1);
    taken.add(periodStart);
    out.set(instance.key, { periodStart, periodEnd: instance.dueDate });
  }
  return out;
}

async function commitPlan(tx: TenantTx, request: CommitRequest): Promise<CommitResult> {
  const { plan, clientId } = request;
  const audit = new ImportAudit(tx, request);
  const stored = await loadClient(tx, clientId);
  const { settings } = await clients.require(tx, clientId);
  const cal: Calendar = {
    fyStartMonth: settings.fyStartMonth,
    holidayPolicy: settings.holidayPolicy,
  };

  // Library names, with the aliases accepted in review.
  for (const planned of plan.acts) {
    const act = stored.acts.get(planned.name);
    if (!act) {
      const created = await acts.create(tx, {
        name: planned.name,
        shortName: null,
        jurisdiction: planned.jurisdiction,
        stateCode: planned.stateCode,
        aliases: planned.aliases,
        kind: 'STATUTE',
      });
      stored.acts.set(created.name, created);
      await audit.record('act', created.id, null, { name: created.name, aliases: created.aliases });
      continue;
    }
    const aliases = newAliases(act.aliases, planned.aliases);
    if (aliases) {
      stored.acts.set(act.name, await acts.update(tx, act.id, act.version, { aliases }));
      await audit.record('act', act.id, { aliases: act.aliases }, { aliases }, 'MERGE_ALIAS');
    }
  }
  for (const planned of plan.categories) {
    const category = stored.categories.get(planned.name);
    if (!category) {
      const created = await categories.create(tx, { name: planned.name, aliases: planned.aliases });
      stored.categories.set(created.name, created);
      await audit.record('category', created.id, null, { name: created.name });
      continue;
    }
    const aliases = newAliases(category.aliases, planned.aliases);
    if (aliases) {
      const updated = await categories.update(tx, category.id, category.version, { aliases });
      stored.categories.set(category.name, updated);
      await audit.record(
        'category',
        category.id,
        { aliases: category.aliases },
        { aliases },
        'MERGE_ALIAS',
      );
    }
  }
  for (const planned of plan.departments) {
    const department = stored.departments.get(planned.name);
    if (!department) {
      const created = await departments.create(tx, {
        clientId,
        name: planned.name,
        aliases: planned.aliases,
      });
      stored.departments.set(created.name, created);
      await audit.record('department', created.id, null, { name: created.name });
      continue;
    }
    const aliases = newAliases(department.aliases, planned.aliases);
    if (aliases) {
      const updated = await departments.update(tx, department.id, department.version, {
        aliases,
      });
      stored.departments.set(department.name, updated);
      await audit.record(
        'department',
        department.id,
        { aliases: department.aliases },
        { aliases },
        'MERGE_ALIAS',
      );
    }
  }

  // People from the sheet are unclaimed until invited (their email is not in the register).
  for (const planned of plan.people) {
    if (stored.people.has(planned.nameNormalized)) continue;
    const created = await people.create(tx, {
      displayName: planned.displayName,
      nameNormalized: planned.nameNormalized,
      email: null,
      status: 'UNCLAIMED',
    });
    stored.people.set(created.nameNormalized, created);
    await audit.record('person', created.id, null, { status: created.status });
  }

  // Places.
  for (const planned of plan.companies) {
    if (stored.companies.has(planned.key)) continue;
    const created = await companies.create(tx, { clientId, name: planned.name });
    stored.companies.set(planned.key, created);
    await audit.record('company', created.id, null, { name: created.name });
  }
  for (const planned of plan.locations) {
    if (stored.locations.has(planned.key)) continue;
    const created = await locations.create(tx, {
      country: planned.country,
      countryCode: planned.countryCode,
      state: planned.state,
      stateCode: planned.stateCode,
      city: planned.city,
    });
    stored.locations.set(planned.key, created);
    await audit.record('location', created.id, null, { countryCode: created.countryCode });
  }
  for (const planned of plan.units) {
    if (stored.units.has(planned.key)) continue;
    const created = await units.create(tx, {
      clientId,
      companyId: stored.companies.get(planned.companyKey)!.id,
      name: planned.name,
      locationId: stored.locations.get(planned.locationKey)!.id,
    });
    stored.units.set(planned.key, created);
    await audit.record('unit', created.id, null, { name: created.name });
  }

  // Obligations: new ones with the inferred rule; existing ones keep their library rule.
  const actName = new Map([...stored.acts.values()].map((a) => [a.id, a.name]));
  const categoryName = new Map([...stored.categories.values()].map((c) => [c.id, c.name]));
  for (const planned of plan.obligations) {
    const fields = {
      externalRef: planned.externalRef,
      domain: planned.domain,
      jurisdiction: planned.jurisdiction,
      stateCode: planned.stateCode,
      actId: stored.acts.get(planned.act)!.id,
      categoryId: stored.categories.get(planned.category)!.id,
      title: planned.title,
      description: planned.description,
      applicabilityText: planned.applicabilityText,
      criticality: planned.criticality,
      timelineType: planned.timelineType,
      forms: planned.forms,
      logSheets: planned.logSheets,
    };
    const existing = stored.obligations.get(planned.key);
    if (!existing) {
      // The analysis infers a rule for every new obligation.
      /* v8 ignore next */
      if (!planned.recurrenceRule || !planned.ruleStatus) throw new Error('No rule to import');
      const created = await obligations.create(tx, {
        ...fields,
        recurrenceRule: planned.recurrenceRule,
        ruleStatus: planned.ruleStatus,
        evidenceRequired: false,
        libraryVersion: 1,
      });
      stored.obligations.set(planned.key, created);
      await audit.record('obligation', created.id, null, {
        externalRef: created.externalRef,
        ruleStatus: created.ruleStatus,
      });
      continue;
    }
    const before = obligationShape(existing, planned.key, actName, categoryName);
    if (fingerprintObligation(before) === fingerprintObligation(planned)) continue;
    const diff = changedFields(existing as unknown as Record<string, unknown>, fields);
    /* v8 ignore next */
    if (!diff) continue;
    const updated = await obligations.update(tx, existing.id, existing.version, fields);
    stored.obligations.set(planned.key, updated);
    await audit.record('obligation', existing.id, diff.was, diff.now);
  }

  // Assignments.
  for (const planned of plan.assignments) {
    const fields = {
      defaultOwnerId: stored.people.get(planned.defaultOwner)!.id,
      defaultApproverId: stored.people.get(planned.defaultApprover)!.id,
    };
    const existing = stored.assignments.get(planned.key);
    if (!existing) {
      const created = await assignments.create(tx, {
        clientId,
        unitId: stored.units.get(planned.unitKey)!.id,
        obligationId: stored.obligations.get(planned.obligationKey)!.id,
        departmentId: stored.departments.get(planned.department)!.id,
        ...fields,
        applicability: 'APPLICABLE',
        naReason: null,
        activeFrom: planned.firstDueDate,
        activeTo: null,
      });
      stored.assignments.set(planned.key, created);
      await audit.record('assignment', created.id, null, fields);
      continue;
    }
    const diff = changedFields(existing as unknown as Record<string, unknown>, fields);
    if (!diff) continue;
    stored.assignments.set(
      planned.key,
      await assignments.update(tx, existing.id, existing.version, fields),
    );
    await audit.record('assignment', existing.id, diff.was, diff.now);
  }

  // Instances: created in the engine's periods, or changed as the dry run found.
  const instanceIds = new Map<string, string>();
  const byAssignment = new Map<string, PlanInstance[]>();
  for (const planned of plan.instances) {
    const existing = stored.instances.get(planned.key);
    if (existing) {
      instanceIds.set(planned.key, existing.row.id);
      continue;
    }
    const list = byAssignment.get(planned.assignmentKey) ?? [];
    list.push(planned);
    byAssignment.set(planned.assignmentKey, list);
  }
  for (const [assignmentKey, planned] of byAssignment) {
    const assignment = stored.assignments.get(assignmentKey)!;
    const obligation = await obligations.require(tx, assignment.obligationId);
    const taken = new Set(
      [...stored.instances]
        .filter(([key]) => key.startsWith(`${assignmentKey}|`))
        .map(([, i]) => i.row.periodStart),
    );
    const periods = periodsFor(obligation.recurrenceRule, planned, taken, cal);
    for (const instance of planned) {
      const fields = {
        workflowState: instance.workflowState,
        completedOn: instance.completedOn,
        naReason: instance.naReason,
        ownerId: stored.people.get(instance.owner)!.id,
        approverId: stored.people.get(instance.approver)!.id,
      };
      const created = await instances.create(tx, {
        clientId,
        unitId: assignment.unitId,
        assignmentId: assignment.id,
        ...periods.get(instance.key)!,
        dueDate: instance.dueDate,
        pendingKind: null,
        submittedAt: null,
        approvedAt: null,
        dueDateOverridden: false,
        ...fields,
      } as Parameters<typeof instances.create>[1]);
      instanceIds.set(instance.key, created.id);
      await audit.record('instance', created.id, null, fields);
      for (const body of instance.comments) {
        await comments.create(tx, {
          instanceId: created.id,
          clientId,
          authorId: null,
          kind: 'IMPORT',
          body,
        });
      }
    }
  }

  for (const [key, change] of request.instanceChanges) {
    const existing = stored.instances.get(key)!;
    const patch: Record<string, unknown> = { ...(change.state ?? {}) };
    if (change.owner !== null) patch.ownerId = stored.people.get(change.owner)!.id;
    if (change.approver !== null) patch.approverId = stored.people.get(change.approver)!.id;
    if (change.state) patch.pendingKind = null;
    const diff = changedFields(
      { ...existing.row, naReason: existing.state.naReason } as unknown as Record<string, unknown>,
      patch,
    );
    if (diff) {
      await instances.update(tx, existing.row.id, existing.row.version, patch as never);
      await audit.record('instance', existing.row.id, diff.was, diff.now);
    }
    for (const body of change.newComments) {
      await comments.create(tx, {
        instanceId: existing.row.id,
        clientId,
        authorId: null,
        kind: 'IMPORT',
        body,
      });
    }
    if (change.newComments.length > 0) {
      await audit.record('instance', existing.row.id, null, {
        commentsAdded: change.newComments.length,
      });
    }
  }
  return { instanceIds };
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
    existingState: async (clientId) => (await loadClient(tx, clientId)).state,
    async planAllowance(limit) {
      await account.lockUsage(tx);
      const view = await account.get(tx);
      return { max: view.entitlements.limits[limit], used: view.usage[limit] };
    },
    commit: (request) => commitPlan(tx, request),
  };
}

export function repositoryStore(db: Database): ImportStore {
  return { transaction: (ctx, fn) => db.withTenant(ctx, (tx) => fn(importTx(tx))) };
}
