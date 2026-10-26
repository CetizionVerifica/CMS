'use client';
// One objective (model §3.6): what it aims at and by when, how its readings stand against the target (and which
// periods have no reading yet), the risk items it addresses, its readings and its plan. While open, its owner records
// and corrects readings and closes it with its outcome; readings and actions stop once it is closed.
import type {
  IsoActionView,
  IsoStandard,
  ObjectiveOutcome,
  ObjectiveReading,
  ObjectiveView,
} from '@canopy/contracts';
import { Button, DateInput, formatDate, Input, RadioGroup, Textarea } from '@canopy/ui';
import NextLink from 'next/link';
import { useState } from 'react';

import { isoWrite } from '../../_lib/actions';
import { nameOf, type PersonOption } from '../../_lib/people';
import { standardTitleByCode, word, WORDS } from '../../_lib/words';
import { ActionsPanel, type ActionEditing } from '../../_components/ActionsPanel';
import { FormDrawer, useSave } from '../../_components/controls';
import { IsoPill } from '../../_components/IsoStates';
import { EditObjective, type ObjectiveSystemOption } from '../ObjectiveForm';
import { amount, progressText, readingRuleText, standing } from '../objectives-words';

export type LinkedRisk = { id: string; label: string; href: string | null };

export type ObjectiveRecordProps = {
  clientId: string;
  objective: ObjectiveView;
  readings: ObjectiveReading[];
  actions: IsoActionView[];
  standards: IsoStandard[];
  system: ObjectiveSystemOption | undefined;
  linkedRisks: LinkedRisk[];
  people: PersonOption[];
  /** Managers, and the objective's owner (contracts role table). */
  canEdit: boolean;
  /** Managers name a new owner. */
  canReassign: boolean;
  canAddAction: boolean;
  actionEditing: ActionEditing;
  today: string;
};

const num = (s: string): number | null => {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function ObjectiveRecord(props: ObjectiveRecordProps) {
  const { clientId, objective: o, standards, people, canEdit, today } = props;
  const [editing, setEditing] = useState(false);
  const [closing, setClosing] = useState(false);
  const open = o.closedOn === null;
  const s = standing(o);

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="objective-details"
        className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="objective-details" className="text-card text-ink">
            Details
          </h2>
          {canEdit && open ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit objective
              </Button>
              <Button size="sm" onClick={() => setClosing(true)}>
                Close objective
              </Button>
            </div>
          ) : null}
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-body sm:grid-cols-[12rem_1fr]">
          <dt className="text-muted">Standing</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <IsoPill tone={s.tone}>{s.text}</IsoPill>
            {o.closedOn ? (
              <span className="text-muted">closed {formatDate(o.closedOn)}</span>
            ) : null}
          </dd>
          <dt className="text-muted">Standards</dt>
          <dd>{o.standards.map((c) => standardTitleByCode(standards, c)).join(', ')}</dd>
          <dt className="text-muted">Target</dt>
          <dd>
            {word('ObjectiveDirection', o.direction)} to {amount(o.target, o.unitOfMeasure)} by{' '}
            {formatDate(o.dueOn)}
          </dd>
          <dt className="text-muted">Baseline</dt>
          <dd>{o.baseline === null ? 'Not recorded' : amount(o.baseline, o.unitOfMeasure)}</dd>
          <dt className="text-muted">Readings</dt>
          <dd>{readingRuleText(o.readingRule)}</dd>
          <dt className="text-muted">Owner</dt>
          <dd>{nameOf(people, o.ownerId)}</dd>
        </dl>
      </section>

      <section
        aria-labelledby="objective-progress"
        className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4"
      >
        <h2 id="objective-progress" className="text-card text-ink">
          Progress
        </h2>
        <p className="text-body text-ink">{progressText(o)}</p>
        {o.progress.missedReadings.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-body text-ink">
              {o.progress.missedReadings.length === 1
                ? 'One period has no reading:'
                : `${o.progress.missedReadings.length} periods have no reading:`}
            </p>
            <ul className="list-disc pl-5 text-body text-muted">
              {o.progress.missedReadings.map((m) => (
                <li key={m.periodStart}>
                  {formatDate(m.periodStart)} to {formatDate(m.periodEnd)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="objective-risks" className="flex flex-col gap-3">
        <h2 id="objective-risks" className="text-section text-ink">
          Risk items it addresses
        </h2>
        {props.linkedRisks.length === 0 ? (
          <p className="rounded-card border border-line bg-surface p-4 text-body text-muted">
            None linked.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
            {props.linkedRisks.map((r) => (
              <li key={r.id} className="p-3 text-body">
                {r.href ? (
                  <NextLink href={r.href} prefetch={false} className="text-forest underline">
                    {r.label}
                  </NextLink>
                ) : (
                  <span className="text-muted">{r.label}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Readings {...props} open={open} />

      <ActionsPanel
        clientId={clientId}
        subject={{ type: 'OBJECTIVE', id: o.id }}
        subjectOpen={open}
        actions={props.actions}
        people={people}
        canAdd={props.canAddAction}
        editing={props.actionEditing}
        today={today}
      />

      {editing ? (
        <EditObjective
          clientId={clientId}
          objective={o}
          system={props.system}
          people={people}
          canReassign={props.canReassign}
          today={today}
          onClose={() => setEditing(false)}
        />
      ) : null}
      {closing ? <CloseObjective {...props} onClose={() => setClosing(false)} /> : null}
    </div>
  );
}

function Readings({
  clientId,
  objective: o,
  readings,
  people,
  canEdit,
  today,
  open,
}: ObjectiveRecordProps & { open: boolean }) {
  const [adding, setAdding] = useState(false);
  const [correcting, setCorrecting] = useState<ObjectiveReading | null>(null);
  return (
    <section aria-labelledby="objective-readings" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="objective-readings" className="text-section text-ink">
          Readings
        </h2>
        {canEdit && open ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            Record reading
          </Button>
        ) : null}
      </div>
      {readings.length === 0 ? (
        <p className="rounded-card border border-line bg-surface p-4 text-body text-muted">
          No reading yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
          {readings.map((r) => (
            <li
              key={r.id}
              aria-label={`Reading for ${formatDate(r.periodStart)} to ${formatDate(r.periodEnd)}`}
              className="flex flex-wrap items-start justify-between gap-2 p-3"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="text-body text-ink">
                  {amount(r.value, o.unitOfMeasure)}
                  <span className="text-muted">
                    {' '}
                    for {formatDate(r.periodStart)} to {formatDate(r.periodEnd)}
                  </span>
                </p>
                {r.note ? (
                  <p className="whitespace-pre-line text-meta text-muted">{r.note}</p>
                ) : null}
                <p className="text-meta text-muted">Recorded by {nameOf(people, r.recordedById)}</p>
              </div>
              {canEdit && open ? (
                <Button size="sm" variant="ghost" onClick={() => setCorrecting(r)}>
                  Correct reading
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <AddReading
          clientId={clientId}
          objective={o}
          today={today}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {correcting ? (
        <CorrectReading
          clientId={clientId}
          objective={o}
          reading={correcting}
          onClose={() => setCorrecting(null)}
        />
      ) : null}
    </section>
  );
}

function AddReading({
  clientId,
  objective: o,
  today,
  onClose,
}: {
  clientId: string;
  objective: ObjectiveView;
  today: string;
  onClose: () => void;
}) {
  const [periodStart, setPeriodStart] = useState<string | null>(null);
  const [periodEnd, setPeriodEnd] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const { pending, error, save } = useSave();
  const missing = !periodStart
    ? 'Give the start of the period'
    : !periodEnd
      ? 'Give the end of the period'
      : periodEnd < periodStart
        ? 'The period ends on or after it starts'
        : num(value) === null
          ? 'Give the reading as a number'
          : undefined;
  return (
    <FormDrawer
      open
      onOpenChange={(next) => !next && onClose()}
      title="Record reading"
      submitLabel="Record reading"
      pending={pending}
      error={error}
      disabledReason={missing}
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'createIsoReading',
              { id: o.id },
              {
                periodStart: periodStart!,
                periodEnd: periodEnd!,
                value: num(value)!,
                note: note.trim() || null,
              },
            ),
          'The reading is recorded.',
        ).then((ok) => ok && onClose())
      }
    >
      <DateInput
        label="Period from"
        value={periodStart}
        onValueChange={setPeriodStart}
        max={today}
        today={today}
      />
      <DateInput label="Period to" value={periodEnd} onValueChange={setPeriodEnd} today={today} />
      <Input
        label={`Reading (${o.unitOfMeasure})`}
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Textarea
        label="Note (optional)"
        value={note}
        maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
      />
    </FormDrawer>
  );
}

function CorrectReading({
  clientId,
  objective: o,
  reading: r,
  onClose,
}: {
  clientId: string;
  objective: ObjectiveView;
  reading: ObjectiveReading;
  onClose: () => void;
}) {
  const [value, setValue] = useState(String(r.value));
  const [note, setNote] = useState(r.note ?? '');
  const { pending, error, save } = useSave();
  const body: Record<string, unknown> = { version: r.version };
  if (num(value) !== null && num(value) !== r.value) body.value = num(value);
  if ((note.trim() || null) !== r.note) body.note = note.trim() || null;
  const missing =
    num(value) === null
      ? 'Give the reading as a number'
      : Object.keys(body).length === 1
        ? 'Nothing has changed'
        : undefined;
  return (
    <FormDrawer
      open
      onOpenChange={(next) => !next && onClose()}
      title="Correct reading"
      submitLabel="Save reading"
      pending={pending}
      error={error}
      disabledReason={missing}
      onSubmit={() =>
        void save(
          () =>
            isoWrite(clientId, 'updateIsoReading', { id: o.id, readingId: r.id }, body as never),
          'The reading is saved.',
        ).then((ok) => ok && onClose())
      }
    >
      <p className="text-body text-muted">
        For {formatDate(r.periodStart)} to {formatDate(r.periodEnd)}. The period stays as it is.
      </p>
      <Input
        label={`Reading (${o.unitOfMeasure})`}
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Textarea
        label="Note (optional)"
        value={note}
        maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
      />
    </FormDrawer>
  );
}

function CloseObjective({
  clientId,
  objective: o,
  today,
  onClose,
}: ObjectiveRecordProps & { onClose: () => void }) {
  const [closedOn, setClosedOn] = useState<string | null>(today);
  const [outcome, setOutcome] = useState<ObjectiveOutcome | null>(null);
  const { pending, error, save } = useSave();
  return (
    <FormDrawer
      open
      onOpenChange={(next) => !next && onClose()}
      title="Close objective"
      submitLabel="Close objective"
      pending={pending}
      error={error}
      disabledReason={
        !closedOn ? 'Give the date it closes' : !outcome ? 'Choose the outcome' : undefined
      }
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'closeIsoObjective',
              { id: o.id },
              { version: o.version, closedOn: closedOn!, outcome: outcome! },
            ),
          'The objective is closed.',
        ).then((ok) => ok && onClose())
      }
    >
      <p className="text-body text-muted">
        Readings and actions stop once it is closed. {progressText(o)}.
      </p>
      <DateInput
        label="Closed on"
        value={closedOn}
        onValueChange={setClosedOn}
        max={today}
        today={today}
      />
      <RadioGroup
        label="Outcome"
        options={(['ACHIEVED', 'NOT_ACHIEVED'] as const).map((v) => ({
          value: v,
          label: WORDS.ObjectiveOutcome[v],
        }))}
        value={outcome ?? ''}
        onValueChange={(v) => setOutcome(v as ObjectiveOutcome)}
      />
    </FormDrawer>
  );
}
