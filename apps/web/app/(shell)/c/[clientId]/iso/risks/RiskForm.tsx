'use client';
// Adds a risk item or edits one (model §3.5). The fields follow the kind: an aspect has its impact, life-cycle stages,
// control or influence and operating condition; a hazard its harm, routine, who is exposed and operating condition.
// The rating and significance are the engine's, worked out by the API from the scores given here.
import {
  AspectControlType,
  LifeCycleStage,
  OperatingCondition,
  PersonsExposed,
  RiskKind,
  type RiskItemView,
} from '@canopy/contracts';
import { Checkbox, DateInput, Input, RadioGroup, Select, Textarea } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { isoWrite } from '../_lib/actions';
import type { PersonOption } from '../_lib/people';
import { word, WORDS } from '../_lib/words';
import { FormDrawer, PersonSelect, useSave } from '../_components/controls';
import { secondAxis } from './risks-model';

export type RiskSystemOption = { id: string; name: string; unitIds: string[] };

export type RiskFormProps = {
  clientId: string;
  systems: RiskSystemOption[];
  units: { id: string; name: string }[];
  people: PersonOption[];
  /** Managers name any owner; an owner adds and edits items that name themselves. */
  ownerOnly: string | null;
  today: string;
  onClose: () => void;
};

type Fields = {
  managementSystemId: string;
  kind: RiskKind;
  unitId: string | null;
  activity: string;
  description: string;
  impact: string;
  lifeCycleStages: LifeCycleStage[];
  controlType: AspectControlType | null;
  routine: boolean | null;
  personsExposed: PersonsExposed[];
  condition: OperatingCondition | null;
  assessedWith: string;
  likelihood: number | null;
  severity: number | null;
  residualLikelihood: number | null;
  residualSeverity: number | null;
  climateRelated: boolean;
  ownerId: string | null;
  reviewDueOn: string | null;
};

function fieldsOf(r: RiskItemView): Fields {
  return {
    managementSystemId: r.managementSystemId,
    kind: r.kind,
    unitId: r.unitId,
    activity: r.activity,
    description: r.description,
    impact: r.impact ?? '',
    lifeCycleStages: r.lifeCycleStages,
    controlType: r.controlType,
    routine: r.routine,
    personsExposed: r.personsExposed,
    condition: r.condition,
    assessedWith: r.assessedWith ?? '',
    likelihood: r.likelihood,
    severity: r.severity,
    residualLikelihood: r.residualLikelihood,
    residualSeverity: r.residualSeverity,
    climateRelated: r.climateRelated,
    ownerId: r.ownerId,
    reviewDueOn: r.reviewDueOn,
  };
}

/** The values the API takes for the kind: other kinds' fields are cleared (the contracts' kind rules). */
export function kindValues(f: Fields) {
  const aspect = f.kind === 'ASPECT';
  const hazard = f.kind === 'HAZARD';
  return {
    impact: aspect || hazard ? f.impact.trim() || null : null,
    lifeCycleStages: aspect ? f.lifeCycleStages : [],
    controlType: aspect ? f.controlType : null,
    routine: hazard ? f.routine : null,
    personsExposed: hazard ? f.personsExposed : [],
    condition: aspect || hazard ? f.condition : null,
  };
}

/** What still stops the item being saved, in words; undefined when it can be. */
export function riskMissing(f: Fields): string | undefined {
  const k = kindValues(f);
  if (f.activity.trim() === '') return 'Name the activity, product or service';
  if (f.description.trim() === '') return `Describe the ${word('RiskKind', f.kind).toLowerCase()}`;
  if ((f.kind === 'ASPECT' || f.kind === 'HAZARD') && !k.impact) {
    return f.kind === 'ASPECT' ? 'Describe the environmental impact' : 'Describe the harm';
  }
  if (f.kind === 'ASPECT' && k.lifeCycleStages.length === 0) return 'Choose a life-cycle stage';
  if (f.kind === 'ASPECT' && !k.controlType) return 'Say whether it is controlled or influenced';
  if (f.kind === 'HAZARD' && k.routine === null) return 'Say whether the work is routine';
  if (f.kind === 'HAZARD' && k.personsExposed.length === 0) return 'Choose who is exposed';
  if ((f.kind === 'ASPECT' || f.kind === 'HAZARD') && !k.condition)
    return 'Choose the operating condition';
  if (f.likelihood === null || f.severity === null) return 'Rate it';
  if ((f.residualLikelihood === null) !== (f.residualSeverity === null)) {
    return 'Give both residual scores, or neither';
  }
  if (!f.ownerId) return 'Choose the owner';
  return undefined;
}

const SCALE = ['1', '2', '3', '4', '5'];

function ScoreSelect({
  label,
  value,
  onChange,
  optional,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  optional?: boolean;
}) {
  const NONE = '__none__';
  return (
    <Select
      label={label}
      options={[
        ...(optional ? [{ value: NONE, label: 'Not rated' }] : []),
        ...SCALE.map((v) => ({ value: v, label: v })),
      ]}
      value={value === null ? (optional ? NONE : undefined) : String(value)}
      onValueChange={(v) => onChange(v === NONE ? null : Number(v))}
    />
  );
}

function CheckGroup<T extends string>({
  legend,
  options,
  words,
  value,
  onChange,
}: {
  legend: string;
  options: readonly T[];
  words: Readonly<Record<T, string>>;
  value: T[];
  onChange: (v: T[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-meta text-ink">{legend}</legend>
      {options.map((o) => (
        <Checkbox
          key={o}
          label={words[o]}
          checked={value.includes(o)}
          onCheckedChange={(c) =>
            onChange(c === true ? [...value, o] : value.filter((v) => v !== o))
          }
        />
      ))}
    </fieldset>
  );
}

function RiskFields({
  f,
  set,
  units,
  isNew,
}: {
  f: Fields;
  set: (patch: Partial<Fields>) => void;
  units: { id: string; name: string }[];
  isNew: boolean;
}) {
  const ALL = '__all__';
  const kindWord = word('RiskKind', f.kind).toLowerCase();
  return (
    <>
      {isNew ? (
        <RadioGroup
          label="Kind"
          orientation="horizontal"
          options={RiskKind.options.map((k) => ({ value: k, label: WORDS.RiskKind[k] }))}
          value={f.kind}
          onValueChange={(v) => set({ kind: v as RiskKind })}
        />
      ) : null}
      <Select
        label="Unit"
        options={[
          { value: ALL, label: "All the system's units" },
          ...units.map((u) => ({ value: u.id, label: u.name })),
        ]}
        value={f.unitId ?? ALL}
        onValueChange={(v) => set({ unitId: v === ALL ? null : v })}
      />
      <Input
        label="Activity, product or service"
        value={f.activity}
        maxLength={300}
        onChange={(e) => set({ activity: e.target.value })}
      />
      <Textarea
        label={`The ${kindWord}`}
        value={f.description}
        maxLength={4000}
        onChange={(e) => set({ description: e.target.value })}
      />
      {f.kind === 'ASPECT' || f.kind === 'HAZARD' ? (
        <Textarea
          label={f.kind === 'ASPECT' ? 'Environmental impact' : 'Harm it can cause'}
          value={f.impact}
          maxLength={2000}
          onChange={(e) => set({ impact: e.target.value })}
        />
      ) : null}
      {f.kind === 'ASPECT' ? (
        <>
          <CheckGroup
            legend="Life-cycle stages"
            options={LifeCycleStage.options}
            words={WORDS.LifeCycleStage}
            value={f.lifeCycleStages}
            onChange={(lifeCycleStages) => set({ lifeCycleStages })}
          />
          <RadioGroup
            label="Control or influence"
            orientation="horizontal"
            options={AspectControlType.options.map((v) => ({
              value: v,
              label: WORDS.AspectControlType[v],
            }))}
            value={f.controlType ?? undefined}
            onValueChange={(v) => set({ controlType: v as AspectControlType })}
          />
        </>
      ) : null}
      {f.kind === 'HAZARD' ? (
        <>
          <RadioGroup
            label="Routine work"
            orientation="horizontal"
            options={[
              { value: 'yes', label: 'Routine' },
              { value: 'no', label: 'Non-routine' },
            ]}
            value={f.routine === null ? undefined : f.routine ? 'yes' : 'no'}
            onValueChange={(v) => set({ routine: v === 'yes' })}
          />
          <CheckGroup
            legend="Who is exposed"
            options={PersonsExposed.options}
            words={WORDS.PersonsExposed}
            value={f.personsExposed}
            onChange={(personsExposed) => set({ personsExposed })}
          />
        </>
      ) : null}
      {f.kind === 'ASPECT' || f.kind === 'HAZARD' ? (
        <Select
          label="Operating condition"
          options={OperatingCondition.options.map((v) => ({
            value: v,
            label: WORDS.OperatingCondition[v],
          }))}
          value={f.condition ?? undefined}
          onValueChange={(v) => set({ condition: v as OperatingCondition })}
        />
      ) : null}
      <Textarea
        label="Assessed with (optional)"
        helper={f.kind === 'HAZARD' ? 'The workers who took part in the assessment.' : undefined}
        value={f.assessedWith}
        maxLength={2000}
        onChange={(e) => set({ assessedWith: e.target.value })}
      />
      <fieldset className="grid grid-cols-2 gap-3">
        <legend className="mb-1 text-meta text-ink">With the controls in place now (1 to 5)</legend>
        <ScoreSelect
          label="Likelihood"
          value={f.likelihood}
          onChange={(likelihood) => set({ likelihood })}
        />
        <ScoreSelect
          label={secondAxis(f.kind)}
          value={f.severity}
          onChange={(severity) => set({ severity })}
        />
      </fieldset>
      <fieldset className="grid grid-cols-2 gap-3">
        <legend className="mb-1 text-meta text-ink">
          After the planned treatment actions (optional)
        </legend>
        <ScoreSelect
          label="Residual likelihood"
          optional
          value={f.residualLikelihood}
          onChange={(residualLikelihood) => set({ residualLikelihood })}
        />
        <ScoreSelect
          label={`Residual ${secondAxis(f.kind).toLowerCase()}`}
          optional
          value={f.residualSeverity}
          onChange={(residualSeverity) => set({ residualSeverity })}
        />
      </fieldset>
      <Checkbox
        label="Climate related"
        checked={f.climateRelated}
        onCheckedChange={(c) => set({ climateRelated: c === true })}
      />
    </>
  );
}

export function NewRisk(props: RiskFormProps & { kind?: RiskKind }) {
  const { clientId, systems, units, people, ownerOnly, today, onClose } = props;
  const router = useRouter();
  const [f, setF] = useState<Fields>({
    managementSystemId: systems[0]?.id ?? '',
    kind: props.kind ?? 'RISK',
    unitId: null,
    activity: '',
    description: '',
    impact: '',
    lifeCycleStages: [],
    controlType: null,
    routine: null,
    personsExposed: [],
    condition: null,
    assessedWith: '',
    likelihood: null,
    severity: null,
    residualLikelihood: null,
    residualSeverity: null,
    climateRelated: false,
    ownerId: ownerOnly,
    reviewDueOn: null,
  });
  const set = (patch: Partial<Fields>) => setF((x) => ({ ...x, ...patch }));
  const { pending, error, save } = useSave();
  const system = systems.find((s) => s.id === f.managementSystemId);
  const systemUnits = system?.unitIds.length
    ? units.filter((u) => system.unitIds.includes(u.id))
    : units;

  const submit = async () => {
    let newId: string | null = null;
    const ok = await save(
      async () => {
        const result = await isoWrite(
          clientId,
          'createIsoRisk',
          {},
          {
            managementSystemId: f.managementSystemId,
            kind: f.kind,
            unitId: f.unitId,
            activity: f.activity.trim(),
            description: f.description.trim(),
            ...kindValues(f),
            assessedWith: f.assessedWith.trim() || null,
            likelihood: f.likelihood!,
            severity: f.severity!,
            residualLikelihood: f.residualLikelihood,
            residualSeverity: f.residualSeverity,
            climateRelated: f.climateRelated,
            ownerId: f.ownerId!,
            reviewDueOn: f.reviewDueOn,
          },
        );
        if (result.ok) newId = result.data.id;
        return result;
      },
      `The ${word('RiskKind', f.kind).toLowerCase()} is added.`,
    );
    if (ok && newId) router.push(`/c/${clientId}/iso/risks/${newId}`);
  };

  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Add to the risk register"
      submitLabel="Add"
      pending={pending}
      error={error}
      disabledReason={riskMissing(f)}
      onSubmit={() => void submit()}
    >
      {systems.length > 1 ? (
        <Select
          label="Management system"
          options={systems.map((s) => ({ value: s.id, label: s.name }))}
          value={f.managementSystemId}
          onValueChange={(v) => set({ managementSystemId: v, unitId: null })}
        />
      ) : null}
      <RiskFields f={f} set={set} units={systemUnits} isNew />
      {ownerOnly ? (
        <p className="text-body">
          <span className="text-muted">Owner: </span>you
        </p>
      ) : (
        <PersonSelect
          label="Owner"
          people={people}
          value={f.ownerId}
          onChange={(ownerId) => set({ ownerId })}
        />
      )}
      <DateInput
        label="Next review (optional)"
        value={f.reviewDueOn}
        onValueChange={(reviewDueOn) => set({ reviewDueOn })}
        min={today}
        today={today}
      />
    </FormDrawer>
  );
}

export function EditRisk({
  clientId,
  risk,
  units,
  people,
  canReassign,
  today,
  onClose,
}: Omit<RiskFormProps, 'systems' | 'ownerOnly'> & { risk: RiskItemView; canReassign: boolean }) {
  const [f, setF] = useState<Fields>(fieldsOf(risk));
  const [reason, setReason] = useState('');
  const set = (patch: Partial<Fields>) => setF((x) => ({ ...x, ...patch }));
  const { pending, error, save } = useSave();

  const before = fieldsOf(risk);
  const k = kindValues(f);
  const kBefore = kindValues(before);
  const next: Record<string, unknown> = {
    unitId: f.unitId,
    activity: f.activity.trim(),
    description: f.description.trim(),
    ...k,
    assessedWith: f.assessedWith.trim() || null,
    likelihood: f.likelihood,
    severity: f.severity,
    residualLikelihood: f.residualLikelihood,
    residualSeverity: f.residualSeverity,
    climateRelated: f.climateRelated,
    ownerId: f.ownerId,
    reviewDueOn: f.reviewDueOn,
  };
  const prev: Record<string, unknown> = {
    unitId: before.unitId,
    activity: before.activity,
    description: before.description,
    ...kBefore,
    assessedWith: before.assessedWith || null,
    likelihood: before.likelihood,
    severity: before.severity,
    residualLikelihood: before.residualLikelihood,
    residualSeverity: before.residualSeverity,
    climateRelated: before.climateRelated,
    ownerId: before.ownerId,
    reviewDueOn: before.reviewDueOn,
  };
  const body: Record<string, unknown> = { version: risk.version };
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(value) !== JSON.stringify(prev[key])) body[key] = value;
  }
  const needsReason = 'ownerId' in body || 'reviewDueOn' in body;
  if (needsReason) body.reason = reason.trim();
  const changed = Object.keys(body).some((key) => key !== 'version' && key !== 'reason');
  const missing = !changed
    ? 'Nothing has changed'
    : (riskMissing(f) ??
      (needsReason && reason.trim() === ''
        ? 'Say why the owner or review date changes'
        : undefined));

  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Edit ${word('RiskKind', risk.kind).toLowerCase()}`}
      submitLabel="Save"
      pending={pending}
      error={error}
      disabledReason={missing}
      onSubmit={() =>
        void save(
          () => isoWrite(clientId, 'updateIsoRisk', { id: risk.id }, body as never),
          'The risk register is saved.',
        ).then((ok) => ok && onClose())
      }
    >
      <RiskFields f={f} set={set} units={units} isNew={false} />
      {canReassign ? (
        <PersonSelect
          label="Owner"
          people={people}
          value={f.ownerId}
          onChange={(ownerId) => set({ ownerId })}
        />
      ) : null}
      <DateInput
        label="Next review"
        value={f.reviewDueOn}
        onValueChange={(reviewDueOn) => set({ reviewDueOn })}
        today={today}
      />
      {needsReason ? (
        <Textarea
          label="Why the owner or review date changes"
          value={reason}
          maxLength={2000}
          onChange={(e) => setReason(e.target.value)}
        />
      ) : null}
    </FormDrawer>
  );
}
