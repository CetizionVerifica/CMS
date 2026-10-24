'use client';
// The client's departments: add one, rename it, keep its other spellings (an import matches them to it), and merge
// duplicates into one. Each change goes through a server action; the page re-renders from the API afterwards.
import { Button, Checkbox, ConfirmDialog, Drawer, Input } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import {
  createDepartmentAction,
  mergeDepartmentsAction,
  updateDepartmentAction,
  type ActionResult,
} from '../actions';
import { parseAliases, type DepartmentRow } from '../setup-model';

const ALIAS_HELP = 'Separate them with commas. An import matches these to this department.';

function Alert({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-body text-crit-ink">
      {message}
    </p>
  ) : null;
}

export function DepartmentsView({ clientId, rows }: { clientId: string; rows: DepartmentRow[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  // The live row, so a refresh after someone else's change brings their version into the open drawer.
  const editing = rows.find((r) => r.id === editingId) ?? null;
  return (
    <div className="flex flex-col gap-6">
      <AddDepartment clientId={clientId} />
      {rows.length === 0 ? (
        <p className="text-body text-muted">
          No departments yet. Add one above, or import the register to bring them in.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full text-body">
            <caption className="sr-only">Departments</caption>
            <thead>
              <tr className="border-b border-line text-left text-meta text-muted">
                <th scope="col" className="px-4 py-2 font-semibold">
                  Department
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Other spellings
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-b-0">
                  <th scope="row" className="px-4 py-2 text-left font-semibold text-ink">
                    {row.name}
                  </th>
                  <td className="px-4 py-2 text-muted">{row.aliases || '—'}</td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit ${row.name}`}
                      onClick={() => setEditingId(row.id)}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? (
        <EditDepartment
          key={editing.id}
          clientId={clientId}
          row={editing}
          others={rows.filter((r) => r.id !== editing.id)}
          onClose={() => setEditingId(null)}
        />
      ) : null}
    </div>
  );
}

function AddDepartment({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') return;
    setPending(true);
    setError(null);
    setAdded(null);
    const result = await createDepartmentAction(clientId, {
      name: trimmed,
      aliases: parseAliases(aliases, trimmed),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setName('');
    setAliases('');
    setAdded(`${trimmed} was added.`);
    router.refresh();
  };

  return (
    <section aria-labelledby="add-heading" className="flex max-w-2xl flex-col gap-3">
      <h2 id="add-heading" className="text-card text-ink">
        Add a department
      </h2>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Input
          label="Department name"
          value={name}
          maxLength={300}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label="Other spellings (optional)"
          helper={ALIAS_HELP}
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
        />
        <Alert message={error} />
        <div>
          <Button
            type="submit"
            loading={pending}
            disabledReason={name.trim() === '' ? 'Type a name first' : undefined}
          >
            Add department
          </Button>
        </div>
      </form>
      <p role="status" className="text-body text-ok-ink">
        {added}
      </p>
    </section>
  );
}

function EditDepartment({
  clientId,
  row,
  others,
  onClose,
}: {
  clientId: string;
  row: DepartmentRow;
  others: DepartmentRow[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(row.name);
  const [aliases, setAliases] = useState(row.aliases);
  const [sources, setSources] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Someone else saved a new version: show it, and keep the message saying so.
  useEffect(() => {
    setName(row.name);
    setAliases(row.aliases);
    setSources([]);
  }, [row.version, row.name, row.aliases]);

  const trimmed = name.trim();
  const nextAliases = parseAliases(aliases, trimmed);
  const changed =
    trimmed !== row.name ||
    nextAliases.join('\n') !== parseAliases(row.aliases, row.name).join('\n');
  const merging = others.filter((o) => sources.includes(o.id));

  const finish = (result: ActionResult) => {
    if (!result.ok) {
      setError(result.message);
      router.refresh();
      return;
    }
    router.refresh();
    onClose();
  };

  const save = async () => {
    if (!changed || trimmed === '') return;
    setPending(true);
    setError(null);
    const result = await updateDepartmentAction(clientId, row.id, {
      version: row.version,
      ...(trimmed !== row.name ? { name: trimmed } : {}),
      aliases: nextAliases,
    });
    setPending(false);
    finish(result);
  };

  return (
    <Drawer
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={row.name}
      eyebrow="Department"
      size="md"
      dirty={changed || sources.length > 0}
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
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <Input
            label="Department name"
            value={name}
            maxLength={300}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label="Other spellings"
            helper={ALIAS_HELP}
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
          />
        </div>
        <Alert message={error} />
        {others.length > 0 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-body font-semibold text-ink">
              Merge other departments into {row.name}
            </legend>
            <p className="text-meta text-muted">
              Their names become other spellings of {row.name}, and their assignments move to it.
            </p>
            {others.map((o) => (
              <Checkbox
                key={o.id}
                label={o.name}
                checked={sources.includes(o.id)}
                onCheckedChange={(checked) =>
                  setSources((current) =>
                    checked === true ? [...current, o.id] : current.filter((id) => id !== o.id),
                  )
                }
              />
            ))}
            <div>
              <Button
                variant="secondary"
                onClick={() => setConfirming(true)}
                disabledReason={
                  sources.length === 0 ? 'Choose a department to merge first' : undefined
                }
              >
                Merge {sources.length === 1 ? 'department' : 'departments'}
              </Button>
            </div>
          </fieldset>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Merge ${merging.length === 1 ? merging[0]!.name : `${merging.length} departments`} into ${row.name}?`}
        body={`${merging.map((m) => m.name).join(', ')} will be removed. Their assignments move to ${row.name}, and the change is recorded in the audit trail.`}
        confirmLabel="Merge"
        tone="danger"
        onConfirm={async () => {
          setError(null);
          finish(
            await mergeDepartmentsAction(clientId, row.id, {
              version: row.version,
              sourceIds: sources,
            }),
          );
        }}
      />
    </Drawer>
  );
}
