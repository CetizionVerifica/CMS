import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addView,
  deleteView,
  findView,
  loadViews,
  MAX_VIEW_NAME,
  MAX_VIEWS,
  renameView,
  saveViews,
  setDefaultView,
  storageKey,
  updateView,
  type ViewStore,
} from './saved-views';

const KEY = storageKey('person-1', 'client-1');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storage', () => {
  it('keys views by person and client', () => {
    expect(KEY).toBe('pp.register.views.person-1.client-1');
    expect(storageKey('person-1', 'client-2')).not.toBe(KEY);
  });

  it('round-trips a store', () => {
    const store: ViewStore = {
      views: [{ id: 'a', name: 'Overdue', query: 'status=OVERDUE' }],
      defaultId: 'a',
    };
    expect(saveViews(KEY, store)).toBe(true);
    expect(loadViews(KEY)).toEqual(store);
  });

  it('returns no views when nothing, junk or the wrong shape is stored', () => {
    expect(loadViews(KEY)).toEqual({ views: [] });
    localStorage.setItem(KEY, '{not json');
    expect(loadViews(KEY)).toEqual({ views: [] });
    localStorage.setItem(
      KEY,
      JSON.stringify({
        views: [{ id: 1 }, null, { id: 'b', name: 'B', query: '' }],
        defaultId: 'gone',
      }),
    );
    expect(loadViews(KEY)).toEqual({ views: [{ id: 'b', name: 'B', query: '' }] });
    localStorage.setItem(KEY, JSON.stringify({ views: 'nope' }));
    expect(loadViews(KEY)).toEqual({ views: [] });
  });

  it('caps how many views it reads', () => {
    const views = Array.from({ length: MAX_VIEWS + 5 }, (_, i) => ({
      id: `v${i}`,
      name: `V${i}`,
      query: '',
    }));
    localStorage.setItem(KEY, JSON.stringify({ views }));
    expect(loadViews(KEY).views).toHaveLength(MAX_VIEWS);
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(loadViews(KEY)).toEqual({ views: [] });
    expect(saveViews(KEY, { views: [] })).toBe(false);
  });

  it('reports no storage when the localStorage accessor throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(saveViews(KEY, { views: [] })).toBe(false);
    expect(loadViews(KEY)).toEqual({ views: [] });
  });
});

describe('editing views', () => {
  it('adds a view with a trimmed, capped name and a fresh id', () => {
    const { store, id } = addView({ views: [] }, `  ${'x'.repeat(80)}  `, 'status=OVERDUE');
    expect(store.views).toEqual([{ id, name: 'x'.repeat(MAX_VIEW_NAME), query: 'status=OVERDUE' }]);
    const second = addView(store, 'Mine', 'ownerId=me');
    expect(second.id).not.toBe(id);
  });

  it('makes ids without crypto.randomUUID', () => {
    vi.stubGlobal('crypto', {});
    const { id } = addView({ views: [] }, 'A', '');
    expect(id).toMatch(/^v[a-z0-9]+$/);
    vi.unstubAllGlobals();
  });

  it('refuses an empty name and too many views', () => {
    expect(() => addView({ views: [] }, '   ', '')).toThrow('name');
    const full: ViewStore = {
      views: Array.from({ length: MAX_VIEWS }, (_, i) => ({ id: `v${i}`, name: 'V', query: '' })),
    };
    expect(() => addView(full, 'One more', '')).toThrow(String(MAX_VIEWS));
    expect(() => renameView(full, 'v1', ' ')).toThrow('name');
  });

  it('updates, renames, deletes and sets the default', () => {
    let store: ViewStore = {
      views: [
        { id: 'a', name: 'A', query: '' },
        { id: 'b', name: 'B', query: '' },
      ],
    };
    store = updateView(store, 'a', 'status=OVERDUE');
    store = renameView(store, 'b', ' Bee ');
    expect(store.views).toEqual([
      { id: 'a', name: 'A', query: 'status=OVERDUE' },
      { id: 'b', name: 'Bee', query: '' },
    ]);
    store = setDefaultView(store, 'b');
    expect(store.defaultId).toBe('b');
    expect(deleteView(store, 'a')).toEqual({
      views: [{ id: 'b', name: 'Bee', query: '' }],
      defaultId: 'b',
    });
    expect(deleteView(store, 'b').defaultId).toBeUndefined();
    expect(setDefaultView(store, undefined).defaultId).toBeUndefined();
    expect(setDefaultView(store, 'missing').defaultId).toBeUndefined();
    expect(deleteView({ views: store.views }, 'a')).toEqual({
      views: [{ id: 'b', name: 'Bee', query: '' }],
    });
  });

  it('finds a view by id', () => {
    const store: ViewStore = { views: [{ id: 'a', name: 'A', query: '' }] };
    expect(findView(store, 'a')?.name).toBe('A');
    expect(findView(store, 'z')).toBeUndefined();
    expect(findView(store, null)).toBeUndefined();
  });
});
