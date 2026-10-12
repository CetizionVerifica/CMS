/**
 * What clients see in every email. The product's client-facing name is "PlanetPulse Compliance"; the internal
 * working name never appears in user-facing text. Colours mirror packages/ui/src/tokens.ts (forest, ink, muted,
 * line, mist, surface, crit-ink, warn-ink); emails inline them because mail clients ignore stylesheets.
 */
export const PRODUCT_NAME = 'PlanetPulse Compliance';

export const EMAIL_COLORS = {
  forest: '#1F6B47',
  onForest: '#FFFFFF',
  ink: '#13221A',
  muted: '#5F6F66',
  line: '#E1E7E2',
  mist: '#F5F7F4',
  surface: '#FFFFFF',
  critInk: '#A8391F',
  warnInk: '#8C5C04',
} as const;
