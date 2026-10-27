import {
  EVIDENCE_EXTENSIONS,
  type IsoEntityType,
  type IsoTransitionResult,
} from '@canopy/contracts';
import { ZodError, type z } from 'zod';
import { ApiError } from '../../auth/index.js';

/**
 * M16's error answers (docs/iso/model.md §4 preamble, docs/contracts/iso-mock.md "Shared rules"): a failed guard is
 * 400 VALIDATION naming the field, a wrong state 409 INVALID_TRANSITION `{ entity, from, action }` (`UPDATE` for a
 * field edit, list change, new child row or file change on a locked record), a missing reason 422 REASON_REQUIRED.
 */

/** 400 VALIDATION on `path`: a field, or the path to a nested one (`['nonconformity', 'ownerId']`). */
export function invalid(path: string | readonly string[], message: string): never {
  const at = typeof path === 'string' ? [path] : [...path];
  throw new ApiError('VALIDATION', { issues: [{ path: at, message }] }, message);
}

export function invalidTransition(entity: IsoEntityType, from: string, action: string): never {
  throw new ApiError('INVALID_TRANSITION', { entity, from, action });
}

export function forbidden(action: string, message?: string): never {
  throw new ApiError('FORBIDDEN', { action }, message);
}

export function notFound(): never {
  throw new ApiError('NOT_FOUND');
}

/** 409 STALE_VERSION unless the body's `version` is the record's. */
export function checkVersion(row: { version: number }, version: number): void {
  if (row.version !== version) throw new ApiError('STALE_VERSION', { currentVersion: row.version });
}

/** What a failed guard says (ISO_TRANSITIONS in packages/engine/src/iso-status.ts), by guard. */
const GUARD_MESSAGES: Readonly<Record<string, string>> = {
  REQUIRED: 'Fill this in first',
  ONE_CLEAN_FILE: 'The revision needs exactly one file, and it must have passed the virus scan',
  EXCLUSION_ALLOWED: 'This clause cannot be determined not applicable',
  NEXT_REVIEW_AFTER_TODAY: 'The next review date is after today',
  DATES_IN_ORDER: 'The audit ends after it starts',
  ENDED: 'The visit has not ended yet',
  REPORT_FILE: "Upload the certification body's report first",
  RESPONSE_DUE_AFTER_END: 'The response is due on or after the last day of the visit',
  DONE_ON_NOT_FUTURE: 'doneOn is not in the future',
  DUE_NOT_BEFORE_REPORTED: 'The nonconformity is due on or after the day it is reported',
  AUDIT_SOURCE_FROM_FINDING: 'An audit nonconformity is raised from its finding',
  OWNER_IS_NOT_APPROVER: 'The approver is not the owner',
  INCIDENT_FOR_INCIDENT_SOURCES: 'An INCIDENT or NEAR_MISS has incident fields, other sources none',
  DISPOSITION_AUTHORISED: 'A disposition names who authorised it',
  INCIDENT_RISK_REVIEW:
    'An incident investigation reviews related risk items or records a risk review',
  OPEN_ACTION: 'PLAN_ACTIONS needs at least one OPEN action on the nonconformity',
  EFFECTIVENESS_DUE_NOT_PAST: 'The effectiveness check is due today or later',
  MAJOR_NEEDS_ACTIONS: 'A MAJOR nonconformity needs corrective actions',
  EXTERNAL_AUDIT_NEEDS_ACTIONS: 'A nonconformity from an external audit needs corrective actions',
  INCIDENT_OUTCOME_NEEDS_ACTIONS:
    'An incident with a lost-time or fatal outcome needs corrective actions',
  NOT_EFFECTIVE_NEEDS_ACTIONS: 'A nonconformity found not effective needs corrective actions',
  ACTION_DONE: 'At least one action is DONE first',
  ACTIONS_SETTLED: 'Every action is DONE or CANCELLED first',
  ACTION_DONE_SINCE_RESET:
    'An action added since the nonconformity was found not effective or reopened is DONE first',
  EFFECTIVENESS_DUE: 'Effectiveness is verified on or after its due date',
  EFFECTIVENESS_DUE_AFTER_TODAY: 'The new effectiveness check is due after today',
  REPORTED_TO: 'Name who the results are reported to',
  CHECKLIST_COMPLETE: 'Answer a checklist row for every clause of the audit',
  NOT_AUDITED_REASON: 'A NOT_AUDITED row has a reason',
  REPORTED_ON_NOT_FUTURE: 'The report date is after today',
  NCS_PAST_OPEN: 'Every nonconformity the audit raised leaves OPEN first',
  NO_NC_FINDING: 'Its findings raised nonconformities: record the response first',
  HELD_ON_NOT_FUTURE: 'The review date is after today',
  ATTENDEES: 'Name the people who attended',
  INPUT_NOTES: 'Add notes to every input first',
  OUTPUT_DECISIONS: 'Record a decision on every output first',
  REVIEW_ACTIONS_SETTLED: 'Every review action is DONE or CANCELLED first',
};

/**
 * The next state from the engine's answer, or its refusal: 409 INVALID_TRANSITION `{ entity, from, action }`, or the
 * failed guard as 422 REASON_REQUIRED (a reason) or 400 VALIDATION naming its first field.
 */
export function stepTo(
  result: IsoTransitionResult,
  entity: IsoEntityType,
  from: string,
  action: string,
): string {
  if (result.ok) return result.to;
  if (result.error === 'INVALID_TRANSITION') invalidTransition(entity, from, action);
  if (result.fields.includes('reason')) throw new ApiError('REASON_REQUIRED');
  return invalid(
    result.fields[0]!,
    GUARD_MESSAGES[result.guard] ?? 'This step is not possible yet',
  );
}

/** The issues of a top-level field, as api-conventions.md §5 gives some of them their own code. */
const top = (issue: z.core.$ZodIssue) => (issue.path.length === 1 ? issue.path[0] : undefined);

/**
 * Parses a query or body with its contract schema. As the mock answers them (docs/contracts/iso-mock.md "Shared
 * rules"): a missing or blank `reason`, or none with a change that needs one, is 422 REASON_REQUIRED; a file over the
 * limit 413 FILE_TOO_LARGE; a file type not allowed 415 UNSUPPORTED_FILE; anything else 400 VALIDATION.
 */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const { issues } = result.error;
  const tooBig = issues.find((i) => top(i) === 'sizeBytes' && i.code === 'too_big');
  if (tooBig !== undefined && tooBig.code === 'too_big') {
    throw new ApiError('FILE_TOO_LARGE', { maxBytes: Number(tooBig.maximum) });
  }
  if (issues.some((i) => top(i) === 'fileName' && i.code === 'custom')) {
    throw new ApiError('UNSUPPORTED_FILE', { allowed: [...EVIDENCE_EXTENSIONS] });
  }
  if (
    issues.some(
      (i) =>
        top(i) === 'reason' &&
        (i.code === 'too_small' || i.code === 'invalid_type' || i.code === 'custom'),
    )
  ) {
    throw new ApiError('REASON_REQUIRED');
  }
  throw new ZodError(issues);
}
