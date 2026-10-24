import type { NextConfig } from 'next';

// The operator API, reached from the browser at /api/platform: the `op_sid` cookie is scoped to that path, so the
// console's pages never see it. In production the load balancer sends /api/platform straight to the API; this rewrite
// is for `next dev` and for a deployment without one. OPERATOR_API_URL is the API's origin, never the customer app's;
// Next reads it when it builds the routes, so set it for `next build` too.
const apiOrigin = (process.env.OPERATOR_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

const config: NextConfig = {
  transpilePackages: ['@canopy/contracts', '@canopy/ui'],
  poweredByHeader: false,
  // Same as apps/web: the contracts use `./x.js` specifiers for `.ts` files, which webpack maps here.
  webpack(webpackConfig: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    webpackConfig.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return webpackConfig;
  },
  async rewrites() {
    return [{ source: '/api/platform/:path*', destination: `${apiOrigin}/api/platform/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};

export default config;
