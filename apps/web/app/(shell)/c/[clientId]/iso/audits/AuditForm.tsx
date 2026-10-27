'use client';
// Planning an internal audit and changing one (model §3.7): its programme, dates, clauses, units and team. Someone who
// audits their own work needs an independence note (9.2.2); moving the dates or changing the lead auditor needs a
// reason. Audit people are the client's people with the owner role or above; the API refuses anyone else.
import { selfAuditors, type InternalAuditView } from '@canopy/contracts';
import { Checkbox, DateInput, Input, Select, Textarea } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { isoWrite } from '../_lib/actions';
import { namesOf, type PersonOption } from '../_lib/people';
import { ClausePicker, type ClauseOption } from '../_components/ClausePicker';
import { FormDrawer, PersonSelect, useSave } from '../_components/controls';

export type AuditPlanProps = {
  clientId: string;
  programmes: { id: string; label: string; managementSystemId: string }[];
  systems: { id: string; unitIds: string[]; clauses: ClauseOption[] }[];
  units: { id: string; name: string }[];
  people: PersonOption[];
  today: string;
};

type Fields = {
  programmeId: string;
  title: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  clauseIds: string[];
  unitIds: string[];
  leadAuditorId: string | null;
  auditorIds: string[];
  auditeeIds: string[];
  reportedToIds: string[];
  independenceNote: string;
  reason: string;
};

function fields(audit: InternalAuditView | undefined, programmeId: string): Fields {
  return {
    programmeId: audit?.programmeId ?? programmeId,
    title: audit?.title ?? '',
    plannedStart: audit?.plannedStart ?? null,
    plannedEnd: audit?.plannedEnd ?? null,
    clauseIds: audit?.clauseIds ?? [],
    unitIds: audit?.unitIds ?? [],
    leadAuditorId: audit?.leadAuditorId ?? null,
    auditorIds: audit?.auditorIds ?? [],
    auditeeIds: audit?.auditeeIds ?? [],
    reportedToIds: audit?.reportedToIds ?? [],
    independenceNote: audit?.independenceNote ?? '',
    reason: '',
  };
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The PATCH body: the version and only what changed, with the reason when the dates or the lead auditor move. */
export function auditPatch(f: Fields, audit: InternalAuditView): Record<string, unknown> {
  const body: Record<string, unknown> = { version: audit.version };
  const title = f.title.trim();
  if (title !== audit.title) body.title = title;
  if (f.plannedStart !== audit.plannedStart) body.plannedStart = f.plannedStart;
  if (f.plannedEnd !== audit.plannedEnd) body.plannedEnd = f.plannedEnd;
  if (f.leadAuditorId !== audit.leadAuditorId) body.leadAuditorId = f.leadAuditorId;
  for (const key of [
    'clauseIds',
    'unitIds',
    'auditorIds',
    'auditeeIds',
    'reportedToIds',
  ] as const) {
    if (!same(f[key], audit[key])) body[key] = f[key];
  }
  const note = f.independenceNote.trim() || null;
  if (note !== audit.independenceNote) body.independenceNote = note;
  if ('plannedStart' in body || 'plannedEnd' in body || 'leadAuditorId' in body) {
    body.reason = f.reason.trim();
  }
  return body;
}

export function auditMissing(f: Fields, audit?: InternalAuditView): string | undefined {
  if (!f.programmeId) return 'Choose the programme';
  if (f.title.trim() === '') return 'Give the audit a title';
  if (!f.plannedStart || !f.plannedEnd) return 'Give the planned dates';
  if (f.plannedEnd < f.plannedStart) return 'The audit ends after it starts';
  if (!f.leadAuditorId) return 'Choose the lead auditor';
  const team = { ...f, leadAuditorId: f.leadAuditorId };
  if (selfAuditors(team).length > 0 && f.independenceNote.trim() === '') {
    return 'Say how independence is kept';
  }
  if (audit) {
    const body = auditPatch(f, audit);
    if (Object.keys(body).every((k) => k === 'version' || k === 'reason')) {
      return 'Nothing has changed';
    }
    if ('reason' in body && f.reason.trim() === '') {
      return 'Say why the dates or the lead auditor change';
    }
  }
  return undefined;
}

export function AuditForm(
  props: AuditPlanProps & { audit?: InternalAuditView; onClose: () => void },
) {
  const { clientId, programmes, systems, units, people, today, audit, onClose } = props;
  const router = useRouter();
  const [f, setF] = useState(() => fields(audit, programmes[0]?.id ?? ''));
  const set = (patch: Partial<Fields>) => setF((x) => ({ ...x, ...patch }));
  const { pending, error, save } = useSave();
  const planned = useRef<string | null>(null);
  const programme = programmes.find((p) => p.id === f.programmeId);
  const system = systems.find((s) => s.id === programme?.managementSystemId);
  const systemUnits = units.filter((u) => !system?.unitIds.length || system.unitIds.includes(u.id));
  const others = people.filter((p) => p.id !== f.leadAuditorId);
  const asOptions = (list: readonly PersonOption[]) =>
    list.map((p) => ({ id: p.id, label: p.name }));
  const self = f.leadAuditorId ? selfAuditors({ ...f, leadAuditorId: f.leadAuditorId }) : [];
  const moves =
    audit !== undefined &&
    (f.plannedStart !== audit.plannedStart ||
      f.plannedEnd !== audit.plannedEnd ||
      f.leadAuditorId !== audit.leadAuditorId);
  const peoplePicker = {
    placeholder: 'Type a name',
    emptyText: 'No one matches',
    unknown: 'Someone not listed',
  };

  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={audit ? 'Edit audit' : 'Plan an internal audit'}
      submitLabel={audit ? 'Save audit' : 'Plan audit'}
      pending={pending}
      error={error}
      disabledReason={auditMissing(f, audit)}
      onSubmit={() =>
        void save(
          async () => {
            if (audit) {
              return isoWrite(
                clientId,
                'updateIsoInternalAudit',
                { id: audit.id },
                auditPatch(f, audit) as never,
              );
            }
            const result = await isoWrite(
              clientId,
              'createIsoInternalAudit',
              {},
              {
                programmeId: f.programmeId,
                title: f.title.trim(),
                plannedStart: f.plannedStart!,
                plannedEnd: f.plannedEnd!,
                clauseIds: f.clauseIds,
                unitIds: f.unitIds,
                leadAuditorId: f.leadAuditorId!,
                auditorIds: f.auditorIds,
                auditeeIds: f.auditeeIds,
                reportedToIds: f.reportedToIds,
                independenceNote: f.independenceNote.trim() || null,
              },
            );
            if (result.ok) planned.current = result.data.id;
            return result;
          },
          audit ? 'The audit is saved.' : 'The audit is planned.',
        ).then((ok) => {
          if (!ok) return;
          onClose();
          if (planned.current) router.push(`/c/${clientId}/iso/audits/${planned.current}`);
        })
      }
    >
      {!audit && programmes.length > 1 ? (
        <Select
          label="Programme"
          options={programmes.map((p) => ({ value: p.id, label: p.label }))}
          value={f.programmeId}
          onValueChange={(v) => set({ programmeId: v, clauseIds: [], unitIds: [] })}
        />
      ) : null}
      <Input
        label="Title"
        value={f.title}
        maxLength={300}
        onChange={(e) => set({ title: e.target.value })}
      />
      <DateInput
        label="Starts on"
        value={f.plannedStart}
        onValueChange={(v) => set({ plannedStart: v })}
        today={today}
      />
      <DateInput
        label="Ends on"
        value={f.plannedEnd}
        onValueChange={(v) => set({ plannedEnd: v })}
        min={f.plannedStart ?? undefined}
        today={today}
      />
      <ClausePicker
        label="Clauses"
        helper="The checklist needs a result for each before the audit is reported."
        options={system?.clauses ?? []}
        value={f.clauseIds}
        onChange={(clauseIds) => set({ clauseIds })}
        max={300}
      />
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-meta text-ink">Units</legend>
        <p className="text-meta text-muted">
          None ticked means every unit of the system, but only units named here count as covered.
        </p>
        {systemUnits.map((u) => (
          <Checkbox
            key={u.id}
            label={u.name}
            checked={f.unitIds.includes(u.id)}
            onCheckedChange={(c) =>
              set({
                unitIds: c === true ? [...f.unitIds, u.id] : f.unitIds.filter((x) => x !== u.id),
              })
            }
          />
        ))}
      </fieldset>
      <PersonSelect
        label="Lead auditor"
        people={people}
        value={f.leadAuditorId}
        onChange={(id) =>
          set({ leadAuditorId: id, auditorIds: f.auditorIds.filter((x) => x !== id) })
        }
      />
      <ClausePicker
        label="Other auditors (optional)"
        options={asOptions(others)}
        value={f.auditorIds}
        onChange={(auditorIds) => set({ auditorIds })}
        max={20}
        {...peoplePicker}
      />
      <ClausePicker
        label="Auditees"
        helper="The people whose work is audited."
        options={asOptions(people)}
        value={f.auditeeIds}
        onChange={(auditeeIds) => set({ auditeeIds })}
        max={100}
        {...peoplePicker}
      />
      <ClausePicker
        label="Reported to (optional until the report)"
        options={asOptions(people)}
        value={f.reportedToIds}
        onChange={(reportedToIds) => set({ reportedToIds })}
        max={20}
        {...peoplePicker}
      />
      {self.length > 0 || f.independenceNote ? (
        <Textarea
          label="Independence note"
          helper={
            self.length > 0
              ? `${namesOf(people, self)} would audit their own work. Say how independence is kept.`
              : undefined
          }
          value={f.independenceNote}
          maxLength={2000}
          onChange={(e) => set({ independenceNote: e.target.value })}
        />
      ) : null}
      {moves ? (
        <Textarea
          label="Why the dates or the lead auditor change"
          value={f.reason}
          maxLength={2000}
          onChange={(e) => set({ reason: e.target.value })}
        />
      ) : null}
    </FormDrawer>
  );
}
