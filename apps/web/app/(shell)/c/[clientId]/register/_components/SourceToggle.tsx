'use client';
// The Source filter as three buttons (Law and ISO, Law, ISO), for the pages without a FilterBar: the approvals inbox and
// the calendar. The register and the evidence vault show the same filter as a FilterBar chip (../_lib/source.ts).
import type { ActivitySource } from '@canopy/contracts';
import { Button } from '@canopy/ui';

import { SOURCE_OPTIONS } from '../_lib/source';

const CHOICES: readonly { value: ActivitySource | undefined; label: string }[] = [
  { value: undefined, label: 'Law and ISO' },
  ...SOURCE_OPTIONS,
];

export function SourceToggle({
  value,
  onChange,
  className,
}: {
  value: ActivitySource | undefined;
  onChange: (next: ActivitySource | undefined) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label="Source" className={`flex flex-wrap gap-1 ${className ?? ''}`}>
      {CHOICES.map((choice) => (
        <Button
          key={choice.label}
          size="sm"
          variant={value === choice.value ? 'primary' : 'ghost'}
          aria-pressed={value === choice.value}
          onClick={() => {
            if (value !== choice.value) onChange(choice.value);
          }}
        >
          {choice.label}
        </Button>
      ))}
    </div>
  );
}
