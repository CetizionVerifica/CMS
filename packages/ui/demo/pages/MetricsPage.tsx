import { useState } from 'react';

import { KpiCard, ProgressBar, ScoreRing } from '../../src';
import { Page, Section } from '../Page';

// Golden fixture counts (docs/requirements/excel-analysis.md §5): 424 instances, 211 complied, 201 pending, 12 NA.
const departments = [
  { name: 'Human resources', value: 82, ok: 120, warn: 18, crit: 8, na: 2 },
  { name: 'EHS', value: 64, ok: 41, warn: 12, crit: 11, na: 4 },
  { name: 'Finance and tax', value: 91, ok: 50, warn: 3, crit: 2, na: 3 },
];

export function MetricsPage() {
  const [errored, setErrored] = useState(true);
  return (
    <Page
      title="KpiCard, ScoreRing and ProgressBar"
      intro="Numbers come from the API; the components only format them."
    >
      <Section title="KPI row" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Compliance score"
          value="78%"
          visual={<ScoreRing value={78} label="Compliance score" />}
          context={{ text: '6 pts this month', tone: 'ok', trend: 'up' }}
          href="#/metrics"
        />
        <KpiCard
          label="Open"
          value={201}
          unit="of 424"
          context={{ text: '9 due this week', tone: 'warn' }}
          href="#/metrics"
        />
        <KpiCard
          label="Overdue"
          value={5}
          context={{ text: '2 super critical', tone: 'crit' }}
          href="#/metrics"
        />
        <KpiCard
          label="Awaiting approval"
          value={0}
          context={{ text: 'Nothing waiting', tone: 'neutral' }}
        />
      </Section>
      <Section title="KPI states" className="grid gap-3 sm:grid-cols-3">
        <KpiCard label="Open" value={0} loading />
        {errored ? (
          <KpiCard
            label="Overdue"
            value={0}
            error="Couldn't load"
            onRetry={() => setErrored(false)}
          />
        ) : (
          <KpiCard label="Overdue" value={0} context={{ text: 'Nothing overdue', tone: 'ok' }} />
        )}
        <KpiCard label="Instances this FY" value={1234567} unit="total" />
      </Section>
      <Section title="ScoreRing">
        <ScoreRing value={78} size="sm" label="Score" />
        <ScoreRing value={78} size="md" label="Score" />
        <ScoreRing value={78} size="lg" label="Compliance score" />
        <ScoreRing value={94} size="lg" tone="status" band="ok" label="Unit score" />
        <ScoreRing value={72} size="lg" tone="status" band="warn" label="Unit score" />
        <ScoreRing value={41} size="lg" tone="status" band="crit" label="Unit score" />
        <ScoreRing value={null} size="lg" label="New client score" />
      </Section>
      <Section title="Readiness by department" className="flex flex-col gap-3">
        {departments.map((d) => (
          <div key={d.name} className="grid items-center gap-2 sm:grid-cols-[180px_1fr]">
            <span className="text-body-strong text-ink">{d.name}</span>
            <ProgressBar label={d.name} value={d.value} />
          </div>
        ))}
        <ProgressBar
          label="EHS (at risk)"
          showLabel
          variant="tone"
          band="crit"
          value={41}
          max={68}
          valueFormat="count"
        />
        <ProgressBar label="Legal" showLabel value={0} loading />
        <ProgressBar label="In a table cell" showLabel value={55} width="table" />
      </Section>
      <Section title="Status by department (stacked)" className="flex flex-col gap-4">
        {departments.map((d) => (
          <ProgressBar
            key={d.name}
            variant="stacked"
            label={d.name}
            showLabel
            segments={[
              { key: 'ok', label: 'Complied', count: d.ok },
              { key: 'warn', label: 'Due soon', count: d.warn },
              { key: 'crit', label: 'Overdue', count: d.crit },
              { key: 'neutral', label: 'Not applicable', count: d.na },
            ]}
          />
        ))}
      </Section>
    </Page>
  );
}
