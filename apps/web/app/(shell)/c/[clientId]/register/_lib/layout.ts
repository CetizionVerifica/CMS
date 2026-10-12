// The grid's column choice, column order and row density. A saved view keeps these next to its query, which is what
// the Save dialog promises ("Saves the filters, sort, columns and density").
import type { Density } from '@canopy/ui';

import { DEFAULT_VISIBILITY, registerColumns } from './columns';

/** What DataTable takes. */
export type GridLayout = { visibility: Record<string, boolean>; order: string[]; density: Density };

/** What a saved view stores: the visible columns in display order, and the density. */
export type ViewLayout = { columns: string[]; density: Density };

const ALL_IDS = registerColumns.map((c) => c.id!);
const KNOWN = new Set(ALL_IDS);
/** Columns the chooser can't hide (the title). */
const LOCKED = registerColumns.filter((c) => c.meta?.locked).map((c) => c.id!);

export const DEFAULT_LAYOUT: GridLayout = {
  visibility: DEFAULT_VISIBILITY,
  order: ALL_IDS,
  density: 'comfortable',
};

export function toViewLayout(layout: GridLayout): ViewLayout {
  // DataTable reports the order it shows; columns it doesn't list keep their place after the listed ones.
  const order = [...layout.order.filter((id) => KNOWN.has(id))];
  for (const id of ALL_IDS) if (!order.includes(id)) order.push(id);
  return {
    columns: order.filter((id) => layout.visibility[id] ?? DEFAULT_VISIBILITY[id]),
    density: layout.density,
  };
}

/** A stored layout as DataTable state. Unknown or missing values fall back to the default, never to a blank grid. */
export function fromViewLayout(view: ViewLayout | undefined): GridLayout {
  const columns = (view?.columns ?? []).filter(
    (id, i, all) => KNOWN.has(id) && all.indexOf(id) === i,
  );
  if (!view || columns.length === 0) return DEFAULT_LAYOUT;
  for (const id of LOCKED) if (!columns.includes(id)) columns.unshift(id);
  return {
    visibility: Object.fromEntries(ALL_IDS.map((id) => [id, columns.includes(id)])),
    order: [...columns, ...ALL_IDS.filter((id) => !columns.includes(id))],
    density: view.density === 'compact' ? 'compact' : 'comfortable',
  };
}

export function sameLayout(a: GridLayout, b: GridLayout): boolean {
  return JSON.stringify(toViewLayout(a)) === JSON.stringify(toViewLayout(b));
}

/** A stored value that looks like a ViewLayout (storage is user-editable, so nothing is trusted). */
export function isViewLayout(value: unknown): value is ViewLayout {
  if (!value || typeof value !== 'object') return false;
  const { columns, density } = value as Record<string, unknown>;
  return (
    Array.isArray(columns) &&
    columns.every((c) => typeof c === 'string') &&
    (density === 'comfortable' || density === 'compact')
  );
}
