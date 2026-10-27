'use client';
// One management review's page (model §3.13, §4.5): where it stands, with exactly the steps its `allowedActions` lists
// and the downloads beside its pack; the meeting; each input with its figures and notes; each output with its decision;
// the review actions; and its files. A figure's value is always the API's; the words say when the reader may open only
// some of the records behind it, and an incidents row the reader may not see says it is withheld (§3.13 item 4).
import type {
  InternalAuditView,
  IsoActionView,
  IsoStandard,
  IsoStandardCode,
  ManagementReviewView,
  ReviewInputView,
  ReviewOutputView,
} from '@canopy/contracts';
import { Button, formatDate, Select } from '@canopy/ui';
import { useState } from 'react';

import { clientDate, namesOf, nameOf, type PersonOption } from '../../_lib/people';
import { isoWrite } from '../../_lib/actions';
import { ActionsPanel, type ActionEditing } from '../../_components/ActionsPanel';
import { StepButton } from '../../_components/controls';
import { ExportButton } from '../../_components/ExportButton';
import { FilesPanel } from '../../_components/FilesPanel';
import { StatePill } from '../../_components/IsoStates';
import { clauseRefWords, figureLine, laterHeldReviews } from '../review-model';
import { HeldForm, InputNotes, MeetingForm, OutputDecision, ReplanReview } from '../ReviewForms';

export type ReviewRecordProps = {
  clientId: string;
  review: ManagementReviewView;
  inputs: ReviewInputView[];
  outputs: ReviewOutputView[];
  actions: IsoActionView[];
  people: PersonOption[];
  standards: IsoStandard[];
  /** The system's standards, for a replan. */
  systemStandards: { code: IsoStandardCode; title: string }[];
  /** The system's other reviews, for the note on a review held after this one's day. */
  otherReviews: ManagementReviewView[];
  /** The system's reported or closed internal audits, newest first, for their report downloads. */
  audits: Pick<InternalAuditView, 'id' | 'title' | 'reportedOn'>[];
  /** Account admins, consultants and client admins replan while PLANNED. */
  canReplan: boolean;
  /** The chair (and FA, CO, CA) keep its meeting, notes and decisions. */
  canWrite: boolean;
  canAddAction: boolean;
  actionEditing: ActionEditing;
  today: string;
  timeZone: string;
};

const FINAL: readonly ManagementReviewView['state'][] = ['CLOSED', 'CANCELLED'];

/** What an input's figures are, in one line (packages.md ISO-6c). */
export function figuresHeading(
  input: ReviewInputView,
  review: Pick<ManagementReviewView, 'state' | 'heldOn'>,
  timeZone: string,
): string {
  if (input.figuresWithheld)
    return 'Figures and notes withheld: they count incidents you may not open';
  if (input.source === 'MANUAL') return 'Written by hand: no records in the app';
  if (review.state === 'CANCELLED') return 'Not held';
  if (review.state === 'PLANNED') return 'Live, to today';
  if (!input.sourceFigures || !input.figuresStoredAt) {
    return 'No figures: held before the system was set up in the app';
  }
  return `Recorded ${formatDate(clientDate(input.figuresStoredAt, timeZone))}, for ${formatDate(
    input.sourceFigures.since,
  )} to ${formatDate(review.heldOn ?? input.sourceFigures.asOf)}`;
}

export function ReviewRecord(props: ReviewRecordProps) {
  const { clientId, review, inputs, outputs, people, standards, canWrite, timeZone, today } = props;
  const [replanning, setReplanning] = useState(false);
  const [meeting, setMeeting] = useState(false);
  const [holding, setHolding] = useState(false);
  const [notes, setNotes] = useState<ReviewInputView | null>(null);
  const [deciding, setDeciding] = useState<ReviewOutputView | null>(null);
  const can = (step: ManagementReviewView['allowedActions'][number]) =>
    review.allowedActions.includes(step);
  const open = !FINAL.includes(review.state);
  const undecided = outputs.filter((o) => o.decision === null).length;
  const openActions = props.actions.filter((a) => a.state === 'OPEN').length;

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="review-status"
        className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="review-status" className="text-card text-ink">
            Where it stands
          </h2>
          <div className="flex flex-wrap gap-2">
            {can('RECORD_HELD') ? (
              <Button size="sm" variant="primary" onClick={() => setHolding(true)}>
                Record as held
              </Button>
            ) : null}
            {can('CLOSE') ? (
              <StepButton
                label="Close review"
                variant="primary"
                title="Close this review?"
                body={
                  undecided > 0 || openActions > 0
                    ? `Every output needs a decision and every review action done or cancelled first: ${undecided} without a decision, ${openActions} still open.`
                    : 'Its notes and decisions are then final.'
                }
                done="The review is closed."
                run={() =>
                  isoWrite(
                    clientId,
                    'closeIsoManagementReview',
                    { id: review.id },
                    { version: review.version },
                  )
                }
              />
            ) : null}
            {props.canReplan && review.state === 'PLANNED' ? (
              <Button size="sm" variant="secondary" onClick={() => setReplanning(true)}>
                Replan
              </Button>
            ) : null}
            {can('CANCEL') ? (
              <StepButton
                label="Cancel review"
                title="Cancel this review?"
                body="It stays on the record as not held."
                reason={{ label: 'Why it is cancelled' }}
                tone="danger"
                done="The review is cancelled."
                run={(reason) =>
                  isoWrite(
                    clientId,
                    'cancelIsoManagementReview',
                    { id: review.id },
                    { version: review.version, reason: reason ?? '' },
                  )
                }
              />
            ) : null}
          </div>
        </div>
        <p className="flex flex-wrap items-center gap-2 text-body">
          <StatePill of="ManagementReviewState" value={review.state} />
          <span>planned for {formatDate(review.plannedOn)}</span>
          {review.heldOn ? <span>· held {formatDate(review.heldOn)}</span> : null}
        </p>
        {review.cancelReason ? (
          <p className="whitespace-pre-line text-body text-ink">Cancelled: {review.cancelReason}</p>
        ) : null}
        <Downloads {...props} />
      </section>

      <section
        aria-labelledby="review-meeting"
        className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="review-meeting" className="text-card text-ink">
            The meeting
          </h2>
          {canWrite && open ? (
            <Button size="sm" variant="secondary" onClick={() => setMeeting(true)}>
              Edit attendees and minutes
            </Button>
          ) : null}
        </div>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-body sm:grid-cols-[9rem_1fr]">
          <dt className="text-muted">Chair</dt>
          <dd>{nameOf(people, review.chairId)}</dd>
          <dt className="text-muted">Attendees</dt>
          <dd>
            {review.attendeeIds.length ? namesOf(people, review.attendeeIds) : 'None named yet'}
          </dd>
          <dt className="text-muted">Minutes</dt>
          <dd className="whitespace-pre-line">{review.minutes ?? 'None yet'}</dd>
        </dl>
      </section>

      <section aria-labelledby="review-inputs" className="flex flex-col gap-3">
        <h2 id="review-inputs" className="text-section text-ink">
          Inputs
        </h2>
        <ul className="flex flex-col gap-3">
          {inputs.map((input) => (
            <InputItem
              key={input.id}
              input={input}
              review={review}
              standards={standards}
              timeZone={timeZone}
              onNotes={canWrite && open && !input.figuresWithheld ? () => setNotes(input) : null}
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby="review-outputs" className="flex flex-col gap-3">
        <h2 id="review-outputs" className="text-section text-ink">
          Outputs
        </h2>
        <ul className="flex flex-col gap-3">
          {outputs.map((output) => (
            <li
              key={output.id}
              aria-label={`Output: ${output.title}`}
              className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <h3 className="text-body font-semibold text-ink">{output.title}</h3>
                  <p className="text-meta text-muted">
                    {clauseRefWords(standards, output.clauseRefs)}
                  </p>
                </div>
                {canWrite && open ? (
                  <Button size="sm" variant="secondary" onClick={() => setDeciding(output)}>
                    {output.decision ? 'Edit decision' : 'Record decision'}
                  </Button>
                ) : null}
              </div>
              <p className="whitespace-pre-line text-body text-ink">
                {output.decision ?? <span className="text-muted">No decision yet.</span>}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <ActionsPanel
        clientId={clientId}
        subject={{ type: 'MANAGEMENT_REVIEW', id: review.id }}
        subjectOpen={open}
        actions={props.actions}
        people={people}
        canAdd={props.canAddAction}
        editing={props.actionEditing}
        outputs={outputs.map((o) => ({ key: o.key, title: o.title }))}
        today={today}
      />

      <FilesPanel
        clientId={clientId}
        subject={{ type: 'management_review', id: review.id }}
        editable={canWrite && open}
        helper="The agenda, presentations and signed minutes."
        timeZone={timeZone}
      />

      {replanning ? (
        <ReplanReview
          clientId={clientId}
          review={review}
          standards={props.systemStandards}
          people={people}
          today={today}
          onClose={() => setReplanning(false)}
        />
      ) : null}
      {meeting ? (
        <MeetingForm
          clientId={clientId}
          review={review}
          people={people}
          onClose={() => setMeeting(false)}
        />
      ) : null}
      {holding ? (
        <HeldForm
          clientId={clientId}
          review={review}
          inputs={inputs}
          people={people}
          laterHeld={(heldOn) => laterHeldReviews(review, props.otherReviews, heldOn)}
          today={today}
          onClose={() => setHolding(false)}
        />
      ) : null}
      {notes ? (
        <InputNotes
          clientId={clientId}
          review={review}
          input={notes}
          onClose={() => setNotes(null)}
        />
      ) : null}
      {deciding ? (
        <OutputDecision
          clientId={clientId}
          review={review}
          output={deciding}
          onClose={() => setDeciding(null)}
        />
      ) : null}
    </div>
  );
}

function InputItem({
  input,
  review,
  standards,
  timeZone,
  onNotes,
}: {
  input: ReviewInputView;
  review: ManagementReviewView;
  standards: IsoStandard[];
  timeZone: string;
  onNotes: (() => void) | null;
}) {
  const figures = input.sourceFigures
    ? input.sourceFigures.figures.map((f) => figureLine(input.source, f))
    : [];
  return (
    <li
      aria-label={`Input: ${input.title}`}
      className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-body font-semibold text-ink">{input.title}</h3>
          <p className="text-meta text-muted">{clauseRefWords(standards, input.clauseRefs)}</p>
        </div>
        {onNotes ? (
          <Button size="sm" variant="secondary" onClick={onNotes}>
            {input.notes ? 'Edit notes' : 'Add notes'}
          </Button>
        ) : null}
      </div>
      <p
        className={
          input.figuresWithheld
            ? 'rounded-card bg-warn-soft p-3 text-body text-warn-ink'
            : 'text-meta text-muted'
        }
      >
        {figuresHeading(input, review, timeZone)}
      </p>
      {figures.length > 0 ? (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-body sm:grid-cols-[18rem_auto]">
          {figures.map((f) => (
            <div key={f.key} className="contents">
              <dt className={f.zero ? 'text-muted' : 'text-ink'}>{f.label}</dt>
              <dd className={f.zero ? 'text-muted' : 'text-ink'}>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {input.figuresWithheld ? null : (
        <p className="whitespace-pre-line text-body text-ink">
          {input.notes ?? <span className="text-muted">No notes yet.</span>}
        </p>
      )}
    </li>
  );
}

/** The review pack, and the NC log and an audit report beside it (packages.md ISO-6c), through the exports API. */
function Downloads({ clientId, review, audits }: ReviewRecordProps) {
  const [auditId, setAuditId] = useState(audits[0]?.id ?? null);
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      <h3 className="text-body font-semibold text-ink">Downloads</h3>
      <ExportButton
        clientId={clientId}
        kind="ISO_REVIEW_PACK_PDF"
        filters={new URLSearchParams({ managementReviewId: review.id }).toString()}
        label="Download review pack (PDF)"
      />
      <ExportButton
        clientId={clientId}
        kind="ISO_NC_LOG_XLSX"
        filters={new URLSearchParams({ managementSystemId: review.managementSystemId }).toString()}
        label="Download NC log (Excel)"
        note="Every nonconformity of the system."
      />
      {audits.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 sm:w-80">
            <Select
              label="Internal audit"
              options={audits.map((a) => ({
                value: a.id,
                label: a.reportedOn ? `${a.title}, reported ${formatDate(a.reportedOn)}` : a.title,
              }))}
              value={auditId ?? undefined}
              onValueChange={setAuditId}
            />
          </div>
          {auditId ? (
            <ExportButton
              clientId={clientId}
              kind="ISO_AUDIT_REPORT_PDF"
              filters={new URLSearchParams({ internalAuditId: auditId }).toString()}
              label="Download audit report (PDF)"
            />
          ) : null}
        </div>
      ) : (
        <p className="text-meta text-muted">No internal audit of the system is reported yet.</p>
      )}
    </div>
  );
}
