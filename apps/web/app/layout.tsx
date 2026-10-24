import '@fontsource-variable/plus-jakarta-sans/wght.css';
import './globals.css';

import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

import { PRODUCT_NAME } from '../lib/brand';

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
  description: 'Statutory compliance register, approvals and evidence.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1F6B47' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page renders per request, so each gets the nonce its Content-Security-Policy allows (proxy.ts). A page
  // prerendered at build time would carry scripts without it, which the browser would refuse to run.
  await connection();
  return (
    <html lang="en-IN">
      <body className="bg-mist text-ink">{children}</body>
    </html>
  );
}
