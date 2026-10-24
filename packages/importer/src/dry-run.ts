import type { DryRunReport, ImportRowOutcome } from '@canopy/contracts';
import { instanceAfterCommit, instanceChange, type InstanceChange } from './instances.js';
import type {
  AnalysedRow,
  ExistingState,
  ImportAnalysis,
  KnownName,
  PlanAssignment,
  PlanNamed,
  PlanObligation,
} from './types.js';

/**
 * Dry run (packages/importer/CLAUDE.md step 5): what a commit would create, update or leave unchanged,
 * compared with what the client already has. Nothing is written.
 */

export function fingerprintObligation(o: PlanObligation): string {
  return JSON.stringify([
    o.externalRef,
    o.domain,
    o.jurisdiction,
    o.stateCode,
    o.act,
    o.category,
    o.title,
    o.description,
    o.applicabilityText,
    o.criticality,
    o.timelineType,
    o.forms,
    o.logSheets,
  ]);
}

export function fingerprintAssignment(a: PlanAssignment): string {
  return JSON.stringify([a.department, a.defaultOwner, a.defaultApprover]);
}

export interface DryRun {
  report: DryRunReport;
  /** Rows with their outcome set (CREATE, UPDATE, UNCHANGED, SKIPPED or ERROR). */
  rows: AnalysedRow[];
  /** Instance key → what the commit does to it. */
  instanceOutcomes: Map<string, 'CREATE' | 'UPDATE' | 'UNCHANGED'>;
  /** Instance key → the change to an existing instance, for the UPDATE ones. */
  instanceChanges: Map<string, InstanceChange>;
}

function outcomeOf(existing: Record<string, string>, key: string, fingerprint: string) {
  if (!(key in existing)) return 'CREATE' as const;
  return existing[key] === fingerprint ? ('UNCHANGED' as const) : ('UPDATE' as const);
}

function newNames(planned: PlanNamed[], known: KnownName[]): number {
  const names = new Set(known.map((k) => k.name));
  return planned.filter((p) => !names.has(p.name)).length;
}

export function dryRun(analysis: ImportAnalysis, existing: ExistingState): DryRun {
  const { plan } = analysis;
  const count = (outcomes: string[], kind: string) => outcomes.filter((o) => o === kind).length;

  const obligationOutcomes = plan.obligations.map((o) =>
    outcomeOf(existing.obligations, o.key, fingerprintObligation(o)),
  );
  const assignmentOutcomes = plan.assignments.map((a) =>
    outcomeOf(existing.assignments, a.key, fingerprintAssignment(a)),
  );
  const instanceOutcomes = new Map<string, 'CREATE' | 'UPDATE' | 'UNCHANGED'>();
  const instanceChanges = new Map<string, InstanceChange>();
  for (const planned of plan.instances) {
    const stored = existing.instances[planned.key];
    const change = stored ? instanceChange(planned, stored) : null;
    if (change) instanceChanges.set(planned.key, change);
    instanceOutcomes.set(planned.key, !stored ? 'CREATE' : change ? 'UPDATE' : 'UNCHANGED');
  }
  const instanceList = [...instanceOutcomes.values()];

  const knownPeople = new Set(existing.people.map((p) => p.nameNormalized));
  const keptRow = new Set(plan.instances.map((i) => i.rowNumbers[0]));
  const rows = analysis.rows.map((row): AnalysedRow => {
    let outcome: ImportRowOutcome = row.outcome;
    if (outcome === 'PENDING' && row.instanceKey !== null && keptRow.has(row.rowNumber)) {
      outcome = instanceOutcomes.get(row.instanceKey) ?? 'PENDING';
    }
    return { ...row, outcome };
  });

  const report: DryRunReport = {
    create: {
      acts: newNames(plan.acts, existing.acts),
      categories: newNames(plan.categories, existing.categories),
      departments: newNames(plan.departments, existing.departments),
      people: plan.people.filter((p) => !knownPeople.has(p.nameNormalized)).length,
      obligations: count(obligationOutcomes, 'CREATE'),
      assignments: count(assignmentOutcomes, 'CREATE'),
      instances: count(instanceList, 'CREATE'),
      companies: plan.companies.filter((c) => !existing.companies.includes(c.key)).length,
      units: plan.units.filter((u) => !existing.units.includes(u.key)).length,
      locations: plan.locations.filter((l) => !existing.locations.includes(l.key)).length,
    },
    update: {
      obligations: count(obligationOutcomes, 'UPDATE'),
      assignments: count(assignmentOutcomes, 'UPDATE'),
      instances: count(instanceList, 'UPDATE'),
    },
    unchanged: { instances: count(instanceList, 'UNCHANGED') },
    skippedRows: rows.filter((r) => r.outcome === 'SKIPPED').length,
    blockingErrors: rows.filter((r) => r.outcome === 'ERROR').length,
  };
  return { report, rows, instanceOutcomes, instanceChanges };
}

function mergeNames(known: KnownName[], planned: PlanNamed[]): KnownName[] {
  const byName = new Map(known.map((k) => [k.name, { name: k.name, aliases: [...k.aliases] }]));
  for (const p of planned) {
    const entry = byName.get(p.name) ?? { name: p.name, aliases: [] };
    for (const alias of p.aliases) if (!entry.aliases.includes(alias)) entry.aliases.push(alias);
    byName.set(p.name, entry);
  }
  return [...byName.values()];
}

/**
 * The state a successful commit of `analysis` leaves behind: accepted aliases stored on the library rows,
 * every planned entity present. Used to prove re-import is idempotent before the database exists (M3).
 */
export function stateAfterCommit(analysis: ImportAnalysis, before: ExistingState): ExistingState {
  const { plan } = analysis;
  const people = new Map(before.people.map((p) => [p.nameNormalized, p]));
  for (const p of plan.people) if (!people.has(p.nameNormalized)) people.set(p.nameNormalized, p);
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return {
    acts: mergeNames(before.acts, plan.acts),
    categories: mergeNames(before.categories, plan.categories),
    departments: mergeNames(before.departments, plan.departments),
    people: [...people.values()],
    companies: union(
      before.companies,
      plan.companies.map((c) => c.key),
    ),
    units: union(
      before.units,
      plan.units.map((u) => u.key),
    ),
    locations: union(
      before.locations,
      plan.locations.map((l) => l.key),
    ),
    obligations: {
      ...before.obligations,
      ...Object.fromEntries(plan.obligations.map((o) => [o.key, fingerprintObligation(o)])),
    },
    assignments: {
      ...before.assignments,
      ...Object.fromEntries(plan.assignments.map((a) => [a.key, fingerprintAssignment(a)])),
    },
    instances: {
      ...before.instances,
      ...Object.fromEntries(
        plan.instances.map((i) => {
          return [i.key, instanceAfterCommit(i, before.instances[i.key])];
        }),
      ),
    },
  };
}
