import { describe, expect, it } from 'vitest';
import {
  CLIENT_ROLES,
  Criticality,
  DerivedStatus,
  ERROR_HTTP_STATUS,
  ErrorCode,
  ErrorEnvelope,
  FIRM_ROLES,
  IMPORT_ISSUE_SEVERITY,
  ImportIssueType,
  Role,
  WorkflowState,
} from '../src/index.js';

describe('enums', () => {
  it('match the contract values in order', () => {
    expect(Criticality.options).toEqual(['SUPER_CRITICAL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
    expect(WorkflowState.options).toEqual([
      'OPEN',
      'SUBMITTED',
      'SENT_BACK',
      'APPROVED',
      'NOT_APPLICABLE',
    ]);
    expect(DerivedStatus.options).toEqual([
      'UPCOMING',
      'DUE_SOON',
      'OVERDUE',
      'SUBMITTED',
      'COMPLIED',
      'COMPLIED_LATE',
      'NOT_APPLICABLE',
    ]);
  });
  it('split roles into firm and client roles with no overlap', () => {
    expect([...FIRM_ROLES, ...CLIENT_ROLES].sort()).toEqual([...Role.options].sort());
  });
  it('give every import issue type its contract severity', () => {
    expect(Object.keys(IMPORT_ISSUE_SEVERITY).sort()).toEqual([...ImportIssueType.options].sort());
    expect(IMPORT_ISSUE_SEVERITY.DUPLICATE_PERIOD).toBe('WARNING');
    expect(IMPORT_ISSUE_SEVERITY.INVALID_DATE).toBe('ERROR');
  });
  it('reject values outside the enum', () => {
    expect(Criticality.safeParse('High').success).toBe(false);
  });
});

describe('errors', () => {
  it('map every code to its HTTP status', () => {
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual([...ErrorCode.options].sort());
    expect(ERROR_HTTP_STATUS.STALE_VERSION).toBe(409);
    expect(ERROR_HTTP_STATUS.NOT_FOUND).toBe(404);
    expect(ERROR_HTTP_STATUS.IMPORT_BLOCKED).toBe(422);
  });
  it('parse the error envelope', () => {
    const body = {
      error: {
        code: 'INVALID_TRANSITION',
        message: 'Instance is APPROVED; SUBMIT is not allowed.',
        details: { from: 'APPROVED', action: 'SUBMIT' },
      },
      requestId: 'req-1',
    };
    expect(ErrorEnvelope.safeParse(body).success).toBe(true);
    expect(
      ErrorEnvelope.safeParse({ ...body, error: { ...body.error, code: 'CONFLICT' } }).success,
    ).toBe(false);
    expect(ErrorEnvelope.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });
});
