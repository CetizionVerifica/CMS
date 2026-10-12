import { useRef } from 'react';

/**
 * For dialogs opened without a Radix Trigger (a table row, a keyboard shortcut): remembers what had focus when `open`
 * became true and returns a handler for `onCloseAutoFocus` that puts focus back there.
 */
export function useReturnFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== 'undefined') {
    opener.current = document.activeElement as HTMLElement | null;
  }
  wasOpen.current = open;
  return (e: Event) => {
    const target = opener.current;
    if (target && target.isConnected && target !== document.body) {
      e.preventDefault();
      target.focus();
    }
  };
}
