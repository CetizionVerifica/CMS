import { createHash } from 'node:crypto';

/** Text helpers for cleaning imported values. Nothing here touches dates or compliance rules. */

/** Trims and collapses runs of whitespace (including line breaks) to one space. */
export function collapse(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Trims each line and drops trailing blank lines, keeping line breaks (descriptions, comments). */
export function tidyMultiline(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Case-insensitive identity of a name: lower case, whitespace collapsed. Person.nameNormalized uses this. */
export function normaliseName(value: string): string {
  return collapse(value).toLowerCase();
}

/** Loose comparison key: lower case, punctuation removed, whitespace collapsed. */
export function looseKey(value: string): string {
  return collapse(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim(),
  );
}

/**
 * Title case for imported person names. Words written all lower case, or all upper case and longer than
 * two letters, are capitalised; mixed-case words and short upper-case initials ("MV") are kept.
 */
export function titleCaseName(value: string): string {
  return collapse(value)
    .split(' ')
    .map((word) => {
      const upper = word.toUpperCase();
      const lower = word.toLowerCase();
      if (word === lower || (word === upper && word.length > 2)) {
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      }
      return word;
    })
    .join(' ');
}

/** Levenshtein edit distance, stopping early once it exceeds `max`. */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Opaque, stable key for an issue group. Hashed so that names in the grouped values never appear in URLs
 * (`PATCH /imports/{id}/issues/{groupKey}`) or request logs.
 */
export function groupKeyOf(type: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([type, ...parts]))
    .digest('hex');
  return `${type}-${digest.slice(0, 20)}`;
}

/** Most frequent value; ties go to the one seen first. */
export function mostFrequent(counts: Map<string, number>): string {
  let best: string | undefined;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  if (best === undefined) throw new Error('mostFrequent needs at least one value');
  return best;
}
