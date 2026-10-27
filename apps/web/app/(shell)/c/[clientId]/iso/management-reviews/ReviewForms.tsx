'use client';
// The forms of a management review (model §3.13, §4.5): planning one, replanning it while PLANNED (a new date or chair
// needs a reason), its attendees and minutes, recording it as held, and the notes and decisions on its rows.
import type {
  IsoStandardCode,
  ManagementReviewView,
  ReviewInputView,
  ReviewOutputView,
} from '@canopy/contracts';
import { Checkbox, DateInput, formatDate, Select, Textarea } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { isoWrite } from '../_lib/actions';
import type { PersonOption } from '../_lib/people';
import { ClausePicker } from '../_components/ClausePicker';
import { FormDrawer, PersonSelect, useSave } from '../_components/controls';

export type ReviewPlanProps = {
  clientId: string;
  /** Each system with its standards, by code and name. */
  systems: { id: string; name: string; standards: { code: IsoStandardCode; title: string }[] }[];
  people: PersonOption[];
  today: string;
};

const peoplePicker = (people: readonly PersonOption[]) => ({
  options: people.map((p) => ({ id: p.id, label: p.name })),
  placeholder: 'Type a name',
  emptyText: 'No one matches',
  unknown: 'Someone not listed',
});

/** The standards as ticked boxes, in the system's order. */
function StandardBoxes({
  standards,
  value,
  onChange,
}: {
  standards: { code: IsoStandardCode; title: string }[];
  value: IsoStandardCode[];
  onChange: (codes: IsoStandardCode[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-meta text-ink">Standards it reviews</legend>
      {standards.map((s) => (
        <Checkbox
          key={s.code}
          label={s.title}
          checked={value.includes(s.code)}
          onCheckedChange={(c) =>
            onChange(
              standards
                .map((x) => x.code)
                .filter((code) => (code === s.code ? c === true : value.includes(code))),
            )
          }
        />
      ))}
    </fieldset>
  );
}

/** PLAN: a review of some or all of a system's standards; its input and output rows come with it. */
export function PlanReview({
  clientId,
  systems,
  people,
  today,
  onClose,
}: ReviewPlanProps & { onClose: () => void }) {
  const router = useRouter();
  const [systemId, setSystemId] = useState(systems[0]?.id ?? '');
  const system = systems.find((s) => s.id === systemId);
  const [standards, setStandards] = useState<IsoStandardCode[]>(
    system?.standards.map((s) => s.code) ?? [],
  );
  const [plannedOn, setPlannedOn] = useState<string | null>(null);
  const [chairId, setChairId] = useState<string | null>(null);
  const [attendeeIds, setAttendeeIds] = useState<string[]>([]);
  const { pending, error, save } = useSave();
  const planned = useRef<string | null>(null);
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Plan a management review"
      submitLabel="Plan review"
      pending={pending}
      error={error}
      disabledReason={
        standards.length === 0
          ? 'Tick the standards it reviews'
          : !plannedOn
            ? 'Give the day it is planned for'
            : !chairId
              ? 'Choose who chairs it'
              : undefined
      }
      onSubmit={() =>
        void save(async () => {
          const result = await isoWrite(
            clientId,
            'planIsoManagementReview',
            {},
            {
              managementSystemId: systemId,
              standards,
              plannedOn: plannedOn!,
              chairId: chairId!,
              attendeeIds,
            },
          );
          if (result.ok) planned.current = result.data.id;
          return result;
        }, 'The review is planned.').then((ok) => {
          if (!ok) return;
          onClose();
          if (planned.current)
            router.push(`/c/${clientId}/iso/management-reviews/${planned.current}`);
        })
      }
    >
      {systems.length > 1 ? (
        <Select
          label="Management system"
          options={systems.map((s) => ({ value: s.id, label: s.name }))}
          value={systemId}
          onValueChange={(v) => {
            setSystemId(v);
            setStandards(systems.find((s) => s.id === v)?.standards.map((s) => s.code) ?? []);
          }}
        />
      ) : null}
      <StandardBoxes
        standards={system?.standards ?? []}
        value={standards}
        onChange={setStandards}
      />
      <DateInput label="Planned for" value={plannedOn} onValueChange={setPlannedOn} today={today} />
      <PersonSelect label="Chair" people={people} value={chairId} onChange={setChairId} />
      <ClausePicker
        label="Attendees (optional until it is held)"
        value={attendeeIds}
        onChange={setAttendeeIds}
        max={100}
        {...peoplePicker(people)}
      />
    </FormDrawer>
  );
}

/** The replan route's body: the version and what changed, with the reason when the date or the chair moves. */
export function replanBody(
  review: Pick<ManagementReviewView, 'version' | 'standards' | 'plannedOn' | 'chairId'>,
  f: {
    standards: IsoStandardCode[];
    plannedOn: string | null;
    chairId: string | null;
    reason: string;
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = { version: review.version };
  if (f.standards.join() !== review.standards.join()) body.standards = f.standards;
  if (f.plannedOn && f.plannedOn !== review.plannedOn) body.plannedOn = f.plannedOn;
  if (f.chairId && f.chairId !== review.chairId) body.chairId = f.chairId;
  if ('plannedOn' in body || 'chairId' in body) body.reason = f.reason.trim();
  return body;
}

/** Replan (account admins, consultants, client admins) while PLANNED: standards, date and chair. */
export function ReplanReview({
  clientId,
  review,
  standards: options,
  people,
  today,
  onClose,
}: {
  clientId: string;
  review: ManagementReviewView;
  standards: { code: IsoStandardCode; title: string }[];
  people: PersonOption[];
  today: string;
  onClose: () => void;
}) {
  const [standards, setStandards] = useState<IsoStandardCode[]>(review.standards);
  const [plannedOn, setPlannedOn] = useState<string | null>(review.plannedOn);
  const [chairId, setChairId] = useState<string | null>(review.chairId);
  const [reason, setReason] = useState('');
  const { pending, error, save } = useSave();
  const body = replanBody(review, { standards, plannedOn, chairId, reason });
  const moves = 'reason' in body;
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Replan review"
      submitLabel="Save plan"
      pending={pending}
      error={error}
      disabledReason={
        standards.length === 0
          ? 'Tick the standards it reviews'
          : Object.keys(body).every((k) => k === 'version' || k === 'reason')
            ? 'Nothing has changed'
            : moves && reason.trim() === ''
              ? 'Say why the date or the chair changes'
              : undefined
      }
      onSubmit={() =>
        void save(
          () => isoWrite(clientId, 'replanIsoManagementReview', { id: review.id }, body as never),
          'The review is replanned.',
        ).then((ok) => ok && onClose())
      }
    >
      <StandardBoxes standards={options} value={standards} onChange={setStandards} />
      <p className="text-meta text-muted">
        A standard taken off drops its inputs and outputs from the review; their notes are kept on
        the record.
      </p>
      <DateInput label="Planned for" value={plannedOn} onValueChange={setPlannedOn} today={today} />
      <PersonSelect label="Chair" people={people} value={chairId} onChange={setChairId} />
      {moves ? (
        <Textarea
          label="Why the date or the chair changes"
          value={reason}
          maxLength={2000}
          onChange={(e) => setReason(e.target.value)}
        />
      ) : null}
    </FormDrawer>
  );
}

/** Attendees and minutes, until the review is CLOSED or CANCELLED. */
export function MeetingForm({
  clientId,
  review,
  people,
  onClose,
}: {
  clientId: string;
  review: ManagementReviewView;
  people: PersonOption[];
  onClose: () => void;
}) {
  const [attendeeIds, setAttendeeIds] = useState(review.attendeeIds);
  const [minutes, setMinutes] = useState(review.minutes ?? '');
  const { pending, error, save } = useSave();
  const body: Record<string, unknown> = { version: review.version };
  if (attendeeIds.join() !== review.attendeeIds.join()) body.attendeeIds = attendeeIds;
  if ((minutes.trim() || null) !== review.minutes) body.minutes = minutes.trim() || null;
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Attendees and minutes"
      submitLabel="Save"
      pending={pending}
      error={error}
      disabledReason={Object.keys(body).length === 1 ? 'Nothing has changed' : undefined}
      onSubmit={() =>
        void save(
          () => isoWrite(clientId, 'updateIsoManagementReview', { id: review.id }, body as never),
          'The review is saved.',
        ).then((ok) => ok && onClose())
      }
    >
      <ClausePicker
        label="Attendees"
        value={attendeeIds}
        onChange={setAttendeeIds}
        max={100}
        {...peoplePicker(people)}
      />
      <MinutesField value={minutes} onChange={setMinutes} />
    </FormDrawer>
  );
}

const MINUTES_NOTE =
  'Everyone who can open the review reads its minutes. Keep incident details in the notes of the incidents input, which are kept from readers who may not open those incidents.';

function MinutesField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Textarea
      label="Minutes"
      helper={MINUTES_NOTE}
      value={value}
      maxLength={20000}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * RECORD_HELD: the day it was held (not after today), who attended and the minutes. Every input needs notes first.
 * The figures are stored as they count on that day, and never change after (model §3.13).
 */
export function HeldForm({
  clientId,
  review,
  inputs,
  people,
  laterHeld,
  today,
  onClose,
}: {
  clientId: string;
  review: ManagementReviewView;
  inputs: ReviewInputView[];
  people: PersonOption[];
  /** For a held day, the days later reviews of the same standards were held. */
  laterHeld: (heldOn: string) => string[];
  today: string;
  onClose: () => void;
}) {
  const [heldOn, setHeldOn] = useState<string | null>(today);
  const [attendeeIds, setAttendeeIds] = useState(review.attendeeIds);
  const [minutes, setMinutes] = useState(review.minutes ?? '');
  const { pending, error, save } = useSave();
  // A withheld row hides its notes from this reader, so only the API can say whether it has them.
  const missing = inputs.filter((i) => i.notes === null && !i.figuresWithheld);
  const later = heldOn ? laterHeld(heldOn) : [];
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record review as held"
      submitLabel="Record as held"
      pending={pending}
      error={error}
      disabledReason={
        missing.length > 0
          ? 'Add notes to every input first'
          : !heldOn
            ? 'Give the day it was held'
            : attendeeIds.length === 0
              ? 'Name who attended'
              : undefined
      }
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'recordIsoManagementReviewHeld',
              { id: review.id },
              {
                version: review.version,
                heldOn: heldOn!,
                attendeeIds,
                ...(minutes.trim() ? { minutes: minutes.trim() } : {}),
              },
            ),
          'The review is recorded as held.',
        ).then((ok) => ok && onClose())
      }
    >
      {missing.length > 0 ? (
        <p className="rounded-card bg-warn-soft p-3 text-body text-warn-ink">
          No notes yet on: {missing.map((i) => i.title).join('; ')}.
        </p>
      ) : null}
      <p className="text-body text-muted">
        The figures of each input are stored as they count on the day it was held, and never change
        after.
      </p>
      <DateInput
        label="Held on"
        value={heldOn}
        onValueChange={setHeldOn}
        max={today}
        today={today}
      />
      {heldOn && heldOn < today ? (
        <p className="rounded-card bg-warn-soft p-3 text-body text-warn-ink">
          The stored figures count the records up to {formatDate(heldOn)}, but read whether a record
          is cancelled, its severity, significance, outcome, finding type and activity workflow as
          they are today. So they can differ from the live figures shown here.
        </p>
      ) : null}
      {later.length > 0 ? (
        <p className="rounded-card bg-warn-soft p-3 text-body text-warn-ink">
          A review of the same standards is already recorded as held on{' '}
          {later.map(formatDate).join(', ')}. Its figures stay as they are.
        </p>
      ) : null}
      <ClausePicker
        label="Attendees"
        value={attendeeIds}
        onChange={setAttendeeIds}
        max={100}
        {...peoplePicker(people)}
      />
      <MinutesField value={minutes} onChange={setMinutes} />
    </FormDrawer>
  );
}

/** Notes on one input, until the review is CLOSED or CANCELLED; a held review keeps notes on every input. */
export function InputNotes({
  clientId,
  review,
  input,
  onClose,
}: {
  clientId: string;
  review: ManagementReviewView;
  input: ReviewInputView;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState(input.notes ?? '');
  const { pending, error, save } = useSave();
  const value = notes.trim() || null;
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Notes: ${input.title}`}
      submitLabel="Save notes"
      pending={pending}
      error={error}
      disabledReason={
        value === input.notes
          ? 'Nothing has changed'
          : value === null && review.state === 'HELD'
            ? 'A held review keeps notes on every input'
            : undefined
      }
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'updateIsoReviewInput',
              { id: review.id, inputId: input.id },
              { version: input.version, notes: value },
            ),
          'The notes are saved.',
        ).then((ok) => ok && onClose())
      }
    >
      <Textarea
        label="Notes"
        helper={
          input.source === 'INCIDENTS'
            ? 'What the review said about the incidents. Kept from readers who may not open them.'
            : input.source === 'MANUAL'
              ? 'This input has no records in the app: write what the review considered.'
              : 'What the review made of these figures, and anything they miss.'
        }
        value={notes}
        maxLength={8000}
        onChange={(e) => setNotes(e.target.value)}
      />
    </FormDrawer>
  );
}

/** The decision on one output, until the review is CLOSED or CANCELLED. */
export function OutputDecision({
  clientId,
  review,
  output,
  onClose,
}: {
  clientId: string;
  review: ManagementReviewView;
  output: ReviewOutputView;
  onClose: () => void;
}) {
  const [decision, setDecision] = useState(output.decision ?? '');
  const { pending, error, save } = useSave();
  const value = decision.trim() || null;
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Decision: ${output.title}`}
      submitLabel="Save decision"
      pending={pending}
      error={error}
      disabledReason={value === output.decision ? 'Nothing has changed' : undefined}
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'updateIsoReviewOutput',
              { id: review.id, outputId: output.id },
              { version: output.version, decision: value },
            ),
          'The decision is saved.',
        ).then((ok) => ok && onClose())
      }
    >
      <Textarea
        label="Decision"
        helper="Work it needs goes in a review action that names this output."
        value={decision}
        maxLength={8000}
        onChange={(e) => setDecision(e.target.value)}
      />
    </FormDrawer>
  );
}
