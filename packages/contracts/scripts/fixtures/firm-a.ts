// Firm A: the sample register as the importer would load it (docs/contracts/fixtures.md §1-§4).
// People are replaced by pseudonyms keyed by normalised name (fixtures.md §7); real names never reach the JSON.
import type {
  Act,
  Assignment,
  Category,
  Comment,
  ComplianceInstance,
  Criticality,
  Department,
  DueDatesFixture,
  ExpectedFixture,
  ExpectedProfile,
  FixtureSet,
  Membership,
  Obligation,
  ObligationDomain,
  Person,
  RecurrenceRule,
  TemplateRef,
  TimelineType,
  WorkflowState,
} from './types.js';
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_FIRM_SETTINGS } from '../../src/index.js';
import { fixtureId } from '../../src/fixtures/index.js';
import { score, statusIds, type ScoredInstance } from '../../src/mock/derive.js';
import { type Cell, serialToDate } from './xlsx.js';

export const AS_OF_DATES = ['2022-09-30', '2022-12-15', '2023-03-31'] as const;
const IMPORTED_AT = '2026-10-01T04:30:00Z';
const FY_START = { year: 2022, month: 4 };

/** Merges the recommended profile accepts (fixtures.md §3). Raw spelling → canonical spelling. */
const DEPARTMENT_ALIASES: Record<string, string> = { HR: 'Human Resources' };
const CATEGORY_ALIASES: Record<string, string> = {
  'Procedural Requirements': 'Procedural Requirement',
  'Statutory Registers and Records': 'Statutory Records',
};
const PETROLEUM = 'Petroleum Act, 1934 read with Petroleum Rules 2002';
const ACT_ALIASES: Record<string, string> = {
  'The Petroleum Act, 1934 and Petroleum Rules, 2002': PETROLEUM,
  'The Petroleum Act, 1934 and Petroleum Rules, 2003': PETROLEUM,
  'The Petroleum Act, 1934 and Petroleum Rules, 2005': PETROLEUM,
};

const CRITICALITY: Record<string, Criticality> = {
  'super critical': 'SUPER_CRITICAL',
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};
const TIMELINE: Record<string, TimelineType> = {
  'time based': 'TIME_BASED',
  'on going': 'ONGOING',
};
const STATUS: Record<string, WorkflowState> = {
  complied: 'APPROVED',
  pending: 'OPEN',
  'not applicable': 'NOT_APPLICABLE',
};
const PLACEHOLDERS = new Set(['', 'null', 'na', 'n/a', '-']);
const STANDARD_REF = /^[A-Z]+-[A-Z]{2}-\d{3}-\d{4}-\d{5}$/;

interface Row {
  rowNumber: number;
  ref: string;
  title: string;
  timeline: TimelineType;
  description: string;
  category: string;
  applicability: string | null;
  act: string;
  activityDate: string | null;
  state: WorkflowState;
  dueDate: string;
  form: string | null;
  logSheet: string | null;
  owner: string;
  ownerComment: string | null;
  approver: string;
  department: string;
  criticality: Criticality;
}

const normalise = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

function clean(value: Cell): string | null {
  if (value === null) return null;
  const text = String(value).trim();
  return PLACEHOLDERS.has(text.toLowerCase()) ? null : text;
}

function required(value: Cell, column: string, rowNumber: number): string {
  const text = clean(value);
  if (text === null) throw new Error(`Row ${rowNumber}: ${column} is empty`);
  return text;
}

function lookup<T>(table: Record<string, T>, value: string, column: string, rowNumber: number): T {
  const found = table[value.toLowerCase()];
  if (found === undefined) throw new Error(`Row ${rowNumber}: unknown ${column} "${value}"`);
  return found;
}

function parseRows(sheet: Cell[][]): Row[] {
  const [header, ...data] = sheet;
  const col = (name: string) => {
    const index = header!.indexOf(name);
    if (index < 0) throw new Error(`Missing column ${name}`);
    return index;
  };
  const c = {
    ref: col('EY Compliance ID'),
    title: col('Compliance Title'),
    timeline: col('Type (TimeLine)'),
    description: col('Compliance Description'),
    category: col('Compliance Categorization'),
    applicability: col('Applicability'),
    act: col('Act'),
    activityDate: col('Activity Date'),
    status: col('Compliance Status'),
    dueDate: col('Due Date'),
    form: col('Form Description'),
    logSheet: col('Log Sheet Description'),
    owner: col('Owner'),
    ownerComment: col('Owner Comments'),
    approver: col('Approvers'),
    department: col('Department'),
    criticality: col('Criticality'),
  };
  return data.map((cells, index) => {
    const rowNumber = index + 2;
    const get = (key: keyof typeof c) => cells[c[key]] ?? null;
    const activity = get('activityDate');
    return {
      rowNumber,
      ref: required(get('ref'), 'EY Compliance ID', rowNumber),
      title: required(get('title'), 'Compliance Title', rowNumber),
      timeline: lookup(TIMELINE, required(get('timeline'), 'Type', rowNumber), 'Type', rowNumber),
      description: required(get('description'), 'Compliance Description', rowNumber),
      category: required(get('category'), 'Compliance Categorization', rowNumber),
      applicability: clean(get('applicability')),
      act: required(get('act'), 'Act', rowNumber),
      activityDate: typeof activity === 'number' ? serialToDate(activity) : null,
      state: lookup(STATUS, required(get('status'), 'Status', rowNumber), 'Status', rowNumber),
      dueDate: serialToDate(Number(get('dueDate'))),
      form: clean(get('form')),
      logSheet: clean(get('logSheet')),
      owner: normalise(required(get('owner'), 'Owner', rowNumber)),
      ownerComment: clean(get('ownerComment')),
      approver: normalise(required(get('approver'), 'Approvers', rowNumber)),
      department: required(get('department'), 'Department', rowNumber),
      criticality: lookup(
        CRITICALITY,
        required(get('criticality'), 'Criticality', rowNumber),
        'Criticality',
        rowNumber,
      ),
    };
  });
}

// ---------- calendar helpers (fixture periods only; product code uses the engine) ----------

const pad = (n: number) => String(n).padStart(2, '0');
function monthAdd(year: number, month: number, add: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + add;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}
const firstDay = (y: number, m: number) => `${y}-${pad(m)}-01`;
const lastDay = (y: number, m: number) =>
  `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
const isMonthEnd = (date: string) =>
  date === lastDay(Number(date.slice(0, 4)), Number(date.slice(5, 7)));
const ymd = (date: string) => ({
  year: Number(date.slice(0, 4)),
  month: Number(date.slice(5, 7)),
  day: Number(date.slice(8, 10)),
});

/** The months [start, start + length) as a period. */
function span(start: { year: number; month: number }, length: number) {
  const end = monthAdd(start.year, start.month, length - 1);
  return {
    periodStart: firstDay(start.year, start.month),
    periodEnd: lastDay(end.year, end.month),
  };
}

const QUARTER_ENDS = ['06-30', '09-30', '12-31', '03-31'];

/** The rule M0 expects inferRule to return, and whether it regenerates every date. */
function expectRule(
  timeline: TimelineType,
  dates: string[],
): { rule: RecurrenceRule | null; exact: boolean } {
  const monthDays = dates.map((d) => d.slice(5));
  if (
    timeline === 'ONGOING' &&
    dates.length === 4 &&
    QUARTER_ENDS.every((md) => monthDays.includes(md))
  ) {
    return { rule: { kind: 'ONGOING_REVIEW', every: 'QUARTER' }, exact: true };
  }
  if (timeline === 'ONGOING' && dates.length === 12 && dates.every(isMonthEnd)) {
    return { rule: { kind: 'ONGOING_REVIEW', every: 'MONTH' }, exact: true };
  }
  if (timeline === 'TIME_BASED' && dates.length === 1) {
    const { month, day } = ymd(dates[0]!);
    return { rule: { kind: 'ANNUAL', month, day }, exact: true };
  }
  if (timeline === 'TIME_BASED' && dates.length === 12) {
    const tally = new Map<number, number>();
    for (const d of dates) tally.set(ymd(d).day, (tally.get(ymd(d).day) ?? 0) + 1);
    const day = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
    const exact = dates.every((d) => {
      const { year, month, day: actual } = ymd(d);
      return actual === Math.min(day, ymd(lastDay(year, month)).day);
    });
    return { rule: { kind: 'MONTHLY', day, offsetMonths: 1 }, exact };
  }
  return { rule: null, exact: false };
}

/** Period of the k-th distinct due date (fixture convention, consistent with the stored rule). */
function periodsFor(rule: RecurrenceRule, timeline: TimelineType, dates: string[]) {
  return dates.map((date, k) => {
    const { year, month } = ymd(date);
    if (rule.kind === 'ONGOING_REVIEW' && rule.every === 'QUARTER') {
      return span(monthAdd(year, month, -2), 3);
    }
    if (rule.kind === 'ONGOING_REVIEW') return span({ year, month }, 1);
    if (timeline === 'TIME_BASED' && dates.length === 12) {
      return span(monthAdd(year, month, -1), 1);
    }
    if (12 % dates.length !== 0) throw new Error(`No period layout for ${dates.length} dates`);
    const length = 12 / dates.length;
    return span(monthAdd(FY_START.year, FY_START.month, k * length), length);
  });
}

function fixedDates(dates: string[]): RecurrenceRule {
  return {
    kind: 'FIXED_DATES',
    dates: dates.map((d) => ({ month: ymd(d).month, day: ymd(d).day })),
  };
}

// ---------- build ----------

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

const distinct = <T>(items: T[]) => [...new Set(items)];
const base = (key: string, firmId: string) => ({
  id: fixtureId(key),
  firmId,
  createdAt: IMPORTED_AT,
  updatedAt: IMPORTED_AT,
  archivedAt: null,
});
const versioned = (key: string, firmId: string) => ({ ...base(key, firmId), version: 1 });

function templates(label: string | null): TemplateRef[] {
  if (label === null) return [];
  if (label.length > 500) throw new Error('Template label longer than 500 characters');
  return [{ label, fileName: null, templateFileId: null }];
}

/** Fails if any real name, or a distinctive part of one, appears in text copied into the fixture. */
function assertNoNames(texts: string[], names: string[]): void {
  const parts = distinct(names.flatMap((n) => [n, ...n.split(' ').filter((p) => p.length >= 4)]));
  for (const text of texts) {
    const lower = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    const hit = parts.find((p) => lower.includes(` ${p} `));
    if (hit !== undefined) throw new Error('A person name appears in text copied into the fixture');
  }
}

export interface FirmA {
  sample: FixtureSet;
  dueDates: DueDatesFixture;
  expected: ExpectedFixture;
}

export function buildFirmA(sheet: Cell[][], sourceName: string): FirmA {
  const rows = parseRows(sheet);
  const firmId = fixtureId('firm-a');
  const k = (key: string) => `firm-a:${key}`;

  // People: owners numbered first, then approvers who own nothing.
  const owners = distinct(rows.map((r) => r.owner)).sort();
  const approverOnly = distinct(rows.map((r) => r.approver))
    .filter((a) => !owners.includes(a))
    .sort();
  const pseudonym = new Map<string, string>([
    ...owners.map((n, i) => [n, `Owner ${pad(i + 1)}`] as const),
    ...approverOnly.map((n, i) => [n, `Approver ${pad(i + 1)}`] as const),
  ]);
  const personId = (realName: string) =>
    fixtureId(k(`person:${normalise(pseudonym.get(realName)!)}`));

  const client = {
    ...versioned(k('client'), firmId),
    name: 'Aditya Birla Group',
    settings: DEFAULT_CLIENT_SETTINGS,
  };
  const company = { ...versioned(k('company'), firmId), clientId: client.id, name: 'Hindalco' };
  const location = {
    ...base(k('location'), firmId),
    country: 'India',
    countryCode: 'IN',
    state: 'West Bengal',
    stateCode: 'WB',
    city: 'Belur',
  };
  const unit = {
    ...versioned(k('unit'), firmId),
    clientId: client.id,
    companyId: company.id,
    name: 'Plant',
    locationId: location.id,
  };

  const canonical = (aliases: Record<string, string>, raw: string) => aliases[raw] ?? raw;
  const aliasesOf = (aliases: Record<string, string>, name: string) =>
    Object.keys(aliases).filter((raw) => aliases[raw] === name);

  const departments: Department[] = distinct(
    rows.map((r) => canonical(DEPARTMENT_ALIASES, r.department)),
  )
    .sort()
    .map((name) => ({
      ...versioned(k(`department:${name}`), firmId),
      clientId: client.id,
      name,
      aliases: aliasesOf(DEPARTMENT_ALIASES, name),
    }));
  const categories: Category[] = distinct(rows.map((r) => canonical(CATEGORY_ALIASES, r.category)))
    .sort()
    .map((name) => ({
      ...versioned(k(`category:${name}`), firmId),
      name,
      aliases: aliasesOf(CATEGORY_ALIASES, name),
    }));
  const acts: Act[] = distinct(rows.map((r) => canonical(ACT_ALIASES, r.act)))
    .sort()
    .map((name) => {
      const state = name.startsWith('West Bengal');
      return {
        ...versioned(k(`act:${name}`), firmId),
        name,
        shortName: null,
        jurisdiction: state ? 'STATE' : 'CENTRAL',
        stateCode: state ? 'WB' : null,
        aliases: aliasesOf(ACT_ALIASES, name),
      };
    });
  const byName = <T extends { name: string; id: string }>(list: T[], name: string) =>
    list.find((item) => item.name === name)!.id;

  const people: Person[] = [...pseudonym.values()].map((displayName) => ({
    ...versioned(k(`person:${normalise(displayName)}`), firmId),
    displayName,
    nameNormalized: normalise(displayName),
    email: null,
    status: 'UNCLAIMED',
  }));
  const staff: Person[] = [
    ['Firm Admin', 'admin@demo-advisory.example'],
    ['Consultant 01', 'consultant01@demo-advisory.example'],
  ].map(([displayName, email]) => ({
    ...versioned(k(`person:${normalise(displayName!)}`), firmId),
    displayName: displayName!,
    nameNormalized: normalise(displayName!),
    email: email!,
    status: 'ACTIVE',
  }));
  const membership = (person: Person, role: Membership['role']): Membership => ({
    ...versioned(k(`membership:${person.nameNormalized}:${role}`), firmId),
    personId: person.id,
    role,
    clientId: role === 'FIRM_ADMIN' || role === 'CONSULTANT' ? null : client.id,
    consultantClientIds: role === 'CONSULTANT' ? [client.id] : null,
    unitIds: null,
    expiresAt: null,
  });
  const ownerIds = new Set(owners.map(personId));
  const approverIds = new Set(rows.map((r) => personId(r.approver)));
  const memberships: Membership[] = [
    membership(staff[0]!, 'FIRM_ADMIN'),
    membership(staff[1]!, 'CONSULTANT'),
    ...people.flatMap((p) => [
      ...(ownerIds.has(p.id) ? [membership(p, 'OWNER')] : []),
      ...(approverIds.has(p.id) ? [membership(p, 'APPROVER')] : []),
    ]),
  ];

  const obligations: Obligation[] = [];
  const assignments: Assignment[] = [];
  const instances: ComplianceInstance[] = [];
  const comments: Comment[] = [];
  const dueDates: DueDatesFixture = [];
  const scored: ScoredInstance[] = [];
  const rawScored: ScoredInstance[] = [];
  const findings: ExpectedFixture['findings'] = {
    duplicatePeriods: [],
    compliedWithoutDate: [],
    unparsedExternalRefs: [],
  };
  const keyed = { department: new Map<string, string>(), act: new Map<string, string>() };

  for (const [ref, group] of groupBy(rows, (r) => r.ref)) {
    const first = group[0]!;
    if (!STANDARD_REF.test(ref)) findings.unparsedExternalRefs.push(ref);
    const segments = ref.split('-');
    const domain = segments[0] as ObligationDomain;
    const state = segments[1] === 'WB';
    const dates = distinct(group.map((r) => r.dueDate)).sort();
    const expected = expectRule(first.timeline, dates);
    dueDates.push({
      externalRef: ref,
      timelineType: first.timeline,
      dueDates: dates,
      expectedRule: expected.rule,
      exact: expected.exact,
    });
    const rule = expected.exact ? expected.rule! : fixedDates(dates);
    const obligation: Obligation = {
      ...versioned(`obligation:${ref}`, firmId),
      externalRef: ref,
      domain,
      jurisdiction: state ? 'STATE' : 'CENTRAL',
      stateCode: state ? 'WB' : null,
      actId: byName(acts, canonical(ACT_ALIASES, first.act)),
      categoryId: byName(categories, canonical(CATEGORY_ALIASES, first.category)),
      title: first.title,
      description: first.description,
      applicabilityText: first.applicability,
      criticality: first.criticality,
      timelineType: first.timeline,
      recurrenceRule: rule,
      ruleStatus: 'TO_REVIEW',
      evidenceRequired: false,
      forms: templates(first.form),
      logSheets: templates(first.logSheet),
      libraryVersion: 1,
    };
    obligations.push(obligation);
    const departmentId = byName(departments, canonical(DEPARTMENT_ALIASES, first.department));
    const assignment: Assignment = {
      ...versioned(`assignment:${ref}`, firmId),
      clientId: client.id,
      unitId: unit.id,
      obligationId: obligation.id,
      departmentId,
      defaultOwnerId: personId(first.owner),
      defaultApproverId: personId(first.approver),
      applicability: 'APPLICABLE',
      naReason: null,
      activeFrom: '2022-04-01',
      activeTo: null,
    };
    assignments.push(assignment);

    const periods = periodsFor(rule, first.timeline, dates);
    for (const [index, date] of dates.entries()) {
      const [row, ...folded] = group.filter((r) => r.dueDate === date);
      const kept = row!;
      const instanceKey = `instance:${ref}:${date}`;
      let completedOn = kept.state === 'OPEN' ? null : kept.activityDate;
      if (kept.state === 'APPROVED' && completedOn === null) {
        findings.compliedWithoutDate.push({ externalRef: ref, dueDate: date });
        completedOn = date;
      }
      const instance: ComplianceInstance = {
        ...versioned(instanceKey, firmId),
        clientId: client.id,
        unitId: unit.id,
        assignmentId: assignment.id,
        ...periods[index]!,
        dueDate: date,
        workflowState: kept.state,
        pendingKind: null,
        completedOn,
        naReason: kept.state === 'NOT_APPLICABLE' ? kept.ownerComment : null,
        ownerId: personId(kept.owner),
        approverId: personId(kept.approver),
        submittedAt: null,
        approvedAt: null,
        dueDateOverridden: false,
      };
      instances.push(instance);
      const forScore = {
        id: instance.id,
        dueDate: date,
        workflowState: kept.state,
        completedOn,
        criticality: obligation.criticality,
      };
      scored.push(forScore);
      rawScored.push(forScore);
      keyed.department.set(instance.id, departmentId);
      keyed.act.set(instance.id, obligation.actId);

      const notes: string[] = [];
      if (kept.ownerComment !== null) notes.push(kept.ownerComment);
      for (const other of folded) {
        findings.duplicatePeriods.push({ externalRef: ref, dueDate: date });
        rawScored.push({ ...forScore, id: fixtureId(`raw-row:${other.rowNumber}`) });
        notes.push(
          `Duplicate row ${other.rowNumber} folded on import (department "${other.department}", ` +
            `activity date ${other.activityDate ?? 'none'})` +
            (other.ownerComment === null ? '.' : `: ${other.ownerComment}`),
        );
      }
      notes.forEach((body, n) =>
        comments.push({
          ...base(`comment:${ref}:${date}:${n + 1}`, firmId),
          instanceId: instance.id,
          clientId: client.id,
          authorId: null,
          kind: 'IMPORT',
          body,
        }),
      );
    }
  }

  assertNoNames(
    [
      ...comments.map((c) => c.body),
      ...obligations.flatMap((o) => [
        o.title,
        o.description,
        ...[...o.forms, ...o.logSheets].map((t) => t.label),
      ]),
    ],
    [...pseudonym.keys()],
  );

  const sample: FixtureSet = {
    source: `${sourceName}, recommended profile`,
    firm: {
      ...versioned('firm-a', firmId),
      name: 'Demo Advisory',
      settings: DEFAULT_FIRM_SETTINGS,
    },
    clients: [client],
    companies: [company],
    locations: [location],
    units: [unit],
    departments,
    people: [...staff, ...people],
    memberships,
    acts,
    categories,
    obligations,
    assignments,
    instances,
    evidence: [],
    comments,
    auditEvents: [],
  };

  const countStates = (list: ScoredInstance[]) => {
    const counts = { OPEN: 0, SUBMITTED: 0, SENT_BACK: 0, APPROVED: 0, NOT_APPLICABLE: 0 };
    for (const i of list) counts[i.workflowState] += 1;
    return counts;
  };
  const profile = (
    list: ScoredInstance[],
    counts: Omit<ExpectedProfile['counts'], 'workflowStates' | 'instances'>,
  ): ExpectedProfile => ({
    counts: { ...counts, instances: list.length, workflowStates: countStates(list) },
    scores: AS_OF_DATES.map((asOf) => score(list, asOf)),
  });

  const breakdown = (
    by: 'department' | 'act' | 'criticality',
    keyOf: (i: ScoredInstance) => string,
    labelOf: (key: string) => string,
  ) =>
    AS_OF_DATES.map((asOf) => ({
      asOf,
      by,
      rows: [...groupBy(scored, keyOf)]
        .map(([key, list]) => ({ key, label: labelOf(key), result: score(list, asOf) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    }));
  const nameOf = (list: { id: string; name: string }[]) => (id: string) =>
    list.find((item) => item.id === id)!.name;

  const expected: ExpectedFixture = {
    profiles: {
      raw: profile(rawScored, {
        obligations: obligations.length,
        acts: distinct(rows.map((r) => r.act)).length,
        categories: distinct(rows.map((r) => r.category)).length,
        departments: distinct(rows.map((r) => r.department)).length,
        people: pseudonym.size,
        assignments: distinct(rows.map((r) => `${r.ref}|${r.department}`)).length,
      }),
      recommended: profile(scored, {
        obligations: obligations.length,
        acts: acts.length,
        categories: categories.length,
        departments: departments.length,
        people: pseudonym.size,
        assignments: assignments.length,
      }),
    },
    instanceIds: AS_OF_DATES.map((asOf) => ({ asOf, ids: statusIds(scored, asOf) })),
    breakdowns: [
      ...breakdown('department', (i) => keyed.department.get(i.id)!, nameOf(departments)),
      ...breakdown('act', (i) => keyed.act.get(i.id)!, nameOf(acts)),
      ...breakdown(
        'criticality',
        (i) => i.criticality,
        (key) => key,
      ),
    ],
    findings,
  };

  return { sample, dueDates, expected };
}
