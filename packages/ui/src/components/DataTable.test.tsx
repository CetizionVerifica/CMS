import { createColumnHelper } from '@tanstack/react-table';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CheckCheck } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { setViewport } from '../../test/viewport';
import type { Criticality } from './CriticalityTag';
import type { TableContext } from './data-table/context';
import { DataTable, type DataTableProps } from './data-table/DataTable';
import type { DerivedStatus } from './StatusPill';
import { resetToasts, Toaster } from './Toast';

type Instance = {
  id: string;
  title: string;
  act: string;
  department: string;
  owner: { name: string } | null;
  due: string;
  status: DerivedStatus;
  days?: number;
  criticality: Criticality;
  progress: number;
  penalty: number;
};

const statuses: DerivedStatus[] = ['OVERDUE', 'DUE_SOON', 'UPCOMING', 'COMPLIED'];
const levels: Criticality[] = ['SUPER_CRITICAL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

const makeRows = (n: number): Instance[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `TAX-CL-${String(i + 1).padStart(3, '0')}`,
    title: `Obligation ${i + 1}`,
    act: i % 2 ? 'Income Tax Act, 1961' : 'Factories Act, 1948',
    department: i % 3 ? 'Finance' : 'EHS',
    owner: i % 4 ? { name: `Owner ${i % 5}` } : null,
    due: `2027-03-${String((i % 28) + 1).padStart(2, '0')}`,
    status: statuses[i % 4]!,
    days: 3,
    criticality: levels[i % 5]!,
    progress: (i * 7) % 100,
    penalty: i * 1000,
  }));

const col = createColumnHelper<Instance>();
const columns = [
  col.accessor('id', { header: 'ID', size: 120, meta: { type: 'id' } }),
  col.accessor((r) => ({ title: r.title, sub: r.act }), {
    id: 'title',
    header: 'Title',
    size: 280,
    meta: { type: 'title', locked: true },
    sortingFn: (a, b) => a.original.title.localeCompare(b.original.title),
  }),
  col.accessor('department', { header: 'Department', meta: { type: 'text' } }),
  col.accessor('owner', { header: 'Owner', meta: { type: 'person' }, enableSorting: false }),
  col.accessor('due', { header: 'Due date', meta: { type: 'date' } }),
  col.accessor((r) => ({ status: r.status, days: r.days }), {
    id: 'status',
    header: 'Status',
    meta: { type: 'status' },
    enableSorting: false,
  }),
  col.accessor('criticality', { header: 'Criticality', meta: { type: 'criticality' } }),
  col.accessor('progress', { header: 'Evidence', meta: { type: 'progress', label: 'Evidence' } }),
  col.accessor('penalty', { header: 'Penalty', meta: { type: 'number' } }),
];

function renderTable(props: Partial<DataTableProps<Instance>> = {}, n = 12) {
  return render(
    <>
      <DataTable<Instance>
        label="Register"
        columns={columns}
        data={makeRows(n)}
        rowId={(r) => r.id}
        rowLabel={(r) => `${r.id}, ${r.title}`}
        rowHref={(r) => `#/i/${r.id}`}
        countNoun={{ one: 'instance', other: 'instances' }}
        {...props}
      />
      <Toaster />
    </>,
  );
}

const rowLinks = () => screen.getAllByRole('link');

afterEach(() => act(() => resetToasts()));

describe('DataTable', () => {
  it('renders a semantic table with counts, typed cells and row indexes', async () => {
    // Three rows cover every cell type; a short fixture keeps this axe pass fast on a loaded runner.
    renderTable({ totalCount: 424 }, 3);
    const table = screen.getByRole('table', { name: 'Register' });
    expect(table.getAttribute('aria-rowcount')).toBe('425');
    expect(screen.getByText('424 instances')).toBeTruthy();
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual([
      'ID',
      'Title',
      'Department',
      'Owner',
      'Due date',
      'Status',
      'Criticality',
      'Evidence',
      'Penalty',
    ]);
    expect(headers[1]!.getAttribute('aria-sort')).toBe('none');
    expect(headers[3]!.getAttribute('aria-sort')).toBeNull();
    expect(headers[8]!.className).toContain('text-right');

    const first = within(table).getAllByRole('row')[1]!;
    expect(first.getAttribute('aria-rowindex')).toBe('2');
    const cells = within(first).getAllByRole('cell');
    expect(cells[0]!.textContent).toBe('TAX-CL-001');
    expect(within(cells[1]!).getByRole('link', { name: 'Obligation 1' }).getAttribute('href')).toBe(
      '#/i/TAX-CL-001',
    );
    expect(cells[1]!.textContent).toContain('Factories Act, 1948');
    expect(cells[3]!.textContent).toBe('Unassigned');
    expect(cells[4]!.textContent).toBe('1 Mar 2027');
    expect(cells[5]!.textContent).toContain('Overdue 3 days');
    expect(cells[6]!.textContent).toBe('Super critical');
    expect(within(cells[7]!).getByRole('progressbar', { name: 'Evidence' })).toBeTruthy();
    expect(cells[8]!.className).toContain('text-right');
    // Second row has an owner.
    expect(within(table).getAllByRole('row')[2]!.textContent).toContain('Owner 1');
    await expectNoAxeViolations();
  });

  it('renders only the rows in view (virtualised) at 10,000 rows', () => {
    renderTable({ maxHeight: 440 }, 10_000);
    const rendered = screen.getAllByRole('row').length - 1;
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(40);
    expect(screen.getByText('10,000 instances')).toBeTruthy();
  });

  it('is one tab stop; arrows, Home and End move between row links', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.tab(); // density
    await user.tab(); // columns
    await user.tab(); // first sortable header…
    for (let i = 0; i < 7; i += 1) await user.tab(); // …through the sortable headers
    expect(document.activeElement).toBe(rowLinks()[0]);
    expect(rowLinks().filter((l) => l.tabIndex === 0)).toHaveLength(1);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Obligation 3');
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement?.textContent).toBe('Obligation 2');
    await user.keyboard('{End}');
    expect(document.activeElement?.textContent).toBe('Obligation 12');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Obligation 12');
    await user.keyboard('{Home}{ArrowUp}');
    expect(document.activeElement?.textContent).toBe('Obligation 1');
    await user.tab();
    expect(document.activeElement?.closest('table')).toBeNull();
  });

  it('cycles sort none, ascending, descending from the header', async () => {
    const user = userEvent.setup();
    const onSortingChange = vi.fn();
    renderTable({ onSortingChange });
    const header = screen.getByRole('columnheader', { name: 'Title' });
    const button = within(header).getByRole('button');
    button.focus();
    await user.keyboard('{Enter}');
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(onSortingChange).toHaveBeenLastCalledWith([{ id: 'title', desc: false }]);
    expect(rowLinks()[1]!.textContent).toBe('Obligation 10');
    await user.keyboard(' ');
    expect(header.getAttribute('aria-sort')).toBe('descending');
    expect(rowLinks()[0]!.textContent).toBe('Obligation 9');
    await user.keyboard('{Enter}');
    expect(header.getAttribute('aria-sort')).toBe('none');
    expect(rowLinks()[0]!.textContent).toBe('Obligation 1');

    // Alt+Arrow resizes the column.
    const colWidth = () =>
      (screen.getByRole('table').querySelectorAll('col')[1] as HTMLElement).style.width;
    expect(colWidth()).toBe('280px');
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(colWidth()).toBe('296px');
    await user.keyboard('{Alt>}{ArrowLeft}{ArrowLeft}{/Alt}');
    expect(colWidth()).toBe('264px');
  });

  it('honours controlled, server-side sorting', async () => {
    const user = userEvent.setup();
    const onSortingChange = vi.fn();
    renderTable({ sorting: [{ id: 'due', desc: true }], manualSorting: true, onSortingChange });
    expect(screen.getByRole('columnheader', { name: 'Due date' }).getAttribute('aria-sort')).toBe(
      'descending',
    );
    // Server order is kept.
    expect(rowLinks()[0]!.textContent).toBe('Obligation 1');
    await user.click(within(screen.getByRole('columnheader', { name: 'ID' })).getByRole('button'));
    expect(onSortingChange).toHaveBeenLastCalledWith([{ id: 'id', desc: false }]);
  });

  it('selects with Space, Shift+Space and Ctrl+A, and runs bulk actions', async () => {
    const user = userEvent.setup();
    const approve = vi.fn();
    const onChange = vi.fn();
    renderTable({
      totalCount: 424,
      selection: {
        bulkActions: [{ label: 'Approve', icon: CheckCheck, onClick: approve }],
        onChange,
      },
    });
    rowLinks()[0]!.focus();
    await user.keyboard(' ');
    expect(
      screen
        .getByRole('checkbox', { name: 'Select TAX-CL-001, Obligation 1' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('1 selected');
    expect(screen.getByText('1 selected', { selector: 'span:not([role])' })).toBeTruthy();
    await user.keyboard('{ArrowDown}{ArrowDown}{Shift>} {/Shift}');
    expect(onChange).toHaveBeenLastCalledWith(['TAX-CL-001', 'TAX-CL-002', 'TAX-CL-003']);
    expect(
      screen.getByRole('checkbox', { name: 'Select all rows' }).getAttribute('aria-checked'),
    ).toBe('mixed');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(approve).toHaveBeenCalledWith(['TAX-CL-001', 'TAX-CL-002', 'TAX-CL-003']);

    rowLinks()[2]!.focus();
    await user.keyboard('{Control>}a{/Control}');
    expect(screen.getByRole('status').textContent).toBe('12 selected');
    await user.click(screen.getByRole('button', { name: 'Select all 424' }));
    expect(screen.getByRole('status').textContent).toBe('424 selected');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(approve).toHaveBeenLastCalledWith('all');
    await expectNoAxeViolations();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('424 instances')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('selects with the checkboxes, shift-click for a range, and the header box', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderTable({ selection: { bulkActions: [], onChange } });
    await user.click(screen.getByRole('checkbox', { name: /^Select TAX-CL-002/ }));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('checkbox', { name: /^Select TAX-CL-004/ }));
    await user.keyboard('{/Shift}');
    expect(onChange).toHaveBeenLastCalledWith(['TAX-CL-002', 'TAX-CL-003', 'TAX-CL-004']);
    const selectedRow = screen.getByRole('checkbox', { name: /^Select TAX-CL-003/ }).closest('tr')!;
    expect(selectedRow.hasAttribute('data-selected')).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.arrayContaining(['TAX-CL-012']));
    await user.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('follows the title link when a row is clicked', async () => {
    const user = userEvent.setup();
    const clicks: string[] = [];
    renderTable({
      renderLink: ({ children, href, ...rest }) => (
        <a
          {...rest}
          href={href}
          onClick={(e) => {
            e.preventDefault();
            rest.onClick?.(e);
            clicks.push(href);
          }}
        >
          {children}
        </a>
      ),
    });
    await user.click(screen.getAllByRole('row')[3]!.querySelectorAll('td')[2]!);
    expect(clicks).toEqual(['#/i/TAX-CL-003']);
    await user.click(rowLinks()[0]!);
    expect(clicks).toEqual(['#/i/TAX-CL-003', '#/i/TAX-CL-001']);
  });

  it('copies an ID and confirms with a toast', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderTable();
    await user.click(screen.getByRole('button', { name: 'Copy ID TAX-CL-001' }));
    expect(writeText).toHaveBeenCalledWith('TAX-CL-001');
    expect(await screen.findByText('Copied ID')).toBeTruthy();
    writeText.mockRejectedValueOnce(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy ID TAX-CL-002' }));
    expect(await screen.findByText("Couldn't copy the ID.")).toBeTruthy();
  });

  it('chooses, reorders and resets columns', async () => {
    const user = userEvent.setup();
    const onColumnsChange = vi.fn();
    renderTable({ onColumnsChange });
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    const chooser = screen.getByRole('dialog', { name: 'Choose columns' });
    expect(within(chooser).getByRole('checkbox', { name: 'Title (always shown)' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(within(chooser).getByRole('checkbox', { name: 'Department' }));
    expect(screen.queryByRole('columnheader', { name: 'Department' })).toBeNull();
    expect(onColumnsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ visibility: { department: false } }),
    );

    within(chooser).getByRole('checkbox', { name: 'Owner' }).focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(within(chooser).getByRole('status').textContent).toBe('Owner moved to position 3 of 9');
    await user.keyboard('{Alt>}{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}{/Alt}');
    expect(screen.getAllByRole('columnheader')[0]!.textContent).toBe('Owner');
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    // Drag and drop with the mouse.
    const items = within(chooser).getAllByRole('listitem');
    fireEvent.dragStart(items[8]!);
    fireEvent.dragOver(items[0]!);
    fireEvent.drop(items[0]!);
    expect(screen.getAllByRole('columnheader')[0]!.textContent).toBe('Penalty');

    await user.type(within(chooser).getByRole('textbox', { name: 'Search columns' }), 'crit');
    expect(within(chooser).getAllByRole('listitem')).toHaveLength(1);
    await expectNoAxeViolations(chooser);

    await user.click(within(chooser).getByRole('button', { name: 'Reset to default' }));
    expect(screen.getAllByRole('columnheader')[0]!.textContent).toBe('ID');
    expect(screen.getByRole('columnheader', { name: 'Department' })).toBeTruthy();
  });

  it('switches density and forces comfortable rows on phones', async () => {
    const user = userEvent.setup();
    const onDensityChange = vi.fn();
    const { unmount } = renderTable({ onDensityChange });
    const row = () => screen.getAllByRole('row')[1]!;
    expect(row().style.height).toBe('44px');
    await user.click(screen.getByRole('button', { name: 'Compact rows' }));
    expect(onDensityChange).toHaveBeenCalledWith('compact');
    expect(row().style.height).toBe('36px');
    await user.click(screen.getByRole('button', { name: 'Comfortable rows' }));
    expect(row().style.height).toBe('44px');
    unmount();
    setViewport(375);
    renderTable({ density: 'compact' });
    expect(row().style.height).toBe('44px');
    expect(screen.queryByRole('button', { name: /rows$/ })).toBeNull();
  });

  it('shows loading, refetching, error and empty states', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const { rerender } = renderTable({ loading: true });
    const table = screen.getByRole('table');
    expect(table.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(table.querySelectorAll('tbody tr')).toHaveLength(8);
    expect(screen.queryAllByRole('link')).toHaveLength(0);

    const base = {
      label: 'Register',
      columns,
      rowId: (r: Instance) => r.id,
      rowLabel: (r: Instance) => r.id,
    };
    rerender(<DataTable<Instance> {...base} data={makeRows(3)} refetching />);
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('table').querySelector('.bg-leaf')).toBeTruthy();
    expect(screen.getAllByText(/^Obligation/)).toHaveLength(3);
    // Without rowHref the title is not a link target.
    expect(
      screen.queryAllByRole('link', { name: /Obligation/ })[0]!.getAttribute('aria-disabled'),
    ).toBe('true');

    rerender(
      <DataTable<Instance>
        {...base}
        data={[]}
        error={{ message: 'Check your connection and try again.', retry, errorId: 'req-42' }}
      />,
    );
    expect(screen.getByRole('heading', { name: "Couldn't load the register" })).toBeTruthy();
    expect(screen.getByText('req-42')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();

    rerender(<DataTable<Instance> {...base} data={[]} />);
    expect(screen.getByRole('heading', { name: 'Nothing to show' })).toBeTruthy();
    expect(screen.getByText('0 rows')).toBeTruthy();
    rerender(<DataTable<Instance> {...base} data={[]} empty={<p>No obligations yet</p>} />);
    expect(screen.getByText('No obligations yet')).toBeTruthy();
    rerender(<DataTable<Instance> {...base} data={makeRows(1)} />);
    expect(screen.getByText('1 row')).toBeTruthy();
  });

  it('puts custom cell controls of the focused row in the tab order', async () => {
    const user = userEvent.setup();
    const withActions = [
      ...columns,
      col.display({
        id: 'actions',
        header: 'Actions',
        meta: { type: 'actions' },
        cell: ({ row, table }) => (
          <button
            type="button"
            tabIndex={(table.options.meta as TableContext<Instance>).rowTabIndex(row)}
          >
            Actions for {row.original.id}
          </button>
        ),
      }),
    ];
    renderTable({ columns: withActions });
    expect(
      screen.getByRole('columnheader', { name: 'Actions' }).querySelector('.sr-only'),
    ).toBeTruthy();
    rowLinks()[0]!.focus();
    await user.keyboard('{ArrowDown}');
    await user.tab();
    expect(document.activeElement?.textContent).toBe('Actions for TAX-CL-002');
    await user.tab();
    expect(document.activeElement?.closest('table')).toBeNull();
  });

  it('offers export from the toolbar and renders a saved-view slot', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    renderTable({ onExport, toolbarStart: <span>View: Default</span> });
    expect(screen.getByText('View: Default')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(onExport).toHaveBeenCalled();
  });

  it('hides the toolbar when asked but still shows the bulk bar', async () => {
    const user = userEvent.setup();
    renderTable({
      toolbar: false,
      selection: { bulkActions: [{ label: 'Approve', onClick: () => {} }] },
    });
    expect(screen.queryByText('12 instances')).toBeNull();
    expect(screen.queryByRole('button', { name: /columns/i })).toBeNull();
    await user.click(screen.getAllByRole('checkbox')[1]!);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('keeps the Tab stop on the first displayed row after a sort (audit #1)', async () => {
    const user = userEvent.setup();
    renderTable({}, 200);
    rowLinks()[0]!.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    const header = screen.getByRole('columnheader', { name: 'Title' });
    within(header).getByRole('button').focus();
    await user.keyboard('{Enter}{Enter}');
    expect(header.getAttribute('aria-sort')).toBe('descending');
    const stops = rowLinks().filter((l) => l.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(rowLinks()[0]);
    expect(stops[0]!.textContent).toBe('Obligation 99');
    // Tab on from the header row: the next stop inside the body is that link.
    for (let i = 0; i < 12 && !document.activeElement?.hasAttribute('data-row-link'); i += 1)
      await user.tab();
    expect(document.activeElement).toBe(stops[0]);
  });

  it('focuses the target row in the commit that renders it, with no timers or animation frames', () => {
    renderTable({}, 200);
    // Frames never run, so focus can only come from the commit itself.
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    try {
      const first = rowLinks()[0]!;
      first.focus();
      fireEvent.keyDown(first, { key: 'End' });
      // Synchronously after the key press: the last row is rendered and focused, and no frame was needed.
      const last = document.querySelector<HTMLElement>('[data-row-index="199"] [data-row-link]');
      expect(document.activeElement).toBe(last);
      fireEvent.keyDown(last!, { key: 'Home' });
      expect(document.activeElement).toBe(
        document.querySelector('[data-row-index="0"] [data-row-link]'),
      );
    } finally {
      raf.mockRestore();
    }
  });

  it('drops a pending focus move when the user goes elsewhere, so it never pulls focus back (re-audit #2)', () => {
    const { rerender } = render(
      <>
        <input aria-label="Search" />
        <DataTable
          label="Register"
          columns={columns}
          data={makeRows(50)}
          rowId={(r) => r.id}
          rowLabel={(r) => r.id}
        />
      </>,
    );
    const [first, second] = rowLinks();
    first!.focus();
    // The next row cannot take focus yet, so the request stays open.
    const realFocus = HTMLElement.prototype.focus;
    let refuse = true;
    const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === second && refuse) return;
      realFocus.call(this);
    });
    try {
      fireEvent.keyDown(first!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(first);
      const search = screen.getByRole('textbox', { name: 'Search' });
      search.focus();
      refuse = false;
      // A later commit that renders different rows would retry the request; it must stay with the user.
      rerender(
        <>
          <input aria-label="Search" />
          <DataTable
            label="Register"
            columns={columns}
            data={makeRows(60)}
            rowId={(r) => r.id}
            rowLabel={(r) => r.id}
          />
        </>,
      );
      expect(document.activeElement).toBe(search);
    } finally {
      focus.mockRestore();
    }
  });

  it('drops selected rows that leave the data, so bulk actions never reach them (audit #3)', async () => {
    const user = userEvent.setup();
    const approve = vi.fn();
    const onChange = vi.fn();
    const rows = makeRows(5);
    const props = {
      label: 'Register',
      columns,
      rowId: (r: Instance) => r.id,
      rowLabel: (r: Instance) => r.id,
      selection: { bulkActions: [{ label: 'Approve', onClick: approve }], onChange },
    };
    const { rerender } = render(<DataTable<Instance> {...props} data={rows} totalCount={5} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select TAX-CL-004' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select TAX-CL-001' }));
    expect(screen.getByRole('status').textContent).toBe('2 selected');
    rerender(
      <DataTable<Instance>
        {...props}
        data={rows.filter((r) => r.id !== 'TAX-CL-004')}
        totalCount={4}
      />,
    );
    expect(onChange).toHaveBeenLastCalledWith(['TAX-CL-001']);
    expect(screen.getByRole('status').textContent).toBe('1 selected');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(approve).toHaveBeenCalledWith(['TAX-CL-001']);
  });

  it('ends "all matching" when the matching count changes', async () => {
    const user = userEvent.setup();
    const approve = vi.fn();
    const props = {
      label: 'Register',
      columns,
      rowId: (r: Instance) => r.id,
      rowLabel: (r: Instance) => r.id,
      selection: { bulkActions: [{ label: 'Approve', onClick: approve }] },
    };
    const rows = makeRows(5);
    const { rerender } = render(<DataTable<Instance> {...props} data={rows} totalCount={40} />);
    await user.click(screen.getByRole('checkbox', { name: /Select all/ }));
    await user.click(screen.getByRole('button', { name: /Select all 40/ }));
    rerender(<DataTable<Instance> {...props} data={rows} totalCount={12} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(approve).toHaveBeenCalledWith(rows.map((r) => r.id));
  });

  it('clears the Shift-select anchor when the order changes (audit #8a)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderTable({ selection: { bulkActions: [], onChange } }, 10);
    rowLinks()[2]!.focus();
    await user.keyboard(' ');
    const header = screen.getByRole('columnheader', { name: 'Title' });
    within(header).getByRole('button').focus();
    await user.keyboard('{Enter}{Enter}');
    rowLinks()[0]!.focus();
    await user.keyboard('{ArrowDown}{Shift>} {/Shift}');
    // Without a stale anchor, Shift+Space on the second row selects only that row (plus the earlier pick).
    expect(onChange.mock.calls.at(-1)![0]).toHaveLength(2);
  });
});
