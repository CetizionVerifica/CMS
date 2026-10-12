// Client-facing product name. Shown in the sidebar, page titles and auth pages. The internal codename never appears
// in UI text.
export const PRODUCT_NAME = 'PlanetPulse Compliance';

/** Document title: "Register · Demo Metals · PlanetPulse Compliance". Empty parts are dropped. */
export function documentTitle(...parts: (string | undefined | null)[]): string {
  return [...parts.filter((p): p is string => !!p && p.trim() !== ''), PRODUCT_NAME].join(' · ');
}
