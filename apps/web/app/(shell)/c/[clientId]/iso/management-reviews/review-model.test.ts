// @vitest-environment node
// Management reviews' URL state, rows and words, against the mock API: the filters are the API's own query, every figure
// key the contract lists is worded, and a figure's value stays the API's while the words say how much of it the reader
// may open. A review planned through the mock shows that its live figures read in words, and that an owner who may not
// open every incident gets that input withheld.
import { REVIEW_FIGURE_KEYS, type LocalDate, type ManagementReviewView } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { ISO } from '../_test/fixture';
import { CLIENT, signedIn } from '../_test/iso-data';
import {
  clauseRefWords,
  dayWords,
  FIGURE_WORDS,
  figureLine,
  laterHeldReviews,
  reviewFilterDefs,
  reviewFilters,
  reviewFilterValue,
  reviewRows,
  reviewsQuery,
  reviewTitle,
  standardsWords,
  systemStandardOptions,
} from './review-model';

const SYS = ISO.system.id;
const [DEMO] = ISO.reviews;
const person = (name: string) => ISO.people.find((p) => p.name === name)!.id;

describe('review filters', () => {
  it('keeps known values only, and sends them as the API’s query', () => {
    const f = reviewFilters({ state: 'HELD,PLANNED,BOGUS', managementSystemId: SYS }, [SYS]);
    expect(reviewsQuery(f)).toEqual({ state: 'HELD,PLANNED', managementSystemId: SYS });
    expect(reviewFilterValue(f)).toEqual({ state: ['HELD', 'PLANNED'] });
    expect(reviewsQuery(reviewFilters({ managementSystemId: 'gone' }, [SYS]))).toEqual({});
    expect(reviewFilterDefs()[0]!.options!.map((o) => o.label)).toEqual([
      'Planned',
      'Held',
      'Closed',
      'Cancelled',
    ]);
  });

  it('asks the API for exactly the reviews it filters', async () => {
    const api = await signedIn('consultant@demo.test');
    const list = async (search: Record<string, string>) =>
      (
        await api.call('listIsoManagementReviews', {
          params: { clientId: CLIENT },
          query: reviewsQuery(reviewFilters(search, [SYS])),
        })
      ).data.items.map((r) => r.id);
    expect(await list({})).toEqual([DEMO!.id]);
    expect(await list({ state: 'HELD' })).toEqual([DEMO!.id]);
    expect(await list({ state: 'PLANNED,CANCELLED' })).toEqual([]);
  });
});

describe('review words', () => {
  it('names a review by its day, and its standards and clauses as the catalogue does', () => {
    expect(dayWords('2024-10-28')).toBe('28 Oct 2024');
    expect(dayWords('2025-01-05')).toBe('5 Jan 2025');
    expect(dayWords('soon')).toBe('soon');
    expect(reviewTitle(DEMO!)).toBe('Management review of 28 Oct 2024');
    expect(reviewTitle({ plannedOn: '2025-04-30' as LocalDate, heldOn: null })).toBe(
      'Management review of 30 Apr 2025',
    );
    expect(standardsWords(ISO.standards, DEMO!.standards)).toBe('ISO 9001, ISO 14001, ISO 45001');
    expect(
      clauseRefWords(ISO.standards, [
        { standard: 'ISO_9001', clauseNumber: '9.3.2', item: 'c1' },
        { standard: 'ISO_14001', clauseNumber: '9.3', item: null },
      ]),
    ).toBe('ISO 9001 9.3.2 c1); ISO 14001 9.3');
    expect(systemStandardOptions(ISO.system, ISO.standards)).toEqual([
      { code: 'ISO_9001', title: 'ISO 9001' },
      { code: 'ISO_14001', title: 'ISO 14001' },
      { code: 'ISO_45001', title: 'ISO 45001' },
    ]);
    expect(systemStandardOptions(undefined, ISO.standards)).toEqual([]);
  });

  it('gives each row its standards, the system when there are several, and the chair', () => {
    const [row] = reviewRows(ISO.reviews, [ISO.system], ISO.standards, ISO.people);
    expect(row).toMatchObject({
      id: DEMO!.id,
      title: 'Management review of 28 Oct 2024',
      sub: 'ISO 9001, ISO 14001, ISO 45001',
      chairName: 'Kabir Shah',
    });
    const two = [ISO.system, { id: 'other', name: 'Second site system' }];
    expect(reviewRows(ISO.reviews, two, ISO.standards, ISO.people)[0]!.sub).toBe(
      `ISO 9001, ISO 14001, ISO 45001 · ${ISO.system.name}`,
    );
    const lost = [{ ...DEMO!, managementSystemId: 'gone' }];
    expect(reviewRows(lost, two, ISO.standards, ISO.people)[0]!.sub).toMatch(/Unknown system$/);
  });

  it('finds the held reviews of the same standards after a day', () => {
    const review = { id: 'new', managementSystemId: SYS, standards: ['ISO_45001' as const] };
    const held = (id: string, heldOn: string, extra: Partial<ManagementReviewView> = {}) =>
      ({
        id,
        managementSystemId: SYS,
        standards: ['ISO_45001'],
        state: 'HELD',
        heldOn,
        ...extra,
      }) as ManagementReviewView;
    const others = [
      DEMO!,
      held('b', '2024-11-02', { state: 'CLOSED' }),
      held('c', '2024-10-01'),
      held('d', '2024-11-05', { standards: ['ISO_9001'] }),
      held('e', '2024-11-06', { managementSystemId: 'other' }),
      held('f', '2024-11-07', { state: 'CANCELLED' }),
      held('new', '2024-11-08'),
    ];
    expect(laterHeldReviews(review, others, '2024-10-15')).toEqual(['2024-10-28', '2024-11-02']);
    expect(laterHeldReviews(review, others, '2024-11-15')).toEqual([]);
  });
});

describe('figures', () => {
  it('words every key the contract lists', () => {
    for (const [source, keys] of Object.entries(REVIEW_FIGURE_KEYS)) {
      const words = (FIGURE_WORDS as Record<string, Record<string, string>>)[source]!;
      expect(Object.keys(words).sort()).toEqual(Object.keys(keys).sort());
      for (const label of Object.values(words)) expect(label).toMatch(/^[A-Z]/);
    }
    expect(FIGURE_WORDS.AUDIT_RESULTS.findingsMajorNc).toBe('Findings: major nonconformity');
  });

  it('keeps the API’s value and says how many of its records the reader may open', () => {
    const line = (
      source: 'NONCONFORMITIES' | 'INCIDENTS' | 'COMPLIANCE_EVALUATION',
      key: string,
      value: number,
      ids: number,
    ) => figureLine(source, { key, value, ids: Array.from({ length: ids }, (_, i) => `id-${i}`) });
    expect(line('NONCONFORMITIES', 'raised', 4, 4)).toEqual({
      key: 'raised',
      label: 'Raised',
      value: '4',
      zero: false,
    });
    expect(line('NONCONFORMITIES', 'raised', 4, 3).value).toBe('4 (3 you can open)');
    expect(line('NONCONFORMITIES', 'open', 0, 0)).toMatchObject({ value: '0', zero: true });
    expect(line('INCIDENTS', 'lostDays', 3, 1)).toMatchObject({
      label: 'Days lost',
      value: '3 (1 record you can open)',
    });
    expect(line('NONCONFORMITIES', 'verifiedNotEffective', 2, 2).value).toBe(
      '2 (2 records you can open)',
    );
    expect(line('COMPLIANCE_EVALUATION', 'statutoryScore', 68.8, 0)).toMatchObject({
      label: 'Statutory compliance score',
      value: '68.8',
    });
    // A key the contract does not list still shows, by its key.
    expect(line('NONCONFORMITIES', 'somethingNew', 1, 1)).toMatchObject({
      label: 'somethingNew',
      value: '1',
    });
  });

  it('words the demo review’s stored figures', () => {
    for (const inputs of Object.values(ISO.reviewInputs)) {
      for (const input of inputs) {
        for (const f of input.sourceFigures?.figures ?? []) {
          expect(figureLine(input.source, f).label).not.toBe(f.key);
        }
      }
    }
  });

  it('words a planned review’s live figures, and withholds the incidents from an owner', async () => {
    const consultant = await signedIn('consultant@demo.test');
    const planned = (
      await consultant.call('planIsoManagementReview', {
        params: { clientId: CLIENT },
        body: {
          managementSystemId: SYS,
          standards: ['ISO_45001'],
          plannedOn: '2025-04-30',
          chairId: person('Sameer Gowda'),
          attendeeIds: [person('Divya Hegde')],
        },
      })
    ).data;
    expect(planned.state).toBe('PLANNED');
    const inputs = async (email: string) =>
      (
        await (
          await signedIn(email)
        ).call('listIsoReviewInputs', {
          params: { clientId: CLIENT, id: planned.id },
        })
      ).data.items;
    const all = await inputs('consultant@demo.test');
    const sources = new Set(all.map((i) => i.source));
    expect(sources.has('INCIDENTS')).toBe(true);
    for (const input of all) {
      for (const f of input.sourceFigures?.figures ?? []) {
        expect(figureLine(input.source, f).label, `${input.source}.${f.key}`).not.toBe(f.key);
      }
    }
    const owner = await inputs('owner@demo.test');
    const incidents = owner.find((i) => i.source === 'INCIDENTS')!;
    expect(incidents.figuresWithheld).toBe(true);
    const ncs = owner.find((i) => i.source === 'NONCONFORMITIES')!;
    const raised = ncs.sourceFigures!.figures.find((f) => f.key === 'raised')!;
    expect(figureLine('NONCONFORMITIES', raised).value).toMatch(/^\d+ \(\d+ you can open\)$/);
  });
});
