import {
  DEFAULT_CLIENT_SETTINGS,
  PlannedNotification,
  type InstanceStatusInput,
} from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { asLocalDate as d, isConsultantDigestDay, planNotifications } from '../src/index.js';

const s = DEFAULT_CLIENT_SETTINGS.reminders;
const ids = {
  id: '01900000-0000-7000-8000-000000000001',
  ownerId: '01900000-0000-7000-8000-000000000002',
  approverId: '01900000-0000-7000-8000-000000000003',
};
function instance(over: Partial<InstanceStatusInput> = {}) {
  return {
    workflowState: 'OPEN',
    pendingKind: null,
    dueDate: d('2023-04-01'),
    completedOn: null,
    ...ids,
    ...over,
  } as const;
}
const kinds = (asOf: string, over: Partial<InstanceStatusInput> = {}) =>
  planNotifications(
    instance(over),
    { ...s, ownerDaysBefore: [...s.ownerDaysBefore], approverDaysAfter: [...s.approverDaysAfter] },
    d(asOf),
  ).map((n) => `${n.kind}${n.offsetDays}`);

describe('planNotifications', () => {
  it('reminds the owner at T-7, T-3 and T-0, across the FY boundary', () => {
    const t7 = planNotifications(
      instance(),
      { ...s, ownerDaysBefore: [7, 3, 0], approverDaysAfter: [1, 7] },
      d('2023-03-25'),
    );
    expect(t7).toEqual([
      {
        kind: 'OWNER_REMINDER',
        recipientId: ids.ownerId,
        instanceId: ids.id,
        sendDate: '2023-03-25',
        offsetDays: -7,
      },
    ]);
    for (const n of t7) expect(PlannedNotification.safeParse(n).success).toBe(true);
    expect(kinds('2023-03-29')).toEqual(['OWNER_REMINDER-3']);
    expect(kinds('2023-04-01')).toEqual(['OWNER_REMINDER0']);
    expect(kinds('2023-03-30')).toEqual([]);
  });
  it('escalates to the approver at +1 and +7 days overdue', () => {
    const plus1 = planNotifications(
      instance(),
      { ...s, ownerDaysBefore: [], approverDaysAfter: [1, 7] },
      d('2023-04-02'),
    );
    expect(plus1).toEqual([
      {
        kind: 'APPROVER_ESCALATION',
        recipientId: ids.approverId,
        instanceId: ids.id,
        sendDate: '2023-04-02',
        offsetDays: 1,
      },
    ]);
    expect(kinds('2023-04-08')).toEqual(['APPROVER_ESCALATION7']);
    expect(kinds('2023-04-05')).toEqual([]);
  });
  it('treats SENT_BACK like OPEN', () => {
    expect(kinds('2023-03-29', { workflowState: 'SENT_BACK' })).toEqual(['OWNER_REMINDER-3']);
    expect(kinds('2023-04-02', { workflowState: 'SENT_BACK' })).toEqual(['APPROVER_ESCALATION1']);
  });
  it('does not remind the owner once submitted, but still escalates an overdue approval', () => {
    const sub = {
      workflowState: 'SUBMITTED',
      pendingKind: 'COMPLETION',
      completedOn: d('2023-03-20'),
    } as const;
    expect(kinds('2023-03-29', sub)).toEqual([]);
    expect(kinds('2023-04-08', sub)).toEqual(['APPROVER_ESCALATION7']);
  });
  it('sends both when settings put owner and approver on the due day', () => {
    const both = planNotifications(
      instance(),
      { ...s, ownerDaysBefore: [0], approverDaysAfter: [0] },
      d('2023-04-01'),
    );
    expect(both.map((n) => n.kind)).toEqual(['OWNER_REMINDER', 'APPROVER_ESCALATION']);
  });
  it('never notifies for complied (on time or late) or not applicable instances', () => {
    const settings = { ...s, ownerDaysBefore: [0, 3, 7], approverDaysAfter: [0, 1, 7] };
    for (const asOf of ['2023-03-25', '2023-04-01', '2023-04-02', '2023-04-08']) {
      expect(
        planNotifications(
          instance({ workflowState: 'APPROVED', completedOn: d('2023-03-01') }),
          settings,
          d(asOf),
        ),
      ).toEqual([]);
      expect(
        planNotifications(
          instance({ workflowState: 'APPROVED', completedOn: d('2023-04-05') }),
          settings,
          d(asOf),
        ),
      ).toEqual([]);
      expect(
        planNotifications(
          instance({ workflowState: 'NOT_APPLICABLE', completedOn: d('2023-03-01') }),
          settings,
          d(asOf),
        ),
      ).toEqual([]);
    }
  });
});

describe('isConsultantDigestDay', () => {
  it('matches the configured ISO weekday (default Monday)', () => {
    expect(isConsultantDigestDay(d('2023-04-03'), s)).toBe(true); // Monday
    expect(isConsultantDigestDay(d('2023-04-02'), s)).toBe(false); // Sunday
    expect(isConsultantDigestDay(d('2023-04-02'), { ...s, consultantDigestWeekday: 7 })).toBe(true);
  });
});
