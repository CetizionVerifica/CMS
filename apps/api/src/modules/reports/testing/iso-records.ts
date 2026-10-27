import { randomUUID } from 'node:crypto';
import {
  LocalDate,
  type Incident,
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
