import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CLIENT_SETTINGS, type EngineCalendar } from '@canopy/contracts';
import { asLocalDate, engine } from '@canopy/engine';
import {
  analyseImport,
  EMPTY_STATE,
  firstNonEmptySheet,
  readWorkbook,
  recommendedDecisions,
  stateAfterCommit,
  suggestMapping,
  type ExistingState,
  type ImportAnalysis,
  type SourceSheet,
} from '@canopy/importer';
import type { MemoryReportsStore, MemoryRow } from '../memory-store.js';

/**
 * Test data for M10: the sample register loaded through the importer (as the M8 commit stores it), and a
 * builder for hand-made rows. Not used by the server.
 */

export const CALENDAR: EngineCalendar = { fyStartMonth: 4, holidayPolicy: 'NONE' };

const SAMPLE = new URL(
  '../../../../../../packages/importer/fixtures/sample-register.xlsx',
  import.meta.url,
);

export async function readSheet(bytes: Uint8Array, fileName: string): Promise<SourceSheet> {
  const sheet = firstNonEmptySheet(await readWorkbook(bytes, fileName));
  if (sheet === null) throw new Error(`${fileName} has no data`);
  return sheet;
}

/** Analyses a register with the recommended decisions, as a consultant accepting every proposal would. */
export function analyseRecommended(sheet: SourceSheet, existing: ExistingState): ImportAnalysis {
  const input = {
    sheet,
    mapping: suggestMapping(sheet.headers),
    existing,
    inferRule: engine.inferRule,
    calendar: CALENDAR,
  };
  const pending = analyseImport(input);
  return analyseImport({ ...input, decisions: recommendedDecisions(pending.issues) });
}

export interface SampleClient {
  firmId: string;
  clientId: string;
  clientName: string;
  unitId: string;
  analysis: ImportAnalysis;
  /** What the client holds after the import commits. */
  state: ExistingState;
  rows: MemoryRow[];
}

/** The sample register imported into a new client of `firmId` and loaded into the store. */
export async function loadSample(store: MemoryReportsStore, firmId: string): Promise<SampleClient> {
  const bytes = new Uint8Array(await readFile(SAMPLE));
  const analysis = analyseRecommended(await readSheet(bytes, 'sample-register.xlsx'), EMPTY_STATE);
  const { plan } = analysis;
  const clientId = randomUUID();
  const clientName = 'Kestrel Metals Group';
  store.clientsById.set(clientId, {
    id: clientId,
    firmId,
    name: clientName,
    settings: DEFAULT_CLIENT_SETTINGS,
  });

  const ids = new Map<string, string>();
  const id = (key: string) => {
    const existing = ids.get(key);
    if (existing !== undefined) return existing;
    const made = randomUUID();
    ids.set(key, made);
    return made;
  };
  const byKey = <T extends { key: string }>(items: T[]) => new Map(items.map((i) => [i.key, i]));
  const assignments = byKey(plan.assignments);
  const obligations = byKey(plan.obligations);
  const units = byKey(plan.units);
  const companies = byKey(plan.companies);
  const locations = byKey(plan.locations);
  const people = new Map(plan.people.map((p) => [p.nameNormalized, p.displayName]));
  const need = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('Sample plan is inconsistent');
    return value;
  };

  for (const unit of plan.units) {
    const location = need(locations.get(unit.locationKey));
    store.units.set(id(`unit:${unit.key}`), {
      id: id(`unit:${unit.key}`),
      firmId,
      clientId,
      name: unit.name,
      companyName: need(companies.get(unit.companyKey)).name,
      locationLabel: [location.country, location.state, location.city]
        .filter((part) => part !== null)
        .join(' / '),
    });
  }

  const rows: MemoryRow[] = plan.instances.map((instance) => {
    const assignment = need(assignments.get(instance.assignmentKey));
    const obligation = need(obligations.get(assignment.obligationKey));
    const unit = need(units.get(assignment.unitKey));
    const location = need(locations.get(unit.locationKey));
    return {
      firmId,
      id: id(`instance:${instance.key}`),
      version: 1,
      obligationId: id(`obligation:${obligation.key}`),
      externalRef: obligation.externalRef,
      title: obligation.title,
      timelineType: obligation.timelineType,
      categoryId: id(`category:${obligation.category}`),
      categoryName: obligation.category,
      domain: obligation.domain,
      actId: id(`act:${obligation.act}`),
      actName: obligation.act,
      criticality: obligation.criticality,
      clientId,
      companyName: need(companies.get(unit.companyKey)).name,
      unitId: id(`unit:${unit.key}`),
      unitName: unit.name,
      locationLabel: [location.country, location.state, location.city]
        .filter((part) => part !== null)
        .join(' / '),
      departmentId: id(`department:${assignment.department}`),
      departmentName: assignment.department,
      ownerId: id(`person:${instance.owner}`),
      ownerName: need(people.get(instance.owner)),
      approverId: id(`person:${instance.approver}`),
      approverName: need(people.get(instance.approver)),
      periodStart: instance.dueDate,
      periodEnd: instance.dueDate,
      dueDate: instance.dueDate,
      completedOn: instance.completedOn,
      workflowState: instance.workflowState,
      pendingKind: null,
      evidenceCount: 0,
      commentCount: instance.comments.length,
      lastComment: instance.comments.at(-1) ?? null,
      formLabels: obligation.forms.map((t) => t.label),
      logSheetLabels: obligation.logSheets.map((t) => t.label),
      description: obligation.description,
      applicabilityText: obligation.applicabilityText,
      naReason: instance.naReason,
      firstComment: instance.comments[0] ?? null,
      comments: instance.comments,
    };
  });
  store.rows.push(...rows);
  return {
    firmId,
    clientId,
    clientName,
    unitId: need(rows[0]).unitId,
    analysis,
    state: stateAfterCommit(analysis, EMPTY_STATE),
    rows,
  };
}

let counter = 0;

/** A hand-made row; ids default to fresh UUIDs and names to readable placeholders. */
export function makeRow(
  overrides: Partial<MemoryRow> & Pick<MemoryRow, 'firmId' | 'clientId'>,
): MemoryRow {
  counter += 1;
  const n = counter;
  return {
    id: randomUUID(),
    version: 1,
    obligationId: randomUUID(),
    externalRef: `HRS-CL-001-0000-${String(n).padStart(5, '0')}`,
    title: `Obligation ${n}`,
    timelineType: 'TIME_BASED',
    categoryId: randomUUID(),
    categoryName: 'Statutory Payments',
    domain: 'HRS',
    actId: randomUUID(),
    actName: 'Factories Act, 1948',
    criticality: 'HIGH',
    companyName: 'Kestrel Aluminium',
    unitId: randomUUID(),
    unitName: 'Plant',
    locationLabel: 'India / West Bengal / Riverbend',
    departmentId: randomUUID(),
    departmentName: 'Safety',
    ownerId: randomUUID(),
    ownerName: 'Person Alpha',
    approverId: randomUUID(),
    approverName: 'Person Bravo',
    periodStart: asLocalDate('2026-04-01'),
    periodEnd: asLocalDate('2026-06-30'),
    dueDate: asLocalDate('2026-06-30'),
    completedOn: null,
    workflowState: 'OPEN',
    pendingKind: null,
    evidenceCount: 0,
    commentCount: 0,
    lastComment: null,
    formLabels: [],
    logSheetLabels: [],
    description: 'Keep the register up to date.',
    applicabilityText: null,
    naReason: null,
    firstComment: null,
    comments: [],
    ...overrides,
  };
}
