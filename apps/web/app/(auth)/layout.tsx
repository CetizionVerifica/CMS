import type { ReactNode } from 'react';

import { AuthBrand } from '../../lib/auth/AuthBrand';

// Signed-out pages: no shell, one centred card.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main
      id="main"
      className="flex min-h-screen flex-col items-center px-4 py-12 sm:justify-center"
    >
      <AuthBrand />
      <div className="w-full max-w-[400px] rounded-card border border-line bg-surface p-5.5">
        {children}
      </div>
    </main>
  );
}
