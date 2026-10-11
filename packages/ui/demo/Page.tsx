import type { ReactNode } from 'react';

import { Link } from '../src';

/** Frame for a gallery page: back link, one h1, and sections with h2s. */
export function Page({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-mist">
      <header className="border-b border-line bg-surface px-4 py-3 sm:px-5.5">
        <Link href="#/">All components</Link>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-5.5 px-4 py-5.5 sm:px-5.5">
        <div>
          <h1 className="text-page text-ink">{title}</h1>
          {intro ? <p className="mt-1 text-body text-muted">{intro}</p> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

export function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className="rounded-card border border-line bg-surface px-4 py-3.5">
      <h2 className="mb-3 text-card text-ink">{title}</h2>
      <div className={className ?? 'flex flex-wrap items-center gap-3'}>{children}</div>
    </section>
  );
}
