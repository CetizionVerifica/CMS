import {
  LocalDate,
  type Comment,
  type ComplianceInstance,
  type RequestContext,
  type Role,
} from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { membership } from '../../auth/testing.js';
import { commentAddedEvent, transitionEvent } from './events.js';

const FIRM = '0190f000-0000-7000-8000-0000000000f1';
const CLIENT = '0190f000-0000-7000-8000-0000000000c1';
const OWNER = '0190f000-0000-7000-8000-000000000001';
const APPROVER = '0190f000-0000-7000-8000-000000000002';
const ADMIN = '0190f000-0000-7000-8000-000000000003';
const ID = '0190f000-0000-7000-8000-0000000000a1';

function ctx(personId: string, role: Role): RequestContext {
  const firmRole = role === 'FIRM_ADMIN' || role === 'CONSULTANT';
  return {
    requestId: 'req-1',
    firmId: FIRM,
    personId,
    memberships: [
      membership({
        role,
        firmId: FIRM,
        personId,
        clientId: firmRole ? null : CLIENT,
        consultantClientIds: role === 'CONSULTANT' ? [CLIENT] : null,
      }),
    ],
    clientIds: [CLIENT],
    mfaSatisfied: true,
    asOf: LocalDate.parse('2023-01-20'),
  };
}

const base = {
  id: ID,
  clientId: CLIENT,
  ownerId: OWNER,
  approverId: APPROVER,
  dueDate: LocalDate.parse('2023-01-31'),
  version: 2,
} as const;

/** The fields the event builders read; the rest of the instance does not matter here. */
function instance(fields: Partial<ComplianceInstance>): ComplianceInstance {
  return { ...base, ...fields } as ComplianceInstance;
}

describe('transitionEvent', () => {
  it('submit and request NA are instance.submitted with the pending kind', () => {
    const after = instance({ pendingKind: 'NA', completedOn: null });
    expect(
      transitionEvent(
        ctx(OWNER, 'OWNER'),
        { action: 'REQUEST_NA', reason: 'x' },
        instance({}),
        after,
      ),
    ).toEqual({
      type: 'instance.submitted',
      data: {
        instanceId: ID,
        kind: 'NA',
        ownerId: OWNER,
        approverId: APPROVER,
        dueDate: '2023-01-31',
        completedOn: null,
      },
    });
  });

  it('approve names the result state and whether a delegate approved', () => {
    const after = instance({
      workflowState: 'APPROVED',
      completedOn: LocalDate.parse('2023-01-15'),
    });
    const own = transitionEvent(
      ctx(APPROVER, 'APPROVER'),
      { action: 'APPROVE' },
      instance({}),
      after,
    );
    expect(own).toMatchObject({
      type: 'instance.approved',
      data: {
        approverId: APPROVER,
        resultState: 'APPROVED',
        delegated: false,
        completedOn: '2023-01-15',
      },
    });
    const delegate = transitionEvent(
      ctx(ADMIN, 'CLIENT_ADMIN'),
      { action: 'APPROVE' },
      instance({}),
      after,
    );
    expect(delegate.data).toMatchObject({ approverId: ADMIN, delegated: true });
  });

  it('send back names the approver and the owner', () => {
    expect(
      transitionEvent(
        ctx(APPROVER, 'APPROVER'),
        { action: 'SEND_BACK', reason: 'x' },
        instance({}),
        instance({ workflowState: 'SENT_BACK' }),
      ),
    ).toEqual({
      type: 'instance.sent_back',
      data: { instanceId: ID, approverId: APPROVER, ownerId: OWNER },
    });
  });

  it('reopen names the previous state and the role that reopened', () => {
    const before = instance({ workflowState: 'NOT_APPLICABLE' });
    const after = instance({ workflowState: 'OPEN' });
    for (const role of ['CLIENT_ADMIN', 'CONSULTANT', 'FIRM_ADMIN'] as const) {
      expect(
        transitionEvent(ctx(ADMIN, role), { action: 'REOPEN', reason: 'x' }, before, after),
      ).toEqual({
        type: 'instance.reopened',
        data: { instanceId: ID, previousState: 'NOT_APPLICABLE', byRole: role },
      });
    }
  });
});

describe('commentAddedEvent', () => {
  it('carries ids and the kind, never the body', () => {
    const comment = {
      id: '0190f000-0000-7000-8000-0000000000d1',
      instanceId: ID,
      authorId: OWNER,
      kind: 'NOTE',
      body: 'Contains a name.',
    } as Comment;
    const event = commentAddedEvent(comment);
    expect(event).toEqual({
      type: 'comment.added',
      data: { commentId: comment.id, instanceId: ID, kind: 'NOTE', authorId: OWNER },
    });
    expect(JSON.stringify(event)).not.toContain('Contains a name');
  });
});
