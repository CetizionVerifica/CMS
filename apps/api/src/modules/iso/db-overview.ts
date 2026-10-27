import {
  type Id,
  type IdCount,
  type IsoAction,
  type IsoOverview,
  type IsoStandardCode,
  type IsoSystemInput,
  type IsoSystemOverview,
  type LocalDate,
  type ManagementSystem,
} from '@canopy/contracts';
import {
  auditChecklistItems,
  auditProgrammes,
  certifications,
  clauseAssessments,
  contextItems,
  controlledDocuments,
  documentRevisions,
  externalAudits,
  internalAudits,
  isoActions,
  isoCatalogue,
  managementReviews,
  managementSystems,
  nonconformities,
  objectiveReadings,
  objectives,
  reviewInputs,
  riskItems,
  type TenantTx,
  type UnitScope,
} from '@canopy/db';
import {
  actionStatus,
  addDays,
  auditProgrammeCoverage,
  certificationCycle,
  certificationReadiness,
  clauseReadiness,
  climateDeterminationGaps,
  compareClauseNumbers,
  fyLabel,
  fyRangeOf,
  incidentCounts,
  localDateIn,
  managementReviewDue,
  nonconformityStatus,
  objectiveProgress,
  reviewDue,
} from '@canopy/engine';
import { authorize, holdsRole, listScope } from './access.js';
import type { Calendar, Core } from './db-context.js';
import { forbidden } from './errors.js';
import type { IsoHandlers } from './types.js';

/**
 * The ISO overview (docs/iso/model.md §5.1-5.2): per management system the actor can see, every engine result with the
 * ids behind each number. Counts list only the records the actor may read (plan §3.3), through the same scoped
 * repository reads as the lists; the readiness gates, the programme's uncovered lists and the cycle dates read every
 * record of the system, as the mock does. Every status, timing and score comes from `@canopy/engine` (root rule 3).
 */

type Ids = 'getIsoOverview';

/** Roles that may read the overview "as at" another date (api-conventions.md §1). */
const AS_OF_ROLES = ['FIRM_ADMIN', 'CONSULTANT', 'VIEWER'] as const;

const idCount = (ids: readonly Id[]): IdCount => {
  const unique = [...new Set(ids)];
  return { count: unique.length, ids: unique };
};

/** Every page of a repository list. */
async function allPages<T>(
  fetch: (page: { limit: number; cursor?: string }) => Promise<{
    items: T[];
    nextCursor: string | null;
  }>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await fetch({ limit: 200, ...(cursor === null ? {} : { cursor }) });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return out;
}

/**
 * Every row a list returns, and the ids of those the reader may read: the same list with the reader's unit scope, or
 * every row for a reader of the whole client.
 */
async function withSeen<T extends { id: string }>(
  scope: UnitScope | undefined,
  list: (scope: UnitScope | undefined) => Promise<T[]>,
): Promise<{ all: T[]; seen: Set<Id> }> {
  const all = await list(undefined);
  const seen = scope === undefined ? all : await list(scope);
  return { all, seen: new Set(seen.map((r) => r.id)) };
}

export function overviewHandlers(core: Core): IsoHandlers<Ids> {
  async function systemOverview(
    tx: TenantTx,
    system: ManagementSystem,
    scope: UnitScope | undefined,
    cal: Calendar,
    asOf: LocalDate,
  ): Promise<IsoSystemOverview> {
    const clientId = system.clientId;
    const systems = [system.id];
    const local = (instant: string) => localDateIn(instant, cal.timeZone);

    const standards = (await isoCatalogue.standards(tx)).filter((s) =>
      system.standardIds.includes(s.id),
    );
    const codeOf = new Map(standards.map((s) => [s.id, s.code]));
    const rank = (standardId: string) => system.standardIds.indexOf(standardId);
    // By the system's standards, then clause number, so `byStandard` follows `standardIds`.
    const clauses = (await isoCatalogue.clauses(tx, { standardIds: system.standardIds })).sort(
      (a, b) => rank(a.standardId) - rank(b.standardId) || compareClauseNumbers(a.number, b.number),
    );
    const assessments = await clauseAssessments.list(tx, system.id);
    const approvedNa = new Set(
      assessments.filter((a) => a.naState === 'APPROVED').map((a) => a.clauseId),
    );
    const context = await contextItems.list(tx, system.id);

    const ncs = await withSeen(scope, (sc) =>
      allPages((page) =>
        nonconformities.list(tx, clientId, { managementSystemIds: systems, scope: sc, ...page }),
      ),
    );
    const actions = await withSeen(scope, (sc) =>
      allPages((page) =>
        isoActions.list(tx, clientId, { managementSystemIds: systems, scope: sc, ...page }),
      ),
    );
    // ACTIVE documents only, the list's default (model §4.2).
    const documents = await withSeen(scope, (sc) =>
      allPages((page) =>
        controlledDocuments.list(tx, clientId, {
          managementSystemIds: systems,
          scope: sc,
          ...page,
        }),
      ),
    );
    const risks = await withSeen(scope, (sc) =>
      allPages((page) =>
        riskItems.list(tx, clientId, { managementSystemIds: systems, scope: sc, ...page }),
      ),
    );
    const objectiveRows = await withSeen(scope, (sc) =>
      allPages((page) =>
        objectives.list(tx, clientId, { managementSystemIds: systems, scope: sc, ...page }),
      ),
    );
    const audits = await withSeen(scope, (sc) =>
      allPages((page) =>
        internalAudits.list(tx, clientId, { managementSystemIds: systems, scope: sc, ...page }),
      ),
    );
    const certificates = await withSeen(scope, (sc) =>
      allPages((page) =>
        certifications.list(tx, clientId, { managementSystemIds: systems, scope: sc, ...page }),
      ),
    );
    const external = await allPages((page) =>
      externalAudits.list(tx, clientId, { managementSystemIds: systems, ...page }),
    );
    const reviews = await allPages((page) =>
      managementReviews.list(tx, clientId, { managementSystemIds: systems, ...page }),
    );
    const checklistItems = (
      await Promise.all(audits.all.map((a) => auditChecklistItems.forAudit(tx, a.id)))
    ).flat();

    const seen = <T extends { id: string }>(rows: { all: T[]; seen: Set<Id> }) =>
      rows.all.filter((r) => rows.seen.has(r.id));
    const ids = <T extends { id: string }>(rows: readonly T[]) => idCount(rows.map((r) => r.id));
    const overdue = (status: { timing: string }) => status.timing === 'OVERDUE';

    // Nonconformities: timing from the NC and its OPEN actions (model §5.2), whoever may read those actions.
    const actionsOf = new Map<Id, IsoAction[]>();
    for (const action of actions.all) {
      if (action.subject.type !== 'NONCONFORMITY') continue;
      actionsOf.set(action.subject.id, [...(actionsOf.get(action.subject.id) ?? []), action]);
    }
    const seenNcs = seen(ncs);
    const openNcs = seenNcs.filter((n) => n.state !== 'CLOSED' && n.state !== 'CANCELLED');
    const ncStatus = new Map(
      openNcs.map((n) => [n.id, nonconformityStatus(n, actionsOf.get(n.id) ?? [], asOf, cal)]),
    );

    const openActions = seen(actions).filter((a) => a.state === 'OPEN');

    const seenDocuments = seen(documents);
    const inReview: typeof seenDocuments = [];
    for (const doc of seenDocuments) {
      const revisions = await documentRevisions.forDocument(tx, doc.id);
      if (revisions.some((r) => r.state === 'IN_REVIEW')) inReview.push(doc);
    }

    const seenRisks = seen(risks);

    const openObjectives = seen(objectiveRows).filter((o) => o.closedOn === null);
    const offTrack: typeof openObjectives = [];
    for (const objective of openObjectives) {
      const readings = await objectiveReadings.forObjective(tx, objective.id);
      const progress = objectiveProgress(
        readings,
        { ...objective, createdOn: local(objective.createdAt) },
        asOf,
        cal,
      );
      if (progress.onTrack === false) offTrack.push(objective);
    }

    // The programme of the client's current FY: uncovered lists from every audit, counts from those seen.
    const fy = fyLabel(asOf, cal.fyStartMonth);
    const programme = (await auditProgrammes.list(tx, system.id)).find((p) => p.fy === fy);
    let auditProgramme: IsoSystemOverview['auditProgramme'] = null;
    if (programme !== undefined) {
      const ofProgramme = audits.all.filter((a) => a.programmeId === programme.id);
      const coverage = auditProgrammeCoverage(
        ofProgramme,
        checklistItems,
        system,
        clauses.map((c) => ({
          id: c.id,
          assessable: c.assessable,
          excluded: c.exclusionAllowed && approvedNa.has(c.id),
        })),
        fy,
      );
      const counts = auditProgrammeCoverage(
        ofProgramme.filter((a) => audits.seen.has(a.id)),
        [],
        system,
        [],
        fy,
      );
      auditProgramme = {
        ...coverage,
        planned: counts.planned,
        reported: counts.reported,
        cancelled: counts.cancelled,
      };
    }

    // A review's input row covers its key in every standard of the review that defines it (model §3.13).
    const defs = await isoCatalogue.reviewDefs(tx, { standardIds: system.standardIds });
    const defById = new Map(defs.inputs.map((d) => [d.id, d]));
    const standardsOfKey = new Map<string, IsoStandardCode[]>();
    for (const def of defs.inputs) {
      const code = codeOf.get(def.standardId);
      if (code === undefined) continue;
      standardsOfKey.set(def.key, [...(standardsOfKey.get(def.key) ?? []), code]);
    }
    const heldReviews = reviews.filter((r) => r.state === 'HELD' || r.state === 'CLOSED');
    const inputRows: Parameters<typeof certificationReadiness>[1]['reviewInputs'] = [];
    for (const review of heldReviews) {
      for (const row of await reviewInputs.forReview(tx, review.id)) {
        const def = defById.get(row.inputDefId);
        if (def === undefined) continue;
        for (const standard of standardsOfKey.get(def.key) ?? []) {
          if (!review.standards.includes(standard)) continue;
          inputRows.push({
            managementReviewId: review.id,
            notes: row.notes,
            key: def.key,
            standard,
          });
        }
      }
    }

    const createdOn = local(system.createdAt);
    const input: IsoSystemInput = {
      id: system.id,
      standardIds: system.standardIds,
      unitIds: system.unitIds,
      scopeStatement: system.scopeStatement,
      climateChangeRelevant: system.climateChangeRelevant,
      reviewIntervalMonths: system.reviewIntervalMonths,
      createdOn,
    };
    const fyRange = fyRangeOf(fy, cal.fyStartMonth);
    const expiryEnd = addDays(asOf, 90);

    return {
      managementSystemId: system.id,
      name: system.name,
      standardIds: [...system.standardIds],
      clauseReadiness: clauseReadiness(assessments, clauses),
      certificationReadiness: certificationReadiness(
        input,
        {
          standards,
          clauses,
          assessments,
          audits: audits.all,
          checklistItems,
          reviews,
          reviewInputs: inputRows,
          documents: documents.all,
          objectives: objectiveRows.all,
          objectiveActions: actions.all.filter((a) => a.subject.type === 'OBJECTIVE'),
          riskItems: risks.all,
        },
        asOf,
      ),
      climateGaps: climateDeterminationGaps(system, context, risks.all),
      nonconformities: {
        open: ids(openNcs),
        overdue: ids(openNcs.filter((n) => overdue(ncStatus.get(n.id)!))),
        awaitingVerification: ids(seenNcs.filter((n) => n.state === 'AWAITING_VERIFICATION')),
        effectivenessOverdue: ids(
          openNcs.filter((n) => ncStatus.get(n.id)!.effectivenessOverdueDays !== null),
        ),
      },
      actions: {
        open: ids(openActions),
        overdue: ids(openActions.filter((a) => overdue(actionStatus(a, asOf, cal)))),
      },
      documents: {
        inReview: ids(inReview),
        reviewOverdue: ids(
          seenDocuments.filter((d) => overdue(reviewDue(d.reviewDueOn, asOf, cal))),
        ),
      },
      risks: {
        significant: ids(seenRisks.filter((r) => r.significant)),
        reviewOverdue: ids(seenRisks.filter((r) => overdue(reviewDue(r.reviewDueOn, asOf, cal)))),
      },
      objectives: { open: ids(openObjectives), offTrack: ids(offTrack) },
      auditProgramme,
      managementReview: managementReviewDue(
        {
          createdOn,
          reviewIntervalMonths: system.reviewIntervalMonths,
          standards: system.standardIds.map((id) => codeOf.get(id)!).filter(Boolean),
        },
        reviews,
        asOf,
        cal,
      ),
      certificates: {
        expiringSoon: ids(
          seen(certificates).filter(
            (c) => c.expiresOn !== null && c.expiresOn >= asOf && c.expiresOn <= expiryEnd,
          ),
        ),
        cycleOverdue: ids(
          seen(certificates).filter((c) =>
            certificationCycle(c, external, asOf).items.some((item) => item.overdueDays !== null),
          ),
        ),
      },
      // Incidents of the client's current FY; cancelled NCs leave the count (model §5.1).
      incidents: incidentCounts(
        seenNcs.filter((n) => n.state !== 'CANCELLED'),
        fyRange,
        cal.timeZone,
      ),
    };
  }

  return {
    /** Every system the actor can see, by name then id; `asOf` only for FA, CO and VIEWER (api-conventions.md §1). */
    async getIsoOverview({ ctx, params, query }): Promise<IsoOverview> {
      const clientId = params.clientId!;
      authorize(ctx, 'isoSystem.read', { type: 'management_system', clientId });
      if (query.asOf !== undefined && !holdsRole(ctx, clientId, AS_OF_ROLES)) {
        forbidden('isoSystem.read', 'Only firm staff and viewers may set asOf');
      }
      return core.run(ctx, async (tx) => {
        const cal = await core.calendar(tx, clientId);
        const asOf = query.asOf ?? localDateIn(core.now(), cal.timeZone);
        const scope = listScope(ctx, clientId);
        const wanted = query.managementSystemId;
        const systems = (
          await allPages((page) => managementSystems.list(tx, clientId, { scope, ...page }))
        )
          .filter((s) => wanted === undefined || wanted.includes(s.id))
          .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
        const out: IsoSystemOverview[] = [];
        for (const system of systems) {
          out.push(await systemOverview(tx, system, scope, cal, asOf));
        }
        return { asOf, systems: out };
      });
    },
  };
}
