'use client';
// A management system's set-up (docs/iso/model.md §3.1-3.2): its standards, scope, units, status, review interval, the
// climate decision of Amd 1:2024, and the issues and interested parties of clauses 4.1 and 4.2. Standards can be added
// to a system, never removed. The climate decision, once made, can change but never return to undecided.
import type {
  ContextItem,
  ContextItemKind,
  IsoStandard,
  ManagementSystem,
} from '@canopy/contracts';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  DateInput,
  formatDate,
  Input,
  RadioGroup,
  Select,
  Textarea,
} from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { isoWrite } from '../_lib/actions';
import { standardTitle, word, WORDS } from '../_lib/words';
import { FormAlert, FormDrawer, useSave } from '../_components/controls';
import { StatePill } from '../_components/IsoStates';

type UnitOption = { id: string; name: string };

export type SystemSetupProps = {
  clientId: string;
  system: ManagementSystem;
  standards: IsoStandard[];
  units: UnitOption[];
  contextItems: ContextItem[];
  /** The person may set up systems (the contracts' role table: managers). */
  canEdit: boolean;
  today: string;
};

function namesFor(list: readonly UnitOption[], ids: readonly string[], empty: string): string {
  if (ids.length === 0) return empty;
  return ids.map((id) => list.find((u) => u.id === id)?.name ?? 'Unknown unit').join(', ');
}

export function SystemSetup(props: SystemSetupProps) {
  const { system, standards, units, canEdit } = props;
  const [editing, setEditing] = useState(false);
  const [climate, setClimate] = useState(false);
  return (
    <section
      id="system-setup"
      aria-labelledby={`setup-${system.id}`}
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={`setup-${system.id}`} className="text-card text-ink">
          System set-up
        </h2>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit system
            </Button>
            <Button size="sm" onClick={() => setClimate(true)}>
              {system.climateChangeRelevant === null
                ? 'Record climate decision'
                : 'Change climate decision'}
            </Button>
          </div>
        ) : null}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-body sm:grid-cols-[12rem_1fr]">
        <dt className="text-muted">Status</dt>
        <dd>
          <StatePill of="ManagementSystemStatus" value={system.status} />
        </dd>
        <dt className="text-muted">Standards</dt>
        <dd className="text-ink">
          {system.standardIds.map((id) => standardTitle(standards, id)).join(', ')}
        </dd>
        <dt className="text-muted">Scope</dt>
        <dd className="whitespace-pre-line text-ink">
          {system.scopeStatement ?? 'No scope statement yet.'}
        </dd>
        <dt className="text-muted">Units</dt>
        <dd className="text-ink">
          {namesFor(units, system.unitIds, 'Not chosen yet (every unit of the client)')}
        </dd>
        <dt className="text-muted">Management reviews</dt>
        <dd className="text-ink">Every {system.reviewIntervalMonths} months</dd>
        <dt className="text-muted">Climate change (clause 4.1)</dt>
        <dd className="text-ink">
          {system.climateChangeRelevant === null ? (
            'Not decided yet'
          ) : (
            <>
              {system.climateChangeRelevant ? 'A relevant issue' : 'Not a relevant issue'}
              {system.climateDecidedOn ? `, decided ${formatDate(system.climateDecidedOn)}` : ''}
              <span className="mt-1 block whitespace-pre-line text-muted">
                {system.climateChangeRationale}
              </span>
            </>
          )}
        </dd>
      </dl>
      <ContextItems {...props} />
      {editing ? <EditSystem {...props} onClose={() => setEditing(false)} /> : null}
      {climate ? <ClimateDecision {...props} onClose={() => setClimate(false)} /> : null}
    </section>
  );
}

function EditSystem({
  clientId,
  system,
  standards,
  units,
  onClose,
}: SystemSetupProps & { onClose: () => void }) {
  const [name, setName] = useState(system.name);
  const [standardIds, setStandardIds] = useState(system.standardIds);
  const [scope, setScope] = useState(system.scopeStatement ?? '');
  const [unitIds, setUnitIds] = useState(system.unitIds);
  const [status, setStatus] = useState<string>(system.status);
  const [interval, setMonthsText] = useState(String(system.reviewIntervalMonths));
  const { pending, error, save } = useSave();
  const months = Number(interval);
  const badInterval = !Number.isInteger(months) || months < 1 || months > 36;

  const submit = async () => {
    const body: Record<string, unknown> = { version: system.version };
    if (name.trim() !== system.name) body.name = name.trim();
    if (standardIds.length !== system.standardIds.length) body.standardIds = standardIds;
    if ((scope.trim() || null) !== system.scopeStatement)
      body.scopeStatement = scope.trim() || null;
    if ([...unitIds].sort().join() !== [...system.unitIds].sort().join()) body.unitIds = unitIds;
    if (status !== system.status) body.status = status;
    if (months !== system.reviewIntervalMonths) body.reviewIntervalMonths = months;
    if (Object.keys(body).length === 1) return onClose();
    const ok = await save(
      () => isoWrite(clientId, 'updateIsoSystem', { id: system.id }, body as never),
      'The system is saved.',
    );
    if (ok) onClose();
  };

  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Edit system"
      submitLabel="Save system"
      pending={pending}
      error={error}
      disabledReason={
        name.trim() === '' ? 'Give the system a name' : badInterval ? 'Fix the interval' : undefined
      }
      onSubmit={() => void submit()}
    >
      <Input label="Name" value={name} maxLength={300} onChange={(e) => setName(e.target.value)} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-meta text-ink">Standards</legend>
        <p className="text-meta text-muted">
          A standard can be added, never removed. Adding one adds its clauses to the checklist.
        </p>
        {standards.map((s) => {
          const kept = system.standardIds.includes(s.id);
          return (
            <Checkbox
              key={s.id}
              label={`${s.title} (${s.edition})`}
              checked={standardIds.includes(s.id)}
              disabled={kept}
              onCheckedChange={(checked) =>
                setStandardIds((ids) =>
                  checked === true ? [...ids, s.id] : ids.filter((id) => id !== s.id),
                )
              }
            />
          );
        })}
      </fieldset>
      <Textarea
        label="Scope statement"
        value={scope}
        maxLength={8000}
        onChange={(e) => setScope(e.target.value)}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-meta text-ink">Units</legend>
        <p className="text-meta text-muted">None chosen means every unit of the client.</p>
        {units.map((u) => (
          <Checkbox
            key={u.id}
            label={u.name}
            checked={unitIds.includes(u.id)}
            onCheckedChange={(checked) =>
              setUnitIds((ids) =>
                checked === true ? [...ids, u.id] : ids.filter((id) => id !== u.id),
              )
            }
          />
        ))}
      </fieldset>
      <Select
        label="Status"
        options={Object.entries(WORDS.ManagementSystemStatus).map(([value, label]) => ({
          value,
          label,
        }))}
        value={status}
        onValueChange={setStatus}
      />
      <Input
        label="Months between management reviews"
        inputMode="numeric"
        value={interval}
        error={badInterval ? 'Enter a whole number from 1 to 36.' : undefined}
        onChange={(e) => setMonthsText(e.target.value)}
      />
    </FormDrawer>
  );
}

function ClimateDecision({
  clientId,
  system,
  today,
  onClose,
}: SystemSetupProps & { onClose: () => void }) {
  const [relevant, setRelevant] = useState<string>(
    system.climateChangeRelevant === null ? '' : String(system.climateChangeRelevant),
  );
  const [rationale, setRationale] = useState(system.climateChangeRationale ?? '');
  const [decidedOn, setDecidedOn] = useState<string | null>(system.climateDecidedOn ?? today);
  const { pending, error, save } = useSave();

  const submit = async () => {
    const ok = await save(
      () =>
        isoWrite(
          clientId,
          'setIsoClimateDecision',
          { id: system.id },
          {
            version: system.version,
            climateChangeRelevant: relevant === 'true',
            climateChangeRationale: rationale.trim(),
            climateDecidedOn: decidedOn ?? today,
          },
        ),
      'The climate decision is recorded.',
    );
    if (ok) onClose();
  };

  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Climate decision"
      submitLabel="Record decision"
      pending={pending}
      error={error}
      disabledReason={
        relevant === ''
          ? 'Choose whether climate change is relevant'
          : rationale.trim() === ''
            ? 'Give the reasons'
            : decidedOn === null
              ? 'Give the date'
              : undefined
      }
      onSubmit={() => void submit()}
    >
      <p className="text-body text-muted">
        Clause 4.1 of each standard asks whether climate change is a relevant issue. The decision
        covers every standard of this system and is kept in its audit trail.
      </p>
      <RadioGroup
        label="Is climate change a relevant issue?"
        options={[
          { value: 'true', label: 'Yes, it is relevant' },
          { value: 'false', label: 'No, it is not relevant' },
        ]}
        value={relevant}
        onValueChange={setRelevant}
      />
      <Textarea
        label="Reasons"
        value={rationale}
        maxLength={4000}
        onChange={(e) => setRationale(e.target.value)}
      />
      <DateInput
        label="Decided on"
        value={decidedOn}
        onValueChange={setDecidedOn}
        max={today}
        today={today}
      />
    </FormDrawer>
  );
}

const KIND_OPTIONS = Object.entries(WORDS.ContextItemKind).map(([value, label]) => ({
  value,
  label,
}));

function ContextItems({ clientId, system, contextItems, canEdit, today }: SystemSetupProps) {
  const router = useRouter();
  const [editing, setEditing] = useState<ContextItem | 'new' | null>(null);
  const [archiving, setArchiving] = useState<ContextItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-body font-semibold text-ink">Issues and interested parties</h3>
        {canEdit ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            Add issue or party
          </Button>
        ) : null}
      </div>
      {contextItems.length === 0 ? (
        <p className="text-body text-muted">None recorded yet.</p>
      ) : (
        // A table wider than a phone scrolls sideways inside its own frame, which takes focus so the keyboard can scroll it.
        <div
          role="region"
          aria-label="Issues and interested parties"
          tabIndex={0}
          className="overflow-x-auto rounded-control border border-line focus-visible:outline-2 focus-visible:outline-forest"
        >
          <table className="w-full text-body">
            <caption className="sr-only">Issues and interested parties</caption>
            <thead>
              <tr className="border-b border-line text-left text-meta text-muted">
                <th scope="col" className="px-3 py-2 font-semibold">
                  Kind
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Issue or party
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Climate related
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Reviewed
                </th>
                {canEdit ? (
                  <th scope="col" className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {contextItems.map((item) => (
                <tr key={item.id} className="border-b border-line align-top last:border-b-0">
                  <td className="px-3 py-2 whitespace-nowrap text-muted">
                    {word('ContextItemKind', item.kind)}
                  </td>
                  <td className="px-3 py-2 text-ink">
                    <span className="whitespace-pre-line">{item.text}</span>
                    {item.needs ? (
                      <span className="mt-1 block whitespace-pre-line text-muted">
                        Needs: {item.needs}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-muted">{item.climateRelated ? 'Yes' : 'No'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted">
                    {item.reviewedOn ? formatDate(item.reviewedOn) : '—'}
                  </td>
                  {canEdit ? (
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${item.text.slice(0, 40).trim()}`}
                        onClick={() => setEditing(item)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Archive ${item.text.slice(0, 40).trim()}`}
                        onClick={() => setArchiving(item)}
                      >
                        Archive
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <FormAlert message={error} />
      {editing ? (
        <ContextItemForm
          clientId={clientId}
          systemId={system.id}
          item={editing === 'new' ? null : editing}
          today={today}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title="Archive this item?"
        body="It leaves the list and stays in the audit trail."
        confirmLabel="Archive"
        tone="danger"
        reason={{ label: 'Reason', required: true, maxLength: 2000 }}
        onConfirm={async (reason) => {
          if (!archiving) return;
          const result = await isoWrite(
            clientId,
            'archiveIsoContextItem',
            { id: system.id, itemId: archiving.id },
            { version: archiving.version, reason: reason ?? '' },
          );
          if (!result.ok) {
            setError(result.message);
            throw new Error(result.message);
          }
          setError(null);
          setArchiving(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function ContextItemForm({
  clientId,
  systemId,
  item,
  today,
  onClose,
}: {
  clientId: string;
  systemId: string;
  item: ContextItem | null;
  today: string;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<ContextItemKind>(item?.kind ?? 'INTERNAL_ISSUE');
  const [text, setText] = useState(item?.text ?? '');
  const [needs, setNeeds] = useState(item?.needs ?? '');
  const [climateRelated, setClimateRelated] = useState(item?.climateRelated ?? false);
  const [reviewedOn, setReviewedOn] = useState<string | null>(item?.reviewedOn ?? null);
  const { pending, error, save } = useSave();
  const party = kind === 'INTERESTED_PARTY';

  const submit = async () => {
    const fields = {
      text: text.trim(),
      needs: party ? needs.trim() || null : null,
      climateRelated,
      reviewedOn,
    };
    const ok = await save(
      () =>
        item
          ? isoWrite(
              clientId,
              'updateIsoContextItem',
              { id: systemId, itemId: item.id },
              { version: item.version, ...fields },
            )
          : isoWrite(clientId, 'createIsoContextItem', { id: systemId }, { kind, ...fields }),
      item ? 'The item is saved.' : 'The item is added.',
    );
    if (ok) onClose();
  };

  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={item ? 'Edit issue or party' : 'Add issue or party'}
      submitLabel={item ? 'Save' : 'Add'}
      pending={pending}
      error={error}
      disabledReason={text.trim() === '' ? 'Describe the issue or party' : undefined}
      onSubmit={() => void submit()}
    >
      {item ? (
        <p className="text-body text-muted">{word('ContextItemKind', item.kind)}</p>
      ) : (
        <Select
          label="Kind"
          options={KIND_OPTIONS}
          value={kind}
          onValueChange={(v) => setKind(v as ContextItemKind)}
        />
      )}
      <Textarea
        label={party ? 'Interested party' : 'Issue'}
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
      />
      {party ? (
        <Textarea
          label="Needs and expectations"
          helper="Say which of them become compliance obligations."
          value={needs}
          maxLength={4000}
          onChange={(e) => setNeeds(e.target.value)}
        />
      ) : null}
      <Checkbox
        label="Climate related"
        checked={climateRelated}
        onCheckedChange={(checked) => setClimateRelated(checked === true)}
      />
      <DateInput
        label="Last reviewed"
        value={reviewedOn}
        onValueChange={setReviewedOn}
        max={today}
        today={today}
      />
    </FormDrawer>
  );
}

/** A client without a management system: the first one's name, standards and units. */
export function NewSystem({
  clientId,
  standards,
  units,
}: {
  clientId: string;
  standards: IsoStandard[];
  units: UnitOption[];
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [standardIds, setStandardIds] = useState<string[]>([]);
  const [unitIds, setUnitIds] = useState<string[]>([]);
  const { pending, error, save } = useSave();

  const submit = async () => {
    const ok = await save(
      () => isoWrite(clientId, 'createIsoSystem', {}, { name: name.trim(), standardIds, unitIds }),
      'The management system is set up. Its checklist is ready.',
    );
    if (ok) setOpen(false);
  };

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Set up a management system
      </Button>
      <FormDrawer
        open={open}
        onOpenChange={setOpen}
        title="Set up a management system"
        submitLabel="Set up system"
        pending={pending}
        error={error}
        disabledReason={
          name.trim() === ''
            ? 'Give the system a name'
            : standardIds.length === 0
              ? 'Choose at least one standard'
              : undefined
        }
        onSubmit={() => void submit()}
      >
        <Input
          label="Name"
          value={name}
          maxLength={300}
          onChange={(e) => setName(e.target.value)}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-meta text-ink">Standards</legend>
          {standards.map((s) => (
            <Checkbox
              key={s.id}
              label={`${s.title} (${s.edition})`}
              checked={standardIds.includes(s.id)}
              onCheckedChange={(checked) =>
                setStandardIds((ids) =>
                  checked === true ? [...ids, s.id] : ids.filter((id) => id !== s.id),
                )
              }
            />
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-meta text-ink">Units</legend>
          <p className="text-meta text-muted">Leave empty to cover every unit for now.</p>
          {units.map((u) => (
            <Checkbox
              key={u.id}
              label={u.name}
              checked={unitIds.includes(u.id)}
              onCheckedChange={(checked) =>
                setUnitIds((ids) =>
                  checked === true ? [...ids, u.id] : ids.filter((id) => id !== u.id),
                )
              }
            />
          ))}
        </fieldset>
      </FormDrawer>
    </>
  );
}
