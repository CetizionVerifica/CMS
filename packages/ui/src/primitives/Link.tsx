import { ExternalLink } from 'lucide-react';
import { Slot } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { cx } from '../lib/cx';

export type LinkProps = ComponentPropsWithRef<'a'> & {
  /** Opens in a new tab with rel="noopener noreferrer" and an ExternalLink icon. */
  external?: boolean;
  /** Inside body copy the underline is always shown. */
  inline?: boolean;
  /** Render the child (for example Next's Link) with link styles. */
  asChild?: boolean;
};

export const linkClasses = (inline?: boolean) =>
  cx(
    'inline-flex items-center gap-1 font-semibold text-forest underline-offset-2',
    inline ? 'underline' : 'hover:underline focus-visible:underline',
  );

/** Spec 00 · Link. Forest 600, underline on hover and focus; always underlined inside body copy. */
export function Link({ external, inline, asChild, className, children, ...rest }: LinkProps) {
  const Comp = asChild ? Slot.Root : 'a';
  return (
    <Comp
      {...rest}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={cx(linkClasses(inline), className)}
    >
      <Slot.Slottable>{children}</Slot.Slottable>
      {external ? (
        <>
          <ExternalLink aria-hidden size={14} />
          <span className="sr-only">{' (opens in a new tab)'}</span>
        </>
      ) : null}
    </Comp>
  );
}
