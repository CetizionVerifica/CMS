// Derived ISO values the mock shows, standing in for M4's ISO engine (docs/iso/model.md §5). They follow the
// IsoEngineApi contract in src/engine-api.ts closely enough for screens and tests; M4 owns the real rules.
import type { z } from 'zod';
import type {
  CertificationCycle,
  IsoDueStatus,
  IsoTiming,
  NonconformityStatus,
  ObjectiveProgress,
} from '../../schemas/iso-results.js';
import { previewPeriods } from '../periods.js';
import type { FirmState, IsoRow } from '../store.js';
import { addDays, daysFrom } from './common.js';

type Timing = z.input<typeof IsoTiming>;
type Objective = IsoRow<'objectives'>;
type ReadingValue = Pick<IsoRow<'readings'>, 'periodStart' | 'periodEnd' | 'value'>;
type Cycle = z.input<typeof CertificationCycle>;
type CycleItem = Cycle['items'][number];

const pad = (n: number) => String(n).padStart(2, '0');

/** The calendar day of `instant` in `timeZone`. */
export function localDate(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

/** The calendar day of `instant` in the client's time zone: the day a record made then is reported or raised on. */
export function clientDay(firm: FirmState, clientId: string, instant: string): string {
  return localDate(instant, firm.data.clients.find((c) => c.id === clientId)!.settings.timeZone);
}

/** `date` plus `months`, the day clamped to the month's end. */
export function addMonths(date: string, months: number): string {
  const total = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(Math.min(Number(date.slice(8, 10)), last))}`;
}

/** The FY label ("2024-25") containing `date` for an FY starting in `startMonth`. */
export function fyOf(date: string, startMonth: number): string {
  const year = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= startMonth ? year : year - 1;
  return `${start}-${pad((start + 1) % 100)}`;
}

/** `riskRating`: likelihood × severity (1-25). */
export const riskRating = (likelihood: number, severity: number): number => likelihood * severity;

/**
 * `isSignificant`: a manual override wins; otherwise the rating at or above `significantAt`, or (when the rule says so)
 * any item linked to a legal or other requirement.
 */
export function isSignificant(
  item: { rating: number; significantOverride: boolean | null; legalLinked?: boolean },
  rule: { significantAt: number; legalLinkMakesSignificant: boolean },
): boolean {
  if (item.significantOverride !== null) return item.significantOverride;
  return (
    item.rating >= rule.significantAt ||
    (rule.legalLinkMakesSignificant && item.legalLinked === true)
  );
}

/**
 * Where a dated item stands on `today`: CLOSED once `closed`, else OVERDUE after `dueOn`, DUE_SOON within
 * `dueSoonDays` of it, ON_TIME otherwise (or without a date).
 */
export function isoTiming(
  dueOn: string | null,
  closed: boolean,
  today: string,
  dueSoonDays: number,
): z.input<typeof IsoDueStatus> {
  if (closed) return { timing: 'CLOSED', overdueDays: null };
  if (dueOn === null) return { timing: 'ON_TIME', overdueDays: null };
  const days = daysFrom(today, dueOn);
  if (days < 0) return { timing: 'OVERDUE', overdueDays: -days };
  const timing: Timing = days <= dueSoonDays ? 'DUE_SOON' : 'ON_TIME';
  return { timing, overdueDays: null };
}

/**
 * `nonconformityStatus` (model §5.2) as the mock reads it: CLOSED once CLOSED or CANCELLED. Otherwise the earliest of
 * `dueOn` (until the owner submits it) and the due dates of its OPEN actions decides ON_TIME, DUE_SOON or OVERDUE, and
 * the effectiveness check is overdue the day after `effectivenessDueOn`. `actions` are the nonconformity's own; the
 * list's `overdue` filter and the overview's `nonconformities.overdue` both read this.
 */
export function ncStatus(
  nc: IsoRow<'nonconformities'>,
  actions: readonly IsoRow<'actions'>[],
  today: string,
  dueSoonDays: number,
): z.input<typeof NonconformityStatus> {
  if (nc.state === 'CLOSED' || nc.state === 'CANCELLED') {
    return { timing: 'CLOSED', overdueDays: null, effectivenessOverdueDays: null };
  }
  const dates = actions.filter((a) => a.state === 'OPEN').map((a) => a.dueOn);
  if (nc.state !== 'AWAITING_VERIFICATION') dates.push(nc.dueOn);
  const earliest = dates.sort()[0] ?? null;
  const effectivenessLate =
    nc.effectivenessDueOn === null ? 0 : daysFrom(nc.effectivenessDueOn, today);
  return {
    ...isoTiming(earliest, false, today, dueSoonDays),
    effectivenessOverdueDays: effectivenessLate > 0 ? effectivenessLate : null,
  };
}

/** Clause readiness points: IMPLEMENTED 1, PARTIAL 0.5, others 0; score 0-100 with one decimal, null when none count. */
export function readinessScore(
  rows: { clauseId: string; status: string; naState: string; exclusionAllowed: boolean }[],
) {
  const implemented: string[] = [];
  const partial: string[] = [];
  const notStarted: string[] = [];
  const naPending: string[] = [];
  const excluded: string[] = [];
  for (const row of rows) {
    if (row.naState === 'APPROVED' && row.exclusionAllowed) excluded.push(row.clauseId);
    else if (row.naState === 'REQUESTED') naPending.push(row.clauseId);
    else if (row.status === 'IMPLEMENTED') implemented.push(row.clauseId);
    else if (row.status === 'PARTIAL') partial.push(row.clauseId);
    else notStarted.push(row.clauseId);
  }
  const counted = implemented.length + partial.length + notStarted.length + naPending.length;
  const score =
    counted === 0
      ? null
      : Math.round(((implemented.length + partial.length / 2) / counted) * 1000) / 10;
  return { score, implemented, partial, notStarted, naPending, excluded };
}

/** Whether `value` meets the objective's target in its direction (MAINTAIN: equal to it). */
function meets(objective: Pick<Objective, 'direction' | 'target'>, value: number): boolean {
  if (objective.direction === 'INCREASE') return value >= objective.target;
  if (objective.direction === 'DECREASE') return value <= objective.target;
  return Math.abs(value - objective.target) <= 1e-9 * Math.max(1, Math.abs(objective.target));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The reading with the latest `periodEnd` (then `periodStart`). */
function latestOf<R extends ReadingValue>(readings: readonly R[]): R | undefined {
  return [...readings].sort(
    (a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.periodStart.localeCompare(b.periodStart),
  )[readings.length - 1];
}

/**
 * `objectiveProgress(...).onTrack`, the one rule the objective, the systems overview and management review figures
 * share: null without a reading whose period ended by `asOf`; with a baseline, INCREASE and DECREASE compare the
 * latest such reading with the straight line from the baseline on the day the objective was created to the target on
 * `dueOn`, at the reading's `periodEnd`; without one, and for MAINTAIN, the reading must meet the target.
 */
export function objectiveOnTrack(
  objective: Objective,
  readings: readonly ReadingValue[],
  asOf: string,
  timeZone: string,
): boolean | null {
  return objectiveOnTrackFrom(localDate(objective.createdAt, timeZone), objective, readings, asOf);
}

/** `objectiveOnTrack` with the objective's creation day already in the client's time zone, as the figures read it. */
export function objectiveOnTrackFrom(
  createdOn: string,
  objective: Pick<Objective, 'baseline' | 'target' | 'direction' | 'dueOn'>,
  readings: readonly ReadingValue[],
  asOf: string,
): boolean | null {
  const latest = latestOf(readings.filter((r) => r.periodEnd <= asOf));
  if (latest === undefined) return null;
  const { baseline, target } = objective;
  if (baseline === null || objective.direction === 'MAINTAIN')
    return meets(objective, latest.value);
  const span = daysFrom(createdOn, objective.dueOn);
  const share =
    span <= 0 ? 1 : Math.min(1, Math.max(0, daysFrom(createdOn, latest.periodEnd) / span));
  const expected = baseline + (target - baseline) * share;
  return objective.direction === 'INCREASE' ? latest.value >= expected : latest.value <= expected;
}

/**
 * `objectiveProgress` (model §5.1), as the mock reads it:
 * - the latest reading is the one with the latest `periodEnd` on or before `asOf` (a closed objective is measured as
 *   at the day it closed);
 * - `progressPercent` is the way from `baseline` to `target` covered by it, 0-100 (null without a baseline or a
 *   reading); MAINTAIN, or a target equal to the baseline, is 100 when the reading meets the target, else 0;
 * - `onTrack` is `objectiveOnTrack`;
 * - `missedReadings` are the periods of `readingRule` that fell due on or after the day it was created and before
 *   `asOf`, ended on or after that day, start no later than `dueOn`, and no reading overlaps.
 */
export function objectiveProgress(
  objective: Objective,
  readings: readonly ReadingValue[],
  asOf: string,
  client: { fyStartMonth: number; timeZone: string },
): z.input<typeof ObjectiveProgress> {
  const createdOn = localDate(objective.createdAt, client.timeZone);
  const latest = latestOf(readings.filter((r) => r.periodEnd <= asOf));
  const { baseline, target } = objective;
  let progressPercent: number | null = null;
  if (latest !== undefined && baseline !== null) {
    progressPercent =
      objective.direction === 'MAINTAIN' || target === baseline
        ? meets(objective, latest.value)
          ? 100
          : 0
        : Math.min(
            100,
            Math.max(0, round1(((latest.value - baseline) / (target - baseline)) * 100)),
          );
  }
  const missedReadings = previewPeriods(
    objective.readingRule,
    createdOn,
    addDays(asOf, -1),
    client.fyStartMonth,
  )
    .filter(
      (p) =>
        p.periodEnd >= createdOn &&
        p.periodStart <= objective.dueOn &&
        !readings.some((r) => r.periodStart <= p.periodEnd && r.periodEnd >= p.periodStart),
    )
    .map((p) => ({ periodStart: p.periodStart, periodEnd: p.periodEnd }));
  return {
    objectiveId: objective.id,
    latestValue: latest?.value ?? null,
    latestPeriodEnd: latest?.periodEnd ?? null,
    progressPercent,
    onTrack: objectiveOnTrack(objective, readings, asOf, client.timeZone),
    missedReadings,
  };
}

/**
 * The incidents `incidentCounts` (model §5.1) counts, one rule for the systems overview and the INCIDENTS review
 * figures: incident nonconformities, CANCELLED ones left out, whose `occurredAt` falls in [`from`, `to`] as a
 * client-local day.
 */
export function incidentsIn<N extends Pick<IsoRow<'nonconformities'>, 'state' | 'incident'>>(
  ncs: readonly N[],
  period: { from: string; to: string },
  timeZone: string,
): N[] {
  return ncs.filter((n) => {
    if (n.incident === null || n.state === 'CANCELLED') return false;
    const on = localDate(n.incident.occurredAt, timeZone);
    return on >= period.from && on <= period.to;
  });
}

/** External audit states in which the visit took place. */
const TOOK_PLACE: readonly string[] = ['HELD', 'RESPONDED', 'CLOSED'];

/**
 * `certificationCycle`: surveillance 1 and 2 due 12 and 24 months after `issuedOn`, recertification on `expiresOn`.
 * Each is met by the earliest HELD, RESPONDED or CLOSED external audit of the certificate's system of that type that
 * covers the certificate's standard and ended after `issuedOn` (the current cycle only; surveillance 2 also after the
 * audit that met surveillance 1). One that ended after the due date meets it late; an open date before `asOf` is
 * overdue. Empty until the certificate is issued. `externalAudits` are the client's live external audits.
 */
export function certificationCycle(
  certificate: IsoRow<'certifications'>,
  externalAudits: readonly IsoRow<'externalAudits'>[],
  asOf: string,
): Cycle {
  const { issuedOn, expiresOn } = certificate;
  if (issuedOn === null || expiresOn === null)
    return { certificationId: certificate.id, items: [] };
  const held = externalAudits.filter(
    (a) =>
      a.managementSystemId === certificate.managementSystemId &&
      TOOK_PLACE.includes(a.state) &&
      a.standardIds.includes(certificate.standardId),
  );
  const metBy = (kind: CycleItem['kind'], after: string) =>
    held
      .filter((a) => a.type === kind && a.endOn > after)
      .sort((a, b) => a.endOn.localeCompare(b.endOn))[0];
  const item = (
    kind: CycleItem['kind'],
    dueOn: string,
    audit: IsoRow<'externalAudits'> | undefined,
  ): CycleItem => ({
    kind,
    dueOn,
    metByAuditId: audit?.id ?? null,
    metOn: audit?.endOn ?? null,
    daysLate: audit !== undefined && audit.endOn > dueOn ? daysFrom(dueOn, audit.endOn) : null,
    overdueDays: audit === undefined && dueOn < asOf ? daysFrom(dueOn, asOf) : null,
  });
  const first = metBy('SURVEILLANCE_1', issuedOn);
  return {
    certificationId: certificate.id,
    items: [
      item('SURVEILLANCE_1', addMonths(issuedOn, 12), first),
      item(
        'SURVEILLANCE_2',
        addMonths(issuedOn, 24),
        metBy('SURVEILLANCE_2', first?.endOn ?? issuedOn),
      ),
      item('RECERTIFICATION', expiresOn, metBy('RECERTIFICATION', issuedOn)),
    ],
  };
}

/**
 * The clauses and units an audit programme leaves uncovered (model §5.1 `auditProgrammeCoverage`): a clause is covered
 * when a checklist row of a REPORTED or CLOSED audit among `audits` names it with CONFORMS or FINDING; a unit when such
 * a row names it, or the row has no unit and its audit lists the unit. `clauseIds` and `unitIds` are those that need
 * coverage, in the order to answer them.
 */
export function uncoveredByAudits(
  audits: readonly Pick<IsoRow<'internalAudits'>, 'id' | 'state' | 'unitIds'>[],
  items: readonly IsoRow<'auditChecklistItems'>[],
  clauseIds: readonly string[],
  unitIds: readonly string[],
): { clauseIds: string[]; unitIds: string[] } {
  const reported = new Map(
    audits
      .filter((a) => a.state === 'REPORTED' || a.state === 'CLOSED')
      .map((a) => [a.id, a.unitIds]),
  );
  const clauses = new Set<string>();
  const units = new Set<string>();
  for (const item of items) {
    const auditUnits = reported.get(item.internalAuditId);
    if (auditUnits === undefined) continue;
    if (item.result !== 'CONFORMS' && item.result !== 'FINDING') continue;
    clauses.add(item.clauseId);
    for (const unit of item.unitId === null ? auditUnits : [item.unitId]) units.add(unit);
  }
  return {
    clauseIds: clauseIds.filter((id) => !clauses.has(id)),
    unitIds: unitIds.filter((id) => !units.has(id)),
  };
}
