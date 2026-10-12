import {
  LocalDate,
  type Action,
  type Can,
  type RequestContext,
  type Role,
  type WorkflowState,
} from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { can } from '../../auth/index.js';
import { membership } from '../../auth/testing.js';
import { allowedActions, instanceResource, type ActionTarget } from './allowed-actions.js';

const FIRM = '0190f000-0000-7000-8000-0000000000f1';
const CLIENT = '0190f000-0000-7000-8000-0000000000c1';
const OTHER_CLIENT = '0190f000-0000-7000-8000-0000000000c2';
const UNIT = '0190f000-0000-7000-8000-0000000000e1';
const OTHER_UNIT = '0190f000-0000-7000-8000-0000000000e2';
const OWNER = '0190f000-0000-7000-8000-000000000001';
const APPROVER = '0190f000-0000-7000-8000-000000000002';
const OTHER = '0190f000-0000-7000-8000-000000000009';

/** A request context with one membership of `role`, scoped to CLIENT unless overridden. */
function ctx(
  role: Role,
  personId: string,
  scope: { clientId?: string; unitIds?: string[] } = {},
): RequestContext {
  const clientId = scope.clientId ?? CLIENT;
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
        clientId: firmRole ? null : clientId,
        consultantClientIds: role === 'CONSULTANT' ? [clientId] : null,
        unitIds: scope.unitIds ?? null,
      }),
    ],
    clientIds: [clientId],
    mfaSatisfied: true,
    asOf: LocalDate.parse('2023-04-20'),
  };
}

/** M5's real can(), recording which actions it was asked about. */
const seen: Action[] = [];
const recordingCan: Can = (c, action, resource) => {
  seen.push(action);
  return can(c, action, resource);
};

function target(workflowState: WorkflowState): ActionTarget {
  return { workflowState, clientId: CLIENT, unitId: UNIT, ownerId: OWNER, approverId: APPROVER };
}

describe("allowedActions with M5's can()", () => {
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
    allowedActions(target('OPEN'), ctx('VIEWER', OTHER), recordingCan);
    expect(new Set(seen)).toEqual(
      new Set([
        'instance.submit',
        'instance.reassign',
        'instance.dueDate',
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
    expect(allowedActions(target(state), ctx(role, person), recordingCan)).toEqual(expected);
  });

  it("offers nothing outside the person's units", () => {
    expect(
      allowedActions(target('OPEN'), ctx('OWNER', OWNER, { unitIds: [OTHER_UNIT] }), can),
    ).toEqual([]);
  });

  it('offers nothing to a consultant on another client', () => {
    expect(
      allowedActions(target('APPROVED'), ctx('CONSULTANT', OTHER, { clientId: OTHER_CLIENT }), can),
    ).toEqual([]);
  });

  it('offers nothing when can() refuses everything', () => {
    expect(allowedActions(target('OPEN'), ctx('FIRM_ADMIN', OTHER), () => false)).toEqual([]);
  });
});
