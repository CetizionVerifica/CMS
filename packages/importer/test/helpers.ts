import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { EngineCalendar, InferredRule, LocalDate } from '@canopy/contracts';
import { inferRule } from '@canopy/engine';
import { analyseImport, type AnalyseInput, type InferRule } from '../src/analyse.js';
import { firstNonEmptySheet, readWorkbook, type SourceSheet } from '../src/read.js';
import { suggestMapping } from '../src/mapping.js';
import {
  EMPTY_STATE,
  type Decisions,
  type ExistingState,
  type ImportAnalysis,
} from '../src/types.js';

export const CALENDAR: EngineCalendar = { fyStartMonth: 4, holidayPolicy: 'NONE' };

/**
 * A simple inferRule for unit tests that should not depend on the engine's choices: one date is a sure ONE_TIME
 * rule, anything else is low confidence. The importer only reads `confidence` and passes the rule through.
 */
export const stubInferRule: InferRule = (dates: LocalDate[]): InferredRule => {
  const first = dates[0];
  if (!first) throw new Error('inferRule needs a date');
  return {
    rule: { kind: 'ONE_TIME', dueDate: first },
    confidence: dates.length === 1 ? 1 : 0.5,
    mismatches: [],
  };
};

export const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

export async function loadSheet(name: string): Promise<SourceSheet> {
  const bytes = await readFile(fixturePath(name));
  const workbook = await readWorkbook(new Uint8Array(bytes), name);
  const sheet = firstNonEmptySheet(workbook);
  if (!sheet) throw new Error(`${name} has no data`);
  return sheet;
}

export function analyse(
  sheet: SourceSheet,
  options: Partial<Omit<AnalyseInput, 'sheet'>> & {
    decisions?: Decisions;
    existing?: ExistingState;
  } = {},
): ImportAnalysis {
  return analyseImport({
    sheet,
    mapping: options.mapping ?? suggestMapping(sheet.headers),
    existing: options.existing ?? EMPTY_STATE,
    decisions: options.decisions ?? {},
    inferRule: options.inferRule ?? inferRule,
    calendar: options.calendar ?? CALENDAR,
    ...(options.coverage ? { coverage: options.coverage } : {}),
  });
}
