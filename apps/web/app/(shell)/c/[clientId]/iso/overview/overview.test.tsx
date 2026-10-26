import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ISO } from '../_test/fixture';

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/c/c1/iso/overview',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: nav.push, refresh: nav.refresh, replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _p,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    prefetch?: boolean;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const actions = vi.hoisted(() => ({ isoWrite: vi.fn(), isoRead: vi.fn() }));
vi.mock('../_lib/actions', () => actions);

const { MyActionsCard, SystemOverview } = await import('./OverviewView');
const { NewSystem, SystemSetup } = await import('./SystemSetup');

const C = 'c1';
const view = ISO.overview.systems[0]!;
const units = ISO.units.map((u) => ({ id: u.id, name: u.name }));
const ok = <T,>(data: T) => ({ ok: true as const, data });

beforeEach(() => {
  actions.isoWrite.mockReset();
  actions.isoWrite.mockResolvedValue(ok({}));
  nav.refresh.mockReset();
});

describe('SystemOverview', () => {
  it('shows readiness per standard, the gates and counts, each linked', () => {
    render(
      <SystemOverview
        clientId={C}
        system={view}
        standards={ISO.standards}
        missing={{
          unitNames: Object.fromEntries(units.map((u) => [u.id, u.name])),
          inputDefs: ISO.defs.inputs,
        }}
        clauseNumbers={Object.fromEntries(ISO.clauses.map((c) => [c.id, c.number]))}
      />,
    );
    expect(screen.getByRole('heading', { name: /^Clause readiness/ })).toBeTruthy();
    const qms = screen.getByRole('list', { name: 'ISO 9001 checklist' });
    const implemented = within(qms).getByRole('link', { name: /implemented/ });
    expect(implemented.getAttribute('href')).toMatch(
      /\/c\/c1\/iso\/checklist\?system=.*status=IMPLEMENTED/,
    );
    expect(screen.getAllByRole('list', { name: /certification gates/ })).toHaveLength(3);
    expect(screen.getAllByText('Not met').length).toBeGreaterThan(0);
    const docs = screen.getByRole('region', { name: 'Documents' });
    expect(
      within(docs)
        .getByRole('link', { name: /revision in review/ })
        .getAttribute('href'),
    ).toMatch(/\/iso\/documents\?ids=/);
    expect(screen.getByRole('region', { name: 'Next management review' }).textContent).toMatch(
      /ISO 9001/,
    );
    expect(screen.getByRole('region', { name: 'Audit programme' }).textContent).toMatch(
      /not yet covered/,
    );
    expect(screen.getByRole('region', { name: 'Incidents this year' }).textContent).toMatch(
      /All incidents/,
    );
  });

  it('says when a count has too many records to name in its link', () => {
    const many = Array.from({ length: 201 }, (_, i) => `d${i}`);
    render(
      <SystemOverview
        clientId={C}
        system={{ ...view, documents: { ...view.documents, inReview: { count: 201, ids: many } } }}
        standards={ISO.standards}
        missing={{ unitNames: {}, inputDefs: [] }}
        clauseNumbers={{}}
      />,
    );
    const docs = screen.getByRole('region', { name: 'Documents' });
    const link = within(docs).getByRole('link', { name: /^201 revision in review, / });
    expect(link.getAttribute('href')).toBe(
      `/c/${C}/iso/documents?managementSystemId=${view.managementSystemId}`,
    );
    expect(within(docs).getByText(/all of the system's records/)).toBeTruthy();
  });

  it('shows a count of 0 without a link, since there is nothing to open', () => {
    render(
      <SystemOverview
        clientId={C}
        system={{ ...view, documents: { ...view.documents, reviewOverdue: { count: 0, ids: [] } } }}
        standards={ISO.standards}
        missing={{ unitNames: {}, inputDefs: [] }}
        clauseNumbers={{}}
      />,
    );
    const docs = screen.getByRole('region', { name: 'Documents' });
    expect(within(docs).queryByRole('link', { name: /review overdue/ })).toBeNull();
    expect(within(docs).getByText('0')).toBeTruthy();
  });

  it('warns about climate gaps and copes with no programme', () => {
    render(
      <SystemOverview
        clientId={C}
        system={{ ...view, climateGaps: ['UNDECIDED', 'RELEVANT_NO_RISK'], auditProgramme: null }}
        standards={ISO.standards}
        missing={{ unitNames: {}, inputDefs: [] }}
        clauseNumbers={{}}
      />,
    );
    const climate = screen.getByRole('region', { name: 'Climate change' });
    expect(within(climate).getAllByRole('link', { name: 'Go there' })).toHaveLength(2);
    expect(screen.getByText('No audit programme for this year yet.')).toBeTruthy();
  });

  it('takes the person to their own open actions', () => {
    render(<MyActionsCard clientId={C} />);
    expect(screen.getByRole('link', { name: 'Open my actions' }).getAttribute('href')).toBe(
      '/c/c1/iso/actions?owner=me&state=OPEN',
    );
  });
});

const setup = (canEdit = true, over: Partial<typeof ISO.system> = {}) =>
  render(
    <SystemSetup
      clientId={C}
      system={{ ...ISO.system, ...over }}
      standards={ISO.standards}
      units={units}
      contextItems={ISO.contextItems}
      canEdit={canEdit}
      today="2024-11-15"
    />,
  );

describe('SystemSetup', () => {
  it('shows the set-up read-only to someone who can’t change it', () => {
    setup(false);
    expect(screen.getByText(ISO.system.scopeStatement!)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit system' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add issue or party' })).toBeNull();
    expect(screen.getByRole('table', { name: 'Issues and interested parties' })).toBeTruthy();
  });

  it('edits the system, sending only what changed; standards can only be added', async () => {
    setup(true, { standardIds: ISO.system.standardIds.slice(0, 2) });
    await userEvent.click(screen.getByRole('button', { name: 'Edit system' }));
    const drawer = screen.getByRole('dialog', { name: 'Edit system' });
    const kept = within(drawer).getByRole('checkbox', { name: /^ISO 9001/ });
    expect(
      kept.hasAttribute('disabled') ||
        kept.getAttribute('aria-disabled') === 'true' ||
        kept.hasAttribute('data-disabled'),
    ).toBe(true);
    await userEvent.click(within(drawer).getByRole('checkbox', { name: /^ISO 45001/ }));
    const months = within(drawer).getByRole('textbox', {
      name: 'Months between management reviews',
    });
    await userEvent.clear(months);
    await userEvent.type(months, '40');
    expect(within(drawer).getByText('Enter a whole number from 1 to 36.')).toBeTruthy();
    await userEvent.clear(months);
    await userEvent.type(months, '6');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save system' }));
    await waitFor(() => expect(actions.isoWrite).toHaveBeenCalled());
    expect(actions.isoWrite).toHaveBeenCalledWith(
      C,
      'updateIsoSystem',
      { id: ISO.system.id },
      {
        version: ISO.system.version,
        standardIds: ISO.system.standardIds,
        reviewIntervalMonths: 6,
      },
    );
  });

  it('records the climate decision with its reasons', async () => {
    setup(true, {
      climateChangeRelevant: null,
      climateChangeRationale: null,
      climateDecidedOn: null,
    });
    expect(screen.getByText('Not decided yet')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Record climate decision' }));
    const drawer = screen.getByRole('dialog', { name: 'Climate decision' });
    await userEvent.click(within(drawer).getByRole('radio', { name: 'No, it is not relevant' }));
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Reasons' }),
      'Indoor work only.',
    );
    await userEvent.click(within(drawer).getByRole('button', { name: 'Record decision' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'setIsoClimateDecision',
        { id: ISO.system.id },
        {
          version: ISO.system.version,
          climateChangeRelevant: false,
          climateChangeRationale: 'Indoor work only.',
          climateDecidedOn: '2024-11-15',
        },
      ),
    );
  });

  it('adds, edits and archives issues and interested parties', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Add issue or party' }));
    let drawer = screen.getByRole('dialog', { name: 'Add issue or party' });
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Kind' }));
    await userEvent.click(screen.getByRole('option', { name: 'Interested party' }));
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Interested party' }),
      'Neighbours',
    );
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Needs and expectations' }),
      'Quiet nights',
    );
    await userEvent.click(within(drawer).getByRole('checkbox', { name: 'Climate related' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoContextItem',
        { id: ISO.system.id },
        {
          kind: 'INTERESTED_PARTY',
          text: 'Neighbours',
          needs: 'Quiet nights',
          climateRelated: true,
          reviewedOn: null,
        },
      ),
    );

    const item = ISO.contextItems[0]!;
    await userEvent.click(
      screen.getByRole('button', { name: `Edit ${item.text.slice(0, 40).trim()}` }),
    );
    drawer = screen.getByRole('dialog', { name: 'Edit issue or party' });
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: /Issue|Interested party/ }),
      '!',
    );
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenLastCalledWith(
        C,
        'updateIsoContextItem',
        { id: ISO.system.id, itemId: item.id },
        expect.objectContaining({ version: item.version, text: `${item.text}!` }),
      ),
    );

    actions.isoWrite.mockResolvedValueOnce({
      ok: false,
      code: 'STALE_VERSION',
      message: 'Someone else changed this.',
    });
    await userEvent.click(
      screen.getByRole('button', { name: `Archive ${item.text.slice(0, 40).trim()}` }),
    );
    const dialog = screen.getByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Done with');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await screen.findAllByText('Someone else changed this.')).not.toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenLastCalledWith(
        C,
        'archiveIsoContextItem',
        { id: ISO.system.id, itemId: item.id },
        { version: item.version, reason: 'Done with' },
      ),
    );
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it('sets up the first system', async () => {
    render(<NewSystem clientId={C} standards={ISO.standards} units={units} />);
    await userEvent.click(screen.getByRole('button', { name: 'Set up a management system' }));
    const drawer = screen.getByRole('dialog', { name: 'Set up a management system' });
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Name' }), 'Quality system');
    await userEvent.click(within(drawer).getByRole('checkbox', { name: /^ISO 9001/ }));
    await userEvent.click(within(drawer).getByRole('checkbox', { name: units[0]!.name }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Set up system' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoSystem',
        {},
        {
          name: 'Quality system',
          standardIds: [ISO.standards[0]!.id],
          unitIds: [units[0]!.id],
        },
      ),
    );
  });
});
