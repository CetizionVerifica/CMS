import type { AuditEvent } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { commentLabel, timelineEvents } from './timeline';

const PERSON = '00000000-0000-5000-8000-000000000201';

function event(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    id: '00000000-0000-5000-8000-000000000a01',
    firmId: '00000000-0000-5000-8000-0000000000f1',
    clientId: '00000000-0000-5000-8000-000000000101',
    at: '2024-11-15T05:30:00Z',
    requestId: 'req-1',
    actorId: PERSON,
    actorKind: 'PERSON',
    action: 'TRANSITION',
    entityType: 'instance',
    entityId: '00000000-0000-5000-8000-000000000301',
    before: null,
    after: null,
    reason: null,
    ...overrides,
  } as AuditEvent;
}

const names = { [PERSON]: 'Owner 01' };
const one = (overrides: Partial<AuditEvent>) => timelineEvents([event(overrides)], names)[0]!;

describe('timelineEvents', () => {
  it('names each workflow move from the state it went to', () => {
    const moved = (before: string, after: string, pendingKind: string | null = null) =>
      one({
        before: { workflowState: before },
        after: { workflowState: after, pendingKind },
      });
    expect(moved('OPEN', 'SUBMITTED', 'COMPLETION')).toMatchObject({
      kind: 'submitted',
      summary: 'submitted it',
    });
    expect(moved('OPEN', 'SUBMITTED', 'NA')).toMatchObject({
      kind: 'na_requested',
      summary: 'asked to mark it not applicable',
    });
    expect(moved('SUBMITTED', 'APPROVED')).toMatchObject({ kind: 'approved' });
    expect(moved('SUBMITTED', 'NOT_APPLICABLE')).toMatchObject({ kind: 'na_approved' });
    expect(moved('SUBMITTED', 'SENT_BACK')).toMatchObject({ kind: 'sent_back' });
    expect(moved('APPROVED', 'OPEN')).toMatchObject({ summary: 'reopened it' });
    expect(moved('NOT_APPLICABLE', 'OPEN')).toMatchObject({ summary: 'reopened it' });
    expect(moved('SENT_BACK', 'OPEN')).toMatchObject({ summary: 'changed its state' });
    expect(one({ after: null })).toMatchObject({ summary: 'changed its state' });
  });

  it('names the other actions, with the reason and a moved due date', () => {
    expect(one({ action: 'EVIDENCE_ADD' })).toMatchObject({ summary: 'added evidence' });
    expect(one({ action: 'EVIDENCE_REMOVE', reason: 'Wrong file' })).toMatchObject({
      kind: 'evidence_removed',
      detail: { reason: 'Wrong file' },
    });
    expect(
      one({
        action: 'DUE_DATE_CHANGE',
        before: { dueDate: '2024-04-30' },
        after: { dueDate: '2024-05-15' },
        reason: 'Holiday',
      }),
    ).toMatchObject({
      kind: 'due_date_changed',
      detail: { from: '30 Apr 2024', to: '15 May 2024', reason: 'Holiday' },
    });
    expect(one({ action: 'DUE_DATE_CHANGE', before: null, after: null }).detail).toBeUndefined();
    expect(one({ action: 'LOGIN' })).toMatchObject({ kind: 'updated', summary: 'updated it' });
  });

  it('shows people by name, an unknown person as "Someone" and the system as itself', () => {
    expect(one({}).actor).toEqual({ name: 'Owner 01' });
    expect(one({ actorId: '00000000-0000-5000-8000-000000000999' }).actor).toEqual({
      name: 'Someone',
    });
    expect(one({ actorKind: 'SYSTEM', actorId: null }).actor).toBe('system');
    expect(one({ actorKind: 'IMPORT', actorId: null, action: 'IMPORT' })).toMatchObject({
      actor: 'system',
      summary: 'imported it',
    });
  });
});

describe('commentLabel', () => {
  it('tags workflow comments and leaves notes plain', () => {
    expect(commentLabel('NOTE')).toBeNull();
    expect(commentLabel('SEND_BACK')).toBe('Sent back');
    expect(commentLabel('NA_REQUEST')).toBe('Asked for not applicable');
  });
});
