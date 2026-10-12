import { Act, Obligation } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import {
  actItems,
  countText,
  cursorParam,
  jurisdictionLabel,
  nextPageHref,
  obligationFilters,
  obligationItems,
  obligationQuery,
  searchText,
  withParams,
} from './library-model';
import { act, id, obligation } from './test-data';

const params = (query: string) => new URLSearchParams(query);

describe('test data', () => {
  it('is contract-valid', () => {
    expect(Act.safeParse(act(1)).success).toBe(true);
    expect(Act.safeParse(act(2, { jurisdiction: 'STATE', stateCode: 'WB' })).success).toBe(true);
    expect(Obligation.safeParse(obligation(1)).success).toBe(true);
  });
});

describe('searchText and cursorParam', () => {
  it('ignores search text under 2 characters and trims it', () => {
    expect(searchText(params('q=a'))).toBeUndefined();
    expect(searchText(params('q=%20%20'))).toBeUndefined();
    expect(searchText(params(''))).toBeUndefined();
    expect(searchText(params('q=%20pf%20'))).toBe('pf');
  });

  it('caps search text at 200 characters', () => {
    expect(searchText(params(`q=${'x'.repeat(300)}`))).toHaveLength(200);
  });

  it('reads the cursor', () => {
    expect(cursorParam(params('cursor=abc'))).toBe('abc');
    expect(cursorParam(params('cursor='))).toBeUndefined();
  });
});

describe('jurisdictionLabel', () => {
  it('words central and state Acts', () => {
    expect(jurisdictionLabel('CENTRAL', null)).toBe('Central');
    expect(jurisdictionLabel('STATE', 'WB')).toBe('State · WB');
    expect(jurisdictionLabel('STATE', null)).toBe('State · —');
  });
});

describe('actItems', () => {
  it('maps Acts to rows that open their obligations', () => {
    expect(
      actItems([act(1, { shortName: 'FA', aliases: ['Factories Act', 'The Factories Act'] })]),
    ).toEqual([
      {
        id: id(0x101),
        name: 'Act 1',
        shortName: 'FA',
        jurisdiction: 'Central',
        aliases: 'Factories Act, The Factories Act',
        obligationsHref: `/library/obligations?actId=${id(0x101)}`,
      },
    ]);
  });
});

describe('obligationFilters', () => {
  it('reads comma lists and drops values the API would reject', () => {
    expect(
      obligationFilters(
        params(
          `actId=${id(1)},nope&domain=HRS,EHS,XYZ&criticality=HIGH,LOW,HIGH&jurisdiction=STATE&ruleStatus=TO_REVIEW&other=1`,
        ),
      ),
    ).toEqual({
      actId: [id(1)],
      domain: ['HRS', 'EHS'],
      criticality: ['HIGH', 'LOW'],
      jurisdiction: ['STATE'],
      ruleStatus: ['TO_REVIEW'],
    });
  });

  it('treats both jurisdictions or both rule statuses as no filter', () => {
    expect(
      obligationFilters(params('jurisdiction=CENTRAL,STATE&ruleStatus=CONFIRMED,TO_REVIEW')),
    ).toEqual({});
  });

  it('returns nothing for an empty or junk URL', () => {
    expect(obligationFilters(params(''))).toEqual({});
    expect(obligationFilters(params('domain=,,'))).toEqual({});
  });
});

describe('obligationQuery', () => {
  it('builds the API query with comma lists, search and cursor', () => {
    expect(
      obligationQuery(
        {
          actId: [id(1), id(2)],
          domain: ['HRS'],
          jurisdiction: ['STATE'],
          ruleStatus: ['TO_REVIEW'],
          criticality: ['HIGH'],
        },
        'pf',
        'c1',
      ),
    ).toEqual({
      limit: '50',
      count: 'true',
      q: 'pf',
      cursor: 'c1',
      actId: `${id(1)},${id(2)}`,
      domain: 'HRS',
      criticality: 'HIGH',
      jurisdiction: 'STATE',
      ruleStatus: 'TO_REVIEW',
    });
  });

  it('sends only paging when nothing is filtered', () => {
    expect(obligationQuery({})).toEqual({ limit: '50', count: 'true' });
  });
});

describe('withParams and nextPageHref', () => {
  it('applies changes, removes empty ones and restarts paging', () => {
    const current = params('q=pf&cursor=c2&domain=HRS');
    expect(withParams('/library/obligations', current, { domain: ['HRS', 'EHS'] })).toBe(
      '/library/obligations?q=pf&domain=HRS%2CEHS',
    );
    expect(withParams('/library/obligations', current, { q: undefined, domain: [] })).toBe(
      '/library/obligations',
    );
  });

  it('links the next page, or nothing on the last one', () => {
    expect(nextPageHref('/library/acts', params('q=pf'), 'c3')).toBe(
      '/library/acts?q=pf&cursor=c3',
    );
    expect(nextPageHref('/library/acts', params('q=pf'), null)).toBeUndefined();
  });
});

describe('obligationItems', () => {
  it('maps obligations with their Act name and review flag', () => {
    const names = new Map([[id(0x101), 'Factories Act, 1948']]);
    expect(
      obligationItems(
        [
          obligation(1, { ruleStatus: 'TO_REVIEW', jurisdiction: 'STATE', stateCode: 'WB' }),
          obligation(2, { actId: id(0x999), externalRef: null }),
        ],
        names,
      ),
    ).toEqual([
      {
        id: id(0x201),
        ref: 'HRS-CL-1',
        title: 'Obligation 1',
        actName: 'Factories Act, 1948',
        domain: 'HRS',
        jurisdiction: 'State · WB',
        criticality: 'HIGH',
        toReview: true,
      },
      expect.objectContaining({ ref: null, actName: 'Unknown Act', toReview: false }),
    ]);
  });
});

describe('countText', () => {
  it('says how many show, and of how many when there are more', () => {
    expect(countText(1, 1, 'Act', 'Acts')).toBe('1 Act');
    expect(countText(3, undefined, 'Act', 'Acts')).toBe('3 Acts');
    expect(countText(50, 119, 'obligation', 'obligations')).toBe('Showing 50 of 119 obligations');
    expect(countText(0, 0, 'Act', 'Acts')).toBe('0 Acts');
  });
});
