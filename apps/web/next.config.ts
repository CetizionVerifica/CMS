import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@canopy/contracts', '@canopy/ui'],
};

export default config;
