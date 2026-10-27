'use client';
// Picks one register instance: the activity that raised a nonconformity (`sourceInstanceId`), or the statutory notice
// an incident needs (`statutoryInstanceId`, model §3.11). The person searches the register by words, the results are
// the API's own search (their units only), and the choice shows by name with a way to clear it.
import type { InstanceRow } from '@canopy/contracts';
import { Button, formatDate, Input, RadioGroup } from '@canopy/ui';
import { useId, useState } from 'react';

import { isoRead } from '../_lib/actions';
import { FormAlert } from './controls';

export type InstanceChoice = { id: string; label: string };

const RESULTS = '10';

/** How an instance reads in a picker or on a record: what, where and when it is due. */
export function instanceLabel(i: Pick<InstanceRow, 'title' | 'unitName' | 'dueDate'>): string {
  return `${i.title} · ${i.unitName} · due ${formatDate(i.dueDate)}`;
}

export function InstancePicker({
  clientId,
  label,
  helper,
  value,
  onChange,
  unitId,
  statutoryOnly,
}: {
  clientId: string;
  label: string;
  helper?: string;
  value: InstanceChoice | null;
  onChange: (choice: InstanceChoice | null) => void;
  /** Only this unit's instances. */
  unitId?: string | null;
  /** Only instances of statutory acts (not the ISO activities). */
  statutoryOnly?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [found, setFound] = useState<InstanceChoice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (text.trim().length < 2) {
      setError('Type at least two letters.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await isoRead(
      clientId,
      'listInstances',
      {},
      {
        q: text.trim(),
        limit: RESULTS,
        ...(unitId ? { unitId } : {}),
        ...(statutoryOnly ? { source: 'LAW' as const } : {}),
      },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setFound(result.data.items.map((i) => ({ id: i.id, label: instanceLabel(i) })));
  };

  if (value) {
    return (
      <div className="flex flex-col gap-1">
        <p id={id} className="text-meta text-ink">
          {label}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span aria-labelledby={id} className="text-body text-ink">
            {value.label}
          </span>
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            {`Remove ${label.toLowerCase()}`}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-meta text-ink">{label}</legend>
      {helper ? <p className="text-meta text-muted">{helper}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <Input
            label="Search the register"
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void search();
              }
            }}
          />
        </div>
        <Button size="sm" loading={busy} onClick={() => void search()}>
          Search
        </Button>
      </div>
      <FormAlert message={error} />
      {found && found.length === 0 ? (
        <p role="status" className="text-body text-muted">
          Nothing in the register matches.
        </p>
      ) : null}
      {found && found.length > 0 ? (
        <RadioGroup
          label="Matching instances"
          options={found.map((f) => ({ value: f.id, label: f.label }))}
          value=""
          onValueChange={(v) => {
            const choice = found.find((f) => f.id === v);
            if (choice) onChange(choice);
          }}
        />
      ) : null}
    </fieldset>
  );
}
