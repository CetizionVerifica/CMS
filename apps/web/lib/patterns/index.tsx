'use client';
// Page patterns every screen uses (apps/web/CLAUDE.md "Every page has loading, empty, error and no-permission
// states"). They take plain props, so Server Components can render them; M12 and M13 import them from here.
import { KNOWN_FEATURES, type KnownFeature } from '@canopy/contracts';
import { EmptyState, Skeleton } from '@canopy/ui';
import NextLink from 'next/link';
import type { ReactNode } from 'react';

const link = ({
  href,
  children,
  ...rest
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) => (
  // No prefetch, like the shell's links (ShellFrame.tsx): each one would render a page and call the API.
  <NextLink href={href} prefetch={false} {...rest}>
    {children}
  </NextLink>
);

/** The page's one h1, an optional line under it and actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-page text-ink">{title}</h1>
        {description ? <p className="mt-1 text-body text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** Skeleton for a page while its data loads: the h1 slot, a row of cards and a table. One message for readers. */
export function PageLoading({ label = 'Loading page' }: { label?: string }) {
  return (
    <div aria-busy="true">
      <span role="status" className="sr-only">
        {label}
      </span>
      <div aria-hidden>
        <Skeleton className="mb-4 h-7 w-56" />
        <div className="mb-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-card" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-card" />
      </div>
    </div>
  );
}

/** Nothing to show yet. Says what to do next. */
export function PageEmpty({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: { label: string; href: string };
}) {
  return (
    <section className="rounded-card border border-line bg-surface">
      <EmptyState
        variant="first-use"
        size="page"
        title={title}
        body={body}
        action={action}
        renderLink={link}
      />
    </section>
  );
}

/** The user is signed in but their role can't open this page. */
export function NoPermission({
  what = 'this page',
  backHref,
  backLabel = 'Go back',
}: {
  what?: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <section className="rounded-card border border-line bg-surface">
      <h1 className="sr-only">No access</h1>
      <EmptyState
        variant="no-permission"
        size="page"
        title={`You don’t have access to ${what}`}
        body="Ask your consultant or client admin if you need it."
        action={backHref ? { label: backLabel, href: backHref } : undefined}
        renderLink={link}
      />
    </section>
  );
}

/**
 * A page of an add-on the account doesn't have (ADR M16-0001): says so, shows none of its data and links home. Only
 * PlanetPulse turns add-ons on, so it names who to ask rather than offering a switch.
 */
export function FeatureNotEnabled({
  feature = 'isoManagement',
  homeHref,
}: {
  feature?: KnownFeature;
  homeHref: string;
}) {
  const label = KNOWN_FEATURES.find((f) => f.code === feature)?.label ?? 'This add-on';
  return (
    <section className="rounded-card border border-line bg-surface">
      <h1 className="sr-only">{label}</h1>
      <EmptyState
        variant="no-permission"
        size="page"
        title={`${label} is not turned on for your account`}
        body="Your account admin can ask PlanetPulse to turn it on."
        action={{ label: 'Go to home', href: homeHref }}
        renderLink={link}
      />
    </section>
  );
}

/** Something failed. `onRetry` re-renders the segment (error.tsx's `reset`). */
export function PageError({
  title = 'This page didn’t load',
  body = 'Something went wrong on our side. Try again, and if it keeps happening, share the reference with support.',
  reference,
  onRetry,
  homeHref,
}: {
  title?: string;
  body?: string;
  reference?: string;
  onRetry?: () => void;
  homeHref?: string;
}) {
  return (
    <section className="rounded-card border border-line bg-surface">
      <h1 className="sr-only">Error</h1>
      <EmptyState
        variant="error"
        size="page"
        title={title}
        body={body}
        errorId={reference}
        action={onRetry ? { label: 'Try again', onClick: onRetry } : undefined}
        secondary={homeHref ? { label: 'Go to home', href: homeHref } : undefined}
        renderLink={link}
      />
    </section>
  );
}

/** Placeholder for a route whose module hasn't shipped its page yet (the `[...stub]` pages). */
export function ComingSoon({ title, homeHref }: { title: string; homeHref?: string }) {
  return (
    <>
      <PageHeader title={title} />
      <section className="rounded-card border border-line bg-surface">
        <EmptyState
          variant="first-use"
          size="page"
          title={`${title} is coming soon`}
          body="This part of the app is being built. Everything else in the menu works as usual."
          secondary={homeHref ? { label: 'Go to home', href: homeHref } : undefined}
          renderLink={link}
        />
      </section>
    </>
  );
}

/** A link to a page that doesn't exist, or a record the user can't see (the API answers 404 for both). */
export function NotFoundState() {
  return (
    <section className="rounded-card border border-line bg-surface">
      <h1 className="sr-only">Page not found</h1>
      <EmptyState
        variant="no-results"
        size="page"
        title="We couldn’t find that page"
        body="The link may be out of date, or the page may belong to a client you can’t see."
        action={{ label: 'Go to home', href: '/' }}
        renderLink={link}
      />
    </section>
  );
}
