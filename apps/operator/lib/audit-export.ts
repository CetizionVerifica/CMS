// The operator audit as a file Excel opens (ADR M15-0001 decision 12): CSV with a UTF-8 byte-order mark, so Excel
// reads ₹ and non-Latin names, and every cell that could start a formula prefixed with an apostrophe.
import type { OperatorAuditEvent } from '@canopy/contracts';

import { ACTION, formatInstant } from './format';

const HEADER = [
  'When (IST)',
  'Action',
  'Account',
  'Operator',
  'Reason',
  'Before',
  'After',
  'IP',
  'Request',
];

/** A cell Excel reads as text: quoted, quotes doubled, and a leading = + - @ tab or return defused. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

const json = (value: Record<string, unknown> | null) =>
  value === null ? '' : JSON.stringify(value);

export function auditCsv(
  events: readonly OperatorAuditEvent[],
  names: {
    accounts: Readonly<Record<string, string>>;
    operators: Readonly<Record<string, string>>;
  },
): string {
  const rows = events.map((e) => [
    formatInstant(e.at),
    ACTION[e.action],
    e.accountId === null ? '' : (names.accounts[e.accountId] ?? e.accountId),
    e.operatorId === null ? 'System' : (names.operators[e.operatorId] ?? e.operatorId),
    e.reason ?? '',
    json(e.before),
    json(e.after),
    e.ip ?? '',
    e.requestId,
  ]);
  return `\uFEFF${[HEADER, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** "operator-audit-2026-10-24.csv". */
export function auditFileName(today: string): string {
  return `operator-audit-${today}.csv`;
}
