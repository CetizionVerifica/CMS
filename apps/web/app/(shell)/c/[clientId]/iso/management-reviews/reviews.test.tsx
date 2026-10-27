import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  LocalDate,
  ManagementReviewAction,
  ManagementReviewView,
  ReviewFigure,
  ReviewInputView,
} from '@canopy/contracts';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ISO } from '../_test/fixture';
import { reviewFilterDefs, reviewRows, systemStandardOptions } from './review-model';

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/c/c1/iso/management-reviews',
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
const exports = vi.hoisted(() => ({ startIsoExport: vi.fn(), isoExportProgress: vi.fn() }));
vi.mock('../_lib/export', () => exports);

const { ReviewsView } = await import('./ReviewsView');
const { ReviewRecord, figuresHeading } = await import('./[reviewId]/ReviewRecord');

// The planning and held journeys pick from several menus: quick alone, but slow on a loaded merge-queue runner with
// coverage on, so they get their own limit.
const JOURNEY_TIMEOUT = 60_000;
const C = 'c1';
const PATH = `/c/${C}/iso/management-reviews`;
const TZ = 'Asia/Kolkata';
const ok = <T,>(data: T) => ({ ok: true as const, data });
const person = (name: string) => ISO.people.find((p) => p.name === name)!.id;
const SAMEER = person('Sameer Gowda');
const DIVYA = person('Divya Hegde');
const KABIR = person('Kabir Shah');
const [DEMO] = ISO.reviews as [ManagementReviewView];
const INPUTS = ISO.reviewInputs[DEMO.id]!;
const OUTPUTS = ISO.reviewOutputs[DEMO.id]!;
const REVIEW_ACTIONS = ISO.actions.filter((a) => a.subject.id === DEMO.id);
const STANDARDS = systemStandardOptions(ISO.system, ISO.standards);
const plan = {
  clientId: C,
  systems: [{ id: ISO.system.id, name: ISO.system.name, standards: STANDARDS }],
  people: ISO.people,
  today: '2024-11-15',
};

/** Why a button is blocked, as its tooltip says. */
const blocked = (button: HTMLElement) =>
  document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent ?? null;

async function pick(scope: HTMLElement, label: string, option: string | RegExp) {
  await user.click(within(scope).getByRole('combobox', { name: label }));
  await user.click(screen.getByRole('option', { name: option }));
}

/** Types into a picker of several (ClausePicker) and chooses the match. */
async function add(scope: HTMLElement, label: string, text: string, option: string | RegExp) {
  await user.type(within(scope).getByRole('combobox', { name: label }), text);
  await user.click(screen.getByRole('option', { name: option }));
}

async function date(scope: HTMLElement, label: string, value: string) {
  const box = within(scope).getByRole('textbox', { name: label });
  await user.clear(box);
  await user.type(box, value);
  await user.tab();
}

// Keys go in without a timer between them: typing stays in one act, quick and in order on a loaded runner.
let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  user = userEvent.setup({ delay: null });
  actions.isoWrite.mockReset();
  actions.isoWrite.mockResolvedValue(ok({ id: 'new-review' }));
  actions.isoRead.mockReset();
  actions.isoRead.mockResolvedValue(ok({ items: [], nextCursor: null }));
  exports.startIsoExport.mockReset();
  exports.isoExportProgress.mockReset();
  nav.push.mockReset();
  nav.refresh.mockReset();
});

function list(manage = false) {
  return render(
    <ReviewsView
      clientId={C}
      due={ISO.overview.systems.map((s) => ({
        systemId: s.managementSystemId,
        systemName: null,
        due: s.managementReview,
      }))}
      standards={ISO.standards}
      rows={reviewRows(ISO.reviews, ISO.systems, ISO.standards, ISO.people)}
      filters={reviewFilterDefs()}
      filterValue={{}}
      plan={manage ? plan : null}
    />,
  );
}

describe('ReviewsView', () => {
  it('shows when the next review is due, and every review the API sent', () => {
    list();
    expect(screen.getByRole('region', { name: 'Next review due' })).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Management reviews' });
    const link = within(table).getByRole('link', { name: 'Management review of 28 Oct 2024' });
    expect(link.getAttribute('href')).toBe(`${PATH}/${DEMO.id}`);
    expect(within(table).getByText('Kabir Shah')).toBeTruthy();
    expect(screen.getByText('1 review')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Plan a management review' })).toBeNull();
  });

  it('plans a review of the standards ticked', { timeout: JOURNEY_TIMEOUT }, async () => {
    list(true);
    await user.click(screen.getByRole('button', { name: 'Plan a management review' }));
    const form = screen.getByRole('dialog', { name: 'Plan a management review' });
    const submit = () => within(form).getByRole('button', { name: 'Plan review' });
    // A single system is not asked for.
    expect(within(form).queryByRole('combobox', { name: 'Management system' })).toBeNull();
    for (const s of ['ISO 9001', 'ISO 14001', 'ISO 45001']) {
      await user.click(within(form).getByRole('checkbox', { name: s }));
    }
    expect(blocked(submit())).toBe('Tick the standards it reviews');
    await user.click(within(form).getByRole('checkbox', { name: 'ISO 45001' }));
    expect(blocked(submit())).toBe('Give the day it is planned for');
    await date(form, 'Planned for', '30 Apr 2025');
    expect(blocked(submit())).toBe('Choose who chairs it');
    await pick(form, 'Chair', 'Sameer Gowda');
    await add(form, 'Attendees (optional until it is held)', 'Div', 'Divya Hegde');
    await user.click(submit());
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'planIsoManagementReview',
        {},
        {
          managementSystemId: ISO.system.id,
          standards: ['ISO_45001'],
          plannedOn: '2025-04-30',
          chairId: SAMEER,
          attendeeIds: [DIVYA],
        },
      ),
    );
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`${PATH}/new-review`));
  });

  it('asks which system when the client has several', async () => {
    render(
      <ReviewsView
        clientId={C}
        due={[]}
        standards={ISO.standards}
        rows={[]}
        filters={reviewFilterDefs()}
        filterValue={{}}
        plan={{
          ...plan,
          systems: [
            ...plan.systems,
            { id: 'second', name: 'Second site system', standards: STANDARDS.slice(0, 1) },
          ],
        }}
      />,
    );
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Plan a management review' }));
    const form = screen.getByRole('dialog', { name: 'Plan a management review' });
    await pick(form, 'Management system', 'Second site system');
    // Its standards are the second system's.
    expect(within(form).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(form).getByRole('checkbox', { name: 'ISO 9001' })).toBeTruthy();
  });
});

const withSteps = (review: ManagementReviewView, steps: ManagementReviewAction[]) =>
  ({ ...review, allowedActions: steps }) as ManagementReviewView;

/** The demo review as PLANNED, with every input as the API sends a live one. */
const PLANNED = {
  ...DEMO,
  state: 'PLANNED',
  heldOn: null,
  minutes: null,
  allowedActions: ['CANCEL', 'RECORD_HELD'],
} as ManagementReviewView;

const figure = (key: string, value: number, ids: number): ReviewFigure => ({
  key,
  value,
  ids: Array.from(
    { length: ids },
    (_, i) => `00000000-0000-5000-8000-${String(i).padStart(12, '0')}`,
  ),
});

const liveInputs = (notes: boolean): ReviewInputView[] =>
  INPUTS.map((i) => ({
    ...i,
    notes: notes ? i.notes : null,
    figuresStoredAt: null,
    ...(i.source === 'NONCONFORMITIES'
      ? {
          sourceFigures: {
            ...i.sourceFigures!,
            asOf: '2024-11-15' as LocalDate,
            figures: [figure('raised', 5, 3), figure('open', 0, 0)],
          },
        }
      : {}),
    ...(i.source === 'INCIDENTS'
      ? { figuresWithheld: true, notes: null, sourceFigures: null }
      : {}),
  }));

function record(
  review: ManagementReviewView,
  opts: {
    inputs?: ReviewInputView[];
    write?: boolean;
    replan?: boolean;
    others?: ManagementReviewView[];
  } = {},
) {
  return render(
    <ReviewRecord
      clientId={C}
      review={review}
      inputs={opts.inputs ?? INPUTS}
      outputs={OUTPUTS}
      actions={REVIEW_ACTIONS}
      people={ISO.people}
      standards={ISO.standards}
      systemStandards={STANDARDS}
      otherReviews={opts.others ?? []}
      audits={ISO.internalAudits
        .filter((a) => a.reportedOn)
        .map((a) => ({ id: a.id, title: a.title, reportedOn: a.reportedOn }))}
      canReplan={opts.replan ?? false}
      canWrite={opts.write ?? false}
      canAddAction={opts.write ?? false}
      actionEditing={{ all: opts.write ?? false, personId: SAMEER }}
      today="2024-11-15"
      timeZone={TZ}
    />,
  );
}

const status = () => screen.getByRole('region', { name: 'Where it stands' });
const input = (title: string) => screen.getByRole('listitem', { name: `Input: ${title}` });
const titleOf = (source: string) => INPUTS.find((i) => i.source === source)!.title;

describe('figuresHeading', () => {
  it('says what each input’s figures are', () => {
    const nc = INPUTS.find((i) => i.source === 'NONCONFORMITIES')!;
    const manual = INPUTS.find((i) => i.source === 'MANUAL')!;
    expect(figuresHeading(nc, DEMO, TZ)).toBe(
      'Recorded 30 Oct 2024, for 10 Apr 2024 to 28 Oct 2024',
    );
    expect(figuresHeading(manual, DEMO, TZ)).toBe('Written by hand: no records in the app');
    expect(figuresHeading({ ...nc, figuresWithheld: true }, DEMO, TZ)).toBe(
      'Figures and notes withheld: they count incidents you may not open',
    );
    expect(figuresHeading(nc, PLANNED, TZ)).toBe('Live, to today');
    expect(figuresHeading(nc, { state: 'CANCELLED', heldOn: null }, TZ)).toBe('Not held');
    expect(figuresHeading({ ...nc, sourceFigures: null, figuresStoredAt: null }, DEMO, TZ)).toBe(
      'No figures: held before the system was set up in the app',
    );
  });
});

describe('ReviewRecord', () => {
  it('offers no steps the view does not allow, and reads the stored figures', () => {
    record(withSteps(DEMO, []));
    expect(
      within(status())
        .queryAllByRole('button')
        .filter((b) => !/^Download/.test(b.textContent ?? '')),
    ).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Edit attendees and minutes' })).toBeNull();
    expect(screen.queryByRole('button', { name: /notes$/ })).toBeNull();
    const nc = input(titleOf('NONCONFORMITIES'));
    expect(
      within(nc).getByText('Recorded 30 Oct 2024, for 10 Apr 2024 to 28 Oct 2024'),
    ).toBeTruthy();
    expect(within(nc).getByText('Raised')).toBeTruthy();
    const incidents = input(titleOf('INCIDENTS'));
    expect(within(incidents).getByText('Days lost')).toBeTruthy();
    expect(within(incidents).getByText('3 (1 record you can open)')).toBeTruthy();
    expect(within(input(titleOf('COMPLIANCE_EVALUATION'))).getByText('68.8')).toBeTruthy();
    expect(
      screen.getByText(/^ISO 9001 9\.3\.2 a\); ISO 14001 9\.3 a\); ISO 45001 9\.3 a\)$/),
    ).toBeTruthy();
    const output = screen.getByRole('listitem', {
      name: `Output: ${OUTPUTS.find((o) => !o.decision)!.title}`,
    });
    expect(within(output).getByText('No decision yet.')).toBeTruthy();
    const meeting = screen.getByRole('region', { name: 'The meeting' });
    expect(within(meeting).getByText('Kabir Shah')).toBeTruthy();
    expect(within(meeting).getByText(DEMO.minutes!)).toBeTruthy();
  });

  it('records decisions and closes the held review, naming what is still open', async () => {
    record(DEMO, { write: true });
    const undecided = OUTPUTS.find((o) => !o.decision)!;
    const output = screen.getByRole('listitem', { name: `Output: ${undecided.title}` });
    await user.click(within(output).getByRole('button', { name: 'Record decision' }));
    const form = screen.getByRole('dialog', { name: `Decision: ${undecided.title}` });
    const save = () => within(form).getByRole('button', { name: 'Save decision' });
    expect(blocked(save())).toBe('Nothing has changed');
    await user.type(
      within(form).getByRole('textbox', { name: 'Decision' }),
      'Brief the committee.',
    );
    await user.click(save());
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoReviewOutput',
        { id: DEMO.id, outputId: undecided.id },
        { version: undecided.version, decision: 'Brief the committee.' },
      ),
    );

    await user.click(within(status()).getByRole('button', { name: 'Close review' }));
    const confirm = screen.getByRole('alertdialog');
    expect(within(confirm).getByText(/1 without a decision, 1 still open\./)).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Close review' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'closeIsoManagementReview',
        { id: DEMO.id },
        { version: DEMO.version },
      ),
    );
  });

  it('keeps notes on a held review’s inputs', async () => {
    record(DEMO, { write: true });
    const title = titleOf('INCIDENTS');
    const row = input(title);
    await user.click(within(row).getByRole('button', { name: 'Edit notes' }));
    const form = screen.getByRole('dialog', { name: `Notes: ${title}` });
    expect(within(form).getByText(/Kept from readers who may not open them/)).toBeTruthy();
    const box = within(form).getByRole('textbox', { name: 'Notes' });
    await user.clear(box);
    expect(blocked(within(form).getByRole('button', { name: 'Save notes' }))).toBe(
      'A held review keeps notes on every input',
    );
  });

  it('downloads the review pack, the NC log and an audit report', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    exports.startIsoExport.mockResolvedValue({ ok: true, id: 'exp-1' });
    exports.isoExportProgress.mockResolvedValue({ status: 'ready', url: 'https://x.invalid/r' });
    record(DEMO);
    await user.click(screen.getByRole('button', { name: 'Download review pack (PDF)' }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Download NC log (Excel)' }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: 'Download audit report (PDF)' }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(3));
    vi.unstubAllGlobals();
    const reported = ISO.internalAudits.filter((a) => a.reportedOn);
    expect(exports.startIsoExport.mock.calls).toEqual([
      [C, 'ISO_REVIEW_PACK_PDF', `managementReviewId=${DEMO.id}`],
      [C, 'ISO_NC_LOG_XLSX', `managementSystemId=${DEMO.managementSystemId}`],
      [C, 'ISO_AUDIT_REPORT_PDF', `internalAuditId=${reported[0]!.id}`],
    ]);
  });

  it('adds a review action that carries out an output', { timeout: JOURNEY_TIMEOUT }, async () => {
    record(DEMO, { write: true });
    const resource = REVIEW_ACTIONS.find((a) => a.state === 'OPEN')!;
    const item = screen.getByRole('listitem', {
      name: `Review action: ${resource.text.slice(0, 60).trim()}`,
    });
    expect(
      within(item).getByText(OUTPUTS.find((o) => o.key === 'RESOURCE_NEEDS')!.title),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add review action' }));
    const form = screen.getByRole('dialog', { name: 'Add review action' });
    await user.type(
      within(form).getByRole('textbox', { name: 'What is to be done' }),
      'Brief staff.',
    );
    const worker = OUTPUTS.find((o) => o.key === 'WORKER_COMMUNICATION')!;
    await pick(form, 'Output it carries out (optional)', worker.title);
    await pick(form, 'Owner', 'Kabir Shah');
    await date(form, 'Due on', '15 Dec 2024');
    await user.click(within(form).getByRole('button', { name: 'Add review action' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoAction',
        {},
        {
          subject: { type: 'MANAGEMENT_REVIEW', id: DEMO.id },
          text: 'Brief staff.',
          resources: null,
          ownerId: KABIR,
          dueOn: '2024-12-15',
          controlHierarchy: null,
          outputKey: 'WORKER_COMMUNICATION',
        },
      ),
    );
  });
});

describe('a planned review', () => {
  it('reads its live figures, and withholds what the reader may not open', () => {
    record(PLANNED, { inputs: liveInputs(true), write: true });
    expect(
      within(status())
        .getAllByRole('button')
        .map((b) => b.textContent)
        .filter((t) => !/^Download/.test(t ?? '')),
    ).toEqual(['Record as held', 'Cancel review']);
    const nc = input(titleOf('NONCONFORMITIES'));
    expect(within(nc).getByText('Live, to today')).toBeTruthy();
    expect(within(nc).getByText('5 (3 you can open)')).toBeTruthy();
    const incidents = input(titleOf('INCIDENTS'));
    expect(
      within(incidents).getByText(
        'Figures and notes withheld: they count incidents you may not open',
      ),
    ).toBeTruthy();
    expect(within(incidents).queryByRole('button')).toBeNull();
    expect(within(incidents).queryByText('No notes yet.')).toBeNull();
  });

  it(
    'is recorded as held once every input has notes, with notes on an earlier day and a later review',
    { timeout: JOURNEY_TIMEOUT },
    async () => {
      const inputs = liveInputs(false);
      const { unmount } = record(PLANNED, { inputs, write: true });
      await user.click(within(status()).getByRole('button', { name: 'Record as held' }));
      let form = screen.getByRole('dialog', { name: 'Record review as held' });
      expect(blocked(within(form).getByRole('button', { name: 'Record as held' }))).toBe(
        'Add notes to every input first',
      );
      // The withheld incidents row is left for the API to judge.
      expect(within(form).getByText(/^No notes yet on: /).textContent).not.toContain(
        titleOf('INCIDENTS'),
      );
      unmount();

      const noted = liveInputs(true);
      record(
        withSteps({ ...PLANNED, standards: ['ISO_45001'], attendeeIds: [] }, ['RECORD_HELD']),
        {
          inputs: noted,
          write: true,
          others: [
            { ...DEMO, id: 'demo' },
            { ...DEMO, id: 'later', heldOn: '2024-11-12' as LocalDate },
          ],
        },
      );
      await user.click(within(status()).getByRole('button', { name: 'Record as held' }));
      form = screen.getByRole('dialog', { name: 'Record review as held' });
      const submit = () => within(form).getByRole('button', { name: 'Record as held' });
      expect(blocked(submit())).toBe('Name who attended');
      expect(within(form).queryByText(/The stored figures count the records up to/)).toBeNull();
      await date(form, 'Held on', '25 Oct 2024');
      expect(
        within(form).getByText(/The stored figures count the records up to 25 Oct 2024/),
      ).toBeTruthy();
      expect(
        within(form).getByText(
          /already recorded as held on 28 Oct 2024, 12 Nov 2024\. Its figures stay as they are\./,
        ),
      ).toBeTruthy();
      await add(form, 'Attendees', 'Div', 'Divya Hegde');
      await user.type(within(form).getByRole('textbox', { name: 'Minutes' }), 'Quorate.');
      await user.click(submit());
      await waitFor(() =>
        expect(actions.isoWrite).toHaveBeenCalledWith(
          C,
          'recordIsoManagementReviewHeld',
          { id: DEMO.id },
          {
            version: DEMO.version,
            heldOn: '2024-10-25',
            attendeeIds: [DIVYA],
            minutes: 'Quorate.',
          },
        ),
      );
    },
  );

  it('adds notes to an input, and edits the meeting', async () => {
    record(PLANNED, { inputs: liveInputs(false), write: true });
    const title = titleOf('MANUAL');
    await user.click(within(input(title)).getByRole('button', { name: 'Add notes' }));
    const form = screen.getByRole('dialog', { name: `Notes: ${title}` });
    expect(within(form).getByText(/has no records in the app/)).toBeTruthy();
    await user.type(within(form).getByRole('textbox', { name: 'Notes' }), 'Survey steady.');
    await user.click(within(form).getByRole('button', { name: 'Save notes' }));
    const manual = INPUTS.find((i) => i.source === 'MANUAL')!;
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoReviewInput',
        { id: DEMO.id, inputId: manual.id },
        { version: manual.version, notes: 'Survey steady.' },
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Edit attendees and minutes' }));
    const meeting = screen.getByRole('dialog', { name: 'Attendees and minutes' });
    const save = () => within(meeting).getByRole('button', { name: 'Save' });
    expect(blocked(save())).toBe('Nothing has changed');
    expect(within(meeting).getByText(/Keep incident details in the notes/)).toBeTruthy();
    await user.type(within(meeting).getByRole('textbox', { name: 'Minutes' }), 'Agenda sent.');
    await user.click(save());
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoManagementReview',
        { id: DEMO.id },
        { version: DEMO.version, minutes: 'Agenda sent.' },
      ),
    );
  });

  it('is replanned, with a reason when the date or the chair changes', async () => {
    record(PLANNED, { inputs: liveInputs(true), replan: true });
    await user.click(within(status()).getByRole('button', { name: 'Replan' }));
    const form = screen.getByRole('dialog', { name: 'Replan review' });
    const save = () => within(form).getByRole('button', { name: 'Save plan' });
    expect(blocked(save())).toBe('Nothing has changed');
    await user.click(within(form).getByRole('checkbox', { name: 'ISO 9001' }));
    expect(blocked(save())).toBeNull();
    await pick(form, 'Chair', 'Sameer Gowda');
    expect(blocked(save())).toBe('Say why the date or the chair changes');
    await user.type(
      within(form).getByRole('textbox', { name: 'Why the date or the chair changes' }),
      'Kabir is away.',
    );
    await user.click(save());
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'replanIsoManagementReview',
        { id: DEMO.id },
        {
          version: DEMO.version,
          standards: ['ISO_14001', 'ISO_45001'],
          chairId: SAMEER,
          reason: 'Kabir is away.',
        },
      ),
    );
  });

  it('is cancelled with a reason, and then reads as not held', async () => {
    const { unmount } = record(PLANNED, { inputs: liveInputs(true), write: true });
    await user.click(within(status()).getByRole('button', { name: 'Cancel review' }));
    const confirm = screen.getByRole('alertdialog');
    await user.type(
      within(confirm).getByRole('textbox', { name: 'Why it is cancelled' }),
      'Merged.',
    );
    await user.click(within(confirm).getByRole('button', { name: 'Cancel review' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'cancelIsoManagementReview',
        { id: DEMO.id },
        { version: DEMO.version, reason: 'Merged.' },
      ),
    );
    unmount();
    record(withSteps({ ...PLANNED, state: 'CANCELLED', cancelReason: 'Merged.' }, []), {
      inputs: liveInputs(true),
      write: true,
    });
    expect(screen.getByText('Cancelled: Merged.')).toBeTruthy();
    expect(within(input(titleOf('NONCONFORMITIES'))).getByText('Not held')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit attendees and minutes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add review action' })).toBeNull();
  });
});
