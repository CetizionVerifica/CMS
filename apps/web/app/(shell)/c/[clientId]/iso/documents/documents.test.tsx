import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DocumentView, RevisionView } from '@canopy/contracts';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ISO } from '../_test/fixture';
import { clauseOptions, documentFilterDefs, documentRows } from './documents-model';

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/c/c1/iso/documents',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: nav.push, refresh: nav.refresh, replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _p,
    scroll: _s,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    prefetch?: boolean;
    scroll?: boolean;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const actions = vi.hoisted(() => ({ isoWrite: vi.fn(), isoRead: vi.fn() }));
vi.mock('../_lib/actions', () => actions);

const { DocumentsView } = await import('./DocumentsView');
const { DocumentRecord } = await import('./[documentId]/DocumentRecord');

const C = 'c1';
const ok = <T,>(data: T) => ({ ok: true as const, data });
const person = (name: string) => ISO.people.find((p) => p.name === name)!.id;
const ROHAN = person('Rohan Joshi');
const NISHA = person('Nisha Patil');
const options = clauseOptions(ISO.clauses, ISO.standards, ISO.system.standardIds);
const doc = (code: string, over: Partial<DocumentView> = {}): DocumentView => ({
  ...ISO.docs.find((d) => d.code === code)!,
  ...over,
});

beforeEach(() => {
  actions.isoWrite.mockReset();
  actions.isoWrite.mockResolvedValue(ok({ id: 'new-doc' }));
  actions.isoRead.mockReset();
  actions.isoRead.mockResolvedValue(ok({ items: [] }));
  nav.push.mockReset();
  nav.refresh.mockReset();
});

const create = (ownerOnly: string | null = null) => ({
  systems: [{ id: ISO.system.id, name: ISO.system.name }],
  clauseOptions: { [ISO.system.id]: options },
  people: ISO.people,
  ownerOnly,
  today: '2024-11-15',
});

describe('DocumentsView', () => {
  it('lists documents, each linking to its page, with review timing or obsolete', () => {
    const rows = documentRows(
      [...ISO.docs, doc('NFG-WI-02', { id: 'obs', status: 'OBSOLETE' })],
      ISO.people,
      [],
    );
    render(
      <DocumentsView
        clientId={C}
        rows={rows}
        filters={documentFilterDefs()}
        filterValue={{ type: [], status: [], ownerId: [] }}
        fromOverview
        clearHref="/c/c1/iso/documents"
        create={null}
      />,
    );
    expect(
      screen.getByRole('link', { name: 'Control of nonconforming product' }).getAttribute('href'),
    ).toBe(`/c/c1/iso/documents/${doc('NFG-PR-07').id}`);
    expect(
      within(screen.getByRole('table', { name: 'Documents' })).getAllByText('Obsolete').length,
    ).toBeGreaterThan(1);
    expect(screen.getByRole('link', { name: 'Show all documents' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add document' })).toBeNull();
  });

  it('adds a document, then opens it', async () => {
    render(
      <DocumentsView
        clientId={C}
        rows={[]}
        filters={[]}
        filterValue={{}}
        fromOverview={false}
        clearHref=""
        create={create()}
      />,
    );
    expect(screen.getByText(/No document matches/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add document' }));
    const drawer = screen.getByRole('dialog', { name: 'Add document' });
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Code' }), 'QP-09');
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Title' }),
      'Allergen changeover',
    );
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Type' }));
    await userEvent.click(screen.getByRole('option', { name: 'Form' }));
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Retention' }), 'Two years');
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Owner' }));
    await userEvent.click(screen.getByRole('option', { name: 'Rohan Joshi' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Add document' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Approver' }));
    await userEvent.click(screen.getByRole('option', { name: 'Nisha Patil' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Add document' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoDocument',
        {},
        {
          managementSystemId: ISO.system.id,
          code: 'QP-09',
          title: 'Allergen changeover',
          type: 'FORM',
          clauseIds: [],
          ownerId: ROHAN,
          approverId: NISHA,
          reviewDueOn: null,
          retention: 'Two years',
          issuer: null,
          externalRef: null,
        },
      ),
    );
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/c/c1/iso/documents/new-doc'));
  });

  it('adds an external document as its owner, with the issuer', async () => {
    render(
      <DocumentsView
        clientId={C}
        rows={[]}
        filters={[]}
        filterValue={{}}
        fromOverview={false}
        clearHref=""
        create={{
          ...create(ROHAN),
          systems: [
            { id: ISO.system.id, name: 'A' },
            { id: 'other', name: 'B' },
          ],
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add document' }));
    const drawer = screen.getByRole('dialog', { name: 'Add document' });
    expect(within(drawer).getByRole('combobox', { name: 'Management system' })).toBeTruthy();
    expect(within(drawer).queryByRole('combobox', { name: 'Owner' })).toBeNull();
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Type' }));
    await userEvent.click(screen.getByRole('option', { name: 'External' }));
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Issuer' }), 'Food Authority');
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: "Issuer's reference" }),
      'FA-12',
    );
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Code' }), 'EXT-9');
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Title' }), 'Hygiene rules');
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Approver' }));
    await userEvent.click(screen.getByRole('option', { name: 'Nisha Patil' }));
    actions.isoWrite.mockResolvedValueOnce({
      ok: false,
      code: 'DUPLICATE',
      message: 'That is already in use.',
    });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Add document' }));
    expect(await within(drawer).findByText('That is already in use.')).toBeTruthy();
    expect(actions.isoWrite.mock.calls[0]![3]).toMatchObject({
      ownerId: ROHAN,
      type: 'EXTERNAL',
      issuer: 'Food Authority',
      externalRef: 'FA-12',
      retention: null,
    });
    expect(nav.push).not.toHaveBeenCalled();
  });
});

const T = '2024-11-01T05:30:00Z';
const revision = (over: Partial<RevisionView> = {}): RevisionView => ({
  id: '00000000-0000-5000-8000-0000000000r1'.replace('r', 'e'),
  firmId: ISO.docs[0]!.firmId,
  createdAt: T,
  updatedAt: T,
  archivedAt: null,
  version: 1,
  clientId: ISO.docs[0]!.clientId,
  documentId: doc('NFG-PR-07').id,
  revision: 'B',
  changeNote: 'Adds the hold tag.',
  state: 'DRAFT',
  preparedById: ROHAN,
  approvedById: null,
  approvedAt: null,
  sendBackReason: null,
  allowedActions: [],
  ...over,
});

function record(
  d: DocumentView,
  revisions: RevisionView[],
  opts: Partial<{ canEdit: boolean; canReassign: boolean; canEditDraft: boolean }> = {},
) {
  return render(
    <DocumentRecord
      clientId={C}
      doc={d}
      revisions={revisions}
      people={ISO.people}
      clauseOptions={options}
      systemName={ISO.system.name}
      canEdit={opts.canEdit ?? true}
      canReassign={opts.canReassign ?? true}
      canEditDraft={opts.canEditDraft ?? true}
      today="2024-11-15"
      timeZone="Asia/Kolkata"
    />,
  );
}

describe('DocumentRecord', () => {
  const pr07 = doc('NFG-PR-07', { clauseIds: [options[10]!.id, 'gone'] });

  it('shows the document, its clauses and every revision, the superseded one marked', () => {
    record(pr07, [
      revision({ allowedActions: ['SUBMIT'], sendBackReason: 'Add the hold tag.' }),
      revision({ id: 'a', revision: 'A', state: 'APPROVED', approvedById: NISHA, approvedAt: T }),
      // 01:30 on 1 Nov in Kolkata, still 31 Oct in UTC.
      revision({
        id: 'o',
        revision: '0',
        state: 'SUPERSEDED',
        approvedById: NISHA,
        approvedAt: '2024-10-31T20:00:00Z',
      }),
    ]);
    expect(screen.getByText(`${options[10]!.label}; A clause no longer listed`)).toBeTruthy();
    expect(screen.getByText('Sent back: Add the hold tag.')).toBeTruthy();
    expect(screen.getByText('Superseded')).toBeTruthy();
    expect(
      screen.getAllByText('Prepared by Rohan Joshi. Approved by Nisha Patil on 1 Nov 2024.'),
    ).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Files of revision B' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Draft a revision' })).toBeNull();
  });

  it('runs the revision steps the API offers', async () => {
    record(pr07, [revision({ allowedActions: ['SUBMIT', 'APPROVE', 'SEND_BACK'] })]);
    const ids = { id: pr07.id, revisionId: revision().id };
    await userEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Submit for approval' }),
    );
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenLastCalledWith(C, 'submitIsoRevision', ids, {
        version: 1,
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    let dialog = screen.getByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Fine');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenLastCalledWith(C, 'approveIsoRevision', ids, {
        version: 1,
        comment: 'Fine',
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send back' }));
    dialog = screen.getByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Add the form');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send back' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenLastCalledWith(C, 'sendBackIsoRevision', ids, {
        version: 1,
        reason: 'Add the form',
      }),
    );
  });

  it('edits a draft revision’s label and note', async () => {
    record(pr07, [revision()]);
    await userEvent.click(screen.getByRole('button', { name: 'Edit revision' }));
    const drawer = screen.getByRole('dialog', { name: 'Edit revision' });
    const label = within(drawer).getByRole('textbox', { name: 'Revision' });
    await userEvent.clear(label);
    await userEvent.type(label, 'C');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoRevision',
        { id: pr07.id, revisionId: revision().id },
        { version: 1, revision: 'C' },
      ),
    );
  });

  it('drafts the next revision with a suggested label, reviews and makes obsolete', async () => {
    const pol = doc('NFG-POL-01', {
      allowedActions: ['DRAFT_REVISION', 'REVIEW', 'MAKE_OBSOLETE'],
    });
    record(pol, []);
    expect(screen.getByText(/No revision yet/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Draft a revision' }));
    let drawer = screen.getByRole('dialog', { name: 'Draft a revision' });
    expect(
      (within(drawer).getByRole('textbox', { name: 'Revision' }) as HTMLInputElement).value,
    ).toBe('C');
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Change note' }),
      'Climate wording.',
    );
    await userEvent.click(within(drawer).getByRole('button', { name: 'Start revision' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'draftIsoRevision',
        { id: pol.id },
        { revision: 'C', changeNote: 'Climate wording.' },
      ),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Record review' }));
    drawer = screen.getByRole('dialog', { name: 'Record review' });
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Review note' }),
      'Still right.',
    );
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Next review due' }),
      '15 Nov 2025',
    );
    await userEvent.tab();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Record review' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenLastCalledWith(
        C,
        'reviewIsoDocument',
        { id: pol.id },
        {
          version: pol.version,
          note: 'Still right.',
          nextReviewDueOn: '2025-11-15',
        },
      ),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Make obsolete' }));
    const dialog = screen.getByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Merged into the manual.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make obsolete' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenLastCalledWith(
        C,
        'obsoleteIsoDocument',
        { id: pol.id },
        {
          version: pol.version,
          reason: 'Merged into the manual.',
        },
      ),
    );
  });

  it('shows an external document’s edition with its issuer, recorded by the owner', async () => {
    const ext = doc('NFG-EXT-01', { allowedActions: ['DRAFT_REVISION'] });
    record(ext, [
      revision({ documentId: ext.id, revision: '5', allowedActions: ['RECORD_EDITION'] }),
      revision({
        id: 'x',
        documentId: ext.id,
        revision: '4',
        state: 'APPROVED',
        approvedById: null,
        approvedAt: T,
      }),
    ]);
    expect(screen.getByRole('button', { name: 'Record a new edition' })).toBeTruthy();
    expect(
      screen.getByText(`Prepared by Rohan Joshi. Recorded 1 Nov 2024, issued by ${ext.issuer}.`),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Record edition' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Record edition' }),
    );
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'recordIsoEdition',
        { id: ext.id, revisionId: revision().id },
        { version: 1 },
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Record a new edition' }));
    expect(screen.getByRole('dialog', { name: 'Record a new edition' })).toBeTruthy();
  });

  it('edits the document; a new approver or review date needs a reason', async () => {
    const frm = doc('NFG-FRM-03');
    record(frm, [], { canReassign: false });
    expect(screen.getByText(frm.retention!)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    const drawer = screen.getByRole('dialog', { name: 'Edit document' });
    expect(within(drawer).queryByRole('combobox', { name: 'Owner' })).toBeNull();
    expect(
      within(drawer).getByRole('button', { name: 'Save document' }).getAttribute('aria-disabled'),
    ).toBe('true');
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Approver' }));
    await userEvent.click(screen.getByRole('option', { name: 'Kabir Shah' }));
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Retention' }), ' More.');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save document' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: /Why the owner, approver/ }),
      'Nisha moved',
    );
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save document' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoDocument',
        { id: frm.id },
        {
          version: frm.version,
          approverId: person('Kabir Shah'),
          retention: `${frm.retention} More.`,
          reason: 'Nisha moved',
        },
      ),
    );
  });

  it('offers no edits on an obsolete document or to a reader', () => {
    record(doc('NFG-PR-07', { status: 'OBSOLETE' }), [revision({ state: 'DRAFT' })], {
      canEditDraft: false,
    });
    expect(screen.queryByRole('button', { name: 'Edit document' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit revision' })).toBeNull();
  });
});
