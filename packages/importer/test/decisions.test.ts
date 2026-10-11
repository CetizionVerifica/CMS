import { describe, expect, it } from 'vitest';
import { checkDecision, decisionFor, isReviewed, recommendedDecisions } from '../src/decisions.js';
import type { DraftIssue } from '../src/types.js';

function issue(partial: Partial<DraftIssue> & Pick<DraftIssue, 'type'>): DraftIssue {
  return {
    groupKey: `${partial.type}-x`,
    severity: 'WARNING',
    rowNumbers: [2],
    field: null,
    rawValues: [],
    proposal: null,
    decision: 'PENDING',
    editedValue: null,
    ...partial,
  };
}

describe('checkDecision', () => {
  it('keeps information issues accepted', () => {
    const info = issue({ type: 'ENUM_NORMALISED', severity: 'INFO', proposal: 'HIGH' });
    expect(checkDecision(info, 'ACCEPTED', null)).toBe(null);
    expect(checkDecision(info, 'REJECTED', null)).toMatch(/shown only/);
  });

  it('needs editedValue exactly when EDITED', () => {
    const alias = issue({
      type: 'ALIAS_DEPARTMENT',
      field: 'department',
      proposal: 'Human Resources',
    });
    expect(checkDecision(alias, 'EDITED', null)).toMatch(/exactly/);
    expect(checkDecision(alias, 'ACCEPTED', 'x')).toMatch(/exactly/);
    expect(checkDecision(alias, 'EDITED', 'People Team')).toBe(null);
    expect(checkDecision(alias, 'EDITED', '  ')).toMatch(/blank/);
    expect(checkDecision(alias, 'PENDING', null)).toBe(null);
  });

  it('accepts only issues with a proposal', () => {
    expect(checkDecision(issue({ type: 'PERSON_NEAR_MATCH' }), 'ACCEPTED', null)).toMatch(
      /no proposal/,
    );
    expect(
      checkDecision(issue({ type: 'DUPLICATE_PERIOD', proposal: 'Keep row 2' }), 'ACCEPTED', null),
    ).toBe(null);
  });

  it('never rejects or edits an inferred rule', () => {
    const rule = issue({ type: 'RULE_LOW_CONFIDENCE', proposal: 'TO_REVIEW' });
    expect(checkDecision(rule, 'REJECTED', null)).toMatch(/after the import/);
    expect(checkDecision(rule, 'EDITED', 'x')).toMatch(/cannot be edited/);
    expect(checkDecision(issue({ type: 'DUPLICATE_PERIOD' }), 'REJECTED', null)).toBe(null);
  });

  it('checks edited values by type', () => {
    const near = issue({ type: 'PERSON_NEAR_MATCH', rawValues: ['Person Ana', 'Person Anna'] });
    expect(checkDecision(near, 'EDITED', 'Person Anna')).toBe(null);
    expect(checkDecision(near, 'EDITED', 'Someone')).toMatch(/one of the two/);
    const date = issue({ type: 'COMPLIED_WITHOUT_DATE', field: 'completedOn' });
    expect(checkDecision(date, 'EDITED', '2022-09-30')).toBe(null);
    expect(checkDecision(date, 'EDITED', 'later')).toMatch(/date/);
    const missingDue = issue({ type: 'MISSING_REQUIRED', severity: 'ERROR', field: 'dueDate' });
    expect(checkDecision(missingDue, 'EDITED', 'tomorrow')).toMatch(/date/);
    const missingTitle = issue({ type: 'MISSING_REQUIRED', severity: 'ERROR', field: 'title' });
    expect(checkDecision(missingTitle, 'EDITED', 'Annual return')).toBe(null);
    const unknown = issue({ type: 'UNKNOWN_ENUM', severity: 'ERROR', field: 'criticality' });
    expect(checkDecision(unknown, 'EDITED', 'super  critical')).toBe(null);
    expect(checkDecision(unknown, 'EDITED', 'Severe')).toMatch(/Super Critical/);
    const unknownPath = issue({ type: 'UNKNOWN_ENUM', severity: 'ERROR', field: 'locationPath' });
    expect(checkDecision(unknownPath, 'EDITED', 'India/ Goa')).toBe(null);
  });
});

describe('decisionFor and profiles', () => {
  it('treats a stored decision that is no longer valid as pending', () => {
    const near = issue({ type: 'PERSON_NEAR_MATCH', rawValues: ['A b', 'A c'] });
    expect(
      decisionFor(near, { [near.groupKey]: { decision: 'ACCEPTED', editedValue: null } }),
    ).toEqual({
      decision: 'PENDING',
      editedValue: null,
    });
    expect(
      decisionFor(near, { [near.groupKey]: { decision: 'EDITED', editedValue: 'A c' } }),
    ).toEqual({
      decision: 'EDITED',
      editedValue: 'A c',
    });
  });

  it('builds the recommended profile and knows when review is done', () => {
    const issues = [
      issue({ type: 'ALIAS_ACT', proposal: 'Act' }),
      issue({ type: 'ALIAS_ACT', groupKey: 'ALIAS_ACT-y' }),
      issue({ type: 'UNKNOWN_ENUM', severity: 'ERROR' }),
      issue({ type: 'FILE_NOT_ATTACHED', severity: 'INFO', decision: 'ACCEPTED' }),
    ];
    expect(recommendedDecisions(issues)).toEqual({
      'ALIAS_ACT-x': { decision: 'ACCEPTED', editedValue: null },
      'ALIAS_ACT-y': { decision: 'REJECTED', editedValue: null },
    });
    expect(isReviewed(issues)).toBe(false);
    expect(isReviewed([issues[3] as DraftIssue])).toBe(true);
  });
});
