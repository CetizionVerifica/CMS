import { contrastRatio, tokens } from '../../src';
import { Page, Section } from '../Page';

const textPairs: Array<[string, tokens.ColorToken, tokens.ColorToken]> = [
  ['Ink on mist', 'ink', 'mist'],
  ['Muted on mist', 'muted', 'mist'],
  ['Muted on surface', 'muted', 'surface'],
  ['On-forest on forest', 'on-forest', 'forest'],
  ['On-forest-muted on forest', 'on-forest-muted', 'forest'],
  ['Forest on sage', 'forest', 'sage'],
  ['Ok-ink on ok-soft', 'ok-ink', 'ok-soft'],
  ['Warn-ink on warn-soft', 'warn-ink', 'warn-soft'],
  ['Crit-ink on crit-soft', 'crit-ink', 'crit-soft'],
];

// Literal class names so Tailwind finds them.
const typeClass: Record<keyof typeof tokens.type, string> = {
  kpi: 'text-kpi',
  page: 'text-page',
  section: 'text-section',
  card: 'text-card',
  body: 'text-body',
  'body-strong': 'text-body-strong',
  meta: 'text-meta',
  label: 'text-label uppercase',
};

export function TokensPage() {
  return (
    <Page
      title="Tokens"
      intro="Values from src/tokens.css. Every colour, size and duration in a component comes from here."
    >
      <Section title="Colour" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Object.entries(tokens.colors).map(([name, value]) => (
          <div key={name} className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-8 shrink-0 rounded-chip border border-line"
              style={{ background: `var(--${name})` }}
            />
            <span className="min-w-0">
              <span className="block truncate text-meta text-ink">--{name}</span>
              <span className="block truncate text-meta text-muted">{value}</span>
            </span>
          </div>
        ))}
      </Section>
      <Section
        title="Text contrast (WCAG 2.2, 4.5:1 minimum)"
        className="grid gap-2 sm:grid-cols-3"
      >
        {textPairs.map(([label, fg, bg]) => (
          <p
            key={label}
            className="rounded-chip px-3 py-2 text-body"
            style={{ color: `var(--${fg})`, background: `var(--${bg})` }}
          >
            {label}{' '}
            <span className="tabular">
              {contrastRatio(tokens.colors[fg], tokens.colors[bg]).toFixed(2)}:1
            </span>
          </p>
        ))}
      </Section>
      <Section title="Type" className="flex flex-col gap-2">
        {Object.entries(tokens.type).map(([name, t]) => (
          <p key={name} className={`${typeClass[name as keyof typeof tokens.type]} text-ink`}>
            type-{name} · {t.size}/{t.lineHeight} · {t.weight}
          </p>
        ))}
      </Section>
      <Section title="Spacing and radius" className="flex flex-wrap items-end gap-4">
        {Object.entries(tokens.space).map(([name, value]) => (
          <div key={name} className="flex flex-col items-center gap-1">
            <span aria-hidden className="block bg-leaf" style={{ width: value, height: value }} />
            <span className="text-meta text-muted">space-{name}</span>
          </div>
        ))}
        {Object.entries(tokens.radius).map(([name, value]) => (
          <div key={name} className="flex flex-col items-center gap-1">
            <span
              aria-hidden
              className="block size-10 border border-line-strong bg-sage"
              style={{ borderRadius: value }}
            />
            <span className="text-meta text-muted">radius-{name}</span>
          </div>
        ))}
      </Section>
    </Page>
  );
}
