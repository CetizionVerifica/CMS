// M8 endpoints. The mock never reads the uploaded bytes: every upload behaves like the sample register, with rows
// built from firm A's fixture (people already pseudonymised) and the issue groups fixtures.md §3 describes.
// Commit marks the batch COMMITTED but does not write register data.
import { IMPORT_ISSUE_SEVERITY, type CanopyField, type ImportIssueType } from '../../enums.js';
import { loadFixtureSet } from '../../fixtures/index.js';
import type { ColumnMapping } from '../../schemas/import.js';
import {
  audit,
  type Actor,
  checkVersion,
  fileUrl,
  fresh,
  MockError,
  notFound,
  paginate,
  touch,
} from '../core.js';
import { actorOf, type EndpointId, type HandlerContext, type PartialHandlers } from '../handler.js';
import type { FirmData, FirmState, ImportState } from '../store.js';
import type { z } from 'zod';
import { SIGNED_URL_TTL_SECONDS } from '../../api/common.js';

type Ctx = HandlerContext<EndpointId>;
type Status = ImportState['batch']['status'];

export const SAMPLE_SHEET = 'ASPxGridView1';

/** The sample register's columns and the field each maps to. */
export const SAMPLE_COLUMNS: [string, CanopyField][] = [
  ['EY Compliance ID', 'externalRef'],
  ['Compliance Title', 'title'],
  ['Type (TimeLine)', 'timelineType'],
  ['Compliance Description', 'description'],
  ['Compliance Categorization', 'category'],
  ['Applicability', 'applicabilityText'],
  ['Act', 'act'],
  ['Activity Date', 'completedOn'],
  ['Compliance Status', 'status'],
  ['Due Date', 'dueDate'],
  ['Form Description', 'forms'],
  ['Log Sheet Description', 'logSheets'],
  ['Organization', 'organizationPath'],
  ['Location', 'locationPath'],
  ['Owner', 'owner'],
  ['Owner Comments', 'ownerComment'],
  ['Approvers', 'approver'],
  ['Department', 'department'],
  ['Criticality', 'criticality'],
];
const SUGGESTED: z.input<typeof ColumnMapping> = SAMPLE_COLUMNS.map(([sourceHeader, field]) => ({
  sourceHeader,
  field,
}));

const STATUS_TEXT = {
  APPROVED: 'Complied',
  OPEN: 'Pending',
  NOT_APPLICABLE: 'Not Applicable',
  SUBMITTED: 'Pending',
  SENT_BACK: 'Pending',
};
const CRITICALITY_TEXT = {
  SUPER_CRITICAL: 'Super Critical',
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};
const TIMELINE_TEXT = { TIME_BASED: 'Time Based', ONGOING: 'On Going' };

let sampleCache: FirmData | undefined;
const sample = () => (sampleCache ??= loadFixtureSet('firm-a.sample') as FirmData);

/** One source row per firm A instance, keyed by header, as the importer would read them. */
function sampleRows(): Record<string, string | null>[] {
  const d = sample();
  const by = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const [assignments, obligations, acts, categories, departments, people] = [
    by(d.assignments),
    by(d.obligations),
    by(d.acts),
    by(d.categories),
    by(d.departments),
    by(d.people),
  ];
  const comments = new Map(d.comments.map((c) => [c.instanceId, c.body]));
  const organisation = `${d.clients[0]!.name}/ ${d.companies[0]!.name}/ ${d.units[0]!.name}`;
  const location = d.locations[0]!;
  const site = `${location.country}/ ${location.state}/ ${location.city}`;
  return d.instances.map((i) => {
    const assignment = assignments.get(i.assignmentId)!;
    const o = obligations.get(assignment.obligationId)!;
    return {
      'EY Compliance ID': o.externalRef,
      'Compliance Title': o.title,
      'Type (TimeLine)': TIMELINE_TEXT[o.timelineType],
      'Compliance Description': o.description,
      'Compliance Categorization': categories.get(o.categoryId)!.name,
      Applicability: o.applicabilityText,
      Act: acts.get(o.actId)!.name,
      'Activity Date': i.completedOn,
      'Compliance Status': STATUS_TEXT[i.workflowState],
      'Due Date': i.dueDate,
      'Form Description': o.forms[0]?.label ?? 'NA',
      'Log Sheet Description': o.logSheets[0]?.label ?? 'NA',
      Organization: organisation,
      Location: site,
      Owner: people.get(i.ownerId)!.displayName,
      'Owner Comments': comments.get(i.id) ?? null,
      Approvers: people.get(i.approverId)!.displayName,
      Department: departments.get(assignment.departmentId)!.name,
      Criticality: CRITICALITY_TEXT[o.criticality],
    };
  });
}

interface IssueSpec {
  type: ImportIssueType;
  key: string;
  field: CanopyField | null;
  rawValues: string[];
  proposal: string | null;
  rows: (row: Record<string, string | null>) => boolean;
}

const refIn = (refs: string[]) => (row: Record<string, string | null>) =>
  refs.includes(row['EY Compliance ID']!);
const PETROLEUM = 'Petroleum Act, 1934 read with Petroleum Rules 2002';

/** The issue groups fixtures.md §3 finds in the sample (person-name issues are left out: names are pseudonyms). */
const SAMPLE_ISSUES: IssueSpec[] = [
  {
    type: 'ALIAS_DEPARTMENT',
    key: 'hr',
    field: 'department',
    rawValues: ['HR', 'Human Resources'],
    proposal: 'Human Resources',
    rows: (r) => r.Department === 'Human Resources',
  },
  {
    type: 'ALIAS_CATEGORY',
    key: 'procedural',
    field: 'category',
    rawValues: ['Procedural Requirements', 'Procedural Requirement'],
    proposal: 'Procedural Requirement',
    rows: (r) => r['Compliance Categorization'] === 'Procedural Requirement',
  },
  {
    type: 'ALIAS_CATEGORY',
    key: 'statutory-records',
    field: 'category',
    rawValues: ['Statutory Registers and Records', 'Statutory Records'],
    proposal: 'Statutory Records',
    rows: (r) => r['Compliance Categorization'] === 'Statutory Records',
  },
  {
    type: 'ALIAS_ACT',
    key: 'petroleum',
    field: 'act',
    rawValues: [
      PETROLEUM,
      'The Petroleum Act, 1934 and Petroleum Rules, 2002',
      'The Petroleum Act, 1934 and Petroleum Rules, 2003',
      'The Petroleum Act, 1934 and Petroleum Rules, 2005',
    ],
    proposal: PETROLEUM,
    rows: (r) => r.Act === PETROLEUM,
  },
  {
    type: 'ALIAS_ACT',
    key: 'factories',
    field: 'act',
    rawValues: [
      'Factories Act , 1948',
      'Factories Act, 1948 and West Bengal Factories Rules, 1958',
    ],
    proposal: null,
    rows: (r) => r.Act?.startsWith('Factories Act') === true,
  },
  {
    type: 'ENUM_NORMALISED',
    key: 'criticality-high',
    field: 'criticality',
    rawValues: ['HIGH'],
    proposal: 'High',
    rows: (r) => r.Criticality === 'High',
  },
  {
    type: 'DUPLICATE_PERIOD',
    key: 'HRS-CL-014-3059-30387',
    field: 'dueDate',
    rawValues: ['2022-04-30'],
    proposal: 'Keep the first row; add the other as an import comment',
    rows: refIn(['HRS-CL-014-3059-30387']),
  },
  {
    type: 'DUPLICATE_PERIOD',
    key: 'HRS-CL-005-3174-30354',
    field: 'dueDate',
    rawValues: ['2022-04-30'],
    proposal: 'Keep the first row; add the other as an import comment',
    rows: refIn(['HRS-CL-005-3174-30354']),
  },
  {
    type: 'COMPLIED_WITHOUT_DATE',
    key: 'ENV-117-0031',
    field: 'completedOn',
    rawValues: [''],
    proposal: '2022-09-30',
    rows: refIn(['ENV-117-0031']),
  },
  {
    type: 'UNPARSED_EXTERNAL_REF',
    key: 'non-standard',
    field: 'externalRef',
    rawValues: [
      'ENV-117-0031',
      'INT-FA-1-1',
      'INT-H-047-0016',
      'INT-H-048-0002',
      'INT-H-050-0002',
      'INT-H-056-0001',
    ],
    proposal: null,
    rows: refIn([
      'ENV-117-0031',
      'INT-FA-1-1',
      'INT-H-047-0016',
      'INT-H-048-0002',
      'INT-H-050-0002',
      'INT-H-056-0001',
    ]),
  },
  {
    type: 'NULL_PLACEHOLDER',
    key: 'forms',
    field: 'forms',
    rawValues: ['NA', 'null'],
    proposal: null,
    rows: (r) => r['Form Description'] === 'NA',
  },
];

function findBatch(actor: Actor, id: string | undefined): ImportState {
  const state = actor.firm.imports.find((s) => s.batch.id === id);
  if (state === undefined) throw notFound();
  return state;
}

function requireStatus(state: ImportState, expected: Status[]): void {
  if (!expected.includes(state.batch.status)) {
    throw new MockError('IMPORT_STATE', `Import is ${state.batch.status}`, {
      status: state.batch.status,
      expected,
    });
  }
}

function setStatus(ctx: Ctx, state: ImportState, status: Status): void {
  state.batch.status = status;
  touch(state.batch, ctx.clock);
}

type Group = ReturnType<typeof groups>[number];

function groups(state: ImportState) {
  return state.issues.map((issue) => ({
    groupKey: issue.groupKey,
    type: issue.type,
    severity: issue.severity,
    field: issue.field,
    rawValues: issue.rawValues,
    proposal: issue.proposal,
    decision: issue.decision,
    editedValue: issue.editedValue,
    rowNumbers: issue.rowNumbers,
    issueIds: [issue.id],
  }));
}

/** ERROR issues and undecided WARNING issues block the commit. */
const blocking = (state: ImportState) =>
  state.issues.filter(
    (i) => i.severity === 'ERROR' || (i.severity === 'WARNING' && i.decision === 'PENDING'),
  );

function dryRun(firm: FirmState, clientId: string, state: ImportState) {
  const d = firm.data;
  const src = sample();
  const names = (rows: { name: string; archivedAt: string | null }[]) =>
    new Set(rows.filter((r) => r.archivedAt === null).map((r) => r.name));
  const newCount = (source: { name: string }[], existing: Set<string>) =>
    source.filter((r) => !existing.has(r.name)).length;
  const refs = new Map(
    d.obligations.filter((o) => o.archivedAt === null).map((o) => [o.externalRef, o.id]),
  );
  const assignmentByObligation = new Map(
    d.assignments
      .filter((a) => a.clientId === clientId && a.archivedAt === null)
      .map((a) => [a.obligationId, a.id]),
  );
  const existingInstances = new Set(
    d.instances.filter((i) => i.clientId === clientId).map((i) => `${i.assignmentId}|${i.dueDate}`),
  );
  let unchanged = 0;
  state.rows.forEach((row) => {
    const obligationId = refs.get(String(row.raw['EY Compliance ID']));
    const assignmentId =
      obligationId === undefined ? undefined : assignmentByObligation.get(obligationId);
    const same =
      assignmentId !== undefined && existingInstances.has(`${assignmentId}|${row.raw['Due Date']}`);
    row.outcome = same ? 'UNCHANGED' : 'CREATE';
    if (same) unchanged += 1;
  });
  const people = new Set(
    d.people.filter((p) => p.archivedAt === null).map((p) => p.nameNormalized),
  );
  const newObligations = src.obligations.filter((o) => !refs.has(o.externalRef)).length;
  const newAssignments = src.obligations.filter((o) => {
    const id = refs.get(o.externalRef);
    return id === undefined || !assignmentByObligation.has(id);
  }).length;
  const clientRows = <T extends { clientId: string; name: string; archivedAt: string | null }>(
    rows: T[],
  ) => names(rows.filter((r) => r.clientId === clientId));
  return {
    create: {
      acts: newCount(src.acts, names(d.acts)),
      categories: newCount(src.categories, names(d.categories)),
      departments: newCount(src.departments, clientRows(d.departments)),
      people: src.people.filter((p) => p.email === null && !people.has(p.nameNormalized)).length,
      obligations: newObligations,
      assignments: newAssignments,
      instances: state.rows.length - unchanged,
      companies: newCount(src.companies, clientRows(d.companies)),
      units: newCount(src.units, clientRows(d.units)),
      locations: d.locations.some((l) => l.city === sample().locations[0]!.city) ? 0 : 1,
    },
    update: { obligations: 0, assignments: 0, instances: 0 },
    unchanged: { instances: unchanged },
    skippedRows: 0,
    blockingErrors: 0,
  };
}

export const importHandlers: PartialHandlers<
  | 'createImport'
  | 'importUploaded'
  | 'putImportMapping'
  | 'parseImport'
  | 'getImport'
  | 'listImportIssues'
  | 'decideImportIssue'
  | 'listImportRows'
  | 'dryRunImport'
  | 'commitImport'
  | 'cancelImport'
  | 'listImports'
  | 'listMappingTemplates'
  | 'createMappingTemplate'
  | 'updateMappingTemplate'
> = {
  createImport(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const batchId = ctx.store.newId();
    actor.firm.pendingImports.set(batchId, {
      clientId,
      fileName: ctx.body.fileName,
      createdById: actor.person.id,
    });
    return {
      batchId,
      url: fileUrl(`imports/${batchId}`),
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      expiresAt: new Date(Date.parse(ctx.clock.now()) + SIGNED_URL_TTL_SECONDS * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
    };
  },

  importUploaded(ctx) {
    const actor = actorOf(ctx);
    const pending = actor.firm.pendingImports.get(ctx.params.id!);
    if (pending === undefined) throw notFound();
    ctx.authorize({ clientId: pending.clientId });
    actor.firm.pendingImports.delete(ctx.params.id!);
    const base = fresh(ctx, actor.firm.data.firm.id);
    const batch = {
      ...base,
      id: ctx.params.id!,
      clientId: pending.clientId,
      createdById: pending.createdById,
      status: 'UPLOADED' as const,
      fileName: pending.fileName,
      fileSha256: ctx.body.sha256,
      sheetName: null,
      mapping: null,
      mappingTemplateId: null,
      counts: null,
      dryRun: null,
      committedAt: null,
      failureCode: null,
    };
    actor.firm.imports.push({ batch, rows: [], issues: [] });
    const headers = SAMPLE_COLUMNS.map(([h]) => h);
    const template = actor.firm.mappingTemplates.find(
      (t) =>
        t.archivedAt === null &&
        (t.clientId === null || t.clientId === pending.clientId) &&
        t.mapping
          .map((m) => m.sourceHeader)
          .sort()
          .join('|') === [...headers].sort().join('|'),
    );
    return {
      batch,
      sheets: [{ name: SAMPLE_SHEET, headers, rowCount: sample().instances.length }],
      suggestedMapping: template?.mapping ?? SUGGESTED,
      suggestedTemplateId: template?.id ?? null,
    };
  },

  putImportMapping(ctx) {
    const actor = actorOf(ctx);
    const state = findBatch(actor, ctx.params.id);
    ctx.authorize({ clientId: state.batch.clientId });
    requireStatus(state, ['UPLOADED', 'MAPPED']);
    if (ctx.body.sheetName !== SAMPLE_SHEET) {
      throw new MockError('VALIDATION', 'Unknown sheet', {
        issues: [{ path: ['sheetName'], message: `The workbook has one sheet, "${SAMPLE_SHEET}"` }],
      });
    }
    Object.assign(state.batch, { sheetName: ctx.body.sheetName, mapping: ctx.body.mapping });
    if (ctx.body.saveAsTemplate !== undefined) {
      const template = {
        ...fresh(ctx, actor.firm.data.firm.id),
        clientId: ctx.body.saveAsTemplate.scope === 'FIRM' ? null : state.batch.clientId,
        name: ctx.body.saveAsTemplate.name,
        mapping: ctx.body.mapping,
      };
      actor.firm.mappingTemplates.push(template);
      state.batch.mappingTemplateId = template.id;
    }
    setStatus(ctx, state, 'MAPPED');
    return state.batch;
  },

  parseImport(ctx) {
    const actor = actorOf(ctx);
    const state = findBatch(actor, ctx.params.id);
    ctx.authorize({ clientId: state.batch.clientId });
    requireStatus(state, ['MAPPED']);
    const mapping = new Map((state.batch.mapping ?? []).map((m) => [m.sourceHeader, m.field]));
    const raws = sampleRows();
    state.rows = raws.map((raw, n) => ({
      id: ctx.store.newId(),
      batchId: state.batch.id,
      rowNumber: n + 2,
      raw,
      mapped: Object.fromEntries(
        Object.entries(raw).flatMap(([header, value]) => {
          const field = mapping.get(header);
          return field === undefined || field === null ? [] : [[field, value]];
        }),
      ),
      issueIds: [],
      outcome: 'PENDING' as const,
      targetInstanceId: null,
    }));
    state.issues = SAMPLE_ISSUES.map((spec) => {
      const id = ctx.store.newId();
      const rowNumbers = state.rows
        .filter((r) => spec.rows(raws[r.rowNumber - 2]!))
        .map((r) => r.rowNumber);
      for (const row of state.rows) if (rowNumbers.includes(row.rowNumber)) row.issueIds.push(id);
      return {
        id,
        batchId: state.batch.id,
        groupKey: `${spec.type}:${spec.key}`,
        type: spec.type,
        severity: IMPORT_ISSUE_SEVERITY[spec.type],
        rowNumbers: rowNumbers.length > 0 ? rowNumbers : [2],
        field: spec.field,
        rawValues: spec.rawValues,
        proposal: spec.proposal,
        decision: 'PENDING' as const,
        editedValue: null,
      };
    });
    const count = (severity: string) => state.issues.filter((i) => i.severity === severity).length;
    state.batch.counts = {
      rows: state.rows.length,
      errors: count('ERROR'),
      warnings: count('WARNING'),
      infos: count('INFO'),
    };
    setStatus(ctx, state, 'PARSED');
    return state.batch;
  },

  getImport(ctx) {
    const state = findBatch(actorOf(ctx), ctx.params.id);
    ctx.authorize({ clientId: state.batch.clientId });
    return state.batch;
  },

  listImportIssues(ctx) {
    const state = findBatch(actorOf(ctx), ctx.params.id);
    ctx.authorize({ clientId: state.batch.clientId });
    const q = ctx.query;
    const inList = <T>(list: T[] | undefined, value: T) =>
      list === undefined || list.includes(value);
    return {
      items: groups(state).filter(
        (g: Group) =>
          inList(q.type, g.type) &&
          inList(q.severity, g.severity) &&
          inList(q.decision, g.decision),
      ),
    };
  },

  decideImportIssue(ctx) {
    const state = findBatch(actorOf(ctx), ctx.params.id);
    ctx.authorize({ clientId: state.batch.clientId });
    // Deciding after a dry run sends the batch back for a fresh dry run.
    requireStatus(state, ['PARSED', 'REVIEWED', 'DRY_RUN_READY']);
    const issues = state.issues.filter((i) => i.groupKey === ctx.params.groupKey);
    if (issues.length === 0) throw notFound();
    for (const issue of issues) {
      issue.decision = ctx.body.decision;
      issue.editedValue = ctx.body.editedValue ?? null;
    }
    setStatus(ctx, state, blocking(state).length === 0 ? 'REVIEWED' : 'PARSED');
    return groups(state).find((g) => g.groupKey === ctx.params.groupKey)!;
  },

  listImportRows(ctx) {
    const state = findBatch(actorOf(ctx), ctx.params.id);
    ctx.authorize({ clientId: state.batch.clientId });
    const q = ctx.query;
    const typesById = new Map(state.issues.map((i) => [i.id, i.type]));
    const rows = state.rows.filter(
      (r) =>
        (q.outcome === undefined || q.outcome.includes(r.outcome)) &&
        (q.issueType === undefined ||
          r.issueIds.some((id) => q.issueType!.includes(typesById.get(id)!))),
    );
    return paginate(rows, q);
  },

  dryRunImport(ctx) {
    const actor = actorOf(ctx);
    const state = findBatch(actor, ctx.params.id);
    ctx.authorize({ clientId: state.batch.clientId });
    requireStatus(state, ['PARSED', 'REVIEWED', 'DRY_RUN_READY']);
    state.batch.dryRun = dryRun(actor.firm, state.batch.clientId, state);
    setStatus(ctx, state, 'DRY_RUN_READY');
    return state.batch.dryRun;
  },

  commitImport(ctx) {
    const actor = actorOf(ctx);
    const state = findBatch(actor, ctx.params.id);
    ctx.authorize({ clientId: state.batch.clientId });
    // Commit is idempotent: committing a committed batch returns it unchanged.
    if (state.batch.status === 'COMMITTED') return state.batch;
    requireStatus(state, ['DRY_RUN_READY']);
    const blockers = blocking(state);
    if (blockers.length > 0) {
      throw new MockError('IMPORT_BLOCKED', 'Decide every blocking issue before committing', {
        blockingIssueIds: blockers.map((i) => i.id),
      });
    }
    state.batch.committedAt = ctx.clock.now();
    setStatus(ctx, state, 'COMMITTED');
    audit(ctx, actor, {
      action: 'IMPORT',
      entityType: 'import_batch',
      entityId: state.batch.id,
      clientId: state.batch.clientId,
      after: { rows: state.rows.length },
    });
    return state.batch;
  },

  cancelImport(ctx) {
    const state = findBatch(actorOf(ctx), ctx.params.id);
    ctx.authorize({ clientId: state.batch.clientId });
    requireStatus(state, ['UPLOADED', 'MAPPED', 'PARSED', 'REVIEWED', 'DRY_RUN_READY', 'FAILED']);
    setStatus(ctx, state, 'CANCELLED');
    return state.batch;
  },

  listImports(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const rows = actor.firm.imports.map((s) => s.batch).filter((b) => b.clientId === clientId);
    return paginate(
      [...rows].sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1)),
      ctx.query,
    );
  },

  listMappingTemplates(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const rows = actor.firm.mappingTemplates.filter(
      (t) => t.archivedAt === null && (t.clientId === null || t.clientId === clientId),
    );
    return paginate(rows, ctx.query);
  },

  createMappingTemplate(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const template = {
      ...fresh(ctx, actor.firm.data.firm.id),
      clientId: ctx.body.scope === 'FIRM' ? null : clientId,
      name: ctx.body.name,
      mapping: ctx.body.mapping,
    };
    actor.firm.mappingTemplates.push(template);
    return template;
  },

  updateMappingTemplate(ctx) {
    const actor = actorOf(ctx);
    const template = actor.firm.mappingTemplates.find(
      (t) => t.id === ctx.params.id && t.archivedAt === null,
    );
    if (template === undefined) throw notFound();
    ctx.authorize({ clientId: template.clientId });
    checkVersion(template, ctx.body.version);
    if (ctx.body.name !== undefined) template.name = ctx.body.name;
    if (ctx.body.mapping !== undefined) template.mapping = ctx.body.mapping;
    touch(template, ctx.clock);
    return template;
  },
};
