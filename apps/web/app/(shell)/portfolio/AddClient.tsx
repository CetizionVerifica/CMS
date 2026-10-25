'use client';
// "Add a client", for account admins of a consultancy account: a new client starts empty, so this goes straight to its
// setup, where its companies and units come first (then People, Departments and the import).
import { Button, Input } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { addClientAction } from './actions';

export function AddClient() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '' || pending) return;
    setPending(true);
    setError(null);
    setAdded(null);
    const result = await addClientAction(trimmed);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setName('');
    setAdded(`${trimmed} was added. Opening its setup.`);
    router.push(`/c/${result.id}/setup/entities`);
  };

  return (
    <section aria-labelledby="add-client-heading" className="flex max-w-2xl flex-col gap-3">
      <h2 id="add-client-heading" className="text-card text-ink">
        Add a client
      </h2>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Input
          label="Client name"
          helper="The customer’s group name, for example Kestrel Metals Group."
          value={name}
          maxLength={300}
          onChange={(e) => setName(e.target.value)}
        />
        {error ? (
          <p role="alert" className="text-body text-crit-ink">
            {error}
          </p>
        ) : null}
        <div>
          <Button
            type="submit"
            loading={pending}
            disabledReason={name.trim() === '' ? 'Type a name first' : undefined}
          >
            Add client
          </Button>
        </div>
      </form>
      <p role="status" className="text-body text-ok-ink">
        {added}
      </p>
    </section>
  );
}
