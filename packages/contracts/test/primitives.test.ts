import { describe, expect, it } from 'vitest';
import {
  CountryCode,
  FyLabel,
  Id,
  Instant,
  isLocalDate,
  LocalDate,
  LocalTime,
  MonthDay,
  Name,
  Sha256,
  StateCode,
  Text,
  TimeZone,
} from '../src/index.js';
import { ID } from './samples.js';

describe('Id', () => {
  it('accepts lower-case v7 and v5 UUIDs', () => {
    expect(Id.safeParse(ID.firm).success).toBe(true);
    expect(Id.safeParse(ID.v5).success).toBe(true);
  });
  it.each([
    '',
    'not-a-uuid',
    ID.firm.toUpperCase(),
    '0192f0c8-1a2b-0c3d-8e4f-000000000001',
    '0192f0c8-1a2b-7c3d-0e4f-000000000001',
  ])('rejects %j', (value) => {
    expect(Id.safeParse(value).success).toBe(false);
  });
});

describe('LocalDate', () => {
  it.each(['2022-04-01', '2023-03-31', '2024-02-29', '2000-02-29', '2022-12-31', '2022-06-30'])(
    'accepts %s',
    (d) => {
      expect(isLocalDate(d)).toBe(true);
      expect(LocalDate.safeParse(d).success).toBe(true);
    },
  );
  it.each([
    '2023-02-29', // not a leap year
    '1900-02-29', // century, not leap
    '2022-04-31',
    '2022-09-31',
    '2022-11-31',
    '2022-13-01',
    '2022-00-10',
    '2022-01-00',
    '0000-01-01',
    '2022-4-1',
    '2022-04-01T00:00:00Z',
    '',
  ])('rejects %j', (d) => {
    expect(isLocalDate(d)).toBe(false);
    expect(LocalDate.safeParse(d).success).toBe(false);
  });
});

describe('Instant', () => {
  it('accepts UTC with Z, with or without fraction', () => {
    expect(Instant.safeParse('2026-10-11T09:17:43Z').success).toBe(true);
    expect(Instant.safeParse('2026-10-11T09:17:43.123Z').success).toBe(true);
  });
  it.each(['2026-10-11T09:17:43+05:30', '2026-10-11T09:17:43', '2026-10-11'])('rejects %s', (v) => {
    expect(Instant.safeParse(v).success).toBe(false);
  });
});

describe('MonthDay', () => {
  it('accepts 29 Feb and 30 Apr', () => {
    expect(MonthDay.safeParse({ month: 2, day: 29 }).success).toBe(true);
    expect(MonthDay.safeParse({ month: 4, day: 30 }).success).toBe(true);
  });
  it('rejects days a month never has', () => {
    expect(MonthDay.safeParse({ month: 2, day: 30 }).success).toBe(false);
    expect(MonthDay.safeParse({ month: 4, day: 31 }).success).toBe(false);
    expect(MonthDay.safeParse({ month: 13, day: 1 }).success).toBe(false);
    expect(MonthDay.safeParse({ month: 1, day: 1, extra: true }).success).toBe(false);
  });
});

describe('FyLabel', () => {
  it('accepts consecutive years, including the century rollover', () => {
    expect(FyLabel.safeParse('2022-23').success).toBe(true);
    expect(FyLabel.safeParse('2099-00').success).toBe(true);
  });
  it.each(['2022-24', '2022-2023', '22-23'])('rejects %s', (v) => {
    expect(FyLabel.safeParse(v).success).toBe(false);
  });
});

describe('text primitives', () => {
  it('trims and rejects empty strings', () => {
    expect(Text.parse('  Plant  ')).toBe('Plant');
    expect(Text.safeParse('   ').success).toBe(false);
    expect(Name.safeParse('x'.repeat(301)).success).toBe(false);
  });
  it('checks codes, hashes, times and zones', () => {
    expect(CountryCode.safeParse('IN').success).toBe(true);
    expect(CountryCode.safeParse('in').success).toBe(false);
    expect(StateCode.safeParse('WB').success).toBe(true);
    expect(StateCode.safeParse('West Bengal').success).toBe(false);
    expect(Sha256.safeParse('a'.repeat(64)).success).toBe(true);
    expect(Sha256.safeParse('A'.repeat(64)).success).toBe(false);
    expect(LocalTime.safeParse('07:00').success).toBe(true);
    expect(LocalTime.safeParse('24:00').success).toBe(false);
    expect(TimeZone.safeParse('Asia/Kolkata').success).toBe(true);
    expect(TimeZone.safeParse('Mars/Olympus').success).toBe(false);
  });
});
