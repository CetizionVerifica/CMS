import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '@canopy/ui';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storageKey } from '../_lib/saved-views';
import { CLIENT_ID, makeRow, makeRows, PERSON_ID } from '../_test/rows';

const PATH = `/c/${CLIENT_ID}/register`;
const nav = {
  search: '',
  replace: vi.fn((url: string, _options?: { scroll?: boolean }) => {
    nav.search = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  }),
};

vi.mock('next/navigation', () => ({
  usePathname: () => PATH,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { RegisterGrid } = await import('./RegisterGrid');
type Props = Parameters<typeof RegisterGrid>[0];

const DEPT = '00000000-0000-5000-8000-000000000501';
const facets = {
  departments: [{ value: DEPT, label: 'EHS', count: 3 }],
  acts: [],
  units: [],
  categories: [],
};

function view(props: Partial<Props> = {}) {
  return (
    <>
      <RegisterGrid
        clientId={CLIENT_ID}
        personId={PERSON_ID}
        rows={makeRows(20)}
        facets={facets}
        {...props}
      />
      <Toaster />
    </>
  );
}

function renderGrid(props: Partial<Props> = {}) {
  const utils = render(view(props));
  return { ...utils, rerender: (next: Partial<Props> = props) => utils.rerender(view(next)) };
}

const lastUrl = () => nav.replace.mock.calls.at(-1)?.[0];

beforeEach(() => {
  nav.search = '';
  nav.replace.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('RegisterGrid', () => {
  it('shows the Excel columns and links each row to its drawer, keeping the URL state', () => {
    nav.search = 'fy=2022-23&status=UPCOMING';
    renderGrid();
    const table = screen.getByRole('table', { name: 'Register' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'ID',
      'Title',
      'Act',
      'Department',
      'Owner',
      'Approver',
      'Due date',
      'Status',
      'Criticality',
    ]);
    expect(screen.getByRole('link', { name: 'Obligation 0' }).getAttribute('href')).toBe(
      `${PATH}/${makeRow(0).id}?fy=2022-23&status=UPCOMING`,
    );
    expect(screen.getByText('20 instances')).toBeTruthy();
  });

  it('writes filters into the URL with replace, keeping the period', async () => {
    const user = userEvent.setup();
    nav.search = 'fy=2022-23&q=Q4';
    renderGrid();
    await user.click(
      within(screen.getByRole('group', { name: 'Filters' })).getByRole('button', {
        name: 'Department',
      }),
    );
    await user.click(screen.getByRole('checkbox', { name: /EHS/ }));
    expect(lastUrl()).toBe(`${PATH}?fy=2022-23&q=Q4&departmentId=${DEPT}`);
    expect(nav.replace.mock.calls.at(-1)?.[1]).toEqual({ scroll: false });
  });

  it('reads filters from the URL into the chips', () => {
    nav.search = 'status=OVERDUE';
    renderGrid();
    expect(screen.getByRole('button', { name: 'Status filter: Overdue. Change' })).toBeTruthy();
  });

  it('writes the search as `search`, never the period’s `q`', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    nav.search = 'q=Q3';
    renderGrid();
    await user.type(screen.getByRole('searchbox'), 'gratuity');
    act(() => vi.advanceTimersByTime(300));
    expect(lastUrl()).toBe(`${PATH}?q=Q3&search=gratuity`);
  });

  it('sorts on the server through the URL', async () => {
    const user = userEvent.setup();
    renderGrid();
    await user.click(screen.getByRole('button', { name: /^Title/ }));
    expect(lastUrl()).toBe(`${PATH}?sort=title`);
  });

  it('offers bulk approve only when the page passes it', async () => {
    const user = userEvent.setup();
    const onBulkApprove = vi.fn();
    const { rerender } = renderGrid();
    expect(screen.queryAllByRole('checkbox', { name: /TAX-CL-0001/ })).toHaveLength(0);
    rerender({ onBulkApprove });
    await user.click(screen.getByRole('checkbox', { name: 'Select TAX-CL-0001, Obligation 1' }));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onBulkApprove).toHaveBeenCalledWith([makeRow(1).id]);
  });

  it('says when filters match nothing, and clears them', async () => {
    const user = userEvent.setup();
    nav.search = 'fy=2022-23&status=OVERDUE&search=zz';
    renderGrid({ rows: [] });
    expect(screen.getByText('No instances match these filters')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(lastUrl()).toBe(`${PATH}?fy=2022-23`);
  });

  it('explains an empty register', () => {
    renderGrid({ rows: [] });
    expect(screen.getByText('Nothing in the register for this period')).toBeTruthy();
  });

  it('shows the error with a retry and disables the filters', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    renderGrid({ rows: [], error: { message: 'The register didn’t load.', retry } });
    expect(screen.getByText('The register didn’t load.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
    expect(
      within(screen.getByRole('group', { name: 'Filters' })).getByRole('button', {
        name: 'Status',
      }),
    ).toHaveProperty('disabled', true);
  });

  it('stays virtualised at 10,000 rows', () => {
    renderGrid({ rows: makeRows(10_000), totalCount: 10_000 });
    const rendered = screen.getAllByRole('row').length - 1;
    expect(rendered).toBeLessThan(60);
    expect(screen.getByText('10,000 instances')).toBeTruthy();
  });

  it('exports the current view when the page offers it', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    renderGrid({ onExport });
    await user.click(screen.getByRole('button', { name: /Export/ }));
    expect(onExport).toHaveBeenCalled();
  });
});

describe('saved views', () => {
  const trigger = () => screen.getByRole('button', { name: /^View: / });
  const key = storageKey(PERSON_ID, CLIENT_ID);

  it('saves the current filters as a view and selects it', async () => {
    const user = userEvent.setup();
    nav.search = 'fy=2022-23&status=OVERDUE';
    const { rerender } = renderGrid();
    await user.click(trigger());
    expect(screen.getByRole('menuitemradio', { name: /Default/ }).textContent).toContain('Default');
    await user.click(screen.getByRole('menuitem', { name: 'Save current view…' }));
    await user.type(screen.getByRole('textbox', { name: /View name/ }), 'Overdue{Enter}');
    const stored = JSON.parse(localStorage.getItem(key)!) as {
      views: { id: string; name: string; query: string }[];
    };
    expect(stored.views).toEqual([
      { id: expect.any(String), name: 'Overdue', query: 'status=OVERDUE' },
    ]);
    expect(lastUrl()).toBe(`${PATH}?fy=2022-23&status=OVERDUE&view=${stored.views[0]!.id}`);
    rerender();
    await waitFor(() => expect(trigger().textContent).toBe('View: Overdue'));
  });

  it('opens on the default view when the URL has no register state', async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ views: [{ id: 'v1', name: 'Mine', query: 'ownerId=me' }], defaultId: 'v1' }),
    );
    nav.search = 'fy=2022-23';
    renderGrid();
    await waitFor(() => expect(lastUrl()).toBe(`${PATH}?fy=2022-23&ownerId=me&view=v1`));
  });

  it('does not override a link that carries filters', async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ views: [{ id: 'v1', name: 'Mine', query: 'ownerId=me' }], defaultId: 'v1' }),
    );
    nav.search = 'status=OVERDUE';
    renderGrid();
    await waitFor(() => expect(trigger()).toBeTruthy());
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('marks a view edited when the URL differs, and discards back to it', async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      key,
      JSON.stringify({ views: [{ id: 'v1', name: 'Mine', query: 'ownerId=me' }] }),
    );
    nav.search = 'ownerId=me&status=OVERDUE&view=v1';
    renderGrid();
    await waitFor(() => expect(trigger().textContent).toContain('Mine'));
    expect(screen.getByText(/Edited/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(lastUrl()).toBe(`${PATH}?view=v1&ownerId=me`);
  });

  it('updates, renames, sets the default and deletes a view', async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      key,
      JSON.stringify({ views: [{ id: 'v1', name: 'Mine', query: 'ownerId=me' }] }),
    );
    nav.search = 'ownerId=me&status=OVERDUE&view=v1';
    const { rerender } = renderGrid();
    await waitFor(() => expect(trigger().textContent).toContain('Mine'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(JSON.parse(localStorage.getItem(key)!).views[0].query).toBe('status=OVERDUE&ownerId=me');

    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: /Rename/ }));
    const name = screen.getByRole('textbox', { name: /View name/ });
    await user.clear(name);
    await user.type(name, 'My overdue{Enter}');
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(key)!).views[0].name).toBe('My overdue'),
    );

    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: /default/i }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).defaultId).toBe('v1'));

    rerender();
    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: /Delete/ }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /Delete/ }),
    );
    await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).views).toEqual([]));
    expect(lastUrl()).toBe(`${PATH}?status=OVERDUE&ownerId=me`);
  });

  it('switches views from the menu', async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      key,
      JSON.stringify({ views: [{ id: 'v1', name: 'Mine', query: 'ownerId=me' }] }),
    );
    nav.search = 'fy=2022-23&status=OVERDUE';
    renderGrid();
    await waitFor(() => expect(trigger()).toBeTruthy());
    await user.click(trigger());
    await user.click(screen.getByRole('menuitemradio', { name: 'Mine' }));
    expect(lastUrl()).toBe(`${PATH}?fy=2022-23&ownerId=me&view=v1`);
  });

  it('warns when the browser blocks storage', async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    nav.search = 'status=OVERDUE';
    renderGrid();
    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: 'Save current view…' }));
    await user.type(screen.getByRole('textbox', { name: /View name/ }), 'Overdue{Enter}');
    expect(await screen.findByText(/blocking storage/)).toBeTruthy();
    setItem.mockRestore();
  });
});
