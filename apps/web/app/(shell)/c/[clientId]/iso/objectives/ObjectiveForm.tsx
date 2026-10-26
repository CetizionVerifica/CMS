'use client';
// Adds an objective or edits an open one (model §3.6): the standards it serves (some of its system's), what it measures,
// its target, baseline and direction, how often a reading is taken, the risk items it addresses, owner and due date. A
// new owner or a moved due date asks for a reason (model §1.9).
import {
  ObjectiveDirection,
  type IsoStandardCode,
  type ObjectiveView,
  type RecurrenceRule,
} from '@canopy/contracts';
import { Checkbox, DateInput, Input, Select, Textarea } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { isoWrite } from '../_lib/actions';
import type { PersonOption } from '../_lib/people';
import { WORDS } from '../_lib/words';
import { FormDrawer, PersonSelect, useSave } from '../_components/controls';
import { READING_CHOICES, readingChoice, type ReadingChoice } from './objectives-model';
import { readingRuleText } from './objectives-words';

export type ObjectiveSystemOption = {
  id: string;
  name: string;
  standards: { code: IsoStandardCode; title: string }[];
  /** The system's risk items an objective can address. */
  risks: { id: string; label: string }[];
};

export type ObjectiveFormProps = {
  clientId: string;
  systems: ObjectiveSystemOption[];
  people: PersonOption[];
  /** Managers name any owner; an owner adds objectives they own. */
  ownerOnly: string | null;
  today: string;
  onClose: () => void;
};

type Fields = {
  managementSystemId: string;
  standards: IsoStandardCode[];
  text: string;
  target: string;
  unitOfMeasure: string;
  baseline: string;
  direction: ObjectiveDirection;
  reading: ReadingChoice | null;
  riskItemIds: string[];
  ownerId: string | null;
  dueOn: string | null;
};

const num = (s: string): number | null => {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** What still stops the objective being saved, in words. */
export function objectiveMissing(f: Fields, keptRule: boolean): string | undefined {
  const target = num(f.target);
  const baseline = num(f.baseline);
  if (f.standards.length === 0) return 'Choose at least one standard';
  if (f.text.trim() === '') return 'Say what the objective is';
  if (target === null) return 'Give the target as a number';
  if (f.unitOfMeasure.trim() === '') return 'Give the unit it is measured in';
  if (f.baseline.trim() !== '' && baseline === null) return 'Give the baseline as a number';
  if (baseline !== null && f.direction === 'INCREASE' && target < baseline) {
    return 'To increase, the target is at or above the baseline';
  }
  if (baseline !== null && f.direction === 'DECREASE' && target > baseline) {
    return 'To decrease, the target is at or below the baseline';
  }
  if (!f.reading && !keptRule) return 'Choose how often a reading is taken';
  if (!f.ownerId) return 'Choose the owner';
  if (!f.dueOn) return 'Give the date it is due';
  return undefined;
}

function ObjectiveFields({
  f,
  set,
  system,
  keptRule,
}: {
  f: Fields;
  set: (patch: Partial<Fields>) => void;
  system: ObjectiveSystemOption | undefined;
  keptRule: RecurrenceRule | null;
}) {
  const KEEP = '__keep__';
  return (
    <>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-meta text-ink">Standards</legend>
        {(system?.standards ?? []).map((s) => (
          <Checkbox
            key={s.code}
            label={s.title}
            checked={f.standards.includes(s.code)}
            onCheckedChange={(c) =>
              set({
                standards:
                  c === true ? [...f.standards, s.code] : f.standards.filter((x) => x !== s.code),
              })
            }
          />
        ))}
      </fieldset>
      <Textarea
        label="Objective"
        value={f.text}
        maxLength={1000}
        onChange={(e) => set({ text: e.target.value })}
      />
      <Select
        label="Direction"
        options={ObjectiveDirection.options.map((d) => ({
          value: d,
          label: WORDS.ObjectiveDirection[d],
        }))}
        value={f.direction}
        onValueChange={(v) => set({ direction: v as ObjectiveDirection })}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Input
          label="Baseline (optional)"
          inputMode="decimal"
          value={f.baseline}
          onChange={(e) => set({ baseline: e.target.value })}
        />
        <Input
          label="Target"
          inputMode="decimal"
          value={f.target}
          onChange={(e) => set({ target: e.target.value })}
        />
        <Input
          label="Unit"
          value={f.unitOfMeasure}
          maxLength={50}
          onChange={(e) => set({ unitOfMeasure: e.target.value })}
        />
      </div>
      <Select
        label="Readings"
        options={[
          ...(keptRule ? [{ value: KEEP, label: `${readingRuleText(keptRule)} (as set)` }] : []),
          ...Object.entries(READING_CHOICES).map(([value, c]) => ({ value, label: c.label })),
        ]}
        value={f.reading ?? (keptRule ? KEEP : undefined)}
        onValueChange={(v) => set({ reading: v === KEEP ? null : (v as ReadingChoice) })}
      />
      {system && system.risks.length > 0 ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-meta text-ink">Risk items it addresses (optional)</legend>
          {system.risks.map((r) => (
            <Checkbox
              key={r.id}
              label={r.label}
              checked={f.riskItemIds.includes(r.id)}
              onCheckedChange={(c) =>
                set({
                  riskItemIds:
                    c === true ? [...f.riskItemIds, r.id] : f.riskItemIds.filter((x) => x !== r.id),
                })
              }
            />
          ))}
        </fieldset>
      ) : null}
    </>
  );
}

export function NewObjective({
  clientId,
  systems,
  people,
  ownerOnly,
  today,
  onClose,
}: ObjectiveFormProps) {
  const router = useRouter();
  const [f, setF] = useState<Fields>({
    managementSystemId: systems[0]?.id ?? '',
    standards: systems[0]?.standards.length === 1 ? [systems[0].standards[0]!.code] : [],
    text: '',
    target: '',
    unitOfMeasure: '',
    baseline: '',
    direction: 'DECREASE',
    reading: 'QUARTERLY',
    riskItemIds: [],
    ownerId: ownerOnly,
    dueOn: null,
  });
  const set = (patch: Partial<Fields>) => setF((x) => ({ ...x, ...patch }));
  const system = systems.find((s) => s.id === f.managementSystemId);
  const { pending, error, save } = useSave();

  const submit = async () => {
    let newId: string | null = null;
    const ok = await save(async () => {
      const result = await isoWrite(
        clientId,
        'createIsoObjective',
        {},
        {
          managementSystemId: f.managementSystemId,
          standards: f.standards,
          text: f.text.trim(),
          target: num(f.target)!,
          unitOfMeasure: f.unitOfMeasure.trim(),
          baseline: num(f.baseline),
          direction: f.direction,
          readingRule: READING_CHOICES[f.reading!].rule as RecurrenceRule,
          riskItemIds: f.riskItemIds,
          ownerId: f.ownerId!,
          dueOn: f.dueOn!,
        },
      );
      if (result.ok) newId = result.data.id;
      return result;
    }, 'The objective is added.');
    if (ok && newId) router.push(`/c/${clientId}/iso/objectives/${newId}`);
  };

  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Add objective"
      submitLabel="Add objective"
      pending={pending}
      error={error}
      disabledReason={objectiveMissing(f, false)}
      onSubmit={() => void submit()}
    >
      {systems.length > 1 ? (
        <Select
          label="Management system"
          options={systems.map((s) => ({ value: s.id, label: s.name }))}
          value={f.managementSystemId}
          onValueChange={(v) => set({ managementSystemId: v, standards: [], riskItemIds: [] })}
        />
      ) : null}
      <ObjectiveFields f={f} set={set} system={system} keptRule={null} />
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
        label="Due on"
        value={f.dueOn}
        onValueChange={(dueOn) => set({ dueOn })}
        min={today}
        today={today}
      />
    </FormDrawer>
  );
}

export function EditObjective({
  clientId,
  objective: o,
  system,
  people,
  canReassign,
  today,
  onClose,
}: {
  clientId: string;
  objective: ObjectiveView;
  system: ObjectiveSystemOption | undefined;
  people: PersonOption[];
  canReassign: boolean;
  today: string;
  onClose: () => void;
}) {
  const [f, setF] = useState<Fields>({
    managementSystemId: o.managementSystemId,
    standards: o.standards,
    text: o.text,
    target: String(o.target),
    unitOfMeasure: o.unitOfMeasure,
    baseline: o.baseline === null ? '' : String(o.baseline),
    direction: o.direction,
    reading: readingChoice(o.readingRule),
    riskItemIds: o.riskItemIds,
    ownerId: o.ownerId,
    dueOn: o.dueOn,
  });
  const [reason, setReason] = useState('');
  const set = (patch: Partial<Fields>) => setF((x) => ({ ...x, ...patch }));
  const { pending, error, save } = useSave();
  const kept = readingChoice(o.readingRule) === null ? o.readingRule : null;

  const body: Record<string, unknown> = { version: o.version };
  const same = (a: readonly string[], b: readonly string[]) =>
    [...a].sort().join() === [...b].sort().join();
  if (!same(f.standards, o.standards)) body.standards = f.standards;
  if (f.text.trim() !== o.text) body.text = f.text.trim();
  if (num(f.target) !== o.target) body.target = num(f.target);
  if (f.unitOfMeasure.trim() !== o.unitOfMeasure) body.unitOfMeasure = f.unitOfMeasure.trim();
  if (num(f.baseline) !== o.baseline) body.baseline = num(f.baseline);
  if (f.direction !== o.direction) body.direction = f.direction;
  if (f.reading && readingChoice(o.readingRule) !== f.reading) {
    body.readingRule = READING_CHOICES[f.reading].rule;
  }
  if (!same(f.riskItemIds, o.riskItemIds)) body.riskItemIds = f.riskItemIds;
  if (f.ownerId !== o.ownerId) body.ownerId = f.ownerId;
  if (f.dueOn !== o.dueOn) body.dueOn = f.dueOn;
  const needsReason = 'ownerId' in body || 'dueOn' in body;
  if (needsReason) body.reason = reason.trim();
  const changed = Object.keys(body).some((k) => k !== 'version' && k !== 'reason');
  const missing = !changed
    ? 'Nothing has changed'
    : (objectiveMissing(f, kept !== null) ??
      (needsReason && reason.trim() === '' ? 'Say why the owner or due date changes' : undefined));

  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Edit objective"
      submitLabel="Save objective"
      pending={pending}
      error={error}
      disabledReason={missing}
      onSubmit={() =>
        void save(
          () => isoWrite(clientId, 'updateIsoObjective', { id: o.id }, body as never),
          'The objective is saved.',
        ).then((ok) => ok && onClose())
      }
    >
      <ObjectiveFields f={f} set={set} system={system} keptRule={kept} />
      {canReassign ? (
        <PersonSelect
          label="Owner"
          people={people}
          value={f.ownerId}
          onChange={(ownerId) => set({ ownerId })}
        />
      ) : null}
      <DateInput
        label="Due on"
        value={f.dueOn}
        onValueChange={(dueOn) => set({ dueOn })}
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
