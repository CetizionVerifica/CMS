'use client';
// The audit programme and its internal audits (packages.md ISO-6c, model §3.7). Each programme shows its FY's
// coverage (M4 `auditProgrammeCoverage`, from the API): what is planned, reported and cancelled, and the clauses and
// units no audit covers yet. The audit list takes the API's filters; a row opens the audit's page.
import type { AuditProgrammeView } from '@canopy/contracts';
import { Button, formatDate, Textarea, type DataTableProps, type FilterDef } from '@canopy/ui';
import NextLink from 'next/link';
import { useState } from 'react';

import { isoWrite } from '../_lib/actions';
import { FormDrawer, useSave } from '../_components/controls';
import { IsoFilterBar } from '../_components/IsoFilterBar';
import { StatePill } from '../_components/IsoStates';
import { IsoTable } from '../_components/IsoTable';
import type { AuditRow } from './audit-model';
import { AuditForm, type AuditPlanProps } from './AuditForm';

export type ProgrammeCard = {
  programme: AuditProgrammeView;
  /** The system's name when the client has more than one. */
  systemName: string | null;
  uncoveredClauses: string[];
  uncoveredUnits: string[];
};

export function auditDates(a: { plannedStart: string; plannedEnd: string }): string {
  return a.plannedStart === a.plannedEnd
    ? formatDate(a.plannedStart)
    : `${formatDate(a.plannedStart)} to ${formatDate(a.plannedEnd)}`;
}

const columns: DataTableProps<AuditRow>['columns'] = [
  {
    id: 'title',
    header: 'Audit',
    accessorFn: (r) => ({ title: r.title, sub: r.sub }) as never,
    meta: { type: 'title', locked: true },
    size: 400,
  },
  {
    id: 'dates',
    header: 'Planned',
    accessorFn: (r) => auditDates(r.audit) as never,
    meta: { type: 'text' },
    size: 220,
  },
  {
    id: 'state',
    header: 'State',
    accessorFn: (r) => r.audit.state as never,
    cell: (ctx) => <StatePill of="InternalAuditState" value={ctx.row.original.audit.state} />,
    size: 150,
  },
  {
    id: 'lead',
    header: 'Lead auditor',
    accessorFn: (r) => r.leadName as never,
    meta: { type: 'text' },
    size: 170,
  },
];

const listOf = (items: readonly string[], max = 8) =>
  items.length > max
    ? `${items.slice(0, max).join(', ')} and ${items.length - max} more`
    : items.join(', ');

export function AuditsView({
  clientId,
  fy,
  programmes,
  missingProgrammes,
  canManageProgrammes,
  rows,
  filters,
  filterValue,
  fromOverview,
  clearHref,
  plan,
}: {
  clientId: string;
  /** The client's current FY. */
  fy: string;
  programmes: ProgrammeCard[];
  /** Systems with no programme for the current FY. */
  missingProgrammes: { id: string; name: string }[];
  canManageProgrammes: boolean;
  rows: AuditRow[];
  filters: FilterDef[];
  filterValue: Record<string, string[]>;
  /** The list is the exact set an overview number counts (`ids`). */
  fromOverview: boolean;
  clearHref: string;
  plan: AuditPlanProps | null;
}) {
  const [planning, setPlanning] = useState(false);
  const [notes, setNotes] = useState<AuditProgrammeView | null>(null);
  const [starting, setStarting] = useState<{ id: string; name: string } | null>(null);
  const cards = [...programmes].sort((a, b) => b.programme.fy.localeCompare(a.programme.fy));

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="programmes" className="flex flex-col gap-3">
        <h2 id="programmes" className="text-section text-ink">
          Audit programme
        </h2>
        {canManageProgrammes
          ? missingProgrammes.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface p-4"
              >
                <p className="text-body text-muted">
                  {missingProgrammes.length > 1 || cards.some((c) => c.systemName)
                    ? `${s.name} has no programme for FY ${fy} yet.`
                    : `No programme for FY ${fy} yet.`}
                </p>
                <Button size="sm" onClick={() => setStarting(s)}>
                  Start FY {fy} programme
                </Button>
              </div>
            ))
          : null}
        {cards.length === 0 && !canManageProgrammes ? (
          <p className="rounded-card border border-line bg-surface p-4 text-body text-muted">
            No audit programme yet.
          </p>
        ) : null}
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {cards.map(({ programme: p, systemName, uncoveredClauses, uncoveredUnits }) => (
            <li
              key={p.id}
              aria-label={`Programme for FY ${p.fy}${systemName ? `, ${systemName}` : ''}`}
              className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="text-card text-ink">
                  FY {p.fy}
                  {systemName ? <span className="text-muted"> · {systemName}</span> : null}
                </h3>
                {canManageProgrammes ? (
                  <Button size="sm" variant="secondary" onClick={() => setNotes(p)}>
                    Edit notes
                  </Button>
                ) : null}
              </div>
              <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1 text-body">
                <dt className="text-muted">Planned</dt>
                <dd>{p.coverage.planned.count}</dd>
                <dt className="text-muted">Reported</dt>
                <dd>{p.coverage.reported.count}</dd>
                <dt className="text-muted">Cancelled</dt>
                <dd>{p.coverage.cancelled.count}</dd>
              </dl>
              <p className="text-meta text-muted">
                {uncoveredClauses.length === 0
                  ? 'Every clause is covered.'
                  : `${uncoveredClauses.length} ${uncoveredClauses.length === 1 ? 'clause' : 'clauses'} not yet covered: ${listOf(uncoveredClauses)}.`}
                {uncoveredUnits.length > 0
                  ? ` Units not yet covered: ${listOf(uncoveredUnits)}.`
                  : ' Every unit is covered.'}
              </p>
              {p.notes ? <p className="whitespace-pre-line text-body text-ink">{p.notes}</p> : null}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="audits" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="audits" className="text-section text-ink">
            Internal audits
          </h2>
          {plan && plan.programmes.length > 0 ? (
            <Button variant="primary" onClick={() => setPlanning(true)}>
              Plan an internal audit
            </Button>
          ) : null}
        </div>
        {fromOverview ? (
          <p className="text-body text-muted">
            Showing the audits the ISO overview counted.{' '}
            <NextLink href={clearHref} prefetch={false} className="text-forest underline">
              Show every audit
            </NextLink>
          </p>
        ) : null}
        <IsoFilterBar
          filters={filters}
          value={filterValue}
          resultText={`${rows.length} ${rows.length === 1 ? 'audit' : 'audits'}`}
          resultCount={rows.length}
          search={{ placeholder: 'Search the title' }}
        />
        <IsoTable
          label="Internal audits"
          columns={columns}
          data={rows}
          rowId={(r) => r.id}
          rowLabel={(r) => r.title}
          rowHref={(r) => `/c/${clientId}/iso/audits/${r.id}`}
          countNoun={{ one: 'audit', other: 'audits' }}
          empty={
            <p className="p-6 text-body text-muted">
              Nothing matches. Clear a filter, or plan the first audit of the programme.
            </p>
          }
        />
      </section>

      {planning && plan ? <AuditForm {...plan} onClose={() => setPlanning(false)} /> : null}
      {notes ? (
        <ProgrammeNotes clientId={clientId} programme={notes} onClose={() => setNotes(null)} />
      ) : null}
      {starting ? (
        <StartProgramme
          clientId={clientId}
          system={starting}
          fy={fy}
          onClose={() => setStarting(null)}
        />
      ) : null}
    </div>
  );
}

function StartProgramme({
  clientId,
  system,
  fy,
  onClose,
}: {
  clientId: string;
  system: { id: string; name: string };
  fy: string;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState('');
  const { pending, error, save } = useSave();
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Start FY ${fy} programme`}
      submitLabel="Start programme"
      pending={pending}
      error={error}
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'createIsoAuditProgramme',
              {},
              { managementSystemId: system.id, fy, notes: notes.trim() || null },
            ),
          'The programme is started.',
        ).then((ok) => ok && onClose())
      }
    >
      <p className="text-body text-muted">
        The audits of {system.name} for FY {fy}. Plan each audit in it once it is started.
      </p>
      <Textarea
        label="Notes (optional)"
        helper="How the year's audits are spread, for example one a quarter."
        value={notes}
        maxLength={4000}
        onChange={(e) => setNotes(e.target.value)}
      />
    </FormDrawer>
  );
}

function ProgrammeNotes({
  clientId,
  programme,
  onClose,
}: {
  clientId: string;
  programme: AuditProgrammeView;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState(programme.notes ?? '');
  const { pending, error, save } = useSave();
  const value = notes.trim() || null;
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={`FY ${programme.fy} programme notes`}
      submitLabel="Save notes"
      pending={pending}
      error={error}
      disabledReason={value === programme.notes ? 'Nothing has changed' : undefined}
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'updateIsoAuditProgramme',
              { id: programme.id },
              { version: programme.version, notes: value },
            ),
          'The notes are saved.',
        ).then((ok) => ok && onClose())
      }
    >
      <Textarea
        label="Notes"
        value={notes}
        maxLength={4000}
        onChange={(e) => setNotes(e.target.value)}
      />
    </FormDrawer>
  );
}
