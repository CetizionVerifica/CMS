import {
  CertificationCycle,
  IsoDueStatus,
  ManagementReviewDue,
  NonconformityStatus,
  type IsoMachine,
} from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import {
  actionStatus,
  asLocalDate as d,
  certificationCycle,
  ISO_NEW_STATE,
  ISO_TRANSITIONS,
  isoMayCheck,
  isoTransition,
  isoTiming,
  managementReviewDue,
  nonconformityStatus,
  reviewDue,
} from '../src/index.js';
import { u } from './iso-ids.js';

const s = { dueSoonDays: 7 };
const asOf = '2026-03-31';

// ---------- the tables ----------

/** Every state and action of each machine (model §4), and the arrows the model draws, as `from action to`. */
const MACHINES: Record<
  IsoMachine,
  {
    states: string[];
    actions: string[];
    arrows: [string, string, string, Record<string, unknown>][];
  }
> = {
  NONCONFORMITY: {
    states: [
      ISO_NEW_STATE,
      'OPEN',
      'ROOT_CAUSE_FOUND',
      'ACTIONS_PLANNED',
      'AWAITING_VERIFICATION',
      'CLOSED',
      'CANCELLED',
    ],
    actions: [
      'RAISE',
      'ADD_ROOT_CAUSE',
      'PLAN_ACTIONS',
      'SUBMIT_NO_ACTION',
      'SUBMIT',
      'VERIFY_EFFECTIVE',
      'VERIFY_NOT_EFFECTIVE',
      'CANCEL',
      'REOPEN',
    ],
    arrows: [
      [ISO_NEW_STATE, 'RAISE', 'OPEN', {}],
      ['OPEN', 'ADD_ROOT_CAUSE', 'ROOT_CAUSE_FOUND', {}],
      ['ROOT_CAUSE_FOUND', 'PLAN_ACTIONS', 'ACTIONS_PLANNED', {}],
      ['ROOT_CAUSE_FOUND', 'SUBMIT_NO_ACTION', 'AWAITING_VERIFICATION', {}],
      ['ACTIONS_PLANNED', 'SUBMIT', 'AWAITING_VERIFICATION', { openActionCount: 0 }],
      ['AWAITING_VERIFICATION', 'VERIFY_EFFECTIVE', 'CLOSED', {}],
      ['AWAITING_VERIFICATION', 'VERIFY_NOT_EFFECTIVE', 'OPEN', { backTo: 'OPEN' }],
      [
        'AWAITING_VERIFICATION',
        'VERIFY_NOT_EFFECTIVE',
        'ACTIONS_PLANNED',
        { backTo: 'ACTIONS_PLANNED', effectivenessDueOn: '2026-04-01' },
      ],
      ['OPEN', 'CANCEL', 'CANCELLED', {}],
      ['ROOT_CAUSE_FOUND', 'CANCEL', 'CANCELLED', {}],
      ['ACTIONS_PLANNED', 'CANCEL', 'CANCELLED', {}],
      ['AWAITING_VERIFICATION', 'CANCEL', 'CANCELLED', {}],
      ['CLOSED', 'REOPEN', 'OPEN', { backTo: 'OPEN' }],
      [
        'CLOSED',
        'REOPEN',
        'ACTIONS_PLANNED',
        { backTo: 'ACTIONS_PLANNED', effectivenessDueOn: '2026-04-30' },
      ],
    ],
  },
  DOCUMENT_REVISION: {
    states: [ISO_NEW_STATE, 'DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED'],
    actions: ['DRAFT_REVISION', 'SUBMIT', 'APPROVE', 'SEND_BACK', 'RECORD_EDITION'],
    arrows: [
      [ISO_NEW_STATE, 'DRAFT_REVISION', 'DRAFT', {}],
      ['DRAFT', 'SUBMIT', 'IN_REVIEW', {}],
      ['IN_REVIEW', 'APPROVE', 'APPROVED', {}],
      ['IN_REVIEW', 'SEND_BACK', 'DRAFT', {}],
      ['DRAFT', 'RECORD_EDITION', 'APPROVED', { documentType: 'EXTERNAL' }],
    ],
  },
  DOCUMENT: {
    states: ['ACTIVE', 'OBSOLETE'],
    actions: ['REVIEW', 'MAKE_OBSOLETE'],
    arrows: [
      ['ACTIVE', 'REVIEW', 'ACTIVE', {}],
      ['ACTIVE', 'MAKE_OBSOLETE', 'OBSOLETE', {}],
    ],
  },
  INTERNAL_AUDIT: {
    states: ['PLANNED', 'IN_PROGRESS', 'REPORTED', 'CLOSED', 'CANCELLED'],
    actions: ['START', 'CANCEL', 'REPORT', 'CLOSE'],
    arrows: [
      ['PLANNED', 'START', 'IN_PROGRESS', {}],
      ['PLANNED', 'CANCEL', 'CANCELLED', {}],
      ['IN_PROGRESS', 'REPORT', 'REPORTED', {}],
      ['REPORTED', 'CLOSE', 'CLOSED', {}],
    ],
  },
  EXTERNAL_AUDIT: {
    states: ['PLANNED', 'HELD', 'RESPONDED', 'CLOSED', 'CANCELLED'],
    actions: ['RECORD_HELD', 'CANCEL', 'RECORD_RESPONSE', 'CLOSE'],
    arrows: [
      ['PLANNED', 'RECORD_HELD', 'HELD', {}],
      ['PLANNED', 'CANCEL', 'CANCELLED', {}],
      ['HELD', 'RECORD_RESPONSE', 'RESPONDED', {}],
      ['HELD', 'CLOSE', 'CLOSED', {}],
      ['RESPONDED', 'CLOSE', 'CLOSED', {}],
    ],
  },
  MANAGEMENT_REVIEW: {
    states: [ISO_NEW_STATE, 'PLANNED', 'HELD', 'CLOSED', 'CANCELLED'],
    actions: ['PLAN', 'CANCEL', 'RECORD_HELD', 'CLOSE'],
    arrows: [
      [ISO_NEW_STATE, 'PLAN', 'PLANNED', {}],
      ['PLANNED', 'CANCEL', 'CANCELLED', {}],
      ['PLANNED', 'RECORD_HELD', 'HELD', {}],
      ['HELD', 'CLOSE', 'CLOSED', { openActionCount: 0 }],
    ],
  },
  CLAUSE_NA: {
    states: ['NONE', 'REQUESTED', 'APPROVED', 'REJECTED'],
    actions: ['REQUEST_NA', 'APPROVE_NA', 'REJECT_NA', 'WITHDRAW_NA'],
    arrows: [
      ['NONE', 'REQUEST_NA', 'REQUESTED', {}],
      ['REJECTED', 'REQUEST_NA', 'REQUESTED', {}],
      ['REQUESTED', 'APPROVE_NA', 'APPROVED', {}],
      ['REQUESTED', 'REJECT_NA', 'REJECTED', {}],
      ['APPROVED', 'WITHDRAW_NA', 'NONE', {}],
    ],
  },
  ISO_ACTION: {
    states: ['OPEN', 'DONE', 'CANCELLED'],
    actions: ['COMPLETE', 'CANCEL', 'REOPEN'],
    arrows: [
      ['OPEN', 'COMPLETE', 'DONE', {}],
      ['OPEN', 'CANCEL', 'CANCELLED', {}],
      ['DONE', 'REOPEN', 'OPEN', {}],
      ['CANCELLED', 'REOPEN', 'OPEN', {}],
    ],
  },
};

/** Facts that satisfy every guard of every arrow (each arrow reads only its own). */
const GOOD: Record<string, unknown> = {
  asOf,
  reason: 'Recorded in error',
  // nonconformity
  description: 'Calibration overdue on press 2',
  source: 'PROCESS',
  severity: 'MINOR',
  ownerId: 'owner',
  approverId: 'approver',
  dueOn: '2026-04-30',
  incident: null,
  fromFinding: false,
  containment: 'Press stopped',
  correction: 'Recalibrated',
  rootCauseMethod: 'FIVE_WHYS',
  rootCause: 'No reminder',
  similarOccurrences: 'None found',
  disposition: null,
  dispositionAuthorisedById: null,
  relatedRiskItemCount: 0,
  riskReview: 'None needed',
  systemChange: 'None needed',
  openActionCount: 1,
  effectivenessDueOn: asOf,
  incidentOutcome: null,
  hadVerifyNotEffective: false,
  noActionReason: 'One-off',
  doneActionCount: 1,
  doneSinceResetCount: null,
  effectivenessNote: 'No repeat in 90 days',
  // documents
  documentType: 'PROCEDURE',
  documentStatus: 'ACTIVE',
  openRevisionCount: 0,
  changeNote: 'New layout',
  liveFileCount: 1,
  cleanFileCount: 1,
  issuer: 'National standards body',
  externalRef: 'NSB-12',
  currentRevisionId: 'rev',
  note: 'Still fits',
  nextReviewDueOn: '2027-03-31',
  // internal audit
  summary: 'Two findings',
  reportedOn: asOf,
  reportedToCount: 1,
  unansweredClauseCount: 0,
  notAuditedWithoutReasonCount: 0,
  openNcCount: 0,
  // external audit
  startOn: '2026-03-30',
  endOn: asOf,
  reportFileCount: 1,
  responseDueOn: null,
  recommendation: 'RECOMMENDED',
  ncFindingCount: 0,
  // management review
  plannedOn: '2026-04-15',
  chairId: 'chair',
  heldOn: asOf,
  attendeeCount: 2,
  inputsWithoutNotesCount: 0,
  outputsWithoutDecisionCount: 0,
  // clause N/A
  exclusionAllowed: true,
  // action
  subjectOpen: true,
  doneOn: asOf,
};

const run = (
  machine: IsoMachine,
  from: string,
  action: string,
  over: Record<string, unknown> = {},
) => isoTransition(machine, from, action, { ...GOOD, ...over });

const guard = (name: string, fields: string[]) => ({
  ok: false,
  error: 'GUARD',
  guard: name,
  fields,
});
const refused = { ok: false, error: 'INVALID_TRANSITION' };

describe('isoTransition: every arrow and every refused arrow', () => {
  for (const [machine, spec] of Object.entries(MACHINES) as [
    IsoMachine,
    (typeof MACHINES)[IsoMachine],
  ][]) {
    it(`${machine}: the arrows of model §4 lead where the model says`, () => {
      for (const [from, action, to, over] of spec.arrows) {
        expect(run(machine, from, action, over), `${from} ${action}`).toEqual({ ok: true, to });
      }
    });
    it(`${machine}: every other state and action is INVALID_TRANSITION`, () => {
      for (const from of spec.states) {
        for (const action of spec.actions) {
          if (spec.arrows.some(([f, a]) => f === from && a === action)) continue;
          expect(run(machine, from, action), `${from} ${action}`).toEqual(refused);
        }
      }
    });
    it(`${machine}: the table holds exactly these arrows`, () => {
      const drawn = new Set(spec.arrows.map(([from, action]) => `${from} ${action}`));
      const held = ISO_TRANSITIONS[machine].flatMap((a) => a.from.map((f) => `${f} ${a.action}`));
      expect(new Set(held)).toEqual(drawn);
    });
  }
  it('an unknown action or state is refused', () => {
    expect(run('NONCONFORMITY', 'OPEN', 'APPROVE')).toEqual(refused);
    expect(run('NONCONFORMITY', 'DRAFT', 'RAISE')).toEqual(refused);
  });
});

describe('isoTransition: nonconformity guards (model §4.1)', () => {
  const raise = (over: Record<string, unknown>) =>
    run('NONCONFORMITY', ISO_NEW_STATE, 'RAISE', over);
  it('RAISE needs its fields, names only the missing ones, and treats blanks as missing', () => {
    expect(raise({ description: [], ownerId: undefined })).toEqual(
      guard('REQUIRED', ['description', 'ownerId']),
    );
    expect(raise({ description: '  ', ownerId: undefined })).toEqual(
      guard('REQUIRED', ['description', 'ownerId']),
    );
  });
  it('RAISE refuses a dueOn before reportedOn (decision 51 q); the same day is allowed', () => {
    expect(raise({ dueOn: '2026-03-30' })).toEqual(guard('DUE_NOT_BEFORE_REPORTED', ['dueOn']));
    expect(raise({ dueOn: asOf })).toEqual({ ok: true, to: 'OPEN' });
    expect(raise({ dueOn: null })).toEqual(guard('REQUIRED', ['dueOn']));
  });
  it('RAISE by hand refuses audit sources; a finding may raise them', () => {
    expect(raise({ source: 'INTERNAL_AUDIT' })).toEqual(
      guard('AUDIT_SOURCE_FROM_FINDING', ['source']),
    );
    expect(raise({ source: 'EXTERNAL_AUDIT' })).toEqual(
      guard('AUDIT_SOURCE_FROM_FINDING', ['source']),
    );
    expect(raise({ source: 'EXTERNAL_AUDIT', fromFinding: true, severity: 'MAJOR' })).toEqual({
      ok: true,
      to: 'OPEN',
    });
  });
  it('RAISE refuses the same person as owner and approver', () => {
    expect(raise({ approverId: 'owner' })).toEqual(guard('OWNER_IS_NOT_APPROVER', ['approverId']));
  });
  it('RAISE needs incident fields exactly for INCIDENT and NEAR_MISS', () => {
    expect(raise({ source: 'INCIDENT' })).toEqual(
      guard('INCIDENT_FOR_INCIDENT_SOURCES', ['incident']),
    );
    expect(raise({ source: 'NEAR_MISS', incident: { type: 'NEAR_MISS' } })).toEqual({
      ok: true,
      to: 'OPEN',
    });
    expect(raise({ incident: { type: 'FIRE' } })).toEqual(
      guard('INCIDENT_FOR_INCIDENT_SOURCES', ['incident']),
    );
  });

  const rootCause = (over: Record<string, unknown>) =>
    run('NONCONFORMITY', 'OPEN', 'ADD_ROOT_CAUSE', over);
  it('ADD_ROOT_CAUSE needs the investigation fields', () => {
    expect(rootCause({ containment: null, similarOccurrences: '' })).toEqual(
      guard('REQUIRED', ['containment', 'similarOccurrences']),
    );
  });
  it('ADD_ROOT_CAUSE needs rootCauseMethod (plan v2.2)', () => {
    expect(rootCause({ rootCauseMethod: null })).toEqual(guard('REQUIRED', ['rootCauseMethod']));
  });
  it('ADD_ROOT_CAUSE needs whoever authorised a disposition', () => {
    expect(rootCause({ disposition: 'CONCESSION' })).toEqual(
      guard('DISPOSITION_AUTHORISED', ['dispositionAuthorisedById']),
    );
    expect(rootCause({ disposition: 'CONCESSION', dispositionAuthorisedById: 'p' })).toEqual({
      ok: true,
      to: 'ROOT_CAUSE_FOUND',
    });
  });
  it('ADD_ROOT_CAUSE on an incident needs related risk items or a risk review', () => {
    const incident = { source: 'INCIDENT', incident: { type: 'INJURY' } };
    expect(rootCause({ ...incident, riskReview: null })).toEqual(
      guard('INCIDENT_RISK_REVIEW', ['relatedRiskItemIds', 'riskReview']),
    );
    expect(rootCause({ ...incident, riskReview: null, relatedRiskItemCount: 2 })).toEqual({
      ok: true,
      to: 'ROOT_CAUSE_FOUND',
    });
    expect(rootCause({ ...incident })).toEqual({ ok: true, to: 'ROOT_CAUSE_FOUND' });
  });

  const plan = (over: Record<string, unknown>) =>
    run('NONCONFORMITY', 'ROOT_CAUSE_FOUND', 'PLAN_ACTIONS', over);
  it('PLAN_ACTIONS needs an OPEN action and an effectiveness date from today on', () => {
    expect(plan({ openActionCount: 0 })).toEqual(guard('OPEN_ACTION', ['actions']));
    expect(plan({ openActionCount: undefined })).toEqual(guard('OPEN_ACTION', ['actions']));
    expect(plan({ effectivenessDueOn: null })).toEqual(guard('REQUIRED', ['effectivenessDueOn']));
    expect(plan({ effectivenessDueOn: '2026-03-30' })).toEqual(
      guard('EFFECTIVENESS_DUE_NOT_PAST', ['effectivenessDueOn']),
    );
  });

  const noAction = (over: Record<string, unknown>) =>
    run('NONCONFORMITY', 'ROOT_CAUSE_FOUND', 'SUBMIT_NO_ACTION', over);
  it('SUBMIT_NO_ACTION is refused for MAJOR, external audit, lost time or fatality, and after not effective', () => {
    expect(noAction({ severity: 'MAJOR' })).toEqual(guard('MAJOR_NEEDS_ACTIONS', ['severity']));
    expect(noAction({ source: 'EXTERNAL_AUDIT' })).toEqual(
      guard('EXTERNAL_AUDIT_NEEDS_ACTIONS', ['source']),
    );
    for (const incidentOutcome of ['LOST_TIME', 'FATALITY']) {
      expect(noAction({ incidentOutcome })).toEqual(
        guard('INCIDENT_OUTCOME_NEEDS_ACTIONS', ['incident.outcome']),
      );
    }
    expect(noAction({ incidentOutcome: 'FIRST_AID' })).toEqual({
      ok: true,
      to: 'AWAITING_VERIFICATION',
    });
    expect(noAction({ hadVerifyNotEffective: true })).toEqual(
      guard('NOT_EFFECTIVE_NEEDS_ACTIONS', ['effective']),
    );
    expect(noAction({ noActionReason: null, systemChange: null })).toEqual(
      guard('REQUIRED', ['noActionReason', 'systemChange']),
    );
  });

  const submit = (over: Record<string, unknown>) =>
    run('NONCONFORMITY', 'ACTIONS_PLANNED', 'SUBMIT', { openActionCount: 0, ...over });
  it('SUBMIT needs a DONE action, none OPEN, and a DONE one since a reset', () => {
    expect(submit({ doneActionCount: 0 })).toEqual(guard('ACTION_DONE', ['actions']));
    // Every action cancelled: none OPEN, none DONE.
    expect(submit({ doneActionCount: 0, openActionCount: 0 })).toEqual(
      guard('ACTION_DONE', ['actions']),
    );
    expect(submit({ openActionCount: 1 })).toEqual(guard('ACTIONS_SETTLED', ['actions']));
    expect(submit({ doneSinceResetCount: 0 })).toEqual(
      guard('ACTION_DONE_SINCE_RESET', ['actions']),
    );
    expect(submit({ doneSinceResetCount: 1 })).toEqual({ ok: true, to: 'AWAITING_VERIFICATION' });
    expect(submit({ riskReview: '' })).toEqual(guard('REQUIRED', ['riskReview']));
  });

  const verify = (over: Record<string, unknown>) =>
    run('NONCONFORMITY', 'AWAITING_VERIFICATION', 'VERIFY_EFFECTIVE', over);
  it('VERIFY_EFFECTIVE needs a note and waits for effectivenessDueOn; VERIFY_NOT_EFFECTIVE may come earlier', () => {
    expect(verify({ effectivenessNote: null })).toEqual(guard('REQUIRED', ['effectivenessNote']));
    expect(verify({ effectivenessDueOn: '2026-04-01' })).toEqual(
      guard('EFFECTIVENESS_DUE', ['effectivenessDueOn']),
    );
    expect(verify({ effectivenessDueOn: null })).toEqual({ ok: true, to: 'CLOSED' });
    expect(
      run('NONCONFORMITY', 'AWAITING_VERIFICATION', 'VERIFY_NOT_EFFECTIVE', {
        backTo: 'OPEN',
        effectivenessDueOn: '2026-05-01',
      }),
    ).toEqual({ ok: true, to: 'OPEN' });
  });
  for (const [from, action] of [
    ['AWAITING_VERIFICATION', 'VERIFY_NOT_EFFECTIVE'],
    ['CLOSED', 'REOPEN'],
  ] as const) {
    it(`${action} needs a reason, a backTo, and a new effectiveness date after today for ACTIONS_PLANNED`, () => {
      expect(run('NONCONFORMITY', from, action, { backTo: 'OPEN', reason: ' ' })).toEqual(
        guard('REQUIRED', ['reason']),
      );
      expect(run('NONCONFORMITY', from, action, { backTo: 'CLOSED' })).toEqual(
        guard('BACK_TO', ['backTo']),
      );
      expect(run('NONCONFORMITY', from, action, { backTo: 'ACTIONS_PLANNED' })).toEqual(
        guard('EFFECTIVENESS_DUE_AFTER_TODAY', ['effectivenessDueOn']),
      );
      expect(
        run('NONCONFORMITY', from, action, { backTo: 'ACTIONS_PLANNED', effectivenessDueOn: null }),
      ).toEqual(guard('EFFECTIVENESS_DUE_AFTER_TODAY', ['effectivenessDueOn']));
    });
  }
  it('CANCEL needs a reason', () => {
    expect(run('NONCONFORMITY', 'OPEN', 'CANCEL', { reason: null })).toEqual(
      guard('REQUIRED', ['reason']),
    );
  });
});

describe('isoTransition: document guards (model §4.2)', () => {
  it('an OBSOLETE document refuses every revision step', () => {
    for (const [from, action] of [
      [ISO_NEW_STATE, 'DRAFT_REVISION'],
      ['DRAFT', 'SUBMIT'],
      ['IN_REVIEW', 'APPROVE'],
      ['IN_REVIEW', 'SEND_BACK'],
      ['DRAFT', 'RECORD_EDITION'],
    ]) {
      expect(
        run('DOCUMENT_REVISION', from!, action!, {
          documentStatus: 'OBSOLETE',
          documentType: 'EXTERNAL',
        }),
      ).toEqual(refused);
    }
  });
  it('a second open revision is refused', () => {
    expect(
      run('DOCUMENT_REVISION', ISO_NEW_STATE, 'DRAFT_REVISION', { openRevisionCount: 1 }),
    ).toEqual(refused);
  });
  it('SUBMIT, APPROVE and SEND_BACK refuse an EXTERNAL document; RECORD_EDITION refuses any other', () => {
    for (const [from, action] of [
      ['DRAFT', 'SUBMIT'],
      ['IN_REVIEW', 'APPROVE'],
      ['IN_REVIEW', 'SEND_BACK'],
    ]) {
      expect(run('DOCUMENT_REVISION', from!, action!, { documentType: 'EXTERNAL' })).toEqual(
        refused,
      );
      expect(run('DOCUMENT_REVISION', from!, action!, { documentType: null })).toEqual(refused);
    }
    expect(run('DOCUMENT_REVISION', 'DRAFT', 'RECORD_EDITION')).toEqual(refused);
  });
  it('SUBMIT and RECORD_EDITION need exactly one live file, and it CLEAN', () => {
    for (const files of [
      { liveFileCount: 2, cleanFileCount: 1 },
      { liveFileCount: 1, cleanFileCount: 0 },
      { liveFileCount: 0, cleanFileCount: 0 },
    ]) {
      expect(run('DOCUMENT_REVISION', 'DRAFT', 'SUBMIT', files)).toEqual(
        guard('ONE_CLEAN_FILE', ['file']),
      );
      expect(
        run('DOCUMENT_REVISION', 'DRAFT', 'RECORD_EDITION', { ...files, documentType: 'EXTERNAL' }),
      ).toEqual(guard('ONE_CLEAN_FILE', ['file']));
    }
    expect(run('DOCUMENT_REVISION', 'DRAFT', 'SUBMIT', { changeNote: '' })).toEqual(
      guard('REQUIRED', ['changeNote']),
    );
    expect(
      run('DOCUMENT_REVISION', 'DRAFT', 'RECORD_EDITION', {
        documentType: 'EXTERNAL',
        externalRef: null,
      }),
    ).toEqual(guard('REQUIRED', ['externalRef']));
    expect(run('DOCUMENT_REVISION', 'IN_REVIEW', 'SEND_BACK', { reason: null })).toEqual(
      guard('REQUIRED', ['reason']),
    );
  });
  it('REVIEW needs a current revision, a note and a next review after today', () => {
    expect(run('DOCUMENT', 'ACTIVE', 'REVIEW', { currentRevisionId: null })).toEqual(
      guard('REQUIRED', ['currentRevisionId']),
    );
    expect(run('DOCUMENT', 'ACTIVE', 'REVIEW', { nextReviewDueOn: asOf })).toEqual(
      guard('NEXT_REVIEW_AFTER_TODAY', ['nextReviewDueOn']),
    );
    expect(run('DOCUMENT', 'ACTIVE', 'REVIEW', { nextReviewDueOn: 'soon' })).toEqual(
      guard('NEXT_REVIEW_AFTER_TODAY', ['nextReviewDueOn']),
    );
    expect(run('DOCUMENT', 'ACTIVE', 'MAKE_OBSOLETE', { reason: null })).toEqual(
      guard('REQUIRED', ['reason']),
    );
  });
});

describe('isoTransition: audit guards (model §4.3, §4.4)', () => {
  it('REPORT needs a summary, someone reported to, a complete checklist and a reportedOn by today', () => {
    const report = (over: Record<string, unknown>) =>
      run('INTERNAL_AUDIT', 'IN_PROGRESS', 'REPORT', over);
    expect(report({ summary: null })).toEqual(guard('REQUIRED', ['summary']));
    expect(report({ reportedToCount: 0 })).toEqual(guard('REPORTED_TO', ['reportedToIds']));
    expect(report({ unansweredClauseCount: 3 })).toEqual(
      guard('CHECKLIST_COMPLETE', ['checklist']),
    );
    expect(report({ notAuditedWithoutReasonCount: 1 })).toEqual(
      guard('NOT_AUDITED_REASON', ['notAuditedReason']),
    );
    expect(report({ reportedOn: '2026-04-01' })).toEqual(
      guard('REPORTED_ON_NOT_FUTURE', ['reportedOn']),
    );
    expect(report({ asOf: undefined })).toEqual(guard('REPORTED_ON_NOT_FUTURE', ['reportedOn']));
  });
  it('CLOSE waits for every NC its findings raised to leave OPEN', () => {
    expect(run('INTERNAL_AUDIT', 'REPORTED', 'CLOSE', { openNcCount: 1 })).toEqual(
      guard('NCS_PAST_OPEN', ['nonconformities']),
    );
    expect(run('INTERNAL_AUDIT', 'PLANNED', 'CANCEL', { reason: '' })).toEqual(
      guard('REQUIRED', ['reason']),
    );
  });
  it('external RECORD_HELD needs dates in order and ended, a report file, and a response date from the end on', () => {
    const held = (over: Record<string, unknown>) =>
      run('EXTERNAL_AUDIT', 'PLANNED', 'RECORD_HELD', over);
    expect(held({ startOn: null })).toEqual(guard('REQUIRED', ['startOn']));
    expect(held({ startOn: '2026-04-01' })).toEqual(guard('DATES_IN_ORDER', ['endOn']));
    expect(held({ endOn: '2026-04-01' })).toEqual(guard('ENDED', ['endOn']));
    expect(held({ reportFileCount: 0 })).toEqual(guard('REPORT_FILE', ['file']));
    expect(held({ responseDueOn: '2026-03-30' })).toEqual(
      guard('RESPONSE_DUE_AFTER_END', ['responseDueOn']),
    );
    expect(held({ responseDueOn: asOf })).toEqual({ ok: true, to: 'HELD' });
  });
  it('external RECORD_RESPONSE and CLOSE follow the NCs and the recommendation', () => {
    expect(run('EXTERNAL_AUDIT', 'HELD', 'RECORD_RESPONSE', { openNcCount: 2 })).toEqual(
      guard('NCS_PAST_OPEN', ['nonconformities']),
    );
    expect(run('EXTERNAL_AUDIT', 'HELD', 'CLOSE', { ncFindingCount: 1 })).toEqual(
      guard('NO_NC_FINDING', ['findings']),
    );
    expect(run('EXTERNAL_AUDIT', 'HELD', 'CLOSE', { recommendation: null })).toEqual(
      guard('REQUIRED', ['recommendation']),
    );
    expect(
      run('EXTERNAL_AUDIT', 'RESPONDED', 'CLOSE', { recommendation: null, ncFindingCount: 1 }),
    ).toEqual(guard('REQUIRED', ['recommendation']));
    expect(run('EXTERNAL_AUDIT', 'PLANNED', 'CANCEL', { reason: null })).toEqual(
      guard('REQUIRED', ['reason']),
    );
  });
});

describe('isoTransition: management review, clause N/A and action guards (model §4.5, §4.6, §3.12)', () => {
  it('a review is planned with a date and chair, held by today with attendees and notes, closed when settled', () => {
    expect(run('MANAGEMENT_REVIEW', ISO_NEW_STATE, 'PLAN', { chairId: null })).toEqual(
      guard('REQUIRED', ['chairId']),
    );
    expect(run('MANAGEMENT_REVIEW', 'PLANNED', 'RECORD_HELD', { heldOn: '2026-04-01' })).toEqual(
      guard('HELD_ON_NOT_FUTURE', ['heldOn']),
    );
    expect(run('MANAGEMENT_REVIEW', 'PLANNED', 'RECORD_HELD', { attendeeCount: 0 })).toEqual(
      guard('ATTENDEES', ['attendeeIds']),
    );
    expect(
      run('MANAGEMENT_REVIEW', 'PLANNED', 'RECORD_HELD', { inputsWithoutNotesCount: 1 }),
    ).toEqual(guard('INPUT_NOTES', ['inputs']));
    expect(run('MANAGEMENT_REVIEW', 'HELD', 'CLOSE', { outputsWithoutDecisionCount: 1 })).toEqual(
      guard('OUTPUT_DECISIONS', ['outputs']),
    );
    expect(run('MANAGEMENT_REVIEW', 'HELD', 'CLOSE', { openActionCount: 1 })).toEqual(
      guard('REVIEW_ACTIONS_SETTLED', ['actions']),
    );
    expect(run('MANAGEMENT_REVIEW', 'PLANNED', 'CANCEL', { reason: null })).toEqual(
      guard('REQUIRED', ['reason']),
    );
  });
  it('REQUEST_NA needs a clause that allows exclusion and a reason; REJECT_NA and WITHDRAW_NA need a reason', () => {
    expect(run('CLAUSE_NA', 'NONE', 'REQUEST_NA', { exclusionAllowed: false })).toEqual(
      guard('EXCLUSION_ALLOWED', ['status']),
    );
    expect(run('CLAUSE_NA', 'NONE', 'REQUEST_NA', { reason: null })).toEqual(
      guard('REQUIRED', ['reason']),
    );
    expect(run('CLAUSE_NA', 'REQUESTED', 'REJECT_NA', { reason: null })).toEqual(
      guard('REQUIRED', ['reason']),
    );
    expect(run('CLAUSE_NA', 'APPROVED', 'WITHDRAW_NA', { reason: null })).toEqual(
      guard('REQUIRED', ['reason']),
    );
  });
  it('an action is completed by today on an open subject; reopened only while its subject is open', () => {
    expect(run('ISO_ACTION', 'OPEN', 'COMPLETE', { doneOn: '2026-04-01' })).toEqual(
      guard('DONE_ON_NOT_FUTURE', ['doneOn']),
    );
    expect(run('ISO_ACTION', 'OPEN', 'COMPLETE', { doneOn: null })).toEqual(
      guard('REQUIRED', ['doneOn']),
    );
    expect(run('ISO_ACTION', 'OPEN', 'COMPLETE', { subjectOpen: false })).toEqual(refused);
    expect(run('ISO_ACTION', 'DONE', 'REOPEN', { subjectOpen: false })).toEqual(refused);
    expect(run('ISO_ACTION', 'CANCELLED', 'REOPEN', { reason: null })).toEqual(
      guard('REQUIRED', ['reason']),
    );
    // A closed subject's actions can still be cancelled.
    expect(run('ISO_ACTION', 'OPEN', 'CANCEL', { subjectOpen: false })).toEqual({
      ok: true,
      to: 'CANCELLED',
    });
    expect(run('ISO_ACTION', 'OPEN', 'CANCEL', { reason: null })).toEqual(
      guard('REQUIRED', ['reason']),
    );
  });
});

describe('isoMayCheck: maker-checker (model §4 preamble)', () => {
  const step = (action: string, actorId: string | null) => ({ action, actorId });
  it('nobody verifies an NC where they took a maker step since its last RAISE, REOPEN or VERIFY_NOT_EFFECTIVE', () => {
    const history = [
      step('RAISE', 'reporter'),
      step('ADD_ROOT_CAUSE', 'ann'),
      step('SUBMIT', 'bob'),
    ];
    expect(isoMayCheck('NONCONFORMITY', 'VERIFY_EFFECTIVE', 'ann', history)).toBe(false);
    expect(isoMayCheck('NONCONFORMITY', 'VERIFY_NOT_EFFECTIVE', 'bob', history)).toBe(false);
    expect(isoMayCheck('NONCONFORMITY', 'VERIFY_EFFECTIVE', 'reporter', history)).toBe(true);
    const reset = [...history, step('VERIFY_NOT_EFFECTIVE', 'carl'), step('PLAN_ACTIONS', 'bob')];
    expect(isoMayCheck('NONCONFORMITY', 'VERIFY_EFFECTIVE', 'ann', reset)).toBe(true);
    expect(isoMayCheck('NONCONFORMITY', 'VERIFY_EFFECTIVE', 'bob', reset)).toBe(false);
    expect(isoMayCheck('NONCONFORMITY', 'VERIFY_EFFECTIVE', 'ann', [])).toBe(true);
  });
  it('a revision is approved by nobody who prepared or submitted it', () => {
    const history = [
      step('DRAFT_REVISION', 'ann'),
      step('SUBMIT', 'bob'),
      step('SEND_BACK', 'carl'),
      step('SUBMIT', 'dee'),
    ];
    for (const actor of ['ann', 'bob', 'dee']) {
      expect(isoMayCheck('DOCUMENT_REVISION', 'APPROVE', actor, history)).toBe(false);
    }
    expect(isoMayCheck('DOCUMENT_REVISION', 'APPROVE', 'carl', history)).toBe(true);
  });
  it('an N/A is approved by anyone but its latest requester', () => {
    const history = [
      step('REQUEST_NA', 'ann'),
      step('REJECT_NA', 'bob'),
      step('REQUEST_NA', 'bob'),
    ];
    expect(isoMayCheck('CLAUSE_NA', 'APPROVE_NA', 'bob', history)).toBe(false);
    expect(isoMayCheck('CLAUSE_NA', 'APPROVE_NA', 'ann', history)).toBe(true);
  });
  it('maker steps and machines without the rule are never refused', () => {
    expect(isoMayCheck('NONCONFORMITY', 'SUBMIT', 'ann', [step('ADD_ROOT_CAUSE', 'ann')])).toBe(
      true,
    );
    expect(isoMayCheck('INTERNAL_AUDIT', 'CLOSE', 'ann', [step('START', 'ann')])).toBe(true);
  });
});

// ---------- timing ----------

describe('isoTiming, actionStatus and reviewDue (model §5.2)', () => {
  const status = (dueOn: string | null, on: string, closed = false, dueSoonDays = 7) =>
    IsoDueStatus.parse(isoTiming(dueOn === null ? null : d(dueOn), closed, d(on), { dueSoonDays }));
  it('OVERDUE the day after the due date, with days counted over 29 February', () => {
    expect(status('2028-02-28', '2028-03-01')).toEqual({ timing: 'OVERDUE', overdueDays: 2 });
    expect(status('2027-02-28', '2027-03-01')).toEqual({ timing: 'OVERDUE', overdueDays: 1 });
  });
  it('DUE_SOON within dueSoonDays, on the due date included, at the firm setting', () => {
    expect(status('2026-04-07', '2026-03-31')).toEqual({ timing: 'DUE_SOON', overdueDays: null });
    expect(status('2026-03-31', '2026-03-31')).toEqual({ timing: 'DUE_SOON', overdueDays: null });
    expect(status('2026-04-08', '2026-03-31')).toEqual({ timing: 'ON_TIME', overdueDays: null });
    expect(status('2026-04-08', '2026-03-31', false, 14)).toEqual({
      timing: 'DUE_SOON',
      overdueDays: null,
    });
    expect(status('2026-04-01', '2026-03-31', false, 0)).toEqual({
      timing: 'ON_TIME',
      overdueDays: null,
    });
  });
  it('CLOSED whatever the date; no date is ON_TIME', () => {
    expect(status('2020-01-01', '2026-03-31', true)).toEqual({
      timing: 'CLOSED',
      overdueDays: null,
    });
    expect(status(null, '2026-03-31')).toEqual({ timing: 'ON_TIME', overdueDays: null });
  });
  it('actionStatus: OPEN by due date, DONE and CANCELLED closed', () => {
    expect(actionStatus({ state: 'OPEN', dueOn: d('2026-03-30') }, d(asOf), s)).toEqual({
      timing: 'OVERDUE',
      overdueDays: 1,
    });
    for (const state of ['DONE', 'CANCELLED'] as const) {
      expect(actionStatus({ state, dueOn: d('2026-03-30') }, d(asOf), s).timing).toBe('CLOSED');
    }
  });
  it('reviewDue: by reviewDueOn across the FY boundary, none set is ON_TIME', () => {
    expect(reviewDue(d('2026-03-31'), d('2026-04-01'), s)).toEqual({
      timing: 'OVERDUE',
      overdueDays: 1,
    });
    expect(reviewDue(null, d('2026-04-01'), s)).toEqual({ timing: 'ON_TIME', overdueDays: null });
  });
});

describe('nonconformityStatus (model §5.2)', () => {
  const nc = (over: Partial<Parameters<typeof nonconformityStatus>[0]> = {}) => ({
    state: 'ACTIONS_PLANNED' as const,
    dueOn: d('2026-04-30'),
    effectivenessDueOn: null,
    ...over,
  });
  const open = (dueOn: string) => ({ state: 'OPEN' as const, dueOn: d(dueOn) });
  const run = (...args: Parameters<typeof nonconformityStatus>) =>
    NonconformityStatus.parse(nonconformityStatus(...args));
  it('the earliest of dueOn and OPEN action due dates decides the timing', () => {
    expect(
      run(nc(), [open('2026-03-29'), { state: 'DONE', dueOn: d('2026-01-01') }], d(asOf), s),
    ).toEqual({
      timing: 'OVERDUE',
      overdueDays: 2,
      effectivenessOverdueDays: null,
    });
    expect(run(nc(), [open('2026-04-05')], d(asOf), s).timing).toBe('DUE_SOON');
    expect(run(nc(), [], d(asOf), s).timing).toBe('ON_TIME');
    expect(run(nc({ dueOn: d('2026-03-01') }), [], d(asOf), s)).toEqual({
      timing: 'OVERDUE',
      overdueDays: 30,
      effectivenessOverdueDays: null,
    });
  });
  it('AWAITING_VERIFICATION no longer runs on dueOn; the effectiveness check is overdue from the day after', () => {
    const waiting = nc({
      state: 'AWAITING_VERIFICATION',
      dueOn: d('2026-01-01'),
      effectivenessDueOn: d('2026-03-29'),
    });
    expect(run(waiting, [], d(asOf), s)).toEqual({
      timing: 'ON_TIME',
      overdueDays: null,
      effectivenessOverdueDays: 2,
    });
    expect(
      run({ ...waiting, effectivenessDueOn: d(asOf) }, [], d(asOf), s).effectivenessOverdueDays,
    ).toBeNull();
  });
  it('CLOSED and CANCELLED are CLOSED', () => {
    for (const state of ['CLOSED', 'CANCELLED'] as const) {
      expect(run(nc({ state, dueOn: d('2020-01-01') }), [open('2020-01-01')], d(asOf), s)).toEqual({
        timing: 'CLOSED',
        overdueDays: null,
        effectivenessOverdueDays: null,
      });
    }
  });
});

describe('certificationCycle (model §5.2)', () => {
  const cert = {
    id: u('cert'),
    standardId: 'std-14001',
    issuedOn: d('2024-02-29'),
    expiresOn: d('2027-02-28'),
  };
  const audit = (id: string, type: string, endOn: string, over: Record<string, unknown> = {}) => ({
    id: u(id),
    type: type as 'SURVEILLANCE_1',
    state: 'HELD' as const,
    standardIds: ['std-14001'],
    endOn: d(endOn),
    ...over,
  });
  const cycle = (audits: ReturnType<typeof audit>[], on: string) =>
    CertificationCycle.parse(certificationCycle(cert, audits, d(on)));

  it('is empty until the certificate is issued', () => {
    for (const dates of [
      { issuedOn: null, expiresOn: null },
      { issuedOn: d('2024-02-29'), expiresOn: null },
    ]) {
      expect(certificationCycle({ ...cert, ...dates }, [], d(asOf))).toEqual({
        certificationId: u('cert'),
        items: [],
      });
    }
  });
  it('dates surveillance 12 and 24 months after a 29 February issue, recertification on expiresOn', () => {
    expect(cycle([], '2025-02-28').items.map((i) => [i.kind, i.dueOn, i.overdueDays])).toEqual([
      ['SURVEILLANCE_1', '2025-02-28', null],
      ['SURVEILLANCE_2', '2026-02-28', null],
      ['RECERTIFICATION', '2027-02-28', null],
    ]);
    expect(cycle([], '2026-03-31').items.map((i) => i.overdueDays)).toEqual([396, 31, null]);
  });
  it('the earliest held audit of each type meets its date, late when it ended after it', () => {
    const items = cycle(
      [
        audit('s1-late', 'SURVEILLANCE_1', '2025-03-10'),
        audit('s1-later', 'SURVEILLANCE_1', '2025-04-10', { state: 'CLOSED' }),
        audit('s2', 'SURVEILLANCE_2', '2026-02-01', { state: 'RESPONDED' }),
      ],
      '2026-03-31',
    ).items;
    expect(items[0]).toMatchObject({
      metByAuditId: u('s1-late'),
      metOn: '2025-03-10',
      daysLate: 10,
      overdueDays: null,
    });
    expect(items[1]).toMatchObject({ metByAuditId: u('s2'), daysLate: null, overdueDays: null });
    expect(items[2]).toMatchObject({ metByAuditId: null, overdueDays: null });
  });
  it('ignores audits not held, of another standard, before the issue, or a surveillance 2 before surveillance 1', () => {
    const items = cycle(
      [
        audit('planned', 'SURVEILLANCE_1', '2025-01-10', { state: 'PLANNED' }),
        audit('cancelled', 'SURVEILLANCE_1', '2025-01-10', { state: 'CANCELLED' }),
        audit('other', 'SURVEILLANCE_1', '2025-01-10', { standardIds: ['std-9001'] }),
        audit('old', 'RECERTIFICATION', '2024-02-29'),
        audit('s1', 'SURVEILLANCE_1', '2025-06-01'),
        audit('early-s2', 'SURVEILLANCE_2', '2025-05-01'),
      ],
      '2026-03-31',
    ).items;
    expect(items.map((i) => i.metByAuditId)).toEqual([u('s1'), null, null]);
    expect(items[1]!.overdueDays).toBe(31);
  });
  it('orders audits ending the same day by id', () => {
    expect(u('a') < u('b')).toBe(true);
    const items = cycle(
      [
        audit('b', 'SURVEILLANCE_1', '2025-01-10'),
        audit('a', 'SURVEILLANCE_1', '2025-01-10'),
        audit('c', 'SURVEILLANCE_1', '2025-01-10'),
      ],
      '2025-03-01',
    ).items;
    expect(items[0]!.metByAuditId).toBe(u('a'));
  });
});

describe('managementReviewDue (model §5.2)', () => {
  const system = {
    createdOn: d('2025-03-31'),
    reviewIntervalMonths: 12,
    standards: ['ISO_9001', 'ISO_45001'] as ('ISO_9001' | 'ISO_45001')[],
  };
  const review = (
    state: 'PLANNED' | 'HELD' | 'CLOSED' | 'CANCELLED',
    heldOn: string | null,
    standards: string[],
  ) => ({
    state,
    heldOn: heldOn === null ? null : d(heldOn),
    standards: standards as 'ISO_9001'[],
  });
  const due = (...args: Parameters<typeof managementReviewDue>) =>
    ManagementReviewDue.parse(managementReviewDue(...args));

  it('a system with no held review is due the interval after its creation day', () => {
    expect(due(system, [review('PLANNED', null, ['ISO_9001'])], d('2026-03-31'), s).items).toEqual([
      {
        standard: 'ISO_9001',
        lastHeldOn: null,
        nextDueOn: '2026-03-31',
        timing: 'DUE_SOON',
        overdueDays: null,
      },
      {
        standard: 'ISO_45001',
        lastHeldOn: null,
        nextDueOn: '2026-03-31',
        timing: 'DUE_SOON',
        overdueDays: null,
      },
    ]);
  });
  it('per standard, the last HELD or CLOSED review covering it plus the interval, clamped at the month end', () => {
    const items = due(
      { ...system, reviewIntervalMonths: 6 },
      [
        review('CLOSED', '2025-08-31', ['ISO_9001', 'ISO_45001']),
        review('HELD', '2025-09-30', ['ISO_9001']),
        review('CANCELLED', null, ['ISO_45001']),
      ],
      d('2026-03-02'),
      s,
    ).items;
    expect(items).toEqual([
      {
        standard: 'ISO_9001',
        lastHeldOn: '2025-09-30',
        nextDueOn: '2026-03-30',
        timing: 'ON_TIME',
        overdueDays: null,
      },
      {
        standard: 'ISO_45001',
        lastHeldOn: '2025-08-31',
        nextDueOn: '2026-02-28',
        timing: 'OVERDUE',
        overdueDays: 2,
      },
    ]);
  });
});
