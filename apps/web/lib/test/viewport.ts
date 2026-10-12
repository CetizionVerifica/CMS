// Minimal matchMedia for jsdom that understands the min-width/max-width queries the components use.
type Listener = (e: MediaQueryListEvent) => void;
const lists = new Set<{ query: string; listeners: Set<Listener>; mql: MediaQueryList }>();
let width = 1280;

function matches(query: string): boolean {
  return query.split(' and ').every((part) => {
    const m = /\((min|max)-width:\s*(\d+(?:\.\d+)?)px\)/.exec(part);
    if (!m) return /pointer:\s*fine/.test(part) || !/pointer/.test(part);
    const px = Number(m[2]);
    return m[1] === 'min' ? width >= px : width <= px;
  });
}

window.matchMedia = (query: string): MediaQueryList => {
  const listeners = new Set<Listener>();
  const mql = {
    media: query,
    get matches() {
      return matches(query);
    },
    onchange: null,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
    addListener: (l: Listener) => listeners.add(l),
    removeListener: (l: Listener) => listeners.delete(l),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
  lists.add({ query, listeners, mql });
  return mql;
};

export function setViewport(px: number): void {
  width = px;
  window.innerWidth = px;
  for (const { listeners, mql } of lists) {
    for (const l of listeners) l({ matches: mql.matches, media: mql.media } as MediaQueryListEvent);
  }
}
