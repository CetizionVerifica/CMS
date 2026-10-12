import { LocalDate, type InstanceStatusInput } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { clientToday, rowStatus } from './status.js';

const d = (s: string) => LocalDate.parse(s);
const settings = { dueSoonDays: 7 };

function open(dueDate: string): InstanceStatusInput {
  return { workflowState: 'OPEN', pendingKind: null, dueDate: d(dueDate), completedOn: null };
}

describe('rowStatus (engine.deriveStatus)', () => {
  it.each([
    ['2023-05-15', '2023-04-20', 'UPCOMING', null],
    ['2023-04-27', '2023-04-20', 'DUE_SOON', null],
    ['2023-04-20', '2023-04-20', 'DUE_SOON', null],
    ['2023-04-19', '2023-04-20', 'OVERDUE', 1],
    ['2023-03-31', '2023-04-20', 'OVERDUE', 20],
  ] as const)('OPEN due %s at %s is %s', (due, asOf, status, overdueDays) => {
    expect(rowStatus(open(due), d(asOf), settings)).toEqual({ status, overdueDays });
  });

  it('APPROVED after the due date is COMPLIED_LATE', () => {
    const late: InstanceStatusInput = {
      workflowState: 'APPROVED',
      pendingKind: null,
      dueDate: d('2023-04-15'),
      completedOn: d('2023-04-16'),
    };
    expect(rowStatus(late, d('2023-04-20'), settings)).toEqual({
      status: 'COMPLIED_LATE',
      overdueDays: null,
    });
  });

  it('drops the engine-only submittedOverdue flag', () => {
    const submitted: InstanceStatusInput = {
      workflowState: 'SUBMITTED',
      pendingKind: 'COMPLETION',
      dueDate: d('2023-04-15'),
      completedOn: d('2023-04-14'),
    };
    expect(rowStatus(submitted, d('2023-04-20'), settings)).toEqual({
      status: 'SUBMITTED',
      overdueDays: null,
    });
  });
});

describe('clientToday', () => {
  it('is the next day in Kolkata from 18:30 UTC', () => {
    expect(clientToday('2023-03-31T18:29:59Z', 'Asia/Kolkata')).toBe('2023-03-31');
    expect(clientToday('2023-03-31T18:30:00Z', 'Asia/Kolkata')).toBe('2023-04-01');
  });
});
