'use client';
// One internal audit's page (model §3.7, §4.3): where it stands, with exactly the steps its `allowedActions` lists, its
// plan and team, the checklist, the findings, the audit report download once reported, and its files.
import type {
  AuditChecklistItem,
  AuditFinding,
  InternalAuditView,
  NcState,
} from '@canopy/contracts';
import { Button, DateInput, formatDate, Textarea } from '@canopy/ui';
import { useState } from 'react';

import { isoWrite } from '../../_lib/actions';
import { namesOf, nameOf, type PersonOption } from '../../_lib/people';
import { ClausePicker, type ClauseOption } from '../../_components/ClausePicker';
import { FormDrawer, StepButton, useSave } from '../../_components/controls';
import { ExportButton } from '../../_components/ExportButton';
import { FilesPanel } from '../../_components/FilesPanel';
import { StatePill } from '../../_components/IsoStates';
import { clausesWithoutResult, selfAuditorNames } from '../audit-model';
import { AuditForm, type AuditPlanProps } from '../AuditForm';
import { auditDates } from '../AuditsView';
import { Checklist, Findings } from './AuditWork';

/** A finding's nonconformity as far as the page needs it. */
export type FindingNc = { id: string; state: NcState; ownerId: string };

export type AuditRecordProps = {
  clientId: string;
  audit: InternalAuditView;
  checklist: AuditChecklistItem[];
  findings: AuditFinding[];
  ncs: FindingNc[];
  people: PersonOption[];
  units: { id: string; name: string }[];
  /** The units a checklist row or finding may name: the audit's, or its system's when it names none. */
  auditUnits: { id: string; name: string }[];
  /** The system's clauses by name. */
  clauses: ClauseOption[];
  personId: string;
  /** Account admins, consultants and client admins plan and change audits. */
  canEdit: boolean;
  /** The audit's auditors (and FA, CO, CA) keep its checklist and findings. */
  canConduct: boolean;
  canEditFindings: boolean;
  plan: AuditPlanProps;
  today: string;
  timeZone: string;
};

const OPEN_STATES: readonly InternalAuditView['state'][] = ['PLANNED', 'IN_PROGRESS'];

export function AuditRecord(props: AuditRecordProps) {
  const { clientId, audit, checklist, people, units, clauses, canEdit, timeZone } = props;
  const [editing, setEditing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const can = (step: InternalAuditView['allowedActions'][number]) =>
    audit.allowedActions.includes(step);
  const open = OPEN_STATES.includes(audit.state);
  const clauseName = (id: string) => clauses.find((c) => c.id === id)?.label ?? 'A clause';
  const self = selfAuditorNames(audit, people);
  const reported = audit.state === 'REPORTED' || audit.state === 'CLOSED';

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="audit-status"
        className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="audit-status" className="text-card text-ink">
            Where it stands
          </h2>
          <div className="flex flex-wrap gap-2">
            {can('START') ? (
              <StepButton
                label="Start audit"
                variant="primary"
                title="Start this audit?"
                body="Its findings can be recorded once it is started."
                done="The audit is started."
                run={() =>
                  isoWrite(
                    clientId,
                    'startIsoInternalAudit',
                    { id: audit.id },
                    { version: audit.version },
                  )
                }
              />
            ) : null}
            {can('REPORT') ? (
              <Button size="sm" variant="primary" onClick={() => setReporting(true)}>
                Report audit
              </Button>
            ) : null}
            {can('CLOSE') ? (
              <StepButton
                label="Close audit"
                variant="primary"
                title="Close this audit?"
                body="Every nonconformity it raised has left Open. The audit is then final."
                done="The audit is closed."
                run={() =>
                  isoWrite(
                    clientId,
                    'closeIsoInternalAudit',
                    { id: audit.id },
                    { version: audit.version },
                  )
                }
              />
            ) : null}
            {can('CANCEL') ? (
              <StepButton
                label="Cancel audit"
                title="Cancel this audit?"
                body="It stays in the programme as cancelled, and its clauses count as not covered."
                reason={{ label: 'Why it is cancelled' }}
                tone="danger"
                done="The audit is cancelled."
                run={(reason) =>
                  isoWrite(
                    clientId,
                    'cancelIsoInternalAudit',
                    { id: audit.id },
                    { version: audit.version, reason: reason ?? '' },
                  )
                }
              />
            ) : null}
          </div>
        </div>
        <p className="flex flex-wrap items-center gap-2 text-body">
          <StatePill of="InternalAuditState" value={audit.state} />
          <span>planned {auditDates(audit)}</span>
          {audit.reportedOn ? <span>· reported {formatDate(audit.reportedOn)}</span> : null}
        </p>
        {audit.cancelReason ? (
          <p className="whitespace-pre-line text-body text-ink">Cancelled: {audit.cancelReason}</p>
        ) : null}
        {audit.summary ? (
          <div className="flex flex-col gap-1">
            <h3 className="text-body font-semibold text-ink">Summary</h3>
            <p className="whitespace-pre-line text-body text-ink">{audit.summary}</p>
          </div>
        ) : null}
        {reported ? (
          <ExportButton
            clientId={clientId}
            kind="ISO_AUDIT_REPORT_PDF"
            filters={new URLSearchParams({ internalAuditId: audit.id }).toString()}
            label="Download audit report (PDF)"
          />
        ) : null}
      </section>

      <section
        aria-labelledby="audit-details"
        className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="audit-details" className="text-card text-ink">
            Plan and team
          </h2>
          {canEdit && open ? (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit audit
            </Button>
          ) : null}
        </div>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-body sm:grid-cols-[11rem_1fr]">
          <dt className="text-muted">Clauses</dt>
          <dd>
            {audit.clauseIds.length ? audit.clauseIds.map(clauseName).join('; ') : 'None yet'}
          </dd>
          <dt className="text-muted">Units</dt>
          <dd>
            {audit.unitIds.length
              ? audit.unitIds
                  .map((id) => units.find((u) => u.id === id)?.name ?? 'Unknown unit')
                  .join(', ')
              : 'Every unit of the system (none counts as covered)'}
          </dd>
          <dt className="text-muted">Lead auditor</dt>
          <dd>{nameOf(people, audit.leadAuditorId)}</dd>
          <dt className="text-muted">Other auditors</dt>
          <dd>{audit.auditorIds.length ? namesOf(people, audit.auditorIds) : 'None'}</dd>
          <dt className="text-muted">Auditees</dt>
          <dd>{audit.auditeeIds.length ? namesOf(people, audit.auditeeIds) : 'None named'}</dd>
          <dt className="text-muted">Reported to</dt>
          <dd>
            {audit.reportedToIds.length ? namesOf(people, audit.reportedToIds) : 'Not named yet'}
          </dd>
        </dl>
        {self || audit.independenceNote ? (
          <div className="flex flex-col gap-1 rounded-card bg-warn-soft p-3 text-body text-warn-ink">
            {self ? <p>Auditing their own work: {self}.</p> : null}
            {audit.independenceNote ? (
              <p className="whitespace-pre-line">Independence: {audit.independenceNote}</p>
            ) : null}
          </div>
        ) : null}
      </section>

      <Checklist {...props} />
      <Findings {...props} />

      <FilesPanel
        clientId={clientId}
        subject={{ type: 'internal_audit', id: audit.id }}
        editable={props.canConduct && audit.state !== 'CLOSED' && audit.state !== 'CANCELLED'}
        helper="The audit plan, notes and evidence seen."
        timeZone={timeZone}
      />

      {editing ? (
        <AuditForm {...props.plan} audit={audit} onClose={() => setEditing(false)} />
      ) : null}
      {reporting ? (
        <ReportForm {...props} checklist={checklist} onClose={() => setReporting(false)} />
      ) : null}
    </div>
  );
}

function ReportForm({
  clientId,
  audit,
  checklist,
  people,
  clauses,
  today,
  onClose,
}: AuditRecordProps & { onClose: () => void }) {
  const [summary, setSummary] = useState('');
  const [reportedOn, setReportedOn] = useState<string | null>(today);
  const [reportedToIds, setReportedToIds] = useState(audit.reportedToIds);
  const { pending, error, save } = useSave();
  const missing = clausesWithoutResult(audit, checklist);
  const clauseName = (id: string) => clauses.find((c) => c.id === id)?.label ?? 'A clause';
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Report audit"
      submitLabel="Report audit"
      pending={pending}
      error={error}
      disabledReason={
        missing.length > 0
          ? 'Give a checklist result for every clause first'
          : summary.trim() === ''
            ? 'Write the summary'
            : !reportedOn
              ? 'Give the report date'
              : reportedToIds.length === 0
                ? 'Name who it is reported to'
                : undefined
      }
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'reportIsoInternalAudit',
              { id: audit.id },
              {
                version: audit.version,
                summary: summary.trim(),
                reportedOn: reportedOn!,
                reportedToIds,
              },
            ),
          'The audit is reported.',
        ).then((ok) => ok && onClose())
      }
    >
      {missing.length > 0 ? (
        <p className="rounded-card bg-warn-soft p-3 text-body text-warn-ink">
          No checklist result yet for: {missing.map(clauseName).join('; ')}.
        </p>
      ) : null}
      <Textarea
        label="Summary"
        helper="What was audited, how well it works, and the findings in a line each."
        value={summary}
        maxLength={8000}
        onChange={(e) => setSummary(e.target.value)}
      />
      <DateInput
        label="Reported on"
        value={reportedOn}
        onValueChange={setReportedOn}
        max={today}
        today={today}
      />
      <ClausePicker
        label="Reported to"
        options={people.map((p) => ({ id: p.id, label: p.name }))}
        value={reportedToIds}
        onChange={setReportedToIds}
        max={20}
        placeholder="Type a name"
        emptyText="No one matches"
        unknown="Someone not listed"
      />
    </FormDrawer>
  );
}
