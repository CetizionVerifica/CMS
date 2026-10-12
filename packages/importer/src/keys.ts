import { looseKey } from './text.js';

/**
 * Natural keys of planned entities (ImportPlan keys and ExistingState entries). The API derives the same keys
 * from stored rows, so a re-import matches what an earlier commit created.
 */

export function companyKey(company: string): string {
  return looseKey(company);
}

export function unitKey(company: string, unit: string): string {
  return `${looseKey(company)}|${looseKey(unit)}`;
}

export function locationKey(loc: {
  countryCode: string;
  state: string | null;
  city: string | null;
}): string {
  return [loc.countryCode, loc.state ?? '', loc.city ?? ''].map((p) => p.toLowerCase()).join('|');
}

/** The key of an obligation with a source ID. Obligations without one are keyed per unit (act, title, unit). */
export function obligationRefKey(externalRef: string): string {
  return `ref:${externalRef}`;
}

export function obligationTitleKey(act: string, title: string, unit: string): string {
  return `act-title-unit:${looseKey(act)}|${looseKey(title)}|${unit}`;
}
