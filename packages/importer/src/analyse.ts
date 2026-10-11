import {
  IMPORT_ISSUE_SEVERITY,
  ObligationDomain,
  type CanopyField,
  type ColumnMapping,
  type Criticality,
  type EngineApi,
  type EngineCalendar,
  type ImportIssueType,
  type Jurisdiction,
  type LocalDate,
  type TemplateRef,
  type TimelineType,
} from '@canopy/contracts';
import { actKey, aliasKey, principalActKey, type AliasField } from './aliases.js';
import { readDate } from './dates.js';
import { splitLocation, splitOrganization } from './paths.js';
import { decisionFor, ENUM_TABLES } from './decisions.js';
import type { RawCell, SourceSheet } from './read.js';
import {
  enumKey,
  STATUS,
  looksLikeFileName,
  NULL_PLACEHOLDERS,
  stateCodeForName,
  stateCodeOf,
  stateNamedIn,
} from './reference.js';
import {
  collapse,
  groupKeyOf,
  looseKey,
  mostFrequent,
  NearIndex,
  normaliseName,
  tidyMultiline,
  titleCaseName,
} from './text.js';
import type {
  AnalysedRow,
  Decision,
  Decisions,
  DraftIssue,
  ExistingState,
  ImportAnalysis,
  ImportPlan,
  KnownName,
  PlanAct,
  PlanAssignment,
  PlanInstance,
  PlanNamed,
  PlanObligation,
  PlanUnit,
} from './types.js';

/**
 * Parse, clean and plan an import (packages/importer/CLAUDE.md steps 3 to 5). Pure: the same sheet, mapping,
 * existing state and decisions always give the same rows, issues and plan. Nothing is applied silently:
 * every change to a source value is an issue, and WARNING and ERROR issues wait for a decision.
 * A PENDING WARNING is previewed as its proposal so later issues (duplicate periods) show up during review.
 */
export interface AnalyseInput {
  sheet: SourceSheet;
  mapping: ColumnMapping;
  existing: ExistingState;
  decisions?: Decisions;
  inferRule: EngineApi['inferRule'];
  calendar: EngineCalendar;
}

const DUPLICATE_COMMENT = (row: number, completedOn: string | null, comment: string | null) =>
  `Row ${row} of the import repeated this period and was folded into it` +
  (completedOn ? `; it was completed on ${completedOn}` : '') +
  (comment ? `; its comment: ${comment}` : '') +
  '.';

const PENDING_DATE_COMMENT = (date: string) =>
  `The register gave an activity date of ${date} for this pending item; it was kept pending on review.`;
const ASSUMED_DATE_COMMENT = 'Completion date assumed on import: the register gave none.';
const EDITED_DATE_COMMENT = 'Completion date entered on import: the register gave none.';

interface CleanRow {
  rowNumber: number;
  raw: Record<string, RawCell>;
  mapped: Partial<Record<CanopyField, string | null>>;
  blocked: boolean;
  skipped: boolean;
  externalRef: string | null;
  title: string | null;
  description: string | null;
  applicabilityText: string | null;
  category: string | null;
  act: string | null;
  department: string | null;
  owner: string | null;
  approver: string | null;
  ownerComment: string | null;
  criticality: Criticality | null;
  timelineType: TimelineType | null;
  status: 'APPROVED' | 'OPEN' | 'NOT_APPLICABLE' | null;
  dueDate: LocalDate | null;
  completedOn: LocalDate | null;
  naReason: string | null;
  extraComments: string[];
  forms: TemplateRef[];
  logSheets: TemplateRef[];
  org: { company: string; unit: string } | null;
  location: {
    country: string;
    countryCode: string;
    state: string | null;
    city: string | null;
  } | null;
}

interface IssueEntry {
  issue: DraftIssue;
  rows: Set<number>;
  values: Set<string>;
}

/** Issue groups by groupKey. Rows and raw values are kept in Sets so large groups stay linear. */
class IssueBook {
  private readonly byKey = new Map<string, IssueEntry>();
  private readonly keyCache = new Map<string, string>();

  constructor(private readonly decisions: Decisions) {}

  /** Records (or extends) an issue group and returns the decision in force for it. */
  add(
    type: ImportIssueType,
    field: CanopyField | null,
    parts: readonly string[],
    rowNumbers: readonly number[],
    rawValues: readonly string[],
    proposal: string | null,
  ): Decision {
    const cacheKey = JSON.stringify([type, field, ...parts]);
    let groupKey = this.keyCache.get(cacheKey);
    if (groupKey === undefined) {
      groupKey = groupKeyOf(type, field ?? '', ...parts);
      this.keyCache.set(cacheKey, groupKey);
    }
    let entry = this.byKey.get(groupKey);
    if (!entry) {
      const issue: DraftIssue = {
        groupKey,
        type,
        severity: IMPORT_ISSUE_SEVERITY[type],
        rowNumbers: [],
        field,
        rawValues: [...new Set(rawValues)],
        proposal,
        decision: 'PENDING',
        editedValue: null,
      };
      const inForce = decisionFor(issue, this.decisions);
      issue.decision = inForce.decision;
      issue.editedValue = inForce.editedValue;
      entry = { issue, rows: new Set(), values: new Set(issue.rawValues) };
      this.byKey.set(groupKey, entry);
    }
    for (const row of rowNumbers) entry.rows.add(row);
    for (const value of rawValues) entry.values.add(value);
    return { decision: entry.issue.decision, editedValue: entry.issue.editedValue };
  }

  all(): DraftIssue[] {
    return [...this.byKey.values()].map(({ issue, rows, values }) => ({
      ...issue,
      rowNumbers: [...rows].sort((a, b) => a - b),
      rawValues: [...values],
    }));
  }
}

/** Appends to the list under `key`, creating it on first use. */
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function text(cell: RawCell): string | null {
  if (cell === null) return null;
  const value = collapse(String(cell));
  return value === '' ? null : value;
}

function multiline(cell: RawCell): string | null {
  if (cell === null) return null;
  const value = tidyMultiline(String(cell));
  return value === '' ? null : value;
}

export function analyseImport(input: AnalyseInput): ImportAnalysis {
  const issues = new IssueBook(input.decisions ?? {});
  const headerOf = new Map<CanopyField, string>();
  for (const { sourceHeader, field } of input.mapping) {
    if (field !== null && !headerOf.has(field)) headerOf.set(field, sourceHeader);
  }

  const rows = input.sheet.rows.map((source) =>
    cleanRow(source.rowNumber, source.cells, headerOf, issues),
  );

  const acts = resolveAliases('act', 'ALIAS_ACT', rows, input.existing.acts, issues);
  const categories = resolveAliases(
    'category',
    'ALIAS_CATEGORY',
    rows,
    input.existing.categories,
    issues,
  );
  const departments = resolveAliases(
    'department',
    'ALIAS_DEPARTMENT',
    rows,
    input.existing.departments,
    issues,
  );
  const people = resolvePeople(rows, input.existing, issues);
  for (const row of rows) {
    row.act = row.act === null ? null : (acts.final.get(row.act) ?? row.act);
    row.category =
      row.category === null ? null : (categories.final.get(row.category) ?? row.category);
    row.department =
      row.department === null ? null : (departments.final.get(row.department) ?? row.department);
    row.owner = row.owner === null ? null : (people.normOf.get(row.owner) ?? null);
    row.approver = row.approver === null ? null : (people.normOf.get(row.approver) ?? null);
    if (row.act !== null) row.mapped.act = row.act;
    if (row.category !== null) row.mapped.category = row.category;
    if (row.department !== null) row.mapped.department = row.department;
    if (row.owner !== null) row.mapped.owner = people.display.get(row.owner) ?? null;
    if (row.approver !== null) row.mapped.approver = people.display.get(row.approver) ?? null;
  }

  // A row that is neither skipped nor complete can never be planned. Count it as an error so that the dry run
  // accounts for every source row (checkDecision refuses the edits that could lead here).
  for (const row of rows) {
    if (!row.blocked && !row.skipped && !isComplete(row)) row.blocked = true;
  }

  const plan = buildPlan(rows, input, issues, {
    acts: acts.entities,
    categories: categories.entities,
    departments: departments.entities,
    people: people.display,
  });

  const allIssues = issues.all();
  const keysByRow = new Map<number, string[]>();
  for (const issue of allIssues) {
    for (const row of issue.rowNumbers) {
      pushTo(keysByRow, row, issue.groupKey);
    }
  }
  const analysedRows: AnalysedRow[] = rows.map((row) => ({
    rowNumber: row.rowNumber,
    raw: row.raw,
    mapped: row.mapped,
    issueGroupKeys: keysByRow.get(row.rowNumber) ?? [],
    outcome: row.blocked ? 'ERROR' : row.skipped ? 'SKIPPED' : 'PENDING',
    instanceKey: plan.instanceOfRow.get(row.rowNumber) ?? null,
  }));
  for (const row of analysedRows) {
    if (row.outcome === 'PENDING' && plan.foldedRows.has(row.rowNumber)) row.outcome = 'SKIPPED';
  }
  return {
    rows: analysedRows,
    issues: allIssues,
    plan: plan.plan,
    counts: {
      rows: rows.length,
      errors: allIssues.filter((i) => i.severity === 'ERROR').length,
      warnings: allIssues.filter((i) => i.severity === 'WARNING').length,
      infos: allIssues.filter((i) => i.severity === 'INFO').length,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Step 1: one row's cells → cleaned values, with value-level issues.

function cleanRow(
  rowNumber: number,
  cells: Record<string, RawCell>,
  headerOf: Map<CanopyField, string>,
  issues: IssueBook,
): CleanRow {
  const cell = (field: CanopyField): RawCell => {
    const header = headerOf.get(field);
    return header === undefined ? null : (cells[header] ?? null);
  };
  const row: CleanRow = {
    rowNumber,
    raw: cells,
    mapped: {},
    blocked: false,
    skipped: false,
    externalRef: null,
    title: null,
    description: null,
    applicabilityText: null,
    category: null,
    act: null,
    department: null,
    owner: null,
    approver: null,
    ownerComment: null,
    criticality: null,
    timelineType: null,
    status: null,
    dueDate: null,
    completedOn: null,
    naReason: null,
    extraComments: [],
    forms: [],
    logSheets: [],
    org: null,
    location: null,
  };

  /** An ERROR issue: an edit supplies the value, a rejection skips the row, anything else blocks it. */
  const needsPerson = (
    type: 'MISSING_REQUIRED' | 'UNKNOWN_ENUM' | 'INVALID_DATE',
    field: CanopyField,
    raw: string,
  ): string | null => {
    const decision = issues.add(type, field, [raw], [rowNumber], raw === '' ? [] : [raw], null);
    if (decision.decision === 'EDITED') return decision.editedValue;
    if (decision.decision === 'REJECTED') row.skipped = true;
    else row.blocked = true;
    return null;
  };

  const required = (field: CanopyField, read: (c: RawCell) => string | null): string | null =>
    read(cell(field)) ?? read(needsPerson('MISSING_REQUIRED', field, ''));

  row.externalRef = text(cell('externalRef'));
  row.title = required('title', text);
  row.description = required('description', multiline);
  row.applicabilityText = multiline(cell('applicabilityText'));
  row.category = required('category', text);
  row.act = required('act', text);
  row.department = required('department', text);
  row.owner = required('owner', text);
  row.approver = required('approver', text);
  row.ownerComment = multiline(cell('ownerComment'));

  const readEnum = <T extends string>(field: CanopyField): T | null => {
    const table = ENUM_TABLES[field];
    /* v8 ignore next */
    if (!table) throw new Error(`No enum table for ${field}`);
    const raw = text(cell(field));
    if (raw === null) {
      const edited = needsPerson('MISSING_REQUIRED', field, '');
      return edited === null ? null : ((table.byKey[enumKey(edited)] as T | undefined) ?? null);
    }
    const value = table.byKey[enumKey(raw)] as T | undefined;
    if (value === undefined) {
      const edited = needsPerson('UNKNOWN_ENUM', field, raw);
      return edited === null ? null : ((table.byKey[enumKey(edited)] as T | undefined) ?? null);
    }
    if (!table.canonical.includes(raw)) {
      issues.add('ENUM_NORMALISED', field, [raw], [rowNumber], [raw], value);
    }
    return value;
  };
  row.criticality = readEnum<Criticality>('criticality');
  row.timelineType = readEnum<TimelineType>('timelineType');
  row.status = readEnum<'APPROVED' | 'OPEN' | 'NOT_APPLICABLE'>('status');

  const readDateField = (field: 'dueDate' | 'completedOn'): LocalDate | null => {
    const raw = cell(field);
    const read = readDate(raw);
    if (read.kind === 'date') return read.value;
    if (read.kind === 'blank' && field === 'completedOn') return null;
    const edited =
      read.kind === 'blank'
        ? needsPerson('MISSING_REQUIRED', field, '')
        : needsPerson('INVALID_DATE', field, String(raw));
    const fixed = readDate(edited);
    return fixed.kind === 'date' ? fixed.value : null;
  };
  row.dueDate = readDateField('dueDate');
  row.completedOn = readDateField('completedOn');

  row.forms = readTemplates('forms', cell('forms'), rowNumber, issues);
  row.logSheets = readTemplates('logSheets', cell('logSheets'), rowNumber, issues);

  const orgRaw = text(cell('organizationPath'));
  const orgText = orgRaw ?? needsPerson('MISSING_REQUIRED', 'organizationPath', '');
  if (orgText !== null) {
    row.org = splitOrganization(orgText);
    if (row.org === null) {
      const edited = needsPerson('MISSING_REQUIRED', 'organizationPath', orgText);
      row.org = edited === null ? null : splitOrganization(edited);
    }
  }

  const locRaw = text(cell('locationPath'));
  const locText = locRaw ?? needsPerson('MISSING_REQUIRED', 'locationPath', '');
  if (locText !== null) {
    row.location = splitLocation(locText);
    if (row.location === null) {
      const edited = needsPerson('UNKNOWN_ENUM', 'locationPath', locText);
      row.location = edited === null ? null : splitLocation(edited);
    }
  }

  applyStatusRules(row, issues);

  const m = row.mapped;
  if (headerOf.has('externalRef')) m.externalRef = row.externalRef;
  m.title = row.title;
  m.description = row.description;
  if (headerOf.has('applicabilityText')) m.applicabilityText = row.applicabilityText;
  m.category = row.category;
  m.act = row.act;
  m.department = row.department;
  m.owner = row.owner;
  m.approver = row.approver;
  if (headerOf.has('ownerComment')) m.ownerComment = row.ownerComment;
  m.criticality = row.criticality;
  m.timelineType = row.timelineType;
  m.status = row.status;
  m.dueDate = row.dueDate;
  if (headerOf.has('completedOn')) m.completedOn = row.completedOn;
  if (headerOf.has('forms')) m.forms = row.forms.map((t) => t.label).join('\n') || null;
  if (headerOf.has('logSheets')) m.logSheets = row.logSheets.map((t) => t.label).join('\n') || null;
  m.organizationPath = row.org ? `${row.org.company} / ${row.org.unit}` : null;
  m.locationPath = row.location
    ? [row.location.country, row.location.state, row.location.city].filter(Boolean).join(' / ')
    : null;
  return row;
}

function readTemplates(
  field: 'forms' | 'logSheets',
  cellValue: RawCell,
  rowNumber: number,
  issues: IssueBook,
): TemplateRef[] {
  const value = text(cellValue);
  if (value === null) return [];
  if (NULL_PLACEHOLDERS.has(value.toLowerCase())) {
    issues.add('NULL_PLACEHOLDER', field, [value.toLowerCase()], [rowNumber], [value], null);
    return [];
  }
  const label = value.slice(0, 500);
  if (looksLikeFileName(value)) {
    issues.add('FILE_NOT_ATTACHED', field, [value], [rowNumber], [value], value);
    return [{ label, fileName: value.slice(0, 255), templateFileId: null }];
  }
  return [{ label, fileName: null, templateFileId: null }];
}

/** Register status → workflow state, with the completion date and NA reason each state needs. */
function applyStatusRules(row: CleanRow, issues: IssueBook): void {
  if (row.status === 'OPEN' && row.completedOn !== null) {
    // A pending row with an activity date: either the status or the date is wrong, and only a person can say
    // which. Edit the status ("Complied" keeps the date; "Pending" drops it into a comment) or skip the row.
    const date = row.completedOn;
    const decision = issues.add(
      'UNKNOWN_ENUM',
      'status',
      ['pending with an activity date'],
      [row.rowNumber],
      ['Pending with an activity date'],
      null,
    );
    const edited =
      decision.decision === 'EDITED'
        ? STATUS.byKey[enumKey(decision.editedValue ?? '')]
        : undefined;
    if (decision.decision === 'REJECTED') {
      row.skipped = true;
    } else if (edited === undefined) {
      row.blocked = true;
    } else {
      row.status = edited;
      if (edited === 'OPEN') {
        row.completedOn = null;
        row.extraComments.push(PENDING_DATE_COMMENT(date));
      }
    }
  }
  if (row.status === 'APPROVED' && row.completedOn === null && row.dueDate !== null) {
    const decision = issues.add(
      'COMPLIED_WITHOUT_DATE',
      'completedOn',
      [],
      [row.rowNumber],
      [],
      'due date',
    );
    if (decision.decision === 'REJECTED') {
      row.skipped = true;
    } else if (decision.decision === 'EDITED') {
      const read = readDate(decision.editedValue);
      row.completedOn = read.kind === 'date' ? read.value : null;
      row.extraComments.push(EDITED_DATE_COMMENT);
    } else {
      row.completedOn = row.dueDate;
      row.extraComments.push(ASSUMED_DATE_COMMENT);
    }
  } else if (row.status === 'NOT_APPLICABLE') {
    row.naReason = row.ownerComment;
    if (row.naReason === null) {
      const decision = issues.add(
        'MISSING_REQUIRED',
        'ownerComment',
        ['NA reason'],
        [row.rowNumber],
        [],
        null,
      );
      if (decision.decision === 'EDITED') row.naReason = decision.editedValue;
      else if (decision.decision === 'REJECTED') row.skipped = true;
      else row.blocked = true;
    }
    if (row.completedOn === null) {
      const decision = issues.add(
        'MISSING_REQUIRED',
        'completedOn',
        ['NA date'],
        [row.rowNumber],
        [],
        null,
      );
      const read = readDate(decision.editedValue);
      if (decision.decision === 'EDITED' && read.kind === 'date') row.completedOn = read.value;
      else if (decision.decision === 'REJECTED') row.skipped = true;
      else row.blocked = true;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Step 2: aliases for Acts, categories and departments; people.

interface AliasResult {
  /** Spelling in the file → name it resolves to. */
  final: Map<string, string>;
  entities: Map<string, PlanNamed>;
}

function resolveAliases(
  field: AliasField,
  type: 'ALIAS_ACT' | 'ALIAS_CATEGORY' | 'ALIAS_DEPARTMENT',
  rows: CleanRow[],
  known: KnownName[],
  issues: IssueBook,
): AliasResult {
  const rowsOf = new Map<string, number[]>();
  for (const row of rows) {
    const value = row[field];
    if (value !== null) pushTo(rowsOf, value, row.rowNumber);
  }
  const counts = new Map([...rowsOf].map(([value, list]) => [value, list.length]));
  const final = new Map<string, string>();

  // Accepted aliases from earlier imports resolve without an issue.
  const knownByLoose = new Map<string, string>();
  const anchorByKey = new Map<string, string>();
  for (const entry of known) {
    for (const spelling of [entry.name, ...entry.aliases])
      knownByLoose.set(looseKey(spelling), entry.name);
    if (!anchorByKey.has(aliasKey(field, entry.name)))
      anchorByKey.set(aliasKey(field, entry.name), entry.name);
  }
  const groups = new Map<string, string[]>();
  for (const value of rowsOf.keys()) {
    const knownName = knownByLoose.get(looseKey(value));
    if (knownName !== undefined) {
      final.set(value, knownName);
      continue;
    }
    const key = aliasKey(field, value);
    pushTo(groups, key, value);
  }

  for (const [key, spellings] of groups) {
    const anchor = anchorByKey.get(key) ?? null;
    if (anchor === null && spellings.length < 2) {
      final.set(spellings[0] ?? '', spellings[0] ?? '');
      continue;
    }
    const ordered = [...spellings].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
    const proposal = anchor ?? mostFrequent(new Map(ordered.map((s) => [s, counts.get(s) ?? 0])));
    const decision = issues.add(
      type,
      field,
      [key],
      spellings.flatMap((s) => rowsOf.get(s) ?? []),
      ordered,
      proposal,
    );
    const target =
      decision.decision === 'EDITED'
        ? collapse(decision.editedValue ?? '')
        : decision.decision === 'REJECTED'
          ? null
          : proposal;
    for (const spelling of spellings) final.set(spelling, target ?? spelling);
  }

  if (field === 'act') groupByPrincipalAct(rowsOf, final, issues);

  const entities = new Map<string, PlanNamed>();
  for (const [spelling, name] of final) {
    const entity = entities.get(name) ?? { name, aliases: [] };
    if (spelling !== name && !entity.aliases.includes(spelling)) entity.aliases.push(spelling);
    entities.set(name, entity);
  }
  return { final, entities };
}

/**
 * An Act named on its own ("Factories Act, 1948") and the same Act with state rules ("Factories Act, 1948 and
 * West Bengal Factories Rules, 1958") are offered as one ALIAS_ACT issue with no proposal: they may be different
 * entries in the library, so they stay apart unless a person picks the name to merge into.
 */
function groupByPrincipalAct(
  rowsOf: Map<string, number[]>,
  final: Map<string, string>,
  issues: IssueBook,
): void {
  const names = [...new Set(final.values())];
  for (const standalone of names) {
    const key = actKey(standalone);
    if (principalActKey(key) !== key) continue;
    const members = names.filter(
      (name) => name !== standalone && principalActKey(actKey(name)) === key,
    );
    if (members.length === 0) continue;
    const group = [standalone, ...members];
    const spellings = [...final].filter(([, name]) => group.includes(name)).map(([s]) => s);
    const decision = issues.add(
      'ALIAS_ACT',
      'act',
      ['principal', key],
      spellings.flatMap((s) => rowsOf.get(s) ?? []),
      group,
      null,
    );
    if (decision.decision !== 'EDITED') continue;
    const target = collapse(decision.editedValue ?? '');
    for (const spelling of spellings) final.set(spelling, target);
  }
}

interface PeopleResult {
  /** Spelling in the file → nameNormalized of the person it resolves to. */
  normOf: Map<string, string>;
  /** nameNormalized → display name. */
  display: Map<string, string>;
}

function resolvePeople(rows: CleanRow[], existing: ExistingState, issues: IssueBook): PeopleResult {
  const rowsOf = new Map<string, number[]>();
  for (const row of rows) {
    for (const value of [row.owner, row.approver]) {
      if (value !== null) {
        // Rows arrive in order, so a repeat (owner = approver) can only be the last entry.
        const list = rowsOf.get(value);
        if (!list) rowsOf.set(value, [row.rowNumber]);
        else if (list[list.length - 1] !== row.rowNumber) list.push(row.rowNumber);
      }
    }
  }
  const knownDisplay = new Map(existing.people.map((p) => [p.nameNormalized, p.displayName]));
  const spellingsByNorm = new Map<string, string[]>();
  for (const spelling of rowsOf.keys()) {
    const norm = normaliseName(spelling);
    pushTo(spellingsByNorm, norm, spelling);
  }

  const display = new Map<string, string>();
  for (const [norm, spellings] of spellingsByNorm) {
    const knownName = knownDisplay.get(norm);
    if (knownName !== undefined) {
      display.set(norm, knownName);
      continue;
    }
    const counts = new Map(spellings.map((s) => [s, rowsOf.get(s)?.length ?? 0]));
    const name = titleCaseName(mostFrequent(counts));
    display.set(norm, name);
    if (spellings.some((s) => s !== name)) {
      issues.add(
        'PERSON_CASE_MERGE',
        'owner',
        [norm],
        spellings.flatMap((s) => rowsOf.get(s) ?? []),
        spellings,
        name,
      );
    }
  }

  // Near matches are never merged without a person choosing the name to keep.
  const target = new Map<string, string>();
  const find = (norm: string): string => {
    let current = norm;
    while (target.has(current) && target.get(current) !== current)
      current = target.get(current) ?? current;
    return current;
  };
  const fresh = [...spellingsByNorm.keys()].filter((norm) => !knownDisplay.has(norm));
  const freshSet = new Set(fresh);
  const index = new NearIndex(new Set([...fresh, ...knownDisplay.keys()]), 2);
  for (const a of fresh) {
    for (const b of index.near(a)) {
      if (freshSet.has(b) && b < a) continue;
      const nameA = display.get(a) ?? knownDisplay.get(a) ?? a;
      const nameB = display.get(b) ?? knownDisplay.get(b) ?? b;
      const pair = [nameA, nameB].sort();
      const decision = issues.add(
        'PERSON_NEAR_MATCH',
        'owner',
        [a < b ? a : b, a < b ? b : a],
        [...(spellingsByNorm.get(a) ?? []), ...(spellingsByNorm.get(b) ?? [])].flatMap(
          (s) => rowsOf.get(s) ?? [],
        ),
        pair,
        null,
      );
      if (decision.decision !== 'EDITED') continue;
      const keep = decision.editedValue === nameA ? a : b;
      const drop = keep === a ? b : a;
      if (!display.has(b)) display.set(b, nameB);
      target.set(find(drop), find(keep));
    }
  }

  const normOf = new Map<string, string>();
  for (const [norm, spellings] of spellingsByNorm) {
    for (const spelling of spellings) normOf.set(spelling, find(norm));
  }
  const used = new Set(normOf.values());
  for (const norm of [...display.keys()]) if (!used.has(norm)) display.delete(norm);
  return { normOf, display };
}

// ---------------------------------------------------------------------------------------------------------
// Step 3: entities, obligations, assignments, instances and rules.

interface Resolved {
  acts: Map<string, PlanNamed>;
  categories: Map<string, PlanNamed>;
  departments: Map<string, PlanNamed>;
  people: Map<string, string>;
}

const REF_PATTERN = /^([A-Z]+)-([A-Z]{2,3})-\d+-\d+-\d+$/;
const DOMAINS: readonly string[] = ObligationDomain.options;

function domainOf(ref: string | null): ObligationDomain {
  const prefix = ref?.split('-')[0]?.toUpperCase() ?? '';
  return DOMAINS.includes(prefix) && prefix !== 'OTHER' ? (prefix as ObligationDomain) : 'OTHER';
}

function jurisdictionOfText(name: string): {
  jurisdiction: Jurisdiction;
  stateCode: string | null;
} {
  const stateCode = stateNamedIn(name);
  return stateCode === null
    ? { jurisdiction: 'CENTRAL', stateCode }
    : { jurisdiction: 'STATE', stateCode };
}

/** Domain and jurisdiction from a 5-part ref ("TAX-CL-033-6067-60218"); null when it does not parse. */
function parseRef(ref: string): { jurisdiction: Jurisdiction; stateCode: string | null } | null {
  const match = REF_PATTERN.exec(ref);
  if (!match) return null;
  const segment = match[2] ?? '';
  if (segment === 'CL') return { jurisdiction: 'CENTRAL', stateCode: null };
  const stateCode = stateCodeOf(segment);
  return stateCode === null ? null : { jurisdiction: 'STATE', stateCode };
}

function locationKeyOf(loc: NonNullable<CleanRow['location']>): string {
  return [loc.countryCode, loc.state ?? '', loc.city ?? ''].map((p) => p.toLowerCase()).join('|');
}

function obligationKeyOf(row: CleanRow, unitKey: string): string {
  if (row.externalRef !== null) return `ref:${row.externalRef}`;
  return `act-title-unit:${looseKey(row.act ?? '')}|${looseKey(row.title ?? '')}|${unitKey}`;
}

/** Every value a planned row needs. A row without them is blocked by a pending ERROR issue or skipped. */
type CompleteRow = CleanRow & {
  org: NonNullable<CleanRow['org']>;
  location: NonNullable<CleanRow['location']>;
  dueDate: LocalDate;
};

function isComplete(row: CleanRow): row is CompleteRow {
  return [
    row.title,
    row.description,
    row.category,
    row.act,
    row.department,
    row.owner,
    row.approver,
    row.criticality,
    row.timelineType,
    row.status,
    row.dueDate,
    row.org,
    row.location,
  ].every((value) => value !== null);
}

interface Usable extends CompleteRow {
  unitKey: string;
  obligationKey: string;
  assignmentKey: string;
  instanceKey: string;
}

function buildPlan(
  rows: CleanRow[],
  input: AnalyseInput,
  issues: IssueBook,
  resolved: Resolved,
): { plan: ImportPlan; instanceOfRow: Map<number, string>; foldedRows: Set<number> } {
  const usable: Usable[] = [];
  for (const row of rows) {
    if (row.blocked || row.skipped || !isComplete(row)) continue;
    const unitKey = `${looseKey(row.org.company)}|${looseKey(row.org.unit)}`;
    const obligationKey = obligationKeyOf(row, unitKey);
    const assignmentKey = `${unitKey}|${obligationKey}|${row.department ?? ''}`;
    usable.push({
      ...row,
      unitKey,
      obligationKey,
      assignmentKey,
      instanceKey: `${assignmentKey}|${row.dueDate}`,
    });
  }

  const companies = new Map<string, { key: string; name: string }>();
  const locations = new Map<string, ImportPlan['locations'][number]>();
  const units = new Map<string, PlanUnit>();
  for (const row of usable) {
    const companyKey = looseKey(row.org.company);
    if (!companies.has(companyKey))
      companies.set(companyKey, { key: companyKey, name: row.org.company });
    const locationKey = locationKeyOf(row.location);
    if (!locations.has(locationKey)) {
      locations.set(locationKey, {
        key: locationKey,
        country: row.location.country,
        countryCode: row.location.countryCode,
        state: row.location.state,
        stateCode: row.location.state === null ? null : stateCodeForName(row.location.state),
        city: row.location.city,
      });
    }
    if (!units.has(row.unitKey)) {
      units.set(row.unitKey, { key: row.unitKey, companyKey, name: row.org.unit, locationKey });
    }
  }

  // Instances: one per (assignment, due date); repeated periods fold into the first row.
  const rowsByInstance = new Map<string, Usable[]>();
  for (const row of usable) pushTo(rowsByInstance, row.instanceKey, row);
  const instances: PlanInstance[] = [];
  const instanceOfRow = new Map<number, string>();
  const foldedRows = new Set<number>();
  const keptRows: Usable[] = [];
  for (const [key, group] of rowsByInstance) {
    const [first, ...repeats] = group;
    /* v8 ignore next */
    if (!first) continue;
    const comments = [...(first.ownerComment ? [first.ownerComment] : []), ...first.extraComments];
    if (repeats.length > 0) {
      const decision = issues.add(
        'DUPLICATE_PERIOD',
        'dueDate',
        [key],
        group.map((r) => r.rowNumber),
        [first.dueDate ?? ''],
        `Keep row ${first.rowNumber}`,
      );
      for (const repeat of repeats) {
        foldedRows.add(repeat.rowNumber);
        if (decision.decision === 'REJECTED') continue;
        instanceOfRow.set(repeat.rowNumber, key);
        comments.push(DUPLICATE_COMMENT(repeat.rowNumber, repeat.completedOn, repeat.ownerComment));
      }
    }
    instanceOfRow.set(first.rowNumber, key);
    keptRows.push(first);
    instances.push({
      key,
      assignmentKey: first.assignmentKey,
      rowNumbers: group.map((r) => r.rowNumber),
      dueDate: first.dueDate,
      workflowState: first.status ?? 'OPEN',
      completedOn: first.completedOn,
      naReason: first.status === 'NOT_APPLICABLE' ? first.naReason : null,
      owner: first.owner ?? '',
      approver: first.approver ?? '',
      comments,
    });
  }

  // Obligations: first row's values; differing values are listed, per-row values stay on instances.
  const rowsByObligation = new Map<string, Usable[]>();
  for (const row of keptRows) {
    pushTo(rowsByObligation, row.obligationKey, row);
  }
  const obligations: PlanObligation[] = [];
  for (const [key, group] of rowsByObligation) {
    const first = group[0] as Usable;
    const conflictFields: [CanopyField, (r: Usable) => string | null][] = [
      ['title', (r) => r.title],
      ['description', (r) => r.description],
      ['applicabilityText', (r) => r.applicabilityText],
      ['category', (r) => r.category],
      ['act', (r) => r.act],
      ['criticality', (r) => r.criticality],
      ['timelineType', (r) => r.timelineType],
      ['forms', (r) => r.forms.map((t) => t.label).join('\n')],
      ['logSheets', (r) => r.logSheets.map((t) => t.label).join('\n')],
    ];
    for (const [field, read] of conflictFields) listConflicts(issues, key, field, group, read);

    let ref: { jurisdiction: Jurisdiction; stateCode: string | null } | null = null;
    if (first.externalRef !== null) {
      ref = parseRef(first.externalRef);
      if (ref === null) {
        issues.add(
          'UNPARSED_EXTERNAL_REF',
          'externalRef',
          [first.externalRef],
          group.map((r) => r.rowNumber),
          [first.externalRef],
          null,
        );
      }
    }
    const juris = ref ?? jurisdictionOfText(first.act ?? '');

    let inferred = null;
    let ruleStatus: PlanObligation['ruleStatus'] = null;
    if (!(key in input.existing.obligations)) {
      const dates = [...new Set(group.map((r) => r.dueDate))].sort();
      inferred = input.inferRule(dates, first.timelineType ?? 'TIME_BASED', input.calendar);
      ruleStatus = 'CONFIRMED';
      if (inferred.confidence < 1) {
        ruleStatus = 'TO_REVIEW';
        issues.add(
          'RULE_LOW_CONFIDENCE',
          null,
          [key],
          group.map((r) => r.rowNumber),
          dates,
          'TO_REVIEW',
        );
      }
    }

    obligations.push({
      key,
      externalRef: first.externalRef,
      domain: domainOf(first.externalRef),
      jurisdiction: juris.jurisdiction,
      stateCode: juris.stateCode,
      act: first.act ?? '',
      category: first.category ?? '',
      title: first.title ?? '',
      description: first.description ?? '',
      applicabilityText: first.applicabilityText,
      criticality: first.criticality ?? 'HIGH',
      timelineType: first.timelineType ?? 'TIME_BASED',
      inferred,
      recurrenceRule: inferred?.rule ?? null,
      ruleStatus,
      forms: first.forms,
      logSheets: first.logSheets,
    });
  }

  // Assignments: (unit, obligation, department); default owner and approver from the first row.
  const rowsByAssignment = new Map<string, Usable[]>();
  for (const row of keptRows) {
    pushTo(rowsByAssignment, row.assignmentKey, row);
  }
  const assignments: PlanAssignment[] = [];
  for (const [key, group] of rowsByAssignment) {
    const first = group[0] as Usable;
    const name = (norm: string | null) =>
      norm === null ? null : (resolved.people.get(norm) ?? norm);
    listConflicts(issues, key, 'owner', group, (r) => name(r.owner));
    listConflicts(issues, key, 'approver', group, (r) => name(r.approver));
    assignments.push({
      key,
      unitKey: first.unitKey,
      obligationKey: first.obligationKey,
      department: first.department ?? '',
      defaultOwner: first.owner ?? '',
      defaultApprover: first.approver ?? '',
      firstDueDate: group.map((r) => r.dueDate).sort()[0] as LocalDate,
    });
  }

  const used = <T extends { name: string }>(entities: Map<string, T>, names: Set<string>): T[] =>
    [...entities.values()].filter((e) => names.has(e.name));
  const actNames = new Set(obligations.map((o) => o.act));
  const plan: ImportPlan = {
    acts: used(resolved.acts, actNames).map((a): PlanAct => ({
      ...a,
      ...jurisdictionOfText(a.name),
    })),
    categories: used(resolved.categories, new Set(obligations.map((o) => o.category))),
    departments: used(resolved.departments, new Set(assignments.map((a) => a.department))),
    people: [...new Set(instances.flatMap((i) => [i.owner, i.approver]))].map((norm) => ({
      nameNormalized: norm,
      displayName: resolved.people.get(norm) ?? norm,
    })),
    companies: [...companies.values()],
    locations: [...locations.values()],
    units: [...units.values()],
    obligations,
    assignments,
    instances,
  };
  return { plan, instanceOfRow, foldedRows };
}

function listConflicts(
  issues: IssueBook,
  key: string,
  field: CanopyField,
  group: Usable[],
  read: (row: Usable) => string | null,
): void {
  const values = [...new Set(group.map((r) => read(r) ?? ''))];
  if (values.length < 2) return;
  issues.add(
    'CONFLICTING_OBLIGATION_VALUE',
    field,
    [key],
    group.map((r) => r.rowNumber),
    values,
    values[0] ?? null,
  );
}
