import { beforeAll, describe, expect, it } from 'vitest';
import { recommendedDecisions } from '../src/decisions.js';
import { dryRun, stateAfterCommit } from '../src/dry-run.js';
import { suggestMapping, validateMapping } from '../src/mapping.js';
import type { SourceSheet } from '../src/read.js';
import { EMPTY_STATE, type Decisions, type ImportAnalysis } from '../src/types.js';
import { analyse, loadSheet } from './helpers.js';

/**
 * Golden test on the sample register (docs/contracts/fixtures.md §2, §3 and §5 "M8").
 * The fixture is the client's register with owner and approver names replaced by pseudonyms
 * (fixtures/README.md); every other cell is the original.
 */

let sheet: SourceSheet;
let pending: ImportAnalysis;

/** "raw" profile: no merge accepted; every other default proposal accepted. */
function rawDecisions(analysis: ImportAnalysis): Decisions {
  const decisions = recommendedDecisions(analysis.issues);
  for (const issue of analysis.issues) {
    if (issue.type.startsWith('ALIAS_')) {
      decisions[issue.groupKey] = { decision: 'REJECTED', editedValue: null };
    }
  }
  return decisions;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

beforeAll(async () => {
  sheet = await loadSheet('sample-register.xlsx');
  pending = analyse(sheet);
});

describe('sample register: reading and mapping', () => {
  it('reads 424 data rows under 19 headers', () => {
    expect(sheet.rows).toHaveLength(424);
    expect(sheet.headers).toHaveLength(19);
    expect(sheet.rows[0]?.rowNumber).toBe(2);
  });

  it('maps all 19 sample headers one to one', () => {
    const mapping = suggestMapping(sheet.headers);
    expect(mapping.every((entry) => entry.field !== null)).toBe(true);
    expect(new Set(mapping.map((entry) => entry.field)).size).toBe(19);
    expect(validateMapping(mapping, sheet.headers)).toEqual([]);
  });
});

describe('sample register: issues before review', () => {
  it('raises the expected issue groups', () => {
    const byType = countBy(
      pending.issues.filter((issue) => issue.type !== 'RULE_LOW_CONFIDENCE'),
      (issue) => issue.type,
    );
    expect(byType).toEqual({
      ALIAS_ACT: 2,
      ALIAS_CATEGORY: 2,
      ALIAS_DEPARTMENT: 1,
      COMPLIED_WITHOUT_DATE: 1,
      CONFLICTING_OBLIGATION_VALUE: 2,
      DUPLICATE_PERIOD: 2,
      ENUM_NORMALISED: 1,
      FILE_NOT_ATTACHED: 14,
      NULL_PLACEHOLDER: 2,
      PERSON_CASE_MERGE: 13,
      UNPARSED_EXTERNAL_REF: 6,
    });
    expect(pending.counts.errors).toBe(0);
  });

  it('normalises the four "HIGH" rows and proposes one ALIAS per spelling family', () => {
    const high = pending.issues.find((issue) => issue.type === 'ENUM_NORMALISED');
    expect(high).toMatchObject({ field: 'criticality', rawValues: ['HIGH'], proposal: 'HIGH' });
    expect(high?.rowNumbers).toHaveLength(4);

    const department = pending.issues.find((issue) => issue.type === 'ALIAS_DEPARTMENT');
    expect(department).toMatchObject({
      rawValues: ['Human Resources', 'HR'],
      proposal: 'Human Resources',
      decision: 'PENDING',
    });
    const categories = pending.issues
      .filter((issue) => issue.type === 'ALIAS_CATEGORY')
      .map((issue) => issue.proposal);
    expect(categories.sort()).toEqual(['Procedural Requirement', 'Statutory Records']);
  });

  it('offers the Factories Act pair without a proposal and merges the Petroleum spellings', () => {
    const acts = pending.issues.filter((issue) => issue.type === 'ALIAS_ACT');
    const factories = acts.find((issue) => issue.proposal === null);
    expect(factories?.rawValues).toEqual([
      'Factories Act , 1948',
      'Factories Act, 1948 and West Bengal Factories Rules, 1958',
    ]);
    const petroleum = acts.find((issue) => issue.proposal !== null);
    expect(petroleum?.rawValues).toHaveLength(4);
    expect(petroleum?.proposal).toBe('Petroleum Act, 1934 read with Petroleum Rules 2002');
  });

  it('lists the six IDs that do not follow the 5-part pattern', () => {
    const refs = pending.issues
      .filter((issue) => issue.type === 'UNPARSED_EXTERNAL_REF')
      .flatMap((issue) => issue.rawValues)
      .sort();
    expect(refs).toEqual([
      'ENV-117-0031',
      'INT-FA-1-1',
      'INT-H-047-0016',
      'INT-H-048-0002',
      'INT-H-050-0002',
      'INT-H-056-0001',
    ]);
  });

  it('flags the one Complied row without an Activity Date', () => {
    const issue = pending.issues.find((i) => i.type === 'COMPLIED_WITHOUT_DATE');
    expect(issue?.rowNumbers).toHaveLength(1);
    const row = pending.rows.find((r) => r.rowNumber === issue?.rowNumbers[0]);
    expect(row?.mapped.externalRef).toBe('ENV-117-0031');
  });

  it('finds no near-match people and keeps raw values beside cleaned ones', () => {
    expect(pending.issues.some((issue) => issue.type === 'PERSON_NEAR_MATCH')).toBe(false);
    const row = pending.rows[0];
    expect(row?.raw['Criticality']).toBe('High');
    expect(row?.mapped.criticality).toBe('HIGH');
    expect(row?.raw['Due Date']).toBe('2022-04-07');
  });
});

describe('sample register: raw profile', () => {
  it('matches fixtures.md §3 "raw"', () => {
    const analysis = analyse(sheet, { decisions: rawDecisions(pending) });
    const { plan } = analysis;
    expect(plan.obligations).toHaveLength(119);
    expect(plan.instances).toHaveLength(424);
    expect(plan.acts).toHaveLength(36);
    expect(plan.categories).toHaveLength(12);
    expect(plan.departments).toHaveLength(10);
    expect(plan.people).toHaveLength(21);
    expect(plan.assignments).toHaveLength(121);
    expect(countBy(plan.instances, (i) => i.workflowState)).toEqual({
      APPROVED: 211,
      OPEN: 201,
      NOT_APPLICABLE: 12,
    });
    expect(analysis.issues.some((issue) => issue.type === 'DUPLICATE_PERIOD')).toBe(false);
  });
});

describe('sample register: recommended profile', () => {
  let recommended: ImportAnalysis;
  beforeAll(() => {
    recommended = analyse(sheet, { decisions: recommendedDecisions(pending.issues) });
  });

  it('matches fixtures.md §3 "recommended"', () => {
    const { plan } = recommended;
    expect(plan.obligations).toHaveLength(119);
    expect(plan.instances).toHaveLength(422);
    expect(plan.acts).toHaveLength(33);
    expect(plan.categories).toHaveLength(10);
    expect(plan.departments).toHaveLength(9);
    expect(plan.people).toHaveLength(21);
    expect(plan.assignments).toHaveLength(119);
    expect(plan.companies).toEqual([{ key: 'hindalco', name: 'Hindalco' }]);
    expect(plan.units).toHaveLength(1);
    expect(plan.locations).toEqual([
      {
        key: 'in|west bengal|belur',
        country: 'India',
        countryCode: 'IN',
        state: 'West Bengal',
        stateCode: 'WB',
        city: 'Belur',
      },
    ]);
    expect(countBy(plan.instances, (i) => i.workflowState)).toEqual({
      APPROVED: 209,
      OPEN: 201,
      NOT_APPLICABLE: 12,
    });
  });

  it('dedupes to 12 owners and 10 approvers', () => {
    expect(new Set(recommended.plan.instances.map((i) => i.owner)).size).toBe(12);
    expect(new Set(recommended.plan.instances.map((i) => i.approver)).size).toBe(10);
  });

  it('has 5 criticality levels and no instance completed after its due date', () => {
    expect(new Set(recommended.plan.obligations.map((o) => o.criticality)).size).toBe(5);
    const late = recommended.plan.instances.filter(
      (i) => i.workflowState === 'APPROVED' && i.completedOn !== null && i.completedOn > i.dueDate,
    );
    expect(late).toEqual([]);
  });

  it('folds the two repeated periods into the first row with an IMPORT comment', () => {
    const folded = recommended.plan.instances.filter((i) => i.rowNumbers.length > 1);
    expect(folded.map((i) => i.dueDate)).toEqual(['2022-04-30', '2022-04-30']);
    for (const instance of folded) {
      expect(instance.comments.at(-1)).toMatch(/^Row \d+ of the import repeated this period/);
    }
  });

  it('uses the due date as completion date for ENV-117-0031, with a comment', () => {
    const assumed = recommended.plan.instances.filter((i) =>
      i.comments.includes('Completion date assumed on import: the register gave none.'),
    );
    expect(assumed).toHaveLength(1);
    expect(assumed[0]?.key).toContain('ref:ENV-117-0031');
    expect(assumed[0]).toMatchObject({ dueDate: '2022-09-30', completedOn: '2022-09-30' });
  });

  it('keeps the NA justification as naReason', () => {
    const na = recommended.plan.instances.filter((i) => i.workflowState === 'NOT_APPLICABLE');
    expect(na).toHaveLength(12);
    expect(na.every((i) => i.naReason !== null && i.completedOn !== null)).toBe(true);
  });

  it('stores accepted spellings as aliases', () => {
    const hr = recommended.plan.departments.find((d) => d.name === 'Human Resources');
    expect(hr?.aliases).toEqual(['HR']);
    const petroleum = recommended.plan.acts.find((a) => a.aliases.length > 0);
    expect(petroleum?.aliases).toHaveLength(3);
  });

  it('dry run on an empty client creates everything and skips the two folded rows', () => {
    const { report, rows } = dryRun(recommended, EMPTY_STATE);
    expect(report).toEqual({
      create: {
        acts: 33,
        categories: 10,
        departments: 9,
        people: 21,
        obligations: 119,
        assignments: 119,
        instances: 422,
        companies: 1,
        units: 1,
        locations: 1,
      },
      update: { obligations: 0, assignments: 0, instances: 0 },
      unchanged: { instances: 0 },
      skippedRows: 2,
      blockingErrors: 0,
    });
    expect(countBy(rows, (r) => r.outcome)).toEqual({ CREATE: 422, SKIPPED: 2 });
  });

  it('is idempotent: a second import creates nothing and reports 422 unchanged', () => {
    const after = stateAfterCommit(recommended, EMPTY_STATE);
    const second = analyse(sheet, { existing: after });
    // Accepted aliases and people are known now, and existing obligations keep their library rule.
    const types = new Set(second.issues.map((issue) => issue.type));
    for (const type of [
      'ALIAS_DEPARTMENT',
      'ALIAS_CATEGORY',
      'PERSON_CASE_MERGE',
      'RULE_LOW_CONFIDENCE',
    ]) {
      expect(types.has(type as never)).toBe(false);
    }
    const reviewed = analyse(sheet, {
      existing: after,
      decisions: recommendedDecisions(second.issues),
    });
    const { report } = dryRun(reviewed, after);
    expect(report.create).toEqual({
      acts: 0,
      categories: 0,
      departments: 0,
      people: 0,
      obligations: 0,
      assignments: 0,
      instances: 0,
      companies: 0,
      units: 0,
      locations: 0,
    });
    expect(report.update).toEqual({ obligations: 0, assignments: 0, instances: 0 });
    expect(report.unchanged.instances).toBe(422);
    expect(stateAfterCommit(reviewed, after)).toEqual(after);
  });
});
