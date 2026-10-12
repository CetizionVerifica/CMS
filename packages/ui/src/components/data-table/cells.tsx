import type { CellContext, RowData } from '@tanstack/react-table';
import { Copy } from 'lucide-react';

import { cx } from '../../lib/cx';
import { formatDate, formatNumber } from '../../lib/format';
import { Avatar } from '../../primitives/Avatar';
import { CriticalityTag, type Criticality } from '../CriticalityTag';
import { ProgressBar } from '../ProgressBar';
import { StatusPill, type StatusPillProps } from '../StatusPill';
import { toast } from '../Toast';
import type { TableContext } from './context';

/** Column types from spec 09. They set alignment and the default cell. */
export type ColumnType =
  | 'id'
  | 'title'
  | 'text'
  | 'date'
  | 'number'
  | 'status'
  | 'criticality'
  | 'person'
  | 'progress'
  | 'actions';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    type?: ColumnType;
    /** Always visible; the column chooser shows it ticked and disabled (the title column). */
    locked?: boolean;
    /** Name in the column chooser when the header is not a plain string. */
    label?: string;
  }
}

/** Values each column type expects from its accessor. */
export type TitleValue = { title: string; sub?: string } | string;
export type StatusValue = Pick<StatusPillProps, 'status' | 'days' | 'dueDate'>;
export type PersonValue = { name: string; avatarUrl?: string } | null | undefined;

export const rightAligned = (type?: ColumnType) => type === 'number' || type === 'actions';

/** The default cell for a column type. A column's own `cell` replaces it. */
export function typedCell<T>(ctx: CellContext<T, unknown>) {
  const type = ctx.column.columnDef.meta?.type ?? 'text';
  const value = ctx.getValue();
  const table = ctx.table.options.meta as TableContext<T> | undefined;

  switch (type) {
    case 'id':
      return <CopyId value={String(value ?? '')} />;
    case 'title': {
      const v = (value ?? '') as TitleValue;
      const title = typeof v === 'string' ? v : v.title;
      const sub = typeof v === 'string' ? undefined : v.sub;
      return table ? table.renderTitle(ctx.row, title, sub) : <span>{title}</span>;
    }
    case 'date':
      return value ? (
        <span className="tabular">{formatDate(String(value))}</span>
      ) : (
        <span className="text-muted">—</span>
      );
    case 'number':
      return typeof value === 'number' ? (
        <span className="tabular">{formatNumber(value)}</span>
      ) : (
        <span className="text-muted">—</span>
      );
    case 'status':
      return value ? <StatusPill {...(value as StatusValue)} size="sm" /> : null;
    case 'criticality':
      return value ? <CriticalityTag level={value as Criticality} size="sm" /> : null;
    case 'person': {
      const p = value as PersonValue;
      return p ? (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={p.name} src={p.avatarUrl} size={24} decorative />
          <span className="truncate">{p.name}</span>
        </span>
      ) : (
        <span className="text-muted">Unassigned</span>
      );
    }
    case 'progress':
      return typeof value === 'number' ? (
        <ProgressBar
          value={value}
          label={String(ctx.column.columnDef.meta?.label ?? ctx.column.id)}
          width="table"
          showValue
        />
      ) : null;
    case 'actions':
      return null;
    case 'text':
    default: {
      const text = value == null ? '' : String(value);
      return (
        <span className="block truncate" title={text}>
          {text}
        </span>
      );
    }
  }
}

function CopyId({ value }: { value: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(value).then(
          () => toast({ tone: 'info', message: 'Copied ID' }),
          () => toast({ tone: 'error', message: "Couldn't copy the ID." }),
        );
      }}
      // Not a tab stop: rows are reached with the arrow keys and the ID is printed in the row.
      tabIndex={-1}
      title="Copy ID"
      aria-label={`Copy ID ${value}`}
      className={cx(
        'group/id inline-flex max-w-full items-center gap-1 rounded-tag text-meta text-muted tabular hover:text-ink',
      )}
    >
      <span className="truncate">{value}</span>
      <Copy aria-hidden size={12} className="shrink-0 opacity-0 group-hover/id:opacity-100" />
    </button>
  );
}
