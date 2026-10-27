'use client';
// RAISE by hand (model §4.1): a nonconformity, an incident or a near miss, for one of the client's systems. Any source but
// the two audit sources, which only an audit finding raises (contracts `RaisableNcSource`); optionally the register
// activity or risk item it came from. The person raising it is its reporter and today its reported day (the API sets
// both). An incident or near miss also takes its incident fields and a unit.
import {
  NcSeverity,
  RaisableNcSource,
  type IsoStandardCode,
  type NcRaiseBody,
  type NcSource,
} from '@canopy/contracts';

type Raisable = Exclude<NcSource, 'INTERNAL_AUDIT' | 'EXTERNAL_AUDIT'>;
import { Checkbox, DateInput, RadioGroup, Select, Textarea } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { isoWrite } from '../_lib/actions';
import { instantAt, type PersonOption } from '../_lib/people';
import { WORDS } from '../_lib/words';
import { ClausePicker } from '../_components/ClausePicker';
import { FormDrawer, PersonSelect, useSave } from '../_components/controls';
import { InstancePicker, type InstanceChoice } from '../_components/InstancePicker';
import {
  IncidentFields,
  incidentMissing,
  lostDaysNumber,
  newIncident,
  PERSONAL_DATA,
  type IncidentDraft,
} from './IncidentFields';
import type { NcSystemOption } from './nc-model';

export type NcRaiseProps = {
  clientId: string;
  systems: NcSystemOption[];
  units: { id: string; name: string }[];
  people: PersonOption[];
  today: string;
  timeZone: string;
  /** Raised from a risk item's page: its system, item and unit. */
  preset?: { managementSystemId: string; raisedFromRiskItemId: string; unitId: string | null };
};

type Fields = {
  managementSystemId: string;
  source: Raisable | null;
  severity: NcSeverity | null;
  standards: IsoStandardCode[];
  clauseIds: string[];
  unitId: string | null;
  description: string;
  containment: string;
  correction: string;
  sourceInstance: InstanceChoice | null;
  raisedFromRiskItemId: string | null;
  ownerId: string | null;
  approverId: string | null;
  dueOn: string | null;
  incident: IncidentDraft;
};

const incidentSource = (s: Raisable | null) => s === 'INCIDENT' || s === 'NEAR_MISS';

/** What still stops the record being raised, in words. */
export function raiseMissing(f: Fields, timeZone: string): string | undefined {
  if (!f.source) return 'Choose where it came from';
  if (!f.severity) return 'Choose the severity';
  if (f.standards.length === 0) return 'Choose at least one standard';
  if (f.description.trim() === '') return 'Describe what happened or what was found';
  if (incidentSource(f.source)) {
    if (!f.unitId) return 'Choose the unit it happened at';
    const incident = incidentMissing(f.incident, timeZone);
    if (incident) return incident;
  }
  if (!f.ownerId) return 'Choose the owner';
  if (!f.approverId) return 'Choose the approver';
  if (f.ownerId === f.approverId) return 'The approver is someone other than the owner';
  if (!f.dueOn) return 'Give the date it is due';
  return undefined;
}

/** The RAISE body from the form. */
export function raiseBody(f: Fields, timeZone: string): NcRaiseBody {
  const d = f.incident;
  return {
    managementSystemId: f.managementSystemId,
    source: f.source!,
    sourceInstanceId: f.sourceInstance?.id ?? null,
    raisedFromRiskItemId: f.raisedFromRiskItemId,
    severity: f.severity!,
    standards: f.standards,
    clauseIds: f.clauseIds,
    unitId: f.unitId,
    description: f.description.trim(),
    containment: f.containment.trim() || null,
    correction: f.correction.trim() || null,
    ownerId: f.ownerId!,
    approverId: f.approverId!,
    dueOn: f.dueOn!,
    incident: incidentSource(f.source)
      ? {
          occurredAt: instantAt(d.date!, d.time, timeZone)!,
          location: d.location.trim(),
          type: f.source === 'NEAR_MISS' ? 'NEAR_MISS' : d.type!,
          outcome: f.source === 'NEAR_MISS' ? 'NONE' : d.outcome,
          personCategory: d.personCategory,
          lostDays: d.outcome === 'LOST_TIME' ? lostDaysNumber(d.lostDays) : null,
          reportable: d.reportable,
          statutoryInstanceId: d.reportable ? (d.statutory?.id ?? null) : null,
        }
      : null,
  };
}

export function RaiseNc({
  clientId,
  systems,
  units,
  people,
  today,
  timeZone,
  preset,
  onClose,
}: NcRaiseProps & { onClose: () => void }) {
  const router = useRouter();
  const first = systems.find((s) => s.id === preset?.managementSystemId) ?? systems[0];
  const [f, setF] = useState<Fields>({
    managementSystemId: first?.id ?? '',
    source: null,
    severity: null,
    standards: first?.standards.length === 1 ? [first.standards[0]!.code] : [],
    clauseIds: [],
    unitId: preset?.unitId ?? (first?.unitIds.length === 1 ? first.unitIds[0]! : null),
    description: '',
    containment: '',
    correction: '',
    sourceInstance: null,
    raisedFromRiskItemId: preset?.raisedFromRiskItemId ?? null,
    ownerId: null,
    approverId: null,
    dueOn: null,
    incident: newIncident(false),
  });
  const set = (patch: Partial<Fields>) => setF((x) => ({ ...x, ...patch }));
  const system = systems.find((s) => s.id === f.managementSystemId);
  const systemUnits = units.filter((u) => !system?.unitIds.length || system.unitIds.includes(u.id));
  const { pending, error, save } = useSave();
  const raised = useRef<string | null>(null);
  const NONE = '__none__';

  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Raise a nonconformity"
      submitLabel="Raise"
      pending={pending}
      error={error}
      disabledReason={raiseMissing(f, timeZone)}
      onSubmit={() =>
        void save(async () => {
          const result = await isoWrite(
            clientId,
            'raiseIsoNonconformity',
            {},
            raiseBody(f, timeZone),
          );
          if (result.ok) raised.current = result.data.id;
          return result;
        }, 'It is raised.').then((ok) => {
          if (!ok) return;
          onClose();
          if (raised.current) router.push(`/c/${clientId}/iso/nonconformities/${raised.current}`);
        })
      }
    >
      {systems.length > 1 ? (
        <Select
          label="Management system"
          options={systems.map((s) => ({ value: s.id, label: s.name }))}
          value={f.managementSystemId}
          onValueChange={(v) => {
            const next = systems.find((s) => s.id === v);
            set({
              managementSystemId: v,
              standards: next?.standards.length === 1 ? [next.standards[0]!.code] : [],
              clauseIds: [],
              unitId: next?.unitIds.length === 1 ? next.unitIds[0]! : null,
              raisedFromRiskItemId: null,
            });
          }}
        />
      ) : null}
      <Select
        label="Where it came from"
        helper="Audit findings raise their own nonconformities."
        options={RaisableNcSource.options.map((s) => ({ value: s, label: WORDS.NcSource[s] }))}
        value={f.source ?? undefined}
        onValueChange={(v) => {
          const source = v as Raisable;
          set({ source, incident: newIncident(source === 'NEAR_MISS') });
        }}
      />
      <RadioGroup
        label="Severity"
        orientation="horizontal"
        options={NcSeverity.options.map((s) => ({ value: s, label: WORDS.NcSeverity[s] }))}
        value={f.severity ?? ''}
        onValueChange={(v) => set({ severity: v as NcSeverity })}
      />
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
      <ClausePicker
        label="Clauses (optional)"
        options={system?.clauses ?? []}
        value={f.clauseIds}
        onChange={(clauseIds) => set({ clauseIds })}
        max={20}
      />
      <Select
        label={incidentSource(f.source) ? 'Unit' : 'Unit (optional)'}
        options={[
          ...(incidentSource(f.source) ? [] : [{ value: NONE, label: 'No one unit' }]),
          ...systemUnits.map((u) => ({ value: u.id, label: u.name })),
        ]}
        value={f.unitId ?? (incidentSource(f.source) ? undefined : NONE)}
        onValueChange={(v) => set({ unitId: v === NONE ? null : v })}
      />
      <Textarea
        label="What happened or was found"
        helper={PERSONAL_DATA}
        value={f.description}
        maxLength={4000}
        onChange={(e) => set({ description: e.target.value })}
      />
      {incidentSource(f.source) ? (
        <IncidentFields
          clientId={clientId}
          draft={f.incident}
          set={(patch) => setF((x) => ({ ...x, incident: { ...x.incident, ...patch } }))}
          nearMiss={f.source === 'NEAR_MISS'}
          people={people}
          unitId={f.unitId}
          today={today}
        />
      ) : null}
      <InstancePicker
        clientId={clientId}
        label="Register activity that raised it (optional)"
        helper="For example a missed filing, a failed drill or an out-of-calibration check."
        value={f.sourceInstance}
        onChange={(sourceInstance) => set({ sourceInstance })}
      />
      {system && system.risks.length > 0 ? (
        <Select
          label="Risk item it came from (optional)"
          options={[
            { value: NONE, label: 'None' },
            ...system.risks.map((r) => ({ value: r.id, label: r.label })),
          ]}
          value={f.raisedFromRiskItemId ?? NONE}
          onValueChange={(v) => set({ raisedFromRiskItemId: v === NONE ? null : v })}
        />
      ) : null}
      <Textarea
        label="Containment so far (optional)"
        value={f.containment}
        maxLength={4000}
        onChange={(e) => set({ containment: e.target.value })}
      />
      <Textarea
        label="Correction so far (optional)"
        value={f.correction}
        maxLength={4000}
        onChange={(e) => set({ correction: e.target.value })}
      />
      <PersonSelect
        label="Owner"
        helper="Investigates it and plans the corrective action."
        people={people}
        value={f.ownerId}
        onChange={(ownerId) => set({ ownerId })}
      />
      <PersonSelect
        label="Approver"
        helper="Verifies the action worked. Someone other than the owner."
        people={people}
        value={f.approverId}
        onChange={(approverId) => set({ approverId })}
      />
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
