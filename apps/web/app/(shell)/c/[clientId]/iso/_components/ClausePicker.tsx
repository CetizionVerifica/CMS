'use client';
// Picks the clauses a record answers to: type to find a clause of the system's standards, add it, remove it again.
import { Combobox, IconButton } from '@canopy/ui';
import { X } from 'lucide-react';
import { useState } from 'react';

export type ClauseOption = { id: string; label: string };

export function ClausePicker({
  label,
  helper,
  options,
  value,
  onChange,
  max = 50,
}: {
  label: string;
  helper?: string;
  options: readonly ClauseOption[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  max?: number;
}) {
  const [key, setKey] = useState(0);
  const left = options.filter((o) => !value.includes(o.id));
  return (
    <div className="flex flex-col gap-2">
      {value.length < max ? (
        <Combobox
          key={key}
          label={label}
          helper={helper}
          options={left.map((o) => ({ value: o.id, label: o.label }))}
          value={null}
          placeholder="Type a clause number or title"
          emptyText="No clause matches"
          onValueChange={(id) => {
            if (id) onChange([...value, id]);
            setKey((k) => k + 1);
          }}
        />
      ) : (
        <p className="text-meta text-muted">{`${label}: at most ${max}.`}</p>
      )}
      {value.length > 0 ? (
        <ul aria-label={`${label} chosen`} className="flex flex-wrap gap-2">
          {value.map((id) => {
            const name = options.find((o) => o.id === id)?.label ?? 'A clause no longer listed';
            return (
              <li
                key={id}
                className="inline-flex items-center gap-1 rounded-pill border border-line py-0.5 pr-0.5 pl-2.5 text-meta text-ink"
              >
                {name}
                <IconButton
                  size="sm"
                  label={`Remove ${name}`}
                  icon={X}
                  onClick={() => onChange(value.filter((v) => v !== id))}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
