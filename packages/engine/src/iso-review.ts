import {
  FindingType,
  IncidentOutcome,
  IncidentType,
  NcSeverity,
  NcSource,
  type Id,
  type LocalDate,
  type ReviewFigure,
  type ReviewFigureAction,
  type ReviewFigureData,
  type ReviewFigureDays,
  type ReviewInputSource,
  type TypedReviewInputFigures,
} from '@canopy/contracts';
import { compareDates } from './dates.js';
import { objectiveProgress } from './iso-score.js';
import { computeScore } from './score.js';

/**
 * Management review input figures (docs/iso/model.md §5.4; ADR M4-0001 rule 18). The caller (M3's
 * `reviewFigures.gather`) passes, per source, the review's system's records for the input's standards as
 * `ReviewFigureData[source]`: archived ones included, with no unit scope (plan §3.3 exception; who may read a stored
 * figure's ids is M16's), every timestamp a client-local day. The engine counts them between `since` and `asOf`, both
 * days included, reading each record as it is now except where one of its days gives its state on `asOf`: its creation
 * and archive days, an NC's counting day, the days that place an entered date (`settledOn`, `closeStepOn`,
 * `reportStepOn`, `heldStepOn`), the climate decisions' days and the event-day lists. It rebuilds no history: a held
 * review stores its figures once, at RECORD_HELD (ADR M16-0003).
 */

type Day = LocalDate;
type FigureSource = Exclude<ReviewInputSource, 'MANUAL'>;

interface Window {
  since: Day;
  asOf: Day;
}

const within = (w: Window, day: Day | null): boolean =>
  day !== null && compareDates(day, w.since) >= 0 && compareDates(day, w.asOf) <= 0;

/** On or before as-of. */
const byAsOf = (w: Window, day: Day | null): boolean =>
  day !== null && compareDates(day, w.asOf) <= 0;

/** The later of two days; a missing one never wins. */
const later = (a: Day | null, b: Day | null): Day | null =>
  a === null || (b !== null && compareDates(b, a) > 0) ? b : a;

/** Live on as-of: created by then and not archived by then (one archived on a later day still counts). */
const liveOn = (w: Window, row: ReviewFigureDays): boolean =>
  byAsOf(w, row.createdOn) && !byAsOf(w, row.archivedOn);

/** An action's settled day: the later of `doneOn` and its step when DONE, its step when CANCELLED, none while OPEN. */
const settledDay = (a: ReviewFigureAction): Day | null =>
  a.state === 'OPEN' ? null : later(a.state === 'DONE' ? a.doneOn : null, a.settledOn);

/** An action's state on as-of: OPEN until its settled day. */
const stateOn = (w: Window, a: ReviewFigureAction): ReviewFigureAction['state'] =>
  byAsOf(w, settledDay(a)) ? a.state : 'OPEN';

const overdueOn = (w: Window, a: ReviewFigureAction): boolean =>
  stateOn(w, a) === 'OPEN' && compareDates(a.dueOn, w.asOf) < 0;

const settledIn = (
  w: Window,
  actions: readonly ReviewFigureAction[],
  state: ReviewFigureAction['state'],
) => actions.filter((a) => a.state === state && within(w, settledDay(a)));

/** An NC's counting day: the later of its creation day and `reportedOn`, which may be backdated. */
const countingDay = (n: { createdOn: Day; reportedOn: Day }): Day =>
  later(n.createdOn, n.reportedOn) as Day;

const figure = (key: string, ids: readonly Id[]): ReviewFigure => ({
  key,
  value: ids.length,
  ids: [...ids],
});

const ids = (rows: readonly { id: Id }[]): Id[] => rows.map((r) => r.id);

/** `prefix` and an enum value as one camelCase key: ('raised', 'INTERNAL_AUDIT') is 'raisedInternalAudit'. */
export function figureKey(prefix: string, value: string): string {
  return (
    prefix +
    value
      .toLowerCase()
      .replace(/(^|_)([a-z0-9])/g, (_m, _sep: string, c: string) => c.toUpperCase())
  );
}

const REPORTED: readonly string[] = ['REPORTED', 'CLOSED'];
const TOOK_PLACE: readonly string[] = ['HELD', 'RESPONDED', 'CLOSED'];

const SOURCES: { [S in FigureSource]: (d: ReviewFigureData[S], w: Window) => ReviewFigure[] } = {
  /** Open on as-of and overdue then, whichever review raised them; done and cancelled by their settled day. */
  PREVIOUS_ACTIONS: (d, w) => {
    const actions = d.actions.filter((a) => liveOn(w, a));
    return [
      figure('actionsOpen', ids(actions.filter((a) => stateOn(w, a) === 'OPEN'))),
      figure('actionsOverdue', ids(actions.filter((a) => overdueOn(w, a)))),
      figure('actionsDone', ids(settledIn(w, actions, 'DONE'))),
      figure('actionsCancelled', ids(settledIn(w, actions, 'CANCELLED'))),
    ];
  },

  /**
   * Issues and interested parties added, changed (an UPDATE in the window) or removed in the window; the climate
   * decision from its first decision by as-of (it never returns to undecided), relevant as it is now once decided, and
   * decided in the period when any decision falls in the window.
   */
  CONTEXT: (d, w) => {
    const live = d.contextItems.filter((c) => liveOn(w, c));
    const added = live.filter((c) => within(w, c.createdOn));
    const updated = new Set(d.contextChanges.filter((c) => within(w, c.on)).map((c) => c.entityId));
    const changed = live.filter((c) => !added.includes(c) && updated.has(c.id));
    const party = (c: { kind: string }) => c.kind === 'INTERESTED_PARTY';
    const { system } = d;
    const days = d.climateDecisions.map((c) => c.on);
    const decided = days.some((day) => byAsOf(w, day)) ? [system.id] : [];
    return [
      figure('issuesAdded', ids(added.filter((c) => !party(c)))),
      figure('issuesChanged', ids(changed.filter((c) => !party(c)))),
      figure('interestedPartiesAdded', ids(added.filter(party))),
      figure('interestedPartiesChanged', ids(changed.filter(party))),
      figure(
        'contextItemsRemoved',
        ids(d.contextItems.filter((c) => byAsOf(w, c.createdOn) && within(w, c.archivedOn))),
      ),
      figure('climateDecided', decided),
      figure('climateRelevant', system.climateChangeRelevant === true ? decided : []),
      figure('climateDecidedInPeriod', days.some((day) => within(w, day)) ? [system.id] : []),
    ];
  },

  /**
   * Items added or re-rated in the window, items significant (as stored now) for each kind in `kinds` only, and the
   * treatment actions of the items live on as-of: done in the window by their settled day, and open on as-of.
   */
  RISKS: (d, w) => {
    const items = d.riskItems.filter((i) => liveOn(w, i));
    const added = items.filter((i) => within(w, i.createdOn));
    const rerated = new Set(d.ratingChanges.filter((c) => within(w, c.on)).map((c) => c.entityId));
    const itemIds = new Set(ids(items));
    const treatments = d.treatmentActions.filter((a) => liveOn(w, a) && itemIds.has(a.subject.id));
    const significant = items.filter((i) => i.significant);
    return [
      figure('itemsAdded', ids(added)),
      figure('itemsRerated', ids(items.filter((i) => !added.includes(i) && rerated.has(i.id)))),
      ...d.kinds.map((kind) =>
        figure(figureKey('significant', kind), ids(significant.filter((i) => i.kind === kind))),
      ),
      figure('treatmentActionsDone', ids(settledIn(w, treatments, 'DONE'))),
      figure('treatmentActionsOpen', ids(treatments.filter((a) => stateOn(w, a) === 'OPEN'))),
    ];
  },

  /**
   * `objectiveProgress` of the objectives open on as-of over the readings created by then (for periods ended by then),
   * those closed in the window by outcome, and the readings created in the window, whatever their period. A closed
   * objective is placed by the later of `closedOn` and its CLOSE step, and is open on as-of until then.
   */
  OBJECTIVES: (d, w) => {
    const objectives = d.objectives.filter((o) => liveOn(w, o));
    const closedDay = (o: (typeof objectives)[number]) =>
      o.closedOn === null ? null : later(o.closedOn, o.closeStepOn);
    const readingsOf = (o: (typeof objectives)[number]) => o.readings.filter((r) => liveOn(w, r));
    const open = objectives.filter((o) => !byAsOf(w, closedDay(o)));
    const track = new Map(
      open.map((o) => [o.id, objectiveProgress(readingsOf(o), o, w.asOf, d.calendar).onTrack]),
    );
    const closed = objectives.filter((o) => within(w, closedDay(o)));
    const recorded = objectives.flatMap(readingsOf).filter((r) => within(w, r.createdOn));
    return [
      figure('objectivesOpen', ids(open)),
      figure('onTrack', ids(open.filter((o) => track.get(o.id) === true))),
      figure('offTrack', ids(open.filter((o) => track.get(o.id) === false))),
      figure('withoutReading', ids(open.filter((o) => track.get(o.id) === null))),
      figure('achieved', ids(closed.filter((o) => o.outcome === 'ACHIEVED'))),
      figure('notAchieved', ids(closed.filter((o) => o.outcome === 'NOT_ACHIEVED'))),
      figure('readingsRecorded', ids(recorded)),
    ];
  },

  /**
   * Raised (by the counting day) and closed in the window, by severity and source; the VERIFY_NOT_EFFECTIVE steps in
   * the window (the number of steps, with the NCs behind them); the NCs open on as-of (not CANCELLED as it is now, and
   * not closed by then) and those NCs' corrective actions overdue on as-of.
   */
  NONCONFORMITIES: (d, w) => {
    const ncs = d.nonconformities.filter(
      (n) => byAsOf(w, countingDay(n)) && !byAsOf(w, n.archivedOn),
    );
    const raised = ncs.filter((n) => within(w, countingDay(n)));
    const closed = ncs.filter((n) => within(w, n.closedOn));
    const ncIds = new Set(ids(ncs));
    const notEffective = d.notEffectiveSteps.filter(
      (s) => ncIds.has(s.entityId) && within(w, s.on),
    );
    const open = ncs.filter((n) => n.state !== 'CANCELLED' && !byAsOf(w, n.closedOn));
    const openIds = new Set(ids(open));
    const overdue = d.correctiveActions.filter(
      (a) => liveOn(w, a) && openIds.has(a.subject.id) && overdueOn(w, a),
    );
    const by = (prefix: string, rows: typeof ncs) => [
      ...NcSeverity.options.map((s) =>
        figure(figureKey(prefix, s), ids(rows.filter((n) => n.severity === s))),
      ),
      ...NcSource.options.map((s) =>
        figure(figureKey(prefix, s), ids(rows.filter((n) => n.source === s))),
      ),
    ];
    return [
      figure('raised', ids(raised)),
      figure('closed', ids(closed)),
      ...by('raised', raised),
      ...by('closed', closed),
      {
        key: 'verifiedNotEffective',
        value: notEffective.length,
        ids: [...new Set(notEffective.map((s) => s.entityId))],
      },
      figure('open', ids(open)),
      figure('correctiveActionsOverdue', ids(overdue)),
    ];
  },

  /**
   * Incidents placed in the window by their NC's counting day (their `occurredAt` day is never later), cancelled ones
   * left out, then grouped by type and outcome as `incidentCounts` groups them, with the lost days. `incidentCounts`
   * itself keeps the overview's `occurredAt` rule.
   */
  INCIDENTS: (d, w) => {
    const incidents = d.nonconformities.flatMap((n) =>
      n.incident !== null &&
      n.state !== 'CANCELLED' &&
      !byAsOf(w, n.archivedOn) &&
      within(w, countingDay(n))
        ? [{ id: n.id, incident: n.incident }]
        : [],
    );
    const lostTime = incidents.flatMap((n) =>
      n.incident.lostDays === null ? [] : [{ id: n.id, lostDays: n.incident.lostDays }],
    );
    return [
      figure('incidents', ids(incidents)),
      ...IncidentType.options.map((t) =>
        figure(figureKey('type', t), ids(incidents.filter((n) => n.incident.type === t))),
      ),
      ...IncidentOutcome.options.map((o) =>
        figure(figureKey('outcome', o), ids(incidents.filter((n) => n.incident.outcome === o))),
      ),
      {
        key: 'lostDays',
        value: lostTime.reduce((sum, n) => sum + n.lostDays, 0),
        ids: ids(lostTime),
      },
    ];
  },

  /**
   * Internal audits reported, placed by the later of `reportedOn` and their REPORT step, and external audits held,
   * placed by the later of `endOn` and the step that set it, in the window; and the findings of those audits by type,
   * each placed by the later of its audit's day and its own creation day, whether or not its audit counts in the window.
   */
  AUDIT_RESULTS: (d, w) => {
    const day = new Map<Id, Day>();
    const internal = d.internalAudits.filter((a) => liveOn(w, a) && REPORTED.includes(a.state));
    for (const a of internal) day.set(a.id, later(a.reportedOn, a.reportStepOn) as Day);
    const external = d.externalAudits.filter((e) => liveOn(w, e) && TOOK_PLACE.includes(e.state));
    for (const e of external) day.set(e.id, later(e.endOn, e.heldStepOn) as Day);
    const findings = d.findings.filter((x) => {
      const auditDay = day.get(x.auditId);
      return liveOn(w, x) && auditDay !== undefined && within(w, later(auditDay, x.createdOn));
    });
    return [
      figure('internalAuditsReported', ids(internal.filter((a) => within(w, day.get(a.id)!)))),
      figure('externalAuditsHeld', ids(external.filter((e) => within(w, day.get(e.id)!)))),
      ...FindingType.options.map((t) =>
        figure(figureKey('findings', t), ids(findings.filter((x) => x.type === t))),
      ),
    ];
  },

  /**
   * The evaluation activity's instances (due and done in the window, and the latest due by as-of) and the STATUTE-only
   * `computeScore` of the instances due in the window (a score has no ids), their workflow read as it is now, as the
   * core score's as-of is.
   */
  COMPLIANCE_EVALUATION: (d, w) => {
    const evaluations = d.evaluations.filter((i) => liveOn(w, i));
    const latest = evaluations
      .filter((i) => byAsOf(w, i.dueDate))
      .sort((a, b) => compareDates(b.dueDate, a.dueDate))[0];
    const statutory = d.statutoryItems.filter((i) => liveOn(w, i) && within(w, i.dueDate));
    const { score } = computeScore(statutory, w.asOf, d.settings);
    return [
      figure('evaluationsDue', ids(evaluations.filter((i) => within(w, i.dueDate)))),
      figure(
        'evaluationsDone',
        ids(evaluations.filter((i) => i.workflowState === 'APPROVED' && within(w, i.completedOn))),
      ),
      figure('latestEvaluation', latest === undefined ? [] : [latest.id]),
      figure(
        'statutoryInstancesDue',
        statutory.map((i) => i.instanceId),
      ),
      ...(score === null ? [] : [{ key: 'statutoryScore', value: score, ids: [] }]),
    ];
  },
};

/**
 * `reviewInputFigures`: one input source's figures between `since` (set by the caller, model §5.4) and `asOf`, from
 * that source's `ReviewFigureData`. MANUAL gets no figures. A `since` after `asOf` is a RangeError.
 */
export const reviewInputFigures: TypedReviewInputFigures = (source, data, since, asOf) => {
  if (compareDates(since, asOf) > 0) {
    throw new RangeError(`since is after asOf: ${since} > ${asOf}`);
  }
  const w = { since, asOf };
  // `source` and `data` arrive as one pair (`ReviewFigureData[S]`); the table holds each source's function.
  const figures =
    source === 'MANUAL'
      ? []
      : (SOURCES[source as FigureSource] as (d: typeof data, w: Window) => ReviewFigure[])(data, w);
  return { source, since, asOf, figures };
};
