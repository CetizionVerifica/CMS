import type { OperatorAuditEvent } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { auditCsv, auditFileName, csvCell } from './audit-export';

const event = (over: Partial<OperatorAuditEvent> = {}): OperatorAuditEvent => ({
  id: '01900000-0000-7000-8000-0000000000c1',
  at: '2026-10-24T09:35:00.000Z',
  operatorId: 'op-1',
  action: 'ACCOUNT_SUSPEND',
  accountId: 'acc-1',
  before: { status: 'ACTIVE' },
  after: { status: 'SUSPENDED' },
  reason: 'Unpaid invoice',
  requestId: 'req-1',
  ip: '203.0.113.4',
  ...over,
});

describe('the audit download', () => {
  it('quotes cells and defuses anything Excel would run as a formula', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    for (const risky of ['=SUM(A1)', '+1', '-1', '@cmd', '\tx']) {
      expect(csvCell(risky).startsWith(`"'`)).toBe(true);
    }
  });

  it('writes a BOM, a header and one row per event with names', () => {
    const text = auditCsv(
      [event(), event({ operatorId: null, accountId: null, reason: null, before: null, ip: null })],
      {
        accounts: { 'acc-1': 'Kestrel Metals Group' },
        operators: { 'op-1': 'Meera Iyer' },
      },
    );
    expect(text.startsWith('﻿"When (IST)"')).toBe(true);
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(
      '"24 Oct 2026, 15:05 IST","Suspended account","Kestrel Metals Group","Meera Iyer","Unpaid invoice"',
    );
    expect(lines[1]).toContain('"{""status"":""SUSPENDED""}"');
    expect(lines[2]).toContain('"","System",""');
    expect(auditFileName('2026-10-24')).toBe('operator-audit-2026-10-24.csv');
  });

  it('falls back to ids for names it does not know', () => {
    const text = auditCsv([event()], { accounts: {}, operators: {} });
    expect(text).toContain('"acc-1","op-1"');
  });
});
