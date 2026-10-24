'use client';
// The wizard's progress: four steps, the current one marked for screen readers (aria-current="step").
import { cx } from '@canopy/ui';
import { Check } from 'lucide-react';

import { STEPS, type WizardStep } from './import-model';

export function ImportSteps({ current, done = false }: { current: WizardStep; done?: boolean }) {
  const index = STEPS.findIndex((s) => s.key === current);
  return (
    <ol aria-label="Import steps" className="mb-4 flex flex-wrap gap-x-5 gap-y-2">
      {STEPS.map((step, i) => {
        const complete = done || i < index;
        const active = !done && i === index;
        return (
          <li
            key={step.key}
            aria-current={active ? 'step' : undefined}
            className={cx(
              'flex items-center gap-2 text-body',
              active ? 'font-semibold text-ink' : 'text-muted',
            )}
          >
            <span
              aria-hidden="true"
              className={cx(
                'flex size-6 items-center justify-center rounded-full border text-meta tabular',
                complete
                  ? 'border-forest bg-forest text-on-forest'
                  : active
                    ? 'border-forest text-forest'
                    : 'border-line-strong',
              )}
            >
              {complete ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span>
              {step.label}
              {complete ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
