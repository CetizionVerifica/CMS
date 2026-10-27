import type { ControlHierarchy, IsoStandardCode } from '@canopy/contracts';

/**
 * Words for ISO codes in exports (docs/iso/model.md §4.7): the code in sentence case with a space for each
 * underscore (`ROOT_CAUSE_FOUND` reads "Root cause found"), never the code itself, with the model's exceptions for
 * the enums M10 prints. Each map is keyed by its own enum, so the same code in another enum follows the rule.
 */
export function codeWords(code: string): string {
  const words = code.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `IsoStandard.title` of each standard. */
export const STANDARD_WORDS: Readonly<Record<IsoStandardCode, string>> = {
  ISO_9001: 'ISO 9001',
  ISO_14001: 'ISO 14001',
  ISO_45001: 'ISO 45001',
};

/** The rule, but PPE stays "PPE". */
export function controlHierarchyWords(value: ControlHierarchy): string {
  return value === 'PPE' ? 'PPE' : codeWords(value);
}

/** "Yes", "No", or blank for a value not set. */
export function yesNo(value: boolean | null): string {
  if (value === null) return '';
  return value ? 'Yes' : 'No';
}
