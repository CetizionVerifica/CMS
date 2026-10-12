import {
  LocalDate,
  type Action,
  type Can,
  type Membership,
  type RequestContext,
  type Role,
  type WorkflowState,
} from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { allowedActions, instanceResource, type ActionTarget } from './allowed-actions.js';

const FIRM = '0190f000-0000-7000-8000-0000000000f1';
const CLIENT = '0190f000-0000-7000-8000-0000000000c1';
const UNIT = '0190f000-0000-7000-8000-0000000000e1';
const OWNER = '0190f000-0000-7000-8000-000000000001';
const APPROVER = '0190f000-0000-7000-8000-000000000002';
const OTHER = '0190f000-0000-7000-8000-000000000009';
const AT = '2023-04-01T00:00:00Z';

function ctx(role: Role, personId: string): RequestContext {
  const firmRole = role === 'FIRM_ADMIN' || role === 'CONSULTANT';
  const membership: Membership = {
    id: '0190f000-0000-7000-8000-0000000000d1',
    firmId: FIRM,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    version: 1,
    personId,
    role,
    clientId: firmRole ? null : CLIENT,
    consultantClientIds: role === 'CONSULTANT' ? [CLIENT] : null,
    unitIds: null,
    expiresAt: role === 'VIEWER' ? '2030-01-01T00:00:00Z' : null,
  };
  return {
    requestId: 'req-1',
    firmId: FIRM,
    personId,
    memberships: [membership],
    clientIds: [CLIENT],
    mfaSatisfied: true,
    asOf: LocalDate.parse('2023-04-20'),
  };
}

/** The endpoints.md §4 matrix, as a stand-in for M5's policy table. "own" = owner or approver of the instance. */
const MATRIX: Record<string, Partial<Record<Role, 'all' | 'own'>>> = {
  'instance.submit': { OWNER: 'own' },
  'instance.approve': { CLIENT_ADMIN: 'all', APPROVER: 'own' },
  'instance.reopen': { FIRM_ADMIN: 'all', CONSULTANT: 'all', CLIENT_ADMIN: 'all' },
  'instance.reassign': { FIRM_ADMIN: 'all', CONSULTANT: 'all', CLIENT_ADMIN: 'all' },
  'instance.due_date': { FIRM_ADMIN: 'all', CONSULTANT: 'all', CLIENT_ADMIN: 'all' },
  'comment.write': {
    FIRM_ADMIN: 'all',
    CONSULTANT: 'all',
    CLIENT_ADMIN: 'all',
    APPROVER: 'own',
    OWNER: 'own',
  },
  'evidence.write': {
    FIRM_ADMIN: 'all',
    CONSULTANT: 'all',
    CLIENT_ADMIN: 'all',
    APPROVER: 'own',
    OWNER: 'own',
  },
};

const seen: Action[] = [];
const can: Can = (c, action, resource) => {
  seen.push(action);
  return c.memberships.some((m) => {
    const rule = MATRIX[action]?.[m.role];
    if (rule === 'all') return true;
    if (rule !== 'own') return false;
    return m.role === 'OWNER'
      ? resource.ownerId === c.personId
      : resource.approverId === c.personId;
  });
};

function target(workflowState: WorkflowState): ActionTarget {
  return { workflowState, clientId: CLIENT, unitId: UNIT, ownerId: OWNER, approverId: APPROVER };
}

describe('allowedActions', () => {
  it('passes the instance as the can() resource', () => {
    expect(instanceResource(target('OPEN'))).toEqual({
      type: 'instance',
      clientId: CLIENT,
      unitId: UNIT,
      ownerId: OWNER,
      approverId: APPROVER,
    });
  });

  it('asks can() with the endpoints.md action names', () => {
    seen.length = 0;
    allowedActions(target('OPEN'), ctx('VIEWER', OTHER), can);
    expect(new Set(seen)).toEqual(
      new Set([
        'instance.submit',
        'instance.reassign',
        'instance.due_date',
        'comment.write',
        'evidence.write',
      ]),
    );
  });

  it.each([
    ['OWNER', OWNER, 'OPEN', ['SUBMIT', 'REQUEST_NA', 'COMMENT', 'UPLOAD_EVIDENCE']],
    ['OWNER', OWNER, 'SENT_BACK', ['SUBMIT', 'REQUEST_NA', 'COMMENT', 'UPLOAD_EVIDENCE']],
    ['OWNER', OWNER, 'SUBMITTED', ['COMMENT', 'UPLOAD_EVIDENCE']],
    ['OWNER', OWNER, 'APPROVED', ['COMMENT']],
    ['OWNER', OTHER, 'OPEN', []],
    ['APPROVER', APPROVER, 'SUBMITTED', ['APPROVE', 'SEND_BACK', 'COMMENT', 'UPLOAD_EVIDENCE']],
    ['APPROVER', APPROVER, 'OPEN', ['COMMENT', 'UPLOAD_EVIDENCE']],
    ['APPROVER', OTHER, 'SUBMITTED', []],
    [
      'CLIENT_ADMIN',
      OTHER,
      'SUBMITTED',
      ['APPROVE', 'SEND_BACK', 'REASSIGN', 'CHANGE_DUE_DATE', 'COMMENT', 'UPLOAD_EVIDENCE'],
    ],
    ['CLIENT_ADMIN', OTHER, 'APPROVED', ['REOPEN', 'COMMENT']],
    ['CONSULTANT', OTHER, 'NOT_APPLICABLE', ['REOPEN', 'COMMENT']],
    ['CONSULTANT', OTHER, 'OPEN', ['REASSIGN', 'CHANGE_DUE_DATE', 'COMMENT', 'UPLOAD_EVIDENCE']],
    ['FIRM_ADMIN', OTHER, 'APPROVED', ['REOPEN', 'COMMENT']],
    ['VIEWER', OTHER, 'OPEN', []],
    ['VIEWER', OTHER, 'SUBMITTED', []],
  ] as const)('%s (%s) on %s → %j', (role, person, state, expected) => {
    expect(allowedActions(target(state), ctx(role, person), can)).toEqual(expected);
  });

  it('offers nothing when can() refuses everything', () => {
    expect(allowedActions(target('OPEN'), ctx('FIRM_ADMIN', OTHER), () => false)).toEqual([]);
  });
});
