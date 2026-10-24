import { LocalDate, RegisterQuery } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import {
  apiQueryFromParams,
  filterValueFromParams,
  registerPeriod,
  sortingFromParams,
  viewQuery,
  withFilters,
  withSearch,
  withSorting,
  withView,
} from './query';

const DEPT = '00000000-0000-5000-8000-000000000501';
const DEPT2 = '00000000-0000-5000-8000-000000000502';
const p = (s: string) => new URLSearchParams(s);
const range = (from: string, to: string) => ({
  from: LocalDate.parse(from),
  to: LocalDate.parse(to),
});

describe('apiQueryFromParams', () => {
  it('passes valid filters through under their API names and sorts by due date by default', () => {
    const q = apiQueryFromParams(
      p(`status=OVERDUE,DUE_SOON&criticality=CRITICAL&departmentId=${DEPT},${DEPT2}&ownerId=me`),
    );
    expect(Object.fromEntries(q)).toEqual({
      status: 'OVERDUE,DUE_SOON',
      criticality: 'CRITICAL',
      departmentId: `${DEPT},${DEPT2}`,
      ownerId: 'me',
      sort: 'dueDate',
    });
    expect(RegisterQuery.safeParse(Object.fromEntries(q)).success).toBe(true);
  });

  it('drops values the contract would reject instead of failing the page', () => {
    const q = apiQueryFromParams(
      p(
        'status=OVERDUE,NOPE&criticality=&departmentId=not-a-uuid&dueFrom=2023-02-30&hasEvidence=yes',
      ),
    );
    expect(Object.fromEntries(q)).toEqual({ sort: 'dueDate' });
  });

  it('maps the URL search to the API q, leaving the period picker’s q alone', () => {
    const q = apiQueryFromParams(p('fy=2022-23&q=Q3&search=%20gratuity%20'));
    expect(q.get('q')).toBe('gratuity');
    expect(q.has('fy')).toBe(false);
  });

  it('ignores a one-letter search (the API needs at least 2 characters)', () => {
    expect(apiQueryFromParams(p('search=a')).has('q')).toBe(false);
  });

  it('sends a whole FY as fy and a quarter or month as its due-date range', () => {
    expect(apiQueryFromParams(p(''), { fy: '2022-23' }).get('fy')).toBe('2022-23');
    const q3 = apiQueryFromParams(p(''), range('2022-10-01', '2022-12-31'));
    expect(q3.has('fy')).toBe(false);
    expect([q3.get('dueFrom'), q3.get('dueTo')]).toEqual(['2022-10-01', '2022-12-31']);
    expect(apiQueryFromParams(p(''), { fy: '2022-2' }).has('fy')).toBe(false);
  });

  it('lets an explicit due-date filter win over the period, since the contract takes one or the other', () => {
    const fy = apiQueryFromParams(p('dueFrom=2023-01-01'), { fy: '2022-23' });
    expect(fy.has('fy')).toBe(false);
    expect(fy.get('dueFrom')).toBe('2023-01-01');
    const quarter = apiQueryFromParams(p('dueTo=2022-11-15'), range('2022-10-01', '2022-12-31'));
    expect(quarter.has('dueFrom')).toBe(false);
    expect(quarter.get('dueTo')).toBe('2022-11-15');
  });

  it('drops the end of a reversed range', () => {
    const q = apiQueryFromParams(
      p('dueFrom=2023-03-10&dueTo=2023-03-01&completedFrom=2023-03-10&completedTo=2023-03-01'),
    );
    expect(q.get('dueFrom')).toBe('2023-03-10');
    expect(q.has('dueTo')).toBe(false);
    expect(q.get('completedFrom')).toBe('2023-03-10');
    expect(q.has('completedTo')).toBe(false);
  });

  it('keeps sort keys the API knows, in order', () => {
    expect(apiQueryFromParams(p('sort=-criticality,bogus,dueDate')).get('sort')).toBe(
      '-criticality,dueDate',
    );
  });

  it('always produces a query the contract accepts', () => {
    const urls = [
      '',
      'fy=2023-24&m=2023-05',
      `search=ab&sort=-title&unitId=${DEPT}&workflowState=SUBMITTED&timelineType=ONGOING`,
      'domain=LABOUR&completedFrom=2023-01-01&hasEvidence=true&approverId=me',
      'dueTo=2023-03-31',
    ];
    const periods = [undefined, { fy: '2022-23' }, range('2023-01-01', '2023-03-31')];
    for (const url of urls) {
      for (const period of periods) {
        expect(
          RegisterQuery.safeParse(Object.fromEntries(apiQueryFromParams(p(url), period))).success,
        ).toBe(true);
      }
    }
  });
});

describe('registerPeriod', () => {
  const client = { fyStartMonth: 4, thisPeriod: { fy: '2023-24', quarter: 2 as const } };

  it('uses the URL’s period: a whole FY, a quarter or a month', () => {
    expect(registerPeriod(p('fy=2022-23'), client)).toEqual({ fy: '2022-23' });
    expect(registerPeriod(p('fy=2022-23&q=Q3'), client)).toEqual({
      from: '2022-10-01',
      to: '2022-12-31',
    });
    expect(registerPeriod(p('fy=2022-23&m=2023-02'), client)).toEqual({
      from: '2023-02-01',
      to: '2023-02-28',
    });
  });

  it('falls back to the client’s current quarter, as the period picker shows it', () => {
    expect(registerPeriod(p(''), client)).toEqual({ from: '2023-07-01', to: '2023-09-30' });
    expect(registerPeriod(p('fy=bad'), client)).toEqual({ from: '2023-07-01', to: '2023-09-30' });
  });

  it('follows a January FY start', () => {
    expect(registerPeriod(p('fy=2023-24&q=Q1'), { ...client, fyStartMonth: 1 })).toEqual({
      from: '2023-01-01',
      to: '2023-03-31',
    });
  });
});

describe('sortingFromParams', () => {
  it('defaults to due date ascending', () => {
    expect(sortingFromParams(p(''))).toEqual([{ id: 'dueDate', desc: false }]);
    expect(sortingFromParams(p('sort=nothing'))).toEqual([{ id: 'dueDate', desc: false }]);
  });

  it('reads descending keys', () => {
    expect(sortingFromParams(p('sort=-status,title'))).toEqual([
      { id: 'status', desc: true },
      { id: 'title', desc: false },
    ]);
  });
});

describe('filterValueFromParams and withFilters', () => {
  it('round-trips the FilterBar value through the URL', () => {
    const value = {
      status: ['OVERDUE'],
      departmentId: [DEPT, DEPT2],
      due: { from: '2023-01-01', to: '2023-03-31' },
    };
    const url = withFilters('fy=2022-23&q=Q4&sort=-title&view=v1', value);
    expect(url.get('fy')).toBe('2022-23');
    expect(url.get('q')).toBe('Q4');
    expect(url.get('sort')).toBe('-title');
    expect(url.get('view')).toBe('v1');
    expect(filterValueFromParams(url)).toEqual(value);
  });

  it('removes filters that are cleared', () => {
    const url = withFilters('status=OVERDUE&dueFrom=2023-01-01&dueTo=2023-02-01', {
      status: [],
      due: { from: '2023-01-05' },
    });
    expect(url.has('status')).toBe(false);
    expect(url.get('dueFrom')).toBe('2023-01-05');
    expect(url.has('dueTo')).toBe(false);
    expect(withFilters(url, {}).toString()).toBe('');
  });

  it('reads a one-sided range and ignores invalid values', () => {
    expect(filterValueFromParams(p('dueTo=2023-03-31&criticality=WRONG'))).toEqual({
      due: { to: '2023-03-31' },
    });
  });
});

describe('withSearch and withSorting', () => {
  it('sets and clears the search', () => {
    expect(withSearch('fy=2022-23', '  pf  ').get('search')).toBe('pf');
    expect(withSearch('search=pf', ' ').has('search')).toBe(false);
  });

  it('leaves the default sort out of the URL', () => {
    expect(withSorting('sort=-title', [{ id: 'dueDate', desc: false }]).has('sort')).toBe(false);
    expect(withSorting('', []).has('sort')).toBe(false);
    expect(
      withSorting('', [
        { id: 'criticality', desc: true },
        { id: 'unknown', desc: false },
      ]).get('sort'),
    ).toBe('-criticality');
  });
});

describe('viewQuery and withView', () => {
  it('stores the register state in a stable order, without the period or view id', () => {
    const a = viewQuery(p('view=x&fy=2022-23&q=Q3&search=pf&status=OVERDUE&sort=-title'));
    const b = viewQuery(p('sort=-title&status=OVERDUE&search=pf'));
    expect(a).toBe(b);
    expect(a).toBe('status=OVERDUE&search=pf&sort=-title');
    expect(viewQuery(p('sort=dueDate'))).toBe('');
  });

  it('replaces the register state with a view and keeps the period', () => {
    const next = withView(
      'fy=2022-23&q=Q3&status=OVERDUE&view=old',
      'criticality=CRITICAL&fy=2099-00',
      'v2',
    );
    expect(Object.fromEntries(next)).toEqual({
      fy: '2022-23',
      q: 'Q3',
      criticality: 'CRITICAL',
      view: 'v2',
    });
    expect(withView(next, '', undefined).toString()).toBe('fy=2022-23&q=Q3');
  });
});
