import {
  DocumentStatus,
  ReviewInputKey,
  ReviewOutputKey,
  type IsoAction,
  type IsoActionSubjectType,
  type LocalDate,
} from '@canopy/contracts';
import {
  assignments,
  auditChecklistItems,
  auditFindings,
  auditProgrammes,
  certifications,
  clauseAssessments,
  contextItems,
  controlledDocuments,
  documentRevisions,
  externalAudits,
  instances,
  internalAudits,
  isoActions,
  isoCatalogue,
  isoFiles,
  isoFileSubject,
  isoVisibleIds,
  managementReviews,
  managementSystems,
  MAX_LIMIT,
  nonconformities,
  objectiveReadings,
  objectives,
  obligations,
  people,
  reviewFigures,
  reviewInputs,
  reviewOutputs,
  riskControls,
  riskItems,
  units,
  type FigureRefs,
  type IsoPage,
  type TenantTx,
} from '@canopy/db';
import { localDateIn, reviewInputFigures } from '@canopy/engine';
import type {
  IsoArchive,
  IsoAuditBook,
  IsoFigureRef,
  IsoNames,
  IsoNcBook,
  IsoNcFilter,
  IsoRecordSheet,
  IsoReviewBook,
  IsoRiskBook,
  IsoRiskFilter,
} from '../dashboard/ports.js';
import { codeWords, findingTypeWords, shortText } from './iso-words.js';

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
  const unitRows = await allPages((cursor) =>
    units.list(tx, clientId, { includeArchived: true, limit: MAX_LIMIT, cursor }),
  );
  const systems = await allPages((cursor) =>
    managementSystems.list(tx, clientId, { includeArchived: true, limit: MAX_LIMIT, cursor }),
  );
  const standards = new Map(
    (await isoCatalogue.standards(tx)).map((st) => [st.id, standardWords(st.code)]),
  );
  // The account's live standards' clauses: a record's clause of a standard archived since prints no name.
  const clauses = await isoCatalogue.clauses(tx, { standardIds: [...standards.keys()] });
  return {
    people: new Map(persons.map((p) => [p.id, p.displayName])),
    units: new Map(unitRows.map((u) => [u.id, u.name])),
    systems: new Map(systems.map((m) => [m.id, m.name])),
    clauses: new Map(clauses.map((c) => [c.id, `${standards.get(c.standardId)!} ${c.number}`])),
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

export async function isoAuditBook(
  tx: TenantTx,
  clientId: string,
  id: string,
  scope: IsoNcFilter['scope'],
): Promise<IsoAuditBook | null> {
  const [audit] = (await internalAudits.list(tx, clientId, { ids: [id], scope: scopeOf(scope) }))
    .items;
  if (audit === undefined) return null;
  const programme = await auditProgrammes.require(tx, audit.programmeId);
  const checklist = await auditChecklistItems.forAudit(tx, audit.id);
  const findings = await auditFindings.forAudit(tx, { internalAuditId: audit.id });
  const ncNumbers = new Map<string, number>();
  for (const finding of findings) {
    if (finding.nonconformityId === null) continue;
    const nc = await nonconformities.require(tx, finding.nonconformityId);
    ncNumbers.set(nc.id, nc.number);
  }
  const actions = await actionsOf(
    tx,
    clientId,
    'AUDIT_FINDING',
    new Set(findings.map((f) => f.id)),
  );
  const names = await namesOf(tx, clientId, {
    people: [
      audit.leadAuditorId,
      ...audit.auditorIds,
      ...audit.auditeeIds,
      ...audit.reportedToIds,
      ...actions.map((a) => a.ownerId),
    ],
  });
  return { audit, programme, checklist, findings, ncNumbers, actions, names };
}

export async function isoReviewBook(
  tx: TenantTx,
  clientId: string,
  id: string,
  scope: IsoNcFilter['scope'],
  day: { today: LocalDate; timeZone: string } | null,
): Promise<IsoReviewBook | null> {
  const review = await managementReviews.get(tx, id);
  if (review === null || review.clientId !== clientId || review.archivedAt !== null) return null;
  if (scope !== null) {
    // M3's list applies plan §3.3 for reviews: the system's units, or the chair or an attendee.
    const readable = await allPages((cursor) =>
      managementReviews.list(tx, clientId, {
        managementSystemIds: [review.managementSystemId],
        scope: scopeOf(scope),
        limit: MAX_LIMIT,
        cursor,
      }),
    );
    if (!readable.some((r) => r.id === review.id)) return null;
  }
  const standards = new Map(
    (await isoCatalogue.standards(tx)).map((st) => [st.id, standardWords(st.code)]),
  );
  const defs = await isoCatalogue.reviewDefs(tx);
  const inputDefs = new Map(defs.inputs.map((d) => [d.id, d]));
  const outputDefs = new Map(defs.outputs.map((d) => [d.id, d]));
  const clause = (d: { standardId: string; clauseNumber: string; item: string | null }) =>
    `${standards.get(d.standardId)!} ${d.clauseNumber}${d.item === null ? '' : ` ${d.item}`}`;
  const inputs = [];
  for (const row of await reviewInputs.forReview(tx, review.id)) {
    const def = inputDefs.get(row.inputDefId)!;
    let figures = null;
    if (def.source === 'MANUAL' || review.state === 'CANCELLED') {
      figures = null;
    } else if (review.state !== 'PLANNED') {
      figures = row.sourceFigures;
    } else if (day !== null) {
      // The whole system, as of the pack's day (model §3.13 item 4, §5.4); M16's screen computes the same.
      const gathered = await reviewFigures.gather(tx, review, def, day.today, (instant) =>
        localDateIn(instant, day.timeZone),
      );
      figures = reviewInputFigures(
        gathered.source,
        gathered.data as never,
        gathered.since,
        day.today,
      );
    }
    inputs.push({ row, def, clause: clause(def), figures });
  }
  const outputs = (await reviewOutputs.forReview(tx, review.id)).map((row) => {
    const def = outputDefs.get(row.outputDefId)!;
    return { row, def, clause: clause(def) };
  });
  const inputOrder: readonly string[] = ReviewInputKey.options;
  const outputOrder: readonly string[] = ReviewOutputKey.options;
  inputs.sort((a, b) => inputOrder.indexOf(a.def.key) - inputOrder.indexOf(b.def.key));
  outputs.sort((a, b) => outputOrder.indexOf(a.def.key) - outputOrder.indexOf(b.def.key));
  const actions = await actionsOf(tx, clientId, 'MANAGEMENT_REVIEW', new Set([review.id]));
  const names = await namesOf(tx, clientId, {
    people: [review.chairId, ...review.attendeeIds, ...actions.map((a) => a.ownerId)],
  });
  return { review, inputs, outputs, actions, names };
}

/**
 * A short reference for one record of a figure's table. `isoVisibleIds` has just found it among the client's rows,
 * archived ones included, so it exists.
 */
const LABELS: Record<string, (tx: TenantTx, id: string) => Promise<string>> = {
  nonconformity: async (tx, id) => `NC ${(await nonconformities.require(tx, id)).number}`,
  iso_action: async (tx, id) => shortText((await isoActions.require(tx, id)).text),
  risk_item: async (tx, id) => {
    const item = await riskItems.require(tx, id);
    return shortText(`${item.activity}: ${item.description}`);
  },
  objective: async (tx, id) => shortText((await objectives.require(tx, id)).text),
  objective_reading: async (tx, id) => {
    const reading = await objectiveReadings.require(tx, id);
    const objective = await objectives.require(tx, reading.objectiveId);
    return shortText(`${objective.text}, reading to ${reading.periodEnd}`);
  },
  internal_audit: async (tx, id) => shortText((await internalAudits.require(tx, id)).title),
  external_audit: async (tx, id) => {
    const audit = await externalAudits.require(tx, id);
    return shortText(`${audit.body} ${codeWords(audit.type)} ${audit.startOn}`);
  },
  audit_finding: async (tx, id) => {
    const finding = await auditFindings.require(tx, id);
    return shortText(`${findingTypeWords(finding.type)}: ${finding.description}`);
  },
  context_item: async (tx, id) => shortText((await contextItems.require(tx, id)).text),
  management_system: async (tx, id) => (await managementSystems.require(tx, id)).name,
  instance: async (tx, id) => {
    const instance = await instances.require(tx, id);
    const assignment = await assignments.require(tx, instance.assignmentId);
    const obligation = await obligations.require(tx, assignment.obligationId);
    return shortText(`${obligation.title}, due ${instance.dueDate}`);
  },
};

export async function isoFigureReferences(
  tx: TenantTx,
  clientId: string,
  refs: readonly IsoFigureRef[],
  scope: IsoNcFilter['scope'],
): Promise<{ visible: string[][]; labels: ReadonlyMap<string, string> }> {
  const visible: string[][] = [];
  // `isoVisibleIds` takes at most 100 refs a call.
  for (let i = 0; i < refs.length; i += 100) {
    const batch = refs.slice(i, i + 100).map((r) => ({ table: r.table, ids: [...r.ids] }));
    const found = await isoVisibleIds(tx, clientId, batch as FigureRefs, scopeOf(scope));
    visible.push(...found.map((f) => f.ids));
  }
  const labels = new Map<string, string>();
  for (const [at, ref] of refs.entries()) {
    for (const id of visible[at]!) {
      if (!labels.has(id)) labels.set(id, await LABELS[ref.table]!(tx, id));
    }
  }
  return { visible, labels };
}

/** Ids a row names (`ownerId`, `attendeeIds`, …): the candidates for its people's names. */
function namedIds(rows: readonly Readonly<Record<string, unknown>>[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (key.endsWith('Id') && typeof value === 'string') out.add(value);
      if (key.endsWith('Ids') && Array.isArray(value)) {
        for (const id of value) if (typeof id === 'string') out.add(id);
      }
    }
  }
  return out;
}

/**
 * The client archive's ISO records (docs/iso/model.md §9): every record of the client other than NCs and risk items,
 * archived ones included where M3's list can include them, with no unit scope (only an account admin makes the
 * archive); each review input with its stored figures, never computed; and the live files.
 */
export async function isoArchive(tx: TenantTx, clientId: string): Promise<IsoArchive> {
  const page = { includeArchived: true, limit: MAX_LIMIT } as const;
  const systems = await allPages((cursor) =>
    managementSystems.list(tx, clientId, { ...page, cursor }),
  );
  const context = [];
  const checklist = [];
  const programmes = [];
  for (const system of systems) {
    context.push(...(await contextItems.list(tx, system.id, { includeArchived: true })));
    checklist.push(...(await clauseAssessments.list(tx, system.id)));
    programmes.push(...(await auditProgrammes.list(tx, system.id, { includeArchived: true })));
  }
  const documents = await allPages((cursor) =>
    controlledDocuments.list(tx, clientId, {
      ...page,
      status: [...DocumentStatus.options],
      cursor,
    }),
  );
  const revisions = [];
  for (const document of documents) {
    revisions.push(...(await documentRevisions.forDocument(tx, document.id)));
  }
  const goals = await allPages((cursor) => objectives.list(tx, clientId, { ...page, cursor }));
  const readings = [];
  for (const goal of goals) readings.push(...(await objectiveReadings.forObjective(tx, goal.id)));
  const audits = await allPages((cursor) => internalAudits.list(tx, clientId, { ...page, cursor }));
  const auditRows = [];
  for (const audit of audits) auditRows.push(...(await auditChecklistItems.forAudit(tx, audit.id)));
  const reviews = await allPages((cursor) =>
    managementReviews.list(tx, clientId, { ...page, cursor }),
  );
  const defs = await isoCatalogue.reviewDefs(tx);
  const inputKeys = new Map(defs.inputs.map((d) => [d.id, d.key]));
  const inputs = [];
  const outputs = [];
  for (const review of reviews) {
    inputs.push(...(await reviewInputs.forReview(tx, review.id)));
    outputs.push(...(await reviewOutputs.forReview(tx, review.id)));
  }
  const sheets: IsoRecordSheet[] = [
    { name: 'Management systems', rows: systems },
    { name: 'Context items', rows: context },
    { name: 'Clause checklist', rows: checklist },
    { name: 'Documents', rows: documents },
    { name: 'Document revisions', rows: revisions },
    {
      name: 'Certifications',
      rows: await allPages((cursor) => certifications.list(tx, clientId, { ...page, cursor })),
    },
    {
      name: 'External audits',
      rows: await allPages((cursor) => externalAudits.list(tx, clientId, { ...page, cursor })),
    },
    { name: 'Objectives', rows: goals },
    { name: 'Objective readings', rows: readings },
    { name: 'Audit programmes', rows: programmes },
    { name: 'Internal audits', rows: audits },
    { name: 'Audit checklists', rows: auditRows },
    {
      name: 'Audit findings',
      rows: await allPages((cursor) => auditFindings.list(tx, clientId, { ...page, cursor })),
    },
    {
      name: 'Actions',
      rows: await allPages((cursor) => isoActions.list(tx, clientId, { ...page, cursor })),
    },
    { name: 'Management reviews', rows: reviews },
    // The stored figures go on their own sheet, one row per figure and id.
    { name: 'Review inputs', rows: inputs.map(({ sourceFigures: _, ...row }) => row) },
    { name: 'Review outputs', rows: outputs },
  ];
  const names = await namesOf(tx, clientId, {
    people: sheets.flatMap((sheet) => [...namedIds(sheet.rows)]),
  });
  const { clean, withheld } = await isoFiles.cleanForClient(tx, clientId);
  return {
    sheets,
    reviewInputs: inputs.map((row) => ({ row, key: inputKeys.get(row.inputDefId) ?? null })),
    names,
    files: {
      clean: clean.map((file) => {
        const subject = isoFileSubject(file);
        return {
          id: file.id,
          subjectType: subject.type,
          subjectId: subject.id,
          fileName: file.fileName,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          uploadedAt: file.createdAt,
          storageKey: file.storageKey,
        };
      }),
      withheld,
    },
  };
}
