'use client';
// Wires the stored views (saved-views.ts) to the URL and the grid layout: choosing a view writes its query into the URL
// and its columns and density into the grid, and the view is "edited" while either differs from what it stored.
import { toast, type SavedViewsProps } from '@canopy/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_LAYOUT,
  fromViewLayout,
  sameLayout,
  toViewLayout,
  type GridLayout,
} from '../_lib/layout';
import { VIEW_PARAM, viewQuery, withView } from '../_lib/query';
import {
  addView,
  deleteView,
  findView,
  loadViews,
  renameView,
  saveViews,
  setDefaultView,
  updateView,
  type StoredView,
  type ViewStore,
} from '../_lib/saved-views';

type Navigate = (search: URLSearchParams) => void;

/**
 * Runs a view change that saved-views.ts may refuse (no name, or the 50-view limit). The reason is shown as a toast,
 * then rethrown so the name dialog stays open.
 */
function refused(change: () => void): void {
  try {
    change();
  } catch (error) {
    // saved-views.ts throws only Errors with a sentence meant for the person.
    toast({ tone: 'error', message: (error as Error).message });
    throw error;
  }
}

const layoutOf = (view: StoredView | undefined): GridLayout =>
  view ? fromViewLayout(view.layout) : DEFAULT_LAYOUT;

export function useSavedViews(
  key: string,
  search: URLSearchParams,
  navigate: Navigate,
  layout: GridLayout,
  setLayout: (layout: GridLayout) => void,
): SavedViewsProps {
  // Storage is read after mount: the server render has none, and the first client render must match it.
  const [store, setStore] = useState<ViewStore>({ views: [] });
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setStore(loadViews(key));
    setLoaded(true);
  }, [key]);

  const currentId = search.get(VIEW_PARAM) ?? undefined;
  const current = findView(store, currentId);
  const state = viewQuery(search);

  // On load: a link naming a view gets that view's layout; with no view and no filters, the person's default view
  // applies once.
  useEffect(() => {
    if (!loaded) return;
    if (current) {
      setLayout(layoutOf(current));
      return;
    }
    if (currentId || state !== '' || !store.defaultId) return;
    const view = findView(store, store.defaultId);
    if (view) {
      setLayout(layoutOf(view));
      navigate(withView(search, view.query, view.id));
    }
    // Only on load: choosing Default later must stay on Default.
  }, [loaded]);

  const commit = useCallback(
    (next: ViewStore) => {
      setStore(next);
      if (!saveViews(key, next)) {
        toast({
          tone: 'warn',
          message:
            'This browser is blocking storage, so the change to your views lasts until you leave the page.',
        });
      }
    },
    [key],
  );

  return useMemo<SavedViewsProps>(
    () => ({
      list: store.views.map(({ id, name }) => ({ id, name })),
      current: current?.id,
      defaultId: store.defaultId,
      edited:
        (current ? current.query !== state : state !== '') ||
        !sameLayout(layout, layoutOf(current)),
      onSelect: (id) => {
        const view = findView(store, id);
        setLayout(layoutOf(view));
        navigate(withView(search, view?.query ?? '', id));
      },
      onSave: (name) =>
        refused(() => {
          const { store: next, id } = addView(store, name, state, toViewLayout(layout));
          commit(next);
          navigate(withView(search, state, id));
        }),
      onUpdate: (id) => commit(updateView(store, id, state, toViewLayout(layout))),
      onDiscard: () => {
        setLayout(layoutOf(current));
        navigate(withView(search, current?.query ?? '', current?.id));
      },
      onRename: (id, name) => refused(() => commit(renameView(store, id, name))),
      onDelete: (id) => {
        commit(deleteView(store, id));
        if (id === current?.id) navigate(withView(search, state, undefined));
      },
      onSetDefault: (id) => commit(setDefaultView(store, id)),
    }),
    [store, current, state, search, navigate, commit, layout, setLayout],
  );
}
