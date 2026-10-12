import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Action,
  Breakdown,
  CONTRACTS_VERSION,
  ExportJob,
  ImportBatch,
  ImportIssue,
  ImportRow,
  MappingTemplate,
  PlannedNotification,
  PortfolioRow,
  RequestContext,
  Resource,
  ScoreInput,
  ScoreResult,
} from '../src/index.js';
import { base, ID, membership, versioned, without } from './samples.js';

const zeroCounts = {
  UPCOMING: 0,
  DUE_SOON: 0,
  OVERDUE: 0,
  SUBMITTED: 0,
  COMPLIED: 0,
  COMPLIED_LATE: 0,
  NOT_APPLICABLE: 0,
};
const noIds = {
  UPCOMING: [],
  DUE_SOON: [],
  OVERDUE: [],
  SUBMITTED: [],
  COMPLIED: [],
  COMPLIED_LATE: [],
  NOT_APPLICABLE: [],
};

describe('import', () => {
  const batch = {
    ...versioned,
    clientId: ID.client,
    createdById: ID.owner,
    status: 'DRY_RUN_READY',
    fileName: 'sample-register.xlsx',
    fileSha256: 'c'.repeat(64),
    sheetName: 'Sheet1',
    mapping: [
      { sourceHeader: 'EY Compliance ID', field: 'externalRef' },
      { sourceHeader: 'Sr. No.', field: null },
    ],
    mappingTemplateId: null,
    counts: { rows: 424, errors: 0, warnings: 3, infos: 12 },
    dryRun: {
      create: {
        acts: 33,
        categories: 5,
        departments: 6,
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
    },
    committedAt: null,
    failureCode: null,
  };
  it('parses a batch at dry run', () => {
    expect(ImportBatch.safeParse(batch).success).toBe(true);
    expect(ImportBatch.safeParse({ ...batch, status: 'DONE' }).success).toBe(false);
    expect(
      ImportBatch.safeParse({ ...batch, mapping: [{ sourceHeader: 'X', field: 'unknownField' }] })
        .success,
    ).toBe(false);
  });
  it('parses a mapping template', () => {
    expect(
      MappingTemplate.safeParse({
        ...versioned,
        clientId: null,
        name: 'EY register',
        mapping: batch.mapping,
      }).success,
    ).toBe(true);
  });
  it('keeps raw values beside mapped ones and starts at row 2', () => {
    const row = {
      id: ID.v5,
      batchId: ID.v5,
      rowNumber: 2,
      raw: { 'EY Compliance ID': 'TAX-CL-033-6067-60218', 'Sr. No.': 1, Remarks: null },
      mapped: { externalRef: 'TAX-CL-033-6067-60218', completedOn: null },
      issueIds: [],
      outcome: 'CREATE',
      targetInstanceId: null,
    };
    expect(ImportRow.safeParse(row).success).toBe(true);
    expect(ImportRow.safeParse({ ...row, rowNumber: 1 }).success).toBe(false);
    expect(ImportRow.safeParse({ ...row, mapped: { notAField: 'x' } }).success).toBe(false);
  });
  const issue = {
    id: ID.v5,
    batchId: ID.v5,
    groupKey: 'ALIAS_DEPARTMENT:Human Resources',
    type: 'ALIAS_DEPARTMENT',
    severity: 'WARNING',
    rowNumbers: [14, 15],
    field: 'department',
    rawValues: ['HR', 'Human Resources'],
    proposal: 'Human Resources',
    decision: 'PENDING',
    editedValue: null,
  };
  it('parses an issue and pins severity to the issue type', () => {
    expect(ImportIssue.safeParse(issue).success).toBe(true);
    expect(ImportIssue.safeParse({ ...issue, severity: 'INFO' }).success).toBe(false);
  });
  it('ties editedValue to the EDITED decision', () => {
    expect(
      ImportIssue.safeParse({ ...issue, decision: 'EDITED', editedValue: 'HR & Admin' }).success,
    ).toBe(true);
    expect(ImportIssue.safeParse({ ...issue, decision: 'EDITED' }).success).toBe(false);
    expect(ImportIssue.safeParse({ ...issue, editedValue: 'HR & Admin' }).success).toBe(false);
  });
});

describe('scores', () => {
  const result = {
    engineVersion: '1.0.0',
    asOf: '2023-03-31',
    score: 51.3,
    onTimeRate: 48.2,
    counts: { ...zeroCounts, COMPLIED: 1 },
    instanceIds: { ...noIds, COMPLIED: [ID.instance] },
  };
  it('parses a score result and "no items due"', () => {
    expect(ScoreResult.safeParse(result).success).toBe(true);
    expect(ScoreResult.safeParse({ ...result, score: null, onTimeRate: null }).success).toBe(true);
  });
  it('requires every count to match its instance ids', () => {
    expect(
      ScoreResult.safeParse({ ...result, counts: { ...zeroCounts, COMPLIED: 2 } }).success,
    ).toBe(false);
    expect(ScoreResult.safeParse({ ...result, counts: zeroCounts }).success).toBe(false);
  });
  it('rejects more than one decimal, out-of-range scores and missing statuses', () => {
    expect(ScoreResult.safeParse({ ...result, score: 51.34 }).success).toBe(false);
    expect(ScoreResult.safeParse({ ...result, score: 100.1 }).success).toBe(false);
    const partial = without(zeroCounts, 'NOT_APPLICABLE');
    expect(ScoreResult.safeParse({ ...result, counts: partial }).success).toBe(false);
  });
  it('parses inputs, breakdowns, portfolio rows, notifications and export jobs', () => {
    expect(
      ScoreInput.safeParse({
        instanceId: ID.instance,
        criticality: 'HIGH',
        dueDate: '2023-03-31',
        workflowState: 'OPEN',
        pendingKind: null,
        completedOn: null,
      }).success,
    ).toBe(true);
    expect(
      Breakdown.safeParse({
        by: 'department',
        rows: [{ key: ID.department, label: 'Finance', result }],
      }).success,
    ).toBe(true);
    expect(Breakdown.safeParse({ by: 'status', rows: [] }).success).toBe(false);
    expect(
      PortfolioRow.safeParse({
        clientId: ID.client,
        clientName: 'Aditya Birla Group',
        result,
        dueThisWeek: 3,
        lastActivityAt: null,
      }).success,
    ).toBe(true);
    expect(
      PlannedNotification.safeParse({
        kind: 'OWNER_REMINDER',
        recipientId: ID.owner,
        instanceId: ID.instance,
        sendDate: '2023-03-24',
        offsetDays: -7,
      }).success,
    ).toBe(true);
    expect(
      ExportJob.safeParse({
        ...base,
        clientId: ID.client,
        kind: 'REGISTER_XLSX',
        params: { fy: '2022-23' },
        status: 'QUEUED',
        fileName: null,
        requestedById: ID.owner,
      }).success,
    ).toBe(true);
  });
});

describe('request context', () => {
  it('parses a context with memberships', () => {
    const ctx = {
      requestId: 'req-1',
      firmId: ID.firm,
      personId: ID.owner,
      memberships: [membership],
      clientIds: [ID.client],
      mfaSatisfied: false,
      asOf: '2026-10-11',
    };
    expect(RequestContext.safeParse(ctx).success).toBe(true);
    expect(RequestContext.safeParse({ ...ctx, asOf: '2026-10-11T00:00:00Z' }).success).toBe(false);
  });
  it('checks action names and resources', () => {
    expect(Action.safeParse('instance.submit').success).toBe(true);
    expect(Action.safeParse('Instance.Submit').success).toBe(false);
    expect(Action.safeParse('instance.dueDate').success).toBe(true);
    expect(Action.safeParse('instance.due_date').success).toBe(false);
    expect(
      Resource.safeParse({ type: 'instance', clientId: ID.client, ownerId: ID.owner }).success,
    ).toBe(true);
    expect(Resource.safeParse({ type: 'firm', clientId: null }).success).toBe(false);
  });
  it('is version 1 and matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(CONTRACTS_VERSION).toBe(pkg.version);
    expect(CONTRACTS_VERSION).toMatch(/^1\./);
  });
});
