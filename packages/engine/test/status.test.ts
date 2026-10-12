import type { InstanceStatusInput } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { asLocalDate as d, deriveStatus } from '../src/index.js';

const s = { dueSoonDays: 7 };
const due = d('2023-03-31');

function input(over: Partial<InstanceStatusInput>): InstanceStatusInput {
  return { workflowState: 'OPEN', pendingKind: null, dueDate: due, completedOn: null, ...over };
}

describe('deriveStatus', () => {
  it('APPROVED on or before the due date is COMPLIED', () => {
    for (const completedOn of ['2023-03-31', '2023-03-01']) {
      expect(
        deriveStatus(
          input({ workflowState: 'APPROVED', completedOn: d(completedOn) }),
          d('2023-06-01'),
          s,
        ),
      ).toEqual({
        status: 'COMPLIED',
        overdueDays: null,
        submittedOverdue: false,
      });
    }
  });
  it('APPROVED after the due date is COMPLIED_LATE, across the FY boundary', () => {
    expect(
      deriveStatus(
        input({ workflowState: 'APPROVED', completedOn: d('2023-04-01') }),
        d('2023-04-02'),
        s,
      ),
    ).toEqual({ status: 'COMPLIED_LATE', overdueDays: null, submittedOverdue: false });
  });
  it('APPROVED without completedOn is invalid input', () => {
    expect(() => deriveStatus(input({ workflowState: 'APPROVED' }), due, s)).toThrow(RangeError);
  });
  it('NOT_APPLICABLE stays NOT_APPLICABLE even past due', () => {
    expect(
      deriveStatus(
        input({ workflowState: 'NOT_APPLICABLE', completedOn: d('2022-04-10') }),
        d('2024-01-01'),
        s,
      ),
    ).toEqual({ status: 'NOT_APPLICABLE', overdueDays: null, submittedOverdue: false });
  });
  it('SUBMITTED flags overdue only after the due date', () => {
    const sub = input({
      workflowState: 'SUBMITTED',
      pendingKind: 'COMPLETION',
      completedOn: d('2023-03-30'),
    });
    expect(deriveStatus(sub, d('2023-03-31'), s)).toEqual({
      status: 'SUBMITTED',
      overdueDays: null,
      submittedOverdue: false,
    });
    expect(deriveStatus(sub, d('2023-04-01'), s)).toEqual({
      status: 'SUBMITTED',
      overdueDays: null,
      submittedOverdue: true,
    });
    const na = input({ workflowState: 'SUBMITTED', pendingKind: 'NA' });
    expect(deriveStatus(na, d('2023-04-05'), s).submittedOverdue).toBe(true);
  });
  it.each(['OPEN', 'SENT_BACK'] as const)(
    '%s: overdue, due soon or upcoming around the boundaries',
    (workflowState) => {
      const i = input({ workflowState });
      expect(deriveStatus(i, d('2023-04-01'), s)).toEqual({
        status: 'OVERDUE',
        overdueDays: 1,
        submittedOverdue: false,
      });
      expect(deriveStatus(i, d('2023-05-31'), s)).toEqual({
        status: 'OVERDUE',
        overdueDays: 61,
        submittedOverdue: false,
      });
      expect(deriveStatus(i, d('2023-03-31'), s)).toEqual({
        status: 'DUE_SOON',
        overdueDays: null,
        submittedOverdue: false,
      });
      expect(deriveStatus(i, d('2023-03-24'), s)).toEqual({
        status: 'DUE_SOON',
        overdueDays: null,
        submittedOverdue: false,
      });
      expect(deriveStatus(i, d('2023-03-23'), s)).toEqual({
        status: 'UPCOMING',
        overdueDays: null,
        submittedOverdue: false,
      });
    },
  );
  it('uses dueSoonDays from settings, including 0', () => {
    const i = input({ dueDate: d('2024-02-29') });
    expect(deriveStatus(i, d('2024-02-28'), { dueSoonDays: 0 }).status).toBe('UPCOMING');
    expect(deriveStatus(i, d('2024-02-29'), { dueSoonDays: 0 }).status).toBe('DUE_SOON');
    expect(deriveStatus(i, d('2024-02-01'), { dueSoonDays: 28 }).status).toBe('DUE_SOON');
    expect(deriveStatus(i, d('2024-03-01'), { dueSoonDays: 0 })).toMatchObject({
      status: 'OVERDUE',
      overdueDays: 1,
    });
  });
});
