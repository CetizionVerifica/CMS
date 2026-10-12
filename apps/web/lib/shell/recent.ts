// Recently opened clients for the switcher, most recent first. Kept in localStorage: a per-browser convenience,
// so a blocked or empty store just means no "Recent" group.
const KEY = 'pp.recentClients';
const MAX = 3;

export function recentClients(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string').slice(0, MAX)
      : [];
  } catch {
    return [];
  }
}

export function rememberClient(id: string): string[] {
  const next = [id, ...recentClients().filter((c) => c !== id)].slice(0, MAX);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the list still applies to this page view.
  }
  return next;
}
