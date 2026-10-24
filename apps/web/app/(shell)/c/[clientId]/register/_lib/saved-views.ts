// Saved register views, per person and client. The contracts have no saved-view endpoint yet, so views live in this
// browser's localStorage (ADR M12-0001). A view stores the register query string (`viewQuery`) and the grid layout
// (layout.ts), never row data, so nothing personal is kept. Storage can be missing or blocked (private windows), so every access is guarded and
// the register works without it.

import { isViewLayout, type ViewLayout } from './layout';

/** `layout` is absent on views saved before views kept the layout; they open with the default layout. */
export type StoredView = { id: string; name: string; query: string; layout?: ViewLayout };
export type ViewStore = { views: StoredView[]; defaultId?: string };

/** Names are trimmed and at most 60 characters (SavedViews' name field). */
export const MAX_VIEW_NAME = 60;
/** Enough for any real use; stops a runaway loop filling storage. */
export const MAX_VIEWS = 50;

const EMPTY: ViewStore = { views: [] };

export function storageKey(personId: string, clientId: string): string {
  return `pp.register.views.${personId}.${clientId}`;
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** A stored view, or undefined when the value isn't one. A malformed layout is dropped, keeping the view. */
function asView(v: unknown): StoredView | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { id, name, query, layout } = v as Record<string, unknown>;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof query !== 'string') {
    return undefined;
  }
  return isViewLayout(layout) ? { id, name, query, layout } : { id, name, query };
}

/** The stored views, or none when storage is unavailable or holds something unexpected. */
export function loadViews(key: string): ViewStore {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as { views?: unknown; defaultId?: unknown };
    const views = Array.isArray(parsed.views)
      ? parsed.views
          .map(asView)
          .filter((v): v is StoredView => v !== undefined)
          .slice(0, MAX_VIEWS)
      : [];
    const defaultId =
      typeof parsed.defaultId === 'string' && views.some((v) => v.id === parsed.defaultId)
        ? parsed.defaultId
        : undefined;
    return defaultId ? { views, defaultId } : { views };
  } catch {
    return EMPTY;
  }
}

/** Writes the views; returns false when storage refused, so the caller can say the view wasn't kept. */
export function saveViews(key: string, store: ViewStore): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

const cleanName = (name: string) => name.trim().slice(0, MAX_VIEW_NAME);

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function addView(
  store: ViewStore,
  name: string,
  query: string,
  layout?: ViewLayout,
): { store: ViewStore; id: string } {
  const label = cleanName(name);
  if (!label) throw new Error('A view needs a name');
  if (store.views.length >= MAX_VIEWS)
    throw new Error(`You can keep up to ${MAX_VIEWS} views. Delete one to save this view.`);
  const id = newId();
  const view: StoredView = layout ? { id, name: label, query, layout } : { id, name: label, query };
  return { store: { ...store, views: [...store.views, view] }, id };
}

export function updateView(
  store: ViewStore,
  id: string,
  query: string,
  layout?: ViewLayout,
): ViewStore {
  return {
    ...store,
    views: store.views.map((v) =>
      v.id === id ? { ...v, query, ...(layout ? { layout } : {}) } : v,
    ),
  };
}

export function renameView(store: ViewStore, id: string, name: string): ViewStore {
  const label = cleanName(name);
  if (!label) throw new Error('A view needs a name');
  return { ...store, views: store.views.map((v) => (v.id === id ? { ...v, name: label } : v)) };
}

export function deleteView(store: ViewStore, id: string): ViewStore {
  const views = store.views.filter((v) => v.id !== id);
  return store.defaultId === id || store.defaultId === undefined
    ? { views }
    : { views, defaultId: store.defaultId };
}

export function setDefaultView(store: ViewStore, id: string | undefined): ViewStore {
  if (id === undefined || !store.views.some((v) => v.id === id)) return { views: store.views };
  return { views: store.views, defaultId: id };
}

export function findView(store: ViewStore, id: string | null | undefined): StoredView | undefined {
  return id ? store.views.find((v) => v.id === id) : undefined;
}
