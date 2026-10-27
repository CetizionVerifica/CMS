import { randomUUID } from 'node:crypto';
import {
  FyLabel,
  LocalDate,
  type AuditChecklistItem,
  type AuditFinding,
  type AuditProgramme,
  type Incident,
  type InternalAudit,
  type IsoReviewInputDef,
  type IsoReviewOutputDef,
  type ManagementReview,
  type ReviewInput,
  type ReviewInputFigures,
  type ReviewInputSource,
  type IsoAction,
  type Nonconformity,
  type RiskControl,
  type RiskItem,
} from '@canopy/contracts';
import type { World } from '../../dashboard/testing/world.js';

/** Who the records belong to and name: a memory world, or a Postgres one's ids. */
export interface Cast {
  firmId: string;
  clientId: string;
  ownerId: string;
  approverId: string;
}

/**
 * ISO records for M10's export tests (docs/iso/model.md §3.5, §3.10-3.12), as M3 returns them, put in the memory
 * store of a test world. Two systems in Beta Group: "Plant system" on Plant, "Office system" on Head Office.
 */

const d = (value: string) => LocalDate.parse(value);
const STAMP = '2026-04-01T04:00:00.000Z';

function record(firmId: string, clientId: string, createdAt = STAMP) {
  return {
    id: randomUUID(),
    firmId,
    clientId,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    version: 1,
  };
}

export function ncRecord(
  world: Cast,
  fields: Partial<Nonconformity> & Pick<Nonconformity, 'number' | 'managementSystemId'>,
): Nonconformity {
  return {
    ...record(world.firmId, world.clientId),
    source: 'PROCESS',
    sourceInstanceId: null,
    raisedFromRiskItemId: null,
    severity: 'MINOR',
    standards: ['ISO_9001'],
    clauseIds: [],
    unitId: null,
    description: 'Calibration record missing',
    reportedById: world.approverId,
    reportedOn: d('2026-09-15'),
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
    ownerId: world.ownerId,
    approverId: world.approverId,
    dueOn: d('2026-11-30'),
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

export function incidentFields(fields: Partial<Incident> = {}): Incident {
  return {
    occurredAt: '2026-09-30T20:00:00.000Z',
    location: 'Casthouse bay 2',
    type: 'INJURY',
    outcome: 'LOST_TIME',
    personCategory: 'CONTRACT_WORKER',
    lostDays: 4,
    reportable: true,
    statutoryInstanceId: null,
    investigatorIds: [],
    workerParticipation: true,
    ...fields,
  };
}

export function riskRecord(
  world: Pick<Cast, 'firmId' | 'clientId' | 'ownerId'>,
  fields: Partial<RiskItem> & Pick<RiskItem, 'managementSystemId' | 'kind'>,
): RiskItem {
  return {
    ...record(world.firmId, world.clientId),
    unitId: null,
    activity: 'Casting',
    description: 'A late alloy delivery stops the line',
    impact: null,
    lifeCycleStages: [],
    controlType: null,
    routine: null,
    personsExposed: [],
    condition: null,
    assessedWith: null,
    likelihood: 3,
    severity: 3,
    residualLikelihood: null,
    residualSeverity: null,
    rating: 9,
    residualRating: null,
    significant: false,
    significantOverride: null,
    significanceReason: null,
    obligationIds: [],
    climateRelated: false,
    ownerId: world.ownerId,
    reviewDueOn: null,
    lastReviewedOn: null,
    ...fields,
  };
}

export function actionRecord(
  world: Pick<Cast, 'firmId' | 'clientId' | 'ownerId'>,
  subject: IsoAction['subject'],
  fields: Partial<IsoAction> = {},
): IsoAction {
  return {
    ...record(world.firmId, world.clientId),
    subject,
    text: 'Recalibrate the gauge',
    resources: null,
    ownerId: world.ownerId,
    dueOn: d('2026-11-15'),
    doneOn: null,
    state: 'OPEN',
    effectivenessNote: null,
    cancelReason: null,
    controlHierarchy: null,
    outputKey: null,
    ...fields,
  };
}

export function controlRecord(
  world: Pick<Cast, 'firmId' | 'clientId'>,
  riskItemId: string,
  fields: Partial<RiskControl> = {},
): RiskControl {
  return {
    ...record(world.firmId, world.clientId),
    riskItemId,
    text: 'Guard on the press',
    hierarchy: null,
    sourceActionId: null,
    ...fields,
  };
}

/** Adds the two systems, four NCs (one archived), four risk items (one archived) and their names to `world`. */
export function addIsoRecords(world: World) {
  const { store } = world;
  const plantSystem = randomUUID();
  const officeSystem = randomUUID();
  const investigatorId = randomUUID();
  const otherOwnerId = randomUUID();
  const clause87 = randomUUID();
  const obligationId = randomUUID();
  store.iso.systems.set(plantSystem, {
    firmId: world.firmId,
    clientId: world.clientId,
    unitIds: [world.unit1],
  });
  store.iso.systems.set(officeSystem, {
    firmId: world.firmId,
    clientId: world.clientId,
    unitIds: [world.unit2],
  });
  const names = store.iso.names;
  names.systems.set(plantSystem, 'Plant system');
  names.systems.set(officeSystem, 'Office system');
  names.units.set(world.unit1, 'Plant');
  names.units.set(world.unit2, 'Head Office');
  names.people.set(world.ownerId, 'Person Owner');
  names.people.set(world.approverId, 'Person Approver');
  names.people.set(otherOwnerId, 'Office Owner');
  names.clauses.set(clause87, 'ISO 9001 8.7');
  names.obligations.set(obligationId, 'Report an accident');

  const ncs = {
    gauge: ncRecord(world, {
      number: 1,
      managementSystemId: plantSystem,
      unitId: world.unit1,
      clauseIds: [clause87],
      dueOn: d('2026-10-01'),
      rootCauseMethod: 'FIVE_WHYS',
      rootCause: 'No calibration schedule',
      state: 'ROOT_CAUSE_FOUND',
    }),
    complaint: ncRecord(world, {
      number: 2,
      managementSystemId: officeSystem,
      unitId: world.unit2,
      source: 'COMPLAINT',
      severity: 'MAJOR',
      description: 'Customer received the wrong grade',
      reportedOn: d('2026-08-01'),
      dueOn: d('2026-08-15'),
      ownerId: otherOwnerId,
      disposition: 'RETURN_OR_SUSPENSION',
      dispositionAuthorisedById: world.approverId,
      effective: true,
      closedOn: d('2026-08-20'),
      state: 'CLOSED',
    }),
    incident: ncRecord(world, {
      number: 3,
      managementSystemId: officeSystem,
      unitId: world.unit2,
      source: 'INCIDENT',
      standards: ['ISO_45001'],
      description: 'Hand caught in a roller',
      reportedOn: d('2026-10-01'),
      ownerId: otherOwnerId,
      incident: incidentFields({ investigatorIds: [investigatorId] }),
    }),
    archived: {
      ...ncRecord(world, { number: 4, managementSystemId: plantSystem, unitId: world.unit1 }),
      archivedAt: '2026-09-01T00:00:00.000Z',
    },
  };
  store.iso.nonconformities.push(...Object.values(ncs));

  const risks = {
    aspect: riskRecord(world, {
      managementSystemId: plantSystem,
      kind: 'ASPECT',
      unitId: world.unit1,
      activity: 'Degreasing',
      description: 'Solvent vapour',
      impact: 'Air emissions',
      lifeCycleStages: ['PRODUCTION', 'END_OF_LIFE'],
      controlType: 'CONTROL',
      condition: 'NORMAL',
      likelihood: 4,
      severity: 4,
      rating: 16,
      significant: true,
      climateRelated: true,
      reviewDueOn: d('2026-10-10'),
      createdAt: '2026-04-02T04:00:00.000Z',
    }),
    hazard: riskRecord(world, {
      managementSystemId: officeSystem,
      kind: 'HAZARD',
      unitId: world.unit2,
      activity: 'Roller line',
      description: 'Trapped hand',
      impact: 'Crush injury',
      routine: true,
      personsExposed: ['WORKER', 'CONTRACTOR'],
      condition: 'ABNORMAL',
      assessedWith: 'Line crew',
      likelihood: 2,
      severity: 3,
      rating: 6,
      residualLikelihood: 1,
      residualSeverity: 3,
      residualRating: 3,
      significant: true,
      obligationIds: [obligationId],
      ownerId: otherOwnerId,
      createdAt: '2026-04-03T04:00:00.000Z',
    }),
    risk: riskRecord(world, {
      managementSystemId: plantSystem,
      kind: 'RISK',
      significantOverride: false,
      significanceReason: 'Second supplier qualified',
      lastReviewedOn: d('2026-09-01'),
      reviewDueOn: d('2027-03-01'),
      createdAt: '2026-04-01T04:00:00.000Z',
    }),
    archived: {
      ...riskRecord(world, { managementSystemId: plantSystem, kind: 'OPPORTUNITY', rating: 20 }),
      archivedAt: '2026-09-30T20:00:00.000Z',
    },
  };
  store.iso.riskItems.push(...Object.values(risks));

  const subject = (type: IsoAction['subject']['type'], id: string) => ({ type, id });
  store.iso.actions.push(
    actionRecord(world, subject('NONCONFORMITY', ncs.gauge.id), {
      state: 'DONE',
      doneOn: d('2026-09-20'),
      dueOn: d('2026-09-01'),
    }),
    actionRecord(world, subject('NONCONFORMITY', ncs.incident.id), { dueOn: d('2026-10-05') }),
    actionRecord(world, subject('RISK_ITEM', risks.hazard.id), {
      text: 'Fit a light curtain',
      controlHierarchy: 'ENGINEERING',
    }),
  );
  store.iso.controls.push(
    controlRecord(world, risks.aspect.id, { text: 'Extraction hood' }),
    controlRecord(world, risks.hazard.id, { text: 'Two-hand start', hierarchy: 'ENGINEERING' }),
    controlRecord(world, risks.hazard.id, { text: 'Gloves', hierarchy: 'PPE' }),
  );
  return { plantSystem, officeSystem, otherOwnerId, investigatorId, clause87, ncs, risks };
}

export function auditRecord(
  world: Pick<Cast, 'firmId' | 'clientId'>,
  fields: Partial<InternalAudit> & Pick<InternalAudit, 'programmeId' | 'leadAuditorId'>,
): InternalAudit {
  return {
    ...record(world.firmId, world.clientId),
    title: 'Casthouse process audit',
    plannedStart: d('2026-09-08'),
    plannedEnd: d('2026-09-09'),
    clauseIds: [],
    unitIds: [],
    auditorIds: [],
    auditeeIds: [],
    reportedToIds: [],
    independenceNote: null,
    state: 'PLANNED',
    summary: null,
    reportedOn: null,
    cancelReason: null,
    ...fields,
  };
}

/**
 * Adds to `world` (after `addIsoRecords`) the FY 2026-27 programmes of both systems and their internal audits: a
 * reported audit of Plant with a checklist, two findings (one raised NC 1) and an improvement action; a planned audit
 * of the office system's units where the lead auditor is also an auditee; and an archived audit.
 */
export function addIsoAudits(world: World, records: ReturnType<typeof addIsoRecords>) {
  const { store } = world;
  const leadId = randomUUID();
  const auditorId = randomUUID();
  const officeLeadId = randomUUID();
  const names = store.iso.names;
  names.people.set(leadId, 'Lead Auditor');
  names.people.set(auditorId, 'Second Auditor');
  names.people.set(officeLeadId, 'Office Lead');
  const programme = (managementSystemId: string): AuditProgramme => ({
    ...record(world.firmId, world.clientId),
    managementSystemId,
    fy: FyLabel.parse('2026-27'),
    notes: null,
  });
  const plantProgramme = programme(records.plantSystem);
  const officeProgramme = programme(records.officeSystem);
  store.iso.programmes.push(plantProgramme, officeProgramme);

  const reported = auditRecord(world, {
    programmeId: plantProgramme.id,
    leadAuditorId: leadId,
    auditorIds: [auditorId],
    auditeeIds: [world.ownerId],
    reportedToIds: [world.approverId],
    unitIds: [world.unit1],
    clauseIds: [records.clause87],
    state: 'REPORTED',
    summary: 'Calibration control is weak; housekeeping is good.',
    reportedOn: d('2026-09-12'),
  });
  const planned = auditRecord(world, {
    programmeId: officeProgramme.id,
    title: 'Office safety audit',
    plannedStart: d('2026-11-03'),
    plannedEnd: d('2026-11-03'),
    leadAuditorId: officeLeadId,
    auditeeIds: [officeLeadId],
    independenceNote: 'The lead audits the office they run; the plant manager reviews the report.',
  });
  const archived = {
    ...auditRecord(world, { programmeId: plantProgramme.id, leadAuditorId: leadId }),
    archivedAt: '2026-09-30T20:00:00.000Z',
  };
  store.iso.audits.push(reported, planned, archived);

  const finding = (fields: Partial<AuditFinding> & Pick<AuditFinding, 'type'>): AuditFinding => ({
    ...record(world.firmId, world.clientId),
    internalAuditId: reported.id,
    externalAuditId: null,
    clauseIds: [records.clause87],
    unitId: world.unit1,
    description: 'Gauge 14 out of calibration',
    nonconformityId: null,
    ...fields,
  });
  const findings = {
    nc: finding({ type: 'MINOR_NC', nonconformityId: records.ncs.gauge.id }),
    ofi: finding({ type: 'OFI', description: 'Label the scrap bins', unitId: null }),
  };
  store.iso.findings.push(...Object.values(findings));

  const row = (fields: Partial<AuditChecklistItem>): AuditChecklistItem => ({
    ...record(world.firmId, world.clientId),
    internalAuditId: reported.id,
    clauseId: records.clause87,
    unitId: world.unit1,
    question: 'Are gauges calibrated on schedule?',
    auditorNote: null,
    result: null,
    findingId: null,
    notAuditedReason: null,
    ...fields,
  });
  store.iso.checklist.push(
    row({ result: 'FINDING', findingId: findings.nc.id, auditorNote: 'Gauge 14 overdue' }),
    row({ question: 'Is scrap segregated?', result: 'CONFORMS' }),
    row({
      question: 'Is the furnace log kept?',
      result: 'NOT_AUDITED',
      notAuditedReason: 'Furnace down for relining',
    }),
  );
  store.iso.actions.push(
    actionRecord(world, { type: 'AUDIT_FINDING', id: findings.ofi.id }, { text: 'Buy bin labels' }),
  );
  return { leadId, auditorId, officeLeadId, reported, planned, archived, findings };
}

export function reviewRecord(
  world: Pick<Cast, 'firmId' | 'clientId'>,
  fields: Partial<ManagementReview> &
    Pick<ManagementReview, 'managementSystemId' | 'chairId' | 'state'>,
): ManagementReview {
  return {
    ...record(world.firmId, world.clientId),
    standards: ['ISO_9001'],
    plannedOn: d('2026-09-30'),
    heldOn: null,
    attendeeIds: [],
    minutes: null,
    cancelReason: null,
    ...fields,
  };
}

/**
 * Adds management reviews to `world` (after `addIsoRecords`): a "Site system" on both units, held on 2026-09-30 with
 * stored figures (NCs 1 and 2, the incident NC 3 at Head Office), a MANUAL input, an output and an action; a planned
 * review of the office system whose figures stand in for the computed ones; a closed review held before set-up; and a
 * cancelled one. NC 1 is at Plant; NCs 2 and 3 at Head Office, NC 3 naming its investigator.
 */
export function addIsoReviews(world: World, records: ReturnType<typeof addIsoRecords>) {
  const { store } = world;
  const siteSystem = randomUUID();
  const chairId = world.approverId;
  const attendeeId = randomUUID();
  store.iso.systems.set(siteSystem, {
    firmId: world.firmId,
    clientId: world.clientId,
    unitIds: [world.unit1, world.unit2],
  });
  store.iso.names.systems.set(siteSystem, 'Site system');
  store.iso.names.people.set(attendeeId, 'Review Attendee');
  const standardId = randomUUID();
  const base = () => ({
    id: randomUUID(),
    firmId: world.firmId,
    createdAt: STAMP,
    updatedAt: STAMP,
    archivedAt: null,
  });
  const inputDef = (
    key: IsoReviewInputDef['key'],
    source: ReviewInputSource,
    title: string,
  ): IsoReviewInputDef => ({
    ...base(),
    standardId,
    key,
    clauseNumber: '9.3.2',
    item: 'c',
    title,
    source,
  });
  const defs = {
    ncs: inputDef('NONCONFORMITIES', 'NONCONFORMITIES', 'Nonconformities and corrective actions'),
    incidents: inputDef('INCIDENTS', 'INCIDENTS', 'Incidents'),
    customers: inputDef('CUSTOMER_SATISFACTION', 'MANUAL', 'Customer satisfaction'),
  };
  const outputDef: IsoReviewOutputDef = {
    ...base(),
    standardId,
    key: 'IMPROVEMENT',
    clauseNumber: '9.3.3',
    item: null,
    title: 'Opportunities for improvement',
  };
  const ncs = records.ncs;
  const refs: [Nonconformity, string[]][] = [
    [ncs.gauge, []],
    [ncs.complaint, []],
    [ncs.incident, [records.investigatorId]],
  ];
  for (const [nc, named] of refs) {
    store.iso.references.set(nc.id, {
      clientId: world.clientId,
      table: 'nonconformity',
      label: `NC ${nc.number}`,
      managementSystemId: nc.managementSystemId,
      unitId: nc.unitId,
      named,
    });
  }
  const figures = (
    source: ReviewInputFigures['source'],
    list: ReviewInputFigures['figures'],
    since = '2026-04-01',
    asOf = '2026-09-30',
  ): ReviewInputFigures => ({ source, since: d(since), asOf: d(asOf), figures: list });
  const stored = {
    ncs: figures('NONCONFORMITIES', [
      { key: 'raised', value: 2, ids: [ncs.gauge.id, ncs.complaint.id] },
      { key: 'open', value: 1, ids: [ncs.gauge.id] },
    ]),
    incidents: figures('INCIDENTS', [
      { key: 'incidents', value: 1, ids: [ncs.incident.id] },
      { key: 'lostDays', value: 4, ids: [ncs.incident.id] },
    ]),
  };

  const review = (fields: Parameters<typeof reviewRecord>[1]) => {
    const made = reviewRecord(world, fields);
    store.iso.reviews.push(made);
    return made;
  };
  const input = (
    reviewId: string,
    def: IsoReviewInputDef,
    fields: Partial<ReviewInput> = {},
    computed: ReviewInputFigures | null = null,
  ) => {
    const row: ReviewInput = {
      ...record(world.firmId, world.clientId),
      managementReviewId: reviewId,
      inputDefId: def.id,
      notes: null,
      sourceFigures: null,
      figuresStoredAt: null,
      figuresEngineVersion: null,
      ...fields,
    };
    store.iso.reviewInputs.push({ row, def, clause: 'ISO 9001 9.3.2 c', computed });
  };
  const storedAt = { figuresStoredAt: '2026-09-30T12:30:00.000Z', figuresEngineVersion: '1.2.0' };

  const held = review({
    managementSystemId: siteSystem,
    chairId,
    attendeeIds: [attendeeId],
    standards: ['ISO_9001', 'ISO_45001'],
    state: 'HELD',
    heldOn: d('2026-09-30'),
    minutes: 'Reviewed the year; guarding needs money.',
  });
  input(held.id, defs.ncs, { notes: 'Two raised', sourceFigures: stored.ncs, ...storedAt });
  input(held.id, defs.incidents, {
    notes: 'One lost-time injury on the roller line',
    sourceFigures: stored.incidents,
    ...storedAt,
  });
  input(held.id, defs.customers, { notes: 'Survey score 4.2 of 5' });
  store.iso.reviewOutputs.push({
    row: {
      ...record(world.firmId, world.clientId),
      managementReviewId: held.id,
      outputDefId: outputDef.id,
      decision: 'Fit guards on every roller',
    },
    def: outputDef,
    clause: 'ISO 9001 9.3.3',
  });
  store.iso.actions.push(
    actionRecord(
      world,
      { type: 'MANAGEMENT_REVIEW', id: held.id },
      {
        text: 'Buy two light curtains',
        outputKey: 'IMPROVEMENT',
      },
    ),
  );

  const planned = review({
    managementSystemId: records.officeSystem,
    chairId,
    state: 'PLANNED',
    plannedOn: d('2027-03-15'),
  });
  input(
    planned.id,
    defs.ncs,
    {},
    figures(
      'NONCONFORMITIES',
      [{ key: 'raised', value: 1, ids: [ncs.complaint.id] }],
      '2026-09-30',
      '2026-10-12',
    ),
  );

  const beforeSetUp = review({
    managementSystemId: siteSystem,
    chairId,
    state: 'CLOSED',
    heldOn: d('2026-03-01'),
    plannedOn: d('2026-03-01'),
  });
  input(beforeSetUp.id, defs.ncs, { notes: 'From the paper register' });

  const cancelled = review({
    managementSystemId: siteSystem,
    chairId,
    state: 'CANCELLED',
    cancelReason: 'Merged into the March review',
  });
  input(cancelled.id, defs.incidents, {}, stored.incidents);

  return { siteSystem, chairId, attendeeId, held, planned, beforeSetUp, cancelled, stored };
}
