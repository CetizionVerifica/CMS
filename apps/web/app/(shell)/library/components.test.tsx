import { act as actNow, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { actItems, obligationItems } from './library-model';
import { act, id, obligation } from './test-data';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const push = vi.fn();
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/library/obligations',
  useSearchParams: () => search,
}));

const { ActsTable } = await import('./ActsTable');
const { ObligationsTable } = await import('./ObligationsTable');
const { LibraryNav } = await import('./LibraryNav');
const { LibraryFilterBar } = await import('./LibraryFilterBar');

describe('LibraryNav', () => {
  it('marks the current view', () => {
    render(<LibraryNav current="obligations" />);
    const nav = screen.getByRole('navigation', { name: 'Library' });
    expect(
      within(nav).getByRole('link', { name: 'Obligations' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Acts' }).getAttribute('aria-current')).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Acts' }).getAttribute('href')).toBe(
      '/library/acts',
    );
  });
});

describe('ActsTable', () => {
  it('lists Acts and links each to its obligations', () => {
    render(
      <ActsTable
        items={actItems([
          act(1, { shortName: 'FA', aliases: ['Factories'] }),
          act(2, { jurisdiction: 'STATE', stateCode: 'WB' }),
        ])}
        empty={<p>none</p>}
      />,
    );
    const table = screen.getByRole('table', { name: 'Acts' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent?.trim()),
    ).toEqual(['Act', 'Short name', 'Jurisdiction', 'Also known as']);
    expect(within(table).getByRole('link', { name: 'Act 1' }).getAttribute('href')).toBe(
      `/library/obligations?actId=${id(0x101)}`,
    );
    expect(within(table).getByText('State · WB')).toBeTruthy();
    expect(within(table).getByText('Factories')).toBeTruthy();
  });

  it('shows the empty message when nothing matches', () => {
    render(<ActsTable items={[]} empty={<p>No Acts match</p>} />);
    expect(screen.getByText('No Acts match')).toBeTruthy();
  });
});

describe('ObligationsTable', () => {
  it('lists obligations with criticality and review state', () => {
    render(
      <ObligationsTable
        items={obligationItems(
          [
            obligation(1, { ruleStatus: 'TO_REVIEW', criticality: 'SUPER_CRITICAL' }),
            obligation(2),
          ],
          new Map([[id(0x101), 'Factories Act, 1948']]),
        )}
        empty={<p>none</p>}
      />,
    );
    const table = screen.getByRole('table', { name: 'Obligations' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent?.trim()),
    ).toEqual(['ID', 'Obligation', 'Act', 'Domain', 'Jurisdiction', 'Criticality', 'Recurrence']);
    const first = within(table).getByText('Obligation 1').closest('tr')!;
    expect(within(first).getByText('To review')).toBeTruthy();
    expect(within(first).getByText('Super critical')).toBeTruthy();
    expect(within(first).getByText('HRS-CL-1')).toBeTruthy();
    const second = within(table).getByText('Obligation 2').closest('tr')!;
    expect(within(second).getByText('Confirmed')).toBeTruthy();
    expect(within(second).getAllByText('Factories Act, 1948')).toHaveLength(1);
  });
});

describe('LibraryFilterBar', () => {
  beforeEach(() => {
    push.mockClear();
    search = new URLSearchParams('q=pf&cursor=c1&domain=HRS');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  const defs = [
    {
      key: 'domain',
      label: 'Domain',
      kind: 'multi' as const,
      options: [
        { value: 'HRS', label: 'HRS' },
        { value: 'EHS', label: 'EHS' },
      ],
    },
  ];

  it('writes the search to the URL after a pause and restarts paging', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <LibraryFilterBar
        filters={defs}
        value={{ domain: ['HRS'] }}
        placeholder="Search obligations"
        resultText="3 obligations match"
        resultCount={3}
      />,
    );
    const box = screen.getByRole('searchbox', { name: /Search obligations/ });
    expect((box as HTMLInputElement).value).toBe('pf');
    await user.clear(box);
    await user.type(box, 'esi');
    expect(push).not.toHaveBeenCalled();
    await actNow(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenLastCalledWith('/library/obligations?q=esi&domain=HRS');
  });

  it('writes filter changes to the URL', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <LibraryFilterBar
        filters={defs}
        value={{ domain: ['HRS'] }}
        placeholder="Search obligations"
        resultText="3 obligations match"
        resultCount={3}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Domain/ }));
    await user.click(await screen.findByRole('checkbox', { name: /EHS/ }));
    expect(push).toHaveBeenLastCalledWith('/library/obligations?q=pf&domain=HRS%2CEHS');
    await user.click(screen.getByRole('checkbox', { name: /HRS/ }));
    expect(push).toHaveBeenLastCalledWith('/library/obligations?q=pf');
  });
});
