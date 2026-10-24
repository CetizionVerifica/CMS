import type { AuditEvent } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { auditRows, changes, kindsFrom, recordName, summary } from './audit-model';

const base: AuditEvent = {
  id: 'e1',
  firmId: 'f1',
  clientId: 'c1',
  at: '2026-10-24T05:30:00.000Z',
  requestId: 'r1',
  actorId: 'p1',
  actorKind: 'PERSON',
  action: 'CREATE',
  entityType: 'department',
  entityId: 'd1',
  before: null,
  after: { name: 'Legal', aliases: ['Law'] },
  reason: null,
};
const event = (over: Partial<AuditEvent>): AuditEvent => ({ ...base, ...over });

describe('kindsFrom', () => {
  it('turns the URL kinds into the API actions and drops unknown ones', () => {
    expect(kindsFrom('evidence,nope,dates')).toEqual({
      kinds: ['evidence', 'dates'],
      actions: [
        'DUE_DATE_CHANGE',
        'APPLICABILITY_CHANGE',
        'EVIDENCE_ADD',
        'EVIDENCE_REMOVE',
        'EVIDENCE_DOWNLOAD',
      ],
    });
    expect(kindsFrom(null)).toEqual({ kinds: [], actions: [] });
  });
});

describe('summary', () => {
  it('words setup and workflow events', () => {
    expect(summary(base)).toBe('Added a department');
    expect(summary(event({ action: 'ARCHIVE', entityType: 'unit' }))).toBe('Archived a unit');
    expect(
      summary(
        event({
          action: 'TRANSITION',
          entityType: 'instance',
          after: { workflowState: 'APPROVED' },
        }),
      ),
    ).toBe('Approved an instance');
    expect(
      summary(
        event({
          action: 'TRANSITION',
          entityType: 'instance',
          after: { workflowState: 'SUBMITTED', pendingKind: 'NA' },
        }),
      ),
    ).toBe('Asked to mark as not applicable: an instance');
    expect(
      summary(
        event({ action: 'TRANSITION', entityType: 'instance', after: { workflowState: 'X' } }),
      ),
    ).toBe('Moved an instance');
    expect(summary(event({ action: 'APPLICABILITY_CHANGE', entityType: 'instance' }))).toBe(
      'Changed whether an instance applies',
    );
    expect(summary(event({ action: 'DUE_DATE_CHANGE', entityType: 'instance' }))).toBe(
      'Moved the due date of an instance',
    );
    expect(summary(event({ action: 'IMPORT', entityType: 'import_batch' }))).toBe(
      'Committed an import',
    );
    expect(summary(event({ action: 'EXPORT', entityType: 'export' }))).toBe('Started an export');
  });
});

describe('recordName and changes', () => {
  it('names the record from the event, never an evidence file', () => {
    expect(recordName(base)).toBe('Legal');
    expect(recordName(event({ after: null, before: { title: 'Form 5' } }))).toBe('Form 5');
    expect(recordName(event({ after: {} }))).toBeNull();
    expect(
      recordName(
        event({ entityType: 'evidence', action: 'EVIDENCE_ADD', after: { name: 'x.pdf' } }),
      ),
    ).toBeNull();
  });

  it('spells out the fields it knows, before and after', () => {
    expect(changes(base)).toEqual(['Name: Legal', 'Other spellings: Law']);
    expect(
      changes(
        event({
          action: 'UPDATE',
          before: { name: 'Legal', aliases: [], email: null, version: 1 },
          after: { name: 'Legal and Secretarial', aliases: [], email: 'a@b.example', version: 2 },
        }),
      ),
    ).toEqual(['Name: Legal → Legal and Secretarial', 'Email: — → a@b.example']);
    expect(
      changes(event({ action: 'UPDATE', before: { name: { x: 1 } }, after: { name: 'Y' } })),
    ).toEqual([]);
    expect(changes(event({ action: 'EVIDENCE_REMOVE', entityType: 'evidence' }))).toEqual([]);
  });
});

describe('auditRows', () => {
  it('names the actor, or says who else acted', () => {
    const rows = auditRows(
      [
        base,
        event({ id: 'e2', actorId: 'p9' }),
        event({ id: 'e3', actorKind: 'SYSTEM', actorId: null }),
        event({ id: 'e4', actorKind: 'IMPORT', actorId: null, reason: 'Initial load' }),
      ],
      { p1: 'Divya Hegde' },
    );
    expect(rows.map((r) => r.who)).toEqual(['Divya Hegde', 'Someone', 'System', 'Import']);
    expect(rows[0]).toMatchObject({ what: 'Added a department', record: 'Legal', reason: null });
    expect(rows[3]!.reason).toBe('Initial load');
    expect(auditRows([event({ after: {} })], {})[0]!.record).toBe('—');
  });
});
