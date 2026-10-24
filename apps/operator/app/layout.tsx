import '@fontsource-variable/plus-jakarta-sans/wght.css';
import './globals.css';

import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

import { CONSOLE_NAME } from '../lib/brand';

export const metadata: Metadata = {
  title: { default: CONSOLE_NAME, template: `%s · ${CONSOLE_NAME}` },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1F6B47' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Rendered per request, so every page carries the nonce its Content-Security-Policy allows (proxy.ts).
  await connection();
  return (
    <html lang="en-IN">
      <body className="bg-mist text-ink">{children}</body>
    </html>
  );
}
