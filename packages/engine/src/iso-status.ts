import type {
  Certification,
  CertificationCycle,
  CertificationCycleItem,
  ExternalAudit,
  IsoAction,
  IsoDueStatus,
  IsoMachine,
  IsoStandardCode,
  IsoSystemInput,
  IsoTransitionResult,
  LocalDate,
  ManagementReview,
  ManagementReviewDue,
  Nonconformity,
  NonconformityStatus,
} from '@canopy/contracts';
import { addMonthsToDate, compareDates, daysBetween } from './dates.js';

/**
 * ISO state machines and timing (docs/iso/model.md §4, §5.2; ADR M4-0001). M16 enforces the tables: an action the
 * state does not allow is 409 INVALID_TRANSITION, a failed guard 400 VALIDATION naming its fields (422
 * REASON_REQUIRED when the field is `reason`), and a checker step by a maker 403 FORBIDDEN (`isoMayCheck`).
 */

type Facts = Readonly<Record<string, unknown>>;

/** The state a record is in before its first step (RAISE, DRAFT_REVISION, PLAN). */
export const ISO_NEW_STATE = 'NEW';

/**
 * One guard of an arrow: `check` returns the fields that fail it (none when it holds). A guard with `refuse` answers
 * 409 INVALID_TRANSITION instead of 400, for a record whose kind or lock rules the action out.
 */
export interface IsoGuard {
  guard: string;
  check: (facts: Facts) => string[];
  refuse?: 'INVALID_TRANSITION';
}

export interface IsoArrow {
  from: readonly string[];
  action: string;
  /** The next state, or how the facts choose it (`backTo`). */
  to: string | ((facts: Facts) => string);
  guards: readonly IsoGuard[];
}

// ---------- fact readers: a missing fact never satisfies a guard ----------

/** A value that counts as given: not null or undefined, not a blank string, not an empty list. */
function given(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

const count = (facts: Facts, name: string): number => {
  const value = facts[name];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : NaN;
};

const dateFact = (facts: Facts, name: string): LocalDate | null => {
  const value = facts[name];
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? (value as LocalDate)
    : null;
};

/** `a` is on or before `b`; false when either is missing. */
function onOrBefore(facts: Facts, a: string, b: string): boolean {
  const left = dateFact(facts, a);
  const right = dateFact(facts, b);
  return left !== null && right !== null && compareDates(left, right) <= 0;
}

/** `a` is after `b`; false when either is missing. */
function after(facts: Facts, a: string, b: string): boolean {
  const left = dateFact(facts, a);
  const right = dateFact(facts, b);
  return left !== null && right !== null && compareDates(left, right) > 0;
}

const when = (holds: boolean, fields: string[]): string[] => (holds ? [] : fields);

// ---------- guard builders ----------

const required = (...fields: string[]): IsoGuard => ({
  guard: 'REQUIRED',
  check: (f) => fields.filter((field) => !given(f[field])),
});

const reason = required('reason');

/** A count fact at least `min`. */
const atLeast = (guard: string, fact: string, min: number, field: string): IsoGuard => ({
  guard,
  check: (f) => when(count(f, fact) >= min, [field]),
});

/** A count fact that must be zero. */
const none = (guard: string, fact: string, field: string): IsoGuard => ({
  guard,
  check: (f) => when(count(f, fact) === 0, [field]),
});

/** A date fact not after `asOf`. */
const notFuture = (guard: string, field: string): IsoGuard => ({
  guard,
  check: (f) => when(onOrBefore(f, field, 'asOf'), [field]),
});

const BACK_TO = ['OPEN', 'ACTIONS_PLANNED'];

const backTo: IsoGuard = {
  guard: 'BACK_TO',
  check: (f) => when(BACK_TO.includes(f.backTo as string), ['backTo']),
};

/** Back to ACTIONS_PLANNED needs a new `effectivenessDueOn` after today. */
const newEffectivenessDate: IsoGuard = {
  guard: 'EFFECTIVENESS_DUE_AFTER_TODAY',
  check: (f) =>
    when(f.backTo !== 'ACTIONS_PLANNED' || after(f, 'effectivenessDueOn', 'asOf'), [
      'effectivenessDueOn',
    ]),
};

const chosenBackTo = (f: Facts): string => f.backTo as string;

/** Exactly one live file on the revision, and it CLEAN (`liveFileCount`, `cleanFileCount`). */
const oneCleanFile: IsoGuard = {
  guard: 'ONE_CLEAN_FILE',
  check: (f) => when(count(f, 'liveFileCount') === 1 && count(f, 'cleanFileCount') === 1, ['file']),
};

const documentActive: IsoGuard = {
  guard: 'DOCUMENT_ACTIVE',
  check: (f) => when(f.documentStatus === 'ACTIVE', ['documentStatus']),
  refuse: 'INVALID_TRANSITION',
};

const internalDocument: IsoGuard = {
  guard: 'INTERNAL_DOCUMENT',
  check: (f) => when(given(f.documentType) && f.documentType !== 'EXTERNAL', ['documentType']),
  refuse: 'INVALID_TRANSITION',
};

const subjectOpen: IsoGuard = {
  guard: 'SUBJECT_OPEN',
  check: (f) => when(f.subjectOpen === true, ['subject']),
  refuse: 'INVALID_TRANSITION',
};

const INCIDENT_SOURCES: readonly unknown[] = ['INCIDENT', 'NEAR_MISS'];
const AUDIT_SOURCES: readonly unknown[] = ['INTERNAL_AUDIT', 'EXTERNAL_AUDIT'];
const NC_OPEN_STATES = ['OPEN', 'ROOT_CAUSE_FOUND', 'ACTIONS_PLANNED', 'AWAITING_VERIFICATION'];

// ---------- the tables of model §4 ----------

/**
 * Every arrow of model §4, by machine. `facts` are named as below; M16 gathers them:
 * - field values by their contract names (`description`, `reason`, `effectivenessDueOn`, ...) and `asOf`, the
 *   client's today;
 * - counts as `<what>Count` (`openActionCount`, `doneActionCount`, `liveFileCount`, ...);
 * - NONCONFORMITY: `fromFinding` (RAISE), `incidentOutcome`, `hadVerifyNotEffective`, `doneSinceResetCount` (actions
 *   created since the last VERIFY_NOT_EFFECTIVE or REOPEN that are DONE; null when there was none);
 * - DOCUMENT_REVISION and DOCUMENT: `documentType`, `documentStatus`; ISO_ACTION: `subjectOpen` (model §3.12).
 */
export const ISO_TRANSITIONS: Readonly<Record<IsoMachine, readonly IsoArrow[]>> = {
  NONCONFORMITY: [
    {
      from: [ISO_NEW_STATE],
      action: 'RAISE',
      to: 'OPEN',
      guards: [
        required('description', 'source', 'severity', 'ownerId', 'approverId'),
        {
          guard: 'AUDIT_SOURCE_FROM_FINDING',
          check: (f) =>
            when(!AUDIT_SOURCES.includes(f.source) || f.fromFinding === true, ['source']),
        },
        {
          guard: 'OWNER_IS_NOT_APPROVER',
          check: (f) => when(f.ownerId !== f.approverId, ['approverId']),
        },
        {
          guard: 'INCIDENT_FOR_INCIDENT_SOURCES',
          check: (f) =>
            when(INCIDENT_SOURCES.includes(f.source) === given(f.incident), ['incident']),
        },
      ],
    },
    {
      from: ['OPEN'],
      action: 'ADD_ROOT_CAUSE',
      to: 'ROOT_CAUSE_FOUND',
      guards: [
        required('containment', 'correction', 'rootCauseMethod', 'rootCause', 'similarOccurrences'),
        {
          guard: 'DISPOSITION_AUTHORISED',
          check: (f) =>
            when(!given(f.disposition) || given(f.dispositionAuthorisedById), [
              'dispositionAuthorisedById',
            ]),
        },
        {
          guard: 'INCIDENT_RISK_REVIEW',
          check: (f) =>
            when(
              !INCIDENT_SOURCES.includes(f.source) ||
                count(f, 'relatedRiskItemCount') >= 1 ||
                given(f.riskReview),
              ['relatedRiskItemIds', 'riskReview'],
            ),
        },
      ],
    },
    {
      from: ['ROOT_CAUSE_FOUND'],
      action: 'PLAN_ACTIONS',
      to: 'ACTIONS_PLANNED',
      guards: [
        atLeast('OPEN_ACTION', 'openActionCount', 1, 'actions'),
        required('effectivenessDueOn'),
        {
          guard: 'EFFECTIVENESS_DUE_NOT_PAST',
          check: (f) => when(onOrBefore(f, 'asOf', 'effectivenessDueOn'), ['effectivenessDueOn']),
        },
      ],
    },
    {
      from: ['ROOT_CAUSE_FOUND'],
      action: 'SUBMIT_NO_ACTION',
      to: 'AWAITING_VERIFICATION',
      guards: [
        { guard: 'MAJOR_NEEDS_ACTIONS', check: (f) => when(f.severity === 'MINOR', ['severity']) },
        {
          guard: 'EXTERNAL_AUDIT_NEEDS_ACTIONS',
          check: (f) => when(given(f.source) && f.source !== 'EXTERNAL_AUDIT', ['source']),
        },
        {
          guard: 'INCIDENT_OUTCOME_NEEDS_ACTIONS',
          check: (f) =>
            when(f.incidentOutcome !== 'LOST_TIME' && f.incidentOutcome !== 'FATALITY', [
              'incident.outcome',
            ]),
        },
        {
          guard: 'NOT_EFFECTIVE_NEEDS_ACTIONS',
          check: (f) => when(f.hadVerifyNotEffective === false, ['effective']),
        },
        required('noActionReason', 'riskReview', 'systemChange'),
      ],
    },
    {
      from: ['ACTIONS_PLANNED'],
      action: 'SUBMIT',
      to: 'AWAITING_VERIFICATION',
      guards: [
        atLeast('ACTION_DONE', 'doneActionCount', 1, 'actions'),
        none('ACTIONS_SETTLED', 'openActionCount', 'actions'),
        {
          guard: 'ACTION_DONE_SINCE_RESET',
          check: (f) =>
            when(f.doneSinceResetCount === null || count(f, 'doneSinceResetCount') >= 1, [
              'actions',
            ]),
        },
        required('riskReview', 'systemChange'),
      ],
    },
    {
      from: ['AWAITING_VERIFICATION'],
      action: 'VERIFY_EFFECTIVE',
      to: 'CLOSED',
      guards: [
        required('effectivenessNote'),
        {
          guard: 'EFFECTIVENESS_DUE',
          check: (f) =>
            when(f.effectivenessDueOn === null || onOrBefore(f, 'effectivenessDueOn', 'asOf'), [
              'effectivenessDueOn',
            ]),
        },
      ],
    },
    {
      from: ['AWAITING_VERIFICATION'],
      action: 'VERIFY_NOT_EFFECTIVE',
      to: chosenBackTo,
      guards: [reason, backTo, newEffectivenessDate],
    },
    { from: NC_OPEN_STATES, action: 'CANCEL', to: 'CANCELLED', guards: [reason] },
    {
      from: ['CLOSED'],
      action: 'REOPEN',
      to: chosenBackTo,
      guards: [reason, backTo, newEffectivenessDate],
    },
  ],
  DOCUMENT_REVISION: [
    {
      from: [ISO_NEW_STATE],
      action: 'DRAFT_REVISION',
      to: 'DRAFT',
      guards: [
        documentActive,
        {
          guard: 'ONE_OPEN_REVISION',
          check: (f) => when(count(f, 'openRevisionCount') === 0, ['revision']),
          refuse: 'INVALID_TRANSITION',
        },
      ],
    },
    {
      from: ['DRAFT'],
      action: 'SUBMIT',
      to: 'IN_REVIEW',
      guards: [documentActive, internalDocument, required('changeNote'), oneCleanFile],
    },
    {
      from: ['IN_REVIEW'],
      action: 'APPROVE',
      to: 'APPROVED',
      guards: [documentActive, internalDocument],
    },
    {
      from: ['IN_REVIEW'],
      action: 'SEND_BACK',
      to: 'DRAFT',
      guards: [documentActive, internalDocument, reason],
    },
    {
      from: ['DRAFT'],
      action: 'RECORD_EDITION',
      to: 'APPROVED',
      guards: [
        documentActive,
        {
          guard: 'EXTERNAL_DOCUMENT',
          check: (f) => when(f.documentType === 'EXTERNAL', ['documentType']),
          refuse: 'INVALID_TRANSITION',
        },
        required('issuer', 'externalRef'),
        oneCleanFile,
      ],
    },
  ],
  DOCUMENT: [
    {
      from: ['ACTIVE'],
      action: 'REVIEW',
      to: 'ACTIVE',
      guards: [
        required('currentRevisionId', 'note', 'nextReviewDueOn'),
        {
          guard: 'NEXT_REVIEW_AFTER_TODAY',
          check: (f) => when(after(f, 'nextReviewDueOn', 'asOf'), ['nextReviewDueOn']),
        },
      ],
    },
    { from: ['ACTIVE'], action: 'MAKE_OBSOLETE', to: 'OBSOLETE', guards: [reason] },
  ],
  INTERNAL_AUDIT: [
    { from: ['PLANNED'], action: 'START', to: 'IN_PROGRESS', guards: [] },
    { from: ['PLANNED'], action: 'CANCEL', to: 'CANCELLED', guards: [reason] },
    {
      from: ['IN_PROGRESS'],
      action: 'REPORT',
      to: 'REPORTED',
      guards: [
        required('summary', 'reportedOn'),
        atLeast('REPORTED_TO', 'reportedToCount', 1, 'reportedToIds'),
        none('CHECKLIST_COMPLETE', 'unansweredClauseCount', 'checklist'),
        none('NOT_AUDITED_REASON', 'notAuditedWithoutReasonCount', 'notAuditedReason'),
        notFuture('REPORTED_ON_NOT_FUTURE', 'reportedOn'),
      ],
    },
    {
      from: ['REPORTED'],
      action: 'CLOSE',
      to: 'CLOSED',
      guards: [none('NCS_PAST_OPEN', 'openNcCount', 'nonconformities')],
    },
  ],
  EXTERNAL_AUDIT: [
    {
      from: ['PLANNED'],
      action: 'RECORD_HELD',
      to: 'HELD',
      guards: [
        required('startOn', 'endOn'),
        {
          guard: 'DATES_IN_ORDER',
          check: (f) => when(onOrBefore(f, 'startOn', 'endOn'), ['endOn']),
        },
        notFuture('ENDED', 'endOn'),
        atLeast('REPORT_FILE', 'reportFileCount', 1, 'file'),
        {
          guard: 'RESPONSE_DUE_AFTER_END',
          check: (f) =>
            when(f.responseDueOn === null || onOrBefore(f, 'endOn', 'responseDueOn'), [
              'responseDueOn',
            ]),
        },
      ],
    },
    { from: ['PLANNED'], action: 'CANCEL', to: 'CANCELLED', guards: [reason] },
    {
      from: ['HELD'],
      action: 'RECORD_RESPONSE',
      to: 'RESPONDED',
      guards: [none('NCS_PAST_OPEN', 'openNcCount', 'nonconformities')],
    },
    {
      from: ['HELD'],
      action: 'CLOSE',
      to: 'CLOSED',
      guards: [required('recommendation'), none('NO_NC_FINDING', 'ncFindingCount', 'findings')],
    },
    { from: ['RESPONDED'], action: 'CLOSE', to: 'CLOSED', guards: [required('recommendation')] },
  ],
  MANAGEMENT_REVIEW: [
    {
      from: [ISO_NEW_STATE],
      action: 'PLAN',
      to: 'PLANNED',
      guards: [required('plannedOn', 'chairId')],
    },
    { from: ['PLANNED'], action: 'CANCEL', to: 'CANCELLED', guards: [reason] },
    {
      from: ['PLANNED'],
      action: 'RECORD_HELD',
      to: 'HELD',
      guards: [
        required('heldOn'),
        notFuture('HELD_ON_NOT_FUTURE', 'heldOn'),
        atLeast('ATTENDEES', 'attendeeCount', 1, 'attendeeIds'),
        none('INPUT_NOTES', 'inputsWithoutNotesCount', 'inputs'),
      ],
    },
    {
      from: ['HELD'],
      action: 'CLOSE',
      to: 'CLOSED',
      guards: [
        none('OUTPUT_DECISIONS', 'outputsWithoutDecisionCount', 'outputs'),
        none('REVIEW_ACTIONS_SETTLED', 'openActionCount', 'actions'),
      ],
    },
  ],
  CLAUSE_NA: [
    {
      from: ['NONE', 'REJECTED'],
      action: 'REQUEST_NA',
      to: 'REQUESTED',
      guards: [
        {
          guard: 'EXCLUSION_ALLOWED',
          check: (f) => when(f.exclusionAllowed === true, ['status']),
        },
        reason,
      ],
    },
    { from: ['REQUESTED'], action: 'APPROVE_NA', to: 'APPROVED', guards: [] },
    { from: ['REQUESTED'], action: 'REJECT_NA', to: 'REJECTED', guards: [reason] },
    { from: ['APPROVED'], action: 'WITHDRAW_NA', to: 'NONE', guards: [reason] },
  ],
  ISO_ACTION: [
    {
      from: ['OPEN'],
      action: 'COMPLETE',
      to: 'DONE',
      guards: [subjectOpen, required('doneOn'), notFuture('DONE_ON_NOT_FUTURE', 'doneOn')],
    },
    { from: ['OPEN'], action: 'CANCEL', to: 'CANCELLED', guards: [reason] },
    { from: ['DONE', 'CANCELLED'], action: 'REOPEN', to: 'OPEN', guards: [subjectOpen, reason] },
  ],
};

/**
 * The next state of `machine` from `from` by `action`, or why not: INVALID_TRANSITION when no arrow leaves `from` by
 * `action` or a `refuse` guard fails, else the first failed guard with the fields it names.
 */
export function isoTransition(
  machine: IsoMachine,
  from: string,
  action: string,
  facts: Facts,
): IsoTransitionResult {
  const arrow = ISO_TRANSITIONS[machine].find((a) => a.action === action && a.from.includes(from));
  if (arrow === undefined) return { ok: false, error: 'INVALID_TRANSITION' };
  for (const refusal of arrow.guards.filter((g) => g.refuse !== undefined)) {
    if (refusal.check(facts).length > 0) return { ok: false, error: 'INVALID_TRANSITION' };
  }
  for (const guard of arrow.guards.filter((g) => g.refuse === undefined)) {
    const fields = guard.check(facts);
    if (fields.length > 0) return { ok: false, error: 'GUARD', guard: guard.guard, fields };
  }
  return { ok: true, to: typeof arrow.to === 'string' ? arrow.to : arrow.to(facts) };
}

// ---------- who may act (model §4 preamble) ----------

/**
 * Maker-checker per machine: nobody takes a checker step on a record where they took a maker step since its last
 * reset. A reset that is also a maker step (DRAFT_REVISION: the preparer; REQUEST_NA: the requester) counts itself.
 */
export const ISO_MAKER_CHECKER: Readonly<
  Partial<
    Record<
      IsoMachine,
      { makers: readonly string[]; checkers: readonly string[]; resets: readonly string[] }
    >
  >
> = {
  NONCONFORMITY: {
    makers: ['ADD_ROOT_CAUSE', 'PLAN_ACTIONS', 'SUBMIT', 'SUBMIT_NO_ACTION'],
    checkers: ['VERIFY_EFFECTIVE', 'VERIFY_NOT_EFFECTIVE'],
    resets: ['RAISE', 'REOPEN', 'VERIFY_NOT_EFFECTIVE'],
  },
  DOCUMENT_REVISION: {
    makers: ['DRAFT_REVISION', 'SUBMIT'],
    checkers: ['APPROVE'],
    resets: ['DRAFT_REVISION'],
  },
  CLAUSE_NA: { makers: ['REQUEST_NA'], checkers: ['APPROVE_NA'], resets: ['REQUEST_NA'] },
};

/**
 * Approver steps (model §4 preamble): only the record's approver, or a client admin as delegate, takes them; an
 * account admin or consultant never does.
 */
export const ISO_APPROVER_STEPS: Readonly<Partial<Record<IsoMachine, readonly string[]>>> = {
  NONCONFORMITY: ['VERIFY_EFFECTIVE', 'VERIFY_NOT_EFFECTIVE'],
  DOCUMENT_REVISION: ['APPROVE', 'SEND_BACK'],
  DOCUMENT: ['REVIEW', 'MAKE_OBSOLETE'],
  CLAUSE_NA: ['APPROVE_NA', 'REJECT_NA'],
};

/**
 * Whether `actorId` may take `action` under the maker-checker rule, given the record's steps oldest first (from its
 * audit trail). False means 403 FORBIDDEN.
 */
export function isoMayCheck(
  machine: IsoMachine,
  action: string,
  actorId: string,
  history: readonly { action: string; actorId: string | null }[],
): boolean {
  const rule = ISO_MAKER_CHECKER[machine];
  if (rule === undefined || !rule.checkers.includes(action)) return true;
  let start = 0;
  history.forEach((step, index) => {
    if (rule.resets.includes(step.action)) start = index;
  });
  return !history
    .slice(start)
    .some((step) => rule.makers.includes(step.action) && step.actorId === actorId);
}

// ---------- timing (model §5.2) ----------

/**
 * Where a dated item stands on `asOf`, as `deriveStatus` reads instances: OVERDUE after `dueOn` (days past it),
 * DUE_SOON within `dueSoonDays` of it, else ON_TIME (also with no date). Closed items are CLOSED whatever the date.
 */
export function isoTiming(
  dueOn: LocalDate | null,
  closed: boolean,
  asOf: LocalDate,
  s: { dueSoonDays: number },
): IsoDueStatus {
  if (closed) return { timing: 'CLOSED', overdueDays: null };
  if (dueOn === null) return { timing: 'ON_TIME', overdueDays: null };
  const left = daysBetween(asOf, dueOn);
  if (left < 0) return { timing: 'OVERDUE', overdueDays: -left };
  return { timing: left <= s.dueSoonDays ? 'DUE_SOON' : 'ON_TIME', overdueDays: null };
}

/** `actionStatus`: an OPEN action by its `dueOn`; DONE and CANCELLED are CLOSED. */
export function actionStatus(
  action: Pick<IsoAction, 'state' | 'dueOn'>,
  asOf: LocalDate,
  s: { dueSoonDays: number },
): IsoDueStatus {
  return isoTiming(action.dueOn, action.state !== 'OPEN', asOf, s);
}

/** `reviewDue` for documents and risk items: by `reviewDueOn`; none set is ON_TIME. */
export function reviewDue(
  reviewDueOn: LocalDate | null,
  asOf: LocalDate,
  s: { dueSoonDays: number },
): IsoDueStatus {
  return isoTiming(reviewDueOn, false, asOf, s);
}

/**
 * `nonconformityStatus`: CLOSED once CLOSED or CANCELLED. Otherwise the earliest of the NC's `dueOn` (until it is
 * AWAITING_VERIFICATION) and its OPEN actions' due dates decides the timing, and the effectiveness check is overdue
 * from the day after `effectivenessDueOn`.
 */
export function nonconformityStatus(
  nc: Pick<Nonconformity, 'state' | 'dueOn' | 'effectivenessDueOn'>,
  actions: readonly Pick<IsoAction, 'state' | 'dueOn'>[],
  asOf: LocalDate,
  s: { dueSoonDays: number },
): NonconformityStatus {
  if (nc.state === 'CLOSED' || nc.state === 'CANCELLED') {
    return { timing: 'CLOSED', overdueDays: null, effectivenessOverdueDays: null };
  }
  const dates = actions.filter((a) => a.state === 'OPEN').map((a) => a.dueOn);
  if (nc.state !== 'AWAITING_VERIFICATION') dates.push(nc.dueOn);
  const earliest = dates.sort(compareDates)[0] ?? null;
  const late = nc.effectivenessDueOn === null ? 0 : daysBetween(nc.effectivenessDueOn, asOf);
  return {
    ...isoTiming(earliest, false, asOf, s),
    effectivenessOverdueDays: late > 0 ? late : null,
  };
}

/** External audit states in which the visit took place. */
const TOOK_PLACE: readonly string[] = ['HELD', 'RESPONDED', 'CLOSED'];

/**
 * `certificationCycle`: surveillance 1 and 2 due 12 and 24 months after `issuedOn`, recertification on `expiresOn`.
 * Each is met by the earliest-ending HELD, RESPONDED or CLOSED external audit of that type covering the certificate's
 * standard that ended after `issuedOn` (surveillance 2 also after the audit that met surveillance 1); one that ended
 * after the due date meets it late. An unmet date before `asOf` is overdue. Empty until the certificate is issued.
 * `externalAudits` are the live external audits of the certificate's system.
 */
export function certificationCycle(
  certification: Pick<Certification, 'id' | 'standardId' | 'issuedOn' | 'expiresOn'>,
  externalAudits: readonly Pick<ExternalAudit, 'id' | 'type' | 'state' | 'standardIds' | 'endOn'>[],
  asOf: LocalDate,
): CertificationCycle {
  const { issuedOn, expiresOn } = certification;
  if (issuedOn === null || expiresOn === null) {
    return { certificationId: certification.id, items: [] };
  }
  const held = externalAudits
    .filter((a) => TOOK_PLACE.includes(a.state) && a.standardIds.includes(certification.standardId))
    .sort((a, b) => compareDates(a.endOn, b.endOn) || (a.id < b.id ? -1 : 1));
  const metBy = (kind: CertificationCycleItem['kind'], since: LocalDate) =>
    held.find((a) => a.type === kind && compareDates(a.endOn, since) > 0);
  const item = (
    kind: CertificationCycleItem['kind'],
    dueOn: LocalDate,
    audit: { id: string; endOn: LocalDate } | undefined,
  ): CertificationCycleItem => {
    if (audit === undefined) {
      const overdue = daysBetween(dueOn, asOf);
      return {
        kind,
        dueOn,
        metByAuditId: null,
        metOn: null,
        daysLate: null,
        overdueDays: overdue > 0 ? overdue : null,
      };
    }
    const late = daysBetween(dueOn, audit.endOn);
    return {
      kind,
      dueOn,
      metByAuditId: audit.id,
      metOn: audit.endOn,
      daysLate: late > 0 ? late : null,
      overdueDays: null,
    };
  };
  const first = metBy('SURVEILLANCE_1', issuedOn);
  return {
    certificationId: certification.id,
    items: [
      item('SURVEILLANCE_1', addMonthsToDate(issuedOn, 12), first),
      item(
        'SURVEILLANCE_2',
        addMonthsToDate(issuedOn, 24),
        metBy('SURVEILLANCE_2', first?.endOn ?? issuedOn),
      ),
      item('RECERTIFICATION', expiresOn, metBy('RECERTIFICATION', issuedOn)),
    ],
  };
}

const HELD_REVIEW: readonly string[] = ['HELD', 'CLOSED'];

/**
 * `managementReviewDue`: per standard of the system, the next review is due `reviewIntervalMonths` after the last HELD
 * or CLOSED review covering it, or after the system's `createdOn` when there is none.
 */
export function managementReviewDue(
  system: Pick<IsoSystemInput, 'createdOn' | 'reviewIntervalMonths'> & {
    standards: IsoStandardCode[];
  },
  reviews: readonly Pick<ManagementReview, 'state' | 'heldOn' | 'standards'>[],
  asOf: LocalDate,
  s: { dueSoonDays: number },
): ManagementReviewDue {
  return {
    items: system.standards.map((standard) => {
      const lastHeldOn =
        reviews
          .filter((r) => HELD_REVIEW.includes(r.state) && r.standards.includes(standard))
          .map((r) => r.heldOn)
          .filter((d): d is LocalDate => d !== null)
          .sort(compareDates)
          .at(-1) ?? null;
      const nextDueOn = addMonthsToDate(
        lastHeldOn ?? system.createdOn,
        system.reviewIntervalMonths,
      );
      const status = isoTiming(nextDueOn, false, asOf, s);
      return {
        standard,
        lastHeldOn,
        nextDueOn,
        timing: status.timing as 'ON_TIME' | 'DUE_SOON' | 'OVERDUE',
        overdueDays: status.overdueDays,
      };
    }),
  };
}
