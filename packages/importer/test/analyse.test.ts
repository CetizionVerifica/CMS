import { describe, expect, it } from 'vitest';
import type { InferredRule } from '@canopy/contracts';
import { suggestMapping } from '../src/mapping.js';
import type { RawCell, SourceSheet } from '../src/read.js';
import { dryRun } from '../src/dry-run.js';
import { EMPTY_STATE, type Decisions, type DraftIssue, type ImportAnalysis } from '../src/types.js';
import { analyse } from './helpers.js';

/** Synthetic registers in the sample's 19-column layout. Names are invented. */
const HEADERS = [
  'EY Compliance ID',
  'Compliance Title',
  'Type (TimeLine)',
  'Compliance Description',
  'Compliance Categorization',
  'Applicability',
  'Act',
  'Activity Date',
  'Compliance Status',
  'Due Date',
  'Form Description',
  'Log Sheet Description',
  'Organization',
  'Location',
  'Owner',
  'Owner Comments',
  'Approvers',
  'Department',
  'Criticality',
] as const;
type Header = (typeof HEADERS)[number];

const BASE: Record<Header, RawCell> = {
  'EY Compliance ID': 'HRS-WB-001-0001-00001',
  'Compliance Title': 'Annual return',
  'Type (TimeLine)': 'Time Based',
  'Compliance Description': 'File the annual return.',
  'Compliance Categorization': 'Filings / Returns',
  Applicability: 'Every factory',
  Act: 'Factories Act, 1948 and West Bengal Factories Rules, 1958',
  'Activity Date': '2022-04-20',
  'Compliance Status': 'Complied',
  'Due Date': '2022-04-30',
  'Form Description': 'Form XIV',
  'Log Sheet Description': null,
  Organization: 'Sample Group/ Sample Co/ Plant',
  Location: 'India/ West Bengal/ Kolkata',
  Owner: 'Asha Rao',
  'Owner Comments': 'Done',
  Approvers: 'Vikram Shah',
  Department: 'Human Resources',
  Criticality: 'High',
};

function sheetOf(...rows: Partial<Record<Header, RawCell>>[]): SourceSheet {
  return {
    name: 'Sheet',
    headers: [...HEADERS],
    rows: rows.map((row, i) => ({ rowNumber: i + 2, cells: { ...BASE, ...row } })),
  };
}

function only(analysis: ImportAnalysis, type: DraftIssue['type']): DraftIssue {
  const found = analysis.issues.filter((issue) => issue.type === type);
  expect(found).toHaveLength(1);
  return found[0] as DraftIssue;
}

function decide(
  issue: DraftIssue,
  decision: 'ACCEPTED' | 'REJECTED' | 'EDITED',
  editedValue: string | null = null,
): Decisions {
  return { [issue.groupKey]: { decision, editedValue } };
}

describe('required values', () => {
  it('blocks a row with a missing value until it is edited or the row is skipped', () => {
    const sheet = sheetOf(
      {},
      { 'Compliance Title': '  ', 'EY Compliance ID': 'HRS-WB-001-0001-00002' },
    );
    const first = analyse(sheet);
    const missing = only(first, 'MISSING_REQUIRED');
    expect(missing).toMatchObject({ field: 'title', severity: 'ERROR', rowNumbers: [3] });
    expect(first.rows.map((r) => r.outcome)).toEqual(['PENDING', 'ERROR']);
    expect(dryRun(first, EMPTY_STATE).report.blockingErrors).toBe(1);

    const edited = analyse(sheet, { decisions: decide(missing, 'EDITED', 'Half-yearly return') });
    expect(edited.plan.obligations.map((o) => o.title)).toEqual([
      'Annual return',
      'Half-yearly return',
    ]);

    const skipped = analyse(sheet, { decisions: decide(missing, 'REJECTED') });
    expect(skipped.rows.map((r) => r.outcome)).toEqual(['PENDING', 'SKIPPED']);
    expect(dryRun(skipped, EMPTY_STATE).report.skippedRows).toBe(1);
  });

  it('asks for missing enum and date values', () => {
    const analysis = analyse(
      sheetOf({ Criticality: null, 'Due Date': null, 'Type (TimeLine)': '' }),
    );
    const fields = analysis.issues.filter((i) => i.type === 'MISSING_REQUIRED').map((i) => i.field);
    expect(fields.sort()).toEqual(['criticality', 'dueDate', 'timelineType']);
    const decisions: Decisions = {};
    for (const issue of analysis.issues) {
      const value = { criticality: 'low', dueDate: '30/04/2022', timelineType: 'On Going' }[
        issue.field as 'criticality'
      ];
      decisions[issue.groupKey] = { decision: 'EDITED', editedValue: value };
    }
    const fixed = analyse(sheetOf({ Criticality: null, 'Due Date': null, 'Type (TimeLine)': '' }), {
      decisions,
    });
    expect(fixed.plan.obligations[0]).toMatchObject({
      criticality: 'LOW',
      timelineType: 'ONGOING',
    });
    expect(fixed.plan.instances[0]?.dueDate).toBe('2022-04-30');
  });

  it('flags unknown enum values and invalid dates as errors', () => {
    const sheet = sheetOf({
      Criticality: 'Severe',
      'Due Date': '31/04/2022',
      'Activity Date': 'yesterday',
    });
    const analysis = analyse(sheet);
    expect(analysis.issues.map((i) => [i.type, i.field, i.rawValues]).sort()).toEqual([
      ['INVALID_DATE', 'completedOn', ['yesterday']],
      ['INVALID_DATE', 'dueDate', ['31/04/2022']],
      ['UNKNOWN_ENUM', 'criticality', ['Severe']],
    ]);
    const decisions: Decisions = {};
    for (const issue of analysis.issues) {
      const value = issue.field === 'criticality' ? 'Critical' : '2022-04-29';
      decisions[issue.groupKey] = { decision: 'EDITED', editedValue: value };
    }
    const fixed = analyse(sheet, { decisions });
    expect(fixed.plan.instances[0]).toMatchObject({
      dueDate: '2022-04-29',
      completedOn: '2022-04-29',
    });
    expect(fixed.plan.obligations[0]?.criticality).toBe('CRITICAL');
  });
});

describe('status rules', () => {
  it('asks a person about a pending row with an activity date instead of dropping the date', () => {
    const sheet = sheetOf({ 'Compliance Status': 'Pending', 'Activity Date': '2022-04-01' });
    const first = analyse(sheet);
    const issue = only(first, 'UNKNOWN_ENUM');
    expect(issue).toMatchObject({ field: 'status', proposal: null, rowNumbers: [2] });
    expect(first.rows[0]?.outcome).toBe('ERROR');
    expect(dryRun(first, EMPTY_STATE).report.blockingErrors).toBe(1);

    const pending = analyse(sheet, { decisions: decide(issue, 'EDITED', 'Pending') });
    expect(pending.plan.instances[0]).toMatchObject({ workflowState: 'OPEN', completedOn: null });
    expect(pending.plan.instances[0]?.comments).toContain(
      'The register gave an activity date of 2022-04-01 for this pending item; it was kept pending on review.',
    );
    const complied = analyse(sheet, { decisions: decide(issue, 'EDITED', 'Complied') });
    expect(complied.plan.instances[0]).toMatchObject({
      workflowState: 'APPROVED',
      completedOn: '2022-04-01',
    });
    const skipped = analyse(sheet, { decisions: decide(issue, 'REJECTED') });
    expect(skipped.rows[0]?.outcome).toBe('SKIPPED');
  });

  it('never loses a row to an edit that does not parse', () => {
    const sheet = sheetOf({ Criticality: null, Location: 'Narnia' });
    const analysis = analyse(sheet);
    const decisions: Decisions = {};
    for (const issue of analysis.issues) {
      decisions[issue.groupKey] = {
        decision: 'EDITED',
        editedValue: issue.field === 'criticality' ? 'banana' : 'Still Narnia',
      };
    }
    const after = analyse(sheet, { decisions });
    expect(after.rows[0]?.outcome).toBe('ERROR');
    const { report } = dryRun(after, EMPTY_STATE);
    expect(report.blockingErrors + report.skippedRows + report.create.instances).toBe(1);
  });

  it('lets a person enter or refuse the missing completion date', () => {
    const sheet = sheetOf({ 'Activity Date': null });
    const issue = only(analyse(sheet), 'COMPLIED_WITHOUT_DATE');
    const edited = analyse(sheet, { decisions: decide(issue, 'EDITED', '2022-04-25') });
    expect(edited.plan.instances[0]).toMatchObject({ completedOn: '2022-04-25' });
    expect(edited.plan.instances[0]?.comments).toContain(
      'Completion date entered on import: the register gave none.',
    );
    const refused = analyse(sheet, { decisions: decide(issue, 'REJECTED') });
    expect(refused.plan.instances).toEqual([]);
  });

  it('needs a reason and a date for Not Applicable', () => {
    const sheet = sheetOf({
      'Compliance Status': 'Not Applicable',
      'Owner Comments': null,
      'Activity Date': null,
    });
    const analysis = analyse(sheet);
    const issues = analysis.issues.filter((i) => i.type === 'MISSING_REQUIRED');
    expect(issues.map((i) => i.field).sort()).toEqual(['completedOn', 'ownerComment']);
    expect(analysis.rows[0]?.outcome).toBe('ERROR');

    const decisions: Decisions = {};
    for (const issue of issues) {
      decisions[issue.groupKey] = {
        decision: 'EDITED',
        editedValue: issue.field === 'completedOn' ? '2022-04-15' : 'No migrant workers employed',
      };
    }
    const fixed = analyse(sheet, { decisions });
    expect(fixed.plan.instances[0]).toMatchObject({
      workflowState: 'NOT_APPLICABLE',
      completedOn: '2022-04-15',
      naReason: 'No migrant workers employed',
    });

    const skip: Decisions = {};
    for (const issue of issues) skip[issue.groupKey] = { decision: 'REJECTED', editedValue: null };
    expect(analyse(sheet, { decisions: skip }).rows[0]?.outcome).toBe('SKIPPED');
  });
});

describe('templates, paths and references', () => {
  it('turns placeholders into nothing and file names into unattached templates', () => {
    const analysis = analyse(
      sheetOf({ 'Form Description': 'N/A', 'Log Sheet Description': 'Washing Facilities.xlsx' }),
    );
    expect(analysis.plan.obligations[0]).toMatchObject({
      forms: [],
      logSheets: [
        {
          label: 'Washing Facilities.xlsx',
          fileName: 'Washing Facilities.xlsx',
          templateFileId: null,
        },
      ],
    });
    expect(analysis.issues.map((i) => i.type).sort()).toEqual([
      'FILE_NOT_ATTACHED',
      'NULL_PLACEHOLDER',
    ]);
    expect(analysis.rows[0]?.mapped.forms).toBe(null);
  });

  it('asks for a usable organisation and location path', () => {
    const sheet = sheetOf({ Organization: 'Plant only', Location: 'Atlantis/ Somewhere' });
    const analysis = analyse(sheet);
    const types = analysis.issues.map((i) => [i.type, i.field]).sort();
    expect(types).toEqual([
      ['MISSING_REQUIRED', 'organizationPath'],
      ['UNKNOWN_ENUM', 'locationPath'],
    ]);
    const decisions: Decisions = {};
    for (const issue of analysis.issues) {
      decisions[issue.groupKey] = {
        decision: 'EDITED',
        editedValue: issue.field === 'organizationPath' ? 'Sample Co/ Plant' : 'India/ Goa/ Panaji',
      };
    }
    const fixed = analyse(sheet, { decisions });
    expect(fixed.plan.units[0]?.name).toBe('Plant');
    expect(fixed.plan.locations[0]).toMatchObject({
      state: 'Goa',
      stateCode: 'GA',
      city: 'Panaji',
    });

    const blank = analyse(sheetOf({ Organization: null, Location: null }));
    expect(blank.issues.filter((i) => i.type === 'MISSING_REQUIRED')).toHaveLength(2);
  });

  it('reads domain and jurisdiction from the ID, else from the Act', () => {
    const analysis = analyse(
      sheetOf(
        { 'EY Compliance ID': 'TAX-CL-033-6067-60218', Act: 'Income Tax Act, 1961' },
        { 'EY Compliance ID': 'EHS-ZZ-001-0001-00001', Act: 'Income Tax Act, 1961' },
        { 'EY Compliance ID': 'ABC-1', Act: 'West Bengal Fire Services Act 1950' },
      ),
    );
    expect(analysis.plan.obligations.map((o) => [o.domain, o.jurisdiction, o.stateCode])).toEqual([
      ['TAX', 'CENTRAL', null],
      ['EHS', 'CENTRAL', null],
      ['OTHER', 'STATE', 'WB'],
    ]);
    expect(analysis.issues.filter((i) => i.type === 'UNPARSED_EXTERNAL_REF')).toHaveLength(2);
  });

  it('groups rows by (Act, Title, Unit) when there is no ID column', () => {
    const sheet = sheetOf({}, { 'Due Date': '2022-10-31' }, { 'Compliance Title': 'Other return' });
    const mapping = suggestMapping(sheet.headers).map((m) =>
      m.field === 'externalRef' ? { ...m, field: null } : m,
    );
    const analysis = analyse(sheet, { mapping });
    expect(analysis.plan.obligations).toHaveLength(2);
    expect(analysis.plan.obligations[0]).toMatchObject({ externalRef: null, domain: 'OTHER' });
    expect(analysis.rows[0]?.mapped).not.toHaveProperty('externalRef');
  });
});

describe('aliases against the library', () => {
  it('resolves accepted aliases silently and proposes the library name for new spellings', () => {
    const sheet = sheetOf({ Department: 'HR', 'Compliance Categorization': 'Filing / Return' });
    const analysis = analyse(sheet, {
      existing: {
        ...EMPTY_STATE,
        departments: [{ name: 'Human Resources', aliases: ['HR'] }],
        categories: [{ name: 'Filings / Returns', aliases: [] }],
      },
    });
    const category = only(analysis, 'ALIAS_CATEGORY');
    expect(category).toMatchObject({
      rawValues: ['Filing / Return'],
      proposal: 'Filings / Returns',
    });
    expect(analysis.issues.some((i) => i.type === 'ALIAS_DEPARTMENT')).toBe(false);
    expect(analysis.plan.assignments[0]?.department).toBe('Human Resources');
  });

  it('merges into an edited name, or keeps spellings apart when rejected', () => {
    const sheet = sheetOf({}, { Department: 'HR', 'EY Compliance ID': 'HRS-WB-001-0001-00002' });
    const issue = only(analyse(sheet), 'ALIAS_DEPARTMENT');
    const edited = analyse(sheet, { decisions: decide(issue, 'EDITED', 'People  Team') });
    expect(edited.plan.departments).toEqual([
      { name: 'People Team', aliases: ['Human Resources', 'HR'] },
    ]);
    const rejected = analyse(sheet, { decisions: decide(issue, 'REJECTED') });
    expect(rejected.plan.departments.map((d) => d.name)).toEqual(['Human Resources', 'HR']);
  });

  it('merges a principal Act pair only when a person picks the name', () => {
    const sheet = sheetOf(
      {},
      { Act: 'Factories Act , 1948', 'EY Compliance ID': 'HRS-WB-001-0001-00002' },
    );
    const issue = only(analyse(sheet), 'ALIAS_ACT');
    expect(issue.proposal).toBe(null);
    const merged = analyse(sheet, {
      decisions: decide(
        issue,
        'EDITED',
        'Factories Act, 1948 and West Bengal Factories Rules, 1958',
      ),
    });
    expect(merged.plan.acts).toEqual([
      {
        name: 'Factories Act, 1948 and West Bengal Factories Rules, 1958',
        aliases: ['Factories Act , 1948'],
        jurisdiction: 'STATE',
        stateCode: 'WB',
      },
    ]);
  });
});

describe('people', () => {
  it('flags near matches and merges only into the name a person picks', () => {
    const sheet = sheetOf({}, { Owner: 'Asha Raoo', 'EY Compliance ID': 'HRS-WB-001-0001-00002' });
    const issue = only(analyse(sheet), 'PERSON_NEAR_MATCH');
    expect(issue.rawValues).toEqual(['Asha Rao', 'Asha Raoo']);
    expect(analyse(sheet).plan.people).toHaveLength(3);
    const merged = analyse(sheet, { decisions: decide(issue, 'EDITED', 'Asha Rao') });
    expect(merged.plan.people.map((p) => p.displayName).sort()).toEqual([
      'Asha Rao',
      'Vikram Shah',
    ]);
    expect(merged.rows[1]?.mapped.owner).toBe('Asha Rao');
  });

  it('checks near matches against people the firm already has', () => {
    const sheet = sheetOf({ Owner: 'asha raoo' });
    const existing = {
      ...EMPTY_STATE,
      people: [
        { nameNormalized: 'asha rao', displayName: 'Asha Rao' },
        { nameNormalized: 'vikram shah', displayName: 'Vikram Shah' },
      ],
    };
    const issue = only(analyse(sheet, { existing }), 'PERSON_NEAR_MATCH');
    const merged = analyse(sheet, { existing, decisions: decide(issue, 'EDITED', 'Asha Rao') });
    expect(merged.plan.people.map((p) => p.nameNormalized).sort()).toEqual([
      'asha rao',
      'vikram shah',
    ]);
    expect(dryRun(merged, existing).report.create.people).toBe(0);
  });
});

describe('periods, conflicts and rules', () => {
  it('drops a repeated period without a comment when the fold is rejected', () => {
    const sheet = sheetOf({}, { 'Owner Comments': 'Again' });
    const issue = only(analyse(sheet), 'DUPLICATE_PERIOD');
    const rejected = analyse(sheet, { decisions: decide(issue, 'REJECTED') });
    expect(rejected.plan.instances).toHaveLength(1);
    expect(rejected.plan.instances[0]?.comments).toEqual(['Done']);
    expect(rejected.rows.map((r) => [r.outcome, r.instanceKey === null])).toEqual([
      ['PENDING', false],
      ['SKIPPED', true],
    ]);
  });

  it('keeps the first value of a conflicting obligation field and lists the others', () => {
    const analysis = analyse(
      sheetOf({}, { 'Due Date': '2022-10-31', Criticality: 'Low', Owner: 'Ravi Kumar' }),
    );
    const conflicts = analysis.issues.filter((i) => i.type === 'CONFLICTING_OBLIGATION_VALUE');
    expect(conflicts.map((i) => [i.field, i.rawValues, i.proposal])).toEqual([
      ['criticality', ['HIGH', 'LOW'], 'HIGH'],
      ['owner', ['Asha Rao', 'Ravi Kumar'], 'Asha Rao'],
    ]);
    expect(analysis.plan.obligations[0]?.criticality).toBe('HIGH');
    expect(analysis.plan.instances.map((i) => i.owner)).toEqual(['asha rao', 'ravi kumar']);
  });

  it('confirms a sure rule and marks an unsure one for review', () => {
    const sure: InferredRule = {
      rule: { kind: 'ANNUAL', month: 4, day: 30 },
      confidence: 1,
      mismatches: [],
    };
    const confirmed = analyse(sheetOf({}), { inferRule: () => sure });
    expect(confirmed.plan.obligations[0]).toMatchObject({
      ruleStatus: 'CONFIRMED',
      recurrenceRule: sure.rule,
    });
    const unsure = analyse(sheetOf({}), { inferRule: () => ({ ...sure, confidence: 0.4 }) });
    expect(unsure.plan.obligations[0]?.ruleStatus).toBe('TO_REVIEW');
    expect(only(unsure, 'RULE_LOW_CONFIDENCE').rawValues).toEqual(['2022-04-30']);
  });

  it('tells inferRule the whole FYs the register covers, once per distinct schedule', () => {
    const calls: unknown[][] = [];
    const sure: InferredRule = {
      rule: { kind: 'ANNUAL', month: 4, day: 30 },
      confidence: 1,
      mismatches: [],
    };
    const sheet = sheetOf(
      { 'EY Compliance ID': 'HRS-WB-001-0001-00001', 'Due Date': '2022-04-30' },
      { 'EY Compliance ID': 'HRS-WB-001-0001-00002', 'Due Date': '2022-04-30' },
      { 'EY Compliance ID': 'HRS-WB-001-0001-00003', 'Due Date': '2023-05-15' },
    );
    const analysis = analyse(sheet, {
      inferRule: (...args) => {
        calls.push(args);
        return sure;
      },
    });
    const coverage = { from: '2022-04-01', to: '2024-03-31' };
    expect(analysis.plan.coverage).toEqual(coverage);
    expect(analysis.plan.obligations).toHaveLength(3);
    expect(calls).toEqual([
      [['2022-04-30'], 'TIME_BASED', { fyStartMonth: 4, holidayPolicy: 'NONE' }, { coverage }],
      [['2023-05-15'], 'TIME_BASED', { fyStartMonth: 4, holidayPolicy: 'NONE' }, { coverage }],
    ]);

    const given = { from: '2022-01-01', to: '2023-12-31' } as typeof coverage;
    const override = analyse(sheet, {
      coverage: given as never,
      inferRule: (...args) => {
        expect(args[3]).toEqual({ coverage: given });
        return sure;
      },
    });
    expect(override.plan.coverage).toEqual(given);
  });

  it('has no coverage when no row can be planned', () => {
    const analysis = analyse(sheetOf({ 'Due Date': null }));
    expect(analysis.plan.coverage).toBeNull();
  });
});

describe('dry run against an existing client', () => {
  it('reports updates when values changed since the last import', () => {
    const first = analyse(sheetOf({}));
    const before = {
      ...EMPTY_STATE,
      obligations: { [first.plan.obligations[0]?.key ?? '']: 'old' },
      assignments: { [first.plan.assignments[0]?.key ?? '']: 'old' },
      instances: { [first.plan.instances[0]?.key ?? '']: 'old' },
    };
    const second = analyse(sheetOf({}), { existing: before });
    expect(second.plan.obligations[0]?.inferred).toBe(null);
    const { report, rows } = dryRun(second, before);
    expect(report.update).toEqual({ obligations: 1, assignments: 1, instances: 1 });
    expect(rows[0]?.outcome).toBe('UPDATE');
  });
});
