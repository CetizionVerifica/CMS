import type { DryRunReport, ImportIssueGroup } from '@canopy/contracts';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Result = { ok: true; value?: unknown } | { ok: false; message: string };

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const actions = vi.hoisted(() => ({
  startImportAction: vi.fn(),
  confirmUploadAction: vi.fn(),
  mapAndParseAction: vi.fn(),
  decideAction: vi.fn(),
  acceptAllAction: vi.fn(),
  dryRunAction: vi.fn(),
  commitAction: vi.fn(),
  cancelAction: vi.fn(),
}));
vi.mock('./actions', () => actions);
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { CancelImport } = await import('./CancelImport');
const { CommitStep } = await import('./CommitStep');
const { Committed } = await import('./Committed');
const { ImportHistory } = await import('./ImportHistory');
const { ImportSteps } = await import('./ImportSteps');
const { MapStep } = await import('./MapStep');
const { ReviewStep } = await import('./ReviewStep');
const { UploadStep } = await import('./UploadStep');
const { Waiting } = await import('./Waiting');

const CLIENT = '00000000-0000-5000-8000-000000000101';
const BATCH = '00000000-0000-5000-8000-0000000000b1';
const ok = (value?: unknown): Result => ({ ok: true, value });
const no = (message: string): Result => ({ ok: false, message });

const group = (overrides: Partial<ImportIssueGroup> = {}): ImportIssueGroup => ({
  groupKey: 'ALIAS_DEPARTMENT:hr',
  type: 'ALIAS_DEPARTMENT',
  severity: 'WARNING',
  field: 'department',
  rawValues: ['HR', 'Human Resources'],
  proposal: 'Human Resources',
  decision: 'PENDING',
  editedValue: null,
  rowNumbers: [3, 5],
  issueIds: [BATCH],
  ...overrides,
});

const report = (overrides: Partial<DryRunReport> = {}): DryRunReport => ({
  create: {
    acts: 2,
    categories: 0,
    departments: 0,
    people: 0,
    obligations: 0,
    assignments: 0,
    instances: 420,
    companies: 0,
    units: 0,
    locations: 0,
  },
  update: { obligations: 0, assignments: 0, instances: 2 },
  unchanged: { instances: 1 },
  skippedRows: 0,
  blockingErrors: 0,
  ...overrides,
});

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  router.push.mockReset();
  router.refresh.mockReset();
});

describe('ImportSteps', () => {
  it('marks the current step and the finished ones', () => {
    const { rerender } = render(<ImportSteps current="review" />);
    const items = within(screen.getByRole('list', { name: 'Import steps' })).getAllByRole(
      'listitem',
    );
    expect(items.map((i) => i.getAttribute('aria-current'))).toEqual([null, null, 'step', null]);
    expect(items[0]!.textContent).toContain('(done)');
    expect(items[3]!.textContent).not.toContain('(done)');
    rerender(<ImportSteps current="commit" done />);
    expect(screen.getAllByText(/\(done\)/)).toHaveLength(4);
    expect(document.querySelector('[aria-current]')).toBeNull();
  });
});

describe('UploadStep', () => {
  const sample = () =>
    new File([new Uint8Array([1, 2, 3])], 'register.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  const choose = (file: File) =>
    userEvent.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);

  afterEach(() => vi.unstubAllGlobals());

  it('sends the workbook, confirms its hash and opens the mapping', async () => {
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', put);
    actions.startImportAction.mockResolvedValue(
      ok({ batchId: BATCH, upload: { url: 'https://files.test/x', headers: { a: 'b' } } }),
    );
    actions.confirmUploadAction.mockResolvedValue(ok());
    render(<UploadStep clientId={CLIENT} />);
    await choose(sample());
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith(`/c/${CLIENT}/import?batch=${BATCH}`),
    );
    expect(actions.startImportAction).toHaveBeenCalledWith(CLIENT, {
      fileName: 'register.xlsx',
      sizeBytes: 3,
    });
    expect(put).toHaveBeenCalledWith(
      'https://files.test/x',
      expect.objectContaining({ method: 'PUT' }),
    );
    // SHA-256 of the bytes 01 02 03.
    expect(actions.confirmUploadAction).toHaveBeenCalledWith(
      CLIENT,
      BATCH,
      '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
    );
  });

  it('says why the upload stopped', async () => {
    actions.startImportAction.mockResolvedValue(no('You can no longer import for this client.'));
    render(<UploadStep clientId={CLIENT} />);
    await choose(sample());
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You can no longer import for this client.',
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it('reports a failed PUT, a failed confirm and a thrown error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    actions.startImportAction.mockResolvedValue(
      ok({ batchId: BATCH, upload: { url: 'https://files.test/x', headers: {} } }),
    );
    const { unmount } = render(<UploadStep clientId={CLIENT} />);
    await choose(sample());
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The workbook did not upload. Try again.',
    );
    unmount();

    actions.startImportAction.mockResolvedValue(ok({ batchId: BATCH, upload: null }));
    actions.confirmUploadAction.mockResolvedValue(no('The workbook could not be read.'));
    const second = render(<UploadStep clientId={CLIENT} />);
    await choose(sample());
    expect((await screen.findByRole('alert')).textContent).toBe('The workbook could not be read.');
    second.unmount();

    actions.startImportAction.mockRejectedValue(new Error('network'));
    render(<UploadStep clientId={CLIENT} />);
    await choose(sample());
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The workbook did not upload. Try again.',
    );
  });
});

describe('MapStep', () => {
  const mapping = [
    { sourceHeader: 'Due Date', field: 'dueDate' as const },
    { sourceHeader: 'Notes', field: null },
  ];

  it('saves the mapping with the template name and waits on the parse', async () => {
    actions.mapAndParseAction.mockResolvedValue(ok());
    render(
      <MapStep
        clientId={CLIENT}
        batchId={BATCH}
        fileName="register.xlsx"
        sheetName="Sheet1"
        mapping={mapping}
      />,
    );
    expect(screen.getByText(/1 of 2 columns are mapped/)).toBeTruthy();
    expect(
      screen.getByRole('combobox', { name: 'Register field for “Due Date”' }).textContent,
    ).toBe('Due date');
    await userEvent.type(
      screen.getByLabelText('Save this mapping as a template (optional)'),
      'Export',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Read the rows' }));
    expect(actions.mapAndParseAction).toHaveBeenCalledWith(
      CLIENT,
      BATCH,
      'Sheet1',
      [
        { sourceHeader: 'Due Date', field: 'dueDate' },
        { sourceHeader: 'Notes', field: null },
      ],
      'Export',
    );
    expect(router.push).toHaveBeenCalledWith(`/c/${CLIENT}/import?batch=${BATCH}&parsing=1`);
  });

  it('shows a refusal and stays on the step', async () => {
    actions.mapAndParseAction.mockResolvedValue(no('This import moved on in another tab.'));
    render(
      <MapStep
        clientId={CLIENT}
        batchId={BATCH}
        fileName="r.xlsx"
        sheetName="S"
        mapping={mapping}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Read the rows' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This import moved on in another tab.',
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it('holds the parse while a field comes from two columns, or nothing is mapped', async () => {
    const { unmount } = render(
      <MapStep
        clientId={CLIENT}
        batchId={BATCH}
        fileName="r.xlsx"
        sheetName="S"
        mapping={[
          { sourceHeader: 'A', field: 'owner' },
          { sourceHeader: 'B', field: 'owner' },
        ]}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Choose one column for Owner');
    const read = screen.getByRole('button', { name: /Read the rows/ });
    expect(read.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(read);
    expect(actions.mapAndParseAction).not.toHaveBeenCalled();
    unmount();

    render(
      <MapStep
        clientId={CLIENT}
        batchId={BATCH}
        fileName="r.xlsx"
        sheetName="S"
        mapping={[{ sourceHeader: 'A', field: null }]}
      />,
    );
    expect(
      screen.getByRole('button', { name: /Read the rows/ }).getAttribute('aria-disabled'),
    ).toBe('true');
  });
});

describe('ReviewStep', () => {
  const groups = [
    group(),
    group({ groupKey: 'ALIAS_ACT:factories', type: 'ALIAS_ACT', field: 'act', proposal: null }),
    group({ groupKey: 'done', decision: 'EDITED', editedValue: 'People team', rawValues: [''] }),
    group({
      groupKey: 'info',
      severity: 'INFO',
      type: 'NULL_PLACEHOLDER',
      field: null,
      proposal: null,
    }),
  ];

  it('shows the workbook values next to the proposal, in sections by what to do', () => {
    render(<ReviewStep clientId={CLIENT} batchId={BATCH} groups={groups} />);
    expect(screen.getByText(/2 groups of rows need a decision/)).toBeTruthy();
    const decide = screen.getByRole('region', { name: 'Needs a decision' });
    const hr = within(decide).getAllByRole('listitem')[0]!;
    expect(hr.textContent).toContain('In the workbook: “HR”, “Human Resources”');
    expect(hr.textContent).toContain('Proposed: “Human Resources”');
    expect(hr.textContent).toContain('Rows 3 and 5');
    const decided = screen.getByRole('region', { name: 'Decided' });
    expect(decided.textContent).toContain('(empty)');
    expect(decided.textContent).toContain('Changed to “People team”');
    expect(screen.getByRole('region', { name: 'For information' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Stops the import' })).toBeNull();
    expect(
      screen.getByRole('button', { name: /Run the dry run/ }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('accepts every proposal, then refreshes', async () => {
    actions.acceptAllAction.mockResolvedValue(ok());
    render(<ReviewStep clientId={CLIENT} batchId={BATCH} groups={groups} />);
    await userEvent.click(screen.getByRole('button', { name: 'Accept every proposal (1)' }));
    expect(actions.acceptAllAction).toHaveBeenCalledWith(CLIENT, BATCH, ['ALIAS_DEPARTMENT:hr']);
    expect(router.refresh).toHaveBeenCalled();
  });

  it('decides one group three ways', async () => {
    actions.decideAction.mockResolvedValue(ok());
    render(<ReviewStep clientId={CLIENT} batchId={BATCH} groups={groups} />);
    const decide = screen.getByRole('region', { name: 'Needs a decision' });
    const [hr, factories] = within(decide).getAllByRole('listitem') as [HTMLElement, HTMLElement];
    await userEvent.click(within(hr).getByRole('button', { name: 'Use “Human Resources”' }));
    expect(actions.decideAction).toHaveBeenLastCalledWith(CLIENT, BATCH, 'ALIAS_DEPARTMENT:hr', {
      decision: 'ACCEPTED',
    });
    await userEvent.click(within(factories).getByRole('button', { name: 'Keep as written' }));
    expect(actions.decideAction).toHaveBeenLastCalledWith(CLIENT, BATCH, 'ALIAS_ACT:factories', {
      decision: 'REJECTED',
    });
    const other = within(factories).getByRole('button', { name: 'Use another value' });
    await userEvent.click(other);
    expect(other.getAttribute('aria-expanded')).toBe('true');
    const save = within(factories).getByRole('button', { name: /Save value/ });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(save);
    expect(actions.decideAction).toHaveBeenCalledTimes(2);
    await userEvent.type(
      within(factories).getByLabelText('Value to use'),
      '  Factories Act, 1948 ',
    );
    await userEvent.click(within(factories).getByRole('button', { name: 'Save value' }));
    expect(actions.decideAction).toHaveBeenLastCalledWith(CLIENT, BATCH, 'ALIAS_ACT:factories', {
      decision: 'EDITED',
      editedValue: 'Factories Act, 1948',
    });
  });

  it('lets a decided group be changed', async () => {
    actions.decideAction.mockResolvedValue(ok());
    render(<ReviewStep clientId={CLIENT} batchId={BATCH} groups={groups} />);
    const decided = screen.getByRole('region', { name: 'Decided' });
    await userEvent.click(
      within(decided).getByRole('button', {
        name: 'Change the decision on department names that look the same, Rows 3 and 5',
      }),
    );
    await userEvent.click(within(decided).getByRole('button', { name: 'Keep as written' }));
    expect(actions.decideAction).toHaveBeenCalledWith(CLIENT, BATCH, 'done', {
      decision: 'REJECTED',
    });
  });

  it('runs the dry run when everything is decided, and shows a refusal', async () => {
    const decidedOnly = [group({ decision: 'ACCEPTED' })];
    actions.dryRunAction.mockResolvedValueOnce(no('This import moved on in another tab.'));
    render(<ReviewStep clientId={CLIENT} batchId={BATCH} groups={decidedOnly} />);
    expect(screen.getByText(/Every group is decided/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Accept every proposal/ })).toBeNull();
    const run = screen.getByRole('button', { name: 'Run the dry run' });
    await userEvent.click(run);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This import moved on in another tab.',
    );
    expect(router.refresh).toHaveBeenCalled();
    actions.dryRunAction.mockResolvedValueOnce(ok());
    await userEvent.click(run);
    expect(router.push).toHaveBeenCalledWith(`/c/${CLIENT}/import?batch=${BATCH}`);
  });

  it('says when the workbook has errors that stop the import', () => {
    render(
      <ReviewStep
        clientId={CLIENT}
        batchId={BATCH}
        groups={[
          group({
            groupKey: 'e',
            severity: 'ERROR',
            type: 'INVALID_DATE',
            field: 'dueDate',
            proposal: null,
          }),
        ]}
      />,
    );
    expect(screen.getByText(/1 problem stops this import/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Stops the import' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Run the dry run/ }).getAttribute('aria-disabled'),
    ).toBe('true');
  });
});

describe('CommitStep', () => {
  it('lists the dry run and commits after the confirmation', async () => {
    actions.commitAction.mockResolvedValue(ok());
    render(
      <CommitStep clientId={CLIENT} clientName="Demo Metals" batchId={BATCH} report={report()} />,
    );
    const add = screen.getByRole('region', { name: 'To add' });
    expect(add.textContent).toContain('Instances420');
    expect(screen.getByRole('region', { name: 'To update' }).textContent).toContain('Instances2');
    expect(screen.getByText(/1 instance is already in the register/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Change decisions' }).getAttribute('href')).toBe(
      `/c/${CLIENT}/import?batch=${BATCH}&step=review`,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Commit the import' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Commit this import to Demo Metals?' });
    expect(dialog.textContent).toContain('422 instances will be added or updated');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Commit the import' }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(actions.commitAction).toHaveBeenCalledWith(CLIENT, BATCH);
  });

  it('shows a refused commit', async () => {
    actions.commitAction.mockResolvedValue(no('Errors in the import stop the commit.'));
    render(
      <CommitStep clientId={CLIENT} clientName="Demo Metals" batchId={BATCH} report={report()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Commit the import' }));
    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Commit the import' }));
    // The dialog closes so the reason, not the dialog's generic line, is what the person reads.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('alert').textContent).toBe('Errors in the import stop the commit.');
    expect(router.refresh).toHaveBeenCalled();
  });

  it('holds the commit while rows have errors, and says what is skipped', () => {
    render(
      <CommitStep
        clientId={CLIENT}
        clientName="Demo Metals"
        batchId={BATCH}
        report={report({
          update: { obligations: 0, assignments: 0, instances: 0 },
          unchanged: { instances: 3 },
          skippedRows: 2,
          blockingErrors: 1,
        })}
      />,
    );
    expect(screen.getByText('Nothing to update.')).toBeTruthy();
    expect(
      screen.getByText(/3 instances are already in the register .* 2 rows are skipped\./),
    ).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('1 row has errors');
    expect(
      screen.getByRole('button', { name: /Commit the import/ }).getAttribute('aria-disabled'),
    ).toBe('true');
  });
});

describe('CancelImport', () => {
  it('cancels after the confirmation and reloads the batch', async () => {
    actions.cancelAction.mockResolvedValue(ok());
    render(<CancelImport clientId={CLIENT} batchId={BATCH} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel import' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this import?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel import' }));
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith(`/c/${CLIENT}/import?batch=${BATCH}`),
    );
  });

  it('shows a refused cancel', async () => {
    actions.cancelAction.mockResolvedValue(no('This import moved on in another tab.'));
    render(<CancelImport clientId={CLIENT} batchId={BATCH} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel import' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel import' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('alert').textContent).toBe('This import moved on in another tab.');
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe('Waiting', () => {
  it('asks the server again until the page changes', () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<Waiting message="Reading the rows…" intervalMs={1000} />);
      expect(screen.getByRole('status').textContent).toBe('Reading the rows…');
      act(() => vi.advanceTimersByTime(2500));
      expect(router.refresh).toHaveBeenCalledTimes(2);
      unmount();
      act(() => vi.advanceTimersByTime(5000));
      expect(router.refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Committed and ImportHistory', () => {
  it('says what was imported and links onward', () => {
    render(<Committed clientId={CLIENT} clientName="Demo Metals" fileName="r.xlsx" rows={1} />);
    expect(screen.getByRole('status').textContent).toBe(
      "1 row from r.xlsx are now in Demo Metals's compliance register.",
    );
    expect(screen.getByRole('link', { name: 'Open the overview' }).getAttribute('href')).toBe(
      `/c/${CLIENT}/overview`,
    );
  });

  it('lists imports with a link to continue the open ones', () => {
    render(
      <ImportHistory
        timeZone="Asia/Kolkata"
        items={[
          {
            id: BATCH,
            fileName: 'register.xlsx',
            startedAt: '2026-10-24T05:00:00Z',
            status: 'Needs review',
            rows: 422,
            open: true,
            href: `/c/${CLIENT}/import?batch=${BATCH}`,
          },
          {
            id: CLIENT,
            fileName: 'old.xlsx',
            startedAt: '2026-10-01T05:00:00Z',
            status: 'Cancelled',
            rows: null,
            open: false,
            href: `/c/${CLIENT}/import?batch=${CLIENT}`,
          },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Imports' });
    const [, open, closed] = within(table).getAllByRole('row') as HTMLElement[];
    expect(open!.textContent).toContain('Needs review · continue');
    expect(open!.textContent).toContain('422');
    expect(closed!.textContent).toContain('Cancelled');
    expect(closed!.textContent).toContain('—');
    expect(within(table).getByRole('link', { name: 'register.xlsx' }).getAttribute('href')).toBe(
      `/c/${CLIENT}/import?batch=${BATCH}`,
    );
  });
});
