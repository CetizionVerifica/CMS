import { Avatar as RadixAvatar } from 'radix-ui';

import { cx } from '../lib/cx';

export type AvatarSize = 24 | 32 | 40;

const sizes: Record<AvatarSize, string> = {
  24: 'size-6 text-meta',
  32: 'size-8 text-meta',
  40: 'size-10 text-meta',
};

/** Initials from a name: first letter of the first and last words ("Priya Rane" → "PR"). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
}

export type AvatarProps = {
  name: string;
  src?: string;
  size?: AvatarSize;
  /** Hide from assistive tech when the name is printed next to the avatar. */
  decorative?: boolean;
  className?: string;
};

/** Spec 00 · Avatar. Circle; initials in forest 700 on sage (5.08:1), or the image with alt = name. */
export function Avatar({ name, src, size = 32, decorative = false, className }: AvatarProps) {
  return (
    <RadixAvatar.Root
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-pill bg-sage font-bold text-forest',
        sizes[size],
        className,
      )}
    >
      {src ? <RadixAvatar.Image src={src} alt="" className="size-full object-cover" /> : null}
      <RadixAvatar.Fallback aria-hidden {...(src ? { delayMs: 300 } : {})}>
        {initials(name)}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  );
}

export type AvatarGroupProps = {
  people: { name: string; src?: string }[];
  max?: number;
  size?: AvatarSize;
};

/** Shows up to `max` (default 3) avatars then "+N"; the group's accessible name lists everyone. */
export function AvatarGroup({ people, max = 3, size = 24 }: AvatarGroupProps) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <span
      role="img"
      aria-label={people.map((p) => p.name).join(', ')}
      className="inline-flex items-center"
    >
      {shown.map((p, i) => (
        <Avatar
          key={`${p.name}-${i}`}
          name={p.name}
          src={p.src}
          size={size}
          decorative
          className={cx('ring-2 ring-surface', i > 0 && '-ml-1.5')}
        />
      ))}
      {extra > 0 ? (
        <span
          aria-hidden
          className="-ml-1.5 inline-flex h-6 min-w-6 items-center justify-center rounded-pill bg-neutral-soft px-1 text-meta font-bold text-ink ring-2 ring-surface"
        >
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
