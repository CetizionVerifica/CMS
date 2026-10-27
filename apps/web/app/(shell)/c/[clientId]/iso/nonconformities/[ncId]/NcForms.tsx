'use client';
// The edits of a nonconformity that are not machine steps (model §4.1): its owner (or a client admin) changes the
// details, the investigation and the incident fields on the PATCH; account admins, consultants and client admins
// reassign the owner, approver, dates, severity and incident outcome on the reassign route, always with a reason
// (model §3.10). Each form sends only what changed.
import {
  IncidentOutcome,
  NcDisposition,
  NcSeverity,
  RootCauseMethod,
  type Incident,
  type IsoStandardCode,
  type NcReassignBody,
  type NcUpdateBody,
  type NonconformityView,
} from '@canopy/contracts';
import { Checkbox, DateInput, Input, RadioGroup, Select, Textarea } from '@canopy/ui';
import { useState } from 'react';

import { isoWrite } from '../../_lib/actions';
import { instantAt } from '../../_lib/people';
import { WORDS } from '../../_lib/words';
import { ClausePicker } from '../../_components/ClausePicker';
import { FormDrawer, PersonSelect, useSave } from '../../_components/controls';
import { InstancePicker, type InstanceChoice } from '../../_components/InstancePicker';
import {
  IncidentFields,
  incidentDraft,
  incidentMissing,
  lostDaysNumber,
  PERSONAL_DATA,
} from '../IncidentFields';
import { severityOpen } from '../nc-model';
import type { NcRecordProps } from './NcRecord';

type Close = { onClose: () => void };

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// ---------- details ----------

export function EditDetails({
  clientId,
  nc,
  system,
  units,
  sourceInstance,
  onClose,
}: NcRecordProps & Close) {
  const incident = nc.incident !== null;
  const [description, setDescription] = useState(nc.description);
  const [standards, setStandards] = useState<IsoStandardCode[]>([...nc.standards]);
  const [clauseIds, setClauseIds] = useState<string[]>([...nc.clauseIds]);
  const [unitId, setUnitId] = useState<string | null>(nc.unitId);
  const [instance, setInstance] = useState<InstanceChoice | null>(
    sourceInstance ? { id: sourceInstance.id, label: sourceInstance.label } : null,
  );
  const { pending, error, save } = useSave();
  const NONE = '__none__';
  const body: NcUpdateBody = {
    version: nc.version,
    ...(description.trim() !== nc.description ? { description: description.trim() } : {}),
    ...(!same(standards, nc.standards) ? { standards } : {}),
    ...(!same(clauseIds, nc.clauseIds) ? { clauseIds } : {}),
    ...(unitId !== nc.unitId ? { unitId } : {}),
    ...((instance?.id ?? null) !== nc.sourceInstanceId
      ? { sourceInstanceId: instance?.id ?? null }
      : {}),
  };
  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Edit details"
      submitLabel="Save details"
      pending={pending}
      error={error}
      disabledReason={
        Object.keys(body).length === 1
          ? 'Nothing has changed'
          : description.trim() === ''
            ? 'Describe what happened or was found'
            : standards.length === 0
              ? 'Choose at least one standard'
              : undefined
      }
      onSubmit={() =>
        void save(
          () => isoWrite(clientId, 'updateIsoNonconformity', { id: nc.id }, body),
          'The details are saved.',
        ).then((ok) => ok && onClose())
      }
    >
      <Textarea
        label="What happened or was found"
        helper={PERSONAL_DATA}
        value={description}
        maxLength={4000}
        onChange={(e) => setDescription(e.target.value)}
      />
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-meta text-ink">Standards</legend>
        {(system?.standards ?? []).map((s) => (
          <Checkbox
            key={s.code}
            label={s.title}
            checked={standards.includes(s.code)}
            onCheckedChange={(c) =>
              setStandards(
                c === true ? [...standards, s.code] : standards.filter((x) => x !== s.code),
              )
            }
          />
        ))}
      </fieldset>
      <ClausePicker
        label="Clauses (optional)"
        options={system?.clauses ?? []}
        value={clauseIds}
        onChange={setClauseIds}
        max={20}
      />
      <Select
        label={incident ? 'Unit' : 'Unit (optional)'}
        options={[
          ...(incident ? [] : [{ value: NONE, label: 'No one unit' }]),
          ...units.map((u) => ({ value: u.id, label: u.name })),
        ]}
        value={unitId ?? NONE}
        onValueChange={(v) => setUnitId(v === NONE ? null : v)}
      />
      <InstancePicker
        clientId={clientId}
        label="Register activity that raised it (optional)"
        value={instance}
        onChange={setInstance}
      />
    </FormDrawer>
  );
}

// ---------- investigation ----------

export type WorkDraft = {
  containment: string;
  correction: string;
  disposition: NcDisposition | null;
  dispositionAuthorisedById: string | null;
  rootCauseMethod: RootCauseMethod | null;
  rootCause: string;
  similarOccurrences: string;
  relatedRiskItemIds: string[];
  updatedRiskItemIds: string[];
  riskReview: string;
  systemChange: string;
  changedDocumentIds: string[];
};

export function workDraft(nc: NonconformityView): WorkDraft {
  return {
    containment: nc.containment ?? '',
    correction: nc.correction ?? '',
    disposition: nc.disposition,
    dispositionAuthorisedById: nc.dispositionAuthorisedById,
    rootCauseMethod: nc.rootCauseMethod,
    rootCause: nc.rootCause ?? '',
    similarOccurrences: nc.similarOccurrences ?? '',
    relatedRiskItemIds: [...nc.relatedRiskItemIds],
    updatedRiskItemIds: [...nc.updatedRiskItemIds],
    riskReview: nc.riskReview ?? '',
    systemChange: nc.systemChange ?? '',
    changedDocumentIds: [...nc.changedDocumentIds],
  };
}

const TEXTS = [
  'containment',
  'correction',
  'rootCause',
  'similarOccurrences',
  'riskReview',
  'systemChange',
] as const;
const LISTS = ['relatedRiskItemIds', 'updatedRiskItemIds', 'changedDocumentIds'] as const;

/** The investigation fields that changed, as the PATCH (and ADD_ROOT_CAUSE) take them: an emptied text is cleared. */
export function workPatch(d: WorkDraft, nc: NonconformityView): Partial<NcUpdateBody> {
  const patch: Record<string, unknown> = {};
  for (const key of TEXTS) {
    const value = d[key].trim() || null;
    if (value !== nc[key]) patch[key] = value;
  }
  for (const key of LISTS) if (!same(d[key], nc[key])) patch[key] = d[key];
  if (d.disposition !== nc.disposition) patch.disposition = d.disposition;
  if (d.dispositionAuthorisedById !== nc.dispositionAuthorisedById) {
    patch.dispositionAuthorisedById = d.dispositionAuthorisedById;
  }
  if (d.rootCauseMethod !== nc.rootCauseMethod) patch.rootCauseMethod = d.rootCauseMethod;
  return patch as Partial<NcUpdateBody>;
}

/** The investigation's fields. A disposition is given no later than the root cause (model §3.10), so only while OPEN. */
export function WorkFields({
  d,
  set,
  nc,
  props,
  only,
}: {
  d: WorkDraft;
  set: (patch: Partial<WorkDraft>) => void;
  nc: NonconformityView;
  props: Pick<NcRecordProps, 'people' | 'risks' | 'liveRiskIds' | 'documents'>;
  /** The fields a step asks for; every field when left out. */
  only?: readonly (keyof WorkDraft)[];
}) {
  const NONE = '__none__';
  const show = (key: keyof WorkDraft) => !only || only.includes(key);
  const riskOptions = props.risks
    .filter((r) => props.liveRiskIds.includes(r.id))
    .map((r) => ({ id: r.id, label: r.label }));
  const documentOptions = props.documents.map((r) => ({ id: r.id, label: r.label }));
  const text = (key: (typeof TEXTS)[number], label: string, helper?: string) =>
    show(key) ? (
      <Textarea
        key={key}
        label={label}
        helper={helper}
        value={d[key]}
        maxLength={4000}
        onChange={(e) => set({ [key]: e.target.value })}
      />
    ) : null;
  return (
    <>
      <p className="text-meta text-muted">{PERSONAL_DATA}</p>
      {text(
        'containment',
        'Containment',
        'What stopped it spreading; for equipment found unfit, the check on earlier results.',
      )}
      {text('correction', 'Correction', 'The immediate fix.')}
      {nc.state === 'OPEN' && show('disposition') ? (
        <>
          <Select
            label="Disposition of nonconforming outputs (optional)"
            options={[
              { value: NONE, label: 'None' },
              ...NcDisposition.options.map((v) => ({ value: v, label: WORDS.NcDisposition[v] })),
            ]}
            value={d.disposition ?? NONE}
            onValueChange={(v) =>
              set({
                disposition: v === NONE ? null : (v as NcDisposition),
                ...(v === NONE ? { dispositionAuthorisedById: null } : {}),
              })
            }
          />
          {d.disposition ? (
            <PersonSelect
              label="Disposition authorised by"
              people={props.people}
              value={d.dispositionAuthorisedById}
              onChange={(id) => set({ dispositionAuthorisedById: id })}
            />
          ) : null}
        </>
      ) : null}
      {show('rootCauseMethod') ? (
        <Select
          label="Root cause method"
          options={RootCauseMethod.options.map((v) => ({
            value: v,
            label: WORDS.RootCauseMethod[v],
          }))}
          value={d.rootCauseMethod ?? undefined}
          onValueChange={(v) => set({ rootCauseMethod: v as RootCauseMethod })}
        />
      ) : null}
      {text('rootCause', 'Root cause')}
      {text(
        'similarOccurrences',
        'Similar occurrences',
        'Whether similar nonconformities exist or could occur, and where.',
      )}
      {show('relatedRiskItemIds') ? (
        <ClausePicker
          label="Risks reviewed"
          options={riskOptions}
          value={d.relatedRiskItemIds}
          onChange={(ids) => set({ relatedRiskItemIds: ids })}
          placeholder="Type a risk item's activity"
          emptyText="No risk item matches"
          unknown="A risk item no longer listed"
        />
      ) : null}
      {show('updatedRiskItemIds') ? (
        <ClausePicker
          label="Risks updated because of it"
          helper="A new hazard found is added to the risk register and named here."
          options={riskOptions}
          value={d.updatedRiskItemIds}
          onChange={(ids) => set({ updatedRiskItemIds: ids })}
          placeholder="Type a risk item's activity"
          emptyText="No risk item matches"
          unknown="A risk item no longer listed"
        />
      ) : null}
      {text('riskReview', 'Risk review', '“None needed” is an answer.')}
      {text('systemChange', 'Change to the system', '“None needed” is an answer.')}
      {show('changedDocumentIds') ? (
        <ClausePicker
          label="Documents changed"
          options={documentOptions}
          value={d.changedDocumentIds}
          onChange={(ids) => set({ changedDocumentIds: ids })}
          placeholder="Type a document code or title"
          emptyText="No document matches"
          unknown="A document no longer listed"
        />
      ) : null}
    </>
  );
}

export function EditInvestigation(props: NcRecordProps & Close) {
  const { clientId, nc, onClose } = props;
  const [d, setD] = useState(() => workDraft(nc));
  const { pending, error, save } = useSave();
  const patch = workPatch(d, nc);
  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Edit investigation"
      submitLabel="Save investigation"
      pending={pending}
      error={error}
      disabledReason={
        Object.keys(patch).length === 0
          ? 'Nothing has changed'
          : d.disposition && !d.dispositionAuthorisedById
            ? 'Name who authorised the disposition'
            : undefined
      }
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'updateIsoNonconformity',
              { id: nc.id },
              {
                version: nc.version,
                ...patch,
              },
            ),
          'The investigation is saved.',
        ).then((ok) => ok && onClose())
      }
    >
      <WorkFields d={d} set={(p) => setD((x) => ({ ...x, ...p }))} nc={nc} props={props} />
    </FormDrawer>
  );
}

// ---------- incident ----------

export function EditIncident({
  clientId,
  nc,
  incident,
  people,
  statutory,
  today,
  timeZone,
  onClose,
}: NcRecordProps & Close & { incident: Incident }) {
  const [d, setD] = useState(() =>
    incidentDraft(
      incident,
      timeZone,
      statutory ? { id: statutory.id, label: statutory.label } : null,
    ),
  );
  const { pending, error, save } = useSave();
  const occurredAt = d.date ? instantAt(d.date, d.time, timeZone) : null;
  const lostDays = incident.outcome === 'LOST_TIME' ? lostDaysNumber(d.lostDays) : null;
  const statutoryId = d.reportable ? (d.statutory?.id ?? null) : null;
  const patch = {
    ...(occurredAt !== null && occurredAt !== incident.occurredAt ? { occurredAt } : {}),
    ...(d.location.trim() !== incident.location ? { location: d.location.trim() } : {}),
    ...(d.personCategory !== incident.personCategory ? { personCategory: d.personCategory } : {}),
    ...(lostDays !== null && lostDays !== incident.lostDays ? { lostDays } : {}),
    ...(d.reportable !== incident.reportable ? { reportable: d.reportable } : {}),
    ...(statutoryId !== incident.statutoryInstanceId ? { statutoryInstanceId: statutoryId } : {}),
    ...(!same(d.investigatorIds, incident.investigatorIds)
      ? { investigatorIds: d.investigatorIds }
      : {}),
    ...(d.workerParticipation !== incident.workerParticipation
      ? { workerParticipation: d.workerParticipation }
      : {}),
  };
  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={nc.source === 'NEAR_MISS' ? 'Edit near miss' : 'Edit incident'}
      submitLabel="Save"
      pending={pending}
      error={error}
      disabledReason={
        incidentMissing(d, timeZone) ??
        (Object.keys(patch).length === 0 ? 'Nothing has changed' : undefined)
      }
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'updateIsoNonconformity',
              { id: nc.id },
              {
                version: nc.version,
                incident: patch,
              },
            ),
          'The incident is saved.',
        ).then((ok) => ok && onClose())
      }
    >
      <p className="text-body text-muted">{PERSONAL_DATA}</p>
      <IncidentFields
        clientId={clientId}
        draft={d}
        set={(p) => setD((x) => ({ ...x, ...p }))}
        nearMiss={nc.source === 'NEAR_MISS'}
        people={people}
        unitId={nc.unitId}
        today={today}
        editing
      />
    </FormDrawer>
  );
}

// ---------- reassign ----------

export function Reassign({ clientId, nc, people, today, onClose }: NcRecordProps & Close) {
  const inWindow = severityOpen(nc);
  const severityShown = inWindow && nc.findingId === null;
  const outcomeShown = inWindow && nc.incident !== null && nc.source !== 'NEAR_MISS';
  const [ownerId, setOwnerId] = useState<string | null>(nc.ownerId);
  const [approverId, setApproverId] = useState<string | null>(nc.approverId);
  const [dueOn, setDueOn] = useState<string | null>(nc.dueOn);
  const [effectivenessDueOn, setEffectivenessDueOn] = useState<string | null>(
    nc.effectivenessDueOn,
  );
  const [severity, setSeverity] = useState<NcSeverity>(nc.severity);
  const [outcome, setOutcome] = useState<IncidentOutcome | null>(nc.incident?.outcome ?? null);
  const [lostDays, setLostDays] = useState(
    nc.incident?.lostDays === null || nc.incident === null ? '' : String(nc.incident.lostDays),
  );
  const [reason, setReason] = useState('');
  const { pending, error, save } = useSave();
  const outcomeChanged = outcomeShown && outcome !== nc.incident?.outcome;
  const body: NcReassignBody = {
    version: nc.version,
    reason: reason.trim(),
    ...(ownerId && ownerId !== nc.ownerId ? { ownerId } : {}),
    ...(approverId && approverId !== nc.approverId ? { approverId } : {}),
    ...(dueOn && dueOn !== nc.dueOn ? { dueOn } : {}),
    ...(effectivenessDueOn && effectivenessDueOn !== nc.effectivenessDueOn
      ? { effectivenessDueOn }
      : {}),
    ...(severityShown && severity !== nc.severity ? { severity } : {}),
    ...(outcomeChanged && outcome
      ? {
          incident: {
            outcome,
            lostDays: outcome === 'LOST_TIME' ? lostDaysNumber(lostDays) : null,
          },
        }
      : {}),
  };
  const changed = Object.keys(body).length > 2;
  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Reassign"
      submitLabel="Save"
      pending={pending}
      error={error}
      disabledReason={
        !changed
          ? 'Nothing has changed'
          : ownerId === approverId
            ? 'The approver is someone other than the owner'
            : outcomeChanged && outcome === 'LOST_TIME' && lostDaysNumber(lostDays) === null
              ? 'Give the days lost, from 1'
              : reason.trim() === ''
                ? 'Say why'
                : undefined
      }
      onSubmit={() =>
        void save(
          () => isoWrite(clientId, 'reassignIsoNonconformity', { id: nc.id }, body),
          'It is reassigned.',
        ).then((ok) => ok && onClose())
      }
    >
      <PersonSelect label="Owner" people={people} value={ownerId} onChange={setOwnerId} />
      <PersonSelect label="Approver" people={people} value={approverId} onChange={setApproverId} />
      <DateInput
        label="Due on"
        value={dueOn}
        onValueChange={setDueOn}
        min={nc.reportedOn}
        today={today}
      />
      {nc.effectivenessDueOn ? (
        <DateInput
          label="Effectiveness check due on"
          value={effectivenessDueOn}
          onValueChange={setEffectivenessDueOn}
          min={today}
          today={today}
        />
      ) : null}
      {severityShown ? (
        <RadioGroup
          label="Severity"
          orientation="horizontal"
          options={NcSeverity.options.map((s) => ({ value: s, label: WORDS.NcSeverity[s] }))}
          value={severity}
          onValueChange={(v) => setSeverity(v as NcSeverity)}
        />
      ) : null}
      {outcomeShown ? (
        <>
          <Select
            label="Outcome"
            options={IncidentOutcome.options.map((o) => ({
              value: o,
              label: WORDS.IncidentOutcome[o],
            }))}
            value={outcome ?? undefined}
            onValueChange={(v) => {
              setOutcome(v as IncidentOutcome);
              setLostDays('');
            }}
          />
          {outcome === 'LOST_TIME' && outcomeChanged ? (
            <Input
              label="Days lost"
              inputMode="numeric"
              maxLength={5}
              value={lostDays}
              onChange={(e) => setLostDays(e.target.value)}
            />
          ) : null}
        </>
      ) : null}
      {!inWindow ? (
        <p className="text-meta text-muted">
          Severity and outcome are fixed once corrective action is planned.
        </p>
      ) : nc.findingId !== null ? (
        <p className="text-meta text-muted">
          Its severity follows the audit finding that raised it.
        </p>
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
