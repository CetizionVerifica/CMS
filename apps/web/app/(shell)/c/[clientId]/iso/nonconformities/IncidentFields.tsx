'use client';
// The incident fields of an INCIDENT or NEAR_MISS nonconformity (model §3.11), for raising one and for its owner's edits.
// They hold no injured person's name, health or medical detail: the form says so, and such detail goes only in the
// record's restricted files. The outcome changes only on the reassign form (model §3.10), so an edit shows it as read.
import {
  IncidentOutcome,
  IncidentPersonCategory,
  IncidentType,
  type Incident,
} from '@canopy/contracts';
import { Checkbox, DateInput, Input, Select } from '@canopy/ui';

import { clientDate, clientTime, instantAt, type PersonOption } from '../_lib/people';
import { word, WORDS } from '../_lib/words';
import { InstancePicker, type InstanceChoice } from '../_components/InstancePicker';

export type IncidentDraft = {
  date: string | null;
  time: string;
  location: string;
  type: IncidentType | null;
  outcome: IncidentOutcome;
  lostDays: string;
  personCategory: IncidentPersonCategory | null;
  reportable: boolean;
  statutory: InstanceChoice | null;
  investigatorIds: string[];
  workerParticipation: boolean;
};

export const PERSONAL_DATA =
  'Write no injured person’s name, health or medical details here: the record’s history keeps every word. Add them only as files, which only the people who may open incidents can read.';

export const REPORTABLE_NOTICE =
  'A statutory accident notice is due. Link its register instance below once it is there.';

export function newIncident(nearMiss: boolean): IncidentDraft {
  return {
    date: null,
    time: '',
    location: '',
    type: nearMiss ? 'NEAR_MISS' : null,
    outcome: 'NONE',
    lostDays: '',
    personCategory: null,
    reportable: false,
    statutory: null,
    investigatorIds: [],
    workerParticipation: false,
  };
}

/** A stored incident as the form's draft, its time in the client's zone. */
export function incidentDraft(
  i: Incident,
  timeZone: string,
  statutory: InstanceChoice | null,
): IncidentDraft {
  return {
    date: clientDate(i.occurredAt, timeZone),
    time: clientTime(i.occurredAt, timeZone),
    location: i.location,
    type: i.type,
    outcome: i.outcome,
    lostDays: i.lostDays === null ? '' : String(i.lostDays),
    personCategory: i.personCategory,
    reportable: i.reportable,
    statutory,
    investigatorIds: [...i.investigatorIds],
    workerParticipation: i.workerParticipation,
  };
}

export const lostDaysNumber = (s: string): number | null =>
  /^\d{1,5}$/.test(s.trim()) && Number(s) >= 1 && Number(s) <= 10_000 ? Number(s) : null;

/** What still stops the incident fields being saved, in words. */
export function incidentMissing(d: IncidentDraft, timeZone: string): string | undefined {
  if (!d.date || instantAt(d.date, d.time, timeZone) === null)
    return 'Give the date and time (HH:MM) it happened';
  if (d.location.trim() === '') return 'Say where it happened';
  if (!d.type) return 'Choose the kind of incident';
  if (d.outcome === 'LOST_TIME' && lostDaysNumber(d.lostDays) === null)
    return 'Give the days lost, from 1';
  return undefined;
}

export function IncidentFields({
  clientId,
  draft,
  set,
  nearMiss,
  people,
  unitId,
  today,
  editing,
}: {
  clientId: string;
  draft: IncidentDraft;
  set: (patch: Partial<IncidentDraft>) => void;
  nearMiss: boolean;
  people: readonly PersonOption[];
  unitId: string | null;
  today: string;
  /** An edit: the type and outcome show as read; days lost change only while the outcome is lost time. */
  editing?: boolean;
}) {
  const NONE = '__none__';
  return (
    <fieldset className="flex flex-col gap-4 rounded-card border border-line p-3">
      <legend className="px-1 text-meta font-semibold text-ink">
        {nearMiss ? 'The near miss' : 'The incident'}
      </legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <DateInput
          label="Date it happened"
          value={draft.date}
          onValueChange={(v) => set({ date: v })}
          max={today}
          today={today}
        />
        <Input
          label="Time (HH:MM)"
          inputMode="numeric"
          placeholder="14:30"
          maxLength={5}
          value={draft.time}
          onChange={(e) => set({ time: e.target.value.trim() })}
        />
      </div>
      <Input
        label="Where it happened"
        value={draft.location}
        maxLength={300}
        onChange={(e) => set({ location: e.target.value })}
      />
      {editing || nearMiss ? (
        <p className="text-body text-ink">
          <span className="text-muted">Kind: </span>
          {draft.type ? word('IncidentType', draft.type) : 'Not given'}
          {nearMiss ? null : (
            <>
              <span className="text-muted"> · Outcome: </span>
              {word('IncidentOutcome', draft.outcome)}
            </>
          )}
        </p>
      ) : (
        <>
          <Select
            label="Kind of incident"
            options={IncidentType.options
              .filter((t) => t !== 'NEAR_MISS')
              .map((t) => ({ value: t, label: WORDS.IncidentType[t] }))}
            value={draft.type ?? undefined}
            onValueChange={(v) => set({ type: v as IncidentType })}
          />
          <Select
            label="Outcome"
            options={IncidentOutcome.options.map((o) => ({
              value: o,
              label: WORDS.IncidentOutcome[o],
            }))}
            value={draft.outcome}
            onValueChange={(v) => set({ outcome: v as IncidentOutcome, lostDays: '' })}
          />
        </>
      )}
      {draft.outcome === 'LOST_TIME' ? (
        <Input
          label="Days lost"
          inputMode="numeric"
          value={draft.lostDays}
          maxLength={5}
          onChange={(e) => set({ lostDays: e.target.value })}
        />
      ) : null}
      <Select
        label="Who was involved (optional)"
        options={[
          { value: NONE, label: 'Not given' },
          ...IncidentPersonCategory.options.map((c) => ({
            value: c,
            label: WORDS.IncidentPersonCategory[c],
          })),
        ]}
        value={draft.personCategory ?? NONE}
        onValueChange={(v) =>
          set({ personCategory: v === NONE ? null : (v as IncidentPersonCategory) })
        }
      />
      <Checkbox
        label="Reportable to the authorities"
        checked={draft.reportable}
        onCheckedChange={(c) => set({ reportable: c === true })}
      />
      {draft.reportable ? (
        <>
          <p className="rounded-card bg-warn-soft p-3 text-body text-warn-ink">
            {REPORTABLE_NOTICE}
          </p>
          <InstancePicker
            clientId={clientId}
            label="Statutory notice instance (optional)"
            helper="A statutory activity of the incident's unit, such as the accident report to the inspector."
            value={draft.statutory}
            onChange={(statutory) => set({ statutory })}
            unitId={unitId}
            statutoryOnly
          />
        </>
      ) : null}
      {editing ? (
        <>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-meta text-ink">Investigated by</legend>
            {people.map((p) => (
              <Checkbox
                key={p.id}
                label={p.name}
                checked={draft.investigatorIds.includes(p.id)}
                onCheckedChange={(c) =>
                  set({
                    investigatorIds:
                      c === true
                        ? [...draft.investigatorIds, p.id]
                        : draft.investigatorIds.filter((x) => x !== p.id),
                  })
                }
              />
            ))}
          </fieldset>
          <Checkbox
            label="A worker who is not a manager took part in the investigation"
            checked={draft.workerParticipation}
            onCheckedChange={(c) => set({ workerParticipation: c === true })}
          />
        </>
      ) : null}
    </fieldset>
  );
}
