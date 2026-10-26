import type { CertificationCycleItem, LocalDate } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { ISO } from '../_test/fixture';
import {
  auditDates,
  auditOpen,
  auditsByDate,
  auditTitle,
  certificatesToShow,
  cycleLine,
  isIssued,
} from './certification-model';

const day = (s: string) => s as LocalDate;
const item: CertificationCycleItem = {
  kind: 'SURVEILLANCE_1',
  dueOn: day('2025-07-22'),
  metByAuditId: null,
  metOn: null,
  daysLate: null,
  overdueDays: null,
};

describe('cycleLine', () => {
  it('words each due date of the cycle from the API’s numbers', () => {
    expect(cycleLine(item)).toEqual({
      label: 'Surveillance 1, due 22 Jul 2025',
      text: 'Not yet held',
      tone: 'neutral',
    });
    expect(cycleLine({ ...item, overdueDays: 1 })).toMatchObject({
      text: 'Overdue 1 day',
      tone: 'crit',
    });
    expect(cycleLine({ ...item, overdueDays: 4 }).text).toBe('Overdue 4 days');
    const met = { ...item, metByAuditId: 'a', metOn: day('2025-07-20') };
    expect(cycleLine(met)).toMatchObject({ text: 'Met 20 Jul 2025', tone: 'ok' });
    expect(cycleLine({ ...met, daysLate: 1 }).text).toBe('Met 20 Jul 2025, 1 day late');
    expect(cycleLine({ ...met, daysLate: 3 })).toMatchObject({
      text: 'Met 20 Jul 2025, 3 days late',
      tone: 'warn',
    });
  });
});

describe('certificates and visits', () => {
  it('tells issued from being pursued and keeps an overview’s ids', () => {
    const [issued, pursued] = ISO.certs;
    expect(isIssued(issued!)).toBe(true);
    expect(isIssued(pursued!)).toBe(false);
    const order = ISO.system.standardIds;
    expect(certificatesToShow([pursued!, issued!], [], order).map((c) => c.id)).toEqual([
      issued!.id,
      pursued!.id,
    ]);
    expect(certificatesToShow(ISO.certs, [pursued!.id], order)).toEqual([pursued]);
  });

  it('names visits by type and standards, newest first, and knows the final states', () => {
    const sorted = auditsByDate(ISO.audits);
    expect(sorted.map((a) => a.type)).toEqual(['SURVEILLANCE_1', 'STAGE_1', 'STAGE_2']);
    expect(auditTitle(sorted[1]!, ISO.standards)).toBe('Stage 1 · ISO 14001, ISO 45001');
    expect(auditDates(sorted[1]!)).toBe('4 Nov 2024 to 5 Nov 2024');
    expect(auditDates({ startOn: day('2024-11-04'), endOn: day('2024-11-04') })).toBe('4 Nov 2024');
    expect(sorted.map(auditOpen)).toEqual([true, true, false]);
    expect(auditOpen({ state: 'CANCELLED' })).toBe(false);
  });
});
