import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InternalAuditAction, InternalAuditView } from '@canopy/contracts';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ISO } from '../_test/fixture';
import { clauseOptions } from '../documents/documents-model';
import { auditFilterDefs, auditRows, programmeFys, programmeOptions } from './audit-model';

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/c/c1/iso/audits',
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

const { AuditsView } = await import('./AuditsView');
const { AuditRecord } = await import('./[auditId]/AuditRecord');
const { findingTypes } = await import('./[auditId]/AuditWork');

// The planning and finding journeys pick from many menus: quick alone, but slow on a loaded merge-queue runner
// with coverage on, so they get their own limit.
const JOURNEY_TIMEOUT = 60_000;
const C = 'c1';
const PATH = `/c/${C}/iso/audits`;
const ok = <T,>(data: T) => ({ ok: true as const, data });
const person = (name: string) => ISO.people.find((p) => p.name === name)!.id;
const ROHAN = person('Rohan Joshi');
const NISHA = person('Nisha Patil');
const SAMEER = person('Sameer Gowda');
const DIVYA = person('Divya Hegde');
const KABIR = person('Kabir Shah');
const byTitle = (start: string) => ISO.internalAudits.find((a) => a.title.startsWith(start))!;
const Q1 = byTitle('Q1');
const Q2 = byTitle('Q2');
const Q3 = byTitle('Q3');
const Q4 = byTitle('Q4');
const [PROGRAMME] = ISO.programmes;
const units = ISO.units.map((u) => ({ id: u.id, name: u.name }));
const CLAUSES = clauseOptions(ISO.clauses, ISO.standards, ISO.system.standardIds);
const plan = {
  clientId: C,
  programmes: programmeOptions(ISO.programmes, [ISO.system]),
  systems: [{ id: ISO.system.id, unitIds: ISO.system.unitIds, clauses: CLAUSES }],
  units,
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
  await user.type(within(scope).getByRole('textbox', { name: label }), value);
  await user.tab();
}

// Keys go in without a timer between them: typing stays in one act, quick and in order on a loaded runner.
let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  user = userEvent.setup({ delay: null });
  actions.isoWrite.mockReset();
  actions.isoWrite.mockResolvedValue(ok({ id: 'new-audit' }));
  actions.isoRead.mockReset();
  actions.isoRead.mockResolvedValue(ok({ items: [], nextCursor: null }));
  exports.startIsoExport.mockReset();
  exports.isoExportProgress.mockReset();
  nav.push.mockReset();
  nav.refresh.mockReset();
});

function list(opts: { fromOverview?: boolean; manage?: boolean; missing?: boolean } = {}) {
  return render(
    <AuditsView
      clientId={C}
      fy="2024-25"
      programmes={ISO.programmes.map((p) => ({
        programme: p,
        systemName: null,
        uncoveredClauses: ['ISO 9001 4.1', 'ISO 9001 4.2'],
        uncoveredUnits: ['Bengaluru Office'],
      }))}
      missingProgrammes={opts.missing ? [{ id: ISO.system.id, name: ISO.system.name }] : []}
      canManageProgrammes={opts.manage ?? false}
      rows={auditRows(ISO.internalAudits, ISO.programmes, ISO.units, ISO.people)}
      filters={auditFilterDefs(ISO.units, programmeFys(ISO.programmes, '2024-25'))}
      filterValue={{}}
      fromOverview={opts.fromOverview ?? false}
      clearHref={PATH}
      plan={opts.manage ? plan : null}
    />,
  );
}

describe('AuditsView', () => {
  it('shows the programme with its coverage, and every audit the API sent', () => {
    list({ fromOverview: true });
    const card = screen.getByRole('listitem', { name: 'Programme for FY 2024-25' });
    expect(
      within(card).getByText(/2 clauses not yet covered: ISO 9001 4\.1, ISO 9001 4\.2\./),
    ).toBeTruthy();
    expect(within(card).getByText(/Units not yet covered: Bengaluru Office\./)).toBeTruthy();
    expect(within(card).getByText(PROGRAMME!.notes!)).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Internal audits' });
    expect(within(table).getAllByRole('link')).toHaveLength(ISO.internalAudits.length);
    expect(within(table).getByRole('link', { name: Q1.title }).getAttribute('href')).toBe(
      `${PATH}/${Q1.id}`,
    );
    expect(screen.getByRole('link', { name: 'Show every audit' }).getAttribute('href')).toBe(PATH);
    expect(screen.queryByRole('button', { name: 'Plan an internal audit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit notes' })).toBeNull();
  });

  it('starts the FY programme and edits its notes', async () => {
    list({ manage: true, missing: true });
    await user.click(screen.getByRole('button', { name: 'Start FY 2024-25 programme' }));
    const start = screen.getByRole('dialog', { name: 'Start FY 2024-25 programme' });
    await user.type(
      within(start).getByRole('textbox', { name: 'Notes (optional)' }),
      'Two a year.',
    );
    await user.click(within(start).getByRole('button', { name: 'Start programme' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoAuditProgramme',
        {},
        {
          managementSystemId: ISO.system.id,
          fy: '2024-25',
          notes: 'Two a year.',
        },
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Edit notes' }));
    const notes = screen.getByRole('dialog', { name: 'FY 2024-25 programme notes' });
    const save = () => within(notes).getByRole('button', { name: 'Save notes' });
    expect(blocked(save())).toBe('Nothing has changed');
    await user.clear(within(notes).getByRole('textbox', { name: 'Notes' }));
    await user.click(save());
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoAuditProgramme',
        { id: PROGRAMME!.id },
        { version: PROGRAMME!.version, notes: null },
      ),
    );
  });

  it(
    'plans an audit, asking for an independence note when an auditor audits their own work',
    { timeout: JOURNEY_TIMEOUT },
    async () => {
      list({ manage: true });
      await user.click(screen.getByRole('button', { name: 'Plan an internal audit' }));
      const form = screen.getByRole('dialog', { name: 'Plan an internal audit' });
      const submit = () => within(form).getByRole('button', { name: 'Plan audit' });
      expect(blocked(submit())).toBe('Give the audit a title');
      await user.type(within(form).getByRole('textbox', { name: 'Title' }), 'Q4 follow-up audit');
      await date(form, 'Starts on', '10 Mar 2025');
      await date(form, 'Ends on', '11 Mar 2025');
      await add(form, 'Clauses', '8.4', CLAUSES.find((c) => / 8\.4 /.test(c.label))!.label);
      await user.click(within(form).getByRole('checkbox', { name: 'Pune Plant' }));
      await pick(form, 'Lead auditor', 'Sameer Gowda');
      await add(form, 'Other auditors (optional)', 'Div', 'Divya Hegde');
      await add(form, 'Auditees', 'Div', 'Divya Hegde');
      await add(form, 'Reported to (optional until the report)', 'Kab', 'Kabir Shah');
      expect(blocked(submit())).toBe('Say how independence is kept');
      const note = within(form).getByRole('textbox', { name: 'Independence note' });
      expect(within(form).getByText(/Divya Hegde would audit their own work/)).toBeTruthy();
      await user.type(note, 'Divya audits Pune only.');
      await user.click(submit());
      await waitFor(() =>
        expect(actions.isoWrite).toHaveBeenCalledWith(
          C,
          'createIsoInternalAudit',
          {},
          {
            programmeId: PROGRAMME!.id,
            title: 'Q4 follow-up audit',
            plannedStart: '2025-03-10',
            plannedEnd: '2025-03-11',
            clauseIds: [expect.any(String)],
            unitIds: [ISO.units.find((u) => u.name === 'Pune Plant')!.id],
            leadAuditorId: SAMEER,
            auditorIds: [DIVYA],
            auditeeIds: [DIVYA],
            reportedToIds: [KABIR],
            independenceNote: 'Divya audits Pune only.',
          },
        ),
      );
      await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`${PATH}/new-audit`));
    },
  );
});

const withSteps = (audit: InternalAuditView, steps: InternalAuditAction[]) =>
  ({ ...audit, allowedActions: steps }) as InternalAuditView;

function record(audit: InternalAuditView, opts: Partial<Record<'edit' | 'conduct', boolean>> = {}) {
  const findings = ISO.auditFindings[audit.id] ?? [];
  return render(
    <AuditRecord
      clientId={C}
      audit={audit}
      checklist={ISO.auditChecklists[audit.id] ?? []}
      findings={findings}
      ncs={findings
        .filter((f) => f.nonconformityId)
        .map((f) => ({ id: f.nonconformityId!, state: 'OPEN' as const, ownerId: ROHAN }))}
      people={ISO.people}
      units={units}
      auditUnits={units.filter((u) => audit.unitIds.includes(u.id))}
      clauses={CLAUSES}
      personId={SAMEER}
      canEdit={opts.edit ?? false}
      canConduct={opts.conduct ?? false}
      canEditFindings={opts.conduct ?? false}
      plan={plan}
      today="2024-11-15"
      timeZone="Asia/Kolkata"
    />,
  );
}

const status = () => screen.getByRole('region', { name: 'Where it stands' });

describe('AuditRecord', () => {
  it('offers exactly the steps the view allows, and the team with its independence note', async () => {
    record(withSteps(Q4, []), { edit: false });
    expect(within(status()).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Edit audit' })).toBeNull();
    expect(screen.getByText('Auditing their own work: Divya Hegde.')).toBeTruthy();
    expect(screen.getByText(/^Independence: Divya audits the Pune Plant only/)).toBeTruthy();
    expect(screen.getByText('Findings are recorded once the audit is started.')).toBeTruthy();
  });

  it('starts and cancels a planned audit, and edits it with a reason when its dates move', async () => {
    record(Q4, { edit: true, conduct: true });
    expect(
      within(status())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Start audit', 'Cancel audit']);
    await user.click(within(status()).getByRole('button', { name: 'Start audit' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Start audit' }),
    );
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'startIsoInternalAudit',
        { id: Q4.id },
        { version: Q4.version },
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Edit audit' }));
    const form = screen.getByRole('dialog', { name: 'Edit audit' });
    const save = () => within(form).getByRole('button', { name: 'Save audit' });
    expect(blocked(save())).toBe('Nothing has changed');
    const end = within(form).getByRole('textbox', { name: 'Ends on' });
    await user.clear(end);
    await user.type(end, '21 Feb 2025');
    await user.tab();
    expect(blocked(save())).toBe('Say why the dates or the lead auditor change');
    await user.type(
      within(form).getByRole('textbox', { name: 'Why the dates or the lead auditor change' }),
      'Stock count week.',
    );
    await user.click(save());
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoInternalAudit',
        { id: Q4.id },
        { version: Q4.version, plannedEnd: '2025-02-21', reason: 'Stock count week.' },
      ),
    );
  });

  it('reports an audit only once every clause has a checklist result', async () => {
    record(Q3, { conduct: true });
    await user.click(within(status()).getByRole('button', { name: 'Report audit' }));
    const form = screen.getByRole('dialog', { name: 'Report audit' });
    const submit = () => within(form).getByRole('button', { name: 'Report audit' });
    expect(blocked(submit())).toBe('Give a checklist result for every clause first');
    expect(within(form).getByText(/^No checklist result yet for: /)).toBeTruthy();
  });

  it('reports a fully answered audit to the people named', async () => {
    const rows = ISO.auditChecklists[Q2.id]!;
    record(
      withSteps({ ...Q2, state: 'IN_PROGRESS', summary: null, reportedOn: null }, ['REPORT']),
      {
        conduct: true,
      },
    );
    expect(rows.every((r) => r.result)).toBe(true);
    await user.click(within(status()).getByRole('button', { name: 'Report audit' }));
    const form = screen.getByRole('dialog', { name: 'Report audit' });
    const submit = () => within(form).getByRole('button', { name: 'Report audit' });
    expect(blocked(submit())).toBe('Write the summary');
    await user.type(within(form).getByRole('textbox', { name: 'Summary' }), 'Controls work.');
    expect(blocked(submit())).toBeNull();
    await user.click(submit());
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'reportIsoInternalAudit',
        { id: Q2.id },
        {
          version: Q2.version,
          summary: 'Controls work.',
          reportedOn: '2024-11-15',
          reportedToIds: Q2.reportedToIds,
        },
      ),
    );
  });

  it('closes a reported audit and downloads its report', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    exports.startIsoExport.mockResolvedValue({ ok: true, id: 'exp-1' });
    exports.isoExportProgress.mockResolvedValue({ status: 'ready', url: 'https://x.invalid/r' });
    record(Q2, { conduct: true });
    expect(screen.getByText(Q2.summary!)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Download audit report (PDF)' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://x.invalid/r'));
    expect(exports.startIsoExport).toHaveBeenCalledWith(
      C,
      'ISO_AUDIT_REPORT_PDF',
      `internalAuditId=${Q2.id}`,
    );
    vi.unstubAllGlobals();
    await user.click(within(status()).getByRole('button', { name: 'Close audit' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Close audit' }),
    );
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'closeIsoInternalAudit',
        { id: Q2.id },
        { version: Q2.version },
      ),
    );
    // A reported audit's checklist and findings are final.
    expect(screen.queryByRole('button', { name: 'Add checklist row' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit finding' })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Open the nonconformity it raised' }).getAttribute('href'),
    ).toBe(
      `/c/${C}/iso/nonconformities/${ISO.auditFindings[Q2.id]!.find((f) => f.nonconformityId)!.nonconformityId}`,
    );
  });
});

describe('the checklist and findings', () => {
  it('adds a row for one of the audit’s clauses and answers it', async () => {
    record(Q3, { conduct: true });
    await user.click(screen.getByRole('button', { name: 'Add checklist row' }));
    const add = screen.getByRole('dialog', { name: 'Add checklist row' });
    const clause = CLAUSES.find((c) => c.id === Q3.clauseIds[2])!;
    await pick(add, 'Clause', clause.label);
    await user.type(within(add).getByRole('textbox', { name: 'Question' }), 'Are backups tested?');
    await user.click(within(add).getByRole('button', { name: 'Add row' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoAuditChecklistItem',
        { id: Q3.id },
        { clauseId: clause.id, unitId: null, question: 'Are backups tested?' },
      ),
    );

    const open = ISO.auditChecklists[Q3.id]!.find((r) => r.result === null)!;
    const row = screen.getByRole('listitem', { name: `Checklist row: ${open.question}` });
    await user.click(within(row).getByRole('button', { name: 'Answer' }));
    const answer = screen.getByRole('dialog', { name: 'Answer checklist row' });
    await user.click(within(answer).getByRole('radio', { name: 'Not audited' }));
    const save = () => within(answer).getByRole('button', { name: 'Save row' });
    expect(blocked(save())).toBe('Say why it was not audited');
    await user.type(
      within(answer).getByRole('textbox', { name: 'Why it was not audited' }),
      'The records owner was away.',
    );
    await user.click(save());
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoAuditChecklistItem',
        { id: Q3.id, itemId: open.id },
        {
          version: open.version,
          result: 'NOT_AUDITED',
          notAuditedReason: 'The records owner was away.',
        },
      ),
    );
  });

  it(
    'records a nonconformity finding from a row, raising its nonconformity',
    { timeout: JOURNEY_TIMEOUT },
    async () => {
      record(Q3, { conduct: true });
      const open = ISO.auditChecklists[Q3.id]!.find((r) => r.result === null)!;
      const row = screen.getByRole('listitem', { name: `Checklist row: ${open.question}` });
      await user.click(within(row).getByRole('button', { name: 'Record finding' }));
      const form = screen.getByRole('dialog', { name: 'Record finding' });
      expect(within(form).getByText(`For the checklist row “${open.question}”.`)).toBeTruthy();
      await user.type(
        within(form).getByRole('textbox', { name: 'Description' }),
        'Backups are not restored to test them.',
      );
      const submit = () => within(form).getByRole('button', { name: 'Record finding' });
      expect(blocked(submit())).toBe('A nonconformity needs an owner, an approver and a due date');
      await pick(form, 'Owner', 'Rohan Joshi');
      await pick(form, 'Approver', 'Nisha Patil');
      await date(form, 'Due on', '31 Jan 2025');
      expect(within(form).getByText('Rohan Joshi works on it; Nisha Patil approves.')).toBeTruthy();
      expect(blocked(submit())).toBeNull();
      await user.click(submit());
      await waitFor(() =>
        expect(actions.isoWrite).toHaveBeenCalledWith(
          C,
          'createIsoInternalFinding',
          { id: Q3.id },
          {
            type: 'MINOR_NC',
            clauseIds: [open.clauseId],
            unitId: open.unitId,
            description: 'Backups are not restored to test them.',
            checklistItemId: open.id,
            nonconformity: { ownerId: ROHAN, approverId: NISHA, dueOn: '2025-01-31' },
          },
        ),
      );
    },
  );

  it('moves a finding only within its group', async () => {
    const ncFinding = { type: 'MINOR_NC' as const };
    const nc = { id: 'n', state: 'OPEN' as const, ownerId: ROHAN };
    expect(findingTypes(ncFinding, nc, SAMEER)).toEqual(['MAJOR_NC', 'MINOR_NC']);
    expect(findingTypes(ncFinding, nc, ROHAN)).toEqual(['MINOR_NC']);
    expect(findingTypes(ncFinding, { ...nc, state: 'ACTIONS_PLANNED' }, SAMEER)).toEqual([
      'MINOR_NC',
    ]);
    expect(findingTypes(ncFinding, undefined, SAMEER)).toEqual(['MINOR_NC']);
    expect(findingTypes({ type: 'OFI' }, undefined, SAMEER)).toEqual([
      'OBSERVATION',
      'OFI',
      'GOOD_PRACTICE',
    ]);

    const finding = ISO.auditFindings[Q2.id]!.find((f) => f.type === 'OFI')!;
    record({ ...Q2, state: 'IN_PROGRESS' }, { conduct: true });
    const item = screen.getByRole('listitem', {
      name: `Finding: ${finding.description.slice(0, 60).trim()}`,
    });
    await user.click(within(item).getByRole('button', { name: 'Edit finding' }));
    const form = screen.getByRole('dialog', { name: 'Edit finding' });
    await pick(form, 'Type', 'Observation');
    await user.click(within(form).getByRole('button', { name: 'Save finding' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoInternalFinding',
        { id: Q2.id, findingId: finding.id },
        { version: finding.version, type: 'OBSERVATION' },
      ),
    );
  });
});
