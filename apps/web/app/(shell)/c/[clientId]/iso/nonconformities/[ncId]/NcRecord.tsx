'use client';
// One nonconformity, incident or near miss (model §3.10, §3.11, §4.1): what happened, where it came from, its
// investigation, its corrective actions and the check that they worked. The steps offered are exactly the view's
// `allowedActions` (model §10); the owner edits every other field through the PATCH, and account admins, consultants and
// client admins reassign owner, approver, dates, severity and outcome, always with a reason.
import type { IsoActionView, IsoStandard, NcAction, NonconformityView } from '@canopy/contracts';
import { Button, formatDate, formatTimestamp } from '@canopy/ui';
import NextLink from 'next/link';
import { useState, type ReactNode } from 'react';

import { isoWrite } from '../../_lib/actions';
import { nameOf, namesOf, type PersonOption } from '../../_lib/people';
import { standardTitleByCode, word } from '../../_lib/words';
import { ActionsPanel, type ActionEditing } from '../../_components/ActionsPanel';
import { StepButton } from '../../_components/controls';
import { FilesPanel } from '../../_components/FilesPanel';
import { StatePill, TimingPill } from '../../_components/IsoStates';
import { PERSONAL_DATA, REPORTABLE_NOTICE } from '../IncidentFields';
import { ncOpen, type NcSystemOption } from '../nc-model';
import { EditDetails, EditIncident, EditInvestigation, Reassign } from './NcForms';
import { NcStepForm, STEP_LABELS, type FormStep } from './NcSteps';

/** A record the nonconformity names, by name, with its page when the person may open it. */
export type LinkedRecord = { id: string; label: string; href: string | null; due?: string };

export type NcRecordProps = {
  clientId: string;
  nc: NonconformityView;
  actions: IsoActionView[];
  people: PersonOption[];
  /** The units of its system, for editing. */
  units: { id: string; name: string }[];
  unitName: string;
  systemName: string;
  /** Its system's standards, clauses and live risk items, for editing. */
  system: NcSystemOption | null;
  standards: IsoStandard[];
  /** Its system's risk items, archived ones too, by name. */
  risks: LinkedRecord[];
  liveRiskIds: string[];
  /** Its system's documents, obsolete ones too, by name. */
  documents: LinkedRecord[];
  sourceInstance: LinkedRecord | null;
  statutory: LinkedRecord | null;
  /** The audit finding that raised it. */
  raisedBy: LinkedRecord | null;
  raisedFromRisk: LinkedRecord | null;
  /** The owner (or a client admin) edits its fields. */
  canEdit: boolean;
  /** Account admins, consultants and client admins reassign it. */
  canReassign: boolean;
  canAddAction: boolean;
  actionEditing: ActionEditing;
  today: string;
  timeZone: string;
};

type Editing = 'details' | 'investigation' | 'incident' | 'reassign' | null;

const FORM_STEPS: readonly NcAction[] = [
  'ADD_ROOT_CAUSE',
  'PLAN_ACTIONS',
  'SUBMIT_NO_ACTION',
  'SUBMIT',
  'VERIFY_EFFECTIVE',
  'VERIFY_NOT_EFFECTIVE',
  'REOPEN',
];

export function NcRecord(props: NcRecordProps) {
  const { clientId, nc, people, canEdit, today } = props;
  const [editing, setEditing] = useState<Editing>(null);
  const [step, setStep] = useState<FormStep | null>(null);
  const open = ncOpen(nc);
  const steps = nc.allowedActions.filter((a): a is FormStep => FORM_STEPS.includes(a));
  const close = () => setEditing(null);

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="nc-status"
        className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="nc-status" className="text-card text-ink">
            Where it stands
          </h2>
          {steps.length > 0 || nc.allowedActions.includes('CANCEL') ? (
            <div className="flex flex-wrap gap-2">
              {steps.map((s, i) => (
                <Button
                  key={s}
                  size="sm"
                  variant={i === 0 ? 'primary' : 'secondary'}
                  onClick={() => setStep(s)}
                >
                  {STEP_LABELS[s]}
                </Button>
              ))}
              {nc.allowedActions.includes('CANCEL') ? (
                <StepButton
                  label="Cancel nonconformity"
                  title="Cancel this nonconformity?"
                  body="It is closed without verification and cannot be reopened. Its open actions can still be cancelled."
                  reason={{ label: 'Why it is cancelled' }}
                  tone="danger"
                  done="It is cancelled."
                  run={(reason) =>
                    isoWrite(
                      clientId,
                      'cancelIsoNc',
                      { id: nc.id },
                      { version: nc.version, reason: reason ?? '' },
                    )
                  }
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="flex flex-wrap items-center gap-2 text-body">
          <StatePill of="NcState" value={nc.state} />
          {open ? (
            <>
              <span>due {formatDate(nc.dueOn)}</span>
              <TimingPill status={nc.status} />
            </>
          ) : nc.closedOn ? (
            <span>closed {formatDate(nc.closedOn)}</span>
          ) : null}
        </p>
        {nc.effectivenessDueOn ? (
          <p className="text-body text-ink">
            Effectiveness check due {formatDate(nc.effectivenessDueOn)}
            {nc.status.effectivenessOverdueDays !== null
              ? `, overdue ${nc.status.effectivenessOverdueDays} ${nc.status.effectivenessOverdueDays === 1 ? 'day' : 'days'}`
              : ''}
            .
          </p>
        ) : null}
        {nc.effective === false && open ? (
          <p className="text-body text-warn-ink">
            The last check found the action did not work, so it is being worked again.
          </p>
        ) : null}
        {nc.cancelReason ? <Text label="Why it was cancelled" value={nc.cancelReason} /> : null}
      </section>

      <Section
        id="nc-details"
        title="Details"
        actions={
          <>
            {canEdit && open ? (
              <Button size="sm" onClick={() => setEditing('details')}>
                Edit details
              </Button>
            ) : null}
            {props.canReassign && open ? (
              <Button size="sm" onClick={() => setEditing('reassign')}>
                Reassign
              </Button>
            ) : null}
          </>
        }
      >
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-body sm:grid-cols-[12rem_1fr]">
          <Row label="Where it came from">{word('NcSource', nc.source)}</Row>
          {props.raisedBy ? <Row label="Raised by">{linked(props.raisedBy)}</Row> : null}
          {props.raisedFromRisk ? (
            <Row label="Risk item">{linked(props.raisedFromRisk)}</Row>
          ) : null}
          <Row label="Register activity">
            {props.sourceInstance ? linked(props.sourceInstance) : 'None linked'}
          </Row>
          <Row label="Severity">{word('NcSeverity', nc.severity)}</Row>
          <Row label="Management system">{props.systemName}</Row>
          <Row label="Standards">
            {nc.standards.map((s) => standardTitleByCode(props.standards, s)).join(', ')}
          </Row>
          <Row label="Clauses">
            {nc.clauseIds.length === 0
              ? 'None given'
              : nc.clauseIds
                  .map((id) => props.system?.clauses.find((c) => c.id === id)?.label ?? 'A clause')
                  .join('; ')}
          </Row>
          <Row label="Unit">{props.unitName}</Row>
          <Row label="Reported">
            {`by ${nameOf(people, nc.reportedById)} on ${formatDate(nc.reportedOn)}`}
          </Row>
          <Row label="Owner">{nameOf(people, nc.ownerId)}</Row>
          <Row label="Approver">{nameOf(people, nc.approverId)}</Row>
          <Row label="What happened or was found">
            <span className="whitespace-pre-line">{nc.description}</span>
          </Row>
        </dl>
      </Section>

      {nc.incident ? (
        <Section
          id="nc-incident"
          title={nc.source === 'NEAR_MISS' ? 'The near miss' : 'The incident'}
          actions={
            canEdit && open ? (
              <Button size="sm" onClick={() => setEditing('incident')}>
                Edit incident
              </Button>
            ) : null
          }
        >
          <p className="text-meta text-muted">{PERSONAL_DATA}</p>
          {nc.incident.reportable ? (
            <p className="rounded-card bg-warn-soft p-3 text-body text-warn-ink">
              {props.statutory ? 'A statutory accident notice is due: ' : REPORTABLE_NOTICE}
              {props.statutory ? linked(props.statutory) : null}
            </p>
          ) : null}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-body sm:grid-cols-[12rem_1fr]">
            <Row label="When">{formatTimestamp(nc.incident.occurredAt, props.timeZone)}</Row>
            <Row label="Where">{nc.incident.location}</Row>
            <Row label="Kind">{word('IncidentType', nc.incident.type)}</Row>
            <Row label="Outcome">
              {word('IncidentOutcome', nc.incident.outcome)}
              {nc.incident.lostDays !== null
                ? `, ${nc.incident.lostDays} ${nc.incident.lostDays === 1 ? 'day' : 'days'} lost`
                : ''}
            </Row>
            <Row label="Who was involved">
              {nc.incident.personCategory
                ? word('IncidentPersonCategory', nc.incident.personCategory)
                : 'Not given'}
            </Row>
            <Row label="Reportable">{nc.incident.reportable ? 'Yes' : 'No'}</Row>
            <Row label="Investigated by">{namesOf(people, nc.incident.investigatorIds)}</Row>
            <Row label="Worker participation">
              {nc.incident.workerParticipation
                ? 'A worker who is not a manager took part'
                : 'No worker who is not a manager took part yet'}
            </Row>
          </dl>
        </Section>
      ) : null}

      <Section
        id="nc-investigation"
        title="Investigation"
        actions={
          canEdit && open ? (
            <Button size="sm" onClick={() => setEditing('investigation')}>
              Edit investigation
            </Button>
          ) : null
        }
      >
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-body sm:grid-cols-[12rem_1fr]">
          <TextRow label="Containment" value={nc.containment} />
          <TextRow label="Correction" value={nc.correction} />
          <Row label="Disposition">
            {nc.disposition
              ? `${word('NcDisposition', nc.disposition)}, authorised by ${nameOf(people, nc.dispositionAuthorisedById)}`
              : 'None'}
          </Row>
          <Row label="Root cause">
            {nc.rootCause ? (
              <span className="whitespace-pre-line">
                {nc.rootCauseMethod ? `${word('RootCauseMethod', nc.rootCauseMethod)}: ` : ''}
                {nc.rootCause}
              </span>
            ) : (
              'Not recorded'
            )}
          </Row>
          <TextRow label="Similar occurrences" value={nc.similarOccurrences} />
          <Row label="Risks reviewed">{links(props.risks, nc.relatedRiskItemIds)}</Row>
          <Row label="Risks updated">{links(props.risks, nc.updatedRiskItemIds)}</Row>
          <TextRow label="Risk review" value={nc.riskReview} />
          <TextRow label="Change to the system" value={nc.systemChange} />
          <Row label="Documents changed">{links(props.documents, nc.changedDocumentIds)}</Row>
          {nc.noActionReason ? (
            <TextRow label="Why no corrective action" value={nc.noActionReason} />
          ) : null}
          {nc.effectivenessNote ? (
            <TextRow label="Effectiveness" value={nc.effectivenessNote} />
          ) : null}
        </dl>
      </Section>

      <ActionsPanel
        clientId={clientId}
        subject={{ type: 'NONCONFORMITY', id: nc.id }}
        subjectOpen={open}
        actions={props.actions}
        people={people}
        canAdd={props.canAddAction}
        editing={props.actionEditing}
        today={today}
      />

      <FilesPanel
        clientId={clientId}
        subject={{ type: 'nonconformity', id: nc.id }}
        editable={canEdit && open}
        helper={
          nc.incident
            ? 'Only people who may open incidents can read these files. Personal details of anyone involved go here, and nowhere else.'
            : undefined
        }
        timeZone={props.timeZone}
      />

      {editing === 'details' ? <EditDetails {...props} onClose={close} /> : null}
      {editing === 'investigation' ? <EditInvestigation {...props} onClose={close} /> : null}
      {editing === 'incident' && nc.incident ? (
        <EditIncident {...props} incident={nc.incident} onClose={close} />
      ) : null}
      {editing === 'reassign' ? <Reassign {...props} onClose={close} /> : null}
      {step ? <NcStepForm {...props} step={step} onClose={() => setStep(null)} /> : null}
    </div>
  );
}

function Section({
  id,
  title,
  actions,
  children,
}: {
  id: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={id} className="text-card text-ink">
          {title}
        </h2>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function TextRow({ label, value }: { label: string; value: string | null }) {
  return (
    <Row label={label}>
      <span className="whitespace-pre-line">{value ?? 'Not recorded'}</span>
    </Row>
  );
}

function Text({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-body text-ink">
      <span className="text-muted">{label}: </span>
      <span className="whitespace-pre-line">{value}</span>
    </p>
  );
}

function linked(r: LinkedRecord): ReactNode {
  const text = r.due ? `${r.label} · due ${formatDate(r.due)}` : r.label;
  return r.href ? (
    <NextLink href={r.href} prefetch={false} className="text-forest underline">
      {text}
    </NextLink>
  ) : (
    text
  );
}

function links(all: readonly LinkedRecord[], ids: readonly string[]): ReactNode {
  if (ids.length === 0) return 'None';
  return (
    <ul className="flex flex-col gap-1">
      {ids.map((id) => {
        const r = all.find((x) => x.id === id) ?? {
          id,
          label: 'A record you cannot open',
          href: null,
        };
        return <li key={id}>{linked(r)}</li>;
      })}
    </ul>
  );
}
