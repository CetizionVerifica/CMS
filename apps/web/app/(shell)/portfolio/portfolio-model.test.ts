import { DerivedStatus, LocalDate, type PortfolioRow } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { portfolioItems, portfolioSummary, registerHref } from './portfolio-model';

const id = (n: number) => `00000000-0000-5000-8000-${n.toString(16).padStart(12, '0')}`;

function row(n: number, name: string, overdue: number, score: number | null): PortfolioRow {
  const counts = Object.fromEntries(
    DerivedStatus.options.map((s) => [s, 0]),
  ) as PortfolioRow['result']['counts'];
  const instanceIds = Object.fromEntries(
    DerivedStatus.options.map((s) => [s, [] as string[]]),
  ) as PortfolioRow['result']['instanceIds'];
  counts.OVERDUE = overdue;
  instanceIds.OVERDUE = Array.from({ length: overdue }, (_, i) => id(0x9000 + n * 100 + i));
  return {
    clientId: id(n),
    clientName: name,
    result: {
      engineVersion: 't',
      asOf: LocalDate.parse('2023-03-15'),
      score,
      onTimeRate: null,
      counts,
      instanceIds,
    },
    dueThisWeek: n,
    lastActivityAt: n === 1 ? '2023-03-14T10:00:00.000Z' : null,
  };
}

describe('registerHref', () => {
  it('links to the register filtered by derived status', () => {
    expect(registerHref(id(1), 'OVERDUE')).toBe(`/c/${id(1)}/register?status=OVERDUE`);
  });

  it('encodes the client id', () => {
    expect(registerHref('a/b', 'OVERDUE')).toBe('/c/a%2Fb/register?status=OVERDUE');
  });
});

describe('portfolioItems', () => {
  it('copies the API numbers without changing them', () => {
    const [item] = portfolioItems([row(1, 'Alpha', 3, 82.5)], { [id(1)]: 'Europe/London' });
    expect(item).toEqual({
      clientId: id(1),
      clientName: 'Alpha',
      score: 82.5,
      overdue: 3,
      dueThisWeek: 1,
      lastActivityAt: '2023-03-14T10:00:00.000Z',
      timeZone: 'Europe/London',
      overviewHref: `/c/${id(1)}/overview`,
      overdueHref: `/c/${id(1)}/register?status=OVERDUE`,
    });
  });

  it('falls back to India time when the client time zone is unknown', () => {
    expect(portfolioItems([row(2, 'Beta', 0, null)], {})[0]!.timeZone).toBe('Asia/Kolkata');
  });

  it('puts the most overdue first, then the lowest score, then the name', () => {
    const items = portfolioItems(
      [
        row(1, 'Delta', 0, null),
        row(2, 'Charlie', 0, 90),
        row(3, 'Bravo', 0, 40),
        row(4, 'Echo', 7, 95),
        row(5, 'Alpha', 0, 40),
        row(6, 'Foxtrot', 12, 10),
      ],
      {},
    );
    expect(items.map((i) => i.clientName)).toEqual([
      'Foxtrot',
      'Echo',
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
    ]);
  });

  it('does not change the input order', () => {
    const rows = [row(1, 'B', 0, null), row(2, 'A', 5, null)];
    portfolioItems(rows, {});
    expect(rows.map((r) => r.clientName)).toEqual(['B', 'A']);
  });
});

describe('portfolioSummary', () => {
  const items = (...rows: PortfolioRow[]) => portfolioItems(rows, {});

  it('says when nothing is overdue', () => {
    expect(portfolioSummary(items(row(1, 'A', 0, null), row(2, 'B', 0, 50)))).toBe(
      'No overdue items across 2 clients.',
    );
    expect(portfolioSummary(items(row(1, 'A', 0, null)))).toBe('No overdue items across 1 client.');
  });

  it('names the total and the clients behind it', () => {
    expect(portfolioSummary(items(row(1, 'A', 1, null), row(2, 'B', 0, null)))).toBe(
      '1 overdue item across 1 client.',
    );
  });

  it('names the client with the most overdue items when several have some', () => {
    expect(
      portfolioSummary(
        items(row(1, 'Demo Metals', 5, null), row(2, 'Sunrise Foods', 12, null), row(3, 'N', 0, 1)),
      ),
    ).toBe('17 overdue items across 2 clients. Sunrise Foods has the most (12).');
  });
});
