'use client';
// The steps of a nonconformity that take a form (model §4.1): its owner records the root cause, plans the corrective
// action or closes a minor case without one, and submits it; its approver verifies whether the action worked; a client
// admin reopens a closed one. Each is offered only when the view's `allowedActions` lists it; the API checks the guards
// again and its words show on failure.
import { NcBackTo, type NcAction, type NonconformityView } from '@canopy/contracts';
import { DateInput, formatDate, RadioGroup, Textarea } from '@canopy/ui';
import { useState } from 'react';

import { isoWrite } from '../../_lib/actions';
import { FormDrawer, useSave } from '../../_components/controls';
import type { NcRecordProps } from './NcRecord';
import { WorkFields, workDraft, workPatch, type WorkDraft } from './NcForms';

export type FormStep = Exclude<NcAction, 'RAISE' | 'CANCEL'>;

export const STEP_LABELS: Readonly<Record<FormStep, string>> = {
  ADD_ROOT_CAUSE: 'Record root cause',
  PLAN_ACTIONS: 'Mark actions planned',
  SUBMIT_NO_ACTION: 'Close without corrective action',
  SUBMIT: 'Submit for verification',
  VERIFY_EFFECTIVE: 'Verify effective',
  VERIFY_NOT_EFFECTIVE: 'Not effective',
  REOPEN: 'Reopen',
};

type StepProps = NcRecordProps & { step: FormStep; onClose: () => void };

export function NcStepForm(props: StepProps) {
  switch (props.step) {
    case 'ADD_ROOT_CAUSE':
      return <RootCause {...props} />;
    case 'PLAN_ACTIONS':
      return <PlanActions {...props} />;
    case 'SUBMIT_NO_ACTION':
      return <SubmitNoAction {...props} />;
    case 'SUBMIT':
      return <Submit {...props} />;
    case 'VERIFY_EFFECTIVE':
      return <VerifyEffective {...props} />;
    case 'VERIFY_NOT_EFFECTIVE':
    case 'REOPEN':
      return <BackTo {...props} />;
  }
}

const ROOT_CAUSE_FIELDS = [
  'containment',
  'correction',
  'disposition',
  'rootCauseMethod',
  'rootCause',
  'similarOccurrences',
  'relatedRiskItemIds',
  'riskReview',
] as const satisfies readonly (keyof WorkDraft)[];

/** What ADD_ROOT_CAUSE still needs (model §4.1), in words. */
export function rootCauseMissing(d: WorkDraft, nc: NonconformityView): string | undefined {
  if (d.containment.trim() === '') return 'Describe the containment';
  if (d.correction.trim() === '') return 'Describe the correction';
  if (d.disposition && !d.dispositionAuthorisedById) return 'Name who authorised the disposition';
  if (!d.rootCauseMethod) return 'Choose the root cause method';
  if (d.rootCause.trim() === '') return 'Give the root cause';
  if (d.similarOccurrences.trim() === '') return 'Say whether similar occurrences exist';
  if (nc.incident && d.relatedRiskItemIds.length === 0 && d.riskReview.trim() === '') {
    return 'Name the risks reviewed, or write the risk review';
  }
  return undefined;
}

function RootCause(props: StepProps) {
  const { clientId, nc, onClose } = props;
  const [d, setD] = useState(() => workDraft(nc));
  const { pending, error, save } = useSave();
  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Record root cause"
      submitLabel="Record root cause"
      pending={pending}
      error={error}
      disabledReason={rootCauseMissing(d, nc)}
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'addIsoNcRootCause',
              { id: nc.id },
              {
                version: nc.version,
                ...workPatch(d, nc),
              },
            ),
          'The root cause is recorded.',
        ).then((ok) => ok && onClose())
      }
    >
      {nc.incident && !nc.incident.workerParticipation ? (
        <p className="rounded-card bg-warn-soft p-3 text-body text-warn-ink">
          No worker who is not a manager has taken part in this investigation yet. ISO 45001 expects
          one to; record it on the incident.
        </p>
      ) : null}
      <WorkFields
        d={d}
        set={(p) => setD((x) => ({ ...x, ...p }))}
        nc={nc}
        props={props}
        only={ROOT_CAUSE_FIELDS}
      />
    </FormDrawer>
  );
}

function PlanActions({ clientId, nc, actions, today, onClose }: StepProps) {
  const [due, setDue] = useState<string | null>(nc.effectivenessDueOn);
  const { pending, error, save } = useSave();
  const open = actions.filter((a) => a.state === 'OPEN').length;
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Mark actions planned"
      submitLabel="Mark actions planned"
      pending={pending}
      error={error}
      disabledReason={
        open === 0
          ? 'Add a corrective action first'
          : due
            ? undefined
            : 'Give the date the effectiveness check is due'
      }
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'planIsoNcActions',
              { id: nc.id },
              {
                version: nc.version,
                effectivenessDueOn: due!,
              },
            ),
          'The actions are planned.',
        ).then((ok) => ok && onClose())
      }
    >
      <p className="text-body text-muted">
        {open === 0
          ? 'There is no open corrective action yet. Add one below the investigation first.'
          : `${open} open corrective ${open === 1 ? 'action' : 'actions'}. Once they are done, the approver checks they worked.`}
      </p>
      <DateInput
        label="Effectiveness check due on"
        helper="When the approver checks the actions worked."
        value={due}
        onValueChange={setDue}
        min={today}
        today={today}
      />
    </FormDrawer>
  );
}

function SubmitNoAction({ clientId, nc, onClose }: StepProps) {
  const [reason, setReason] = useState(nc.noActionReason ?? '');
  const [riskReview, setRiskReview] = useState(nc.riskReview ?? '');
  const [systemChange, setSystemChange] = useState(nc.systemChange ?? '');
  const { pending, error, save } = useSave();
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Close without corrective action"
      submitLabel="Submit for verification"
      pending={pending}
      error={error}
      disabledReason={
        reason.trim() === ''
          ? 'Say why no corrective action is needed'
          : riskReview.trim() === ''
            ? 'Write the risk review'
            : systemChange.trim() === ''
              ? 'Say what changes in the system'
              : undefined
      }
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'submitIsoNcNoAction',
              { id: nc.id },
              {
                version: nc.version,
                noActionReason: reason.trim(),
                riskReview: riskReview.trim(),
                systemChange: systemChange.trim(),
              },
            ),
          'It is submitted for verification.',
        ).then((ok) => ok && onClose())
      }
    >
      <p className="text-body text-muted">
        For a minor case the correction already dealt with. The approver still checks it.
      </p>
      <Textarea
        label="Why no corrective action is needed"
        value={reason}
        maxLength={4000}
        onChange={(e) => setReason(e.target.value)}
      />
      <Textarea
        label="Risk review"
        helper="“None needed” is an answer."
        value={riskReview}
        maxLength={4000}
        onChange={(e) => setRiskReview(e.target.value)}
      />
      <Textarea
        label="Change to the system"
        helper="“None needed” is an answer."
        value={systemChange}
        maxLength={4000}
        onChange={(e) => setSystemChange(e.target.value)}
      />
    </FormDrawer>
  );
}

function Submit({ clientId, nc, actions, onClose }: StepProps) {
  const [riskReview, setRiskReview] = useState(nc.riskReview ?? '');
  const [systemChange, setSystemChange] = useState(nc.systemChange ?? '');
  const { pending, error, save } = useSave();
  const open = actions.filter((a) => a.state === 'OPEN').length;
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Submit for verification"
      submitLabel="Submit for verification"
      pending={pending}
      error={error}
      disabledReason={
        open > 0
          ? 'Every corrective action is done or cancelled first'
          : riskReview.trim() === ''
            ? 'Write the risk review'
            : systemChange.trim() === ''
              ? 'Say what changes in the system'
              : undefined
      }
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'submitIsoNc',
              { id: nc.id },
              {
                version: nc.version,
                riskReview: riskReview.trim(),
                systemChange: systemChange.trim(),
              },
            ),
          'It is submitted for verification.',
        ).then((ok) => ok && onClose())
      }
    >
      <p className="text-body text-muted">
        {open > 0
          ? `${open} corrective ${open === 1 ? 'action is' : 'actions are'} still open.`
          : 'The approver checks the actions worked.'}
      </p>
      <Textarea
        label="Risk review"
        helper="“None needed” is an answer."
        value={riskReview}
        maxLength={4000}
        onChange={(e) => setRiskReview(e.target.value)}
      />
      <Textarea
        label="Change to the system"
        helper="“None needed” is an answer."
        value={systemChange}
        maxLength={4000}
        onChange={(e) => setSystemChange(e.target.value)}
      />
    </FormDrawer>
  );
}

function VerifyEffective({ clientId, nc, onClose }: StepProps) {
  const [note, setNote] = useState('');
  const { pending, error, save } = useSave();
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Verify effective"
      submitLabel="Verify and close"
      pending={pending}
      error={error}
      disabledReason={note.trim() === '' ? 'Say how you checked it worked' : undefined}
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'verifyIsoNcEffective',
              { id: nc.id },
              {
                version: nc.version,
                effectivenessNote: note.trim(),
              },
            ),
          'It is verified effective and closed.',
        ).then((ok) => ok && onClose())
      }
    >
      {nc.effectivenessDueOn ? (
        <p className="text-body text-muted">
          The check is due on {formatDate(nc.effectivenessDueOn)}; it cannot be verified before
          then.
        </p>
      ) : null}
      <Textarea
        label="How it was checked"
        value={note}
        maxLength={4000}
        onChange={(e) => setNote(e.target.value)}
      />
    </FormDrawer>
  );
}

const BACK_WORDS: Record<NcBackTo, string> = {
  OPEN: 'Back to the root cause: it was wrong',
  ACTIONS_PLANNED: 'Back to the actions: the root cause stands, more action is needed',
};

/** VERIFY_NOT_EFFECTIVE (the approver) and REOPEN (a client admin): where it goes back to, and why. */
function BackTo({ clientId, nc, step, today, onClose }: StepProps) {
  const reopen = step === 'REOPEN';
  const [backTo, setBackTo] = useState<NcBackTo | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const { pending, error, save } = useSave();
  const title = reopen ? 'Reopen' : 'Not effective';
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      submitLabel={title}
      pending={pending}
      error={error}
      disabledReason={
        !backTo
          ? 'Choose where it goes back to'
          : backTo === 'ACTIONS_PLANNED' && !due
            ? 'Give the new effectiveness check date'
            : reason.trim() === ''
              ? 'Say why'
              : undefined
      }
      onSubmit={() =>
        void save(
          () => {
            const body = {
              version: nc.version,
              reason: reason.trim(),
              backTo: backTo!,
              ...(backTo === 'ACTIONS_PLANNED' ? { effectivenessDueOn: due! } : {}),
            };
            return reopen
              ? isoWrite(clientId, 'reopenIsoNc', { id: nc.id }, body)
              : isoWrite(clientId, 'verifyIsoNcNotEffective', { id: nc.id }, body);
          },
          reopen ? 'It is reopened.' : 'It goes back to be worked again.',
        ).then((ok) => ok && onClose())
      }
    >
      <RadioGroup
        label="Where it goes back to"
        options={NcBackTo.options.map((b) => ({ value: b, label: BACK_WORDS[b] }))}
        value={backTo ?? ''}
        onValueChange={(v) => setBackTo(v as NcBackTo)}
      />
      {backTo === 'ACTIONS_PLANNED' ? (
        <DateInput
          label="New effectiveness check due on"
          value={due}
          onValueChange={setDue}
          min={today}
          today={today}
        />
      ) : null}
      <Textarea
        label="Why"
        value={reason}
        maxLength={2000}
        onChange={(e) => setReason(e.target.value)}
      />
    </FormDrawer>
  );
}
