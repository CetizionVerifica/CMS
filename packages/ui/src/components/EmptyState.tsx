import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  SearchX,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

import { cx } from '../lib/cx';
import { defaultLink, type LinkRenderer } from '../lib/link';
import { Button, buttonClasses } from '../primitives/Button';

export type EmptyStateVariant = 'first-use' | 'no-results' | 'no-permission' | 'error' | 'done';

export type EmptyStateProps = {
  variant: EmptyStateVariant;
  title: string;
  /** One or two sentences that say what to do. */
  body?: string;
  /** Replaces the variant's icon (for example a context icon on first use). */
  icon?: LucideIcon;
  action?: { label: string; onClick?: () => void; href?: string };
  secondary?: { label: string; href: string };
  /** `page` pads 48px and uses an h2; `card` pads 22px and uses an h3. */
  size?: 'page' | 'card';
  /** Override the heading level to fit the region's outline. */
  headingLevel?: 2 | 3 | 4;
  /** Request id from the API, shown as "Reference: 7f3a…" so support can trace it. */
  errorId?: string;
  /**
   * Announce the state with role="alert". Only when it appears after a user action (a failed retry); on first load
   * it is plain content.
   */
  announce?: boolean;
  renderLink?: LinkRenderer;
  className?: string;
};

const icons: Record<EmptyStateVariant, LucideIcon> = {
  'first-use': Sparkles,
  'no-results': SearchX,
  'no-permission': Lock,
  error: AlertTriangle,
  done: CheckCircle2,
};

/** Spec 14 · EmptyState. Nothing to show, something failed, or no access; always says what to do next. */
export function EmptyState({
  variant,
  title,
  body,
  icon,
  action,
  secondary,
  size = 'card',
  headingLevel,
  errorId,
  announce = false,
  renderLink = defaultLink,
  className,
}: EmptyStateProps) {
  const Icon = icon ?? icons[variant];
  const Heading = `h${headingLevel ?? (size === 'page' ? 2 : 3)}` as 'h2' | 'h3' | 'h4';
  const tone =
    variant === 'error'
      ? 'bg-crit-soft text-crit-ink'
      : variant === 'done'
        ? 'bg-ok-soft text-ok-ink'
        : 'bg-sage text-forest';

  return (
    <div
      role={announce && variant === 'error' ? 'alert' : undefined}
      className={cx(
        'mx-auto flex max-w-[420px] flex-col items-center text-center',
        size === 'page' ? 'p-12' : 'p-5.5',
        className,
      )}
    >
      <span
        aria-hidden
        className={cx('mb-3 inline-flex size-10 items-center justify-center rounded-pill', tone)}
      >
        <Icon size={20} />
      </span>
      <Heading className="text-section text-ink">{title}</Heading>
      {body ? <p className="mt-1 text-body text-muted">{body}</p> : null}
      {action || secondary ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action ? (
            action.href ? (
              renderLink({
                href: action.href,
                className: buttonClasses({ variant: 'primary' }),
                children: action.label,
              })
            ) : (
              <Button variant="primary" onClick={action.onClick}>
                {action.label}
              </Button>
            )
          ) : null}
          {secondary
            ? renderLink({
                href: secondary.href,
                className: buttonClasses({ variant: 'ghost' }),
                children: secondary.label,
              })
            : null}
        </div>
      ) : null}
      {errorId ? (
        <p className="mt-3 text-meta text-muted">
          Reference: <span className="tabular">{errorId}</span>
        </p>
      ) : null}
    </div>
  );
}
