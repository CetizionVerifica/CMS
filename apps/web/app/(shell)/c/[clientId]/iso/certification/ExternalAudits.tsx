'use client';
// Certification body visits (model §3.9, §4.5): planned, held, responded to, closed or cancelled. A visit opens in a
// drawer named in the URL (`?audit=`), with its steps (exactly its `allowedActions`), findings and files.
import type {
  AuditFinding,
  AuditRecommendation,
  ExternalAuditType,
  ExternalAuditView,
  IsoStandard,
  ManagementSystem,
} from '@canopy/contracts';
import {
  Button,
  Checkbox,
  DateInput,
  Drawer,
  DrawerSection,
  formatDate,
  Input,
  Select,
  Textarea,
  type DataTableProps,
} from '@canopy/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { isoRead, isoWrite } from '../_lib/actions';
import { nameOf, type PersonOption } from '../_lib/people';
import { word, WORDS } from '../_lib/words';
import { ClausePicker, type ClauseOption } from '../_components/ClausePicker';
import { FilesPanel } from '../_components/FilesPanel';
import { FormAlert, FormDrawer, PersonSelect, StepButton, useSave } from '../_components/controls';
import { withOpen } from '../_components/IsoFilterBar';
import { StatePill } from '../_components/IsoStates';
import { IsoTable } from '../_components/IsoTable';
import { auditDates, auditOpen, auditTitle, auditsByDate } from './certification-model';

type UnitOption = { id: string; name: string };
type SystemOption = Pick<ManagementSystem, 'id' | 'name' | 'standardIds' | 'unitIds'>;

export type ExternalAuditsProps = {
  clientId: string;
  audits: ExternalAuditView[];
  standards: IsoStandard[];
  systems: SystemOption[];
  units: UnitOption[];
  people: PersonOption[];
  /** Clause choices per system, for findings. */
  clauseOptions: Record<string, ClauseOption[]>;
  openAuditId: string | null;
  canManage: boolean;
  today: string;
};

type Row = { id: string; title: string; audit: ExternalAuditView };

const columns: DataTableProps<Row>['columns'] = [
  {
    id: 'title',
    header: 'Visit',
    accessorFn: (r) => ({ title: r.title, sub: r.audit.body }) as never,
    meta: { type: 'title', locked: true },
    size: 360,
  },
  {
    id: 'dates',
    header: 'Dates',
    accessorFn: (r) => auditDates(r.audit) as never,
    meta: { type: 'text' },
    size: 220,
  },
  {
    id: 'state',
    header: 'State',
    accessorFn: (r) => r.audit.state as never,
    cell: (ctx) => <StatePill of="ExternalAuditState" value={ctx.row.original.audit.state} />,
    size: 150,
  },
  {
    id: 'recommendation',
    header: 'Recommendation',
    accessorFn: (r) =>
      (r.audit.recommendation ? word('AuditRecommendation', r.audit.recommendation) : '') as never,
    meta: { type: 'text' },
    size: 220,
  },
];

export function ExternalAudits(props: ExternalAuditsProps) {
  const { audits, standards, openAuditId, canManage } = props;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [adding, setAdding] = useState(false);
  const hrefFor = (id?: string) =>
    withOpen(pathname, new URLSearchParams(params.toString()), 'audit', id);
  const rows = auditsByDate(audits).map((a) => ({
    id: a.id,
    title: auditTitle(a, standards),
    audit: a,
  }));
  const open = audits.find((a) => a.id === openAuditId) ?? null;

  return (
    <section aria-labelledby="external-audits" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="external-audits" className="text-section text-ink">
          External audits
        </h2>
        {canManage ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            Plan external audit
          </Button>
        ) : null}
      </div>
      <IsoTable
        label="External audits"
        columns={columns}
        data={rows}
        rowId={(r) => r.id}
        rowLabel={(r) => `${r.title}, ${auditDates(r.audit)}`}
        rowHref={(r) => hrefFor(r.id)}
        countNoun={{ one: 'visit', other: 'visits' }}
        empty={
          <p className="p-6 text-body text-muted">
            No certification body visit yet. Plan the first one when its dates are agreed.
          </p>
        }
      />
      {adding ? <NewAudit {...props} onClose={() => setAdding(false)} /> : null}
      {open ? (
        <AuditDrawer
          key={`${open.id}-${open.version}`}
          {...props}
          audit={open}
          onClose={() => router.push(hrefFor(), { scroll: false })}
        />
      ) : null}
    </section>
  );
}

function StandardBoxes({
  standards,
  allowed,
  value,
  onChange,
}: {
  standards: IsoStandard[];
  allowed: string[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-meta text-ink">Standards</legend>
      {allowed.map((id) => (
        <Checkbox
          key={id}
          label={standards.find((s) => s.id === id)?.title ?? 'Unknown standard'}
          checked={value.includes(id)}
          onCheckedChange={(checked) =>
            onChange(checked === true ? [...value, id] : value.filter((v) => v !== id))
          }
        />
      ))}
    </fieldset>
  );
}

const typeOptions = Object.entries(WORDS.ExternalAuditType).map(([value, label]) => ({
  value,
  label,
}));
const NO_RECOMMENDATION = '__none__';
const recommendationOptions = [
  { value: NO_RECOMMENDATION, label: 'Not given yet' },
  ...Object.entries(WORDS.AuditRecommendation).map(([value, label]) => ({ value, label })),
];

function NewAudit({
  clientId,
  standards,
  systems,
  today,
  onClose,
}: ExternalAuditsProps & { onClose: () => void }) {
  const [systemId, setSystemId] = useState(systems[0]?.id ?? '');
  const system = systems.find((s) => s.id === systemId);
  const [standardIds, setStandardIds] = useState<string[]>(system?.standardIds ?? []);
  const [type, setType] = useState<string>('SURVEILLANCE_1');
  const [body, setBody] = useState('');
  const [lead, setLead] = useState('');
  const [startOn, setStartOn] = useState<string | null>(null);
  const [endOn, setEndOn] = useState<string | null>(null);
  const [responseDueOn, setResponseDueOn] = useState<string | null>(null);
  const { pending, error, save } = useSave();
  const missing =
    standardIds.length === 0
      ? 'Choose at least one standard'
      : body.trim() === ''
        ? 'Name the certification body'
        : !startOn || !endOn
          ? 'Set the start and end dates'
          : endOn < startOn
            ? 'The audit ends after it starts'
            : undefined;
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Plan external audit"
      submitLabel="Plan audit"
      pending={pending}
      error={error}
      disabledReason={missing}
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'createIsoExternalAudit',
              {},
              {
                managementSystemId: systemId,
                standardIds,
                type: type as ExternalAuditType,
                body: body.trim(),
                leadAuditorName: lead.trim() || null,
                startOn: startOn!,
                endOn: endOn!,
                responseDueOn,
              },
            ),
          'The external audit is planned.',
        ).then((ok) => ok && onClose())
      }
    >
      {systems.length > 1 ? (
        <Select
          label="Management system"
          options={systems.map((s) => ({ value: s.id, label: s.name }))}
          value={systemId}
          onValueChange={(v) => {
            setSystemId(v);
            setStandardIds(systems.find((s) => s.id === v)?.standardIds ?? []);
          }}
        />
      ) : null}
      <StandardBoxes
        standards={standards}
        allowed={system?.standardIds ?? []}
        value={standardIds}
        onChange={setStandardIds}
      />
      <Select label="Type" options={typeOptions} value={type} onValueChange={setType} />
      <Input
        label="Certification body"
        value={body}
        maxLength={200}
        onChange={(e) => setBody(e.target.value)}
      />
      <Input
        label="Lead auditor"
        value={lead}
        maxLength={200}
        onChange={(e) => setLead(e.target.value)}
      />
      <DateInput label="Starts on" value={startOn} onValueChange={setStartOn} today={today} />
      <DateInput
        label="Ends on"
        value={endOn}
        onValueChange={setEndOn}
        min={startOn ?? undefined}
        today={today}
      />
      <DateInput
        label="Response due"
        helper="The body's deadline for the corrective-action response, if it set one."
        value={responseDueOn}
        onValueChange={setResponseDueOn}
        today={today}
      />
    </FormDrawer>
  );
}

function AuditDrawer(
  props: ExternalAuditsProps & { audit: ExternalAuditView; onClose: () => void },
) {
  const { clientId, audit, standards, canManage, onClose } = props;
  const ids = { id: audit.id };
  const can = (a: ExternalAuditView['allowedActions'][number]) => audit.allowedActions.includes(a);
  const [editing, setEditing] = useState(false);
  const title = auditTitle(audit, standards);

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      eyebrow={<span className="text-meta text-muted">{audit.body}</span>}
      meta={<StatePill of="ExternalAuditState" value={audit.state} />}
      backLabel="Back to certification"
      size="lg"
    >
      <div className="flex flex-col gap-6">
        <DrawerSection title="Visit">
          <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5 text-body">
            <dt className="text-muted">Dates</dt>
            <dd>{auditDates(audit)}</dd>
            <dt className="text-muted">Lead auditor</dt>
            <dd>{audit.leadAuditorName ?? 'Not named'}</dd>
            <dt className="text-muted">Recommendation</dt>
            <dd>
              {audit.recommendation
                ? word('AuditRecommendation', audit.recommendation)
                : 'Not given yet'}
            </dd>
            <dt className="text-muted">Response due</dt>
            <dd>{audit.responseDueOn ? formatDate(audit.responseDueOn) : 'No deadline'}</dd>
            {audit.cancelReason ? (
              <>
                <dt className="text-muted">Cancelled because</dt>
                <dd className="whitespace-pre-line">{audit.cancelReason}</dd>
              </>
            ) : null}
          </dl>
          <div className="flex flex-wrap gap-2">
            {canManage && auditOpen(audit) ? (
              <Button size="sm" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
                Edit visit
              </Button>
            ) : null}
            {can('RECORD_RESPONSE') ? (
              <StepButton
                label="Record response sent"
                title="Record that the response was sent?"
                body="Every nonconformity this visit raised must have moved past Open."
                variant="primary"
                done="The response is recorded."
                run={() =>
                  isoWrite(clientId, 'recordIsoExternalAuditResponse', ids, {
                    version: audit.version,
                  })
                }
              />
            ) : null}
            {can('CANCEL') ? (
              <StepButton
                label="Cancel visit"
                title="Cancel this visit?"
                reason={{ label: 'Why it is cancelled' }}
                tone="danger"
                done="The visit is cancelled."
                run={(reason) =>
                  isoWrite(clientId, 'cancelIsoExternalAudit', ids, {
                    version: audit.version,
                    reason: reason ?? '',
                  })
                }
              />
            ) : null}
          </div>
          {editing ? <EditAudit {...props} onDone={() => setEditing(false)} /> : null}
        </DrawerSection>

        {can('RECORD_HELD') ? <RecordHeld {...props} /> : null}
        {can('CLOSE') ? <CloseAudit {...props} /> : null}

        <Findings {...props} />

        <FilesPanel
          clientId={clientId}
          subject={{ type: 'external_audit', id: audit.id }}
          editable={canManage && auditOpen(audit)}
          heading="Report and files"
          helper={
            can('RECORD_HELD')
              ? "Attach the body's report before recording the visit held."
              : undefined
          }
        />
      </div>
    </Drawer>
  );
}

function EditAudit({
  clientId,
  audit,
  standards,
  systems,
  today,
  onDone,
}: ExternalAuditsProps & { audit: ExternalAuditView; onDone: () => void }) {
  const system = systems.find((s) => s.id === audit.managementSystemId);
  const [standardIds, setStandardIds] = useState(audit.standardIds);
  const [type, setType] = useState<string>(audit.type);
  const [body, setBody] = useState(audit.body);
  const [lead, setLead] = useState(audit.leadAuditorName ?? '');
  const [startOn, setStartOn] = useState<string | null>(audit.startOn);
  const [endOn, setEndOn] = useState<string | null>(audit.endOn);
  const [responseDueOn, setResponseDueOn] = useState<string | null>(audit.responseDueOn);
  const [reason, setReason] = useState('');
  const { pending, error, save } = useSave();

  const patch: Record<string, unknown> = { version: audit.version };
  if ([...standardIds].sort().join() !== [...audit.standardIds].sort().join())
    patch.standardIds = standardIds;
  if (type !== audit.type) patch.type = type;
  if (body.trim() !== audit.body) patch.body = body.trim();
  if ((lead.trim() || null) !== audit.leadAuditorName) patch.leadAuditorName = lead.trim() || null;
  if (startOn !== audit.startOn) patch.startOn = startOn;
  if (endOn !== audit.endOn) patch.endOn = endOn;
  const moved = responseDueOn !== audit.responseDueOn;
  if (moved) {
    patch.responseDueOn = responseDueOn;
    patch.reason = reason.trim();
  }
  const changed = Object.keys(patch).length > 1;
  const blocked = !changed
    ? 'Nothing has changed'
    : standardIds.length === 0
      ? 'Choose at least one standard'
      : body.trim() === ''
        ? 'Name the certification body'
        : !startOn || !endOn
          ? 'Set the start and end dates'
          : endOn < startOn
            ? 'The audit ends after it starts'
            : moved && reason.trim() === ''
              ? 'Say why the response date moves'
              : undefined;

  return (
    <form
      aria-label="Edit visit"
      className="flex flex-col gap-4 rounded-control border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (blocked) return;
        void save(
          () => isoWrite(clientId, 'updateIsoExternalAudit', { id: audit.id }, patch as never),
          'The visit is saved.',
        ).then((ok) => ok && onDone());
      }}
    >
      <StandardBoxes
        standards={standards}
        allowed={system?.standardIds ?? audit.standardIds}
        value={standardIds}
        onChange={setStandardIds}
      />
      <Select label="Type" options={typeOptions} value={type} onValueChange={setType} />
      <Input
        label="Certification body"
        value={body}
        maxLength={200}
        onChange={(e) => setBody(e.target.value)}
      />
      <Input
        label="Lead auditor"
        value={lead}
        maxLength={200}
        onChange={(e) => setLead(e.target.value)}
      />
      <DateInput label="Starts on" value={startOn} onValueChange={setStartOn} today={today} />
      <DateInput
        label="Ends on"
        value={endOn}
        onValueChange={setEndOn}
        min={startOn ?? undefined}
        today={today}
      />
      <DateInput
        label="Response due"
        value={responseDueOn}
        onValueChange={setResponseDueOn}
        today={today}
      />
      {moved ? (
        <Input
          label="Why the response date moves"
          value={reason}
          maxLength={2000}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      ) : null}
      <FormAlert message={error} />
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={pending}
          disabledReason={blocked}
        >
          Save visit
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RecordHeld({
  clientId,
  audit,
  today,
}: ExternalAuditsProps & { audit: ExternalAuditView }) {
  const [startOn, setStartOn] = useState<string | null>(audit.startOn);
  const [endOn, setEndOn] = useState<string | null>(audit.endOn);
  const [recommendation, setRecommendation] = useState<string>(
    audit.recommendation ?? NO_RECOMMENDATION,
  );
  const [responseDueOn, setResponseDueOn] = useState<string | null>(audit.responseDueOn);
  const { pending, error, save } = useSave();
  const blocked =
    !startOn || !endOn
      ? 'Set the dates it was held'
      : endOn < startOn
        ? 'The audit ends after it starts'
        : undefined;
  return (
    <DrawerSection title="Record the visit held">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (blocked) return;
          void save(
            () =>
              isoWrite(
                clientId,
                'recordIsoExternalAuditHeld',
                { id: audit.id },
                {
                  version: audit.version,
                  startOn: startOn!,
                  endOn: endOn!,
                  recommendation:
                    recommendation === NO_RECOMMENDATION
                      ? null
                      : (recommendation as AuditRecommendation),
                  responseDueOn,
                },
              ),
            'The visit is recorded as held.',
          );
        }}
      >
        <p className="text-body text-muted">
          Needs the body&apos;s report as a file on this visit (below).
        </p>
        <DateInput
          label="Held from"
          value={startOn}
          onValueChange={setStartOn}
          max={today}
          today={today}
        />
        <DateInput
          label="Held until"
          value={endOn}
          onValueChange={setEndOn}
          min={startOn ?? undefined}
          max={today}
          today={today}
        />
        <Select
          label="Recommendation"
          options={recommendationOptions}
          value={recommendation}
          onValueChange={setRecommendation}
        />
        <DateInput
          label="Response due"
          value={responseDueOn}
          onValueChange={setResponseDueOn}
          today={today}
        />
        <FormAlert message={error} />
        <div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={pending}
            disabledReason={blocked}
          >
            Record visit held
          </Button>
        </div>
      </form>
    </DrawerSection>
  );
}

function CloseAudit({ clientId, audit }: ExternalAuditsProps & { audit: ExternalAuditView }) {
  const [recommendation, setRecommendation] = useState<string>(
    audit.recommendation ?? NO_RECOMMENDATION,
  );
  const { pending, error, save } = useSave();
  const chosen = recommendation !== NO_RECOMMENDATION;
  return (
    <DrawerSection title="Close the visit">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!chosen) return;
          void save(
            () =>
              isoWrite(
                clientId,
                'closeIsoExternalAudit',
                { id: audit.id },
                {
                  version: audit.version,
                  recommendation: recommendation as AuditRecommendation,
                },
              ),
            'The visit is closed.',
          );
        }}
      >
        <Select
          label="Recommendation"
          options={recommendationOptions}
          value={recommendation}
          onValueChange={setRecommendation}
        />
        <FormAlert message={error} />
        <div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={pending}
            disabledReason={chosen ? undefined : 'Record the recommendation first'}
          >
            Close visit
          </Button>
        </div>
      </form>
    </DrawerSection>
  );
}

const NC_TYPES = ['MAJOR_NC', 'MINOR_NC'];

function Findings(props: ExternalAuditsProps & { audit: ExternalAuditView }) {
  const { clientId, audit, units, clauseOptions, canManage } = props;
  const [findings, setFindings] = useState<AuditFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    const result = await isoRead(clientId, 'listIsoExternalFindings', { id: audit.id });
    if (result.ok) setFindings(result.data.items);
    else setError(result.message);
  }, [clientId, audit.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const clauseName = (id: string) =>
    (clauseOptions[audit.managementSystemId] ?? []).find((c) => c.id === id)?.label ?? 'A clause';

  return (
    <DrawerSection title="Findings">
      <FormAlert message={error} />
      {findings === null && !error ? (
        <p className="text-body text-muted" aria-live="polite">
          Loading findings…
        </p>
      ) : null}
      {findings && findings.length === 0 ? (
        <p className="text-body text-muted">No finding recorded.</p>
      ) : null}
      {findings && findings.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {findings.map((f) => (
            <li key={f.id} className="flex flex-col gap-1 rounded-control border border-line p-3">
              <span className="flex flex-wrap items-center gap-2">
                <StatePill of="FindingType" value={f.type} />
                {f.unitId ? (
                  <span className="text-meta text-muted">
                    {units.find((u) => u.id === f.unitId)?.name ?? 'Unknown unit'}
                  </span>
                ) : null}
              </span>
              <span className="whitespace-pre-line text-body text-ink">{f.description}</span>
              {f.clauseIds.length ? (
                <span className="text-meta text-muted">
                  {f.clauseIds.map(clauseName).join('; ')}
                </span>
              ) : null}
              {f.nonconformityId ? (
                <span className="text-meta text-muted">Raised a nonconformity.</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage && audit.state === 'HELD' ? (
        <div>
          <Button size="sm" onClick={() => setAdding(true)}>
            Add finding
          </Button>
        </div>
      ) : null}
      {adding ? (
        <NewFinding
          {...props}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void load();
          }}
        />
      ) : null}
    </DrawerSection>
  );
}

function NewFinding({
  clientId,
  audit,
  people,
  units,
  clauseOptions,
  today,
  onClose,
  onAdded,
}: ExternalAuditsProps & { audit: ExternalAuditView; onClose: () => void; onAdded: () => void }) {
  const [type, setType] = useState<string>('MINOR_NC');
  const [clauseIds, setClauseIds] = useState<string[]>([]);
  const [unitId, setUnitId] = useState<string>('');
  const [description, setDescription] = useState('');
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [approverId, setApproverId] = useState<string | null>(null);
  const [dueOn, setDueOn] = useState<string | null>(null);
  const { pending, error, save } = useSave();
  const nc = NC_TYPES.includes(type);
  const blocked =
    description.trim() === ''
      ? 'Describe the finding'
      : nc && (!ownerId || !approverId || !dueOn)
        ? 'A nonconformity needs an owner, an approver and a due date'
        : nc && ownerId === approverId
          ? 'The approver is not the owner'
          : undefined;
  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add finding"
      submitLabel="Add finding"
      pending={pending}
      error={error}
      disabledReason={blocked}
      onSubmit={() =>
        void save(
          () =>
            isoWrite(
              clientId,
              'createIsoExternalFinding',
              { id: audit.id },
              {
                type: type as AuditFinding['type'],
                clauseIds,
                unitId: unitId || null,
                description: description.trim(),
                ...(nc
                  ? { nonconformity: { ownerId: ownerId!, approverId: approverId!, dueOn: dueOn! } }
                  : {}),
              },
            ),
          nc ? 'The finding is added and its nonconformity raised.' : 'The finding is added.',
        ).then((ok) => ok && onAdded())
      }
    >
      <Select
        label="Type"
        options={Object.entries(WORDS.FindingType).map(([value, label]) => ({ value, label }))}
        value={type}
        onValueChange={setType}
      />
      <Textarea
        label="Description"
        value={description}
        maxLength={4000}
        onChange={(e) => setDescription(e.target.value)}
      />
      <ClausePicker
        label="Clauses"
        options={clauseOptions[audit.managementSystemId] ?? []}
        value={clauseIds}
        onChange={setClauseIds}
        max={20}
      />
      <Select
        label="Unit"
        options={[
          { value: '', label: 'No one unit' },
          ...units.map((u) => ({ value: u.id, label: u.name })),
        ]}
        value={unitId}
        onValueChange={setUnitId}
      />
      {nc ? (
        <>
          <p className="text-body text-muted">A nonconformity is raised with it, for:</p>
          <PersonSelect
            label="Owner"
            people={people}
            value={ownerId}
            onChange={setOwnerId}
            none="Choose someone"
          />
          <PersonSelect
            label="Approver"
            people={people}
            value={approverId}
            onChange={setApproverId}
            none="Choose someone"
          />
          <DateInput
            label="Due on"
            value={dueOn}
            onValueChange={setDueOn}
            min={today}
            today={today}
          />
          {ownerId && approverId ? (
            <p className="text-meta text-muted">
              {nameOf(people, ownerId)} works on it; {nameOf(people, approverId)} approves.
            </p>
          ) : null}
        </>
      ) : null}
    </FormDrawer>
  );
}
