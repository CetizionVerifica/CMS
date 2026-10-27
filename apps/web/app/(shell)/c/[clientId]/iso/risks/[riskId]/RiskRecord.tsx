'use client';
// One risk item (model §3.5): what it is, its kind's own fields, its rating with the controls in place and after the
// planned treatment, its significance (the engine's, or a manager's override with its reason), the controls in place
// and its treatment actions. Completing a treatment action puts its control in place and sets the review to today, so
// the owner re-rates the item.
import {
  ControlHierarchy,
  type IsoActionView,
  type RiskControl,
  type RiskItemView,
} from '@canopy/contracts';
import { Button, DateInput, formatDate, RadioGroup, Select, Textarea } from '@canopy/ui';
import { useState } from 'react';

import { isoWrite } from '../../_lib/actions';
import { nameOf, type PersonOption } from '../../_lib/people';
import { word, WORDS } from '../../_lib/words';
import { ActionsPanel, type ActionEditing } from '../../_components/ActionsPanel';
import { FormDrawer, StepButton, useSave } from '../../_components/controls';
import { IsoPill, TimingPill } from '../../_components/IsoStates';
import { RaiseNc, type NcRaiseProps } from '../../nonconformities/NcRaiseForm';
import { EditRisk } from '../RiskForm';
import { kindDetails, ratingText, secondAxis } from '../risks-model';

export type RiskRecordProps = {
  clientId: string;
  risk: RiskItemView;
  controls: RiskControl[];
  actions: IsoActionView[];
  people: PersonOption[];
  /** The units of the item's system, for editing. */
  units: { id: string; name: string }[];
  unitName: string;
  systemName: string;
  /** Managers, and the item's owner (contracts role table). */
  canEdit: boolean;
  /** Managers name a new owner. */
  canReassign: boolean;
  /** Managers set or clear the significance override. */
  canOverride: boolean;
  canAddAction: boolean;
  actionEditing: ActionEditing;
  today: string;
  /** Raising a nonconformity from this item, for someone who may raise one. */
  raise: NcRaiseProps | null;
};

export function RiskRecord(props: RiskRecordProps) {
  const { clientId, risk, actions, people, canEdit, canOverride, today } = props;
  const [editing, setEditing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [overriding, setOverriding] = useState(false);
  const [raising, setRaising] = useState(false);
  const archived = risk.archivedAt !== null;
  const hazard = risk.kind === 'HAZARD';

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="risk-details"
        className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="risk-details" className="text-card text-ink">
            Details
          </h2>
          {(canEdit || props.raise) && !archived ? (
            <div className="flex flex-wrap gap-2">
              {canEdit ? (
                <>
                  <Button size="sm" variant="primary" onClick={() => setReviewing(true)}>
                    Record review
                  </Button>
                  <Button size="sm" onClick={() => setEditing(true)}>
                    Edit or re-rate
                  </Button>
                </>
              ) : null}
              {props.raise ? (
                <Button size="sm" onClick={() => setRaising(true)}>
                  Raise nonconformity
                </Button>
              ) : null}
              {canEdit ? (
                <StepButton
                  label="Archive"
                  title="Archive this item?"
                  body="It leaves the register. Its open actions can no longer be reopened."
                  reason={{ label: 'Why it is archived' }}
                  tone="danger"
                  done="The item is archived."
                  run={(reason) =>
                    isoWrite(
                      clientId,
                      'archiveIsoRisk',
                      { id: risk.id },
                      { version: risk.version, reason: reason ?? '' },
                    )
                  }
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-body sm:grid-cols-[12rem_1fr]">
          {archived ? (
            <>
              <dt className="text-muted">Status</dt>
              <dd>
                <IsoPill>Archived</IsoPill>
              </dd>
            </>
          ) : null}
          <dt className="text-muted">Kind</dt>
          <dd>{word('RiskKind', risk.kind)}</dd>
          <dt className="text-muted">Management system</dt>
          <dd>{props.systemName}</dd>
          <dt className="text-muted">Unit</dt>
          <dd>{props.unitName}</dd>
          <dt className="text-muted">Activity, product or service</dt>
          <dd>{risk.activity}</dd>
          {kindDetails(risk).map((d) => (
            <KeyValue key={d.label} label={d.label} value={d.value} />
          ))}
          {risk.assessedWith ? <KeyValue label="Assessed with" value={risk.assessedWith} /> : null}
          <dt className="text-muted">Climate related</dt>
          <dd>{risk.climateRelated ? 'Yes' : 'No'}</dd>
          <dt className="text-muted">Legal requirements</dt>
          <dd>
            {risk.obligationIds.length === 0
              ? 'None linked'
              : `${risk.obligationIds.length} linked`}
          </dd>
          <dt className="text-muted">Owner</dt>
          <dd>{nameOf(people, risk.ownerId)}</dd>
          <dt className="text-muted">Review</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {risk.reviewDueOn ? (
              <>
                due {formatDate(risk.reviewDueOn)} <TimingPill status={risk.reviewStatus} />
              </>
            ) : (
              'No date set'
            )}
            {risk.lastReviewedOn ? (
              <span className="text-muted">last reviewed {formatDate(risk.lastReviewedOn)}</span>
            ) : null}
          </dd>
        </dl>
      </section>

      <section
        aria-labelledby="risk-rating"
        className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="risk-rating" className="text-card text-ink">
            Rating and significance
          </h2>
          {canOverride && !archived ? (
            <Button size="sm" onClick={() => setOverriding(true)}>
              {risk.significantOverride === null ? 'Override significance' : 'Change override'}
            </Button>
          ) : null}
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-body sm:grid-cols-[12rem_1fr]">
          <dt className="text-muted">With controls in place</dt>
          <dd>
            {ratingText(risk.rating, risk.likelihood, risk.severity)}
            <span className="text-muted"> likelihood × {secondAxis(risk.kind).toLowerCase()}</span>
          </dd>
          <dt className="text-muted">After treatment</dt>
          <dd>
            {risk.residualRating === null
              ? 'Not rated'
              : ratingText(risk.residualRating, risk.residualLikelihood, risk.residualSeverity)}
          </dd>
          <dt className="text-muted">Significance</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {risk.significant ? (
              <IsoPill tone="warn">Significant</IsoPill>
            ) : (
              <IsoPill>Not significant</IsoPill>
            )}
            <span className="text-muted">
              {risk.significantOverride === null ? 'from its rating' : 'set by override'}
            </span>
          </dd>
          {risk.significanceReason ? (
            <KeyValue label="Why it was overridden" value={risk.significanceReason} />
          ) : null}
        </dl>
      </section>

      <Controls {...props} archived={archived} />

      <ActionsPanel
        clientId={clientId}
        subject={{ type: 'RISK_ITEM', id: risk.id }}
        subjectOpen={!archived}
        actions={actions}
        people={people}
        canAdd={props.canAddAction}
        editing={props.actionEditing}
        hierarchy={hazard ? 'required' : 'optional'}
        completeNote="Its control goes in place on this item, and the item's review is set to today so its owner re-rates it."
        today={today}
      />

      {editing ? <EditRisk {...props} onClose={() => setEditing(false)} /> : null}
      {reviewing ? <ReviewRisk {...props} onClose={() => setReviewing(false)} /> : null}
      {overriding ? <OverrideSignificance {...props} onClose={() => setOverriding(false)} /> : null}
      {raising && props.raise ? (
        <RaiseNc {...props.raise} onClose={() => setRaising(false)} />
      ) : null}
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="whitespace-pre-line">{value || 'Not recorded'}</dd>
    </>
  );
}

function Controls({
  clientId,
  risk,
  controls,
  actions,
  canEdit,
  archived,
}: RiskRecordProps & { archived: boolean }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<RiskControl | null>(null);
  const live = controls.filter((c) => c.archivedAt === null);
  const fromAction = (c: RiskControl) => actions.find((a) => a.id === c.sourceActionId);
  return (
    <section aria-labelledby="risk-controls" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="risk-controls" className="text-section text-ink">
          Controls in place
        </h2>
        {canEdit && !archived ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add control
          </Button>
        ) : null}
      </div>
      {live.length === 0 ? (
        <p className="rounded-card border border-line bg-surface p-4 text-body text-muted">
          No control in place yet. Planned controls are treatment actions below.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
          {live.map((c) => {
            const source = fromAction(c);
            return (
              <li
                key={c.id}
                aria-label={`Control: ${c.text.slice(0, 60).trim()}`}
                className="flex flex-wrap items-start justify-between gap-2 p-3"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="whitespace-pre-line text-body text-ink">{c.text}</p>
                  <p className="text-meta text-muted">
                    {c.hierarchy ? word('ControlHierarchy', c.hierarchy) : 'Kind not given'}
                    {source
                      ? ` · from a treatment action done ${formatDate(source.doneOn ?? source.dueOn)}`
                      : ''}
                  </p>
                </div>
                {canEdit && !archived ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                      Edit control
                    </Button>
                    <StepButton
                      label="Remove"
                      title="Remove this control?"
                      body="It is no longer in place. It stays in the item's history."
                      reason={{ label: 'Why it is no longer in place' }}
                      tone="danger"
                      done="The control is removed."
                      run={(reason) =>
                        isoWrite(
                          clientId,
                          'archiveIsoRiskControl',
                          { id: risk.id, controlId: c.id },
                          { version: c.version, reason: reason ?? '' },
                        )
                      }
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <ControlForm clientId={clientId} risk={risk} onClose={() => setAdding(false)} />
      ) : null}
      {editing ? (
        <ControlForm
          clientId={clientId}
          risk={risk}
          control={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

function ControlForm({
  clientId,
  risk,
  control,
  onClose,
}: {
  clientId: string;
  risk: RiskItemView;
  control?: RiskControl;
  onClose: () => void;
}) {
  const NONE = '__none__';
  const hazard = risk.kind === 'HAZARD';
  const [text, setText] = useState(control?.text ?? '');
  const [hierarchy, setHierarchy] = useState<string | null>(control?.hierarchy ?? null);
  const { pending, error, save } = useSave();
  const value = hierarchy as ControlHierarchy | null;
  const changed = !control || text.trim() !== control.text || value !== control.hierarchy;
  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={control ? 'Edit control' : 'Add control in place'}
      submitLabel={control ? 'Save control' : 'Add control'}
      pending={pending}
      error={error}
      disabledReason={
        !changed
          ? 'Nothing has changed'
          : text.trim() === ''
            ? 'Describe the control'
            : hazard && !value
              ? 'Choose the kind of control'
              : undefined
      }
      onSubmit={() =>
        void save(
          () =>
            control
              ? isoWrite(
                  clientId,
                  'updateIsoRiskControl',
                  { id: risk.id, controlId: control.id },
                  {
                    version: control.version,
                    ...(text.trim() !== control.text ? { text: text.trim() } : {}),
                    ...(value !== control.hierarchy ? { hierarchy: value } : {}),
                  },
                )
              : isoWrite(
                  clientId,
                  'createIsoRiskControl',
                  { id: risk.id },
                  { text: text.trim(), hierarchy: value },
                ),
          control ? 'The control is saved.' : 'The control is added.',
        ).then((ok) => ok && onClose())
      }
    >
      <Textarea
        label="The control"
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
      />
      <Select
        label="Kind of control"
        helper={hazard ? 'Most effective first.' : 'Optional.'}
        options={[
          ...(hazard ? [] : [{ value: NONE, label: 'Not given' }]),
          ...ControlHierarchy.options.map((v) => ({ value: v, label: WORDS.ControlHierarchy[v] })),
        ]}
        value={hierarchy ?? (hazard ? undefined : NONE)}
        onValueChange={(v) => setHierarchy(v === NONE ? null : v)}
      />
    </FormDrawer>
  );
}

function ReviewRisk({ clientId, risk, today, onClose }: RiskRecordProps & { onClose: () => void }) {
  const [next, setNext] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const { pending, error, save } = useSave();
  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Record review"
      submitLabel="Record review"
      pending={pending}
      error={error}
      disabledReason={next ? undefined : 'Give the next review date'}
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'reviewIsoRisk',
              { id: risk.id },
              {
                version: risk.version,
                nextReviewDueOn: next!,
                ...(note.trim() ? { note: note.trim() } : {}),
              },
            ),
          'The review is recorded.',
        ).then((ok) => ok && onClose())
      }
    >
      <p className="text-body text-muted">
        The item stands as rated. To change its scores, edit or re-rate it instead.
      </p>
      <DateInput
        label="Next review"
        value={next}
        onValueChange={setNext}
        min={today}
        today={today}
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

function OverrideSignificance({
  clientId,
  risk,
  onClose,
}: RiskRecordProps & { onClose: () => void }) {
  const current =
    risk.significantOverride === null ? 'none' : risk.significantOverride ? 'yes' : 'no';
  const [choice, setChoice] = useState(current);
  const [reason, setReason] = useState('');
  const { pending, error, save } = useSave();
  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Override significance"
      submitLabel="Save"
      pending={pending}
      error={error}
      disabledReason={
        choice === current ? 'Nothing has changed' : reason.trim() === '' ? 'Say why' : undefined
      }
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'setIsoRiskSignificance',
              { id: risk.id },
              {
                version: risk.version,
                significantOverride: choice === 'none' ? null : choice === 'yes',
                reason: reason.trim(),
              },
            ),
          'The significance is saved.',
        ).then((ok) => ok && onClose())
      }
    >
      <p className="text-body text-muted">
        By its rating of {risk.rating}, the item is significant when the rating reaches the
        account&apos;s threshold or it is linked to a legal requirement. An override wins over both.
      </p>
      <RadioGroup
        label="Significance"
        options={[
          { value: 'none', label: 'From its rating (no override)' },
          { value: 'yes', label: 'Significant' },
          { value: 'no', label: 'Not significant' },
        ]}
        value={choice}
        onValueChange={setChoice}
      />
      <Textarea
        label="Why"
        value={reason}
        maxLength={2000}
        onChange={(e) => setReason(e.target.value)}
      />
    </FormDrawer>
  );
}
