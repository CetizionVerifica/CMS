import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditFinding, ExternalAuditView, LocalDate } from '@canopy/contracts';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ISO } from '../_test/fixture';
import { clauseOptions } from '../documents/documents-model';

const nav = vi.hoisted(() => ({ search: '', push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/c/c1/iso/certification',
  useSearchParams: () => new URLSearchParams(nav.search),
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

const { Certificates } = await import('./Certificates');
const { ExternalAudits } = await import('./ExternalAudits');

const C = 'c1';
const ok = <T,>(data: T) => ({ ok: true as const, data });
const systems = ISO.systems.map((s) => ({
  id: s.id,
  name: s.name,
  standardIds: s.standardIds,
  unitIds: s.unitIds,
}));
const units = ISO.units.map((u) => ({ id: u.id, name: u.name }));
const [issued, pursued] = ISO.certs as [(typeof ISO.certs)[0], (typeof ISO.certs)[0]];
const audit = (type: string) => ISO.audits.find((a) => a.type === type)!;
const person = (name: string) => ISO.people.find((p) => p.name === name)!.id;

beforeEach(() => {
  actions.isoWrite.mockReset();
  actions.isoWrite.mockResolvedValue(ok({}));
  actions.isoRead.mockReset();
  actions.isoRead.mockResolvedValue(ok({ items: [] }));
  nav.push.mockReset();
  nav.search = '';
});

const certificates = (over: Partial<Parameters<typeof Certificates>[0]> = {}) =>
  render(
    <Certificates
      clientId={C}
      certificates={ISO.certs}
      standards={ISO.standards}
      systems={systems}
      units={units}
      ids={[]}
      clearHref="/c/c1/iso/certification"
      canManage
      today="2024-11-15"
      {...over}
    />,
  );

describe('Certificates', () => {
  it('shows an issued certificate with its cycle, and one being pursued without number or dates', () => {
    certificates({ canManage: false });
    const held = screen.getByRole('listitem', { name: /ISO 9001 certificate/ });
    expect(within(held).getByText(issued.certificateNumber!)).toBeTruthy();
    expect(within(held).getByText('Issued')).toBeTruthy();
    expect(
      within(held).getByRole('list', { name: 'Surveillance and recertification' }).children,
    ).toHaveLength(3);
    const pursuing = screen.getByRole('listitem', { name: /ISO 14001 certificate/ });
    expect(within(pursuing).getByText('Being pursued')).toBeTruthy();
    expect(within(pursuing).queryByText('Number')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add certificate' })).toBeNull();
  });

  it('shows only the certificates an overview number counted, and links a met cycle date to its visit', () => {
    const met = {
      ...issued,
      cycle: {
        ...issued.cycle,
        items: [
          {
            ...issued.cycle.items[0]!,
            metByAuditId: audit('STAGE_2').id,
            metOn: '2025-07-20' as LocalDate,
          },
        ],
      },
    };
    certificates({ certificates: [met, pursued], ids: [issued.id] });
    expect(screen.queryByText('Being pursued')).toBeNull();
    expect(screen.getByRole('link', { name: 'Show all certificates' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'The visit' }).getAttribute('href')).toBe(
      `/c/c1/iso/certification?audit=${audit('STAGE_2').id}`,
    );
    certificates({ certificates: [], ids: ['gone'] });
    expect(screen.getByText(/None of the certificates the overview counted/)).toBeTruthy();
  });

  it('adds a certificate being pursued', async () => {
    certificates({ certificates: [] });
    expect(screen.getByText(/No certificate yet/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add certificate' }));
    const drawer = screen.getByRole('dialog', { name: 'Add certificate' });
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Standard' }));
    await userEvent.click(screen.getByRole('option', { name: 'ISO 45001' }));
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Certification body' }),
      'Harbour Cert',
    );
    await userEvent.click(within(drawer).getByRole('checkbox', { name: units[0]!.name }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Add certificate' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoCertification',
        {},
        {
          managementSystemId: ISO.system.id,
          standardId: ISO.system.standardIds[2],
          body: 'Harbour Cert',
          certificateNumber: null,
          issuedOn: null,
          expiresOn: null,
          scopeText: null,
          unitIds: [units[0]!.id],
        },
      ),
    );
  });

  it('records a certificate issued: number and both dates together', async () => {
    certificates();
    await userEvent.click(screen.getByRole('button', { name: 'Edit or record issued' }));
    const drawer = screen.getByRole('dialog', { name: 'Edit certificate' });
    await userEvent.click(
      within(drawer).getByRole('checkbox', { name: 'The certificate has been issued' }),
    );
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Certificate number' }),
      'HC-1',
    );
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Issued on' }), '1 Nov 2024');
    await userEvent.tab();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save certificate' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Expires on' }),
      '31 Oct 2027',
    );
    await userEvent.tab();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save certificate' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoCertification',
        { id: pursued.id },
        {
          version: pursued.version,
          certificateNumber: 'HC-1',
          issuedOn: '2024-11-01',
          expiresOn: '2027-10-31',
        },
      ),
    );
  });

  it('closes without a call when nothing changed', async () => {
    certificates();
    await userEvent.click(screen.getByRole('button', { name: 'Edit certificate' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Save certificate' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(actions.isoWrite).not.toHaveBeenCalled();
  });
});

const audits = (
  openAuditId: string | null,
  over: Partial<Parameters<typeof ExternalAudits>[0]> = {},
) =>
  render(
    <ExternalAudits
      clientId={C}
      audits={ISO.audits}
      standards={ISO.standards}
      systems={systems}
      units={units}
      people={ISO.people}
      clauseOptions={{
        [ISO.system.id]: clauseOptions(ISO.clauses, ISO.standards, ISO.system.standardIds),
      }}
      openAuditId={openAuditId}
      canManage
      today="2024-11-15"
      {...over}
    />,
  );

const finding = (over: Partial<AuditFinding> = {}): AuditFinding => ({
  id: '00000000-0000-5000-8000-0000000000f9',
  firmId: ISO.system.firmId,
  createdAt: '2024-11-05T05:30:00Z',
  updatedAt: '2024-11-05T05:30:00Z',
  archivedAt: null,
  version: 1,
  clientId: ISO.system.clientId,
  internalAuditId: null,
  externalAuditId: audit('STAGE_1').id,
  type: 'MINOR_NC',
  clauseIds: [ISO.clauses[0]!.id],
  unitId: units[0]!.id,
  description: 'Contract workers were not invited.',
  nonconformityId: '00000000-0000-5000-8000-0000000000f8',
  ...over,
});

describe('ExternalAudits', () => {
  it('lists visits newest first, each opening in the URL', () => {
    audits(null);
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Surveillance 1 · ISO 9001',
      'Stage 1 · ISO 14001, ISO 45001',
      'Stage 2 · ISO 9001',
    ]);
    expect(links[0]!.getAttribute('href')).toBe(
      `/c/c1/iso/certification?audit=${audit('SURVEILLANCE_1').id}`,
    );
  });

  it('plans a visit', async () => {
    audits(null, { audits: [] });
    expect(screen.getByText(/No certification body visit yet/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Plan external audit' }));
    const drawer = screen.getByRole('dialog', { name: 'Plan external audit' });
    await userEvent.click(within(drawer).getByRole('checkbox', { name: 'ISO 14001' }));
    await userEvent.click(within(drawer).getByRole('checkbox', { name: 'ISO 45001' }));
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Certification body' }),
      'Tidewater',
    );
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Starts on' }), '3 Mar 2025');
    await userEvent.tab();
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Ends on' }), '4 Mar 2025');
    await userEvent.tab();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Plan audit' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoExternalAudit',
        {},
        {
          managementSystemId: ISO.system.id,
          standardIds: [ISO.system.standardIds[0]],
          type: 'SURVEILLANCE_1',
          body: 'Tidewater',
          leadAuditorName: null,
          startOn: '2025-03-03',
          endOn: '2025-03-04',
          responseDueOn: null,
        },
      ),
    );
  });

  it('records a planned visit held, cancels one, and edits one', async () => {
    const planned = audit('SURVEILLANCE_1');
    audits(planned.id);
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByRole('heading', { name: 'Record the visit held' })).toBeTruthy();
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Recommendation' }));
    await userEvent.click(screen.getByRole('option', { name: 'Recommended' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Record visit held' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'recordIsoExternalAuditHeld',
        { id: planned.id },
        {
          version: planned.version,
          startOn: planned.startOn,
          endOn: planned.endOn,
          recommendation: 'RECOMMENDED',
          responseDueOn: planned.responseDueOn,
        },
      ),
    );

    await userEvent.click(within(drawer).getByRole('button', { name: 'Cancel visit' }));
    const dialog = screen.getByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Moved by the body');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel visit' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenLastCalledWith(
        C,
        'cancelIsoExternalAudit',
        { id: planned.id },
        {
          version: planned.version,
          reason: 'Moved by the body',
        },
      ),
    );

    await userEvent.click(within(drawer).getByRole('button', { name: 'Edit visit' }));
    const form = within(drawer).getByRole('form', { name: 'Edit visit' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Lead auditor' }), ' Rao');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Response due' }), '1 Aug 2025');
    await userEvent.tab();
    await userEvent.click(within(form).getByRole('button', { name: 'Save visit' }));
    expect(actions.isoWrite).toHaveBeenCalledTimes(2);
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'Why the response date moves' }),
      'Body asked',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save visit' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenLastCalledWith(
        C,
        'updateIsoExternalAudit',
        { id: planned.id },
        {
          version: planned.version,
          leadAuditorName: `${planned.leadAuditorName ?? ''} Rao`.trim(),
          responseDueOn: '2025-08-01',
          reason: 'Body asked',
        },
      ),
    );
  });

  it('shows a held visit’s findings, adds a nonconformity finding and records the response', async () => {
    const held = audit('STAGE_1');
    actions.isoRead.mockImplementation(async (_c: string, name: string) =>
      name === 'listIsoExternalFindings'
        ? ok({
            items: [
              finding(),
              finding({
                id: 'o',
                type: 'OBSERVATION',
                nonconformityId: null,
                unitId: null,
                clauseIds: [],
                description: 'Consent missing.',
              }),
            ],
          })
        : ok({ items: [] }),
    );
    audits(held.id);
    const drawer = screen.getByRole('dialog');
    expect(await within(drawer).findByText('Contract workers were not invited.')).toBeTruthy();
    expect(within(drawer).getByText('Raised a nonconformity.')).toBeTruthy();

    await userEvent.click(within(drawer).getByRole('button', { name: 'Add finding' }));
    const add = screen.getByRole('dialog', { name: 'Add finding' });
    await userEvent.type(
      within(add).getByRole('textbox', { name: 'Description' }),
      'No calibration record.',
    );
    await userEvent.click(within(add).getByRole('combobox', { name: 'Owner' }));
    await userEvent.click(screen.getByRole('option', { name: 'Rohan Joshi' }));
    await userEvent.click(within(add).getByRole('combobox', { name: 'Approver' }));
    await userEvent.click(screen.getByRole('option', { name: 'Nisha Patil' }));
    expect(within(add).getByText('Rohan Joshi works on it; Nisha Patil approves.')).toBeTruthy();
    await userEvent.type(within(add).getByRole('textbox', { name: 'Due on' }), '15 Dec 2024');
    await userEvent.tab();
    await userEvent.click(within(add).getByRole('button', { name: 'Add finding' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoExternalFinding',
        { id: held.id },
        {
          type: 'MINOR_NC',
          clauseIds: [],
          unitId: null,
          description: 'No calibration record.',
          nonconformity: {
            ownerId: person('Rohan Joshi'),
            approverId: person('Nisha Patil'),
            dueOn: '2024-12-15',
          },
        },
      ),
    );

    await userEvent.click(within(drawer).getByRole('button', { name: 'Record response sent' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Record response sent' }),
    );
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenLastCalledWith(
        C,
        'recordIsoExternalAuditResponse',
        { id: held.id },
        {
          version: held.version,
        },
      ),
    );
  });

  it('closes a responded visit with its recommendation', async () => {
    const responded = {
      ...audit('STAGE_1'),
      state: 'RESPONDED',
      allowedActions: ['CLOSE'],
    } as ExternalAuditView;
    audits(responded.id, { audits: [responded] });
    const drawer = screen.getByRole('dialog');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Close visit' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Recommendation' }));
    await userEvent.click(screen.getByRole('option', { name: 'Recommended after closure' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Close visit' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'closeIsoExternalAudit',
        { id: responded.id },
        {
          version: responded.version,
          recommendation: 'RECOMMENDED_AFTER_CLOSURE',
        },
      ),
    );
  });

  it('shows a closed or cancelled visit read-only', async () => {
    const cancelled = {
      ...audit('SURVEILLANCE_1'),
      state: 'CANCELLED',
      cancelReason: 'Moved.',
      allowedActions: [],
    } as ExternalAuditView;
    actions.isoRead.mockResolvedValue({
      ok: false,
      code: 'FORBIDDEN',
      message: 'You can’t do this here.',
    });
    audits(cancelled.id, { audits: [cancelled], canManage: false });
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText('Moved.')).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'Edit visit' })).toBeNull();
    expect(within(drawer).queryByLabelText('Add a file')).toBeNull();
    expect((await within(drawer).findAllByText('You can’t do this here.')).length).toBeGreaterThan(
      0,
    );
    await userEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(nav.push).toHaveBeenCalledWith('/c/c1/iso/certification', { scroll: false });
  });
});
