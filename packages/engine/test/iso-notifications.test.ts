import {
  ISO_REMINDER_SCHEDULE,
  IsoReminderSchedule,
  PlannedIsoNotification,
  type IsoNotificationInput,
} from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { asLocalDate as d, planIsoNotifications } from '../src/index.js';
import { u } from './iso-ids.js';

const schedule = IsoReminderSchedule.parse(ISO_REMINDER_SCHEDULE);

const item = (over: Partial<IsoNotificationInput> = {}): IsoNotificationInput => ({
  kind: 'ISO_ACTION_DUE',
  isoSubjectType: 'iso_action',
  isoSubjectId: u('action'),
  anchorDate: d('2026-03-31'),
  open: true,
  recipientIds: [u('owner')],
  ...over,
});

const plan = (items: IsoNotificationInput[], asOf: string) =>
  planIsoNotifications(items, schedule, d(asOf)).map((n) => PlannedIsoNotification.parse(n));

/** The days in [from, to] on which `item` is sent, with their offsets. */
function sendDays(i: IsoNotificationInput, from: string, days: number) {
  const out: string[] = [];
  let date = new Date(`${from}T00:00:00Z`);
  for (let n = 0; n < days; n += 1) {
    const iso = date.toISOString().slice(0, 10);
    for (const p of plan([i], iso)) out.push(`${iso} ${p.offsetDays}`);
    date = new Date(date.getTime() + 86_400_000);
  }
  return out;
}

describe('planIsoNotifications (model §5.3, §7)', () => {
  it('an action is reminded 7 days before and on its due date, across the FY boundary', () => {
    expect(sendDays(item({ anchorDate: d('2026-04-03') }), '2026-03-20', 30)).toEqual([
      '2026-03-27 -7',
      '2026-04-03 0',
    ]);
  });
  it('the reminder carries everything the dedupe key needs, dated as-of', () => {
    expect(plan([item()], '2026-03-31')).toEqual([
      {
        kind: 'ISO_ACTION_DUE',
        recipientId: u('owner'),
        isoSubjectType: 'iso_action',
        isoSubjectId: u('action'),
        sendDate: '2026-03-31',
        offsetDays: 0,
      },
    ]);
  });
  it('a closed subject or a met cycle date gets nothing', () => {
    expect(plan([item({ open: false })], '2026-03-31')).toEqual([]);
  });
  it('a kind without a rule for that subject type gets nothing', () => {
    expect(plan([item({ isoSubjectType: 'risk_item' })], '2026-03-31')).toEqual([]);
  });
  it('a document review goes to each distinct recipient, 14 days before and on reviewDueOn over 29 February', () => {
    const review = item({
      kind: 'ISO_REVIEW_DUE',
      isoSubjectType: 'controlled_document',
      isoSubjectId: u('document'),
      anchorDate: d('2028-03-14'),
      recipientIds: [u('owner'), u('approver'), u('owner')],
    });
    expect(plan([review], '2028-02-29').map((p) => p.recipientId)).toEqual([
      u('owner'),
      u('approver'),
    ]);
    expect(sendDays(review, '2028-02-20', 30).filter((x) => x.endsWith(' 0'))).toEqual([
      '2028-03-14 0',
      '2028-03-14 0',
    ]);
  });
  it('two subjects of one kind for one recipient on one day are two notifications', () => {
    const planned = plan([item(), item({ isoSubjectId: u('action-2') })], '2026-03-31');
    expect(planned.map((p) => p.isoSubjectId)).toEqual([u('action'), u('action-2')]);
    expect(new Set(planned.map((p) => p.recipientId))).toEqual(new Set([u('owner')]));
  });
  it('an overdue system review is sent on the day it becomes overdue, then every 30 days while it stays so', () => {
    const overdue = item({
      kind: 'ISO_MANAGEMENT_REVIEW_DUE',
      isoSubjectType: 'management_system',
      isoSubjectId: u('system'),
      anchorDate: d('2026-01-31'),
      recipientIds: [u('client-admin')],
    });
    expect(sendDays(overdue, '2026-01-01', 130)).toEqual([
      '2026-01-31 0',
      '2026-03-02 30',
      '2026-04-01 60',
      '2026-05-01 90',
    ]);
    expect(plan([{ ...overdue, open: false }], '2026-03-02')).toEqual([]);
  });
  it('a planned review is reminded 14 days before and on plannedOn; certificates 90, 30 and 7 days before', () => {
    const review = item({
      kind: 'ISO_MANAGEMENT_REVIEW_DUE',
      isoSubjectType: 'management_review',
      anchorDate: d('2026-04-14'),
    });
    expect(sendDays(review, '2026-03-25', 30).map((x) => x.split(' ')[1])).toEqual(['-14', '0']);
    const cert = item({
      kind: 'ISO_CERTIFICATE_EXPIRING',
      isoSubjectType: 'certification',
      anchorDate: d('2027-02-28'),
    });
    expect(sendDays(cert, '2026-11-01', 150)).toEqual([
      '2026-11-30 -90',
      '2027-01-29 -30',
      '2027-02-21 -7',
    ]);
  });
  it('an item with no recipients plans nothing', () => {
    expect(plan([item({ recipientIds: [] })], '2026-03-31')).toEqual([]);
  });
});
