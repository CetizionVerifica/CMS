import type { ImportPlan } from '@canopy/importer';
import type { MasterAct, MasterLibrary, MasterObligation } from './master.js';

/**
 * Builds a master library from an import plan (ADR M6-0002): the Acts, categories and obligations a consultant
 * would get by importing the same register into an empty account, with every unit, assignment, person and
 * instance left out. Rules stay exactly as the import infers them, so a low-confidence guess stays TO_REVIEW and
 * generates nothing until a consultant confirms it.
 */
export function masterFromPlan(
  plan: ImportPlan,
  version: number,
  options: {
    /** Act names to replace, for an "Act" cell that names one site's licence rather than the law. */
    actNames?: Readonly<Record<string, string>>;
    /** Obligation titles to replace, by external ID, for a title that is one site's licence number. */
    titles?: Readonly<Record<string, string>>;
  } = {},
): MasterLibrary {
  const rename = (name: string) => options.actNames?.[name] ?? name;
  const actKeys = keyed(plan.acts.map((a) => rename(a.name)));
  const categoryKeys = keyed(plan.categories.map((c) => c.name));
  const obligations = plan.obligations.map((o): MasterObligation => {
    /* v8 ignore next 3 */
    if (!o.recurrenceRule || !o.ruleStatus) {
      throw new Error(`Obligation ${o.externalRef ?? o.title} has no rule: plan an empty account`);
    }
    return {
      act: keyOf(actKeys, rename(o.act)),
      category: keyOf(categoryKeys, o.category),
      externalRef: o.externalRef,
      domain: o.domain,
      jurisdiction: o.jurisdiction,
      stateCode: o.stateCode,
      title: (o.externalRef !== null ? options.titles?.[o.externalRef] : undefined) ?? o.title,
      description: o.description,
      applicabilityText: o.applicabilityText,
      criticality: o.criticality,
      timelineType: o.timelineType,
      recurrenceRule: o.recurrenceRule,
      ruleStatus: o.ruleStatus,
      // As the import sets it: the consultant decides which obligations need evidence.
      evidenceRequired: false,
      forms: o.forms,
      logSheets: o.logSheets,
      // A register obligation serves no ISO clause; only the ISO catalogue sets clauses.
      clauseRefs: [],
    };
  });
  return {
    version,
    categories: plan.categories
      .map((c) => ({ key: keyOf(categoryKeys, c.name), name: c.name, aliases: [...c.aliases] }))
      .sort(byKey),
    acts: plan.acts
      .map((a): MasterAct => ({
        key: keyOf(actKeys, rename(a.name)),
        name: rename(a.name),
        shortName: null,
        jurisdiction: a.jurisdiction,
        stateCode: a.stateCode,
        aliases: [...a.aliases],
        // A register names laws; only the ISO catalogue copy makes a STANDARD act.
        kind: 'STATUTE',
      }))
      .sort(byKey),
    obligations: obligations.sort(
      (a, b) => compare(a.externalRef ?? '', b.externalRef ?? '') || compare(a.title, b.title),
    ),
  };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byKey = (a: { key: string }, b: { key: string }) => compare(a.key, b.key);

/** A readable key per name: lower-case words joined by hyphens, numbered when two names share one. */
export function keyed(names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const name of [...names].sort(compare)) {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80)
        .replace(/-$/, '') || 'item';
    let key = base;
    for (let n = 2; used.has(key); n += 1) key = `${base}-${n}`;
    used.add(key);
    out.set(name, key);
  }
  return out;
}

function keyOf(keys: Map<string, string>, name: string): string {
  const key = keys.get(name);
  if (key === undefined) throw new Error(`Master library: "${name}" is not in the plan`);
  return key;
}
