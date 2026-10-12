// Server-side guess of the AppShell layout, so a phone's first paint is the phone layout (spec 01, "Server
// rendering"). AppShell's `auto` layout reads matchMedia, which the server can't, so without a hint every page
// renders the desktop sidebar first and jumps to the bottom-sheet layout after hydration.
//
// Sources, most exact first:
// 1. The `pp_layout` cookie the shell writes in the browser whenever the layout changes (exact after the first visit).
// 2. The `Sec-CH-Viewport-Width` client hint (Chromium, once the app has sent `Accept-CH`).
// 3. The `Sec-CH-UA-Mobile` hint or a mobile user agent: a phone is assumed to be under 640px.
// 4. The desktop sidebar.
export type ShellLayout = 'sidebar' | 'rail' | 'sheet';

export const LAYOUT_COOKIE = 'pp_layout';

/** Breakpoints from foundations §8, the same ones AppShell's `auto` mode uses. */
export function layoutForWidth(width: number): ShellLayout {
  if (width >= 1100) return 'sidebar';
  if (width >= 640) return 'rail';
  return 'sheet';
}

export function isShellLayout(value: unknown): value is ShellLayout {
  return value === 'sidebar' || value === 'rail' || value === 'sheet';
}

type HeaderReader = { get(name: string): string | null };

export function initialLayout(headers: HeaderReader, cookie: string | undefined): ShellLayout {
  if (isShellLayout(cookie)) return cookie;
  const width = Number(headers.get('sec-ch-viewport-width'));
  if (Number.isFinite(width) && width > 0) return layoutForWidth(width);
  if (headers.get('sec-ch-ua-mobile') === '?1') return 'sheet';
  const ua = headers.get('user-agent') ?? '';
  // iPadOS reports a desktop UA, and Android tablets omit "Mobile", so this only matches phones.
  if (/\b(iPhone|iPod)\b|Android.+Mobile|Mobile.+Firefox|Windows Phone/i.test(ua)) return 'sheet';
  return 'sidebar';
}
