import type { LocalDate, ObjectiveView, RecurrenceRule } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { ISO } from '../_test/fixture';
import {
  objectiveFilterDefs,
  objectiveFilters,
  objectiveFilterValue,
  objectivesQuery,
  objectiveSystems,
  READING_CHOICES,
  readingChoice,
} from './objectives-model';
import { objectiveRows, progressText, readingRuleText, standing } from './objectives-words';

const SYS = ISO.system.id;
const objective = (start: string) => ISO.objectives.find((o) => o.text.startsWith(start))!;

describe('objective filters', () => {
  it("reads the overview's exact filters and sends them, with ids, to the API", () => {
    const f = objectiveFilters(
      {
        managementSystemId: SYS,
        open: 'true',
        standard: 'ISO_14001,BOGUS',
        ownerId: 'me',
        q: ' energy ',
        ids: 'a,b',
      },
      [SYS],
    );
    expect(objectivesQuery(f)).toEqual({
      managementSystemId: SYS,
      open: 'true',
      standard: 'ISO_14001',
      ownerId: 'me',
      q: 'energy',
      ids: 'a,b',
    });
    expect(objectiveFilterValue(f)).toEqual({
      standard: ['ISO_14001'],
      open: ['true'],
      ownerId: ['me'],
    });
  });

  it('adds no filter the URL does not name', () => {
    const f = objectiveFilters({ open: 'both', managementSystemId: 'other' }, [SYS]);
    expect(objectivesQuery(f)).toEqual({});
    expect(objectiveFilterValue(f)).toEqual({ standard: [], open: [], ownerId: [] });
    const defs = objectiveFilterDefs(ISO.standards);
    expect(defs.map((d) => d.key)).toEqual(['standard', 'open', 'ownerId']);
    expect(defs[0]!.options!.map((o) => o.label)).toEqual(['ISO 9001', 'ISO 14001', 'ISO 45001']);
  });
});

describe('reading rules', () => {
  it('finds the form’s choice for a stored rule, or none for another shape', () => {
    for (const [key, choice] of Object.entries(READING_CHOICES)) {
      expect(readingChoice(choice.rule as RecurrenceRule)).toBe(key);
      expect(readingRuleText(choice.rule as RecurrenceRule)).toBe(choice.label);
    }
    const monthlyReview: RecurrenceRule = { kind: 'ONGOING_REVIEW', every: 'MONTH' };
    expect(readingChoice(monthlyReview)).toBeNull();
  });

  it('words every rule kind', () => {
    const words = (rule: unknown) => readingRuleText(rule as RecurrenceRule);
    expect(words({ kind: 'ONE_TIME', dueDate: '2025-03-31' })).toBe('Once, by 31 Mar 2025');
    expect(words({ kind: 'FIXED_DATES', dates: [{}] })).toBe('On 1 set date a year');
    expect(words({ kind: 'FIXED_DATES', dates: [{}, {}] })).toBe('On 2 set dates a year');
    expect(words({ kind: 'EVENT_DRIVEN', withinDays: 7, trigger: 'an incident' })).toBe(
      'Within 7 days of an incident',
    );
    expect(words({ kind: 'ONGOING_REVIEW', every: 'HALF_YEAR' })).toBe('Every half year');
  });
});

describe('objective words', () => {
  it('rows each objective with its standards, target, progress and owner', () => {
    const rows = objectiveRows(ISO.objectives, ISO.standards, ISO.people);
    expect(rows).toHaveLength(ISO.objectives.length);
    for (const r of rows) {
      expect(r.target).toMatch(/ to .* by /);
      expect(r.ownerName).not.toBe('Someone');
    }
  });

  it('says where an objective stands', () => {
    const closed = objective('Train every');
    expect(standing(closed).text).toBe(closed.outcome === 'ACHIEVED' ? 'Achieved' : 'Not achieved');
    const open = objective('Cut grid');
    const base: ObjectiveView = { ...open, closedOn: null, outcome: null };
    expect(standing({ ...base, progress: { ...base.progress, onTrack: true } })).toEqual({
      text: 'On track',
      tone: 'ok',
    });
    expect(standing({ ...base, progress: { ...base.progress, onTrack: false } }).text).toBe(
      'Off track',
    );
    const none = { ...base, progress: { ...base.progress, onTrack: null, latestValue: null } };
    expect(standing(none).text).toBe('No reading yet');
    expect(progressText(none)).toBe('No reading yet');
    expect(
      progressText({
        ...base,
        unitOfMeasure: 'kWh per tonne',
        progress: {
          ...base.progress,
          latestValue: 405,
          latestPeriodEnd: '2024-09-30' as LocalDate,
          progressPercent: 37.4,
        },
      }),
    ).toBe('Latest 405 kWh per tonne (to 30 Sep 2024), 37% of the way');
  });

  it("offers each system's standards and live risk items", () => {
    const [sys] = objectiveSystems(ISO.systems, ISO.standards, [
      ...ISO.risks,
      { ...ISO.risks[0]!, id: 'gone', archivedAt: '2024-01-01T00:00:00Z' },
    ]);
    expect(sys!.standards.map((s) => s.code)).toEqual(['ISO_9001', 'ISO_14001', 'ISO_45001']);
    expect(sys!.risks.map((r) => r.id)).not.toContain('gone');
    expect(sys!.risks[0]!.label).toMatch(/^Risk: Buying flour, /);
  });
});
