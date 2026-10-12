import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@canopy/contracts', '@canopy/ui'],
  poweredByHeader: false,
  // @canopy/contracts uses NodeNext-style `./x.js` specifiers for its `.ts` files. Turbopack can't map those yet, so
  // the app builds with webpack (`--webpack` in package.json) and maps `.js` to the TypeScript source here.
  webpack(webpackConfig: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    webpackConfig.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return webpackConfig;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Asks Chromium to send the viewport width, so the server can render the right shell layout on later
          // requests (lib/layout-hint.ts). Other browsers ignore it and the layout cookie covers them.
          { key: 'Accept-CH', value: 'Sec-CH-Viewport-Width, Sec-CH-UA-Mobile' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
