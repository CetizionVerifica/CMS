import {
  CRITICALITY_ORDER,
  CriticalityTag,
  DERIVED_STATUSES,
  StatusPill,
  type DerivedStatus,
} from '../../src';
import { Page, Section } from '../Page';

const examples: Array<{ status: DerivedStatus; days?: number; dueDate?: string }> = [
  { status: 'DUE_SOON', days: 0 },
  { status: 'DUE_SOON', days: 1 },
  { status: 'OVERDUE', days: 1 },
  { status: 'OVERDUE', days: 120, dueDate: '2022-06-07' },
];

export function StatusPage() {
  return (
    <Page
      title="StatusPill and CriticalityTag"
      intro="Fixed vocabulary from spec/status-language.md. Status is a round pill, criticality a square tag."
    >
      <Section title="Every status (md, 12 days)">
        {DERIVED_STATUSES.map((s) => (
          <StatusPill key={s} status={s} days={12} />
        ))}
      </Section>
      <Section title="With icons">
        {DERIVED_STATUSES.map((s) => (
          <StatusPill key={s} status={s} days={3} withIcon />
        ))}
      </Section>
      <Section title="Small, for dense tables">
        {DERIVED_STATUSES.map((s) => (
          <StatusPill key={s} status={s} days={3} size="sm" />
        ))}
      </Section>
      <Section title="Day counts">
        {examples.map((e) => (
          <StatusPill key={`${e.status}-${e.days}`} {...e} />
        ))}
      </Section>
      <Section title="On mist">
        <div className="flex flex-wrap gap-3 rounded-chip bg-mist p-3">
          {DERIVED_STATUSES.map((s) => (
            <StatusPill key={s} status={s} days={5} />
          ))}
        </div>
      </Section>
      <Section title="Criticality">
        {CRITICALITY_ORDER.map((l) => (
          <CriticalityTag key={l} level={l} />
        ))}
        {CRITICALITY_ORDER.map((l) => (
          <CriticalityTag key={`${l}-sm`} level={l} size="sm" />
        ))}
      </Section>
      <Section title="Side by side in a row">
        <span className="inline-flex items-center gap-2 text-body-strong text-ink">
          TAX-CL-033 Tax collection at source
          <StatusPill status="OVERDUE" days={5} size="sm" />
          <CriticalityTag level="SUPER_CRITICAL" size="sm" />
        </span>
      </Section>
    </Page>
  );
}
