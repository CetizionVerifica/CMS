'use client';
// The actions on one ISO subject (model §3.12): a risk item's treatment actions, an objective's plan, an NC's corrective
// actions, and a review's actions, each of which may name the output it carries out. Each action is named by its subject
// (§4.7). Its steps are exactly the API's `allowedActions`; a plain edit follows the contracts' role table, and a new
// owner or a moved due date asks for a reason (model §1.9).
import {
  ControlHierarchy,
  type IsoActionSubjectType,
  type IsoActionView,
  type ReviewOutputKey,
} from '@canopy/contracts';
import { Button, DateInput, formatDate, Select, Textarea } from '@canopy/ui';
import { useState, type ReactNode } from 'react';

import { isoWrite } from '../_lib/actions';
import { nameOf, type PersonOption } from '../_lib/people';
import { word, WORDS } from '../_lib/words';
import { FormDrawer, PersonSelect, StepButton, useSave } from './controls';
import { StatePill, TimingPill } from './IsoStates';

/** "Treatment action", "Objective plan" (model §4.7). */
export function actionName(type: IsoActionSubjectType): string {
  return word('IsoActionSubjectType', type);
}

/** "Treatment actions", "Objective plans". */
export function actionsName(type: IsoActionSubjectType): string {
  return `${actionName(type)}s`;
}

export type ActionEditing = {
  /** Managers may edit every action and name any owner. */
  all: boolean;
  /** An owner edits the actions that name them. */
  personId: string;
};

export type ActionsPanelProps = {
  clientId: string;
  subject: { type: IsoActionSubjectType; id: string };
  /** The subject still takes actions: a risk item not archived, an objective without `closedOn`, and so on. */
  subjectOpen: boolean;
  actions: IsoActionView[];
  people: PersonOption[];
  /** May add an action: managers, and the subject's owner (contracts role table). */
  canAdd: boolean;
  editing: ActionEditing;
  /** A risk item's actions carry the control they put in place; `required` on a hazard. */
  hierarchy?: 'required' | 'optional';
  /** What completing an action does besides closing it, for the confirm step. */
  completeNote?: string;
  /** A review's outputs: its actions may name the output they carry out (`outputKey`). */
  outputs?: { key: ReviewOutputKey; title: string }[];
  today: string;
};

export function ActionsPanel(props: ActionsPanelProps) {
  const { subject, subjectOpen, actions, canAdd } = props;
  const [adding, setAdding] = useState(false);
  const title = actionsName(subject.type);
  const headingId = `actions-${subject.id}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-section text-ink">
          {title}
        </h2>
        {canAdd && subjectOpen ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add {actionName(subject.type).toLowerCase()}
          </Button>
        ) : null}
      </div>
      {actions.length === 0 ? (
        <p className="rounded-card border border-line bg-surface p-4 text-body text-muted">
          No {title.toLowerCase()} yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {actions.map((a) => (
            <ActionItem key={a.id} {...props} action={a} />
          ))}
        </ul>
      )}
      {adding ? <ActionForm {...props} onClose={() => setAdding(false)} /> : null}
    </section>
  );
}

/** One action with its details and the steps on offer. */
export function ActionItem(
  props: Omit<ActionsPanelProps, 'actions' | 'canAdd' | 'subjectOpen'> & {
    action: IsoActionView;
    /** Shown above the text on the actions list: what the action is for. */
    subjectLine?: ReactNode;
  },
) {
  const { clientId, action: a, people, editing, completeNote, subjectLine } = props;
  const [editingOpen, setEditingOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const can = (step: IsoActionView['allowedActions'][number]) => a.allowedActions.includes(step);
  const mayEdit = a.state === 'OPEN' && (editing.all || a.ownerId === editing.personId);
  const label = `${actionName(a.subject.type)}: ${a.text.slice(0, 60).trim()}`;
  return (
    <li
      aria-label={label}
      className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
    >
      {subjectLine}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-line text-body text-ink">{a.text}</p>
        <div className="flex flex-wrap items-center gap-2">
          <StatePill of="IsoActionState" value={a.state} />
          {a.state === 'OPEN' ? <TimingPill status={a.status} /> : null}
        </div>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-meta sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted">Owner</dt>
        <dd>{nameOf(people, a.ownerId)}</dd>
        <dt className="text-muted">Due</dt>
        <dd>{formatDate(a.dueOn)}</dd>
        {a.doneOn ? (
          <>
            <dt className="text-muted">Done</dt>
            <dd>{formatDate(a.doneOn)}</dd>
          </>
        ) : null}
        {a.outputKey ? (
          <>
            <dt className="text-muted">Output</dt>
            <dd>
              {props.outputs?.find((o) => o.key === a.outputKey)?.title ?? 'An earlier output'}
            </dd>
          </>
        ) : null}
        {a.controlHierarchy ? (
          <>
            <dt className="text-muted">Control</dt>
            <dd>{word('ControlHierarchy', a.controlHierarchy)}</dd>
          </>
        ) : null}
        {a.resources ? (
          <>
            <dt className="text-muted">Resources</dt>
            <dd className="whitespace-pre-line">{a.resources}</dd>
          </>
        ) : null}
        {a.effectivenessNote ? (
          <>
            <dt className="text-muted">Effectiveness</dt>
            <dd className="whitespace-pre-line">{a.effectivenessNote}</dd>
          </>
        ) : null}
        {a.cancelReason ? (
          <>
            <dt className="text-muted">Cancelled because</dt>
            <dd className="whitespace-pre-line">{a.cancelReason}</dd>
          </>
        ) : null}
      </dl>
      {can('COMPLETE') || can('CANCEL') || can('REOPEN') || mayEdit ? (
        <div className="flex flex-wrap gap-2">
          {can('COMPLETE') ? (
            <Button size="sm" variant="primary" onClick={() => setCompleting(true)}>
              Mark done
            </Button>
          ) : null}
          {mayEdit ? (
            <Button size="sm" variant="ghost" onClick={() => setEditingOpen(true)}>
              Edit action
            </Button>
          ) : null}
          {can('CANCEL') ? (
            <StepButton
              label="Cancel action"
              title="Cancel this action?"
              body="It stays on the record as cancelled."
              reason={{ label: 'Why it is cancelled' }}
              tone="danger"
              done="The action is cancelled."
              run={(reason) =>
                isoWrite(
                  clientId,
                  'cancelIsoAction',
                  { id: a.id },
                  { version: a.version, reason: reason ?? '' },
                )
              }
            />
          ) : null}
          {can('REOPEN') ? (
            <StepButton
              label="Reopen"
              title="Reopen this action?"
              body="It goes back to open with its owner and due date."
              reason={{ label: 'Why it is reopened' }}
              done="The action is open again."
              run={(reason) =>
                isoWrite(
                  clientId,
                  'reopenIsoAction',
                  { id: a.id },
                  { version: a.version, reason: reason ?? '' },
                )
              }
            />
          ) : null}
        </div>
      ) : null}
      {completing ? (
        <CompleteAction
          clientId={clientId}
          action={a}
          today={props.today}
          note={completeNote}
          onClose={() => setCompleting(false)}
        />
      ) : null}
      {editingOpen ? (
        <ActionForm
          {...props}
          subject={a.subject}
          action={a}
          onClose={() => setEditingOpen(false)}
        />
      ) : null}
    </li>
  );
}

function CompleteAction({
  clientId,
  action,
  today,
  note,
  onClose,
}: {
  clientId: string;
  action: IsoActionView;
  today: string;
  note?: string;
  onClose: () => void;
}) {
  const [doneOn, setDoneOn] = useState<string | null>(today);
  const [effectiveness, setEffectiveness] = useState('');
  const { pending, error, save } = useSave();
  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Mark the action done"
      submitLabel="Mark done"
      pending={pending}
      error={error}
      disabledReason={doneOn ? undefined : 'Give the day it was done'}
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'completeIsoAction',
              { id: action.id },
              {
                version: action.version,
                doneOn: doneOn!,
                ...(effectiveness.trim() ? { effectivenessNote: effectiveness.trim() } : {}),
              },
            ),
          'The action is done.',
        ).then((ok) => ok && onClose())
      }
    >
      <p className="whitespace-pre-line text-body text-ink">{action.text}</p>
      {note ? <p className="text-body text-muted">{note}</p> : null}
      <DateInput
        label="Done on"
        value={doneOn}
        onValueChange={setDoneOn}
        max={today}
        today={today}
      />
      <Textarea
        label="How well it worked (optional)"
        value={effectiveness}
        maxLength={4000}
        onChange={(e) => setEffectiveness(e.target.value)}
      />
    </FormDrawer>
  );
}

/** Adds an action to the subject, or edits an open one. */
export function ActionForm({
  clientId,
  subject,
  people,
  editing,
  hierarchy,
  outputs,
  today,
  action,
  onClose,
}: Pick<
  ActionsPanelProps,
  'clientId' | 'subject' | 'people' | 'editing' | 'hierarchy' | 'outputs' | 'today'
> & { action?: IsoActionView; onClose: () => void }) {
  const [text, setText] = useState(action?.text ?? '');
  const [resources, setResources] = useState(action?.resources ?? '');
  const [ownerId, setOwnerId] = useState<string | null>(
    action?.ownerId ?? (editing.all ? null : editing.personId),
  );
  const [dueOn, setDueOn] = useState<string | null>(action?.dueOn ?? null);
  const [control, setControl] = useState<string | null>(action?.controlHierarchy ?? null);
  const [outputKey, setOutputKey] = useState<ReviewOutputKey | null>(action?.outputKey ?? null);
  const [reason, setReason] = useState('');
  const { pending, error, save } = useSave();
  const name = actionName(subject.type).toLowerCase();

  const values = {
    text: text.trim(),
    resources: resources.trim() || null,
    ownerId,
    dueOn,
    controlHierarchy: hierarchy ? control : null,
    outputKey: outputs ? outputKey : null,
  };
  const body: Record<string, unknown> = action ? { version: action.version } : {};
  if (action) {
    if (values.text !== action.text) body.text = values.text;
    if (values.resources !== action.resources) body.resources = values.resources;
    if (values.ownerId !== action.ownerId) body.ownerId = values.ownerId;
    if (values.dueOn !== action.dueOn) body.dueOn = values.dueOn;
    if (hierarchy && values.controlHierarchy !== action.controlHierarchy) {
      body.controlHierarchy = values.controlHierarchy;
    }
    if (outputs && values.outputKey !== action.outputKey) body.outputKey = values.outputKey;
  }
  const needsReason = action !== undefined && ('ownerId' in body || 'dueOn' in body);
  if (needsReason) body.reason = reason.trim();
  const changed = !action || Object.keys(body).some((k) => k !== 'version' && k !== 'reason');

  const missing = !changed
    ? 'Nothing has changed'
    : values.text === ''
      ? 'Say what is to be done'
      : !values.ownerId
        ? 'Choose who does it'
        : !values.dueOn
          ? 'Give a due date'
          : hierarchy === 'required' && !values.controlHierarchy
            ? 'Choose the kind of control'
            : needsReason && reason.trim() === ''
              ? 'Say why the owner or due date changes'
              : undefined;

  const submit = () =>
    action
      ? isoWrite(clientId, 'updateIsoAction', { id: action.id }, body as never)
      : isoWrite(
          clientId,
          'createIsoAction',
          {},
          {
            subject,
            text: values.text,
            resources: values.resources,
            ownerId: values.ownerId!,
            dueOn: values.dueOn!,
            controlHierarchy: values.controlHierarchy as ControlHierarchy | null,
            ...(outputs ? { outputKey: values.outputKey } : {}),
          },
        );

  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={action ? `Edit ${name}` : `Add ${name}`}
      submitLabel={action ? 'Save action' : `Add ${name}`}
      pending={pending}
      error={error}
      disabledReason={missing}
      onSubmit={() =>
        void save(submit, action ? 'The action is saved.' : 'The action is added.').then(
          (ok) => ok && onClose(),
        )
      }
    >
      <Textarea
        label="What is to be done"
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
      />
      {hierarchy ? (
        <Select
          label="Kind of control"
          helper={
            hierarchy === 'required'
              ? 'Most effective first. When the action is done, the control is in place.'
              : 'Optional. When the action is done, the control is in place.'
          }
          options={[
            ...(hierarchy === 'optional' ? [{ value: '__none__', label: 'Not given' }] : []),
            ...ControlHierarchy.options.map((v) => ({
              value: v,
              label: WORDS.ControlHierarchy[v],
            })),
          ]}
          value={control ?? (hierarchy === 'optional' ? '__none__' : undefined)}
          onValueChange={(v) => setControl(v === '__none__' ? null : v)}
        />
      ) : null}
      {outputs ? (
        <Select
          label="Output it carries out (optional)"
          options={[
            { value: '__none__', label: 'None' },
            ...outputs.map((o) => ({ value: o.key, label: o.title })),
          ]}
          value={outputKey ?? '__none__'}
          onValueChange={(v) => setOutputKey(v === '__none__' ? null : (v as ReviewOutputKey))}
        />
      ) : null}
      <Textarea
        label="Resources (optional)"
        helper="People, money or equipment it needs."
        value={resources}
        maxLength={2000}
        onChange={(e) => setResources(e.target.value)}
      />
      {editing.all ? (
        <PersonSelect label="Owner" people={people} value={ownerId} onChange={setOwnerId} />
      ) : (
        <p className="text-body">
          <span className="text-muted">Owner: </span>
          {ownerId === editing.personId ? 'you' : nameOf(people, ownerId)}
        </p>
      )}
      <DateInput
        label="Due on"
        value={dueOn}
        onValueChange={setDueOn}
        min={action ? undefined : today}
        today={today}
      />
      {needsReason ? (
        <Textarea
          label="Why the owner or due date changes"
          value={reason}
          maxLength={2000}
          onChange={(e) => setReason(e.target.value)}
        />
      ) : null}
    </FormDrawer>
  );
}
