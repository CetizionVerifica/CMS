import type { Row } from '@tanstack/react-table';
import type { ReactNode } from 'react';

/** Passed to cells through TanStack's table meta, so cells hold no React state of their own. */
export type TableContext<T> = {
  renderTitle: (row: Row<T>, title: string, sub?: string) => ReactNode;
  /**
   * 0 for the focused row and -1 for the rest. Give controls inside custom cells (the actions menu) this tabIndex, so
   * Tab goes from the row's title to its actions and then out of the table.
   */
  rowTabIndex: (row: Row<T>) => 0 | -1;
};
