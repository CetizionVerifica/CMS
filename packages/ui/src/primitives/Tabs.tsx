import { Tabs as RadixTabs } from 'radix-ui';
import { useEffect, useRef, useState, type ComponentPropsWithRef, type RefObject } from 'react';

import { cx } from '../lib/cx';

/** Spec 00 · Tabs. Radix Tabs: arrow keys move, Home/End jump, the list is one tab stop. */
export function Tabs({ className, ...props }: ComponentPropsWithRef<typeof RadixTabs.Root>) {
  return <RadixTabs.Root {...props} className={cx('flex flex-col', className)} />;
}

/** Which ends of a scrolling tab list have hidden tabs behind them. */
function useOverflowEdges(ref: RefObject<HTMLDivElement | null>) {
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [ref]);
  return edges;
}

const FADE = '24px';

/** Overflow scrolls horizontally, with a fade at each end that has more tabs (spec 00). */
export function TabsList({
  className,
  style,
  ref,
  ...props
}: ComponentPropsWithRef<typeof RadixTabs.List>) {
  const own = useRef<HTMLDivElement>(null);
  const { start, end } = useOverflowEdges(own);
  const mask =
    start || end
      ? `linear-gradient(to right, ${start ? 'transparent' : 'black'} 0, #000 ${start ? FADE : '0px'}, #000 calc(100% - ${end ? FADE : '0px'}), ${end ? 'transparent' : 'black'} 100%)`
      : undefined;
  return (
    <RadixTabs.List
      {...props}
      ref={(node) => {
        own.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      data-fade-start={start || undefined}
      data-fade-end={end || undefined}
      style={mask ? { ...style, maskImage: mask, WebkitMaskImage: mask } : style}
      className={cx(
        'flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]',
        className,
      )}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      {...props}
      className={cx(
        'relative h-control shrink-0 cursor-pointer whitespace-nowrap px-3 text-body font-semibold text-muted',
        'hover:text-ink data-[state=active]:font-bold data-[state=active]:text-ink',
        'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-transparent data-[state=active]:after:bg-forest',
        'disabled:cursor-not-allowed disabled:opacity-50 touch-target',
        className,
      )}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixTabs.Content>) {
  return <RadixTabs.Content {...props} className={cx('pt-4', className)} />;
}
