'use client';
// A client's companies and their units (plants, sites, offices). Companies are added, renamed and archived; units
// are added under a company at a location, changed in a drawer and archived. Archiving asks for a reason, which the
// API keeps in the audit trail.
import { Button, Combobox, ConfirmDialog, Drawer, Input, Select } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import {
  archiveCompanyAction,
  archiveUnitAction,
  createCompanyAction,
  createUnitAction,
  renameCompanyAction,
  updateUnitAction,
  type ActionResult,
} from './actions';
import { unitsText, type CompanyRow, type LocationOption, type UnitRow } from './entities-model';

export type EntitiesViewProps = {
  clientId: string;
  companies: CompanyRow[];
  units: UnitRow[];
  locations: LocationOption[];
};

const th = 'px-4 py-2 font-semibold';
const td = 'px-4 py-2';

function Alert({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-body text-crit-ink">
      {message}
    </p>
  ) : null;
}

/** One message line for the page: what was done, or why it wasn't. */
function useOutcome() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const report = (result: ActionResult, success: string) => {
    if (result.ok) {
      setError(null);
      setDone(success);
    } else {
      setDone(null);
      setError(result.message);
    }
    router.refresh();
    return result.ok;
  };
  const clear = () => {
    setError(null);
    setDone(null);
  };
  return { error, done, report, clear };
}

export function EntitiesView({ clientId, companies, units, locations }: EntitiesViewProps) {
  return (
    <div className="flex flex-col gap-8">
      <CompaniesSection clientId={clientId} companies={companies} />
      <UnitsSection clientId={clientId} companies={companies} units={units} locations={locations} />
    </div>
  );
}

function CompaniesSection({ clientId, companies }: { clientId: string; companies: CompanyRow[] }) {
  const outcome = useOutcome();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [renaming, setRenaming] = useState<CompanyRow | null>(null);
  const [archiving, setArchiving] = useState<CompanyRow | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') return;
    setPending(true);
    outcome.clear();
    const ok = outcome.report(
      await createCompanyAction(clientId, { name: trimmed }),
      `${trimmed} was added.`,
    );
    setPending(false);
    if (ok) setName('');
  };

  return (
    <section aria-labelledby="companies-heading" className="flex flex-col gap-3">
      <h2 id="companies-heading" className="text-card text-ink">
        Companies
      </h2>
      {companies.length === 0 ? (
        <p className="text-body text-muted">No companies yet. Add the first one below.</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full text-body">
            <caption className="sr-only">Companies</caption>
            <thead>
              <tr className="border-b border-line text-left text-meta text-muted">
                <th scope="col" className={th}>
                  Company
                </th>
                <th scope="col" className={th}>
                  Units
                </th>
                <th scope="col" className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-b-0">
                  <th scope="row" className={`${td} text-left font-semibold text-ink`}>
                    {c.name}
                  </th>
                  <td className={`${td} tabular text-muted`}>{unitsText(c.units)}</td>
                  <td className={`${td} whitespace-nowrap text-right`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Rename ${c.name}`}
                      onClick={() => setRenaming(c)}
                    >
                      Rename
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Archive ${c.name}`}
                      disabledReason={c.units > 0 ? 'Archive or move its units first' : undefined}
                      onClick={() => setArchiving(c)}
                    >
                      Archive
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="flex max-w-2xl flex-wrap items-end gap-2" onSubmit={(e) => void add(e)}>
        <Input
          label="New company name"
          value={name}
          maxLength={300}
          onChange={(e) => setName(e.target.value)}
          className="min-w-64 flex-1"
        />
        <Button
          type="submit"
          loading={pending}
          disabledReason={name.trim() === '' ? 'Type a name first' : undefined}
        >
          Add company
        </Button>
      </form>
      <Alert message={outcome.error} />
      <p role="status" className="text-body text-ok-ink">
        {outcome.done}
      </p>
      <ConfirmDialog
        open={renaming !== null}
        onOpenChange={(open) => (open ? undefined : setRenaming(null))}
        title={`Rename ${renaming?.name ?? ''}?`}
        confirmLabel="Rename"
        reason={{
          label: 'New name',
          required: true,
          maxLength: 300,
          multiline: false,
          initialValue: renaming?.name,
        }}
        onConfirm={async (newName) => {
          const row = renaming!;
          const trimmed = (newName ?? '').trim();
          if (trimmed === row.name) return;
          outcome.report(
            await renameCompanyAction(clientId, row.id, { version: row.version, name: trimmed }),
            `${row.name} is now ${trimmed}.`,
          );
        }}
      />
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => (open ? undefined : setArchiving(null))}
        title={`Archive ${archiving?.name ?? ''}?`}
        body="It leaves the client's setup. The audit trail keeps it, with your reason."
        confirmLabel="Archive"
        tone="danger"
        reason={{ label: 'Reason (required)', required: true, maxLength: 2000 }}
        onConfirm={async (reason) => {
          const row = archiving!;
          outcome.report(
            await archiveCompanyAction(clientId, row.id, {
              version: row.version,
              reason: (reason ?? '').trim(),
            }),
            `${row.name} was archived.`,
          );
        }}
      />
    </section>
  );
}

function UnitsSection({
  clientId,
  companies,
  units,
  locations,
}: {
  clientId: string;
  companies: CompanyRow[];
  units: UnitRow[];
  locations: LocationOption[];
}) {
  const outcome = useOutcome();
  const companyOptions = companies.map((c) => ({ value: c.id, label: c.name }));
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const [locationId, setLocationId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<UnitRow | null>(null);
  const editing = units.find((u) => u.id === editingId) ?? null;

  // A newly added first company becomes the default choice.
  useEffect(() => {
    if (!companies.some((c) => c.id === companyId)) setCompanyId(companies[0]?.id ?? '');
  }, [companies, companyId]);

  const missing =
    companyId === ''
      ? 'Add a company first'
      : locationId === null
        ? 'Choose a location first'
        : name.trim() === ''
          ? 'Type a name first'
          : undefined;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (missing || locationId === null) return;
    const trimmed = name.trim();
    setPending(true);
    outcome.clear();
    const ok = outcome.report(
      await createUnitAction(clientId, { companyId, locationId, name: trimmed }),
      `${trimmed} was added.`,
    );
    setPending(false);
    if (ok) {
      setName('');
      setLocationId(null);
    }
  };

  return (
    <section aria-labelledby="units-heading" className="flex flex-col gap-3">
      <h2 id="units-heading" className="text-card text-ink">
        Units
      </h2>
      <p className="text-body text-muted">
        Plants, sites and offices. A unit&apos;s state decides which state laws apply to it.
      </p>
      {units.length === 0 ? (
        <p className="text-body text-muted">No units yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full text-body">
            <caption className="sr-only">Units</caption>
            <thead>
              <tr className="border-b border-line text-left text-meta text-muted">
                <th scope="col" className={th}>
                  Unit
                </th>
                <th scope="col" className={th}>
                  Company
                </th>
                <th scope="col" className={th}>
                  Location
                </th>
                <th scope="col" className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {units.map((u) => (
                <tr key={u.id} className="border-b border-line last:border-b-0">
                  <th scope="row" className={`${td} text-left font-semibold text-ink`}>
                    {u.name}
                  </th>
                  <td className={`${td} text-muted`}>{u.company}</td>
                  <td className={`${td} text-muted`}>{u.location}</td>
                  <td className={`${td} whitespace-nowrap text-right`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit ${u.name}, ${u.company}`}
                      onClick={() => setEditingId(u.id)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Archive ${u.name}, ${u.company}`}
                      onClick={() => setArchiving(u)}
                    >
                      Archive
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="flex max-w-2xl flex-col gap-3" onSubmit={(e) => void add(e)}>
        <h3 className="text-body font-semibold text-ink">Add a unit</h3>
        {companies.length > 0 ? (
          <Select
            label="Company"
            options={companyOptions}
            value={companyId}
            onValueChange={setCompanyId}
          />
        ) : null}
        <Combobox
          label="Location"
          helper="Type a city or state to find it."
          options={locations}
          value={locationId}
          onValueChange={setLocationId}
          emptyText="No location matches. Ask your account admin to add it."
        />
        <Input
          label="Unit name"
          value={name}
          maxLength={300}
          onChange={(e) => setName(e.target.value)}
        />
        <div>
          <Button type="submit" loading={pending} disabledReason={missing}>
            Add unit
          </Button>
        </div>
      </form>
      <Alert message={outcome.error} />
      <p role="status" className="text-body text-ok-ink">
        {outcome.done}
      </p>
      {editing ? (
        <EditUnit
          key={editing.id}
          clientId={clientId}
          unit={editing}
          companies={companyOptions}
          locations={locations}
          onClose={() => setEditingId(null)}
          onSaved={(message) => outcome.report({ ok: true }, message)}
        />
      ) : null}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => (open ? undefined : setArchiving(null))}
        title={`Archive ${archiving?.name ?? ''}?`}
        body="Its assignments stop producing new instances. The audit trail keeps it, with your reason."
        confirmLabel="Archive"
        tone="danger"
        reason={{ label: 'Reason (required)', required: true, maxLength: 2000 }}
        onConfirm={async (reason) => {
          const row = archiving!;
          outcome.report(
            await archiveUnitAction(clientId, row.id, {
              version: row.version,
              reason: (reason ?? '').trim(),
            }),
            `${row.name} was archived.`,
          );
        }}
      />
    </section>
  );
}

function EditUnit({
  clientId,
  unit,
  companies,
  locations,
  onClose,
  onSaved,
}: {
  clientId: string;
  unit: UnitRow;
  companies: { value: string; label: string }[];
  locations: LocationOption[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(unit.name);
  const [companyId, setCompanyId] = useState(unit.companyId);
  const [locationId, setLocationId] = useState<string | null>(unit.locationId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Someone else saved a new version: show it, and keep the message saying so.
  useEffect(() => {
    setName(unit.name);
    setCompanyId(unit.companyId);
    setLocationId(unit.locationId);
  }, [unit.version, unit.name, unit.companyId, unit.locationId]);

  const trimmed = name.trim();
  const changes = {
    ...(trimmed !== unit.name ? { name: trimmed } : {}),
    ...(companyId !== unit.companyId ? { companyId } : {}),
    ...(locationId !== null && locationId !== unit.locationId ? { locationId } : {}),
  };
  const changed = Object.keys(changes).length > 0;

  const save = async () => {
    if (!changed || trimmed === '') return;
    setPending(true);
    setError(null);
    const result = await updateUnitAction(clientId, unit.id, { version: unit.version, ...changes });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      router.refresh();
      return;
    }
    onSaved(`${trimmed} was saved.`);
    onClose();
  };

  return (
    <Drawer
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={unit.name}
      eyebrow={`Unit · ${unit.company}`}
      size="md"
      dirty={changed}
      dirtyPrompt={{ title: 'Discard your changes?', body: 'What you changed here will be lost.' }}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button
            loading={pending}
            onClick={() => void save()}
            disabledReason={
              trimmed === '' ? 'Type a name first' : !changed ? 'Nothing has changed' : undefined
            }
          >
            Save changes
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          label="Unit name"
          value={name}
          maxLength={300}
          onChange={(e) => setName(e.target.value)}
        />
        <Select
          label="Company"
          options={companies}
          value={companyId}
          onValueChange={setCompanyId}
        />
        <Combobox
          label="Location"
          options={locations}
          value={locationId}
          onValueChange={setLocationId}
          emptyText="No location matches. Ask your account admin to add it."
        />
        <Alert message={error} />
      </div>
    </Drawer>
  );
}
