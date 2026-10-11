import { looseKey } from './text.js';

/**
 * Comparison keys for alias detection. Two spellings with the same key are proposed as one value
 * (ALIAS_* issues); nothing is merged until the user accepts the proposal.
 */

export type AliasField = 'act' | 'category' | 'department';

/** Drops a plural "s" from words longer than three letters ("Requirements" → "requirement"). */
function singular(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function singularKey(value: string): string {
  return looseKey(value).split(' ').map(singular).join(' ');
}

/**
 * Seed aliases from the requirements analysis (docs/requirements/excel-analysis.md §2), keyed by singularKey.
 * Accepted aliases are stored on the library rows, so later imports resolve them without an issue.
 */
const SEED: Record<'category' | 'department', Record<string, string>> = {
  department: {
    hr: 'human resource',
    ehs: 'environment health and safety',
    it: 'information technology',
  },
  category: {
    'statutory register and record': 'statutory record',
  },
};

/**
 * Act key: "the" and punctuation dropped, "&" and "read with" read as "and", and the year after "Rules" or
 * "Regulations" ignored (Petroleum Rules 2002/2003/2005 are one Act in the sample, docs/contracts/fixtures.md §3).
 */
export function actKey(value: string): string {
  const words = looseKey(value.replace(/&/g, ' and ').replace(/\bread with\b/gi, ' and '))
    .split(' ')
    .filter((word) => word !== 'the');
  const out: string[] = [];
  for (const word of words) {
    const previous = out[out.length - 1];
    if (/^\d{4}$/.test(word) && (previous === 'rules' || previous === 'regulations')) continue;
    out.push(word);
  }
  return out.join(' ');
}

/**
 * The principal Act inside an Act key: everything up to and including its first year
 * ("factories act 1948 and west bengal factories rules" → "factories act 1948"). Null without a year.
 */
export function principalActKey(key: string): string | null {
  const match = /^(.*?\b\d{4})\b/.exec(key);
  return match?.[1] ?? null;
}

export function aliasKey(field: AliasField, value: string): string {
  if (field === 'act') return actKey(value);
  const key = singularKey(value);
  return SEED[field][key] ?? key;
}
