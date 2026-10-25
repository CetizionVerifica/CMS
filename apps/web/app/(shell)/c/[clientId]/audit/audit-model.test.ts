import {
  ChecklistResult,
  ClauseStatus,
  DocumentStatus,
  EntityType,
  ExternalAuditState,
  ISO_ENTITY_TYPES,
  InternalAuditState,
  IsoActionState,
  ManagementReviewState,
  ManagementSystemStatus,
  NcSeverity,
  NcState,
  PersonStatus,
  RevisionState,
  WorkflowState,
  type AuditEvent,
} from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import {
  ENTITY,
  VALUE_WORDS,
  auditRows,
  changes,
  kindsFrom,
  recordName,
  summary,
} from './audit-model';

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

// ISO entity types are staged outside EntityType until ISO-1b, so a test event names one through a cast.
const iso = (entityType: (typeof ISO_ENTITY_TYPES)[number]) =>
  entityType as unknown as AuditEvent['entityType'];

describe('ENTITY', () => {
  it('has words for every entity type, the staged ISO ones included, and nothing else', () => {
    const types = [...EntityType.options, ...ISO_ENTITY_TYPES];
    expect(Object.keys(ENTITY).sort()).toEqual([...new Set(types)].sort());
    for (const type of types) expect(ENTITY[type]).toMatch(/^((a|an|the) [A-Za-z]|evidence$)/);
  });
});

describe('VALUE_WORDS', () => {
  const maps: [string, string, readonly string[]][] = [
    ['instance', 'workflowState', WorkflowState.options],
    ['person', 'status', PersonStatus.options],
    ['management_system', 'status', ManagementSystemStatus.options],
    ['clause_assessment', 'status', ClauseStatus.options],
    ['controlled_document', 'status', DocumentStatus.options],
    ['document_revision', 'state', RevisionState.options],
    ['internal_audit', 'state', InternalAuditState.options],
    ['audit_checklist_item', 'result', ChecklistResult.options],
    ['external_audit', 'state', ExternalAuditState.options],
    ['nonconformity', 'state', NcState.options],
    ['nonconformity', 'severity', NcSeverity.options],
    ['iso_action', 'state', IsoActionState.options],
    ['management_review', 'state', ManagementReviewState.options],
  ];

  it.each(maps)('words every value of %s.%s, never as the code', (entity, field, values) => {
    const map = VALUE_WORDS[entity as keyof typeof VALUE_WORDS]?.[field];
    expect(Object.keys(map ?? {}).sort()).toEqual([...values].sort());
    for (const value of values) {
      expect(map![value]).toMatch(/^[A-Z][a-z]*( [a-z0-9]+)*$/);
      if (value.length > 2) expect(map![value]).not.toBe(value);
    }
  });

  it('has no map the table above leaves out', () => {
    const named = maps.map(([entity, field]) => `${entity}.${field}`).sort();
    const all = Object.entries(VALUE_WORDS).flatMap(([entity, fields]) =>
      Object.keys(fields ?? {}).map((field) => `${entity}.${field}`),
    );
    expect(all.sort()).toEqual(named);
  });

  it('follows model §4.7 and the status language', () => {
    expect(VALUE_WORDS.nonconformity!.state!.ROOT_CAUSE_FOUND).toBe('Root cause found');
    expect(VALUE_WORDS.document_revision!.state!.IN_REVIEW).toBe('In review');
    expect(VALUE_WORDS.instance!.workflowState!.SUBMITTED).toBe('Awaiting approval');
    expect(VALUE_WORDS.instance!.workflowState!.NOT_APPLICABLE).toBe('Not applicable');
    expect(VALUE_WORDS.person!.status!.INVITED).toBe('Invited');
  });
});

describe('changes in words', () => {
  it('words a state by the record it belongs to', () => {
    expect(
      changes(
        event({
          action: 'TRANSITION',
          entityType: iso('nonconformity'),
          before: { state: 'ROOT_CAUSE_FOUND', severity: 'MINOR' },
          after: { action: 'PLAN_ACTIONS', state: 'ACTIONS_PLANNED', severity: 'MAJOR' },
        }),
      ),
    ).toEqual(['State: Root cause found → Actions planned', 'Severity: Minor → Major']);
    expect(
      changes(
        event({
          action: 'TRANSITION',
          entityType: 'instance',
          before: { workflowState: 'OPEN' },
          after: { workflowState: 'SUBMITTED' },
        }),
      ),
    ).toEqual(['State: Open → Awaiting approval']);
    expect(
      changes(event({ entityType: 'person', after: { name: 'Divya Hegde', status: 'INVITED' } })),
    ).toEqual(['Name: Divya Hegde', 'Status: Invited']);
  });

  it("keeps a risk item's severity a number and a value without a map as it is", () => {
    expect(
      changes(
        event({
          action: 'UPDATE',
          entityType: iso('risk_item'),
          before: { severity: 2 },
          after: { severity: 4 },
        }),
      ),
    ).toEqual(['Severity: 2 → 4']);
    expect(
      changes(
        event({
          action: 'UPDATE',
          entityType: 'unit',
          before: { status: 'A' },
          after: { status: 'B' },
        }),
      ),
    ).toEqual(['Status: A → B']);
    expect(
      changes(
        event({
          action: 'TRANSITION',
          entityType: 'instance',
          before: { workflowState: 'OPEN' },
          after: { workflowState: 'LATER' },
        }),
      ),
    ).toEqual(['State: Open → LATER']);
  });
});

describe('summary for ISO records', () => {
  it('words an ISO step from after.action', () => {
    expect(
      summary(
        event({
          action: 'TRANSITION',
          entityType: iso('nonconformity'),
          after: { action: 'VERIFY_EFFECTIVE', state: 'CLOSED' },
        }),
      ),
    ).toBe('Verified as effective: a nonconformity');
    expect(
      summary(
        event({
          action: 'TRANSITION',
          entityType: iso('controlled_document'),
          after: { action: 'MAKE_OBSOLETE', status: 'OBSOLETE' },
        }),
      ),
    ).toBe('Made obsolete: a controlled document');
    expect(
      summary(
        event({ action: 'TRANSITION', entityType: iso('iso_action'), after: { action: 'X' } }),
      ),
    ).toBe('Moved an ISO action');
    expect(summary(event({ entityType: iso('management_system') }))).toBe(
      'Added a management system',
    );
    expect(summary(event({ action: 'REASSIGN', entityType: iso('internal_audit') }))).toBe(
      'Reassigned an internal audit',
    );
  });

  it('says when a step was taken as delegate', () => {
    expect(
      summary(
        event({
          action: 'TRANSITION',
          entityType: iso('internal_audit'),
          after: { action: 'REPORT', state: 'REPORTED', delegated: true },
        }),
      ),
    ).toBe('Reported an internal audit (as delegate)');
    // The API writes `delegated` when a client admin approves or sends back in the approver's place (#268 audit).
    expect(
      summary(
        event({
          action: 'TRANSITION',
          entityType: 'instance',
          after: { workflowState: 'APPROVED', delegated: true },
        }),
      ),
    ).toBe('Approved an instance (as delegate)');
  });

  it('spells out the ISO fields it knows', () => {
    expect(
      changes(
        event({
          action: 'UPDATE',
          entityType: iso('risk_item'),
          before: { significant: false, reviewDueOn: '2026-11-30', severity: 3 },
          after: { significant: true, reviewDueOn: '2027-05-31', severity: 3 },
        }),
      ),
    ).toEqual(['Significant: No → Yes', 'Next review: 2026-11-30 → 2027-05-31']);
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
