import { describe, expect, it } from 'vitest';
import { KNOWN_HEADERS, REQUIRED_FIELDS, suggestMapping, validateMapping } from '../src/mapping.js';

describe('suggestMapping', () => {
  it('matches headers regardless of case, punctuation and order', () => {
    const mapping = suggestMapping(['due  date', 'STATUS', 'Remarks', 'Notes', 'act name']);
    expect(mapping).toEqual([
      { sourceHeader: 'due  date', field: 'dueDate' },
      { sourceHeader: 'STATUS', field: 'status' },
      { sourceHeader: 'Remarks', field: 'ownerComment' },
      { sourceHeader: 'Notes', field: null },
      { sourceHeader: 'act name', field: 'act' },
    ]);
  });

  it('prefers the stronger header when two could map to one field', () => {
    const mapping = suggestMapping(['Type', 'Type (TimeLine)']);
    expect(mapping).toEqual([
      { sourceHeader: 'Type', field: null },
      { sourceHeader: 'Type (TimeLine)', field: 'timelineType' },
    ]);
  });

  it('applies a saved template first, including ignored columns', () => {
    const mapping = suggestMapping(
      ['Resp. Person', 'Owner', 'Due Date', 'Status'],
      [
        { sourceHeader: 'resp person', field: 'owner' },
        { sourceHeader: 'Owner', field: null },
        { sourceHeader: 'Status', field: 'owner' },
      ],
    );
    expect(mapping).toEqual([
      { sourceHeader: 'Resp. Person', field: 'owner' },
      { sourceHeader: 'Owner', field: null },
      { sourceHeader: 'Due Date', field: 'dueDate' },
      // The template's second "owner" cannot be used, so the header is matched as usual.
      { sourceHeader: 'Status', field: 'status' },
    ]);
  });

  it('has a known header for every field', () => {
    for (const headers of Object.values(KNOWN_HEADERS)) expect(headers.length).toBeGreaterThan(0);
  });
});

describe('validateMapping', () => {
  it('reports unknown headers, duplicate fields and missing required fields', () => {
    const problems = validateMapping(
      [
        { sourceHeader: 'Title', field: 'title' },
        { sourceHeader: 'Name', field: 'title' },
        { sourceHeader: 'Gone', field: null },
      ],
      ['Title', 'Name'],
    );
    expect(problems).toContainEqual({ kind: 'UNKNOWN_HEADER', subject: 'Gone' });
    expect(problems).toContainEqual({ kind: 'DUPLICATE_FIELD', subject: 'title' });
    expect(problems.filter((p) => p.kind === 'MISSING_REQUIRED_FIELD')).toHaveLength(
      REQUIRED_FIELDS.length - 1,
    );
  });
});
