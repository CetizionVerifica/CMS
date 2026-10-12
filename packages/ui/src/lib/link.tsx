import type { AnchorHTMLAttributes, ReactElement, ReactNode } from 'react';

/** Renders a link. Apps pass Next's Link; the default is a plain anchor. */
export type LinkRenderer = (
  props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode },
) => ReactElement;

export const defaultLink: LinkRenderer = ({ children, ...props }) => <a {...props}>{children}</a>;
