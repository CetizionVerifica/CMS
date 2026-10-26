import {
  ClientSettings,
  FirmSettings,
  Id,
  IsoStandardCode,
  LocalDate,
  ManagementReview,
  ReviewInputKey,
  ReviewInputSource,
  reviewRiskKinds,
  type ActKind,
  type IsoAction,
  type IsoReviewInputDef,
  type ManagementSystem,
  type ReviewFigureAction,
  type ReviewFigureData,
  type ReviewFigureDays,
  type ReviewFigureEventDay,
} from '@canopy/contracts';
import { and, asc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { TenantTx } from '../database.js';
import { DbError, rethrow, validate } from '../errors.js';
import * as s from '../schema/index.js';
import { contextEntity, externalAuditEntity, managementSystems } from './iso.js';
import {
  actionEntity,
  findingEntity,
  internalAuditRecord,
  ncRecord,
  objectiveRecord,
  readingEntity,
  reviewRecord,
  riskEntity,
} from './iso-records.js';
import { uuids } from './iso-shared.js';

/**
 * Review figure reads (docs/iso/model.md §3.13, §5.4; ISO-2h): `reviewFigures.gather` reads one input row's records
 * and window for the engine's `reviewInputFigures`, as the contracts mock's `gather` does. M16 (ISO-8c) and M10
 * (ISO-11d) both call it, so the screen, the stored copy and the review pack read the same records. The records are
 * the review's system's with no unit scope and archived ones included (plan §3.3's exception); each reader's ids are
 * cut afterwards with `isoVisibleIds`.
 */

/** An instant's client-local day: the caller's `localDateIn` with the client's time zone (root rule 4). */
export type LocalDayOf = (instant: string) => LocalDate;

/** One input's window start and records, by source. */
export type GatheredFigures = {
  [S in ReviewInputSource]: { source: S; since: LocalDate; data: ReviewFigureData[S] };
}[ReviewInputSource];

type FigureSource = Exclude<ReviewInputSource, 'MANUAL'>;

/** What gathering one input reads: the review, its system, the input's key and standards, as-of. */
interface Gather {
  tx: TenantTx;
  clientId: string;
  system: ManagementSystem;
  /** The catalogue standard id of each code the system covers. */
  standards: Map<IsoStandardCode, string>;
  key: ReviewInputKey;
  /** The review's standards that ask for this input. */
  codes: IsoStandardCode[];
  asOf: LocalDate;
  localDay: LocalDayOf;
  /** The held reviews before this one that cover one of `codes`. */
  earlier: ManagementReview[];
}

/** An audited event as the window counts read it. */
interface Event {
  entityId: string;
  at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

type EntityType = (typeof s.auditEvent.$inferSelect)['entityType'];

const textArray = (values: readonly string[]): SQL =>
  sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

const e = s.auditEvent;

/** A TRANSITION naming one of `steps` in its `after.action`. */
const stepIs = (...steps: string[]): SQL =>
  sql`(${e.action} = 'TRANSITION' and ${e.after}->>'action' = any(${textArray(steps)}))`;

/** An UPDATE whose `after` names one of `fields`. */
const updateNames = (...fields: string[]): SQL =>
  sql`(${e.action} = 'UPDATE' and ${e.after} ?| ${textArray(fields)})`;

const UPDATE = sql`(${e.action} = 'UPDATE')`;

/**
 * A re-rating (model §5.4): an UPDATE naming a rating field. The clearing of the residual rating when a treatment
 * action puts the last control in place names its action (`sourceActionId`) and is not one.
 */
const RERATING = sql`(${updateNames('likelihood', 'severity', 'residualLikelihood', 'residualSeverity')} and not (${e.after} ? 'sourceActionId'))`;

/** A climate decision: a management system UPDATE naming a climate field, which only the climate route writes. */
const CLIMATE = updateNames('climateChangeRelevant', 'climateChangeRationale', 'climateDecidedOn');

/** The audited events of `ids` that pass `test`, oldest first. */
async function eventsOf(
  g: Gather,
  entityType: EntityType,
  ids: readonly string[],
  test: SQL,
): Promise<Event[]> {
  if (ids.length === 0) return [];
  const rows = await g.tx
    .select({ entityId: e.entityId, at: e.at, before: e.before, after: e.after })
    .from(e)
    .where(and(eq(e.entityType, entityType), sql`${e.entityId} = any(${uuids(ids)})`, test))
    .orderBy(asc(e.at), asc(e.id))
    .catch(rethrow);
  return rows.map((r) => ({
    entityId: r.entityId,
    at: r.at.toISOString(),
    before: r.before,
    after: r.after,
  }));
}

/** Event days for the window counts: one per event, each on its client-local day. */
const eventDays = (g: Gather, events: readonly Event[]): ReviewFigureEventDay[] =>
  events.map((ev) => ({ entityId: ev.entityId as Id, on: g.localDay(ev.at) }));

/** A row's creation and archive days. */
const daysOf = (
  g: Gather,
  row: { createdAt: string; archivedAt: string | null },
): ReviewFigureDays => ({
  createdOn: g.localDay(row.createdAt),
  archivedOn: row.archivedAt === null ? null : g.localDay(row.archivedAt),
});

/**
 * The day of each record's latest step that passes `test` (the latest when it was taken more than once). A record
 * seeded or loaded without that step in its trail takes its `createdAt`, which never changes, so it is placed by the
 * later of its entered date and its creation day.
 */
async function stepDays(
  g: Gather,
  entityType: EntityType,
  rows: readonly { id: string; createdAt: string }[],
  test: SQL,
): Promise<Map<string, LocalDate>> {
  const latest = new Map<string, string>();
  for (const ev of await eventsOf(
    g,
    entityType,
    rows.map((r) => r.id),
    test,
  )) {
    latest.set(ev.entityId, ev.at);
  }
  return new Map(rows.map((r) => [r.id, g.localDay(latest.get(r.id) ?? r.createdAt)]));
}

/** Rows in id (creation) order, as the mock's store keeps them. */
const byId = <T extends { id: string }>(rows: T[]): T[] =>
  rows.sort((a, b) => a.id.localeCompare(b.id));

/** The client's actions whose `subject` column is one of `subjectIds`, with their settled day. */
async function actionsOn(
  g: Gather,
  column: 'riskItemId' | 'nonconformityId' | 'managementReviewId',
  subjectIds: readonly string[],
): Promise<ReviewFigureAction[]> {
  if (subjectIds.length === 0) return [];
  const a = s.isoAction;
  const actions = byId(
    await actionEntity.all(
      g.tx,
      and(eq(a.clientId, g.clientId), sql`${a[column]} = any(${uuids(subjectIds)})`),
    ),
  );
  const settled = await stepDays(
    g,
    'iso_action',
    actions.filter((x) => x.state !== 'OPEN'),
    stepIs('COMPLETE', 'CANCEL'),
  );
  return actions.map((x: IsoAction) => ({
    id: x.id,
    subject: x.subject,
    state: x.state,
    dueOn: x.dueOn,
    doneOn: x.doneOn,
    ...daysOf(g, x),
    settledOn: x.state === 'OPEN' ? null : settled.get(x.id)!,
  }));
}

/** The later of two days; a missing one never wins. */
const later = (a: LocalDate | null, b: LocalDate | null) =>
  a === null || (b !== null && b > a) ? b : a;

/**
 * The decision a system was seeded or loaded with (model §5.4): one decided with no decision in its trail, or whose
 * first decision (`decisions`, oldest first) does not move `climateChangeRelevant` from null, was decided before its
 * trail starts. It is placed by the later of the `climateDecidedOn` it was seeded with, which the decisions since give
 * back in their `before`, and its creation day.
 */
function seededDecision(g: Gather, decisions: readonly Event[]): ReviewFigureEventDay[] {
  const { system } = g;
  if (system.climateChangeRelevant === null) return [];
  const first = decisions[0];
  if (first !== undefined && first.before?.climateChangeRelevant === null) return [];
  let decidedOn: LocalDate | null = system.climateDecidedOn;
  for (const ev of [...decisions].reverse()) {
    if (ev.before !== null && 'climateDecidedOn' in ev.before) {
      decidedOn = ev.before.climateDecidedOn as LocalDate | null;
    }
  }
  return [{ entityId: system.id, on: later(decidedOn, g.localDay(system.createdAt))! }];
}

/** `column` (a standards array) overlaps the input's standards. */
const ofCodes = (g: Gather, column: PgColumn) =>
  g.codes.length === 0
    ? sql`false`
    : sql`${column} && ${`{${g.codes.join(',')}}`}::iso_standard_code[]`;

/** The system's nonconformities of the input's standards, archived ones included. */
const ncsOf = async (g: Gather) => {
  const n = s.nonconformity;
  return byId(
    await ncRecord.all(
      g.tx,
      and(
        eq(n.clientId, g.clientId),
        eq(n.managementSystemId, g.system.id),
        ofCodes(g, n.standards),
      ),
    ),
  );
};

/** Internal audit states once reported, and external audit states once the visit took place. */
const VISITED: readonly string[] = ['HELD', 'RESPONDED', 'CLOSED'];

async function clientSettings(g: Gather): Promise<ClientSettings> {
  const [row] = await g.tx
    .select({ settings: s.client.settings })
    .from(s.client)
    .where(eq(s.client.id, g.clientId))
    .catch(rethrow);
  if (!row) throw new DbError('NOT_FOUND', 'Not found');
  return ClientSettings.parse(row.settings);
}

const GATHER: { [S in FigureSource]: (g: Gather) => Promise<ReviewFigureData[S]> } = {
  async PREVIOUS_ACTIONS(g) {
    return {
      actions: await actionsOn(
        g,
        'managementReviewId',
        g.earlier.map((r) => r.id),
      ),
    };
  },

  async CONTEXT(g) {
    const c = s.contextItem;
    const items = byId(
      await contextEntity.all(
        g.tx,
        and(eq(c.clientId, g.clientId), eq(c.managementSystemId, g.system.id)),
      ),
    );
    const updates = await eventsOf(
      g,
      'context_item',
      items.map((i) => i.id),
      UPDATE,
    );
    const decisions = await eventsOf(g, 'management_system', [g.system.id], CLIMATE);
    return {
      contextItems: items.map((i) => ({ id: i.id, kind: i.kind, ...daysOf(g, i) })),
      contextChanges: eventDays(g, updates),
      system: {
        id: g.system.id,
        climateChangeRelevant: g.system.climateChangeRelevant,
        climateDecidedOn: g.system.climateDecidedOn,
      },
      climateDecisions: [...seededDecision(g, decisions), ...eventDays(g, decisions)],
    };
  },

  async RISKS(g) {
    const kinds = reviewRiskKinds(g.key, g.codes);
    const r = s.riskItem;
    const items = kinds.length
      ? byId(
          await riskEntity.all(
            g.tx,
            and(
              eq(r.clientId, g.clientId),
              eq(r.managementSystemId, g.system.id),
              inArray(r.kind, kinds),
            ),
          ),
        )
      : [];
    const itemIds = items.map((i) => i.id);
    return {
      kinds,
      riskItems: items.map((i) => ({
        id: i.id,
        kind: i.kind,
        significant: i.significant,
        ...daysOf(g, i),
      })),
      ratingChanges: eventDays(g, await eventsOf(g, 'risk_item', itemIds, RERATING)),
      treatmentActions: await actionsOn(g, 'riskItemId', itemIds),
    };
  },

  async OBJECTIVES(g) {
    const o = s.objective;
    const objectives = byId(
      await objectiveRecord.all(
        g.tx,
        and(
          eq(o.clientId, g.clientId),
          eq(o.managementSystemId, g.system.id),
          ofCodes(g, o.standards),
        ),
      ),
    );
    const ids = objectives.map((x) => x.id);
    const readings = ids.length
      ? byId(await readingEntity.all(g.tx, inArray(s.objectiveReading.objectiveId, ids)))
      : [];
    const closeSteps = await stepDays(
      g,
      'objective',
      objectives.filter((x) => x.closedOn !== null),
      stepIs('CLOSE'),
    );
    return {
      objectives: objectives.map((x) => ({
        id: x.id,
        target: x.target,
        baseline: x.baseline,
        direction: x.direction,
        readingRule: x.readingRule,
        dueOn: x.dueOn,
        closedOn: x.closedOn,
        outcome: x.outcome,
        ...daysOf(g, x),
        closeStepOn: x.closedOn === null ? null : closeSteps.get(x.id)!,
        readings: readings
          .filter((r) => r.objectiveId === x.id)
          .map((r) => ({
            id: r.id,
            periodStart: r.periodStart,
            periodEnd: r.periodEnd,
            value: r.value,
            ...daysOf(g, r),
          })),
      })),
      calendar: { fyStartMonth: (await clientSettings(g)).fyStartMonth },
    };
  },

  async NONCONFORMITIES(g) {
    const ncs = await ncsOf(g);
    const ncIds = ncs.map((n) => n.id);
    return {
      nonconformities: ncs.map((n) => ({
        id: n.id,
        state: n.state,
        severity: n.severity,
        source: n.source,
        reportedOn: n.reportedOn,
        closedOn: n.closedOn,
        ...daysOf(g, n),
      })),
      notEffectiveSteps: eventDays(
        g,
        await eventsOf(g, 'nonconformity', ncIds, stepIs('VERIFY_NOT_EFFECTIVE')),
      ),
      correctiveActions: await actionsOn(g, 'nonconformityId', ncIds),
    };
  },

  async INCIDENTS(g) {
    return {
      nonconformities: (await ncsOf(g))
        .filter((n) => n.incident !== null && n.state !== 'CANCELLED')
        .map((n) => ({
          id: n.id,
          state: n.state,
          reportedOn: n.reportedOn,
          incident: n.incident,
          ...daysOf(g, n),
        })),
      timeZone: (await clientSettings(g)).timeZone,
    };
  },

  async AUDIT_RESULTS(g) {
    const covered = g.codes
      .map((code) => g.standards.get(code))
      .filter((id): id is string => id !== undefined);
    const ia = s.internalAudit;
    const internalAll = byId(
      await internalAuditRecord.all(
        g.tx,
        and(
          eq(ia.clientId, g.clientId),
          sql`${ia.programmeId} in (select p.id from audit_programme p where p.management_system_id = ${g.system.id})`,
        ),
      ),
    );
    const ea = s.externalAudit;
    const external = byId(
      await externalAuditEntity.all(
        g.tx,
        and(eq(ea.clientId, g.clientId), eq(ea.managementSystemId, g.system.id)),
      ),
    ).filter((x) => x.standardIds.some((id) => covered.includes(id)));
    const f = s.auditFinding;
    const findingsAll =
      internalAll.length + external.length
        ? byId(
            await findingEntity.all(
              g.tx,
              or(
                internalAll.length
                  ? inArray(
                      f.internalAuditId,
                      internalAll.map((x) => x.id),
                    )
                  : undefined,
                external.length
                  ? inArray(
                      f.externalAuditId,
                      external.map((x) => x.id),
                    )
                  : undefined,
              ),
            ),
          )
        : [];
    // A record's standards are its clauses'; one that lists no clauses follows its system (an internal audit) or its
    // audit (a finding), as for the nonconformities a finding raises.
    const clauseIds = [...new Set([...internalAll, ...findingsAll].flatMap((x) => x.clauseIds))];
    const clauseStandards = new Map<string, string>();
    if (clauseIds.length) {
      const rows = await g.tx
        .select({ id: s.isoClause.id, standardId: s.isoClause.standardId })
        .from(s.isoClause)
        .where(sql`${s.isoClause.id} = any(${uuids(clauseIds)})`)
        .catch(rethrow);
      for (const row of rows) clauseStandards.set(row.id, row.standardId);
    }
    const ofCovered = (ids: readonly string[]) =>
      ids.length === 0 || ids.some((id) => covered.includes(clauseStandards.get(id) ?? ''));
    const internal = internalAll.filter((x) => ofCovered(x.clauseIds));
    const auditIds = new Set([...internal, ...external].map((x) => x.id));
    const findings = findingsAll.filter(
      (x) => auditIds.has(x.internalAuditId ?? x.externalAuditId!) && ofCovered(x.clauseIds),
    );
    const reportSteps = await stepDays(
      g,
      'internal_audit',
      internal.filter((x) => x.reportedOn !== null),
      stepIs('REPORT'),
    );
    // RECORD_HELD sets `endOn`, and so does a later edit of the visit's dates.
    const heldSteps = await stepDays(
      g,
      'external_audit',
      external.filter((x) => VISITED.includes(x.state)),
      sql`(${stepIs('RECORD_HELD')} or ${updateNames('endOn')})`,
    );
    return {
      internalAudits: internal.map((x) => ({
        id: x.id,
        state: x.state,
        reportedOn: x.reportedOn,
        ...daysOf(g, x),
        reportStepOn: x.reportedOn === null ? null : reportSteps.get(x.id)!,
      })),
      externalAudits: external.map((x) => ({
        id: x.id,
        state: x.state,
        endOn: x.endOn,
        ...daysOf(g, x),
        heldStepOn: VISITED.includes(x.state) ? heldSteps.get(x.id)! : null,
      })),
      findings: findings.map((x) => ({
        id: x.id,
        auditId: (x.internalAuditId ?? x.externalAuditId)!,
        type: x.type,
        ...daysOf(g, x),
      })),
    };
  },

  async COMPLIANCE_EVALUATION(g) {
    const units = g.system.unitIds.length
      ? g.system.unitIds
      : (
          await g.tx
            .select({ id: s.unit.id })
            .from(s.unit)
            .where(and(eq(s.unit.clientId, g.clientId), isNull(s.unit.archivedAt)))
            .catch(rethrow)
        ).map((u) => u.id);
    const i = s.complianceInstance;
    const rows = units.length
      ? await g.tx
          .select({
            id: i.id,
            dueDate: i.dueDate,
            workflowState: i.workflowState,
            pendingKind: i.pendingKind,
            completedOn: i.completedOn,
            createdAt: i.createdAt,
            archivedAt: i.archivedAt,
            criticality: s.obligation.criticality,
            externalRef: s.obligation.externalRef,
            kind: s.act.kind,
          })
          .from(i)
          .innerJoin(s.assignment, eq(s.assignment.id, i.assignmentId))
          .innerJoin(s.obligation, eq(s.obligation.id, s.assignment.obligationId))
          .innerJoin(s.act, eq(s.act.id, s.obligation.actId))
          .where(and(eq(i.clientId, g.clientId), sql`${i.unitId} = any(${uuids(units)})`))
          .orderBy(asc(i.id))
          .catch(rethrow)
      : [];
    const days = (row: (typeof rows)[number]) =>
      daysOf(g, {
        createdAt: row.createdAt.toISOString(),
        archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
      });
    const standard = (row: (typeof rows)[number]) => (row.kind as ActKind) === 'STANDARD';
    const [firm] = await g.tx.select({ settings: s.firm.settings }).from(s.firm).catch(rethrow);
    if (!firm) throw new DbError('NOT_FOUND', 'Not found');
    return {
      evaluations: rows
        .filter((row) => standard(row) && row.externalRef === COMPLIANCE_EVALUATION_REF)
        .map((row) => ({
          id: row.id as Id,
          dueDate: row.dueDate as LocalDate,
          workflowState: row.workflowState,
          completedOn: row.completedOn as LocalDate | null,
          ...days(row),
        })),
      statutoryItems: rows
        .filter((row) => !standard(row))
        .map((row) => ({
          instanceId: row.id as Id,
          criticality: row.criticality,
          dueDate: row.dueDate as LocalDate,
          workflowState: row.workflowState,
          pendingKind: row.pendingKind,
          completedOn: row.completedOn as LocalDate | null,
          ...days(row),
        })),
      settings: FirmSettings.parse(firm.settings),
    };
  },
};

/** The STANDARD obligation whose instances are the compliance evaluations (catalogue §4, 9.1.2/9.1.3). */
const COMPLIANCE_EVALUATION_REF = 'ISO-COMPLIANCE-EVALUATION';

/** The input's standards: the review's standards whose definitions (among the system's standards) carry its key. */
async function inputCodes(
  tx: TenantTx,
  review: { standards: readonly IsoStandardCode[] },
  standards: Map<IsoStandardCode, string>,
  def: Pick<IsoReviewInputDef, 'key' | 'standardId'>,
): Promise<IsoStandardCode[]> {
  const ids = review.standards
    .map((code) => standards.get(code))
    .filter((id): id is string => id !== undefined);
  const d = s.isoReviewInputDef;
  const rows = ids.length
    ? await tx
        .select({ standardId: d.standardId })
        .from(d)
        .where(and(eq(d.key, def.key), isNull(d.archivedAt), inArray(d.standardId, ids)))
        .catch(rethrow)
    : [];
  const found = new Set(rows.map((r) => r.standardId));
  const codes = IsoStandardCode.options.filter((code) => found.has(standards.get(code) ?? ''));
  if (codes.length) return codes;
  // A row always has a definition among the review's standards; fall back to its own for a hand-seeded one.
  const [own] = await tx
    .select({ code: s.isoStandard.code })
    .from(s.isoStandard)
    .where(eq(s.isoStandard.id, def.standardId))
    .catch(rethrow);
  return own ? [own.code] : [];
}

/**
 * `since` (model §5.4): per standard of the input, the later of the system's creation day and the `heldOn` of the
 * last earlier held review covering it; the earliest of those, so the figures leave out nothing a standard has not been
 * reviewed on yet, and never after as-of.
 */
function sinceOf(g: Gather): LocalDate {
  const createdOn = g.localDay(g.system.createdAt);
  const last = g.codes.map((code) =>
    g.earlier
      .filter((r) => r.standards.includes(code))
      .reduce<LocalDate>((latest, r) => (r.heldOn! > latest ? r.heldOn! : latest), createdOn),
  );
  const since = [...last].sort()[0] as LocalDate | undefined;
  return since !== undefined && since < g.asOf ? since : g.asOf;
}

const GatherReview = z.object({
  id: Id,
  clientId: Id,
  managementSystemId: Id,
  standards: z.array(IsoStandardCode).min(1).max(3),
});
const GatherDef = z.object({ key: ReviewInputKey, source: ReviewInputSource, standardId: Id });

export const reviewFigures = {
  /**
   * `since` and `data` for one input row (model §5.4), as of `asOf`: today in the client's time zone for a PLANNED
   * review, its `heldOn` at RECORD_HELD. `localDay` places every timestamp on a client-local day (the engine's
   * `localDateIn` with the client's time zone, root rule 4). `since` comes from the system's creation day and the
   * other live HELD or CLOSED reviews of the system held on or before `asOf` that cover one of the input's standards.
   * `data` holds the system's records that the source reads, archived ones included, with no unit scope: risk items
   * of the kinds the key reads (`reviewRiskKinds`), findings and internal audits whose clauses' standards overlap the
   * input's, and the event and step days read from `audit_event` (model §8). MANUAL reads nothing.
   */
  async gather(
    tx: TenantTx,
    review: Pick<ManagementReview, 'id' | 'clientId' | 'managementSystemId' | 'standards'>,
    inputDef: Pick<IsoReviewInputDef, 'key' | 'source' | 'standardId'>,
    asOf: LocalDate,
    localDay: LocalDayOf,
  ): Promise<GatheredFigures> {
    const r = validate(GatherReview, review);
    const def = validate(GatherDef, inputDef);
    const day = validate(LocalDate, asOf) as LocalDate;
    const system = await managementSystems.require(tx, r.managementSystemId);
    if (system.clientId !== r.clientId) throw new DbError('NOT_FOUND', 'Not found');
    const standards = new Map<IsoStandardCode, string>();
    if (system.standardIds.length) {
      const rows = await tx
        .select({ id: s.isoStandard.id, code: s.isoStandard.code })
        .from(s.isoStandard)
        .where(inArray(s.isoStandard.id, system.standardIds))
        .catch(rethrow);
      for (const row of rows) standards.set(row.code, row.id);
    }
    const codes = await inputCodes(tx, r, standards, def);
    const m = s.managementReview;
    const earlier = codes.length
      ? await reviewRecord.all(
          tx,
          and(
            eq(m.clientId, r.clientId),
            eq(m.managementSystemId, system.id),
            ne(m.id, r.id),
            isNull(m.archivedAt),
            inArray(m.state, ['HELD', 'CLOSED']),
            sql`${m.heldOn} <= ${day}`,
            sql`${m.standards} && ${`{${codes.join(',')}}`}::iso_standard_code[]`,
          ),
        )
      : [];
    const g: Gather = {
      tx,
      clientId: r.clientId,
      system,
      standards,
      key: def.key,
      codes,
      asOf: day,
      localDay,
      earlier,
    };
    const since = sinceOf(g);
    if (def.source === 'MANUAL') return { source: 'MANUAL', since, data: {} };
    const source: FigureSource = def.source;
    const data = await (GATHER[source] as (g: Gather) => Promise<unknown>)(g);
    return { source, since, data } as GatheredFigures;
  },
};
