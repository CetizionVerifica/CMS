import {
  DEFAULT_CLIENT_SETTINGS,
  LocalDate,
  type AuditFinding,
  type InternalAudit,
  type IsoAction,
  type ManagementReview,
  type Nonconformity,
  type RiskItem,
} from '@canopy/contracts';
import {
  acts,
  auditFindings,
  auditProgrammes,
  categories,
  clients,
  companies,
  internalAudits,
  isoActions,
  locations,
  managementReviews,
  managementSystems,
  nonconformities,
  obligations,
  riskItems,
  units,
} from '@canopy/db';
import type { Harness } from './fixture.js';

/**
 * Records the ISO-8b routes act on but do not create (ISO-8c serves nonconformities, audits and reviews), written as
 * the firm's system context with M3's repositories: obligations to link, nonconformities, internal audit findings,
 * management reviews, and another client's risk item for the `ids` tests. Fictional names only.
 */

const day = (d: string) => LocalDate.parse(d);

type New<T> = Omit<T, 'id' | 'firmId' | 'version' | 'createdAt' | 'updatedAt' | 'archivedAt'>;

/** A statutory obligation (or an activity of a STANDARD act), optionally archived. */
export async function seedObligation(
  h: Harness,
  options: { standard?: boolean; archived?: boolean } = {},
): Promise<string> {
  return h.asSystem(async (tx) => {
    const act = await acts.create(tx, {
      name: `${options.standard ? 'ISO 14001' : 'Kestrel Factories Rules'} ${Math.random().toString(36).slice(2, 8)}`,
      shortName: null,
      jurisdiction: 'CENTRAL',
      stateCode: null,
      aliases: [],
      ...(options.standard ? { kind: 'STANDARD' as const } : {}),
    });
    const category = await categories.create(tx, {
      name: `Safety ${Math.random().toString(36).slice(2, 8)}`,
      aliases: [],
    });
    const obligation = await obligations.create(tx, {
      externalRef: null,
      domain: 'EHS',
      jurisdiction: 'CENTRAL',
      stateCode: null,
      actId: act.id,
      categoryId: category.id,
      title: 'Report an accident',
      description: 'Send the accident notice.',
      applicabilityText: null,
      criticality: 'HIGH',
      timelineType: 'TIME_BASED',
      recurrenceRule: { kind: 'ONE_TIME', dueDate: day('2026-12-31') },
      ruleStatus: 'CONFIRMED',
      evidenceRequired: false,
      forms: [],
      logSheets: [],
      libraryVersion: 1,
    });
    if (options.archived) await obligations.archive(tx, obligation.id, obligation.version);
    return obligation.id;
  });
}

/** A nonconformity on `systemId`, owned by the unit A owner and approved by the all-units approver. */
function ncInput(
  h: Harness,
  systemId: string,
  fields: Partial<New<Nonconformity>> = {},
): Parameters<typeof nonconformities.create>[1] {
  return {
    clientId: h.f.clientId,
    managementSystemId: systemId,
    source: 'PROCESS',
    sourceInstanceId: null,
    raisedFromRiskItemId: null,
    severity: 'MINOR',
    standards: ['ISO_9001'],
    clauseIds: [],
    unitId: null,
    description: 'Calibration record missing',
    reportedById: h.f.people.approver,
    reportedOn: day('2026-10-12'),
    containment: null,
    correction: null,
    disposition: null,
    dispositionAuthorisedById: null,
    rootCauseMethod: null,
    rootCause: null,
    similarOccurrences: null,
    relatedRiskItemIds: [],
    updatedRiskItemIds: [],
    riskReview: null,
    systemChange: null,
    changedDocumentIds: [],
    noActionReason: null,
    ownerId: h.f.people.owner,
    approverId: h.f.people.approver,
    dueOn: day('2026-12-15'),
    effectivenessDueOn: null,
    effectivenessNote: null,
    effective: null,
    closedOn: null,
    cancelReason: null,
    state: 'OPEN',
    incident: null,
    ...fields,
  };
}

export function seedNc(
  h: Harness,
  systemId: string,
  fields: Partial<New<Nonconformity>> = {},
): Promise<Nonconformity> {
  return h.asSystem((tx) => nonconformities.create(tx, ncInput(h, systemId, fields)));
}

/** Closes or cancels a seeded nonconformity with the fields that state needs (as ISO-8c's arrows will). */
export async function setNcState(
  h: Harness,
  nc: Nonconformity,
  state: 'CLOSED' | 'CANCELLED',
): Promise<void> {
  const fields =
    state === 'CLOSED'
      ? {
          containment: 'Quarantined the batch',
          correction: 'Recalibrated',
          rootCauseMethod: 'FIVE_WHYS' as const,
          rootCause: 'No calibration schedule',
          similarOccurrences: 'None found',
          riskReview: 'No change',
          systemChange: 'None',
          closedOn: day('2026-10-20'),
          effective: true,
          effectivenessNote: 'No repeat',
        }
      : { cancelReason: 'Raised twice' };
  await h.asSystem((tx) => nonconformities.update(tx, nc.id, nc.version, { state, ...fields }));
}

let fyCount = 0;

/** An internal audit on `systemId` led by the client admin, in `state`, with one finding of `type`. */
export async function seedFinding(
  h: Harness,
  systemId: string,
  type: AuditFinding['type'],
  state: InternalAudit['state'] = 'IN_PROGRESS',
): Promise<{ finding: AuditFinding; auditId: string }> {
  return h.asSystem(async (tx) => {
    // One programme per system and FY: a fresh FY each time.
    const start = 2030 + (fyCount++ % 60);
    const fy = `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
    const programme = await auditProgrammes.create(tx, {
      clientId: h.f.clientId,
      managementSystemId: systemId,
      fy,
      notes: null,
    });
    const audit = await internalAudits.create(tx, {
      clientId: h.f.clientId,
      programmeId: programme.id,
      title: 'Stonebridge audit',
      plannedStart: day('2026-10-12'),
      plannedEnd: day('2026-10-13'),
      clauseIds: [h.f.clauses['9001:4.1']!],
      unitIds: [],
      leadAuditorId: h.f.people.clientAdmin,
      auditorIds: [],
      auditeeIds: [],
      reportedToIds: [],
      independenceNote: null,
      state,
      summary: null,
      reportedOn: null,
      cancelReason: null,
    });
    const finding = await auditFindings.create(tx, {
      clientId: h.f.clientId,
      internalAuditId: audit.id,
      externalAuditId: null,
      type,
      clauseIds: [],
      unitId: null,
      description: 'Labels faded',
      nonconformityId: null,
      // A MAJOR_NC or MINOR_NC finding is raised with its nonconformity.
      ...(type === 'MAJOR_NC' || type === 'MINOR_NC'
        ? {
            nonconformityId: (
              await nonconformities.create(tx, ncInput(h, systemId, { source: 'INTERNAL_AUDIT' }))
            ).id,
          }
        : {}),
    });
    return { finding, auditId: audit.id };
  });
}

/** Reports and closes a seeded internal audit (as ISO-8c's arrows will). */
export async function closeAudit(h: Harness, auditId: string): Promise<void> {
  await h.asSystem(async (tx) => {
    const audit = await internalAudits.require(tx, auditId);
    await internalAudits.update(tx, audit.id, audit.version, {
      state: 'CLOSED',
      reportedOn: day('2026-10-19'),
      summary: 'Two opportunities for improvement',
      reportedToIds: [h.f.people.clientAdmin],
    });
  });
}

/** A management review of `systemId` chaired by the client admin. */
export async function seedReview(
  h: Harness,
  systemId: string,
  fields: Partial<New<ManagementReview>> = {},
): Promise<ManagementReview> {
  return h.asSystem((tx) =>
    managementReviews.create(tx, {
      clientId: h.f.clientId,
      managementSystemId: systemId,
      standards: ['ISO_9001'],
      plannedOn: day('2026-11-15'),
      heldOn: null,
      chairId: h.f.people.clientAdmin,
      attendeeIds: [],
      minutes: null,
      state: 'PLANNED',
      cancelReason: null,
      ...fields,
    }),
  );
}

/** An action written straight to the store (a state the routes reach only through other steps). */
export async function seedAction(
  h: Harness,
  subject: IsoAction['subject'],
  fields: Partial<New<IsoAction>> = {},
): Promise<IsoAction> {
  return h.asSystem((tx) =>
    isoActions.create(tx, {
      clientId: h.f.clientId,
      subject,
      text: 'Qualify a second carton supplier',
      resources: null,
      ownerId: h.f.people.owner,
      dueOn: day('2026-11-30'),
      doneOn: null,
      state: 'OPEN',
      effectivenessNote: null,
      cancelReason: null,
      controlHierarchy: null,
      outputKey: null,
      ...fields,
    }),
  );
}

const others = new WeakMap<Harness, Promise<RiskItem>>();

/** A second client of the firm with its own system and one risk item: what `ids` must never reach. One per harness. */
export function seedOtherClientRisk(h: Harness): Promise<RiskItem> {
  if (!others.has(h)) others.set(h, otherClientRisk(h));
  return others.get(h)!;
}

async function otherClientRisk(h: Harness): Promise<RiskItem> {
  return h.asSystem(async (tx) => {
    const location = await locations.create(tx, {
      country: 'India',
      countryCode: 'IN',
      state: 'Odisha',
      stateCode: 'OD',
      city: 'Kestrelganj',
    });
    const client = await clients.create(tx, {
      name: 'Osprey Textiles Group',
      settings: DEFAULT_CLIENT_SETTINGS,
    });
    const company = await companies.create(tx, { clientId: client.id, name: 'Osprey Textiles' });
    const unit = await units.create(tx, {
      clientId: client.id,
      companyId: company.id,
      name: 'Kestrelganj mill',
      locationId: location.id,
    });
    const system = await managementSystems.create(tx, {
      clientId: client.id,
      name: 'Osprey system',
      standardIds: [h.f.std9001],
      unitIds: [unit.id],
      scopeStatement: null,
      status: 'PLANNING',
      reviewIntervalMonths: 12,
      climateChangeRelevant: null,
      climateChangeRationale: null,
      climateDecidedOn: null,
    });
    return riskItems.create(tx, {
      clientId: client.id,
      managementSystemId: system.id,
      kind: 'RISK',
      unitId: null,
      activity: 'Dye supply',
      description: 'One dye supplier',
      impact: null,
      lifeCycleStages: [],
      controlType: null,
      routine: null,
      personsExposed: [],
      condition: null,
      assessedWith: null,
      likelihood: 2,
      severity: 2,
      residualLikelihood: null,
      residualSeverity: null,
      rating: 4,
      residualRating: null,
      significant: false,
      significantOverride: null,
      significanceReason: null,
      obligationIds: [],
      climateRelated: false,
      ownerId: h.f.people.clientAdmin,
      lastReviewedOn: null,
      reviewDueOn: null,
    });
  });
}
