'use client';
// Wires the stored views (saved-views.ts) to the URL: choosing a view writes its query into the URL, and the view is
// "edited" while the URL's register state differs from what the view stored.
import { toast, type SavedViewsProps } from '@canopy/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

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

export function useSavedViews(
  key: string,
  search: URLSearchParams,
  navigate: Navigate,
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

  // Opening the register with no view and no filters applies the person's default view once.
  useEffect(() => {
    if (!loaded || currentId || state !== '' || !store.defaultId) return;
    const view = findView(store, store.defaultId);
    if (view) navigate(withView(search, view.query, view.id));
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
      edited: current ? current.query !== state : state !== '',
      onSelect: (id) => navigate(withView(search, findView(store, id)?.query ?? '', id)),
      onSave: (name) =>
        refused(() => {
          const { store: next, id } = addView(store, name, state);
          commit(next);
          navigate(withView(search, state, id));
        }),
      onUpdate: (id) => commit(updateView(store, id, state)),
      onDiscard: () => navigate(withView(search, current?.query ?? '', current?.id)),
      onRename: (id, name) => refused(() => commit(renameView(store, id, name))),
      onDelete: (id) => {
        commit(deleteView(store, id));
        if (id === current?.id) navigate(withView(search, state, undefined));
      },
      onSetDefault: (id) => commit(setDefaultView(store, id)),
    }),
    [store, current, state, search, navigate, commit],
  );
}
