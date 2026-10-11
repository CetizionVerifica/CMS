// Canopy design tokens as data. `tokens.css` is the source of truth for the browser; this file mirrors it so
// `tailwind.preset.ts`, the contrast test and charts can read the same values. `tokens.test.ts` fails if they drift.
// Spec: spec/foundations.md and spec/tokens.json.

export const colors = {
  forest: '#1F6B47',
  'forest-hover': '#185A3B',
  leaf: '#2F8F60',
  moss: '#A9C97A',
  sage: '#D9E8DC',
  mist: '#F5F7F4',
  surface: '#FFFFFF',
  ink: '#13221A',
  muted: '#5F6F66',
  line: '#E1E7E2',
  'line-strong': '#7A8A81',
  ok: '#1E8A55',
  warn: '#B97A06',
  crit: '#C0442A',
  'ok-ink': '#176B42',
  'warn-ink': '#8C5C04',
  'crit-ink': '#A8391F',
  'ok-soft': '#E3F3EA',
  'warn-soft': '#FBF0D9',
  'crit-soft': '#FBE5DF',
  'neutral-soft': '#EEF1EF',
  'on-forest': '#FFFFFF',
  'on-forest-muted': '#CFE3D6',
  'on-forest-hover': 'rgba(255,255,255,0.08)',
  'on-forest-selected': 'rgba(255,255,255,0.13)',
  scrim: 'rgba(19,34,26,0.40)',
} as const;

export type ColorToken = keyof typeof colors;

export const space = {
  '1': '4px',
  '2': '8px',
  '3': '12px',
  '3h': '14px',
  '4': '16px',
  '5': '22px',
  '6': '32px',
  '7': '48px',
} as const;

export const radius = {
  card: '12px',
  control: '9px',
  chip: '8px',
  tag: '6px',
  pill: '999px',
} as const;

export const size = {
  control: '36px',
  'control-compact': '32px',
  'control-touch': '44px',
  sidebar: '212px',
  rail: '64px',
  topbar: '56px',
  'drawer-lg': '560px',
  'drawer-md': '480px',
} as const;

export const shadow = {
  overlay: '0 12px 32px -12px rgba(19,34,26,.28), 0 2px 6px rgba(19,34,26,.08)',
} as const;

export const zIndex = {
  sticky: 10,
  shell: 20,
  drawer: 40,
  popover: 50,
  dialog: 60,
  toast: 70,
} as const;

export const motion = {
  'ease-out': 'cubic-bezier(.2,0,0,1)',
  'dur-fast': '120ms',
  'dur-base': '200ms',
  'dur-slow': '260ms',
} as const;

export const breakpoints = { sm: '640px', lg: '1100px' } as const;

export const fontFamily = [
  'Plus Jakarta Sans',
  'Plus Jakarta Sans Variable',
  'system-ui',
  '-apple-system',
  'Segoe UI',
  'sans-serif',
] as const;

type TypeStyle = {
  size: string;
  lineHeight: string;
  weight: number;
  tracking?: string;
  uppercase?: boolean;
};

export const type = {
  kpi: { size: '26px', lineHeight: '30px', weight: 800, tracking: '-0.02em' },
  page: { size: '20px', lineHeight: '26px', weight: 800, tracking: '-0.01em' },
  section: { size: '16px', lineHeight: '22px', weight: 700 },
  card: { size: '14px', lineHeight: '20px', weight: 800 },
  body: { size: '14px', lineHeight: '21px', weight: 500 },
  'body-strong': { size: '14px', lineHeight: '21px', weight: 700 },
  meta: { size: '12px', lineHeight: '16px', weight: 600 },
  label: { size: '12px', lineHeight: '16px', weight: 600, tracking: '0.05em', uppercase: true },
} as const satisfies Record<string, TypeStyle>;

/** Categorical chart series order (foundations §1.5). */
export const chartSeries = [
  'forest',
  'leaf',
  'moss',
  'muted',
] as const satisfies readonly ColorToken[];
