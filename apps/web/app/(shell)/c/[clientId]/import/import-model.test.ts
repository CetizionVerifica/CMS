import { ImportBatchStatus, ImportIssueType, type ImportIssueGroup } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import {
  acceptableKeys,
  batchHref,
  batchView,
  blockingCount,
  currentStep,
  decisionText,
  dryRunLines,
  duplicateFields,
  FIELD_OPTIONS,
  groupIssues,
  historyItems,
  IGNORE,
  isOpen,
  ISSUE_TITLE,
  issueBucket,
  mappingFromValues,
  rowsText,
  STATUS_LABEL,
} from './import-model';

const CLIENT = '00000000-0000-5000-8000-000000000101';
const BATCH = '00000000-0000-5000-8000-0000000000b1';

const group = (overrides: Partial<ImportIssueGroup> = {}): ImportIssueGroup => ({
  groupKey: 'ALIAS_DEPARTMENT:hr',
  type: 'ALIAS_DEPARTMENT',
  severity: 'WARNING',
  field: 'department',
  rawValues: ['HR', 'Human Resources'],
  proposal: 'Human Resources',
  decision: 'PENDING',
  editedValue: null,
  rowNumbers: [3, 5],
  issueIds: [BATCH],
  ...overrides,
});

describe('batchView', () => {
  it('maps each status to its screen', () => {
    expect(batchView({ status: 'UPLOADED', failureCode: null })).toEqual({ kind: 'map' });
    expect(batchView({ status: 'MAPPED', failureCode: null })).toEqual({ kind: 'map' });
    expect(batchView({ status: 'PARSED', failureCode: null })).toEqual({ kind: 'review' });
    expect(batchView({ status: 'REVIEWED', failureCode: null })).toEqual({ kind: 'review' });
    expect(batchView({ status: 'DRY_RUN_READY', failureCode: null })).toEqual({ kind: 'commit' });
    expect(batchView({ status: 'COMMITTED', failureCode: null })).toEqual({ kind: 'done' });
    expect(batchView({ status: 'COMMITTING', failureCode: null })).toMatchObject({
      kind: 'working',
      step: 'commit',
    });
    expect(batchView({ status: 'CANCELLED', failureCode: null })).toMatchObject({
      kind: 'closed',
      message: 'This import was cancelled. Nothing was changed.',
    });
  });

  it('waits on a parse it started, and reopens the review from the dry run', () => {
    expect(batchView({ status: 'MAPPED', failureCode: null }, { parseStarted: true })).toEqual({
      kind: 'working',
      step: 'map',
      message: 'Reading the rows and checking them…',
    });
    expect(batchView({ status: 'DRY_RUN_READY', failureCode: null }, { wantReview: true })).toEqual(
      { kind: 'review' },
    );
    // A parse that finished shows the review whatever the URL says.
    expect(batchView({ status: 'PARSED', failureCode: null }, { parseStarted: true })).toEqual({
      kind: 'review',
    });
  });

  it('says why a failed import stopped when the API gives a code', () => {
    expect(batchView({ status: 'FAILED', failureCode: 'PARSE_ERROR' })).toEqual({
      kind: 'closed',
      message:
        'This import stopped with an error (PARSE_ERROR). Nothing was changed. Start a new import.',
    });
    expect(batchView({ status: 'FAILED', failureCode: 'PLAN_LIMIT_REACHED' })).toEqual({
      kind: 'closed',
      message:
        'This import would go over your plan’s company or unit limit. Nothing was changed. Ask your account admin.',
    });
    expect(batchView({ status: 'FAILED', failureCode: null })).toMatchObject({
      message: 'This import stopped with an error. Nothing was changed. Start a new import.',
    });
  });

  it('has a screen and a label for every status', () => {
    for (const status of ImportBatchStatus.options) {
      expect(batchView({ status, failureCode: null }).kind).toBeTruthy();
      expect(STATUS_LABEL[status]).toBeTruthy();
    }
  });
});

describe('currentStep and isOpen', () => {
  it('marks the step the screen belongs to', () => {
    expect(currentStep(null)).toBe('upload');
    expect(currentStep({ kind: 'map' })).toBe('map');
    expect(currentStep({ kind: 'working', step: 'map', message: '' })).toBe('map');
    expect(currentStep({ kind: 'review' })).toBe('review');
    expect(currentStep({ kind: 'commit' })).toBe('commit');
    expect(currentStep({ kind: 'done' })).toBe('commit');
    expect(currentStep({ kind: 'closed', message: '' })).toBe('commit');
  });

  it('counts only unfinished imports as open', () => {
    expect(isOpen('MAPPED')).toBe(true);
    expect(isOpen('DRY_RUN_READY')).toBe(true);
    expect(isOpen('COMMITTED')).toBe(false);
    expect(isOpen('CANCELLED')).toBe(false);
    expect(isOpen('FAILED')).toBe(false);
  });
});

describe('mapping', () => {
  it('offers "ignore" first, then every field', () => {
    expect(FIELD_OPTIONS[0]).toEqual({ value: IGNORE, label: 'Ignore this column' });
    expect(FIELD_OPTIONS.every((o) => o.value !== '')).toBe(true);
    expect(FIELD_OPTIONS).toHaveLength(20);
  });

  it('builds the mapping from the form, ignoring unknown values', () => {
    expect(mappingFromValues(['Due Date', 'Notes', 'X'], ['dueDate', IGNORE])).toEqual([
      { sourceHeader: 'Due Date', field: 'dueDate' },
      { sourceHeader: 'Notes', field: null },
      { sourceHeader: 'X', field: null },
    ]);
  });

  it('finds fields mapped from two columns', () => {
    expect(
      duplicateFields([
        { sourceHeader: 'A', field: 'owner' },
        { sourceHeader: 'B', field: 'owner' },
        { sourceHeader: 'C', field: null },
        { sourceHeader: 'D', field: null },
        { sourceHeader: 'E', field: 'title' },
      ]),
    ).toEqual(['owner']);
  });
});

describe('issues', () => {
  it('has words for every issue type', () => {
    for (const type of ImportIssueType.options) expect(ISSUE_TITLE[type]).toBeTruthy();
  });

  it('sorts groups by what the person has to do', () => {
    expect(issueBucket(group({ severity: 'ERROR', type: 'INVALID_DATE' }))).toBe('blocking');
    expect(issueBucket(group())).toBe('decide');
    expect(issueBucket(group({ decision: 'REJECTED' }))).toBe('decided');
    expect(issueBucket(group({ severity: 'INFO', type: 'ENUM_NORMALISED' }))).toBe('info');

    const sorted = groupIssues([
      group(),
      group({ groupKey: 'ALIAS_ACT:factories', type: 'ALIAS_ACT', proposal: null }),
      group({ groupKey: 'b', decision: 'ACCEPTED' }),
      group({ groupKey: 'c', severity: 'ERROR', type: 'MISSING_REQUIRED' }),
      group({ groupKey: 'd', severity: 'INFO', type: 'NULL_PLACEHOLDER' }),
    ]);
    expect(sorted.decide).toHaveLength(2);
    expect(sorted.decided).toHaveLength(1);
    expect(sorted.blocking).toHaveLength(1);
    expect(sorted.info).toHaveLength(1);
    expect(blockingCount(sorted)).toBe(3);
    // Only groups with a proposal can be accepted in one go.
    expect(acceptableKeys(sorted)).toEqual(['ALIAS_DEPARTMENT:hr']);
  });

  it('lists a few row numbers and counts the rest', () => {
    expect(rowsText([7])).toBe('Row 7');
    expect(rowsText([3, 5])).toBe('Rows 3 and 5');
    expect(rowsText([3, 5, 9])).toBe('Rows 3, 5 and 9');
    expect(rowsText([3, 5, 9, 11, 12])).toBe('Rows 3, 5, 9 and 2 more');
  });

  it('reads back each decision', () => {
    expect(decisionText(group({ decision: 'ACCEPTED' }))).toBe('Uses “Human Resources”');
    expect(decisionText(group({ decision: 'ACCEPTED', proposal: null }))).toBe('Accepted');
    expect(decisionText(group({ decision: 'EDITED', editedValue: 'HR dept' }))).toBe(
      'Changed to “HR dept”',
    );
    expect(decisionText(group({ decision: 'REJECTED' }))).toBe('Kept as written');
    expect(decisionText(group())).toBe('Not decided');
  });
});

describe('dryRunLines', () => {
  it('lists what changes, leaving out the zeros', () => {
    const lines = dryRunLines({
      create: {
        acts: 2,
        categories: 0,
        departments: 1,
        people: 0,
        obligations: 0,
        assignments: 0,
        instances: 422,
        companies: 0,
        units: 0,
        locations: 1,
      },
      update: { obligations: 0, assignments: 3, instances: 0 },
      unchanged: { instances: 5 },
      skippedRows: 1,
      blockingErrors: 0,
    });
    expect(lines.create).toEqual([
      { label: 'Instances', count: 422 },
      { label: 'Acts', count: 2 },
      { label: 'Departments', count: 1 },
      { label: 'Locations', count: 1 },
    ]);
    expect(lines.update).toEqual([{ label: 'Assignments', count: 3 }]);
    expect(lines).toMatchObject({ unchanged: 5, skipped: 1, blocking: 0 });
  });
});

describe('links and history', () => {
  it('builds the wizard URL for a batch', () => {
    expect(batchHref(CLIENT, BATCH)).toBe(`/c/${CLIENT}/import?batch=${BATCH}`);
    expect(batchHref(CLIENT, BATCH, 'review')).toBe(
      `/c/${CLIENT}/import?batch=${BATCH}&step=review`,
    );
    expect(batchHref(CLIENT, BATCH, 'parsing')).toBe(
      `/c/${CLIENT}/import?batch=${BATCH}&parsing=1`,
    );
  });

  it('lists past imports with their state', () => {
    expect(
      historyItems(CLIENT, [
        {
          id: BATCH,
          fileName: 'register.xlsx',
          createdAt: '2026-10-24T05:00:00Z',
          status: 'PARSED',
          counts: { rows: 422, errors: 0, warnings: 8, infos: 3 },
        },
        {
          id: CLIENT,
          fileName: 'old.xlsx',
          createdAt: '2026-10-01T05:00:00Z',
          status: 'CANCELLED',
          counts: null,
        },
      ]),
    ).toEqual([
      {
        id: BATCH,
        fileName: 'register.xlsx',
        startedAt: '2026-10-24T05:00:00Z',
        status: 'Needs review',
        rows: 422,
        open: true,
        href: `/c/${CLIENT}/import?batch=${BATCH}`,
      },
      {
        id: CLIENT,
        fileName: 'old.xlsx',
        startedAt: '2026-10-01T05:00:00Z',
        status: 'Cancelled',
        rows: null,
        open: false,
        href: `/c/${CLIENT}/import?batch=${CLIENT}`,
      },
    ]);
  });
});
