import { describe, expect, it } from 'vitest';

import {
  aliasText,
  daysText,
  departmentRows,
  parseAliases,
  parseDays,
  reminderSummary,
} from './setup-model';

describe('aliases', () => {
  it('splits on commas and lines, dropping blanks, repeats and the name itself', () => {
    expect(parseAliases(' HR,  Human  resources\nhr, , People,Finance', 'finance')).toEqual([
      'HR',
      'Human resources',
      'People',
    ]);
    expect(parseAliases('')).toEqual([]);
    expect(aliasText(['HR', 'People'])).toBe('HR, People');
  });

  it('shapes the rows the table shows', () => {
    expect(
      departmentRows([
        {
          id: 'a',
          firmId: 'f',
          clientId: 'c',
          name: 'EHS',
          aliases: ['Safety', 'Environment'],
          version: 3,
          createdAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-01T00:00:00Z',
          archivedAt: null,
        },
      ]),
    ).toEqual([{ id: 'a', name: 'EHS', aliases: 'Safety, Environment', version: 3 }]);
  });
});

describe('days', () => {
  it('reads whole days from 0 to 90, newest last', () => {
    expect(parseDays('1, 7 3,3')).toEqual([7, 3, 1]);
    expect(parseDays('')).toEqual([]);
    expect(parseDays('0')).toEqual([0]);
    expect(daysText([7, 3, 1])).toBe('7, 3, 1');
  });

  it('refuses anything else', () => {
    expect(parseDays('91')).toBeNull();
    expect(parseDays('1.5')).toBeNull();
    expect(parseDays('-1')).toBeNull();
    expect(parseDays('a')).toBeNull();
    expect(parseDays('1,2,3,4,5,6,7,8,9,10,11')).toBeNull();
  });
});

describe('reminderSummary', () => {
  it('reads the settings back in sentences', () => {
    expect(
      reminderSummary({
        ownerDaysBefore: [1, 7, 0],
        approverDaysAfter: [5, 2],
        sendAtLocalTime: '09:00',
        consultantDigestWeekday: 1,
      }),
    ).toEqual([
      'Owners are reminded 7 days and 1 day before the due date, and on the due date.',
      'Approvers are reminded 2 days and 5 days after a submission reaches them.',
      "Reminders go out at 09:00 in the client's time zone.",
      'Consultants get a weekly digest every Monday.',
    ]);
  });

  it('says when nobody is reminded', () => {
    const [owners, approvers, , digest] = reminderSummary({
      ownerDaysBefore: [],
      approverDaysAfter: [],
      sendAtLocalTime: '18:00',
      consultantDigestWeekday: 7,
    });
    expect(owners).toBe('Owners get no reminders before a due date.');
    expect(approvers).toBe('Approvers get no reminders about submissions.');
    expect(digest).toBe('Consultants get a weekly digest every Sunday.');
    expect(
      reminderSummary({
        ownerDaysBefore: [0],
        approverDaysAfter: [0, 3],
        sendAtLocalTime: '08:00',
        consultantDigestWeekday: 3,
      }).slice(0, 2),
    ).toEqual([
      'Owners are reminded on the due date.',
      'Approvers are reminded the same day and 3 days after a submission reaches them.',
    ]);
  });
});
