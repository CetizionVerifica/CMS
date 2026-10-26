'use client';
// One controlled document (model §3.4, §4.2): its own fields, the steps on offer, and every revision with its files.
// The steps are exactly the API's `allowedActions` on the document and on each revision. An external document's edition
// shows its issuer, never an internal approver.
import type { DocumentView, RevisionView } from '@canopy/contracts';
import { Button, DateInput, formatDate, Input, Textarea } from '@canopy/ui';
import { useState } from 'react';

import { isoWrite } from '../../_lib/actions';
import { clientDate, nameOf, type PersonOption } from '../../_lib/people';
import { word } from '../../_lib/words';
import type { ClauseOption } from '../../_components/ClausePicker';
import { FilesPanel } from '../../_components/FilesPanel';
import { FormDrawer, StepButton, useSave } from '../../_components/controls';
import { StatePill, TimingPill } from '../../_components/IsoStates';
import { nextRevisionLabel } from '../documents-model';
import { EditDocument } from '../DocumentForm';

export type DocumentRecordProps = {
  clientId: string;
  doc: DocumentView;
  revisions: RevisionView[];
  people: PersonOption[];
  clauseOptions: ClauseOption[];
  systemName: string;
  /** May edit the document's fields: managers, and its owner (contracts role table). */
  canEdit: boolean;
  /** May name a new owner (managers). */
  canReassign: boolean;
  /** May edit a DRAFT revision's label and note: managers, and the document's owner. */
  canEditDraft: boolean;
  today: string;
  timeZone: string;
};

export function DocumentRecord(props: DocumentRecordProps) {
  const { clientId, doc, revisions, people, clauseOptions, systemName, canEdit, today } = props;
  const [editing, setEditing] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const external = doc.type === 'EXTERNAL';
  const clauseNames = doc.clauseIds.map(
    (id) => clauseOptions.find((c) => c.id === id)?.label ?? 'A clause no longer listed',
  );
  const actions = doc.allowedActions;

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="document-details"
        className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="document-details" className="text-card text-ink">
            Details
          </h2>
          <div className="flex flex-wrap gap-2">
            {actions.includes('DRAFT_REVISION') ? (
              <Button size="sm" variant="primary" onClick={() => setDrafting(true)}>
                {external ? 'Record a new edition' : 'Draft a revision'}
              </Button>
            ) : null}
            {actions.includes('REVIEW') ? (
              <Button size="sm" onClick={() => setReviewing(true)}>
                Record review
              </Button>
            ) : null}
            {canEdit && doc.status === 'ACTIVE' ? (
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit document
              </Button>
            ) : null}
            {actions.includes('MAKE_OBSOLETE') ? (
              <StepButton
                label="Make obsolete"
                title={`Make ${doc.code} obsolete?`}
                body="It leaves the active list. Its history stays readable."
                reason={{ label: 'Why it is no longer needed' }}
                tone="danger"
                done="The document is obsolete."
                run={(reason) =>
                  isoWrite(
                    clientId,
                    'obsoleteIsoDocument',
                    { id: doc.id },
                    {
                      version: doc.version,
                      reason: reason ?? '',
                    },
                  )
                }
              />
            ) : null}
          </div>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-body sm:grid-cols-[12rem_1fr]">
          <dt className="text-muted">Status</dt>
          <dd>
            <StatePill of="DocumentStatus" value={doc.status} />
          </dd>
          <dt className="text-muted">Type</dt>
          <dd>{word('DocumentType', doc.type)}</dd>
          <dt className="text-muted">Management system</dt>
          <dd>{systemName}</dd>
          <dt className="text-muted">{external ? 'Edition in force' : 'Revision in force'}</dt>
          <dd>{doc.currentRevision ?? 'None approved yet'}</dd>
          {external ? (
            <>
              <dt className="text-muted">Issuer</dt>
              <dd>{doc.issuer ?? 'Not recorded yet'}</dd>
              <dt className="text-muted">Issuer&apos;s reference</dt>
              <dd>{doc.externalRef ?? 'Not recorded yet'}</dd>
            </>
          ) : null}
          {doc.type === 'FORM' ? (
            <>
              <dt className="text-muted">Retention</dt>
              <dd className="whitespace-pre-line">{doc.retention ?? 'Not recorded yet'}</dd>
            </>
          ) : null}
          <dt className="text-muted">Owner</dt>
          <dd>{nameOf(people, doc.ownerId)}</dd>
          <dt className="text-muted">Approver</dt>
          <dd>{nameOf(people, doc.approverId)}</dd>
          <dt className="text-muted">Review</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {doc.reviewDueOn ? (
              <>
                due {formatDate(doc.reviewDueOn)} <TimingPill status={doc.reviewStatus} />
              </>
            ) : (
              'No date set'
            )}
            {doc.lastReviewedOn ? (
              <span className="text-muted">last reviewed {formatDate(doc.lastReviewedOn)}</span>
            ) : null}
          </dd>
          <dt className="text-muted">Clauses</dt>
          <dd>{clauseNames.length ? clauseNames.join('; ') : 'None named'}</dd>
        </dl>
      </section>

      <section aria-labelledby="revisions" className="flex flex-col gap-3">
        <h2 id="revisions" className="text-section text-ink">
          {external ? 'Editions' : 'Revisions'}
        </h2>
        {revisions.length === 0 ? (
          <p className="rounded-card border border-line bg-surface p-4 text-body text-muted">
            {external
              ? 'No edition recorded yet.'
              : 'No revision yet. The owner drafts the first one and attaches the file.'}
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {revisions.map((rev) => (
              <Revision key={rev.id} {...props} rev={rev} />
            ))}
          </ol>
        )}
      </section>

      {editing ? (
        <EditDocument
          clientId={clientId}
          people={people}
          today={today}
          doc={doc}
          clauseOptions={clauseOptions}
          canReassign={props.canReassign}
          onClose={() => setEditing(false)}
        />
      ) : null}
      {drafting ? <DraftRevision {...props} onClose={() => setDrafting(false)} /> : null}
      {reviewing ? <ReviewDocument {...props} onClose={() => setReviewing(false)} /> : null}
    </div>
  );
}

function Revision({
  clientId,
  doc,
  rev,
  people,
  canEditDraft,
  timeZone,
}: DocumentRecordProps & { rev: RevisionView }) {
  const [editing, setEditing] = useState(false);
  const external = doc.type === 'EXTERNAL';
  const ids = { id: doc.id, revisionId: rev.id };
  const label = external ? `edition ${rev.revision}` : `revision ${rev.revision}`;
  const can = (a: RevisionView['allowedActions'][number]) => rev.allowedActions.includes(a);
  const filesOpen = can('SUBMIT') || can('RECORD_EDITION');
  const approved = rev.state === 'APPROVED' || rev.state === 'SUPERSEDED';

  return (
    <li
      aria-label={`${external ? 'Edition' : 'Revision'} ${rev.revision}`}
      className={`flex flex-col gap-3 rounded-card border border-line bg-surface p-4 ${
        rev.state === 'SUPERSEDED' ? 'opacity-90' : ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-body font-semibold text-ink">
          {external ? 'Edition' : 'Revision'} {rev.revision}
        </h3>
        <StatePill of="RevisionState" value={rev.state} />
        {rev.id === doc.currentRevisionId ? (
          <span className="text-meta text-muted">In force</span>
        ) : null}
      </div>
      <p className="whitespace-pre-line text-body text-ink">
        {rev.changeNote ?? <span className="text-muted">No change note yet.</span>}
      </p>
      <p className="text-meta text-muted">
        Prepared by {nameOf(people, rev.preparedById)}
        {approved && rev.approvedAt
          ? external
            ? `. Recorded ${formatDate(clientDate(rev.approvedAt, timeZone))}, issued by ${doc.issuer ?? 'the issuer'}`
            : `. Approved by ${nameOf(people, rev.approvedById)} on ${formatDate(clientDate(rev.approvedAt, timeZone))}`
          : ''}
        .
      </p>
      {rev.sendBackReason && rev.state === 'DRAFT' ? (
        <p className="rounded-control bg-warn-soft p-2 text-body text-warn-ink">
          Sent back: {rev.sendBackReason}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {rev.state === 'DRAFT' && canEditDraft ? (
          <Button size="sm" onClick={() => setEditing(true)}>
            Edit {external ? 'edition' : 'revision'}
          </Button>
        ) : null}
        {can('SUBMIT') ? (
          <StepButton
            label="Submit for approval"
            title={`Submit ${label} for approval?`}
            body="It needs a change note and one file that has passed the virus check. The approver is told."
            variant="primary"
            done="Submitted for approval."
            run={() => isoWrite(clientId, 'submitIsoRevision', ids, { version: rev.version })}
          />
        ) : null}
        {can('RECORD_EDITION') ? (
          <StepButton
            label="Record edition"
            title={`Record ${label} as in force?`}
            body="It needs the issuer, the issuer's reference and one file that has passed the virus check."
            variant="primary"
            done="The edition is recorded."
            run={() => isoWrite(clientId, 'recordIsoEdition', ids, { version: rev.version })}
          />
        ) : null}
        {can('APPROVE') ? (
          <StepButton
            label="Approve"
            title={`Approve ${label}?`}
            body="It comes into force and the revision before it is superseded."
            reason={{ label: 'Comment', optional: true }}
            variant="primary"
            done="Approved. It is now in force."
            run={(comment) =>
              isoWrite(clientId, 'approveIsoRevision', ids, {
                version: rev.version,
                ...(comment ? { comment } : {}),
              })
            }
          />
        ) : null}
        {can('SEND_BACK') ? (
          <StepButton
            label="Send back"
            title={`Send ${label} back?`}
            body="It returns to the owner as a draft."
            reason={{ label: 'What needs to change' }}
            done="Sent back to the owner."
            run={(reason) =>
              isoWrite(clientId, 'sendBackIsoRevision', ids, {
                version: rev.version,
                reason: reason ?? '',
              })
            }
          />
        ) : null}
      </div>
      <FilesPanel
        clientId={clientId}
        subject={{ type: 'document_revision', id: rev.id }}
        editable={filesOpen}
        heading={`Files of ${label}`}
        timeZone={timeZone}
        helper={filesOpen ? 'Attach exactly one file before submitting.' : undefined}
      />
      {editing ? (
        <EditRevision
          clientId={clientId}
          ids={ids}
          rev={rev}
          external={external}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </li>
  );
}

function DraftRevision({ clientId, doc, onClose }: DocumentRecordProps & { onClose: () => void }) {
  const external = doc.type === 'EXTERNAL';
  const [revision, setRevision] = useState(nextRevisionLabel(doc.currentRevision));
  const [note, setNote] = useState('');
  const { pending, error, save } = useSave();
  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={external ? 'Record a new edition' : 'Draft a revision'}
      submitLabel={external ? 'Start edition' : 'Start revision'}
      pending={pending}
      error={error}
      disabledReason={revision.trim() === '' ? 'Give it a label' : undefined}
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'draftIsoRevision',
              { id: doc.id },
              {
                revision: revision.trim(),
                changeNote: note.trim() || null,
              },
            ),
          external
            ? 'Edition started. Attach its file, then record it.'
            : 'Revision drafted. Attach its file, then submit it.',
        ).then((ok) => ok && onClose())
      }
    >
      <Input
        label={external ? 'Edition' : 'Revision'}
        helper={
          external ? "The issuer's edition, e.g. 2024." : 'The client’s own label, e.g. B or 2.0.'
        }
        value={revision}
        maxLength={20}
        onChange={(e) => setRevision(e.target.value)}
      />
      <Textarea
        label="Change note"
        helper="What changed and why. Needed before it is submitted."
        value={note}
        maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
      />
    </FormDrawer>
  );
}

function EditRevision({
  clientId,
  ids,
  rev,
  external,
  onClose,
}: {
  clientId: string;
  ids: { id: string; revisionId: string };
  rev: RevisionView;
  external: boolean;
  onClose: () => void;
}) {
  const [revision, setRevision] = useState(rev.revision);
  const [note, setNote] = useState(rev.changeNote ?? '');
  const { pending, error, save } = useSave();
  const body: Record<string, unknown> = { version: rev.version };
  if (revision.trim() !== rev.revision) body.revision = revision.trim();
  if ((note.trim() || null) !== rev.changeNote) body.changeNote = note.trim() || null;
  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={external ? 'Edit edition' : 'Edit revision'}
      submitLabel="Save"
      pending={pending}
      error={error}
      disabledReason={
        Object.keys(body).length === 1
          ? 'Nothing has changed'
          : revision.trim() === ''
            ? 'Give it a label'
            : undefined
      }
      onSubmit={() =>
        void save(() => isoWrite(clientId, 'updateIsoRevision', ids, body as never), 'Saved.').then(
          (ok) => ok && onClose(),
        )
      }
    >
      <Input
        label={external ? 'Edition' : 'Revision'}
        value={revision}
        maxLength={20}
        onChange={(e) => setRevision(e.target.value)}
      />
      <Textarea
        label="Change note"
        value={note}
        maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
      />
    </FormDrawer>
  );
}

function ReviewDocument({
  clientId,
  doc,
  today,
  onClose,
}: DocumentRecordProps & { onClose: () => void }) {
  const [note, setNote] = useState('');
  const [next, setNext] = useState<string | null>(null);
  const { pending, error, save } = useSave();
  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Record review"
      submitLabel="Record review"
      pending={pending}
      error={error}
      disabledReason={
        note.trim() === ''
          ? 'Say what the review found'
          : !next
            ? 'Set the next review date'
            : undefined
      }
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'reviewIsoDocument',
              { id: doc.id },
              {
                version: doc.version,
                note: note.trim(),
                nextReviewDueOn: next!,
              },
            ),
          'Review recorded.',
        ).then((ok) => ok && onClose())
      }
    >
      <p className="text-body text-muted">
        Confirms that revision {doc.currentRevision ?? ''} still fits, without changing it.
      </p>
      <Textarea
        label="Review note"
        value={note}
        maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
      />
      <DateInput
        label="Next review due"
        value={next}
        onValueChange={setNext}
        min={today}
        today={today}
      />
    </FormDrawer>
  );
}
