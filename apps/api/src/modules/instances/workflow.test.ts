import { ComplianceInstance, LocalDate, WorkflowState, type ScanStatus } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import {
  canTransition,
  planTransition,
  TRANSITION_SOURCES,
  type TransitionAction,
  type TransitionCommand,
  type TransitionInput,
  type WorkflowFields,
  type WorkflowInstance,
} from './workflow.js';

const d = (s: string) => LocalDate.parse(s);
const OWNER = '0190f000-0000-7000-8000-000000000001';
const APPROVER = '0190f000-0000-7000-8000-000000000002';
const CLIENT_ADMIN = '0190f000-0000-7000-8000-000000000003';
const ASOF = d('2023-04-20');
const NOW = '2023-04-20T06:30:00Z';
const EARLIER = '2023-04-18T05:00:00Z';

/** A valid instance in each workflow state (the shapes ComplianceInstance allows). */
const STATE_FIELDS: Record<WorkflowState, WorkflowFields> = {
  OPEN: {
    workflowState: 'OPEN',
    pendingKind: null,
    completedOn: null,
    naReason: null,
    submittedAt: null,
    approvedAt: null,
  },
  SENT_BACK: {
    workflowState: 'SENT_BACK',
    pendingKind: null,
    completedOn: null,
    naReason: null,
    submittedAt: EARLIER,
    approvedAt: null,
  },
  SUBMITTED: {
    workflowState: 'SUBMITTED',
    pendingKind: 'COMPLETION',
    completedOn: d('2023-04-15'),
    naReason: null,
    submittedAt: EARLIER,
    approvedAt: null,
  },
  APPROVED: {
    workflowState: 'APPROVED',
    pendingKind: null,
    completedOn: d('2023-04-15'),
    naReason: null,
    submittedAt: EARLIER,
    approvedAt: EARLIER,
  },
  NOT_APPLICABLE: {
    workflowState: 'NOT_APPLICABLE',
    pendingKind: null,
    completedOn: d('2023-04-18'),
    naReason: 'Unit has no boilers.',
    submittedAt: EARLIER,
    approvedAt: EARLIER,
  },
};

function instance(state: WorkflowState, extra: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    id: '0190f000-0000-7000-8000-0000000000aa',
    version: 3,
    approverId: APPROVER,
    ...STATE_FIELDS[state],
    ...extra,
  };
}

const COMMANDS: Record<TransitionAction, TransitionCommand> = {
  SUBMIT: { action: 'SUBMIT', completedOn: d('2023-04-19'), comment: 'Filed return.' },
  REQUEST_NA: { action: 'REQUEST_NA', reason: 'Unit has no boilers.' },
  APPROVE: { action: 'APPROVE' },
  SEND_BACK: { action: 'SEND_BACK', reason: 'Wrong challan attached.' },
  REOPEN: { action: 'REOPEN', reason: 'Approved by mistake.' },
};

function input(
  inst: WorkflowInstance,
  command: TransitionCommand,
  extra: Partial<TransitionInput> = {},
): TransitionInput {
  const owner = command.action === 'SUBMIT' || command.action === 'REQUEST_NA';
  return {
    instance: inst,
    expectedVersion: inst.version,
    command,
    actorId: owner ? OWNER : APPROVER,
    asOf: ASOF,
    now: NOW,
    evidenceRequired: false,
    evidence: [],
    ...extra,
  };
}

function errorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('Expected an ApiError');
}

describe('state machine arrows', () => {
  it('OPEN → submit → SUBMITTED (COMPLETION)', () => {
    const plan = planTransition(input(instance('OPEN'), COMMANDS.SUBMIT));
    expect(plan.fields).toEqual({
      workflowState: 'SUBMITTED',
      pendingKind: 'COMPLETION',
      completedOn: '2023-04-19',
      naReason: null,
      submittedAt: NOW,
      approvedAt: null,
    });
    expect(plan.version).toBe(4);
    expect(plan.comment).toEqual({ kind: 'SUBMIT', body: 'Filed return.' });
    expect(plan.audit).toEqual({
      action: 'TRANSITION',
      before: { workflowState: 'OPEN', pendingKind: null, completedOn: null, submittedAt: null },
      after: {
        workflowState: 'SUBMITTED',
        pendingKind: 'COMPLETION',
        completedOn: '2023-04-19',
        submittedAt: NOW,
      },
      reason: null,
    });
  });

  it('SENT_BACK → submit → SUBMITTED, with a fresh submittedAt', () => {
    const plan = planTransition(input(instance('SENT_BACK'), COMMANDS.SUBMIT));
    expect(plan.fields.workflowState).toBe('SUBMITTED');
    expect(plan.fields.pendingKind).toBe('COMPLETION');
    expect(plan.fields.submittedAt).toBe(NOW);
    expect(plan.audit.before).toMatchObject({ workflowState: 'SENT_BACK', submittedAt: EARLIER });
  });

  it('SUBMITTED (COMPLETION) → approve → APPROVED, keeping completedOn', () => {
    const plan = planTransition(input(instance('SUBMITTED'), COMMANDS.APPROVE));
    expect(plan.fields).toEqual({
      workflowState: 'APPROVED',
      pendingKind: null,
      completedOn: '2023-04-15',
      naReason: null,
      submittedAt: EARLIER,
      approvedAt: NOW,
    });
    expect(plan.comment).toEqual({ kind: 'APPROVE', body: 'Approved.' });
    expect(plan.audit.before).toEqual({
      workflowState: 'SUBMITTED',
      pendingKind: 'COMPLETION',
      approvedAt: null,
    });
    expect(plan.audit.after).toEqual({
      workflowState: 'APPROVED',
      pendingKind: null,
      approvedAt: NOW,
    });
    expect(plan.audit.reason).toBeNull();
  });

  it('SUBMITTED → send back → SENT_BACK, clearing the submission', () => {
    const plan = planTransition(input(instance('SUBMITTED'), COMMANDS.SEND_BACK));
    expect(plan.fields).toEqual({
      workflowState: 'SENT_BACK',
      pendingKind: null,
      completedOn: null,
      naReason: null,
      submittedAt: EARLIER,
      approvedAt: null,
    });
    expect(plan.comment).toEqual({ kind: 'SEND_BACK', body: 'Wrong challan attached.' });
    expect(plan.audit.reason).toBe('Wrong challan attached.');
  });

  it.each(['OPEN', 'SENT_BACK'] as const)('%s → request NA → SUBMITTED (NA)', (state) => {
    const plan = planTransition(input(instance(state), COMMANDS.REQUEST_NA));
    expect(plan.fields).toEqual({
      workflowState: 'SUBMITTED',
      pendingKind: 'NA',
      completedOn: null,
      naReason: 'Unit has no boilers.',
      submittedAt: NOW,
      approvedAt: null,
    });
    expect(plan.comment).toEqual({ kind: 'NA_REQUEST', body: 'Unit has no boilers.' });
    expect(plan.audit.reason).toBe('Unit has no boilers.');
  });

  it('SUBMITTED (NA) → approve → NOT_APPLICABLE, dated the day it was signed off', () => {
    const pendingNa = instance('SUBMITTED', {
      pendingKind: 'NA',
      completedOn: null,
      naReason: 'Unit has no boilers.',
    });
    const plan = planTransition(input(pendingNa, { action: 'APPROVE', comment: ' Agreed. ' }));
    expect(plan.fields).toEqual({
      workflowState: 'NOT_APPLICABLE',
      pendingKind: null,
      completedOn: ASOF,
      naReason: 'Unit has no boilers.',
      submittedAt: EARLIER,
      approvedAt: NOW,
    });
    expect(plan.comment).toEqual({ kind: 'APPROVE', body: 'Agreed.' });
    expect(plan.audit.reason).toBe('Agreed.');
  });

  it('SUBMITTED (NA) → send back → SENT_BACK, clearing the NA reason', () => {
    const pendingNa = instance('SUBMITTED', {
      pendingKind: 'NA',
      completedOn: null,
      naReason: 'Unit has no boilers.',
    });
    const plan = planTransition(input(pendingNa, COMMANDS.SEND_BACK));
    expect(plan.fields.workflowState).toBe('SENT_BACK');
    expect(plan.fields.naReason).toBeNull();
    expect(plan.audit.before).toMatchObject({ naReason: 'Unit has no boilers.' });
  });

  it.each(['APPROVED', 'NOT_APPLICABLE'] as const)(
    '%s → reopen → OPEN, clearing everything',
    (state) => {
      const plan = planTransition(input(instance(state), COMMANDS.REOPEN));
      expect(plan.fields).toEqual(STATE_FIELDS.OPEN);
      expect(plan.comment).toEqual({ kind: 'REOPEN', body: 'Approved by mistake.' });
      expect(plan.audit.reason).toBe('Approved by mistake.');
      expect(plan.audit.after).toMatchObject({ workflowState: 'OPEN', completedOn: null });
    },
  );
});

describe('every arrow lands on a valid instance', () => {
  const arrows = WorkflowState.options.flatMap((state) =>
    (Object.keys(TRANSITION_SOURCES) as TransitionAction[])
      .filter((action) => TRANSITION_SOURCES[action].includes(state))
      .map((action) => [state, action] as const),
  );

  it.each(arrows)('%s → %s parses as a ComplianceInstance', (state, action) => {
    const plan = planTransition(input(instance(state), COMMANDS[action]));
    const row = {
      id: '0190f000-0000-7000-8000-0000000000aa',
      firmId: '0190f000-0000-7000-8000-0000000000f1',
      createdAt: EARLIER,
      updatedAt: NOW,
      archivedAt: null,
      version: plan.version,
      clientId: '0190f000-0000-7000-8000-0000000000c1',
      unitId: '0190f000-0000-7000-8000-0000000000e1',
      assignmentId: '0190f000-0000-7000-8000-0000000000a1',
      periodStart: '2023-04-01',
      periodEnd: '2023-04-30',
      dueDate: '2023-05-15',
      ownerId: OWNER,
      approverId: APPROVER,
      dueDateOverridden: false,
      ...plan.fields,
    };
    expect(ComplianceInstance.safeParse(row).success).toBe(true);
  });
});

describe('invalid transitions', () => {
  const cases = WorkflowState.options.flatMap((state) =>
    (Object.keys(TRANSITION_SOURCES) as TransitionAction[])
      .filter((action) => !TRANSITION_SOURCES[action].includes(state))
      .map((action) => [state, action] as const),
  );

  it('covers every state and action the machine forbids', () => {
    // 5 states × 5 transitions, minus the 8 arrows.
    expect(cases).toHaveLength(17);
  });

  it.each(cases)('%s cannot %s (409 INVALID_TRANSITION)', (state, action) => {
    expect(canTransition(state, action)).toBe(false);
    const error = errorOf(() => planTransition(input(instance(state), COMMANDS[action])));
    expect(error.code).toBe('INVALID_TRANSITION');
    expect(error.httpStatus).toBe(409);
    expect(error.details).toEqual({ from: state, action });
  });

  it('names the action in plain words', () => {
    const error = errorOf(() => planTransition(input(instance('APPROVED'), COMMANDS.SEND_BACK)));
    expect(error.message).toBe('Cannot send back an item that is approved.');
  });

  it.each([
    [
      'SUBMITTED',
      'REQUEST_NA',
      'Cannot request not applicable for an item that is waiting for approval.',
    ],
    ['OPEN', 'APPROVE', 'Cannot approve an item that is open.'],
    ['SENT_BACK', 'REOPEN', 'Cannot reopen an item that is sent back.'],
    ['NOT_APPLICABLE', 'SUBMIT', 'Cannot submit an item that is not applicable.'],
  ] as const)('%s + %s reads in plain words', (state, action, message) => {
    expect(errorOf(() => planTransition(input(instance(state), COMMANDS[action]))).message).toBe(
      message,
    );
  });
});

describe('optimistic concurrency', () => {
  it.each([2, 4])('a stale version %i is 409 STALE_VERSION with the current version', (seen) => {
    const error = errorOf(() =>
      planTransition(input(instance('OPEN'), COMMANDS.SUBMIT, { expectedVersion: seen })),
    );
    expect(error.code).toBe('STALE_VERSION');
    expect(error.httpStatus).toBe(409);
    expect(error.details).toEqual({ currentVersion: 3 });
  });

  it('checks the version before the state, so a stale client reloads first', () => {
    const error = errorOf(() =>
      planTransition(input(instance('APPROVED'), COMMANDS.SUBMIT, { expectedVersion: 1 })),
    );
    expect(error.code).toBe('STALE_VERSION');
  });
});

describe('submit checks', () => {
  it('accepts a completion dated today', () => {
    const plan = planTransition(input(instance('OPEN'), { action: 'SUBMIT', completedOn: ASOF }));
    expect(plan.fields.completedOn).toBe(ASOF);
    expect(plan.comment.body).toBe('Submitted for approval.');
  });

  it('rejects a completion dated tomorrow (422 DATE_IN_FUTURE)', () => {
    const error = errorOf(() =>
      planTransition(input(instance('OPEN'), { action: 'SUBMIT', completedOn: d('2023-04-21') })),
    );
    expect(error.code).toBe('DATE_IN_FUTURE');
    expect(error.httpStatus).toBe(422);
    expect(error.details).toEqual({ today: '2023-04-20' });
  });

  it('treats a blank comment as none', () => {
    const plan = planTransition(
      input(instance('OPEN'), { action: 'SUBMIT', completedOn: ASOF, comment: '   ' }),
    );
    expect(plan.comment.body).toBe('Submitted for approval.');
  });

  const evidenceCases: [ScanStatus[], string | null][] = [
    [[], 'EVIDENCE_REQUIRED'],
    [['INFECTED', 'FAILED'], 'EVIDENCE_REQUIRED'],
    [['PENDING'], 'EVIDENCE_NOT_READY'],
    [['PENDING', 'INFECTED'], 'EVIDENCE_NOT_READY'],
    [['PENDING', 'CLEAN'], null],
    [['CLEAN'], null],
  ];

  it.each(evidenceCases)('evidence required with files %j → %s', (evidence, code) => {
    const run = () =>
      planTransition(
        input(instance('OPEN'), COMMANDS.SUBMIT, { evidenceRequired: true, evidence }),
      );
    if (code === null) {
      expect(run().fields.workflowState).toBe('SUBMITTED');
    } else {
      const error = errorOf(run);
      expect(error.code).toBe(code);
      expect(error.httpStatus).toBe(422);
    }
  });

  it('reports the scan status when evidence is still being scanned', () => {
    const error = errorOf(() =>
      planTransition(
        input(instance('OPEN'), COMMANDS.SUBMIT, { evidenceRequired: true, evidence: ['PENDING'] }),
      ),
    );
    expect(error.details).toEqual({ scanStatus: 'PENDING' });
  });

  it('does not need evidence when the obligation does not ask for it', () => {
    const plan = planTransition(input(instance('OPEN'), COMMANDS.SUBMIT, { evidence: [] }));
    expect(plan.fields.workflowState).toBe('SUBMITTED');
  });

  it('does not need evidence to request NA', () => {
    const plan = planTransition(
      input(instance('OPEN'), COMMANDS.REQUEST_NA, { evidenceRequired: true }),
    );
    expect(plan.fields.pendingKind).toBe('NA');
  });
});

describe('reasons', () => {
  it.each([
    ['REQUEST_NA', 'OPEN'],
    ['SEND_BACK', 'SUBMITTED'],
    ['REOPEN', 'APPROVED'],
  ] as const)('%s needs a reason (422 REASON_REQUIRED)', (action, state) => {
    const command = { action, reason: '  \n ' } as TransitionCommand;
    const error = errorOf(() => planTransition(input(instance(state), command)));
    expect(error.code).toBe('REASON_REQUIRED');
    expect(error.httpStatus).toBe(422);
    expect(error.details).toBeUndefined();
  });

  it('trims the reason it stores', () => {
    const plan = planTransition(
      input(instance('SUBMITTED'), { action: 'SEND_BACK', reason: '  Wrong challan.  ' }),
    );
    expect(plan.comment.body).toBe('Wrong challan.');
    expect(plan.audit.reason).toBe('Wrong challan.');
  });
});

describe('delegation', () => {
  it.each(['APPROVE', 'SEND_BACK'] as const)(
    '%s by someone other than the approver is audited as delegated',
    (action) => {
      const plan = planTransition(
        input(instance('SUBMITTED'), COMMANDS[action], { actorId: CLIENT_ADMIN }),
      );
      expect(plan.audit.after.delegated).toBe(true);
    },
  );

  it('the approver acting is not delegated', () => {
    const plan = planTransition(input(instance('SUBMITTED'), COMMANDS.APPROVE));
    expect(plan.audit.after).not.toHaveProperty('delegated');
  });

  it('reopen by a consultant is not a delegation', () => {
    const plan = planTransition(
      input(instance('APPROVED'), COMMANDS.REOPEN, { actorId: CLIENT_ADMIN }),
    );
    expect(plan.audit.after).not.toHaveProperty('delegated');
  });
});
