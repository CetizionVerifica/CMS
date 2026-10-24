'use client';
// The client's people: owners, approvers and client admins. A person is added with a role on every unit (an email
// makes them invited; without one they can still be assigned work), their name or email is changed in a drawer, and
// duplicates (two spellings of one person, often from an import) are merged into one.
import { Button, Checkbox, ConfirmDialog, Drawer, Input, Select } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { addPersonAction, mergePeopleAction, rolesAction, updatePersonAction } from './actions';
import { ADD_ROLE_OPTIONS, parseEmail, type PersonRow } from './people-model';

const EMAIL_ERROR = 'Enter an email like name@company.com, or leave it empty.';

function Alert({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-body text-crit-ink">
      {message}
    </p>
  ) : null;
}

export function PeopleView({ clientId, rows }: { clientId: string; rows: PersonRow[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  // The live row, so a refresh after someone else's change brings their version into the open drawer.
  const editing = rows.find((r) => r.id === editingId) ?? null;
  return (
    <div className="flex flex-col gap-6">
      <AddPerson clientId={clientId} />
      {rows.length === 0 ? (
        <p className="text-body text-muted">
          No people yet. Add one above, or import the register to bring in its owners and approvers.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full text-body">
            <caption className="sr-only">People</caption>
            <thead>
              <tr className="border-b border-line text-left text-meta text-muted">
                <th scope="col" className="px-4 py-2 font-semibold">
                  Name
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Email
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Status
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
                  <td className="px-4 py-2 break-all text-muted">{row.email ?? '—'}</td>
                  <td className="px-4 py-2 text-muted">{row.status}</td>
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
        <EditPerson
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

function AddPerson({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('OWNER');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const parsed = parseEmail(email);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '' || parsed === undefined) return;
    setPending(true);
    setError(null);
    setAdded(null);
    const result = await addPersonAction(clientId, { displayName: trimmed, email: parsed, role });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setName('');
    setEmail('');
    setAdded(
      parsed === null
        ? `${trimmed} was added. Add an email when they need to sign in.`
        : `${trimmed} was added as invited.`,
    );
    router.refresh();
  };

  return (
    <section aria-labelledby="add-heading" className="flex max-w-2xl flex-col gap-3">
      <h2 id="add-heading" className="text-card text-ink">
        Add a person
      </h2>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Input
          label="Name"
          value={name}
          maxLength={300}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label="Email (optional)"
          helper="Without an email they can be assigned work but cannot sign in yet."
          type="email"
          value={email}
          error={parsed === undefined ? EMAIL_ERROR : undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Select
          label="Role"
          helper="On every unit of this client."
          options={[...ADD_ROLE_OPTIONS]}
          value={role}
          onValueChange={setRole}
          className="max-w-64"
        />
        <Alert message={error} />
        <div>
          <Button
            type="submit"
            loading={pending}
            disabledReason={
              name.trim() === ''
                ? 'Type a name first'
                : parsed === undefined
                  ? 'Fix the email first'
                  : undefined
            }
          >
            Add person
          </Button>
        </div>
      </form>
      <p role="status" className="text-body text-ok-ink">
        {added}
      </p>
    </section>
  );
}

function EditPerson({
  clientId,
  row,
  others,
  onClose,
}: {
  clientId: string;
  row: PersonRow;
  others: PersonRow[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(row.name);
  const [email, setEmail] = useState(row.email ?? '');
  const [sources, setSources] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Someone else saved a new version: show it, and keep the message saying so.
  useEffect(() => {
    setName(row.name);
    setEmail(row.email ?? '');
    setSources([]);
  }, [row.version, row.name, row.email]);

  useEffect(() => {
    let live = true;
    void rolesAction(clientId, row.id).then((result) => {
      if (live) setRoles(result.ok ? result.value : []);
    });
    return () => {
      live = false;
    };
  }, [clientId, row.id]);

  const trimmed = name.trim();
  const parsed = parseEmail(email);
  const changes = {
    ...(trimmed !== row.name ? { displayName: trimmed } : {}),
    ...(parsed !== undefined && parsed !== row.email ? { email: parsed } : {}),
  };
  const changed = Object.keys(changes).length > 0;
  const merging = others.filter((o) => sources.includes(o.id));
  const blocked =
    trimmed === ''
      ? 'Type a name first'
      : parsed === undefined
        ? 'Fix the email first'
        : parsed === null && row.emailRequired
          ? 'An active person keeps an email'
          : !changed
            ? 'Nothing has changed'
            : undefined;

  const finish = (result: { ok: boolean; message?: string }) => {
    router.refresh();
    if (!result.ok) {
      setError(result.message ?? null);
      return;
    }
    onClose();
  };

  const save = async () => {
    if (blocked) return;
    setPending(true);
    setError(null);
    const result = await updatePersonAction(clientId, row.id, { version: row.version, ...changes });
    setPending(false);
    finish(result);
  };

  return (
    <Drawer
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={row.name}
      eyebrow={`Person · ${row.status}`}
      size="md"
      dirty={changed || sources.length > 0}
      dirtyPrompt={{ title: 'Discard your changes?', body: 'What you changed here will be lost.' }}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button loading={pending} onClick={() => void save()} disabledReason={blocked}>
            Save changes
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <Input
            label="Name"
            value={name}
            maxLength={300}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label="Email"
            type="email"
            helper={
              row.emailRequired
                ? 'They sign in with this email, so it can be changed but not removed.'
                : 'Adding an email marks them invited.'
            }
            value={email}
            error={parsed === undefined ? EMAIL_ERROR : undefined}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <section aria-labelledby="roles-heading" className="flex flex-col gap-1">
          <h3 id="roles-heading" className="text-body font-semibold text-ink">
            Roles in this client
          </h3>
          {roles === null ? (
            <p role="status" className="text-body text-muted">
              Loading roles…
            </p>
          ) : roles.length === 0 ? (
            <p className="text-body text-muted">No roles here.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-body text-ink">
              {roles.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </section>
        <Alert message={error} />
        {others.length > 0 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-body font-semibold text-ink">
              Merge duplicates into {row.name}
            </legend>
            <p className="text-meta text-muted">
              For the same person entered twice. Their work moves to {row.name} and the duplicates
              are removed.
            </p>
            <div className="flex max-h-64 flex-col overflow-y-auto">
              {others.map((o) => (
                <Checkbox
                  key={o.id}
                  label={o.email ? `${o.name} (${o.email})` : o.name}
                  checked={sources.includes(o.id)}
                  onCheckedChange={(checked) =>
                    setSources((current) =>
                      checked === true ? [...current, o.id] : current.filter((id) => id !== o.id),
                    )
                  }
                />
              ))}
            </div>
            <div>
              <Button
                variant="secondary"
                onClick={() => setConfirming(true)}
                disabledReason={sources.length === 0 ? 'Choose a duplicate first' : undefined}
              >
                Merge {sources.length === 1 ? 'person' : 'people'}
              </Button>
            </div>
          </fieldset>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Merge ${merging.length === 1 ? merging[0]!.name : `${merging.length} people`} into ${row.name}?`}
        body={`${merging.map((m) => m.name).join(', ')} will be removed. Their assignments and instances move to ${row.name}, and the change is recorded in the audit trail.`}
        confirmLabel="Merge"
        tone="danger"
        onConfirm={async () => {
          setError(null);
          finish(
            await mergePeopleAction(clientId, row.id, { version: row.version, sourceIds: sources }),
          );
        }}
      />
    </Drawer>
  );
}
