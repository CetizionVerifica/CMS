import { ClientPeriods, type LocalDate } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { daysInMonth } from '../src/dates.js';
import { clientPeriods } from '../src/periods.js';

const d = (s: string): LocalDate => s as LocalDate;
const none = { generatedFrom: null, generatedTo: null };

describe('clientPeriods', () => {
  describe('current FY and quarter', () => {
    it.each([
      ['2026-03-31', '2025-26', 4],
      ['2026-04-01', '2026-27', 1],
      ['2026-06-30', '2026-27', 1],
      ['2026-07-01', '2026-27', 2],
      ['2026-09-30', '2026-27', 2],
      ['2026-10-01', '2026-27', 3],
      ['2026-12-31', '2026-27', 3],
      ['2027-01-01', '2026-27', 4],
      ['2027-02-28', '2026-27', 4],
      ['2028-02-29', '2027-28', 4],
    ])('April FY: %s is %s Q%i', (today, fy, quarter) => {
      expect(clientPeriods({ today: d(today), fyStartMonth: 4, ...none }).current).toEqual({
        fy,
        quarter,
      });
    });

    it('labels a century crossing with two digits', () => {
      expect(clientPeriods({ today: d('2100-01-15'), fyStartMonth: 4, ...none }).current).toEqual({
        fy: '2099-00',
        quarter: 4,
      });
    });

    // For every FY start month, walk the 12 months of FY 2026: the first day of month k (0-based) of the FY is in
    // quarter floor(k/3)+1, and the day before the FY starts is Q4 of the previous FY.
    for (let fyStartMonth = 1; fyStartMonth <= 12; fyStartMonth++) {
      it(`FY starting in month ${fyStartMonth}: every month and both FY edges`, () => {
        const label = (start: number) => `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
        for (let k = 0; k < 12; k++) {
          const index = 2026 * 12 + (fyStartMonth - 1) + k;
          const year = Math.floor(index / 12);
          const month = (index % 12) + 1;
          const first = d(`${year}-${String(month).padStart(2, '0')}-01`);
          const quarter = Math.floor(k / 3) + 1;
          expect(clientPeriods({ today: first, fyStartMonth, ...none }).current, first).toEqual({
            fy: label(2026),
            quarter,
          });
          const lastDay = daysInMonth(year, month);
          const last = d(`${first.slice(0, 8)}${lastDay}`);
          expect(clientPeriods({ today: last, fyStartMonth, ...none }).current, last).toEqual({
            fy: label(2026),
            quarter,
          });
        }
        const startYear = fyStartMonth === 1 ? 2025 : 2026;
        const endMonth = fyStartMonth === 1 ? 12 : fyStartMonth - 1;
        const lastDay = daysInMonth(startYear, endMonth);
        const dayBefore = d(`${startYear}-${String(endMonth).padStart(2, '0')}-${lastDay}`);
        expect(
          clientPeriods({ today: dayBefore, fyStartMonth, ...none }).current,
          dayBefore,
        ).toEqual({
          fy: label(2025),
          quarter: 4,
        });
      });
    }

    it('rejects an FY start month outside 1-12', () => {
      for (const fyStartMonth of [0, 13, 4.5]) {
        expect(() => clientPeriods({ today: d('2026-10-12'), fyStartMonth, ...none })).toThrow(
          RangeError,
        );
      }
    });
  });

  describe('available FYs and months', () => {
    it('offers just the current FY when nothing is generated yet', () => {
      expect(clientPeriods({ today: d('2026-10-12'), fyStartMonth: 4, ...none })).toEqual({
        current: { fy: '2026-27', quarter: 3 },
        availableFys: ['2026-27'],
        availableUntil: null,
      });
    });

    it('lists every FY from the first to the last generated date, oldest first', () => {
      expect(
        clientPeriods({
          today: d('2026-10-12'),
          fyStartMonth: 4,
          generatedFrom: d('2022-04-07'),
          generatedTo: d('2027-03-31'),
        }),
      ).toEqual({
        current: { fy: '2026-27', quarter: 3 },
        availableFys: ['2022-23', '2023-24', '2024-25', '2025-26', '2026-27'],
        availableUntil: '2027-03',
      });
    });

    it('adds the current FY when generation stops before it, without inventing the FYs in between', () => {
      const p = clientPeriods({
        today: d('2026-10-12'),
        fyStartMonth: 4,
        generatedFrom: d('2022-04-01'),
        generatedTo: d('2023-03-31'),
      });
      expect(p.availableFys).toEqual(['2022-23', '2026-27']);
      expect(p.availableUntil).toBe('2023-03');
    });

    it('adds the current FY when generation starts after it', () => {
      const p = clientPeriods({
        today: d('2026-03-31'),
        fyStartMonth: 4,
        generatedFrom: d('2026-04-01'),
        generatedTo: d('2027-04-07'),
      });
      expect(p.availableFys).toEqual(['2025-26', '2026-27', '2027-28']);
      expect(p.availableUntil).toBe('2027-04');
    });

    it('splits generated dates at the FY start month', () => {
      const p = clientPeriods({
        today: d('2026-06-15'),
        fyStartMonth: 7,
        generatedFrom: d('2025-06-30'),
        generatedTo: d('2026-07-01'),
      });
      expect(p.current).toEqual({ fy: '2025-26', quarter: 4 });
      expect(p.availableFys).toEqual(['2024-25', '2025-26', '2026-27']);
      expect(p.availableUntil).toBe('2026-07');
    });

    it('handles a single generated date and a calendar-year FY', () => {
      expect(
        clientPeriods({
          today: d('2026-12-31'),
          fyStartMonth: 1,
          generatedFrom: d('2028-02-29'),
          generatedTo: d('2028-02-29'),
        }),
      ).toEqual({
        current: { fy: '2026-27', quarter: 4 },
        availableFys: ['2026-27', '2028-29'],
        availableUntil: '2028-02',
      });
    });

    it('rejects a half-null or reversed generated range', () => {
      const today = d('2026-10-12');
      expect(() =>
        clientPeriods({
          today,
          fyStartMonth: 4,
          generatedFrom: d('2026-04-01'),
          generatedTo: null,
        }),
      ).toThrow(RangeError);
      expect(() =>
        clientPeriods({
          today,
          fyStartMonth: 4,
          generatedFrom: null,
          generatedTo: d('2026-04-01'),
        }),
      ).toThrow(RangeError);
      expect(() =>
        clientPeriods({
          today,
          fyStartMonth: 4,
          generatedFrom: d('2026-04-02'),
          generatedTo: d('2026-04-01'),
        }),
      ).toThrow(RangeError);
    });

    it('always returns a valid ClientPeriods', () => {
      for (let fyStartMonth = 1; fyStartMonth <= 12; fyStartMonth++) {
        for (const range of [
          none,
          { generatedFrom: d('2019-01-01'), generatedTo: d('2031-12-31') },
        ]) {
          const p = clientPeriods({ today: d('2026-10-12'), fyStartMonth, ...range });
          expect(ClientPeriods.safeParse(p).success).toBe(true);
          expect(p.availableFys).toEqual([...p.availableFys].sort());
        }
      }
    });
  });
});
