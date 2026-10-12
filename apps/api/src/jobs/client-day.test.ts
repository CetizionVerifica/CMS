import { DEFAULT_CLIENT_SETTINGS, type ClientSettings, type LocalDate } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { clientDay, currentAndNextFy, reminderWindow, sendTimeReached } from './client-day.js';

const settings = DEFAULT_CLIENT_SETTINGS as ClientSettings;
const d = (s: string) => s as LocalDate;

describe('clientDay in Asia/Kolkata (UTC+05:30)', () => {
  it('is 06:59 IST at 01:29Z, so the 07:00 send time has not been reached', () => {
    const day = clientDay('2026-10-12T01:29:00Z', 'Asia/Kolkata');
    expect(day).toEqual({ today: '2026-10-12', localTime: '06:59' });
    expect(sendTimeReached(day, settings)).toBe(false);
  });

  it('is 07:00 IST at 01:30Z, so the send time is reached', () => {
    const day = clientDay('2026-10-12T01:30:00Z', 'Asia/Kolkata');
    expect(day).toEqual({ today: '2026-10-12', localTime: '07:00' });
    expect(sendTimeReached(day, settings)).toBe(true);
  });

  it('rolls over to the next date at 18:30Z, while UTC is still on the previous day', () => {
    expect(clientDay('2026-10-11T18:29:59Z', 'Asia/Kolkata')).toEqual({
      today: '2026-10-11',
      localTime: '23:59',
    });
    expect(clientDay('2026-10-11T18:30:00Z', 'Asia/Kolkata')).toEqual({
      today: '2026-10-12',
      localTime: '00:00',
    });
  });

  it('starts the new FY on 1 Apr IST while UTC still reads 31 Mar', () => {
    const before = clientDay('2027-03-31T18:29:00Z', 'Asia/Kolkata');
    const after = clientDay('2027-03-31T18:30:00Z', 'Asia/Kolkata');
    expect(currentAndNextFy(before.today, 4)).toEqual({ from: '2026-04-01', to: '2028-03-31' });
    expect(currentAndNextFy(after.today, 4)).toEqual({ from: '2027-04-01', to: '2029-03-31' });
  });

  it('serves other time zones by their own wall clock', () => {
    expect(clientDay('2026-10-12T01:30:00Z', 'Europe/London')).toEqual({
      today: '2026-10-12',
      localTime: '02:30',
    });
    expect(clientDay('2026-10-12T01:30:00Z', 'America/New_York')).toEqual({
      today: '2026-10-11',
      localTime: '21:30',
    });
  });

  it('honours a client send time other than 07:00', () => {
    const late = { ...settings, reminders: { ...settings.reminders, sendAtLocalTime: '09:30' } };
    expect(sendTimeReached({ today: d('2026-10-12'), localTime: '09:29' }, late)).toBe(false);
    expect(sendTimeReached({ today: d('2026-10-12'), localTime: '09:30' }, late)).toBe(true);
  });
});

describe('currentAndNextFy', () => {
  it('follows a January FY start', () => {
    expect(currentAndNextFy(d('2026-10-12'), 1)).toEqual({ from: '2026-01-01', to: '2027-12-31' });
  });
});

describe('reminderWindow', () => {
  it('spans the largest escalation offset back and the largest reminder offset ahead', () => {
    expect(reminderWindow(d('2026-10-12'), settings)).toEqual({
      from: '2026-10-05',
      to: '2026-10-19',
    });
  });

  it('is just today when no offsets are configured', () => {
    const none = {
      ...settings,
      reminders: { ...settings.reminders, ownerDaysBefore: [], approverDaysAfter: [] },
    };
    expect(reminderWindow(d('2026-03-01'), none)).toEqual({ from: '2026-03-01', to: '2026-03-01' });
  });
});
