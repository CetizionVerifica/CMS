// Gallery routes, shared by the demo app and the Playwright suite (e2e/gallery.spec.ts visits every one).
export const galleryRoutes = [
  { path: '/tokens', title: 'Tokens', spec: 'foundations' },
  { path: '/button', title: 'Button and IconButton', spec: '00' },
  { path: '/fields', title: 'Form controls', spec: '00' },
  { path: '/overlays', title: 'Tabs, menus, popover and tooltip', spec: '00' },
  { path: '/display', title: 'Avatar, badge, skeleton and link', spec: '00' },
  { path: '/app-shell', title: 'AppShell', spec: '01' },
  { path: '/context', title: 'ClientSwitcher, PeriodPicker and DateInput', spec: '02-03' },
  { path: '/metrics', title: 'KpiCard, ScoreRing and ProgressBar', spec: '04-06' },
  { path: '/status', title: 'StatusPill and CriticalityTag', spec: '07-08' },
] as const;

export type GalleryPath = (typeof galleryRoutes)[number]['path'];

/** Full-page shell variants (query strings for #/shell). */
export const shellVariants = [
  { label: 'Desktop sidebar, 4 waiting', query: 'layout=sidebar&badge=4', width: 1280 },
  { label: 'Rail, 120 waiting', query: 'layout=rail&badge=120', width: 900 },
  { label: 'Sheet, long client name', query: 'layout=sheet&client=long', width: 375 },
  { label: 'No client selected', query: 'layout=sidebar&client=none', width: 1280 },
  { label: 'Badge 0', query: 'layout=sidebar&badge=0', width: 1280 },
] as const;
