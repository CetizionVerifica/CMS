import { describe, expect, it } from 'vitest';

import { DEFAULT_COLUMN_IDS } from './columns';
import {
  DEFAULT_LAYOUT,
  fromViewLayout,
  isViewLayout,
  sameLayout,
  toViewLayout,
  type GridLayout,
} from './layout';

describe('grid layout in saved views', () => {
  it('stores the visible columns in display order, and the density', () => {
    expect(toViewLayout(DEFAULT_LAYOUT)).toEqual({
      columns: [...DEFAULT_COLUMN_IDS],
      density: 'comfortable',
    });
    const layout: GridLayout = {
      visibility: { ...DEFAULT_LAYOUT.visibility, actName: false, unitName: true },
      order: ['dueDate', 'title', 'unitName'],
      density: 'compact',
    };
    expect(toViewLayout(layout).columns.slice(0, 3)).toEqual(['dueDate', 'title', 'unitName']);
    expect(toViewLayout(layout).columns).not.toContain('actName');
    expect(toViewLayout(layout).density).toBe('compact');
  });

  it('round-trips a layout', () => {
    const stored = { columns: ['dueDate', 'title', 'status'], density: 'compact' as const };
    const grid = fromViewLayout(stored);
    expect(grid.order.slice(0, 3)).toEqual(stored.columns);
    expect(Object.entries(grid.visibility).filter(([, v]) => v)).toHaveLength(3);
    expect(toViewLayout(grid)).toEqual(stored);
  });

  it('falls back to the default instead of showing a blank or broken grid', () => {
    expect(fromViewLayout(undefined)).toBe(DEFAULT_LAYOUT);
    expect(fromViewLayout({ columns: ['gone'], density: 'compact' })).toBe(DEFAULT_LAYOUT);
    const grid = fromViewLayout({ columns: ['dueDate', 'dueDate', 'gone'], density: 'compact' });
    // The title can't be hidden, so it comes back; duplicates and unknown ids are dropped.
    expect(toViewLayout(grid).columns).toEqual(['title', 'dueDate']);
  });

  it('compares layouts by what a view would store', () => {
    const reordered = { ...DEFAULT_LAYOUT, order: [...DEFAULT_LAYOUT.order].reverse() };
    expect(sameLayout(DEFAULT_LAYOUT, { ...DEFAULT_LAYOUT })).toBe(true);
    expect(sameLayout(DEFAULT_LAYOUT, reordered)).toBe(false);
    expect(sameLayout(DEFAULT_LAYOUT, { ...DEFAULT_LAYOUT, density: 'compact' })).toBe(false);
  });

  it('accepts only well-formed stored layouts', () => {
    expect(isViewLayout({ columns: ['title'], density: 'compact' })).toBe(true);
    expect(isViewLayout({ columns: ['title'], density: 'tiny' })).toBe(false);
    expect(isViewLayout({ columns: [1], density: 'compact' })).toBe(false);
    expect(isViewLayout({ density: 'compact' })).toBe(false);
    expect(isViewLayout(null)).toBe(false);
  });
});
